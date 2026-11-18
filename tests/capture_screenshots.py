#!/usr/bin/env python3
"""
Regenerate the README screenshots in docs/screenshots/ from real game states.

  python3 tests/capture_screenshots.py            # all of them
  python3 tests/capture_screenshots.py hangar,maneuver

The scripted pilots (tests/pilots.js) fly an actual mission with player controls; each scene is
frozen before it is captured. Needs the same setup as run_browser_tests.py (Python `websockets`
and Chrome/Chromium) plus Pillow for the JPEG conversion.
"""
import asyncio
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.request

import websockets

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import run_browser_tests as T  # noqa: E402

OUT = os.path.join(T.ROOT, "docs", "screenshots")
JPEG = {"orbit", "lunar-orbit", "planets"}  # photographic scenes are much smaller as JPEG
W, H = 1440, 900


async def capture(only):
    httpd, port = T.start_server()
    dbg = T.free_port()
    prof = tempfile.mkdtemp(prefix="po-")
    proc = subprocess.Popen(T.chrome_command(prof, dbg), stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    base = f"http://127.0.0.1:{port}"
    want = lambda n: not only or n in only  # noqa: E731
    saved = []
    try:
        pages = []
        for _ in range(100):
            try:
                with urllib.request.urlopen(f"http://127.0.0.1:{dbg}/json") as r:
                    pages = [t for t in json.load(r) if t["type"] == "page"]
                if pages:
                    break
            except OSError:
                pass
            time.sleep(0.2)
        async with websockets.connect(pages[0]["webSocketDebuggerUrl"], max_size=None) as ws:
            cdp = T.CDP(ws)
            reader = asyncio.create_task(cdp.run())
            await cdp.send("Page.enable")
            await cdp.send("Runtime.enable")
            await cdp.send("Emulation.setDeviceMetricsOverride", {"width": W, "height": H, "deviceScaleFactor": 1, "mobile": False})

            async def shot(name, settle=0.8):
                if not want(name):
                    return
                await cdp.eval("if (window.APP && APP.flight) { APP.flight.messages = []; } true")  # no toasts
                await asyncio.sleep(settle)
                path = os.path.join(OUT, name + ".png")
                await cdp.shot(path)
                saved.append(path)

            await cdp.goto(base + "/index.html")
            await cdp.eval("localStorage.clear(); true")
            await cdp.goto(base + "/index.html")
            await cdp.wait_for("!!window.APP && !!document.querySelector('#catalog .part-card')")
            await cdp.eval("new Promise(r => { const s = document.createElement('script'); s.src = 'tests/pilots.js'; s.onload = () => r(true); document.body.appendChild(s); })")

            # hangar: the starter in the Retro livery, paint panel open on its big tank
            await cdp.eval("""(() => { const h = APP.hangar; h.applyLivery('Retro');
                h.selected = h.design.parts.find(p => p.type === 'tank_m').uid; h.render(); h.renderInfo();
                document.getElementById('hangarToast').className = 'toast'; return true; })()""")
            await shot("hangar")
            await cdp.eval("APP.hangar.selected = null; APP.hangar.render(); APP.hangar.renderInfo(); true")

            # ignition on the pad
            await cdp.eval("document.querySelector('#btnLaunch').click(); true")
            await cdp.wait_for("APP.screen === 'flight'")
            await cdp.eval("(() => { const f = APP.flight; f.setThrottle(1); f.stage(); APP.flightView.zoom = 9; f.paused = true; return true; })()")
            await shot("liftoff")

            # orbit: a fresh flight taken up by the ascent pilot
            await cdp.eval("""(() => { APP.revert(); const f = APP.flight;
                Pilots.ascend(f, {turnAlt: 500, turnDeg: 25, targetAp: 30000, targetPe: 20000}, []);
                APP.flightView.zoom = 0.006; f.paused = true; return true; })()""")
            await shot("orbit", 1.2)

            # maneuver: a node placed from the map panel's hint, tuned for a Pock encounter
            await cdp.eval("""(() => { const f = APP.flight, pock = APP.sys.byId('pock'); f.paused = false;
                const n = Pilots.addTransferNode(f, pock);
                const ok = (inf) => { const pe = Pilots.layerPeAt(inf.layer, pock); return pe !== null && pe > 4000 && pe < 9000; };
                if (!Pilots.tuneNode(f, n, 'pro', 0.1, ok, 150).ok) { f.planner.setComps(n, f.transferInfo(pock).dv, 0); Pilots.tuneNode(f, n, 'pro', -0.1, ok, 150); }
                f.planner.selected = n; f.maybePredict(true); f.planner.compute();
                APP.setView('map'); APP.mapView.fitOrbit(); f.paused = true; return true; })()""")
            await shot("maneuver", 1.2)

            # lunar orbit: fly the node, warp to the encounter, capture
            await cdp.eval("""(() => { const f = APP.flight, pock = APP.sys.byId('pock'); f.paused = false;
                Pilots.executeNode(f); Pilots.warpToSoi(f); Pilots.capture(f, pock); f.setTarget(null);
                APP.setView('map'); APP.mapView.fitOrbit(); APP.mapView.zoom(1.35); f.maybePredict(true); f.paused = true; return true; })()""")
            await shot("lunar-orbit", 1.2)

            # landing on Pock
            await cdp.eval("""(() => { const f = APP.flight, pock = APP.sys.byId('pock'); f.paused = false;
                Pilots.deorbit(f, pock); Pilots.land(f, []); APP.setView('flight'); APP.flightView.zoom = 6; return true; })()""")
            await asyncio.sleep(1.0)
            await cdp.eval("APP.flight.paused = true; true")
            await shot("landed", 0.6)

            # parachutes: the Kestrel Return's upper stage (fuel mostly spent) under its three mains above Verdis
            if want("chutes"):
                await cdp.eval("""(() => { APP.toHangar(); const h = APP.hangar, i = SB.CONFIG.presets.findIndex(p => /parachute/i.test(p.name));
                    h.setDesign(h.preset(i)); h.selected = null; h.render(); document.querySelector('#btnLaunch').click();
                    const f = APP.flight, P = APP.sys.planet;
                    f.stage(); f.situation = 'flying'; f.stage(); f.setThrottle(0); f.launchTime = f.st.t - 5523;
                    for (const p of f.craft.parts) if (p.role === 'tank') p.fuel = p.fuelMax * 0.15;
                    const a = P.launchAngle + 0.05, R = APP.sys.surfaceRadius(P, a) + f.geometry().bottomOffset + 2650;
                    f.st.rx = Math.cos(a) * R; f.st.ry = Math.sin(a) * R; f.st.vx = -Math.cos(a) * 60; f.st.vy = -Math.sin(a) * 60;
                    f.heading = a; f.stage(); APP.setView('flight'); APP.flightView.zoom = 9; return true; })()""")
                await asyncio.sleep(7.5)
                await cdp.eval("APP.flight.paused = true; true")
                await shot("chutes", 0.5)

            # a sink-rate warning: falling at Pock faster than full thrust can stop in the height left
            if want("warning"):
                await cdp.eval("""(() => { APP.debugScenario('landed'); const f = APP.flight; f.outcome = null; f.launchTime = f.st.t - 3900;
                    const c = f.craft, accel = c.thrustState(1, 0).thrust / c.mass() - f.localGravity();
                    const L = f.landingLimits().maxDescent, v = 40, h = (v * v - L * L) / (2 * accel) / 1.3 + 60;
                    const n = Math.hypot(f.st.rx, f.st.ry), u = [f.st.rx / n, f.st.ry / n];
                    f.st.rx += u[0] * h; f.st.ry += u[1] * h; f.st.vx = -u[0] * v - u[1] * 1.5; f.st.vy = -u[1] * v + u[0] * 1.5;
                    f.situation = 'flying'; f.setThrottle(0); f.setSas('stability', true); APP.setView('flight'); APP.flightView.zoom = 2.5; return true; })()""")
                await asyncio.sleep(1.2)
                await shot("warning", 0.3)

            if want("planets"):
                await cdp.goto(base + "/tests/planets.html")
                await cdp.wait_for("!!window.PLANET_CHECK", timeout=60)
                await cdp.eval("document.getElementById('info').style.display = 'none'; true")
                await shot("planets", 0.5)
            for c in cdp.console:
                print(c)
            reader.cancel()
    finally:
        await T.stop_chrome(proc, prof, dbg)
        httpd.shutdown()
        shutil.rmtree(prof, ignore_errors=True)
    return saved


def main():
    only = set(sys.argv[1].split(",")) if len(sys.argv) > 1 else None
    os.makedirs(OUT, exist_ok=True)
    saved = asyncio.run(capture(only))
    from PIL import Image
    for path in saved:
        name = os.path.splitext(os.path.basename(path))[0]
        im = Image.open(path)
        if name in JPEG:
            im.convert("RGB").save(os.path.join(OUT, name + ".jpg"), quality=88, optimize=True, progressive=True)
            os.remove(path)
        else:
            im.save(path, optimize=True)
        print("saved", name)


if __name__ == "__main__":
    main()
