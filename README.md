# Solar System AR

A minimal, cross-platform AR web app for kids to explore the solar system on iPhone and Android — built with [Vite](https://vitejs.dev/) and Google's [`<model-viewer>`](https://modelviewer.dev/). No framework, no backend, no API keys.

The app opens **straight into the 3D solar system** — there is no gallery or card screen. From there:

- **Zoom and rotate** the whole solar system; pinch to get close to the small inner planets.
- **Tap a planet** (each has a glowing marker) to open its own page.
- On a **planet page** you can rotate/zoom it, **View it in AR**, and read **kid-friendly fun facts** along the bottom — tap a fact to pop it up in a **floating window**.
- **Back** returns you to the solar system. The solar system is the hub that connects to every body.
- **✋ Hand mode** (on a planet page, next to **View in AR**) turns on the
  phone's back camera so kids can zoom and rotate that planet with their hand
  while it floats over the live camera view. See [Hand mode](#hand-mode).

Tappable planet markers are possible because the home model is **static** (the planets don't orbit), so each marker stays put on its planet. Marker positions were measured from the model and live in `SOLAR_HOTSPOTS` in `main.js`.

## Tech stack

- Vite (vanilla JS / HTML / CSS)
- `<model-viewer>` web component, loaded from a CDN (jsDelivr, pinned to `4.1.0`)
- A small amount of vanilla JS for navigation, hotspots, fun facts, and the info window
- [MediaPipe](https://ai.google.dev/edge/mediapipe/solutions/vision/hand_landmarker/web_js)
  Hand Landmarker (`@mediapipe/tasks-vision`, npm) for Hand mode, loaded in the
  background once a planet page has loaded

> **Why jsDelivr and not Google's CDN?** Google's hosted libraries only serve
> `<model-viewer>` up to `3.0.0`. jsDelivr serves the current release, which has
> better AR compatibility on recent iOS/Android. To swap CDNs, just change the
> `<script>` `src` in `index.html`.

## Project structure

```
public/
  models/            <- you add <id>/ subfolders here (empty for now)
    .gitkeep         <- only there to keep the empty folder in git; safe to delete later
  models.json        <- manifest: a plain array of { id, name } (ships as [])
  mediapipe/
    hand_landmarker.task  <- MediaPipe hand model (Hand mode)
index.html
style.css
main.js
hand-tracking.js     <- Hand mode: camera + MediaPipe loop (lazy-loaded)
gestures.js          <- Hand mode: pinch-drag → rotate, open/close hand → zoom
vercel.json
package.json
.gitignore
README.md
```

## Running locally

```bash
npm install
npm run dev
```

Vite serves the app at `http://localhost:5173`.

> **AR and camera access require HTTPS.** Plain `http://localhost` is fine for
> clicking around on your computer, but to test AR **on a phone** you need an
> HTTPS URL. Use one of:
>
> - `npx ngrok http 5173` — tunnels your running dev server over HTTPS, or
> - `vercel dev` — Vercel's local dev server, or
> - just deploy (see below) and test the live URL.

Production build:

```bash
npm run build      # outputs to dist/
npm run preview    # serve the production build locally
```

## Adding a model

Each model lives in its own folder under `public/models/`, named by a short
**id**, containing exactly three files:

```
public/models/<id>/model.glb     # 3D model — Android / WebXR
public/models/<id>/model.usdz    # 3D model — iOS AR (Quick Look)
public/models/<id>/poster.webp   # thumbnail / loading image
```

Then add one entry to `public/models.json`:

```json
[{ "id": "<id>", "name": "Display Name" }]
```

That's it. `main.js` derives all three file paths from the id by convention, so
you never touch the code to add a model — the app reads `models.json` on load.

**File notes**

- `model.glb` — required for Android, WebXR, and the in-page 3D view.
- `model.usdz` — required for iOS AR. If you only have a `.glb`, a real `.usdz`
  can be generated from it (Apple's [Reality Converter](https://developer.apple.com/augmented-reality/tools/)
  on a Mac, or programmatically). The home solar-system model has no `.usdz`
  because it isn't shown in AR (only the individual planets are).
- `poster.webp` — optional but recommended; shown while the model loads.

## Included models

Ten models are included (check/respect each source model's license + attribution
terms): the **Solar System** (the static Paint 3D model you supplied, used as the
home screen), the **Sun**, and all eight planets — **Mercury, Venus, Earth, Mars,
Jupiter, Saturn, Uranus, Neptune**. The planet order (used by swipe / arrows on
the planet pages) follows the order in `models.json`.

**What was done to them**

- **Compressed the `.glb`** with Draco (geometry) and textures capped at
  1024 px (512 px for the home solar-system, which is mostly seen zoomed out),
  no mesh simplification. Textures are kept in their original **JPEG/PNG** format
  (not WebP) so they decode reliably on every device — WebP textures were the
  cause of models occasionally rendering gray/untextured.
- **Generated a real `.usdz`** for each planet from the actual geometry +
  textures (`UsdGeom.Mesh` + `UsdPreviewSurface`, packaged for ARKit). They pass
  `UsdUtils.ComplianceChecker(arkit=True)` with zero errors. (The home solar
  system has no `.usdz` — it isn't an AR target.)
- **Rendered `poster.webp`** for each model (offscreen render on the dark
  background), shown on planet pages while the model streams in. The home
  solar system shows a loading bar instead: its poster framed the whole row
  while the 3D view opens zoomed in, so the first load looked like two.
- **Opaque PNG textures re-encoded as JPEG** and unused vertex data dropped
  (geometry untouched; renders compared pixel-for-pixel before/after). Textures
  that really use transparency stay PNG. All models together: ~10.6 MB → ~4.9 MB
  (the home solar system 3.2 MB → 0.65 MB).
- **Normalized AR size.** The planet sources are authored at wildly different
  scales, so each planet's AR assets are scaled to place at a consistent
  real-world size (**≈ 0.4 m**). `<model-viewer>` uses `ar-scale="auto"`, so
  AR starts at that size and a pinch in AR resizes the planet and keeps it
  (with `"fixed"` it snapped back to 100%). The home solar-system model is scaled to a friendly ~2-unit size for
  on-screen exploration (no AR), and the planet hotspot positions are measured in
  that same scaled space.

**Info & fun facts**

- **Fun facts (planet pages)** — each planet page shows a row of kid-friendly
  fun-fact chips along the bottom. Tapping a chip opens a **floating window** with
  the full fact, layered over the model (the model stays visible behind it). Facts
  live in each model's `funFacts` array in `models.json` (`{ "label", "text" }`).
- **ⓘ button** — opens the same floating window with the planet's name and
  description (`blurb`).
- **iOS AR banner** — in Quick Look AR, a native banner shows the planet's title,
  subtitle, and a "Learn more" button (wired to `arInfoUrl`). It's built from each
  model's `subtitle` / `arInfoUrl` and appended to the `.usdz` URL automatically.
  Android Scene Viewer shows a minimal title only.

**Animation:** the home solar-system model is **static** — that's deliberate, so
the planet markers stay pinned to their planets. `<model-viewer>` keeps `autoplay`
on, so any planet model that has its own spin animation still plays on its page.

## Tapping the planets

The home solar-system model is static, so each planet gets a fixed marker.
These are configured in `main.js`, in the `SOLAR_HOTSPOTS` array:

```js
const SOLAR_HOTSPOTS = [
  { target: "earth", position: "0.088m -0.020m 0.692m" }, // model id + 3D spot
  // ...one entry per body
];
```

- `target` is the model id to open when the marker is tapped.
- `position` is in the home model's **own** coordinate space (metres), measured
  from the asset. If a marker doesn't sit exactly on its planet, nudge these
  numbers (or tell me which one and I'll re-measure).
- **Back** from any planet returns to the solar system.

## Hand mode

On a planet page, tap **✋ Hand mode** (next to **View in AR**) to zoom and
rotate that planet with one hand while the other holds the phone. The **back
camera** fills the screen and the planet floats over it, in the middle of the
screen. MediaPipe watches the camera for these gestures:

| Gesture | What it does |
|---|---|
| 🤏 Pinch (thumb touches index finger), hold and move | Rotate the planet, like grabbing and turning it |
| ✋ Open your hand wider | The planet gets bigger |
| ✊ Close your hand | The planet gets smaller |

Hand mode stays on one planet: Back, the arrows, ⓘ and the fun facts step aside
(swipes and arrow keys are ignored too). To visit another planet, tap
**✋ Hand mode** again to switch it off. A status pill at the top shows what the
camera sees, and a short guide appears each time Hand mode starts (tap it to
dismiss).

**Hand mode vs. View in AR.** They are separate on purpose. **View in AR** places
the planet on your real floor or table at a fixed size and lets you walk around
it. That AR view runs in Apple's Quick Look or Google's Scene Viewer, outside the
web page, so the page's code (and MediaPipe) can't run there and gestures can't
work in it. Hand mode is our own in-page camera view: it has gestures, but the
planet stays pinned to the screen rather than the room. When you tap **View in AR** during Hand mode, the camera is
handed over to AR first, and Hand mode picks it back up when you return.

**Privacy.** Everything runs on the phone. No video or images leave the device,
and there is no server. The camera only starts after tapping ✋ and allowing the
browser's camera prompt. It switches off when Hand mode is turned off or the app
goes into the background.

**Requirements and notes**

- HTTPS (or `localhost`), like AR. The ✋ button is hidden where the camera
  can't be used.
- iOS 16.4+ / a recent Android Chrome. MediaPipe runs on the GPU when it can
  and falls back to the CPU.
- Hand tracking downloads about 11 MB once: the 7.8 MB hand model plus
  MediaPipe's runtime (~3.5 MB compressed), cached by the browser afterwards.
  It starts quietly in the background once a planet page has loaded (not on the
  home screen, and not when the phone asks to save data), so tapping ✋ is
  usually instant; otherwise the status pill shows the download percentage.
- Works best in decent light with the hand about 20–60 cm from the lens.
- MediaPipe's WASM runtime is bundled from the npm package by Vite (rather than
  a CDN), so it always matches the pinned `@mediapipe/tasks-vision` version. To
  upgrade, bump that version in `package.json`. The hand model in
  `public/mediapipe/` comes from Google's
  [model page](https://ai.google.dev/edge/mediapipe/solutions/vision/hand_landmarker#models)
  (`hand_landmarker.task`, float16).
- Gesture thresholds (pinch distance, wobble filtering) are constants at the
  top of `gestures.js`. Rotate and zoom strength are `HAND_SPIN_*` /
  `HAND_ZOOM` in `main.js`.

## Deployment (GitHub → Vercel)

1. Push this repo to GitHub.
2. Import the repo in Vercel — no build configuration needed, it detects Vite
   automatically.
3. HTTPS is automatic on Vercel, so AR works on the live URL with no extra
   setup.

`vercel.json` adds a header so any `.usdz` file (at any path depth) is served as
`Content-Type: model/vnd.usdz+zip`, which iOS Quick Look requires.

## Handling large models

If a `.glb` is heavy, compress it with [`gltf-transform`](https://gltf-transform.dev/)
(Draco geometry compression + resizing textures to 1024 px or less) before
committing, rather than reaching for Git LFS. Keep textures as **JPEG/PNG** — the
WebP texture path was dropped because it decoded unreliably on some devices and
left models gray. As a rule of thumb, keep individual files under ~40–50 MB to
stay comfortable on GitHub.
