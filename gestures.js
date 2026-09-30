// Gesture engine for Hand mode: turns per-frame hand data into app actions.
// Pure logic (no DOM, no MediaPipe) so it can be driven by fake frames.
//
// Input frame: { t, width, height, landmarks, gesture, score }
//   - landmarks: 21 MediaPipe hand points already mapped to screen pixels
//     ({ x, y, z }), or null when no hand is visible
//   - gesture/score: MediaPipe's canned gesture label (e.g. 'Open_Palm')
//
// Poses and what they do:
//   palm   ✋  move slowly to rotate; quick sideways swipe = next/prev
//   point  ☝️  cursor follows the index fingertip
//   pinch  🤏  quick pinch = click; pinch and hold = zoom (move up/down)
//   fist   ✊  hold to go back
//
// All distances are normalised by the viewport width ("units") so the
// thresholds behave the same on every screen size.

// MediaPipe hand landmark indices.
const WRIST = 0;
const THUMB_TIP = 4;
const INDEX_MCP = 5;
const INDEX_PIP = 6;
const INDEX_TIP = 8;
const MIDDLE_MCP = 9;
const MIDDLE_PIP = 10;
const MIDDLE_TIP = 12;
const RING_PIP = 14;
const RING_TIP = 16;
const PINKY_PIP = 18;
const PINKY_TIP = 20;

const LABEL_MIN_SCORE = 0.6;
const PINCH_CLOSE = 0.25; // thumb–index gap / hand size to count as pinched
const PINCH_OPEN = 0.4; // ...and to count as released again (hysteresis)
const PINCH_MIN_REACH = 1.15; // index tip must stick out past its knuckle (not a fist)

// Frames a new pose must hold before we switch to it (filters flicker).
const STABLE_FRAMES = { pinch: 2, none: 4 };
const STABLE_FRAMES_DEFAULT = 3;

const SWIPE_WINDOW_MS = 300;
const SWIPE_MIN_DX = 0.25; // a quarter of the screen width
const SWIPE_COOLDOWN_MS = 800;

const CLICK_MAX_MS = 350; // a pinch shorter than this is a click...
const CLICK_MAX_MOVE = 0.06; // ...as long as the hand stayed roughly still
const CLICK_AIM_LOOKBACK_MS = 150; // click where the cursor was just before pinching

const FIST_HOLD_MS = 600;
const DEADZONE = 0.0015; // ignore per-frame wobble smaller than this

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

function pointFilter(opts) {
  const fx = oneEuro(opts);
  const fy = oneEuro(opts);
  return {
    reset() {
      fx.reset();
      fy.reset();
    },
    filter(p, t) {
      return { x: fx.filter(p.x, t), y: fy.filter(p.y, t) };
    },
  };
}

// A finger is extended when its tip is clearly farther from the wrist than
// its middle joint.
const extended = (lm, tip, pip) => dist(lm[WRIST], lm[tip]) > dist(lm[WRIST], lm[pip]) * 1.1;

function isPointing(lm) {
  return (
    extended(lm, INDEX_TIP, INDEX_PIP) &&
    !extended(lm, MIDDLE_TIP, MIDDLE_PIP) &&
    !extended(lm, RING_TIP, RING_PIP) &&
    !extended(lm, PINKY_TIP, PINKY_PIP)
  );
}

// ---- engine ----

