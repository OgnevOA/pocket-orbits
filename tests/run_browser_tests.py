#!/usr/bin/env python3
"""
Drive headless Chrome over the DevTools protocol to run Pocket Orbits checks.

  python3 tests/run_browser_tests.py core          # simulation checks (tests/index.html)
  python3 tests/run_browser_tests.py ui            # hangar save/reload + flight UI smoke test
  python3 tests/run_browser_tests.py all --shots out_dir

Needs Python 3.9+ with the `websockets` package and Chrome/Chromium (a Flatpak Chrome works).
Set CHROME="/path/to/chrome" to pick a specific browser binary.
"""
import asyncio
import base64
import contextlib
import functools
import http.server
import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time
import urllib.request

import websockets

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def start_server():
    port = free_port()
    handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=ROOT)

    class Quiet(handler.func):  # type: ignore[misc]
        def log_message(self, *a):
            pass

    httpd = http.server.ThreadingHTTPServer(("127.0.0.1", port), functools.partial(Quiet, directory=ROOT))
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd, port


async def stop_chrome(proc, profile, port):
    """Shut the browser down for real. With Flatpak Chrome, terminating the `flatpak run` wrapper
    leaves the sandboxed browser running, so: ask it to close over DevTools, then stop anything
    still using this run's unique profile directory, then the wrapper."""
    with contextlib.suppress(Exception):
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/json/version", timeout=2) as r:
            ws_url = json.load(r)["webSocketDebuggerUrl"]
        async with websockets.connect(ws_url, max_size=None) as ws:
            await ws.send(json.dumps({"id": 1, "method": "Browser.close"}))
            with contextlib.suppress(Exception):
                await asyncio.wait_for(ws.recv(), 2)

    def alive():
        return subprocess.run(["pgrep", "-f", "--", "--user-data-dir=" + profile], capture_output=True).returncode == 0

    for sig in (None, "-TERM", "-KILL"):
        if sig:
            subprocess.run(["pkill", sig, "-f", "--", "--user-data-dir=" + profile], capture_output=True)
        for _ in range(25):
            if not alive():
                break
            await asyncio.sleep(0.2)
        if not alive():
            break
    proc.terminate()
    with contextlib.suppress(Exception):
        proc.wait(5)


def chrome_command(profile, port):
    flags = [
        "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
        f"--remote-debugging-port={port}", f"--user-data-dir={profile}", "--window-size=1440,900",
        "--hide-scrollbars", "about:blank",
    ]
    env = os.environ.get("CHROME")
    if env:
        return env.split() + flags
    for name in ("google-chrome", "google-chrome-stable", "chromium", "chromium-browser"):
        p = shutil.which(name)
        if p:
            return [p] + flags
    if shutil.which("flatpak"):
        return ["flatpak", "run", f"--filesystem={profile}", "com.google.Chrome"] + flags
    raise SystemExit("No Chrome/Chromium found. Set CHROME=/path/to/chrome")


class CDP:
    def __init__(self, ws):
        self.ws = ws
        self.n = 0
        self.pending = {}
        self.console = []

    async def run(self):
        async for raw in self.ws:
            msg = json.loads(raw)
            if "id" in msg and msg["id"] in self.pending:
                self.pending.pop(msg["id"]).set_result(msg)
            elif msg.get("method") == "Runtime.exceptionThrown":
                d = msg["params"]["exceptionDetails"]
                self.console.append("EXCEPTION " + (d.get("exception", {}).get("description") or d.get("text", "")))
            elif msg.get("method") == "Runtime.consoleAPICalled":
                p = msg["params"]
                if p["type"] in ("error", "warning"):
                    self.console.append(p["type"].upper() + " " + " ".join(str(a.get("value", a.get("description", ""))) for a in p["args"]))

    async def send(self, method, params=None, timeout=900):
        self.n += 1
        fut = asyncio.get_event_loop().create_future()
        self.pending[self.n] = fut
        await self.ws.send(json.dumps({"id": self.n, "method": method, "params": params or {}}))
        res = await asyncio.wait_for(fut, timeout)
        if "error" in res:
            raise RuntimeError(f"{method}: {res['error']}")
        return res["result"]

    async def eval(self, expr, timeout=900):
        r = await self.send("Runtime.evaluate", {"expression": expr, "awaitPromise": True, "returnByValue": True}, timeout)
        if r.get("exceptionDetails"):
            d = r["exceptionDetails"]
            raise RuntimeError("JS error: " + (d.get("exception", {}).get("description") or d.get("text", "")))
        return r["result"].get("value")

    async def goto(self, url):
        await self.send("Page.navigate", {"url": url})
        for _ in range(200):
            await asyncio.sleep(0.1)
            try:
                if await self.eval("document.readyState") == "complete":
                    return
            except RuntimeError:
                pass

    async def wait_for(self, expr, timeout=900, poll=0.5):
        t0 = time.time()
        while time.time() - t0 < timeout:
            try:
                if await self.eval(expr, timeout=timeout):
                    return True
            except (RuntimeError, asyncio.TimeoutError):
                pass
            await asyncio.sleep(poll)
        raise TimeoutError(expr)

    async def shot(self, path):
        r = await self.send("Page.captureScreenshot", {"format": "png"})
        with open(path, "wb") as f:
            f.write(base64.b64decode(r["data"]))
        print(f"  screenshot: {path}")

    async def mouse(self, kind, x, y, buttons=0):
        await self.send("Input.dispatchMouseEvent", {"type": kind, "x": x, "y": y, "button": "left" if kind != "mouseMoved" or buttons else "none",
                                                     "buttons": buttons, "clickCount": 1 if kind != "mouseMoved" else 0})

    async def click(self, x, y):
        await self.mouse("mouseMoved", x, y)
        await self.mouse("mousePressed", x, y, 1)
        await asyncio.sleep(0.05)
        await self.mouse("mouseReleased", x, y)

    async def drag(self, x0, y0, x1, y1, hold=0.0, steps=8):
        await self.mouse("mouseMoved", x0, y0)
        await self.mouse("mousePressed", x0, y0, 1)
        for i in range(1, steps + 1):
            await self.mouse("mouseMoved", x0 + (x1 - x0) * i / steps, y0 + (y1 - y0) * i / steps, 1)
            await asyncio.sleep(0.02)
        await asyncio.sleep(hold)
        await self.mouse("mouseReleased", x1, y1)

    async def click_el(self, selector):
        r = json.loads(await self.eval(f"(() => {{ const e = document.querySelector({json.dumps(selector)}); if (!e) return 'null'; const b = e.getBoundingClientRect(); return JSON.stringify({{x: b.x + b.width / 2, y: b.y + b.height / 2}}); }})()"))
        if not r:
            raise RuntimeError("no element " + selector)
        await self.click(r["x"], r["y"])

    async def key(self, code, key=None, down_ms=60):
        key = key or code
        info = {"code": code, "key": key, "windowsVirtualKeyCode": KEYCODES.get(code, 0)}
        await self.send("Input.dispatchKeyEvent", dict(type="keyDown", **info))
        await asyncio.sleep(down_ms / 1000)
        await self.send("Input.dispatchKeyEvent", dict(type="keyUp", **info))


KEYCODES = {"KeyU": 85, "KeyS": 83, "Space": 32, "KeyM": 77, "KeyZ": 90, "KeyX": 88, "KeyP": 80, "KeyR": 82, "KeyD": 68, "KeyA": 65,
            "Period": 190, "Comma": 188, "Escape": 27, "KeyH": 72, "KeyT": 84, "KeyV": 86, "Delete": 46}


