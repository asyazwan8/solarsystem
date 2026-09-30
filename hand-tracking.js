// Hand mode camera + MediaPipe loop. Loaded on demand (dynamic import) the
// first time Hand mode is switched on, so the normal app load stays light.
//
// Streams the back camera into a <video>, runs MediaPipe's HandLandmarker
// on each new frame, and reports one hand per frame with its landmarks
// mapped to screen pixels (matching the video's object-fit: cover crop).

import { FilesetResolver, HandLandmarker } from '@mediapipe/tasks-vision';
// The WASM runtime is bundled from the npm package rather than a CDN, so it
// always matches the JS API version pinned in package.json.
import simdLoader from '@mediapipe/tasks-vision/vision_wasm_internal.js?url';
import simdBinary from '@mediapipe/tasks-vision/vision_wasm_internal.wasm?url';
import noSimdLoader from '@mediapipe/tasks-vision/vision_wasm_nosimd_internal.js?url';
import noSimdBinary from '@mediapipe/tasks-vision/vision_wasm_nosimd_internal.wasm?url';

const MODEL_URL = '/mediapipe/hand_landmarker.task';

let recognizerPromise = null;
let recognizerLoaded = false;
const progressListeners = new Set();

function reportProgress(fraction) {
  progressListeners.forEach((fn) => fn(fraction));
}

// Download the hand model ourselves (rather than letting MediaPipe fetch it)
// so we can show how far along it is.
async function fetchModel() {
  const res = await fetch(MODEL_URL);
  if (!res.ok) throw new Error(`Hand model: HTTP ${res.status}`);
  const total = Number(res.headers.get('content-length')) || 0;
  if (!res.body || !total) return new Uint8Array(await res.arrayBuffer());
  const reader = res.body.getReader();
  const chunks = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.byteLength;
    reportProgress(Math.min(received / total, 0.99));
  }
  const model = new Uint8Array(received);
  let offset = 0;
  for (const c of chunks) {
    model.set(c, offset);
    offset += c.byteLength;
  }
  return model;
}

async function createRecognizer() {
  const simd = await FilesetResolver.isSimdSupported();
  const fileset = simd
    ? { wasmLoaderPath: simdLoader, wasmBinaryPath: simdBinary }
    : { wasmLoaderPath: noSimdLoader, wasmBinaryPath: noSimdBinary };
  const model = await fetchModel();
  const options = (delegate) => ({
    baseOptions: { modelAssetBuffer: model.slice(), delegate },
    runningMode: 'VIDEO',
    numHands: 1,
  });
  try {
    return await HandLandmarker.createFromOptions(fileset, options('GPU'));
  } catch (err) {
    console.warn('GPU hand tracking unavailable, using CPU:', err);
    return HandLandmarker.createFromOptions(fileset, options('CPU'));
  } finally {
    reportProgress(1);
  }
}

// Start downloading and setting up hand tracking ahead of time (no camera),
// so switching Hand mode on is quick. Safe to call more than once.
export function preloadHandTracking() {
  return getRecognizer();
}

// One recognizer for the whole session; a failed load can be retried.
function getRecognizer() {
  recognizerPromise ??= createRecognizer().then((r) => {
    recognizerLoaded = true;
    return r;
  }, (err) => {
    recognizerPromise = null;
    throw err;
  });
  return recognizerPromise;
}

// Front cameras (and laptop webcams) are shown mirrored, like a mirror.
function shouldMirror(track) {
  const facing = track?.getSettings?.().facingMode;
  if (facing) return facing === 'user';
  return !window.matchMedia('(pointer: coarse)').matches;
}

// Give up (and report) after this many detection failures in a row.
const MAX_FRAME_FAILURES = 5;

export function createHandTracker({ video, onFrame, onStatus, onError }) {
  let stream = null;
  let recognizer = null;
  let running = false;
  let generation = 0; // bumps on stop() so a pending start() can bail out
  let frameHandle = 0;
  let usingVideoCallback = false;
  let lastVideoTime = -1;
  let nextRunAt = 0;
  let mirrored = false;
  let failures = 0;

  function stopStream() {
    stream?.getTracks().forEach((t) => t.stop());
    stream = null;
    video.srcObject = null;
  }

  function schedule() {
    usingVideoCallback = typeof video.requestVideoFrameCallback === 'function';
    frameHandle = usingVideoCallback
      ? video.requestVideoFrameCallback(tick)
      : requestAnimationFrame(tick);
  }

  function cancel() {
    if (!frameHandle) return;
    if (usingVideoCallback) video.cancelVideoFrameCallback(frameHandle);
    else cancelAnimationFrame(frameHandle);
    frameHandle = 0;
  }

  function tick() {
    frameHandle = 0;
    if (!running) return;
    const now = performance.now();
    // Only new frames (a video-frame callback always is one), and leave the
    // main thread at least as much idle time as the last detection took, so
    // the 3D view keeps rendering smoothly.
    const fresh = usingVideoCallback || video.currentTime !== lastVideoTime;
    if (video.readyState >= 2 && fresh && now >= nextRunAt) {
      lastVideoTime = video.currentTime;
      try {
        const result = recognizer.detectForVideo(video, now);
        const end = performance.now();
        nextRunAt = end + (end - now);
        failures = 0;
        onFrame(toFrame(result, end));
      } catch (err) {
        if (++failures >= MAX_FRAME_FAILURES) {
          stop();
          onError?.(err);
          return;
        }
      }
    }
    schedule();
  }

  function stop() {
    generation++;
    running = false;
    cancel();
    stopStream();
  }

  function toFrame(result, t) {
    const rect = video.getBoundingClientRect();
    const frame = { t, width: rect.width, height: rect.height, landmarks: null };
    const hand = result.landmarks?.[0];
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    if (!hand || !vw || !vh) return frame;

    // Undo the object-fit: cover crop so landmarks line up with the screen.
    const scale = Math.max(rect.width / vw, rect.height / vh);
    const offX = (rect.width - vw * scale) / 2;
    const offY = (rect.height - vh * scale) / 2;
    frame.landmarks = hand.map((p) => ({
      x: offX + (mirrored ? 1 - p.x : p.x) * vw * scale,
      y: offY + p.y * vh * scale,
      z: p.z * vw * scale,
    }));
    return frame;
  }

  return {
    // Resolves true once frames are flowing, or false if stop() was called
    // while starting. Rejects if the camera or model can't be opened.
    async start() {
      if (running) return true;
      const gen = ++generation;
      const recognizerReady = getRecognizer();
      recognizerReady.catch(() => {}); // handled below; avoid an unhandled-rejection warning

      const s = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: false,
      });
      if (gen !== generation) {
        s.getTracks().forEach((t) => t.stop());
        return false;
      }
      stream = s;
      mirrored = shouldMirror(s.getVideoTracks()[0]);
      video.style.transform = mirrored ? 'scaleX(-1)' : '';
      video.srcObject = s;
      await video.play().catch(() => {}); // autoplay/muted normally allows this
      if (gen !== generation) return false;

      if (!recognizerLoaded) onStatus?.('loading', 0); // (already preloaded: skip)
      const onProgress = (p) => gen === generation && onStatus?.('loading', p);
      progressListeners.add(onProgress);
      try {
        recognizer = await recognizerReady;
      } catch (err) {
        if (gen === generation) stopStream();
        throw err;
      } finally {
        progressListeners.delete(onProgress);
      }
      if (gen !== generation) return false;

      running = true;
      lastVideoTime = -1;
      nextRunAt = 0;
      failures = 0;
      schedule();
      return true;
    },

    stop,

    get active() {
      return running;
    },
  };
}