export function createGestureEngine(handlers = {}) {
  const emit = (name, ...args) => handlers[name]?.(...args);

  const palmFilter = pointFilter();
  const cursorFilter = pointFilter();

  let pose = 'none'; // the stable pose we act on
  let candidate = 'none';
  let candidateFrames = 0;
  let candidateSince = 0; // when the candidate pose was first seen
  let pinched = false;

  let lastPalm = null; // for rotation deltas (units)
  let palmHistory = []; // [{ t, x, y }] for swipe detection
  let swipeCooldownUntil = 0;

  let cursorHistory = []; // [{ t, x, y }] in pixels, for click aim
  let pinchStart = null; // { t, x, y, aim } when the current pinch began
  let pinchReleasedAt = null; // first frame the fingers opened again
  let zooming = false;
  let lastZoomY = null;

  let fistStart = 0;
  let fistFired = false;

  function rawPose(frame) {
    const lm = frame.landmarks;
    if (!lm) {
      pinched = false;
      return 'none';
    }
    const handSize = dist(lm[WRIST], lm[MIDDLE_MCP]) || 1;
    const gap = dist(lm[THUMB_TIP], lm[INDEX_TIP]) / handSize;
    const reach = dist(lm[WRIST], lm[INDEX_TIP]) / (dist(lm[WRIST], lm[INDEX_MCP]) || 1);
    if (pinched) pinched = gap < PINCH_OPEN;
    else pinched = gap < PINCH_CLOSE && reach > PINCH_MIN_REACH;
    if (pinched) return 'pinch';

    const sure = frame.score >= LABEL_MIN_SCORE;
    if (sure && frame.gesture === 'Closed_Fist') return 'fist';
    if (sure && frame.gesture === 'Open_Palm') return 'palm';
    if (frame.gesture === 'Pointing_Up' || isPointing(lm)) return 'point';
    return 'other';
  }

  function enterPose(next, frame) {
    const prev = pose;
    pose = next;

    // Losing the hand mid-pinch cancels it rather than clicking.
    if (prev === 'pinch') endPinch(frame, next !== 'none');

    lastPalm = null;
    palmHistory = [];
    palmFilter.reset();
    fistStart = candidateSince;
    fistFired = false;

    if (next === 'pinch') {
      // Time the pinch from its first frame, not from when it became stable,
      // so a quick pinch still counts as a click at low frame rates.
      const aim = aimPoint(candidateSince);
      const p = cursorPoint(frame);
      pinchStart = { t: candidateSince, x: p.x, y: p.y, aim };
      pinchReleasedAt = null;
      zooming = false;
      lastZoomY = null;
    }
    if (next === 'none') {
      cursorFilter.reset();
      cursorHistory = [];
    }
    emit('onPose', next);
  }

  function endPinch(frame, allowClick) {
    if (!pinchStart) return;
    const held = (pinchReleasedAt ?? frame.t) - pinchStart.t;
    if (allowClick && !zooming && held <= CLICK_MAX_MS && pinchStart.aim) {
      emit('onClick', pinchStart.aim.x, pinchStart.aim.y);
    }
    pinchStart = null;
    pinchReleasedAt = null;
    zooming = false;
    lastZoomY = null;
  }

  // Cursor position (pixels) from ~150 ms ago, i.e. before the pinch nudged it.
  function aimPoint(t) {
    if (cursorHistory.length === 0) return null;
    let best = cursorHistory[cursorHistory.length - 1];
    for (let i = cursorHistory.length - 1; i >= 0; i--) {
      best = cursorHistory[i];
      if (t - cursorHistory[i].t >= CLICK_AIM_LOOKBACK_MS) break;
    }
    return { x: best.x, y: best.y };
  }

  // Index fingertip in units (fraction of viewport width).
  function cursorPoint(frame) {
    const tip = frame.landmarks[INDEX_TIP];
    return { x: tip.x / frame.width, y: tip.y / frame.width };
  }

  function palmPoint(frame) {
    const p = frame.landmarks[MIDDLE_MCP];
    return { x: p.x / frame.width, y: p.y / frame.width };
  }

  function updateCursor(frame) {
    if (pose === 'none' || pose === 'palm' || pose === 'fist') {
      emit('onCursor', 0, 0, false);
      return;
    }
    if (pose === 'pinch' && pinchStart?.aim) {
      // Hold the cursor still on its target while pinching.
      emit('onCursor', pinchStart.aim.x, pinchStart.aim.y, true);
      return;
    }
    const s = cursorFilter.filter(cursorPoint(frame), frame.t);
    const px = { t: frame.t, x: s.x * frame.width, y: s.y * frame.width };
    cursorHistory.push(px);
    while (cursorHistory.length && frame.t - cursorHistory[0].t > 1000) cursorHistory.shift();
    emit('onCursor', px.x, px.y, true);
  }

  function updatePalm(frame) {
    const raw = palmPoint(frame);

    // Swipe: a big, fast, mostly-horizontal move within a short window.
    palmHistory.push({ t: frame.t, x: raw.x, y: raw.y });
    while (palmHistory.length && frame.t - palmHistory[0].t > SWIPE_WINDOW_MS) palmHistory.shift();
    if (frame.t >= swipeCooldownUntil && palmHistory.length > 1) {
      const first = palmHistory[0];
      const dx = raw.x - first.x;
      const dy = raw.y - first.y;
      if (Math.abs(dx) > SWIPE_MIN_DX && Math.abs(dx) > Math.abs(dy) * 2) {
        swipeCooldownUntil = frame.t + SWIPE_COOLDOWN_MS;
        palmHistory = [];
        lastPalm = null;
        palmFilter.reset();
        // Hand moving left on screen = next (same as the touch swipe).
        emit('onSwipe', dx < 0 ? 1 : -1);
        return;
      }
    }
    if (frame.t < swipeCooldownUntil) return;

    // Rotate: follow the (smoothed) palm.
    const s = palmFilter.filter(raw, frame.t);
    if (lastPalm) {
      const dx = s.x - lastPalm.x;
      const dy = s.y - lastPalm.y;
      if (Math.abs(dx) > DEADZONE || Math.abs(dy) > DEADZONE) emit('onRotate', dx, dy);
    }
    lastPalm = s;
  }

  function updatePinch(frame) {
    // Once the fingers open, wait for the release to settle; opening the
    // fingers moves the tip, which must not count as a zoom drag.
    if (!pinchStart || pinchReleasedAt !== null) return;
    const p = cursorPoint(frame);
    const moved = Math.hypot(p.x - pinchStart.x, p.y - pinchStart.y);
    if (!zooming && (frame.t - pinchStart.t > CLICK_MAX_MS || moved > CLICK_MAX_MOVE)) {
      zooming = true;
      lastZoomY = p.y;
      emit('onPose', 'zoom');
      return;
    }
    if (zooming) {
      const dy = p.y - lastZoomY;
      lastZoomY = p.y;
      if (Math.abs(dy) > DEADZONE) emit('onZoom', dy);
    }
  }

  function updateFist(frame) {
    if (!fistFired && frame.t - fistStart >= FIST_HOLD_MS) {
      fistFired = true;
      emit('onBack');
    }
  }

  return {
    update(frame) {
      const next = rawPose(frame);
      if (next === candidate) candidateFrames++;
      else {
        candidate = next;
        candidateFrames = 1;
        candidateSince = frame.t;
      }
      if (pose === 'pinch') {
        if (next !== 'pinch') pinchReleasedAt ??= frame.t;
        else pinchReleasedAt = null;
      }
      const needed = STABLE_FRAMES[candidate] ?? STABLE_FRAMES_DEFAULT;
      if (candidate !== pose && candidateFrames >= needed) enterPose(candidate, frame);

      // While a pose change is pending, keep acting on the current stable
      // pose as long as we still have a hand to read.
      if (!frame.landmarks) {
        emit('onCursor', 0, 0, false);
        return;
      }
      updateCursor(frame);
      if (pose === 'palm') updatePalm(frame);
      else if (pose === 'pinch') updatePinch(frame);
      else if (pose === 'fist') updateFist(frame);
    },

    // Forget any in-progress gesture (e.g. when Hand mode is paused).
    reset() {
      pose = 'none';
      candidate = 'none';
      candidateFrames = 0;
      pinched = false;
      pinchStart = null;
      pinchReleasedAt = null;
      zooming = false;
      lastPalm = null;
      palmHistory = [];
      cursorHistory = [];
      palmFilter.reset();
      cursorFilter.reset();
    },
  };
}