async def run_core(cdp, base, shots):
    print("== Simulation checks (tests/index.html) ==")
    await cdp.goto(base + "/tests/index.html")
    await cdp.wait_for("window.TESTS_DONE === true", timeout=1200)
    data = await cdp.eval("JSON.stringify(window.TEST_RESULTS)")
    data = json.loads(data)
    ok = True
    for r in data["results"]:
        ok &= r["pass"]
        print(f"[{'PASS' if r['pass'] else 'FAIL'}] {r['name']}  ({r['ms']} ms)")
        for d in r["details"]:
            print("       " + d)
    if shots:
        await cdp.send("Emulation.setDeviceMetricsOverride", {"width": 1200, "height": 2400, "deviceScaleFactor": 1, "mobile": False})
        await cdp.shot(os.path.join(shots, "core-tests.png"))
        await cdp.send("Emulation.clearDeviceMetricsOverride")
    return ok


async def run_ui(cdp, base, shots):
    """Hangar build + save, reload, reopen; then a short flight through the real UI."""
    print("== UI checks (index.html) ==")
    ok = True

    def report(name, passed, detail=""):
        nonlocal ok
        ok &= bool(passed)
        print(f"[{'PASS' if passed else 'FAIL'}] {name}" + (f"\n       {detail}" if detail else ""))

    await cdp.goto(base + "/index.html")
    await cdp.eval("localStorage.clear(); true")
    await cdp.goto(base + "/index.html")
    await cdp.wait_for("!!window.APP && !!document.querySelector('#catalog .part-card')")
    if shots:
        await cdp.shot(os.path.join(shots, "hangar-starter.png"))

    # Build a custom rocket through the UI: New, then click catalogue cards (click = add to bottom).
    built = await cdp.eval("""(async () => {
      const q = (s) => document.querySelector(s);
      const click = (el) => el.dispatchEvent(new MouseEvent('click', {bubbles: true}));
      window.confirm = () => true;
      click(q('#btnNew'));
      for (const t of ['pod_lark','tank_m','legs','eng_sparrow','decoupler','tank_l','eng_hammer']) {
        click(q(`#catalog .part-card[data-type="${t}"] .add`));
      }
      const name = q('#designName'); name.value = 'Test Lifter'; name.dispatchEvent(new Event('input', {bubbles: true}));
      click(q('#btnSave'));
      const d = APP.hangar.design;
      return JSON.stringify({parts: d.parts.map(p => p.type), stages: d.stages.length,
        stats: q('#stats').innerText.replace(/\\s+/g, ' ').slice(0, 300),
        staging: q('#staging').innerText.replace(/\\s+/g, ' ').slice(0, 400),
        saved: Object.keys(JSON.parse(localStorage.getItem('pocketOrbits.designs.v1') || '{}'))});
    })()""")
    built = json.loads(built)
    report("Build a rocket in the hangar and save it as 'Test Lifter'",
           built["parts"] == ['pod_lark', 'tank_m', 'legs', 'eng_sparrow', 'decoupler', 'tank_l', 'eng_hammer'] and 'Test Lifter' in built["saved"],
           f"parts={built['parts']}\n       stats: {built['stats']}\n       staging: {built['staging']}\n       saved designs: {built['saved']}")
    if shots:
        await cdp.shot(os.path.join(shots, "hangar-custom.png"))

    # Switch to the starter, then reload and reopen the saved design.
    await cdp.eval("document.querySelector('#btnStarter').click(); true")
    await cdp.goto(base + "/index.html")
    await cdp.wait_for("!!window.APP && !!document.querySelector('#catalog .part-card')")
    reopened = await cdp.eval("""(() => {
      const sel = document.querySelector('#designSelect');
      const opt = [...sel.options].find(o => o.textContent.includes('Test Lifter'));
      if (!opt) return JSON.stringify({error: 'not in list', options: [...sel.options].map(o => o.textContent)});
      sel.value = opt.value; sel.dispatchEvent(new Event('change', {bubbles: true}));
      document.querySelector('#btnOpen').click();
      const d = APP.hangar.design;
      return JSON.stringify({name: d.name, parts: d.parts.map(p => p.type), stages: d.stages.map(s => s.length)});
    })()""")
    reopened = json.loads(reopened)
    report("Reload the page and reopen the saved design",
           reopened.get("name") == "Test Lifter" and reopened.get("parts") == built["parts"], json.dumps(reopened))

    # Staging edit: move the Sparrow into stage 1 and back using the staging buttons.
    stg = await cdp.eval("""(() => {
      const before = APP.hangar.design.stages.map(s => s.length).join(',');
      const item = [...document.querySelectorAll('#staging .stage-item[data-role="engine"]')].find(e => e.innerText.includes('Sparrow'));
      const btn = item && item.querySelector('.mv-up');
      const items = [...document.querySelectorAll('#staging .stage-item')].map(e => e.innerText.replace(/\\s+/g,' '));
      if (btn) btn.click();
      const mid = APP.hangar.design.stages.map(s => s.length).join(',');
      document.querySelector('#btnAutoStage').click();
      const after = APP.hangar.design.stages.map(s => s.length).join(',');
      return JSON.stringify({before, mid, after, items});
    })()""")
    stg = json.loads(stg)
    report("Reorder the staging sequence (move an engine to another step, then auto-stage)",
           stg["before"] != stg["mid"] and stg["after"] == stg["before"], json.dumps(stg))
    await run_paint_ui(cdp, base, shots, report)

    # Launch the starter through the UI and fly a few seconds with keyboard input.
    await cdp.eval("document.querySelector('#btnStarter').click(); document.querySelector('#btnLaunch').click(); true")
    await cdp.wait_for("APP.screen === 'flight'")
    await asyncio.sleep(0.5)
    if shots:
        await cdp.shot(os.path.join(shots, "flight-pad.png"))
    await cdp.key("Space")
    await asyncio.sleep(6)
    await cdp.key("KeyD", down_ms=700)
    await asyncio.sleep(4)
    fl = json.loads(await cdp.eval("""JSON.stringify({sit: APP.flight.situation, alt: APP.flight.altitude(),
        stage: APP.flight.craft.nextStage, hud: document.querySelector('#telemetry').innerText.replace(/\\s+/g,' ')})"""))
    report("Launch from the hangar; Space stages; keyboard steers", fl["sit"] == "flying" and fl["alt"] > 100 and fl["stage"] == 1,
           f"situation={fl['sit']} alt={fl['alt']:.0f} m\n       HUD: {fl['hud'][:260]}")
    if shots:
        await cdp.shot(os.path.join(shots, "flight-ascent.png"))
    await cdp.key("KeyM")
    await asyncio.sleep(0.6)
    mp = await cdp.eval("APP.view")
    report("Map view toggles with M while the flight continues", mp == "map")
    if shots:
        await cdp.shot(os.path.join(shots, "map-ascent.png"))
    await cdp.key("KeyM")

    # Jump to a scripted orbit + Pock transfer state to screenshot the map with an encounter.
    enc = json.loads(await cdp.eval("""(() => {
      const r = APP.debugScenario('transfer');
      return JSON.stringify(r);
    })()"""))
    await asyncio.sleep(1.0)
    report("Map shows a predicted Pock encounter after a transfer burn", enc.get("encounter") is True, json.dumps(enc))
    if shots:
        await cdp.eval("APP.setView('map'); APP.mapView.fitSystem(); true")
        await asyncio.sleep(0.6)
        await cdp.shot(os.path.join(shots, "map-transfer.png"))
        await cdp.eval("APP.mapView.focusOn('pock', 70000); true")
        await asyncio.sleep(0.6)
        await cdp.shot(os.path.join(shots, "map-encounter-zoom.png"))

    land = json.loads(await cdp.eval("JSON.stringify(APP.debugScenario('landed'))"))
    await asyncio.sleep(0.8)
    if shots:
        await cdp.eval("APP.setView('flight'); true")
        await asyncio.sleep(0.5)
        await cdp.shot(os.path.join(shots, "landed-pock.png"))
    crash = json.loads(await cdp.eval("JSON.stringify(APP.debugScenario('crash'))"))
    await cdp.wait_for("!!APP.flight.outcome", timeout=30)
    await asyncio.sleep(1.2)
    txt = await cdp.eval("document.querySelector('#outcome').innerText.replace(/\\s+/g,' ')")
    report("Crash overlay with revert / hangar actions", "CRASH" in txt.upper() and "Revert" in txt and "hangar" in txt.lower(), txt[:200])
    if shots:
        await cdp.shot(os.path.join(shots, "crash.png"))
    await cdp.eval("document.querySelector('#outcome [data-act=revert]').click(); true")
    await asyncio.sleep(0.4)
    rv = json.loads(await cdp.eval("JSON.stringify({sit: APP.flight.situation, t: APP.flight.st.t})"))
    report("Revert to launch resets the flight", rv["sit"] == "prelaunch", json.dumps(rv))
    for b in ("pock", "ferro", "rime"):
        await cdp.eval(f"APP.debugScenario('surface', '{b}'); APP.setView('flight'); true")
        await asyncio.sleep(0.6)
        if shots:
            await cdp.shot(os.path.join(shots, f"surface-{b}.png"))
    if shots:
        await cdp.eval("APP.debugScenario('orbit'); APP.setView('map'); APP.mapView.fitSystem(); true")
        await asyncio.sleep(0.6)
        await cdp.shot(os.path.join(shots, "map-system.png"))
    _ = land, crash

    await run_maneuver_ui(cdp, shots, report)
    await run_alerts_ui(cdp, shots, report)
    await run_parachute_ui(cdp, shots, report)
    await run_planet_textures(base, cdp, shots, report)
    await run_audio(base, cdp, shots, report)

    # Full mission inside the real game page: the scripted pilot drives APP.flight (the same
    # Flight object the keyboard controls) from the pad to the surface of Pock.
    await cdp.eval("APP.toHangar(); document.querySelector('#btnStarter').click(); document.querySelector('#btnLaunch').click(); APP.setView('flight'); true")
    await cdp.eval("new Promise(r => { const s = document.createElement('script'); s.src = 'tests/pilots.js'; s.onload = () => r(true); document.body.appendChild(s); })")
    m1 = json.loads(await cdp.eval("""(() => { const f = APP.flight, log = [];
        const r = Pilots.ascend(f, {turnAlt: 500, turnDeg: 25, targetAp: 30000, targetPe: 20000}, log);
        const el = f.orbit(), R = f.body.radius;
        return JSON.stringify({ok: r.ok, sit: f.situationText(), apKm: +((el.ra - R) / 1000).toFixed(2), peKm: +((el.rp - R) / 1000).toFixed(2), missionTime: Math.round(f.missionTime())}); })()"""))
    report("In-app mission: starter rocket reaches orbit", m1["ok"] and m1["peKm"] > 15, json.dumps(m1))
    if shots:
        await cdp.eval("APP.flightView.zoom = 0.0035; true")
        await asyncio.sleep(0.6)
        await cdp.shot(os.path.join(shots, "mission-1-orbit-flight.png"))
        await cdp.eval("APP.flightView.zoom = 14; APP.setView('map'); true")
        await asyncio.sleep(0.6)
        await cdp.shot(os.path.join(shots, "mission-1-orbit-map.png"))
    m2 = json.loads(await cdp.eval("""(() => { const f = APP.flight, pock = APP.sys.byId('pock');
        const r = Pilots.transfer(f, pock);
        return JSON.stringify({ok: r.ok, burn: +r.dv.toFixed(1), peKm: +(r.pe / 1000).toFixed(2), entryIn: Math.round(r.entry.t - f.st.t)}); })()"""))
    report("In-app mission: transfer burn gives a Pock encounter on the map", m2["ok"], json.dumps(m2))
    if shots:
        await cdp.eval("APP.setView('map'); APP.mapView.fitOrbit(); true")
        await asyncio.sleep(0.6)
        await cdp.shot(os.path.join(shots, "mission-2-transfer-map.png"))
    m3 = json.loads(await cdp.eval("""(() => { const f = APP.flight, pock = APP.sys.byId('pock');
        const w = Pilots.warpToSoi(f); const c = Pilots.capture(f, pock); const el = f.orbit();
        return JSON.stringify({soi: w.ev && w.ev.to.name, maxWarp: w.maxWarp, warpAtEntry: w.warpAtEntry, captured: c.ok, sit: f.situationText(),
          apKm: +((el.ra - pock.radius) / 1000).toFixed(2), peKm: +((el.rp - pock.radius) / 1000).toFixed(2)}); })()"""))
    report("In-app mission: warp to the encounter and capture into Pock orbit", m3["captured"] and m3["soi"] == "Pock", json.dumps(m3))
    if shots:
        await cdp.eval("APP.setView('map'); APP.mapView.fitOrbit(); true")
        await asyncio.sleep(0.6)
        await cdp.shot(os.path.join(shots, "mission-3-pock-orbit-map.png"))
    m4 = json.loads(await cdp.eval("""(() => { const f = APP.flight, pock = APP.sys.byId('pock'), log = [];
        Pilots.deorbit(f, pock); const r = Pilots.land(f, log); const o = f.outcome;
        return JSON.stringify({ok: r.ok, outcome: o && o.type, descent: o && +o.descent.toFixed(2), horizontal: o && +o.horizontal.toFixed(2), tilt: o && +o.tilt.toFixed(1), slope: o && +o.slope.toFixed(1)}); })()"""))
    report("In-app mission: deorbit and land on Pock", m4["outcome"] == "landed", json.dumps(m4))
    if shots:
        await cdp.eval("APP.setView('flight'); APP.flightView.zoom = 9; true")
        await asyncio.sleep(1.0)
        await cdp.shot(os.path.join(shots, "mission-4-landed.png"))
    return ok


