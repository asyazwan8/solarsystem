import './style.css';

const MODELS_URL = '/models.json';
const HOME_ID = 'solar-system';

// Tappable markers placed on each body in the (static) solar-system model.
// Positions are in the model's own coordinate space, measured from the asset.
// Tapping one opens that body's standalone page.
const SOLAR_HOTSPOTS = [
  { target: 'sun', position: '-0.513m 0.012m 0.668m' },
  { target: 'mercury', position: '-0.052m -0.024m 0.721m' },
  { target: 'venus', position: '0.009m -0.024m 0.707m' },
  { target: 'earth', position: '0.088m -0.020m 0.692m' },
  { target: 'mars', position: '0.171m -0.022m 0.669m' },
  { target: 'jupiter', position: '0.335m -0.023m 0.666m' },
  { target: 'saturn', position: '0.650m -0.025m 0.673m' },
  { target: 'uranus', position: '0.923m -0.029m 0.711m' },
  { target: 'neptune', position: '1.056m -0.026m 0.725m' },
];

// Hand mode tuning: spin (radians per screen-width of hand movement), zoom
// strength for a pinch-drag, and how forgiving gesture taps are (px).
const HAND_SPIN_THETA = Math.PI * 1.6;
const HAND_SPIN_PHI = Math.PI * 1.2;
const HAND_ZOOM = 2.5;
const HAND_HIT_SLOP = 24;
const LEGEND_MS = 6000;

// What the status pill says for each hand pose (see gestures.js).
const POSE_STATUS = {
  none: 'Show your hand to the camera',
  palm: '✋ Spinning',
  point: '☝️ Aiming · pinch to tap',
  pinch: '🤏 Pinch',
  zoom: '🤏 Zooming · up = closer, down = farther',
  fist: '✊ Hold to go back',
  other: '☝️ Point to aim · ✋ open hand to spin',
};

// ---- element references ----
const viewer = document.getElementById('viewer');
const viewerView = document.getElementById('viewer-view');
const viewerTitle = document.getElementById('viewer-title');
const backButton = document.getElementById('back-button');
const prevButton = document.getElementById('prev-button');
const nextButton = document.getElementById('next-button');
const infoButton = document.getElementById('info-button');
const factsBar = document.getElementById('facts-bar');
const hint = document.getElementById('hint');
const infoSheet = document.getElementById('info-sheet');
const infoTitle = document.getElementById('info-title');
const infoBody = document.getElementById('info-body');
const arButton = document.getElementById('ar-button');
const handButton = document.getElementById('hand-button');
const cameraFeed = document.getElementById('camera-feed');
const gestureCursor = document.getElementById('gesture-cursor');
const gestureStatus = document.getElementById('gesture-status');
const gestureLegend = document.getElementById('gesture-legend');

let manifest = [];
let currentModel = null;

// Hand mode state. The tracker + gesture engine are loaded on first use.
let handMode = false;
let handTracker = null;
let gestureEngine = null;
let handStarting = null; // pending start, so overlapping resumes share it
let handGoal = null; // camera goal while a hand gesture is steering it
let hoverTarget = null;
let legendTimer = 0;
let statusTimer = 0;
const HINT_TEXT = hint.textContent;

// ---- helpers ----

function pathsFor(id) {
  const base = `/models/${id}`;
  return { glb: `${base}/model.glb`, usdz: `${base}/model.usdz`, poster: `${base}/poster.webp` };
}

