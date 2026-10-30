/*
 * inference.worker.js — Web Worker CLÁSICO que aloja UN modelo de IA (pose,
 * manos, malla facial u objetos) fuera del hilo principal.
 *
 * Por qué: MediaPipe ejecuta la inferencia de forma síncrona y TF.js con el
 * backend WASM también; en el hilo principal, una inferencia de 80 ms congela
 * el render 80 ms. Dentro de un worker, el hilo principal sólo crea un
 * ImageBitmap del fotograma (≈1 ms) y lo transfiere sin copia; la interfaz
 * sigue a 60 FPS aunque el análisis vaya más lento, y los cuatro modelos
 * pueden ejecutarse EN PARALELO en núcleos distintos.
 *
 * Es un worker clásico (no de tipo módulo) porque el cargador WASM de
 * MediaPipe usa importScripts(). Los módulos propios y el bundle de MediaPipe
 * se cargan con import() dinámico. Todas las rutas son locales.
 *
 * Protocolo de mensajes:
 *   → {type:'init', kind:'mediapipe'|'tfjs', ...}  ← {type:'ready', backend, delegate, connections}
 *   → {type:'infer', seq, bitmap, t, opts}         ← {type:'result', seq, result, ms, mem?}
 *   → {type:'call', seq, method, args}             ← {type:'done', seq}
 *   ← {type:'progress', fraction}  ·  ← {type:'error', seq, message}
 */
'use strict';

let det = null;
let tf = null;
let queue = Promise.resolve();

const post = (msg, transfer) => self.postMessage(msg, transfer || []);
const errMsg = (e) => (e && e.message ? e.message : String(e));

const MP_MODULES = {
  pose: ['../detectors/PoseDetector.js', 'PoseDetector'],
  hands: ['../detectors/HandDetector.js', 'HandDetector'],
  face: ['../detectors/FaceDetector.js', 'FaceDetector'],
};

// Los mensajes se procesan en orden estricto (init antes que infer, etc.).
self.onmessage = (e) => {
  const m = e.data;
  queue = queue
    .then(() => handle(m))
    .catch((err) => post({ type: 'error', seq: m && m.seq != null ? m.seq : null, message: errMsg(err) }));
};

async function handle(m) {
  switch (m.type) {
    case 'init':
      if (m.kind === 'tfjs') return initTf(m);
      if (m.kind === 'motion') return initMotion();
      return initMediaPipe(m);
    case 'infer':
      return infer(m);
    case 'call':
      await det[m.method](...(m.args || []));
      return post({ type: 'done', seq: m.seq });
    case 'close':
      if (det) det.dispose();
      det = null;
      return self.close();
    default:
      return undefined;
  }
}

async function initMediaPipe(m) {
  const [path, cls] = MP_MODULES[m.task];
  const [{ MediaPipeRuntime }, mod] = await Promise.all([import('../detectors/MediaPipeRuntime.js'), import(path)]);
  const rt = new MediaPipeRuntime({ bundlePath: m.bundleUrl, wasmDir: m.wasmDir, simd: m.simd });
  await rt.load();
  det = new mod[cls](rt);
  await det.load({ model: m.model, delegates: m.delegates, ...m.options });
  post({ type: 'ready', backend: det.backend, delegate: det.delegate, connections: det.connections });
}

async function initTf(m) {
  // Ver main.js: evita que el regenerator-runtime de tf.min.js use Function().
  if (!('regeneratorRuntime' in self)) self.regeneratorRuntime = undefined;
  importScripts(m.urls.tf);
  const notices = [];
  for (const u of m.urls.extra || []) {
    try { importScripts(u); } catch (e) { notices.push(`No se pudo cargar ${u}: ${errMsg(e)}`); }
  }
  tf = self.tf;
  if (!tf || !tf.loadGraphModel) throw new Error('TF.js no se inicializó en el worker');
  if (tf.wasm && tf.wasm.setWasmPaths && m.wasmPrefix) tf.wasm.setWasmPaths(m.wasmPrefix);
  const [{ activateTfBackend }, { ObjectDetector }] = await Promise.all([
    import('../core/BackendManager.js'),
    import('../detectors/ObjectDetector.js'),
  ]);
  det = new ObjectDetector();
  const attempts = [];
  let start = 0;
  let lastErr = null;
  while (start < m.order.length) {
    let act;
    try {
      act = await activateTfBackend(tf, m.order.slice(start), { auto: m.auto });
    } catch (e) {
      lastErr = e;
      attempts.push(...(e.attempts || []));
      break;
    }
    attempts.push(...act.attempts);
    try {
      await det.load({ tf, url: m.modelUrl, onProgress: (f) => post({ type: 'progress', fraction: f }) });
      post({ type: 'ready', backend: det.backend, tfBackend: act.name, attempts, notices });
      return;
    } catch (e) {
      lastErr = e;
      det.dispose();
      attempts.push({ name: act.name, ok: false, reason: `falló al ejecutar COCO-SSD: ${errMsg(e)}` });
      start = m.order.indexOf(act.name) + 1;
    }
  }
  const err = new Error(`TF.js sin backend operativo: ${attempts.filter((a) => !a.ok).map((a) => `${a.name} (${a.reason})`).join('; ') || errMsg(lastErr)}`);
  throw err;
}

/** Módulo E: la lectura de píxeles (getImageData) se hace aquí, no en el hilo principal. */
async function initMotion() {
  const { MotionCore } = await import('../detectors/MotionDetector.js');
  const core = new MotionCore();
  let canvas = null, ctx = null;
  det = {
    backend: 'CPU · JS',
    reset() { core.reset(); },
    dispose() {},
    infer(bmp, f) {
      const W = f.w || bmp.width, H = f.h || bmp.height;
      if (!canvas || canvas.width !== W || canvas.height !== H) {
        canvas = new OffscreenCanvas(W, H);
        ctx = canvas.getContext('2d', { willReadFrequently: true });
      }
      ctx.drawImage(bmp, 0, 0, W, H);
      const r = core.process(ctx.getImageData(0, 0, W, H).data, W, H, f.t);
      const heat = r.heat.slice();
      return { energy: r.energy, w: W, h: H, heat, __transfer: [heat.buffer] };
    },
  };
  post({ type: 'ready', backend: det.backend });
}

async function infer(m) {
  const t0 = performance.now();
  try {
    if (m.opts) Object.assign(det, m.opts);
    const result = await det.infer(m.bitmap, { t: m.t, w: m.w, h: m.h });
    let transfer = [];
    if (result && result.__transfer) { transfer = result.__transfer; delete result.__transfer; }
    const msg = { type: 'result', seq: m.seq, result, ms: performance.now() - t0 };
    if (tf && tf.memory) {
      const mem = tf.memory();
      msg.mem = { numTensors: mem.numTensors, numBytes: mem.numBytes };
    }
    post(msg, transfer);
  } finally {
    if (m.bitmap && m.bitmap.close) m.bitmap.close();
  }
}