async def run_planet_textures(base, cdp, shots, report):
    """GPU sphere textures: shader compiles, every body is textured and lit, the 2D fallback still works."""
    await cdp.goto(base + "/tests/planets.html")
    await cdp.wait_for("!!window.PLANET_CHECK", timeout=60)
    gpu = json.loads(await cdp.eval("JSON.stringify(window.PLANET_CHECK)"))
    if shots:
        await cdp.shot(os.path.join(shots, "planets-gpu.png"))
    varied = all(s["std"] > 25 and s["mean"] > 30 for s in gpu["stats"])
    report("Planet textures: WebGL2 shader renders every body textured and lit", gpu["gpu"] and varied,
           f"renders={gpu['renders']} in {gpu['ms']} ms; " + "; ".join(f"{s['id']} mean {s['mean']} std {s['std']} colours {s['colours']}" for s in gpu["stats"]))
    await cdp.goto(base + "/tests/planets.html?fallback=1")
    await cdp.wait_for("!!window.PLANET_CHECK", timeout=60)
    fb = json.loads(await cdp.eval("JSON.stringify(window.PLANET_CHECK)"))
    report("Planet textures: without WebGL2 the flat 2D discs are drawn instead", (not fb["gpu"]) and all(s["mean"] > 30 for s in fb["stats"]),
           "; ".join(f"{s['id']} mean {s['mean']}" for s in fb["stats"]))
    await cdp.goto(base + "/index.html")  # back to the game for the checks that follow
    await cdp.wait_for("!!window.APP && !!document.querySelector('#catalog .part-card')")
    return True


