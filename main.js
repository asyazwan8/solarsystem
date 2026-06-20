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

let manifest = [];
let currentModel = null;

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
  const home = isHome(model);
  const { glb, usdz, poster } = pathsFor(model.id);

  viewer.setAttribute('src', glb);
  viewer.setAttribute('poster', poster);
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
