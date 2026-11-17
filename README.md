# Pocket Orbits

A small 2D spaceflight sandbox that runs entirely in the browser. You assemble a rocket in the hangar, launch it, stage it into orbit, transfer to a moon and land. There are no dependencies and no build step.

**Play online:** <https://ognevoa.github.io/pocket-orbits/>

## Run it

- **Online:** <https://ognevoa.github.io/pocket-orbits/> (GitHub Pages, served straight from `main`).
- **Locally:** open `index.html` in a current Chrome, Edge, Firefox or Safari. It works from `file://`.
- **Or serve it:** `python3 -m http.server 8000` in this folder, then open <http://localhost:8000>.

Designs are saved in your browser's `localStorage`. The design you're working on is also autosaved, so a reload brings it back.

## Fly the starter rocket (Kestrel)

The hangar opens with **Kestrel**, a ready-to-launch two-stage rocket. Its numbers are 2,910 kg wet, liftoff TWR 1.92, and Δv of 1,296 m/s (stage 1, vacuum) plus 1,573 m/s (stage 2). Press **Launch ▲**, then follow the checklist. The same checklist is in the game under **Help · H**.

### 1 · Reach orbit
1. Throttle starts at 100%. Press **Space** to ignite stage 1 (Hammer) and lift off.
2. At **500 m** hold **D** until the attitude dial shows **25° R**, then release. Stability assist holds the tilt.
3. When the green prograde marker on the dial reaches the yellow needle (about 1.5 km), press **P** for prograde hold. The rocket now gravity-turns on its own.
4. When **APOAPSIS** reads **30 km** (about T+1:40 at 11 km altitude), press **X**.
5. Above 15 km press **.** to warp toward apoapsis. Drop back to real time when the apoapsis timer shows about 15 s.
6. About **5–10 s before apoapsis**, still holding prograde, press **Z**. Press **X** when **PERIAPSIS** passes **20 km**. You are now in an orbit of about 29.5 × 20 km, with about 100 kg of booster fuel left for the next burn.

### 2 · Intercept the inner moon (Pock)
1. Press **M** for the map and click **Pock** (or press **N**).
2. The map panel shows the phase angle and *"Transfer burn ≈ 170 m/s prograde in …"*. Warp until that countdown is a few seconds away.
3. Press **P**, then **Z**. Press **Space** when the booster runs dry and the Sparrow takes over.
4. When the map shows **Encounter Pock**, throttle down (**S**) and keep burning until the orange Pock periapsis reads **3–9 km**. Then press **X**.
5. Warp freely. Warp slows down by itself before the sphere-of-influence (SOI) boundary.

**With maneuver nodes instead:** in step 2, press **Create transfer node** in the map panel. Click the node panel's **+.1** until it shows *Pock encounter Pe 3–9 km*. Then click **Warp to burn**, press **V**, and press **Z** when *Start burn* says **NOW**. Ease off with **S** for the last few m/s and press **X** near 0. You can also add the capture burn before leaving: click the dashed path at Pock's periapsis and drag the retrograde handle until the panel shows a closed orbit.