async def run_audio(base, cdp, shots, report):
    """Engine sound: offline analysis of the synthesised voice, then the game driving it with real input."""
    await cdp.goto(base + "/tests/audio.html")
    await cdp.wait_for("!!window.AUDIO_CHECK", timeout=180)
    a = json.loads(await cdp.eval("JSON.stringify(window.AUDIO_CHECK)"))
    if a.get("error"):
        report("Engine sound: offline analysis", False, a["error"][:300])
    for c in a["checks"]:
        report("Engine sound: " + c["name"], c["pass"], c["detail"])

    await cdp.goto(base + "/index.html")
    await cdp.wait_for("!!window.APP && !!document.querySelector('#catalog .part-card')")
    await cdp.eval("localStorage.removeItem('pocketOrbits.audio.v1'); true")
    await cdp.click_el("#btnStarter")
    await cdp.click_el("#btnLaunch")  # a real click: browsers only start audio after a user gesture
    await cdp.wait_for("APP.screen === 'flight'")
    dbg = "JSON.stringify(SB.Audio.debug())"
    s0 = json.loads(await cdp.eval(dbg))
    await cdp.key("Space")
    await asyncio.sleep(0.6)
    s1 = json.loads(await cdp.eval(dbg))
    report("Engine sound in game: launch starts audio; Space ignites (thump) and the engine roars",
           s0["state"] == "running" and s1["firing"] and s1["level"] > 0.2 and s1["ignitions"] == 1,
           f"context {s0['state']}; after Space: {s1}")
    await cdp.key("KeyX")
    await asyncio.sleep(0.5)
    s2 = json.loads(await cdp.eval(dbg))
    await cdp.key("KeyZ")
    await asyncio.sleep(0.5)
    s3 = json.loads(await cdp.eval(dbg))
    report("Engine sound in game: X cuts it (no flameout), Z relights it",
           not s2["firing"] and s2["level"] == 0 and s2["flameouts"] == 0 and s3["firing"] and s3["ignitions"] == 2,
           f"after X: level {s2['level']}, flameouts {s2['flameouts']}; after Z: ignitions {s3['ignitions']}")
    await cdp.key("KeyM")
    await asyncio.sleep(0.3)
    bus_map = (json.loads(await cdp.eval(dbg)))["bus"]
    await cdp.key("KeyM")
    await cdp.key("Escape")
    await asyncio.sleep(0.3)
    bus_pause = (json.loads(await cdp.eval(dbg)))["bus"]
    await cdp.key("Escape")
    await asyncio.sleep(0.3)
    bus_back = (json.loads(await cdp.eval(dbg)))["bus"]
    report("Engine sound in game: quieter in map view, silent while paused", bus_map < 1 and bus_pause == 0 and bus_back == 1,
           f"bus flight→map {bus_map}, paused {bus_pause}, resumed {bus_back}")
    # run the tank dry while burning: the engine should sputter out
    await cdp.eval("(() => { const c = APP.flight.craft; for (const p of c.parts) if (p.role === 'tank' && c.sections().some(s => s.tanks.includes(p) && s.engines.some(e => c.active.has(e.uid)))) p.fuel = Math.min(p.fuel, 1.5); })(); true")
    await asyncio.sleep(1.5)
    s4 = json.loads(await cdp.eval(dbg))
    report("Engine sound in game: running out of fuel sputters out", s4["flameouts"] == 1 and not s4["firing"], json.dumps(s4))
    await cdp.key("KeyU")
    await asyncio.sleep(0.2)
    muted = json.loads(await cdp.eval("JSON.stringify({a: SB.Audio.debug(), btn: document.querySelector('#btnSound').innerText, saved: localStorage.getItem('pocketOrbits.audio.v1')})"))
    await cdp.goto(base + "/index.html")
    await cdp.wait_for("!!window.APP && !!document.querySelector('#catalog .part-card')")
    after = json.loads(await cdp.eval("JSON.stringify({enabled: SB.Audio.enabled})"))
    await cdp.eval("SB.Audio.setEnabled(true); true")
    report("Engine sound in game: U mutes, and the setting survives a reload",
           not muted["a"]["enabled"] and "Muted" in muted["btn"] and after["enabled"] is False,
           f"button '{muted['btn']}', saved {muted['saved']}, after reload enabled={after['enabled']}")
    return True


