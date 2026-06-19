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
const carousel = document.getElementById('carousel');
const track = document.getElementById('track');
const dots = document.getElementById('dots');
const viewerView = document.getElementById('viewer-view');
const viewer = document.getElementById('viewer');
const viewerTitle = document.getElementById('viewer-title');
const backButton = document.getElementById('back-button');
const prevButton = document.getElementById('prev-button');
const nextButton = document.getElementById('next-button');
const bodyDock = document.getElementById('body-dock');
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
  renderGallery();
}

function renderGallery() {
  track.replaceChildren();
  dots.replaceChildren();

  if (manifest.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'empty';
    empty.textContent =
      'No models yet. Add a folder to /public/models/ and list it in models.json.';
    track.appendChild(empty);
    return;
  }

  manifest.forEach(() => {
    const dot = document.createElement('span');
    dot.className = 'dot';
    dots.appendChild(dot);
  });
  manifest.forEach((model) => track.appendChild(createCard(model)));
  observeCarousel();
}

// Highlight the dot for whichever card is centered in the viewport.
function observeCarousel() {
  const cards = [...track.children];
  const dotEls = [...dots.children];
  if (!cards.length || !window.IntersectionObserver) {
    dotEls[0]?.classList.add('dot--active');
    return;
  }
  const io = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        const idx = cards.indexOf(e.target);
        dotEls.forEach((d, i) => d.classList.toggle('dot--active', i === idx));
      }
    },
    { root: carousel, threshold: 0.6 },
  );
  cards.forEach((c) => io.observe(c));
}

function createCard(model) {
  const { poster } = pathsFor(model.id);

  const card = document.createElement('button');
  card.className = 'card';
  card.type = 'button';
  card.setAttribute('aria-label', `View ${model.name} in 3D and AR`);

  const img = document.createElement('img');
  img.className = 'card-img';
  img.loading = 'lazy';
  img.alt = '';
  img.src = poster;
  img.addEventListener('error', () => {
    img.remove();
    card.classList.add('card--noimg');
    card.dataset.initial = (model.name?.[0] ?? '?').toUpperCase();
  });

  const overlay = document.createElement('div');
  overlay.className = 'card-overlay';
  const name = document.createElement('span');
  name.className = 'card-name';
  name.textContent = model.name;
  overlay.appendChild(name);
  if (model.subtitle) {
    const sub = document.createElement('span');
    sub.className = 'card-sub';
    sub.textContent = model.subtitle;
    overlay.appendChild(sub);
  }

  card.append(img, overlay);
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
  updateBodyDock(model);
}

// The Solar System links out to every other model — like tapping the Sun, but
// for all bodies. (On-body hotspots can't track the planets while they orbit,
// so this dock is the reliable equivalent.) Built once, shown only here.
function updateBodyDock(model) {
  if (model.id !== 'solar-system' || manifest.length < 2) {
    bodyDock.hidden = true;
    return;
  }
  if (bodyDock.dataset.built !== '1') {
    bodyDock.replaceChildren();
    for (const m of manifest) {
      if (m.id === 'solar-system') continue;
      const { poster } = pathsFor(m.id);
      const chip = document.createElement('button');
      chip.className = 'dock-chip';
      chip.type = 'button';
      chip.setAttribute('aria-label', `Open ${m.name}`);

      const img = document.createElement('img');
      img.loading = 'lazy';
      img.alt = '';
      img.src = poster;
      img.addEventListener('error', () => {
        img.remove();
        chip.classList.add('dock-chip--noimg');
        chip.dataset.initial = (m.name?.[0] ?? '?').toUpperCase();
      });

      const cap = document.createElement('span');
      cap.className = 'dock-cap';
      cap.textContent = m.name;

      chip.append(img, cap);
      chip.addEventListener('click', () => switchToModel(getModel(m.id)));
      bodyDock.appendChild(chip);
    }
    bodyDock.dataset.built = '1';
  }
  bodyDock.hidden = false;
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
  bodyDock.hidden = true;
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

// Lateral move to the previous/next model in the carousel order (wraps around).
// This is a sideways step, not a drill-down, so it replaces the current entry
// in the trail rather than growing it — Back still returns where you came from.
function navigateBy(delta) {
  if (!currentModel || manifest.length < 2) return;
  let i = manifest.findIndex((m) => m.id === currentModel.id);
  if (i === -1) i = 0;
  const next = manifest[(i + delta + manifest.length) % manifest.length];
  if (next.id === currentModel.id) return;
  if (historyStack.length) historyStack[historyStack.length - 1] = next;
  else historyStack.push(next);
  applyModel(next);
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
prevButton.addEventListener('click', () => navigateBy(-1));
nextButton.addEventListener('click', () => navigateBy(1));

// Arrow keys (desktop) — only while the viewer is open and info is closed.
document.addEventListener('keydown', (e) => {
  if (viewerView.hidden || !infoSheet.hidden) return;
  if (e.key === 'ArrowRight') navigateBy(1);
  else if (e.key === 'ArrowLeft') navigateBy(-1);
});

// Swipe across the model to change planets. Listened in the capture phase so we
// measure the gesture before <model-viewer> consumes it for camera rotation;
// we don't preventDefault, so normal drag-to-rotate still works. A switch fires
// only on a clearly horizontal flick that doesn't start on a control.
let swipe = null;
viewerView.addEventListener(
  'touchstart',
  (e) => {
    if (!infoSheet.hidden || e.touches.length !== 1 ||
        e.target.closest('#body-dock, button')) {
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
