// Gesture engine for Hand mode: turns per-frame hand data into zoom and
// rotate actions for the planet on screen. Pure logic (no DOM, no MediaPipe)
// so it can be driven by fake frames.
//
// Input frame: { t, width, height, landmarks }
//   - landmarks: 21 MediaPipe hand points already mapped to screen pixels
//     ({ x, y, z }), or null when no hand is visible
//
// Poses and what they do:
//   pinch  🤏  hold the pinch and move the hand to rotate the planet
//   hand   ✋  open the hand wider to zoom in, close it to zoom out
//
// Distances are normalised (by the viewport width for movement, by the hand's
// own size for finger shapes) so thresholds behave the same everywhere.

// MediaPipe hand landmark indices.
const WRIST = 0;
const THUMB_TIP = 4;
const INDEX_MCP = 5;
const INDEX_TIP = 8;
const MIDDLE_MCP = 9;
const MIDDLE_TIP = 12;
const RING_TIP = 16;
const PINKY_TIP = 20;

const PINCH_CLOSE = 0.25; // thumb–index gap / hand size to count as pinched
const PINCH_OPEN = 0.4; // ...and to count as released again (hysteresis)
const PINCH_MIN_REACH = 1.25; // index tip must stick out past its knuckle (not a fist)

// Frames a new pose must hold before we switch to it. A hand closing into a
// fist briefly looks like a pinch, so the pinch has to hold a moment too.
const STABLE_FRAMES = { none: 4 };
const STABLE_FRAMES_DEFAULT = 3;

// Changes smaller than these are wobble and are held back until they add up.
const ROTATE_STEP = 0.0015; // fraction of screen width
const ZOOM_STEP = 0.02; // openness units (fist ≈ 0.9, open hand ≈ 1.9)

// ---- small helpers ----

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, (a.z ?? 0) - (b.z ?? 0));

// One-Euro filter: smooths jitter when the hand is still, stays responsive
// when it moves fast. https://gery.casiez.net/1euro/
function oneEuro({ minCutoff = 1.0, beta = 5, dCutoff = 1.0 } = {}) {
  let x = null;
  let dx = 0;
  let tPrev = 0;
  const alpha = (cutoff, dt) => 1 / (1 + 1 / (2 * Math.PI * cutoff * dt));
  return {
    reset() {
      x = null;
    },
    filter(value, t) {
      if (x === null) {
        x = value;
        dx = 0;
        tPrev = t;
        return value;
      }
      const dt = Math.max((t - tPrev) / 1000, 1e-3);
      tPrev = t;
      const rawDx = (value - x) / dt;
      dx += alpha(dCutoff, dt) * (rawDx - dx);
      const cutoff = minCutoff + beta * Math.abs(dx);
      x += alpha(cutoff, dt) * (value - x);
      return x;
    },
  };
}

// How open the hand is: average wrist-to-fingertip distance of the middle,
// ring and pinky fingers, in hand sizes. (Thumb and index are left out so a
// pinch doesn't change it.)
export function handOpenness(lm) {
  const size = dist(lm[WRIST], lm[MIDDLE_MCP]) || 1;
  return (dist(lm[WRIST], lm[MIDDLE_TIP]) + dist(lm[WRIST], lm[RING_TIP]) + dist(lm[WRIST], lm[PINKY_TIP])) / 3 / size;
}

// ---- engine ----

export function createGestureEngine(handlers = {}) {
  const emit = (name, ...args) => handlers[name]?.(...args);

  const fx = oneEuro();
  const fy = oneEuro();
  const fOpen = oneEuro({ minCutoff: 1.0, beta: 2 });

  let pose = 'none'; // the stable pose we act on
  let candidate = 'none';
  let candidateFrames = 0;
  let pinched = false;

  let rotateRef = null; // last pinch point we rotated from (units)
  let openRef = null; // last openness we zoomed from

  function rawPose(lm) {
    if (!lm) {
      pinched = false;
      return 'none';
    }
    const size = dist(lm[WRIST], lm[MIDDLE_MCP]) || 1;
    const gap = dist(lm[THUMB_TIP], lm[INDEX_TIP]) / size;
    const reach = dist(lm[WRIST], lm[INDEX_TIP]) / (dist(lm[WRIST], lm[INDEX_MCP]) || 1);
    if (pinched) pinched = gap < PINCH_OPEN;
    else pinched = gap < PINCH_CLOSE && reach > PINCH_MIN_REACH;
    return pinched ? 'pinch' : 'hand';
  }

  function enterPose(next) {
    pose = next;
    // Start each gesture from where the hand is now, so nothing jumps.
    rotateRef = null;
    openRef = null;
    fx.reset();
    fy.reset();
    fOpen.reset();
    emit('onPose', next);
  }

  function updateRotate(frame) {
    const lm = frame.landmarks;
    // Midpoint of the pinching fingertips, as a fraction of screen width.
    const px = (lm[THUMB_TIP].x + lm[INDEX_TIP].x) / 2 / frame.width;
    const py = (lm[THUMB_TIP].y + lm[INDEX_TIP].y) / 2 / frame.width;
    const p = { x: fx.filter(px, frame.t), y: fy.filter(py, frame.t) };
    if (!rotateRef) {
      rotateRef = p;
      return;
    }
    const dx = p.x - rotateRef.x;
    const dy = p.y - rotateRef.y;
    if (Math.abs(dx) < ROTATE_STEP && Math.abs(dy) < ROTATE_STEP) return;
    rotateRef = p;
    emit('onRotate', dx, dy);
  }

  function updateZoom(frame) {
    const open = fOpen.filter(handOpenness(frame.landmarks), frame.t);
    if (openRef === null) {
      openRef = open;
      return;
    }
    const d = open - openRef;
    if (Math.abs(d) < ZOOM_STEP) return;
    openRef = open;
    emit('onZoom', d);
  }

  return {
    update(frame) {
      const next = rawPose(frame.landmarks);
      if (next === candidate) candidateFrames++;
      else {
        candidate = next;
        candidateFrames = 1;
      }
      const needed = STABLE_FRAMES[candidate] ?? STABLE_FRAMES_DEFAULT;
      if (candidate !== pose && candidateFrames >= needed) enterPose(candidate);

      // While a pose change is still pending, don't act on a pose the hand
      // is visibly leaving.
      if (!frame.landmarks || candidate !== pose) return;
      if (pose === 'pinch') updateRotate(frame);
      else if (pose === 'hand') updateZoom(frame);
    },

    // Forget any in-progress gesture (e.g. when Hand mode is paused).
    reset() {
      pose = 'none';
      candidate = 'none';
      candidateFrames = 0;
      pinched = false;
      rotateRef = null;
      openRef = null;
    },
  };
}