async def run_paint_ui(cdp, base, shots, report):
    """Paint parts in the hangar with real clicks; check the canvas pixels, saving, reloading and flight."""
    await cdp.click_el("#btnStarter")
    await asyncio.sleep(0.3)
    part = json.loads(await cdp.eval("""(() => { const h = APP.hangar, p = h.design.parts.find(q => q.type === 'tank_m');
        const r = h.rects.find(q => q.uid === p.uid), b = h.canvas.getBoundingClientRect();
        return JSON.stringify({uid: p.uid, x: b.left + (r.x0 + r.x1) / 2, y: b.top + (r.y0 + r.y1) / 2}); })()"""))
    await cdp.click(part["x"], part["y"])
    await asyncio.sleep(0.3)
    name = await cdp.eval("document.getElementById('paintSection').classList.contains('hidden') ? '' : document.getElementById('ppName').textContent")

    def pixel(fx, fy):  # colour at a fraction of the selected tank's box on the stack canvas
        return cdp.eval("""(() => { const h = APP.hangar, r = h.rects.find(q => q.uid === '%s'), p = h.design.parts.find(q => q.uid === '%s');
            const w = SB.CONFIG.parts[p.type].width, s = (r.y1 - r.y0) / SB.CONFIG.parts[p.type].height, cx = (r.x0 + r.x1) / 2;
            const x = cx + (%f - 0.5) * w * s, y = r.y0 + %f * (r.y1 - r.y0), d = devicePixelRatio || 1;
            return Array.from(h.ctx.getImageData(Math.round(x * d), Math.round(y * d), 1, 1).data.slice(0, 3)); })()""" % (part["uid"], part["uid"], fx, fy))

    before = await pixel(0.5, 0.5)
    await cdp.click_el('#paintSection .swatches[data-slot="base"] .sw[data-color="#c8352b"]')
    await asyncio.sleep(0.2)
    red = await pixel(0.5, 0.5)
    report("Paint: select a part, pick a colour, the stack canvas shows it",
           name == "FT-200 Fuel Tank" and red[0] > red[1] + 60 and red[0] > red[2] + 60 and before[1] > 150,
           f"panel for '{name}'; centre pixel {before} -> {red}")
    await cdp.click_el('#paintSection .pat[data-pattern="checker"]')
    await asyncio.sleep(0.2)
    await cdp.eval("(() => { const i = document.querySelector('#paintSection input[data-slot=accent]'); i.value = '#2a9d9b'; i.dispatchEvent(new Event('input', {bubbles: true})); })(); true")
    await asyncio.sleep(0.2)
    left, right = await pixel(0.4, 0.25), await pixel(0.6, 0.25)  # checker: teal on one side, red on the other
    await cdp.click_el("#ppSameRole")
    await asyncio.sleep(0.2)
    paints = json.loads(await cdp.eval("JSON.stringify(APP.hangar.design.parts.filter(p => p.type.startsWith('tank')).map(p => p.paint))"))
    report("Paint: checker pattern, custom accent colour, 'every tank' copies it",
           sum(abs(a - b) for a, b in zip(left, right)) > 120 and len(paints) == 2 and paints[0] == paints[1] == {"base": "#c8352b", "accent": "#2a9d9b", "pattern": "checker"},
           f"checker pixels {left} vs {right}; tank paints {paints}")
    await cdp.click_el('#paintSection [data-livery="Retro"]')
    await asyncio.sleep(0.2)
    liv = json.loads(await cdp.eval("JSON.stringify(APP.hangar.design.parts.map(p => [p.type, p.paint || null]))"))
    if shots:
        await cdp.shot(os.path.join(shots, "hangar-paint.png"))
    await cdp.eval("(() => { const n = document.querySelector('#designName'); n.value = 'Painted'; n.dispatchEvent(new Event('input', {bubbles: true})); document.querySelector('#btnSave').click(); })(); true")
    await cdp.goto(base + "/index.html")
    await cdp.wait_for("!!window.APP && !!document.querySelector('#catalog .part-card')")
    await cdp.eval("""(() => { const sel = document.querySelector('#designSelect'); sel.value = 's:Painted'; document.querySelector('#btnOpen').click(); })(); true""")
    reloaded = json.loads(await cdp.eval("JSON.stringify(APP.hangar.design.parts.map(p => [p.type, p.paint || null]))"))
    await cdp.click_el("#btnLaunch")
    await cdp.wait_for("APP.screen === 'flight'")
    flown = json.loads(await cdp.eval("JSON.stringify(APP.flight.craft.parts.map(p => [p.type, p.paint || null]))"))
    report("Paint: a livery paints the whole rocket; it survives save, reload and launch",
           all(p for _, p in liv) and liv == reloaded == flown and dict(liv)["tank_m"]["pattern"] == "checker",
           f"Retro livery: {liv}")
    if shots:
        await asyncio.sleep(0.4)
        await cdp.shot(os.path.join(shots, "flight-painted.png"))
    await cdp.eval("APP.toHangar(); true")
    return True


