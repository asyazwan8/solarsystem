# Solar System AR

A minimal, cross-platform AR web app for viewing 3D models on iPhone and Android — built with [Vite](https://vitejs.dev/) and Google's [`<model-viewer>`](https://modelviewer.dev/). No framework, no backend, no API keys.

Models are shown in a responsive gallery; tapping one opens a full-screen 3D viewer with a **View in AR** button. This build also has one custom interaction: while viewing the **Solar System**, a marker sits on the Sun — tapping it switches the viewer to the standalone **Sun** model.

## Tech stack

- Vite (vanilla JS / HTML / CSS)
- `<model-viewer>` web component, loaded from a CDN (jsDelivr, pinned to `4.1.0`)
- A small amount of vanilla JS to build the gallery and switch models

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
index.html
style.css
main.js
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
you never touch the code to add a model — the gallery rebuilds itself from
`models.json` on load.

**File notes**

- `model.glb` — required for Android and WebXR.
- `model.usdz` — required for iOS AR. If you only have a `.glb`, a real `.usdz`
  can be generated from it (Apple's [Reality Converter](https://developer.apple.com/augmented-reality/tools/)
  on a Mac, or programmatically).
- `poster.webp` — optional but recommended. If it fails to load, the card falls
  back to the model's first initial.

## Included models

Both models are already in the repo, derived from your Sketchfab `.glb` files
(check/respect each model's Sketchfab license + attribution terms):

| id             | name         | what's in the folder                |
| -------------- | ------------ | ----------------------------------- |
| `solar-system` | Solar System | `model.glb` (3.9 MB), `model.usdz` (9.1 MB) |
| `sun`          | The Sun      | `model.glb` (0.66 MB), `model.usdz` (1.7 MB) |

**What was done to them**

- **Compressed the `.glb`** with Draco (geometry) + WebP textures, no mesh
  simplification: solar system 10.6 MB → 3.9 MB, sun 2.1 MB → 0.66 MB. Both
  keep their original animations and validate clean.
- **Generated a real `.usdz`** for each from the original geometry + textures
  (`UsdGeom.Mesh` + `UsdPreviewSurface`, packaged for ARKit), since you only
  supplied `.glb`. Both pass `UsdUtils.ComplianceChecker(arkit=True)` with zero
  errors.

**Animation:** both models are animated (the solar system orbits over 20 s; the
sun pulses over 33 s). The `<model-viewer>` has `autoplay`, so the in-page 3D
view and Android Scene Viewer AR play the animation. The `.usdz` is a static
snapshot of the rest pose — iOS Quick Look AR shows the posed model, not the
motion. (Animated USDZ is a larger lift; say the word if you want it.)

**Posters:** no `poster.webp` thumbnails are included (they can't be rendered
here without a browser/GPU). The gallery falls back to the model's initial on a
tile, which is intentional and fine. To add real thumbnails later, drop a
`poster.webp` into each model folder — e.g. screenshot the model in the viewer,
or grab the thumbnail from its Sketchfab page.

(You can remove `sun` from `models.json` if you only want it reachable by tapping
the Sun — the tap-to-switch still works either way, since `public/models/sun/`
exists.)

## The "tap the Sun" interaction

Configured in `main.js`, in the `MODEL_HOTSPOTS` object:

```js
const MODEL_HOTSPOTS = {
  "solar-system": {
    target: "sun",          // model id to switch to when tapped
    label: "Enter the Sun",
    position: "0m 0m 0m",   // where the Sun sits in the solar-system model
    normal: "0m 1m 0m",
  },
};
```

- `position` is in the model's **own** coordinate space (metres). Most
  solar-system models put the Sun at the centre, so `0 0 0` is the default. If
  the marker doesn't land on the Sun, nudge these numbers.
- To link any other model to another, add another entry keyed by the source
  model's id.
- **Back** from the Sun returns you to the Solar System; **Back** again returns
  to the gallery.

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
(Draco geometry compression + WebP textures) before committing, rather than
reaching for Git LFS. As a rule of thumb, keep individual files under ~40–50 MB
to stay comfortable on GitHub.