### 3 · Lunar orbit and landing
1. After *"Entered Pock's sphere of influence"*, warp until the periapsis timer reads about 40 s.
2. Press **R** (retrograde hold) and **Z**. Burn until an apoapsis below about 15 km appears, then press **X**. Pock's SOI reaches only about 21.7 km above its surface.
3. To deorbit, press **R** and **Z** until **PERIAPSIS** is below −3 km, then press **X**.
4. Warp down (it slows near the ground) and keep retrograde hold. From about **500 m RADAR**, use the throttle to keep the descent rate near RADAR ÷ 10.
5. Below about 50 m, with horizontal speed under 1 m/s, press **T** (stability) and stand upright with **A**/**D**.
6. A safe touchdown with legs needs descent ≤ 6 m/s, horizontal speed ≤ 3 m/s, tilt ≤ 12° and ground slope ≤ 25°. The HUD's **GROUND** row shows the slope.

## Controls

| Key | Action | Key | Action |
| --- | --- | --- | --- |
| Space | Next stage | M | Map view |
| W / S, ↑ / ↓ | Throttle up / down (Shift = fine) | Tab | Map focus |
| Z / X | Full throttle / cut throttle | N | Next target moon |
| A / D, ← / → | Rotate left / right | Wheel, + / − | Zoom |
| T | Stability assist on / off | . / , | Warp faster / slower |
| P / R | Hold prograde / retrograde | / | Back to real time |
| V | Hold the maneuver burn direction | Del | Delete the selected maneuver node |
| U | Sound on / off (volume in the Esc menu) | | |
| H | Help and checklist | Esc | Pause menu (revert, hangar) |

Every control also has an on-screen button. Control stays with the same craft in both the flight view and the map.

## Maneuver nodes

Plan burns in advance on the map (**M**):

- **Add:** click your trajectory; hovering shows where the node will go. The dashed path is the orbit after the burn, with apoapsis, periapsis, moon encounters and impacts. It's computed with the same gravity, SOI and terrain rules as flight.
- **Shape the burn:** drag the green prograde/retrograde or cyan radial handles. The farther you pull, the faster the Δv changes. Or use the node panel's −10…+10 buttons (hold to repeat) or type exact values.
- **Move in time:** drag the node along its path, or use −orb, −1m … +1m, +orb.
- **Chain nodes:** click the dashed planned path to add another node, e.g. the capture burn at the moon. Each node's panel shows what it leads to.
- **Transfer helper:** with a moon targeted in a near-circular orbit, **Create transfer node** places a Hohmann burn at the next good moment.
- **Fly it:**
  - **Warp to burn**: warp stops 10 s before the burn should start.
  - **V** holds the burn direction (blue marker on the attitude dial).
  - Throttle up when *Start burn* says **NOW**.
  - The next node keeps its planned orbit fixed, so its Δv counts down as you burn. Cut the throttle near zero and the node removes itself.
- Burns take time, while nodes are instant, so real results land close to the plan but not exactly on it. A moon encounter is sensitive, so check the map afterwards and add a small correction node if needed.

## Rules of the sandbox

- **Hangar.** Drag parts onto the stack; a highlighted line shows where they snap. Drag a part off the stack to remove it, or select it and use Up, Down and Remove (also Alt+↑/↓ and Delete). The staging panel lists, for each step, which engines **IGNITE** and which decouplers **DECOUPLE**. Use ▲/▼ to move an item to an earlier or later step, ↑/↓ to reorder whole steps, and **Auto** to restore the default order.
- **Fuel flow.** An engine burns only from tanks in its own section, meaning between its nearest decouplers. When a decoupler fires, everything on the side away from the command pod is dropped, decoupler included.
- **Physics.**
  - Inverse-square gravity from the body whose sphere of influence you're in (patched conics). Moons follow circular orbits.
  - Exponential atmospheric drag below 15 km on Verdis. Thrust points along the rocket's axis, and Isp blends between sea-level and vacuum values with air pressure.
  - Powered or atmospheric flight is integrated with fixed 0.02 s RK4 steps, independent of frame rate.
  - Coasting is propagated analytically (universal-variable Kepler). Orbits therefore don't drift, and high warp is cheap.
- **Prediction and flight share one integrator.** The map's trajectory is computed by the same coasting code the flight uses, with the same SOI, atmosphere and terrain events. SOI changes keep the global position and velocity exactly.
- **Time warp.** Up to 4× works any time (physics warp). Above that, warp runs "on rails" and only while coasting outside the atmosphere. Warp steps itself down before SOI changes, atmospheric entry, terrain impact and the start of the next maneuver burn.
- **Touchdown.** Judged on surface-relative descent rate, horizontal speed, tilt (against local vertical or the ground normal) and ground slope. Legs on the bottom stage raise the limits (6 m/s / 3 m/s / 12° with legs, 2.5 m/s / 1.5 m/s / 8° without).
- **Simplifications.** The world is a single 2D plane, the planet does not rotate, and there is no reentry heating or parachutes.

## Sound

Engine sound is synthesised live with the Web Audio API; there are no audio files.

- **The engine voice** mixes a deep rumble, the exhaust roar, a hiss, a low combustion throb, crackle pops and a turbopump whine.
- **What shapes it:** the throttle, which engines are firing, and the air pressure. Each engine has its own `sound` profile in `js/config.js` (size, crackle, whine). Big boosters are deeper, louder and crackle in air. Small vacuum engines are brighter, with a whine that rises with throttle.
- **In vacuum** the sound turns into a muffled, structure-borne rumble with the whine on top.
- **Events:** ignition gives a thump and a whoosh, including when staging lights a new engine. Running out of fuel coughs and sputters out. Cutting the throttle fades the engine quickly.
- **Mixing:** quieter in map view, silent while paused or in the hangar, and suspended when the tab is hidden.
- **Controls:** **U** mutes. The volume slider is in the **Esc** menu, and both settings are remembered.

Browsers only start audio after you click or press a key; any input in the game does that.

`tests/audio.html` is a sound lab: listen to each engine at sea level and in vacuum, play a scripted launch sequence, or drive the voice live. It also renders the voice offline and checks loudness, brightness, the whine, the ignition transient, flameout and clipping.

## Planet and moon textures

Planets and moons in the map and in distant views are textured spheres, rendered per pixel on the GPU (WebGL2):

- **Projection.** The map looks down on the orbital plane, so each body is seen from above its pole. The disc rim is the equator, which is exactly the terrain outline the flight physics uses.
- **Noise.** Every pixel is placed on the sphere and coloured from several layers of 3D Perlin noise sampled at that point, so there are no seams or pinched poles. Layers are band-limited to the on-screen size, so they stay sharp without shimmering at any zoom.
- **Craters and relief.** Crater and ridge height fields bump the surface normals. Pock's equatorial craters are the same ones that cut its terrain outline. Extra craters at three finer scales fade in as you zoom.
- **Each body:**
  - *Verdis:* continents and seas, forests, deserts and mountains, a small polar cap, drifting clouds, ocean glint and atmospheric haze.
  - *Pock:* grey regolith, dark maria, dense craters and a few young rayed craters.
  - *Ferro:* rust-red terraced ridges with dust lowlands.
  - *Rime:* bright ice crossed by long stained cracks.
- **Sunlight.** One sun lights everything from a fixed direction, so bodies have a day and a night side. The close-up ground and the sky follow the same day/night cycle.
- **Fallback.** Without WebGL2, the game falls back to flat 2D discs.

`tests/planets.html` shows all four bodies plus two close-ups. Add `?fallback=1` to see the 2D version.

## Configuration

Everything tunable lives in **`js/config.js`**: the planet (radius, gravity, atmosphere, launch site), the three moons (radius, gravity, orbit radius, start angle, terrain style, palette), the part catalogue, presets, warp levels and landing limits. Each body also has a `texture` entry (colours, bump strength, number of extra craters, seed), and `sunDirection` sets where the light comes from.

| Body | Radius | g | Orbit | SOI | Look |
| --- | --- | --- | --- | --- | --- |
| Verdis (home) | 120 km | 4.0 m/s² | — | — | green hills and mountains, blue atmosphere |
| Pock | 12 km | 0.3 m/s² | 600 km | 33.7 km | grey, cratered outline |
| Ferro | 22 km | 0.5 m/s² | 1,300 km | 145.7 km | rust-red stepped mesas and cliffs |
| Rime | 35 km | 0.7 m/s² | 2,500 km | 464.6 km | pale ice plains with sharp spires |

## Project layout

```
index.html          page layout, help / checklist
css/style.css       styles
js/config.js        the editable configuration
js/orbit.js         Kepler propagation, orbital elements
js/system.js        bodies, ephemerides, SOIs, atmosphere, terrain generation
js/planets.js       GPU sphere textures (layered noise, craters, lighting)
js/craft.js         designs, staging, fuel sections, Δv/TWR analysis
js/coast.js         shared coasting + event detection, trajectory prediction
js/maneuver.js      maneuver nodes: planned burns, chained predictions, burn estimates
js/sim.js           flight simulation, warp limiter, touchdown evaluation
js/render.js        part painter, flight view, map, attitude dial
js/audio.js         synthesised engine sound (Web Audio)
js/hangar.js        hangar UI and saved designs
js/flightui.js      flight HUD and controls
js/main.js          app shell and game loop
tests/              automated checks (see below)
```

## Automated checks

- **In a browser:** open `tests/index.html`. It runs the simulation checks, including a scripted flight from the pad to the surface of Pock, and lists PASS/FAIL with details.
- **Headless:** `python3 tests/run_browser_tests.py all --shots shots/` runs the simulation checks and the UI checks in headless Chrome over the DevTools protocol. The UI checks cover building, saving, reloading and reopening a design, editing the staging, keyboard flight, the map, the crash card, revert, the planet textures (GPU and 2D fallback), and engine sound (offline waveform analysis plus the game driving it with real input). They also drive maneuver nodes with real mouse and keyboard input (add, edit, drag, chain, delete, then fly a transfer node live) and run the full mission inside the real game page. It needs Python 3.9+ with `websockets` and Chrome or Chromium (Flatpak Chrome works; set `CHROME=/path/to/chrome` to choose one).

The scripted pilots in `tests/pilots.js` only use player controls: throttle, rotation, SAS holds, staging and warp.

Developer shortcuts in the browser console: `APP.debugScenario('orbit' | 'transfer' | 'landed' | 'crash')` and `APP.debugScenario('surface', 'ferro')`.

## License

MIT, see [LICENSE](LICENSE).