async def run_maneuver_ui(cdp, shots, report):
    """Maneuver nodes through the real UI: mouse on the map, node panel, keyboard to fly the burn."""
    await cdp.eval("new Promise(r => { if (window.Pilots) return r(true); const s = document.createElement('script'); s.src = 'tests/pilots.js'; s.onload = () => r(true); document.body.appendChild(s); })")
    await cdp.eval("APP.debugScenario('orbit'); APP.setView('map'); APP.mapView.fitOrbit(); true")
    await asyncio.sleep(0.8)
    # a point on the orbit ~400 s ahead that is not covered by a HUD panel
    pt = json.loads(await cdp.eval("""(() => { const f = APP.flight, now = f.st.t, cv = document.getElementById('view');
        for (const p of APP.mapView.pick.filter(q => q.layer === 0))
          for (let k = 0; k < p.ts.length; k++)
            if (p.ts[k] > now + 400 && document.elementFromPoint(p.xs[k], p.ys[k]) === cv) return JSON.stringify({x: p.xs[k], y: p.ys[k], dt: p.ts[k] - now});
        return 'null'; })()"""))
    await cdp.mouse("mouseMoved", pt["x"], pt["y"])
    await asyncio.sleep(0.3)
    hover = await cdp.eval("!!APP.mapView.hover")
    tip = await cdp.eval("(APP.mapView.labelInfo.placed.find(p => p.text.startsWith('Alt ')) || {text: ''}).text")
    await cdp.click(pt["x"], pt["y"])
    await asyncio.sleep(0.4)
    n1 = json.loads(await cdp.eval("JSON.stringify({count: APP.flight.planner.count, dt: APP.flight.planner.count ? APP.flight.planner.nodes[0].t - APP.flight.st.t : null})"))
    report("Maneuver: hovering the path shows the altitude and time there; clicking adds a node there",
           hover and tip.startswith("Alt 25.0 km · ") and n1["count"] == 1 and abs(n1["dt"] - pt["dt"]) < 30,
           f"hover={hover} label '{tip}' node={n1} clicked ~{pt['dt']:.0f} s ahead")

    for _ in range(15):
        await cdp.click_el('#nodePanel [data-comp="pro"] [data-dv="10"]')
        await asyncio.sleep(0.03)
    await asyncio.sleep(0.6)
    st = json.loads(await cdp.eval("""(() => { const pl = APP.flight.planner, n = pl.nodes[0], inf = pl.info(n), el = inf.layer.segments[0].el, R = APP.sys.planet.radius;
        return JSON.stringify({pro: n.pro, apKm: (el.ra - R) / 1000, info: document.getElementById('npInfo').innerText.replace(/\\s+/g, ' ')}); })()"""))
    report("Maneuver: node panel +10 button (15 clicks) raises the planned apoapsis", abs(st["pro"] - 150) < 0.01 and st["apKm"] > 200,
           f"prograde {st['pro']:.1f} m/s, planned Ap {st['apKm']:.1f} km; panel: {st['info'][:160]}")

    h = json.loads(await cdp.eval("JSON.stringify(APP.mapView.handles.find(h => h.kind === 'pro'))"))
    before = await cdp.eval("APP.flight.planner.nodes[0].pro")
    await cdp.drag(h["x"], h["y"], h["x"] + h["ax"][0] * 70, h["y"] + h["ax"][1] * 70, hold=1.0)
    await asyncio.sleep(0.3)
    after = await cdp.eval("APP.flight.planner.nodes[0].pro")
    report("Maneuver: dragging the prograde handle outward adds delta-v", after > before + 10, f"prograde {before:.1f} -> {after:.1f} m/s")

    await cdp.eval("(() => { const i = document.querySelector('#nodePanel [data-input=pro]'); i.focus(); i.value = '170'; i.dispatchEvent(new Event('change', {bubbles: true})); })(); true")
    await asyncio.sleep(0.4)
    typed = await cdp.eval("APP.flight.planner.nodes[0].pro")
    report("Maneuver: typing an exact value in the panel", abs(typed - 170) < 1e-6, f"prograde {typed}")

    t0 = await cdp.eval("APP.flight.planner.nodes[0].t")
    ns = json.loads(await cdp.eval("JSON.stringify(APP.mapView.nodeScreens[0])"))
    await cdp.drag(ns["x"], ns["y"], ns["x"] - 40, ns["y"] - 60, hold=0.1)
    await asyncio.sleep(0.4)
    t1 = await cdp.eval("APP.flight.planner.nodes[0].t")
    report("Maneuver: dragging the node along the path changes its time", abs(t1 - t0) > 5, f"node time shifted by {t1 - t0:+.0f} s")

    pt2 = json.loads(await cdp.eval("""(() => { const f = APP.flight, cv = document.getElementById('view'), n = f.planner.nodes[0];
        for (const p of APP.mapView.pick.filter(q => q.layer === 1))
          for (let k = 0; k < p.ts.length; k++)
            if (p.ts[k] > n.t + 900 && p.ts[k] < p.maxT && document.elementFromPoint(p.xs[k], p.ys[k]) === cv) return JSON.stringify({x: p.xs[k], y: p.ys[k]});
        return 'null'; })()"""))
    await cdp.click(pt2["x"], pt2["y"])
    await asyncio.sleep(0.4)
    await cdp.click_el('#nodePanel [data-comp="rad"] [data-dv="10"]')
    await asyncio.sleep(0.6)
    two = json.loads(await cdp.eval("JSON.stringify({count: APP.flight.planner.count, layers: APP.flight.planner.plan.layers.length, rad: APP.flight.planner.selected.rad})"))
    report("Maneuver: clicking the dashed planned path chains a second node", two["count"] == 2 and two["layers"] == 2 and two["rad"] == 10, json.dumps(two))
    if shots:
        await cdp.shot(os.path.join(shots, "nodes-two.png"))
    await cdp.key("Delete")
    await asyncio.sleep(0.3)
    one = await cdp.eval("APP.flight.planner.count")
    await cdp.click_el("#npDel")
    await asyncio.sleep(0.3)
    zero = await cdp.eval("APP.flight.planner.count")
    report("Maneuver: Delete key and the Delete button remove nodes", one == 1 and zero == 0, f"after Delete key: {one}, after button: {zero}")

    # Transfer to Pock placed by hand (there is no "create transfer node" shortcut): target Pock, click the
    # path where the craft will be when the panel's countdown runs out, line the node up with the time
    # buttons, type the suggested delta-v, fine-tune like clicking +0.1, then fly it live.
    await cdp.click_el('#mapPanel [data-target="pock"]')
    await asyncio.sleep(0.5)
    gone = await cdp.eval("!document.querySelector('[data-act=\"plan-transfer\"]') && !document.body.innerText.includes('Create transfer node')")
    await cdp.eval("""(() => { const f = APP.flight, pock = APP.sys.byId('pock'), T = f.orbit().period;
        Pilots.coastUntil(f, (ff) => { const w = ff.transferInfo(pock).wait; return w > 150 && w < T - 150; }, 10);
        f.maybePredict(true); APP.mapView.fitOrbit(); return true; })()""")
    await asyncio.sleep(0.6)
    pt = json.loads(await cdp.eval("""(() => { const f = APP.flight, pock = APP.sys.byId('pock'), cv = document.getElementById('view');
        const tb = f.st.t + f.transferInfo(pock).wait; let best = null;
        for (const p of APP.mapView.pick.filter(q => q.layer === 0)) for (let k = 0; k < p.ts.length; k++) {
          const d = Math.abs(p.ts[k] - tb);
          if ((!best || d < best.d) && document.elementFromPoint(p.xs[k], p.ys[k]) === cv) best = {x: p.xs[k], y: p.ys[k], d};
        }
        return JSON.stringify(best); })()"""))
    await cdp.click(pt["x"], pt["y"])
    await asyncio.sleep(0.4)
    offset = "(() => { const f = APP.flight; return f.st.t + f.transferInfo(APP.sys.byId('pock')).wait - f.planner.nodes[0].t; })()"
    for _ in range(60):  # the node panel's time buttons, like a player matching "Node in" to the countdown
        dt = await cdp.eval(offset)
        if abs(dt) < 1.5:
            break
        step = "60" if abs(dt) >= 45 else "10" if abs(dt) >= 7 else "1"
        await cdp.click_el(f'#nodePanel [data-dt="{"" if dt > 0 else "-"}{step}"]')
        await asyncio.sleep(0.05)
    dv = await cdp.eval("APP.flight.transferInfo(APP.sys.byId('pock')).dv.toFixed(1)")
    await cdp.eval("(() => { const i = document.querySelector('#nodePanel [data-input=pro]'); i.focus(); i.value = '%s'; i.dispatchEvent(new Event('change', {bubbles: true})); })(); true" % dv)
    await asyncio.sleep(0.4)
    tune = json.loads(await cdp.eval("""(() => { const f = APP.flight, pock = APP.sys.byId('pock'), n = f.planner.nodes[0];
        const ok = (inf) => { const pe = Pilots.layerPeAt(inf.layer, pock); return pe !== null && pe > 4000 && pe < 9000; };
        let r = Pilots.tuneNode(f, n, 'pro', 0.1, ok, 150);
        if (!r.ok) { f.planner.setComps(n, f.transferInfo(pock).dv, 0); r = Pilots.tuneNode(f, n, 'pro', -0.1, ok, 150); }
        return JSON.stringify({ok: r.ok, pro: n.pro, pe: Pilots.layerPeAt(f.planner.info(n).layer, pock), wait: n.t - f.st.t}); })()"""))
    report("Maneuver: no transfer shortcut; a hand-placed node at the hinted time, fine-tuned, gives a planned Pock encounter",
           gone and tune["ok"], f"button gone={gone}; clicked {pt['d']:.0f} s from the hint, matched with the time buttons; typed {dv} m/s; " + json.dumps(tune))
    await asyncio.sleep(0.6)
    if shots:
        await cdp.shot(os.path.join(shots, "nodes-transfer-plan.png"))
    await cdp.click_el("#npWarp")
    await cdp.wait_for("APP.flight.planner.nextBurnStart() - APP.flight.st.t < 10", timeout=120, poll=0.1)
    warp_at = await cdp.eval("APP.flight.warpRate()")
    await cdp.key("KeyV")
    await cdp.key("KeyM")
    await cdp.wait_for("APP.flight.st.t >= APP.flight.planner.nextBurnStart()", timeout=60, poll=0.05)
    await cdp.key("KeyZ")
    await asyncio.sleep(6)
    if shots:
        await cdp.shot(os.path.join(shots, "nodes-burning.png"))
    rem = "(() => { const i = APP.flight.planner.plan && APP.flight.planner.plan.infos[0]; return i ? i.total : 0; })()"
    await cdp.wait_for(rem + " < 12", timeout=120, poll=0.05)
    await cdp.key("KeyS", down_ms=1000)  # ease off for the last few m/s, like a player would
    await cdp.wait_for(rem + " < 0.8", timeout=120, poll=0.05)
    left = await cdp.eval(rem)
    await cdp.key("KeyX")
    await asyncio.sleep(1.0)
    fin = json.loads(await cdp.eval("""(() => { const f = APP.flight, pock = APP.sys.byId('pock');
        const ev = f.prediction.events.find(e => e.type === 'soi' && e.to === pock);
        return JSON.stringify({nodes: f.planner.count, sas: f.sas, encounter: !!ev, pe: Pilots.predictedPeAlt(f, pock), msgs: f.messages.map(m => m.text)}); })()"""))
    report("Maneuver: fly it with Warp to burn, V, Z, X: node clears and the real trajectory meets Pock",
           warp_at <= 2 and fin["nodes"] == 0 and fin["encounter"],
           f"warp near burn start {warp_at}x; Δv left at cut {left:.2f} m/s; {json.dumps(fin)}")
    return True


