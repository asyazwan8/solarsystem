import './style.css';

const MODELS_URL = '/models.json';

/**
 * Optional model-to-model hotspots.
 *
 * When you open a model whose id is a key in this object, a tappable marker is
 * placed on it; tapping switches the viewer to the `target` model.
 *
 *   position : where the marker sits, in the model's OWN coordinate space
 *              (metres). Most solar-system models put the Sun at the centre,
 *              so "0m 0m 0m" is the default — nudge these numbers if the marker
 *              doesn't land on the Sun.
 *   normal   : surface normal the marker faces (used by model-viewer for
 *              occlusion); "0m 1m 0m" (up) is a safe default.
 *
 * The target model just needs a /public/models/<id>/ folder to exist — it does
 * not have to be listed in models.json.
 */
const MODEL_HOTSPOTS = {
  'solar-system': {
    target: 'sun',
    label: 'Enter the Sun',
    position: '0m 0m 0m',
    normal: '0m 1m 0m',
  },
};

// ---- element references ----
const galleryView = document.getElementById('gallery-view');
const grid = document.getElementById('grid');
const viewerView = document.getElementById('viewer-view');
const viewer = document.getElementById('viewer');
const viewerTitle = document.getElementById('viewer-title');
const backButton = document.getElementById('back-button');
const infoButton = document.getElementById('info-button');
const infoSheet = document.getElementById('info-sheet');
const infoTitle = document.getElementById('info-title');
const infoBody = document.getElementById('info-body');

let manifest = [];
let currentModel = null;
const historyStack = [];

// ---- helpers ----

// Derive the three file paths from a model id, by convention.
function pathsFor(id) {
  const base = `/models/${id}`;
  return {
    glb: `${base}/model.glb`,
    usdz: `${base}/model.usdz`,
    poster: `${base}/poster.webp`,
  };
}

// Turn an id like "solar-system" into "Solar System" for a fallback label.
function prettify(id) {
  return id
    .replace(/[-_]+/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

// Look up a model in the manifest, falling back to a derived entry so that a
// hotspot can target a model that isn't listed in the gallery.
function getModel(id) {
  return manifest.find((m) => m.id === id) || { id, name: prettify(id) };
}

// ---- gallery ----

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
  renderGrid();
}

function renderGrid() {
  grid.replaceChildren();

  if (manifest.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'empty';
    empty.textContent =
      'No models yet. Add a folder to /public/models/ and list it in models.json.';
    grid.appendChild(empty);
    return;
  }

  for (const model of manifest) {
    grid.appendChild(createCard(model));
  }
}

function createCard(model) {
  const { poster } = pathsFor(model.id);

  const card = document.createElement('button');
  card.className = 'card';
  card.type = 'button';
  card.setAttribute('aria-label', `View ${model.name} in 3D and AR`);

  const thumb = document.createElement('div');
  thumb.className = 'thumb';

  const img = document.createElement('img');
  img.loading = 'lazy';
  img.alt = '';
  img.src = poster;
  // If poster.webp is missing, fall back to the model's initial.
  img.addEventListener('error', () => {
    img.remove();
    thumb.classList.add('thumb--placeholder');
    thumb.textContent = (model.name?.[0] ?? '?').toUpperCase();
  });
  thumb.appendChild(img);

  const label = document.createElement('span');
  label.className = 'card-label';
  label.textContent = model.name;

  card.append(thumb, label);
  card.addEventListener('click', () => openModel(model));
  return card;
}

// ---- viewer ----

// Build the iOS Quick Look URL, adding a native info banner (title + subtitle
// + "Learn more" button) when the model has info. These #params are read by
// Quick Look on iOS; see Apple's AR Quick Look banner docs.
function quickLookSrc(usdz, model) {
  if (!model.subtitle && !model.blurb) return usdz;
  const parts = [`checkoutTitle=${encodeURIComponent(model.name)}`];
  if (model.subtitle) parts.push(`checkoutSubtitle=${encodeURIComponent(model.subtitle)}`);
  parts.push(`callToAction=${encodeURIComponent('Learn more')}`);
  if (model.arInfoUrl) parts.push(`canonicalWebPageURL=${encodeURIComponent(model.arInfoUrl)}`);
  return `${usdz}#${parts.join('&')}`;
}

function applyModel(model) {
  currentModel = model;
  const { glb, usdz, poster } = pathsFor(model.id);
  viewer.setAttribute('src', glb);
  viewer.setAttribute('ios-src', quickLookSrc(usdz, model));
  viewer.setAttribute('poster', poster);
  viewer.setAttribute('alt', `3D model of ${model.name}`);
  viewerTitle.textContent = model.name;

  // In-page info panel (works on every platform, unlike AR-session overlays)
  const hasInfo = Boolean(model.blurb || model.subtitle);
  infoButton.hidden = !hasInfo;
  infoTitle.textContent = model.name;
  infoBody.textContent = model.blurb || model.subtitle || '';
  closeInfo();

  setupHotspots(model);
}

function clearHotspots() {
  viewer.querySelectorAll('[slot^="hotspot-"]').forEach((el) => el.remove());
}

function setupHotspots(model) {
  clearHotspots();

  const cfg = MODEL_HOTSPOTS[model.id];
  if (!cfg) return;

  const hotspot = document.createElement('button');
  hotspot.className = 'hotspot';
  hotspot.type = 'button';
  hotspot.slot = `hotspot-${cfg.target}`;
  hotspot.dataset.position = cfg.position;
  if (cfg.normal) hotspot.dataset.normal = cfg.normal;
  hotspot.setAttribute('aria-label', cfg.label);

  const dot = document.createElement('span');
  dot.className = 'hotspot-dot';
  dot.setAttribute('aria-hidden', 'true');

  const label = document.createElement('span');
  label.className = 'hotspot-label';
  label.textContent = cfg.label;

  hotspot.append(dot, label);
  hotspot.addEventListener('click', () => switchToModel(getModel(cfg.target)));
  viewer.appendChild(hotspot);
}

function showViewer() {
  galleryView.hidden = true;
  viewerView.hidden = false;
}

function showGallery() {
  viewerView.hidden = true;
  galleryView.hidden = false;
  // Release the current model from memory and reset navigation.
  clearHotspots();
  closeInfo();
  viewer.removeAttribute('src');
  viewer.removeAttribute('ios-src');
  viewer.removeAttribute('poster');
  currentModel = null;
  historyStack.length = 0;
}

// Open a model from the gallery (starts a fresh navigation trail).
function openModel(model) {
  historyStack.length = 0;
  historyStack.push(model);
  applyModel(model);
  showViewer();
}

// Switch to another model from within the viewer (e.g. tapping the Sun).
function switchToModel(model) {
  historyStack.push(model);
  applyModel(model);
}

// Back steps through the trail, then returns to the gallery.
function goBack() {
  historyStack.pop();
  if (historyStack.length > 0) {
    applyModel(historyStack[historyStack.length - 1]);
  } else {
    showGallery();
  }
}

// ---- info panel ----

function openInfo() {
  infoSheet.hidden = false;
}

function closeInfo() {
  infoSheet.hidden = true;
}

infoButton.addEventListener('click', openInfo);
infoSheet.addEventListener('click', (e) => {
  if (e.target.hasAttribute('data-close')) closeInfo();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !infoSheet.hidden) closeInfo();
});

// iOS Quick Look fires this when the banner's "Learn more" button is tapped.
viewer.addEventListener('quick-look-button-tapped', () => {
  if (currentModel?.arInfoUrl) window.open(currentModel.arInfoUrl, '_blank', 'noopener');
});

backButton.addEventListener('click', goBack);

loadManifest();