function prettify(id) {
  return id.replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

function getModel(id) {
  return manifest.find((m) => m.id === id) || { id, name: prettify(id) };
}

const isHome = (model) => model?.id === HOME_ID;

// Bodies you can step through with swipe / arrows (everything except the home).
const planetOrder = () => manifest.filter((m) => m.id !== HOME_ID);

// ---- boot ----

async function loadManifest() {
  try {
    const res = await fetch(MODELS_URL, { cache: 'no-cache' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (!Array.isArray(data)) throw new Error('models.json must be a JSON array');
    manifest = data;
  } catch (err) {
    console.error('Could not load models.json:', err);
    manifest = [];
  }
  goHome();
}

// ---- iOS Quick Look banner ----

function quickLookSrc(usdz, model) {
  if (!model.subtitle && !model.blurb) return usdz;
  const parts = [`checkoutTitle=${encodeURIComponent(model.name)}`];
  if (model.subtitle) parts.push(`checkoutSubtitle=${encodeURIComponent(model.subtitle)}`);
  parts.push(`callToAction=${encodeURIComponent('Learn more')}`);
  if (model.arInfoUrl) parts.push(`canonicalWebPageURL=${encodeURIComponent(model.arInfoUrl)}`);
  return `${usdz}#${parts.join('&')}`;
}

// ---- applying a model ----

function applyModel(model) {
  currentModel = model;
  handGoal = null;
  const home = isHome(model);
  const { glb, usdz, poster } = pathsFor(model.id);

  viewer.setAttribute('src', glb);
  // Posters have the dark background baked in, which would cover the camera.
  if (handMode) viewer.removeAttribute('poster');
  else viewer.setAttribute('poster', poster);
  viewer.setAttribute('alt', `3D model of ${model.name}`);
  viewerTitle.textContent = home ? '' : model.name;

  // AR + Quick Look only on the planet pages, not the home solar system.
  if (home) {
    viewer.removeAttribute('ar');
    viewer.removeAttribute('ios-src');
  } else {
    viewer.setAttribute('ar', '');
    viewer.setAttribute('ios-src', quickLookSrc(usdz, model));
  }

  // Camera: the home opens zoomed in (Sun large, planets trailing off) and lets
  // kids pinch right in to the small inner planets or out to see the whole row.
  if (home) {
    viewer.setAttribute('camera-orbit', '0deg 68deg 60%');
    viewer.setAttribute('min-camera-orbit', 'auto auto 8%');
    viewer.setAttribute('max-camera-orbit', 'auto auto 160%');
  } else {
    viewer.setAttribute('camera-orbit', '0deg 75deg auto');
    viewer.removeAttribute('min-camera-orbit');
    viewer.removeAttribute('max-camera-orbit');
  }

  // Chrome: home is the hub (markers, no back/AR/facts); planets get the rest.
  backButton.hidden = home;
  prevButton.hidden = home;
  nextButton.hidden = home;
  hint.hidden = !home;
  infoButton.hidden = home || !model.blurb;

  closeInfo();
  setupHotspots(model);
  renderFacts(model);
}

// ---- hotspots (home only) ----

function clearHotspots() {
  viewer.querySelectorAll('[slot^="hotspot-"]').forEach((el) => el.remove());
}

function setupHotspots(model) {
  clearHotspots();
  if (!isHome(model)) return;

  for (const cfg of SOLAR_HOTSPOTS) {
    const body = getModel(cfg.target);
    const hotspot = document.createElement('button');
    hotspot.className = 'hotspot';
    hotspot.type = 'button';
    hotspot.slot = `hotspot-${cfg.target}`;
    hotspot.dataset.position = cfg.position;
    hotspot.setAttribute('aria-label', `Open ${body.name}`);

    const dot = document.createElement('span');
    dot.className = 'hotspot-dot';
    dot.setAttribute('aria-hidden', 'true');
    hotspot.appendChild(dot);

    hotspot.addEventListener('click', () => openPlanet(body));
    viewer.appendChild(hotspot);
  }
}

// ---- fun facts (planet pages) ----

function renderFacts(model) {
  factsBar.replaceChildren();
  const facts = Array.isArray(model.funFacts) ? model.funFacts : [];
  if (isHome(model) || facts.length === 0) {
    factsBar.hidden = true;
    return;
  }
  for (const fact of facts) {
    const chip = document.createElement('button');
    chip.className = 'fact-chip';
    chip.type = 'button';
    chip.textContent = fact.label;
    chip.addEventListener('click', () => openInfo(fact.label, fact.text));
    factsBar.appendChild(chip);
  }
  factsBar.hidden = false;
}

// ---- navigation ----

function openPlanet(model) {
  applyModel(model);
}

function goHome() {
  applyModel(getModel(HOME_ID));
}

// Step through the planets (wraps). Used by arrows, keys and swipe.
function navigateBy(delta) {
  if (!currentModel || isHome(currentModel)) return;
  const order = planetOrder();
  if (order.length < 2) return;
  let i = order.findIndex((m) => m.id === currentModel.id);
  if (i === -1) i = 0;
  applyModel(order[(i + delta + order.length) % order.length]);
}

// ---- info floating window ----

function openInfo(title, body) {
  infoTitle.textContent = title;
  infoBody.textContent = body;
  infoSheet.hidden = false;
}

function closeInfo() {
  infoSheet.hidden = true;
}

// ---- hand mode (MediaPipe gestures over the live back camera) ----

const handModeSupported = window.isSecureContext && !!navigator.mediaDevices?.getUserMedia;

function setStatus(text) {
  clearTimeout(statusTimer);
  gestureStatus.textContent = text;
  gestureStatus.hidden = !text;
}

function flashStatus(text) {
  setStatus(text);
  statusTimer = setTimeout(() => setStatus(''), 4000);
}

function showLegend() {
  clearTimeout(legendTimer);
  gestureLegend.hidden = false;
  legendTimer = setTimeout(hideLegend, LEGEND_MS);
}

function hideLegend() {
  clearTimeout(legendTimer);
  gestureLegend.hidden = true;
}

function handModeError(err) {
  switch (err?.name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return 'Camera blocked — allow camera access for this site in your browser settings';
    case 'NotFoundError':
    case 'OverconstrainedError':
      return 'No camera found on this device';
    case 'NotReadableError':
      return 'The camera is busy in another app';
    default:
      return "Hand tracking couldn't start — check your connection and try again";
  }
}

async function setHandMode(on) {
  if (on === handMode) return;
  handMode = on;
  handButton.setAttribute('aria-pressed', String(on));
  viewerView.classList.toggle('hand-mode', on);
  cameraFeed.hidden = !on;
  hint.textContent = on ? '☝️ Point at a planet, then 🤏 pinch to open it' : HINT_TEXT;
  if (on) {
    showLegend();
    await resumeHandTracking();
  } else {
    pauseHandTracking();
    hideLegend();
    setStatus('');
  }
}

function resumeHandTracking() {
  if (!handMode || document.hidden || handTracker?.active) return;
  if (handStarting) return handStarting;
  const starting = startHandTracking();
  handStarting = starting;
  starting.finally(() => {
    if (handStarting === starting) handStarting = null;
  });
  return starting;
}

async function startHandTracking() {
  setStatus('Starting camera…');
  try {
    if (!handTracker) {
      const [{ createHandTracker }, { createGestureEngine }] = await Promise.all([
        import('./hand-tracking.js'),
        import('./gestures.js'),
      ]);
      gestureEngine ??= createGestureEngine(gestureHandlers);
      handTracker ??= createHandTracker({
        video: cameraFeed,
        onFrame: (frame) => gestureEngine.update(frame),
        onStatus: () => handMode && setStatus('Loading hand tracking…'),
        onError: (err) => {
          console.error('Hand tracking stopped:', err);
          if (!handMode) return;
          setHandMode(false);
          flashStatus("Hand tracking isn't working on this device");
        },
      });
    }
    if (!handMode) return; // switched off while loading
    if (await handTracker.start()) setStatus(POSE_STATUS.none);
  } catch (err) {
    console.error('Hand mode could not start:', err);
    if (!handMode) return;
    await setHandMode(false);
    flashStatus(handModeError(err));
  }
}

function pauseHandTracking() {
  handStarting = null;
  handTracker?.stop();
  gestureEngine?.reset();
  handGoal = null;
  moveCursor(0, 0, false);
}

// Hand movement is added to our own running goal (not the still-animating
// camera) so it feels direct, but kept on a short leash to the real camera so
// it can't run far past model-viewer's zoom/tilt limits.
function handOrbitGoal() {
  const cur = viewer.getCameraOrbit();
  handGoal ??= { theta: cur.theta, phi: cur.phi, radius: cur.radius };
  const leash = (v, c, max) => Math.min(c + max, Math.max(c - max, v));
  handGoal.theta = leash(handGoal.theta, cur.theta, 0.5);
  handGoal.phi = leash(handGoal.phi, cur.phi, 0.35);
  handGoal.radius = leash(handGoal.radius, cur.radius, cur.radius * 0.15);
  return handGoal;
}

function steerCamera(update) {
  const goal = handOrbitGoal();
  update(goal);
  viewer.cameraOrbit = `${goal.theta}rad ${goal.phi}rad ${goal.radius}m`;
}

// The nearest tappable thing under the cursor, with some slop for small
// hands and wobbly tracking. AR can't be launched from a gesture (browsers
// require a real tap), and the hand toggle is left out so it can't be hit by
// accident.
function gestureTargetAt(x, y) {
  const scope = infoSheet.hidden ? viewerView : infoSheet;
  let best = null;
  let bestDist = HAND_HIT_SLOP;
  for (const el of scope.querySelectorAll('button:not(#ar-button):not(#hand-button)')) {
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) continue;
    const d = Math.hypot(Math.max(r.left - x, 0, x - r.right), Math.max(r.top - y, 0, y - r.bottom));
    if (d <= bestDist) {
      best = el;
      bestDist = d;
    }
  }
  // Tapping the scrim around the info window (not the card itself) closes it.
  if (!best && !infoSheet.hidden) {
    const card = infoSheet.querySelector('.info-card').getBoundingClientRect();
    const onCard = x >= card.left && x <= card.right && y >= card.top && y <= card.bottom;
    if (!onCard) best = infoSheet.querySelector('.info-backdrop');
  }
  return best;
}

function setHover(el) {
  if (el === hoverTarget) return;
  hoverTarget?.classList.remove('gesture-hover');
  hoverTarget = el;
  if (el && !el.classList.contains('info-backdrop')) el.classList.add('gesture-hover');
}

function moveCursor(x, y, visible) {
  if (!visible) {
    gestureCursor.hidden = true;
    setHover(null);
    return;
  }
  gestureCursor.hidden = false;
  gestureCursor.style.transform = `translate(${x}px, ${y}px)`;
  setHover(gestureTargetAt(x, y));
}

const gestureHandlers = {
  onPose(pose) {
    handGoal = null;
    setStatus(POSE_STATUS[pose] ?? '');
    gestureCursor.classList.toggle('is-pinching', pose === 'pinch' || pose === 'zoom');
  },
  onRotate(dx, dy) {
    if (!infoSheet.hidden) return;
    steerCamera((g) => {
      g.theta -= dx * HAND_SPIN_THETA;
      g.phi -= dy * HAND_SPIN_PHI;
    });
  },
  onZoom(dy) {
    if (!infoSheet.hidden) return;
    steerCamera((g) => {
      g.radius *= Math.exp(dy * HAND_ZOOM);
    });
  },
  onSwipe(dir) {
    if (infoSheet.hidden) navigateBy(dir);
  },
  onCursor: moveCursor,
  onClick(x, y) {
    const target = gestureTargetAt(x, y);
    if (!target) return;
    gestureCursor.animate?.([{ scale: 1.6 }, { scale: 0.75 }], { duration: 220, easing: 'ease-out' });
    target.click();
  },
  onBack() {
    if (!infoSheet.hidden) closeInfo();
    else if (currentModel && !isHome(currentModel)) goHome();
  },
};

handButton.hidden = !handModeSupported;
handButton.addEventListener('click', () => setHandMode(!handMode));
gestureLegend.addEventListener('click', hideLegend);

// Native AR needs the camera, so hand it over first (capture phase runs
// before model-viewer's own click handler) and pick it back up afterwards:
// WebXR reports when it ends, Scene Viewer returns via visibilitychange, and
// any touch on the page is the fallback (e.g. after iOS Quick Look).
arButton.addEventListener(
  'click',
  () => {
    if (!handMode) return;
    pauseHandTracking();
    setStatus('Hand mode paused · tap the screen to resume');
  },
  { capture: true },
);
viewer.addEventListener('ar-status', (e) => {
  if (e.detail.status === 'not-presenting' || e.detail.status === 'failed') resumeHandTracking();
});
window.addEventListener('focus', () => resumeHandTracking());
viewerView.addEventListener('pointerdown', (e) => {
  if (!e.target.closest('#ar-button, #hand-button')) resumeHandTracking();
});

// Never keep the camera on while the page is in the background.
document.addEventListener('visibilitychange', () => {
  if (!handMode) return;
  if (document.hidden) pauseHandTracking();
  else resumeHandTracking();
});

// ---- wiring ----

infoButton.addEventListener('click', () => {
  if (currentModel) openInfo(currentModel.name, currentModel.blurb || currentModel.subtitle || '');
});
infoSheet.addEventListener('click', (e) => {
  if (e.target.hasAttribute('data-close')) closeInfo();
});
backButton.addEventListener('click', goHome);
prevButton.addEventListener('click', () => navigateBy(-1));
nextButton.addEventListener('click', () => navigateBy(1));

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !infoSheet.hidden) {
    closeInfo();
    return;
  }
  if (!infoSheet.hidden) return;
  if (e.key === 'ArrowRight') navigateBy(1);
  else if (e.key === 'ArrowLeft') navigateBy(-1);
});

// Quick Look "Learn more" (iOS).
viewer.addEventListener('quick-look-button-tapped', () => {
  if (currentModel?.arInfoUrl) window.open(currentModel.arInfoUrl, '_blank', 'noopener');
});

// Swipe across a planet page to move to the next/previous planet. Captured
// before <model-viewer> so we can measure it without blocking drag-to-rotate.
let swipe = null;
viewerView.addEventListener(
  'touchstart',
  (e) => {
    if (!currentModel || isHome(currentModel) || !infoSheet.hidden ||
        e.touches.length !== 1 || e.target.closest('button')) {
      swipe = null;
      return;
    }
    const t = e.touches[0];
    swipe = { x: t.clientX, y: t.clientY, t: Date.now() };
  },
  { capture: true, passive: true },
);
viewerView.addEventListener(
  'touchend',
  (e) => {
    if (!swipe) return;
    const t = e.changedTouches[0];
    const dx = t.clientX - swipe.x;
    const dy = t.clientY - swipe.y;
    const dt = Date.now() - swipe.t;
    swipe = null;
    if (dt < 700 && Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.7) {
      navigateBy(dx < 0 ? 1 : -1);
    }
  },
  { capture: true, passive: true },
);

loadManifest();