async def run_alerts_ui(cdp, shots, report):
    """Cautions and warnings as the player meets them, and the decluttered map view."""
    await cdp.eval("new Promise(r => { if (window.Pilots) return r(true); const s = document.createElement('script'); s.src = 'tests/pilots.js'; s.onload = () => r(true); document.body.appendChild(s); })")
    audio = "JSON.stringify(SB.Audio.debug())"

    # 1. The booster runs dry mid-burn in orbit, with the upper stage still waiting.
    await cdp.eval("""(() => { APP.toHangar(); document.querySelector('#btnStarter').click(); document.querySelector('#btnLaunch').click();
        const f = APP.flight, P = APP.sys.planet, r = P.radius + 25000;
        f.stage(); f.situation = 'flying'; f.st.body = P; f.st.rx = 0; f.st.ry = r; f.st.vx = Math.sqrt(P.mu / r); f.st.vy = 0;
        f.heading = 0; f.setThrottle(1); f.messages = [];
        const sec = f.craft.sections().find(s => s.engines.some(e => f.craft.active.has(e.uid)));
        for (const t of sec.tanks) t.fuel = t.fuelMax * 0.004;  // about half a second of burn left
        APP.setView('flight'); return true; })()""")
    s0 = json.loads(await cdp.eval(audio))
    await asyncio.sleep(1.2)
    state = """JSON.stringify({alerts: [...document.querySelectorAll('#alerts .alert')].map(e => e.className.replace('alert ', '') + ': ' + e.textContent),
        ready: document.querySelector('#btnStage').classList.contains('ready'), vignette: document.querySelector('#vignette').classList.contains('on'),
        msgs: APP.flight.messages.map(m => m.text),
        rows: Object.fromEntries([...document.querySelectorAll('#telemetry .t-row')].map(e => [e.querySelector('span').textContent, e.className.replace('t-row', '').trim() + ' | ' + e.querySelector('b').textContent])),
        audio: SB.Audio.debug()})"""
    dry = json.loads(await cdp.eval(state))
    fuel_row = dry["rows"].get("STAGE FUEL", "")
    report("Alerts: a stage running dry gets a caution strip, a message, a pulsing STAGE button, EMPTY on the HUD and a chime",
           any(a.startswith("caution") and "press Space" in a for a in dry["alerts"]) and dry["ready"] and not dry["vignette"]
           and any(m.startswith("Out of fuel") for m in dry["msgs"]) and "EMPTY" in fuel_row and dry["audio"]["chimes"] > s0["chimes"],
           f"strips {dry['alerts']}; STAGE pulsing {dry['ready']}; messages {dry['msgs']}; fuel row '{fuel_row}'; "
           f"chimes {s0['chimes']} -> {dry['audio']['chimes']} (audio {dry['audio']['state']})")
    if shots:
        await cdp.shot(os.path.join(shots, "alert-stage-empty.png"))
    await cdp.key("Space")
    await asyncio.sleep(0.5)
    staged = json.loads(await cdp.eval(state))
    report("Alerts: pressing Space stages; the caution and the pulse clear", not staged["alerts"] and not staged["ready"],
           f"strips {staged['alerts']}; STAGE pulsing {staged['ready']}")

    # 2. Falling at Pock too fast to stop in time: red strip, flashing edges, beeps, V.SPD flagged.
    await cdp.eval("""(() => { APP.debugScenario('landed'); const f = APP.flight; f.outcome = null; f.messages = [];
        const c = f.craft, accel = c.thrustState(1, 0).thrust / c.mass() - f.localGravity();
        const L = f.landingLimits().maxDescent, v = 40, h = (v * v - L * L) / (2 * accel) / 1.3;
        const n = Math.hypot(f.st.rx, f.st.ry), u = [f.st.rx / n, f.st.ry / n];
        f.st.rx += u[0] * h; f.st.ry += u[1] * h; f.st.vx = -u[0] * v; f.st.vy = -u[1] * v;
        f.situation = 'flying'; f.setThrottle(0); f.setSas('stability', true);
        APP.setView('flight'); APP.flightView.zoom = 2.5; return true; })()""")
    s1 = json.loads(await cdp.eval(audio))
    await asyncio.sleep(1.0)
    sink = json.loads(await cdp.eval(state))
    vspd = sink["rows"].get("V.SPD", "")
    if shots:
        await cdp.shot(os.path.join(shots, "alert-sink-rate.png"))
    report("Alerts: falling too fast near the ground flashes the screen edges, beeps and flags V.SPD",
           any(a.startswith("warning") and "sink rate" in a.lower() for a in sink["alerts"]) and sink["vignette"]
           and vspd.startswith("bad") and sink["audio"]["beeps"] >= s1["beeps"] + 1,
           f"strips {sink['alerts']}; edges flashing {sink['vignette']}; V.SPD '{vspd}'; beeps {s1['beeps']} -> {sink['audio']['beeps']}")
    await cdp.eval("""(() => { const f = APP.flight, n = Math.hypot(f.st.rx, f.st.ry); f.st.vx = -f.st.rx / n * 2; f.st.vy = -f.st.ry / n * 2; return true; })()""")
    await asyncio.sleep(0.4)
    calm = json.loads(await cdp.eval(state))
    report("Alerts: back to a gentle descent, the warning clears", not calm["alerts"] and not calm["vignette"],
           f"strips {calm['alerts']}; edges flashing {calm['vignette']}")
    await cdp.eval("APP.flight.paused = true; true")

    # 3. Map view: a slim control deck, and labels that keep clear of each other, the markers and the panels.
    await cdp.eval("APP.debugScenario('orbit'); APP.setView('flight'); true")
    await asyncio.sleep(0.4)
    deck_flight = await cdp.eval("document.querySelector('#controls').getBoundingClientRect().height")
    await cdp.eval("""(() => { const f = APP.flight, pock = APP.sys.byId('pock'); f.setTarget(pock);
        Pilots.addTransferNode(f, pock); f.maybePredict(true); f.planner.compute();
        APP.setView('map'); APP.mapView.fitOrbit(); return true; })()""")
    await asyncio.sleep(0.9)
    lab = json.loads(await cdp.eval("""(() => { const mv = APP.mapView, info = mv.labelInfo;
        const ov = (a, b) => a[0] < b[0] + b[2] && a[0] + a[2] > b[0] && a[1] < b[1] + b[3] && a[1] + a[3] > b[1];
        const P = info.placed, clash = [], hit = [];
        for (let i = 0; i < P.length; i++) {
          for (let j = i + 1; j < P.length; j++) if (ov(P[i].r, P[j].r)) clash.push(P[i].text + ' / ' + P[j].text);
          if (info.obstacles.some(o => ov(P[i].r, o))) hit.push(P[i].text);
        }
        return JSON.stringify({deck: document.querySelector('#controls').getBoundingClientRect().height, dial: document.querySelector('#dial').getBoundingClientRect().width, placed: P.map(p => p.text),
          requested: info.requested, forced: P.filter(p => p.forced).length, clash, hit, panels: mv.hudRects().length}); })()"""))
    if shots:
        await cdp.shot(os.path.join(shots, "map-labels.png"))
    report("Map view: slimmer control deck with the attitude dial; no label overlaps another label, a marker or a HUD panel",
           lab["deck"] < deck_flight - 20 and lab["dial"] >= 140 and not lab["clash"] and not lab["hit"] and lab["forced"] == 0 and len(lab["placed"]) >= 5,
           f"deck height {deck_flight:.0f} px in flight, {lab['deck']:.0f} px on the map, dial {lab['dial']:.0f} px; {len(lab['placed'])}/{lab['requested']} labels placed "
           f"around {lab['panels']} panels, {lab['forced']} forced; overlaps {lab['clash']} {lab['hit']}\n       labels: {lab['placed']}")
    return True


async def run_parachute_ui(cdp, shots, report):
    """Parachutes through the real UI: the preset's staging, arming with Space, drogues then mains, warp and the map."""
    info = json.loads(await cdp.eval("""(() => { APP.toHangar(); const h = APP.hangar, i = SB.CONFIG.presets.findIndex(p => /parachute/i.test(p.name));
        h.setDesign(h.preset(i)); h.selected = null; h.render(); h.renderInfo();
        const steps = [...document.querySelectorAll('#staging .stage-step')];
        const p = h.design.parts.find(q => q.type === 'chute'), r = h.rects.find(q => q.uid === p.uid), b = h.canvas.getBoundingClientRect();
        return JSON.stringify({last: steps[steps.length - 1].innerText.replace(/\\s+/g, ' '), x: b.left + (r.x0 + r.x1) / 2, y: b.top + (r.y0 + r.y1) / 2}); })()"""))
    await cdp.click(info["x"], info["y"])
    await asyncio.sleep(0.3)
    name = await cdp.eval("document.getElementById('paintSection').classList.contains('hidden') ? '' : document.getElementById('ppName').textContent")
    report("Parachutes: the preset fires them as its last stage (CHUTES), and clicking the pack opens its paint panel",
           "CHUTES" in info["last"] and "Triad Parachute Pack" in info["last"] and name == "Triad Parachute Pack",
           f"last stage: '{info['last']}'; paint panel for '{name}'")

    await cdp.eval("APP.hangar.selected = null; APP.hangar.render(); true")
    await cdp.click_el("#btnLaunch")
    await cdp.wait_for("APP.screen === 'flight'")
    await cdp.eval("""(() => { const f = APP.flight, P = APP.sys.planet;
        f.stage(); f.situation = 'flying'; f.stage(); f.setThrottle(0); f.messages = [];
        const a = P.launchAngle + 0.05, R = APP.sys.surfaceRadius(P, a) + f.geometry().bottomOffset + 2650;
        f.st.rx = Math.cos(a) * R; f.st.ry = Math.sin(a) * R; f.st.vx = -Math.cos(a) * 60; f.st.vy = -Math.sin(a) * 60;
        f.heading = a; APP.setView('flight'); APP.flightView.zoom = 5; return true; })()""")
    state = """JSON.stringify((() => { const f = APP.flight, c = f.craft.parts.find(p => p.role === 'chute').chute;
        const rows = Object.fromEntries([...document.querySelectorAll('#telemetry .t-row')].map(e => [e.querySelector('span').textContent, e.querySelector('b').textContent]));
        const err = Math.abs(SB.Orbit.wrapPi(Math.atan2(-f.st.vy, -f.st.vx) - f.heading)) * 180 / Math.PI;
        return {stage: c.stage, main: c.main.map(x => +x.toFixed(2)), msgs: f.messages.map(m => m.text), whumps: SB.Audio.debug().whumps,
          chutes: rows['CHUTES'] || '', touchdown: rows['TOUCHDOWN'] || '', tilt: +err.toFixed(1), warp: f.warpRate(), mode: document.getElementById('warpMode').textContent}; })())"""
    w0 = json.loads(await cdp.eval(state))["whumps"]
    await cdp.key("Space")
    await asyncio.sleep(1.0)
    s1 = json.loads(await cdp.eval(state))
    await asyncio.sleep(6.5)
    s2 = json.loads(await cdp.eval(state))
    if shots:
        await cdp.shot(os.path.join(shots, "chutes-mains.png"))
    report("Parachutes: Space arms them; the drogues, then the three mains open with a whump each; the pod hangs upright; the HUD shows the touchdown",
           s1["stage"] == "drogue" and any("chutes armed" in m for m in s1["msgs"]) and s2["stage"] == "main" and s2["main"] == [1, 1, 1]
           and s2["whumps"] >= w0 + 2 and s2["chutes"] == "mains open" and "m/s" in s2["touchdown"] and s2["tilt"] < 10,
           f"after Space: {s1['stage']} {s1['msgs']}; 7.5 s later: {s2['stage']} {s2['main']}, CHUTES '{s2['chutes']}', TOUCHDOWN '{s2['touchdown']}', "
           f"{s2['tilt']}° from hanging straight; whumps {w0} -> {s2['whumps']}")
    for _ in range(6):
        await cdp.key("Period")
        await asyncio.sleep(0.05)
    await asyncio.sleep(0.5)
    await cdp.key("KeyM")
    await asyncio.sleep(0.8)
    s3 = json.loads(await cdp.eval(state))
    m = json.loads(await cdp.eval("""JSON.stringify({panel: document.getElementById('mapPanel').innerText.replace(/\\s+/g, ' '),
        label: (APP.mapView.labelInfo.placed.find(p => p.text.startsWith('Touchdown')) || {text: ''}).text})"""))
    if shots:
        await cdp.shot(os.path.join(shots, "chutes-map.png"))
    report("Parachutes: time warp reaches 50x under the open mains (still physics), and the map gives the touchdown time instead of a drag-free impact",
           s3["warp"] == 50 and s3["mode"] == "physics" and "Touchdown under chutes" in m["panel"] and m["label"].startswith("Touchdown under chutes"),
           f"warp {s3['warp']}x ({s3['mode']}); map label '{m['label']}'")
    await cdp.eval("APP.flight.paused = true; APP.setView('flight'); true")
    return True


async def main():
    mode = sys.argv[1] if len(sys.argv) > 1 else "all"
    shots = None
    if "--shots" in sys.argv:
        shots = sys.argv[sys.argv.index("--shots") + 1]
        os.makedirs(shots, exist_ok=True)
    httpd, http_port = start_server()
    dbg = free_port()
    profile = tempfile.mkdtemp(prefix="po-chrome-")
    proc = subprocess.Popen(chrome_command(profile, dbg), stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        ws_url = None
        for _ in range(100):
            try:
                with urllib.request.urlopen(f"http://127.0.0.1:{dbg}/json") as r:
                    pages = [t for t in json.load(r) if t["type"] == "page"]
                if pages:
                    ws_url = pages[0]["webSocketDebuggerUrl"]
                    break
            except OSError:
                pass
            time.sleep(0.2)
        if not ws_url:
            raise SystemExit("Could not connect to Chrome")
        async with websockets.connect(ws_url, max_size=None) as ws:
            cdp = CDP(ws)
            reader = asyncio.create_task(cdp.run())
            await cdp.send("Page.enable")
            await cdp.send("Runtime.enable")
            base = f"http://127.0.0.1:{http_port}"
            ok = True
            if mode == "eval":  # python3 run_browser_tests.py eval "<js expression>"
                await cdp.goto(base + "/tests/sandbox.html")
                await cdp.wait_for("window.READY === true")
                print(await cdp.eval(sys.argv[2]))
                reader.cancel()
                return 0
            if mode in ("core", "all"):
                ok &= await run_core(cdp, base, shots)
            if mode in ("ui", "all"):
                ok &= await run_ui(cdp, base, shots)
            if cdp.console:
                print("== Browser console errors/warnings ==")
                for c in cdp.console:
                    print("  " + c)
            reader.cancel()
            print("ALL PASSED" if ok else "SOME CHECKS FAILED")
            return 0 if ok else 1
    finally:
        await stop_chrome(proc, profile, dbg)
        httpd.shutdown()
        shutil.rmtree(profile, ignore_errors=True)


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
