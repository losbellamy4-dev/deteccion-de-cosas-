/**
 * main.js — Arranque de «Detéctalo todo».
 *
 * Secuencia de inicialización (todo desde disco local, sin red):
 *  1. Construye el núcleo (Engine, VideoSource, Renderer, EventLog,
 *     AlertManager, ZoneManager) y la interfaz.
 *  2. Detecta capacidades: WASM SIMD, WebGL2, GPU real o por software, WebGPU,
 *     soporte de Web Workers con OffscreenCanvas.
 *  3. Comprueba TODOS los archivos de /lib y /models. Si falta alguno se dice
 *     qué archivo y dónde va; los módulos que no dependen de él siguen
 *     funcionando. Jamás se intenta descargar nada de Internet.
 *  4. MediaPipe: crea pose, manos y malla facial a partir de los bytes de cada
 *     .task (progreso por modelo), cada uno en su propio Web Worker (o en el
 *     hilo principal como respaldo), con el delegado GPU→CPU que funcione.
 *  5. TF.js: activa el primer backend que funcione (WebGPU → WebGL → WASM →
 *     CPU) y carga COCO-SSD; si la ejecución de prueba falla en un backend,
 *     pasa al siguiente. También en un worker, con respaldo local.
 *  6. Arranca el bucle de render y espera a que el usuario elija una fuente.
 */
import { APP, ASSETS, SETTINGS, POSE_VARIANTS, VERSIONS, MODULES } from './config.js';
import { Settings, safeStorage } from './core/Settings.js';
import { EventLog } from './analytics/EventLog.js';
import { AlertManager } from './analytics/AlertManager.js';
import { ZoneManager } from './analytics/ZoneManager.js';
import { VideoSource } from './core/VideoSource.js';
import { Renderer } from './core/Renderer.js';
import { Engine } from './core/Engine.js';
import { checkAll, fetchWithProgress, loadClassicScript, assertMagic } from './core/AssetChecker.js';
import { detectGpu, wasmSimdSupported, tfBackendOrder, activateTfBackend } from './core/BackendManager.js';
import { MediaPipeRuntime, delegateOrder } from './detectors/MediaPipeRuntime.js';
import { PoseDetector } from './detectors/PoseDetector.js';
import { HandDetector } from './detectors/HandDetector.js';
import { FaceDetector } from './detectors/FaceDetector.js';
import { ObjectDetector, backendLabel } from './detectors/ObjectDetector.js';
import { MotionDetector } from './detectors/MotionDetector.js';
import { WorkerDetector, MotionWorkerDetector } from './detectors/WorkerDetector.js';
import { UIController } from './ui/UIController.js';
import { LoadingScreen } from './ui/LoadingScreen.js';

window.__detectaloBooted = true; // lo vigila boot-check.js

const $ = (id) => document.getElementById(id);
const abs = (p) => new URL(p, document.baseURI).href;
const MP_BUNDLE = 'lib/mediapipe/vision_bundle.mjs';
const MP_WASM_DIR = 'lib/mediapipe/wasm';
const LABELS = Object.fromEntries(MODULES.map((m) => [m.id, `${m.letter} · ${m.name}`]));

async function main() {
  const settings = new Settings(SETTINGS);
  const log = new EventLog();
  const alerts = new AlertManager(log);
  alerts.sound = settings.get('alert.sound');
  const zones = new ZoneManager();
  zones.load(safeStorage().get('detectalo.zones.v1'));
  const source = new VideoSource($('video'));
  const renderer = new Renderer($('overlay'));
  const engine = new Engine({ source, renderer, settings, log, alerts, zones });
  const loading = new LoadingScreen($('loading'));

  const ctx = { settings, log, alerts, zones, source, renderer, engine, loading, results: [], notices: [], det: {} };
  const ui = new UIController({ engine, settings, log, alerts, zones, source, renderer, actions: { reloadDetector: (id) => reloadDetector(ctx, id) } });
  ctx.ui = ui;
  // Acceso para depuración desde la consola (F12): window.detectalo.engine, etc.
  window.detectalo = ctx;

  // Cualquier intento de conexión externa queda bloqueado por la CSP y se registra.
  document.addEventListener('securitypolicyviolation', (e) => {
    log.add('error', 'sistema', `Bloqueado por la CSP (no local): ${e.blockedURI || 'recurso'} [${e.violatedDirective}]`);
  });
  window.addEventListener('unhandledrejection', (e) => console.warn('[promesa no gestionada]', e.reason));

  ui.build();
  engine.start();
  log.add('system', 'sistema', `${APP.name} v${APP.version} — MediaPipe Tasks ${VERSIONS.mediapipe} · TensorFlow.js ${VERSIONS.tfjs}`);

  await bootModels(ctx);
  hookTaskOptions(ctx);
}

/** Pasos 2–5: capacidades, comprobación de archivos y carga de modelos. */
async function bootModels(ctx) {
  const { settings, log, engine, loading, ui } = ctx;
  engine.setStatus('loading');
  loading.show();

  // --- 2) Capacidades -------------------------------------------------------
  const simd = wasmSimdSupported();
  const gpu = detectGpu();
  const canWorkers = typeof Worker !== 'undefined' && typeof createImageBitmap === 'function' && typeof OffscreenCanvas !== 'undefined';
  ctx.simd = simd;
  ctx.gpu = gpu;
  ctx.useWorkers = canWorkers && settings.get('perf.workers');
  const sys = `GPU: ${gpu.renderer || 'sin WebGL2'}${gpu.software ? ' (por software)' : ''} · WebGPU: ${gpu.webgpu ? 'sí' : 'no'} · WASM SIMD: ${simd ? 'sí' : 'no'} · workers: ${ctx.useWorkers ? 'sí' : canWorkers ? 'desactivados' : 'no disponibles'} · núcleos: ${navigator.hardwareConcurrency || '?'}`;
  ui.setSystemInfo(sys);
  log.add('system', 'sistema', sys);
  if (gpu.software) log.add('warn', 'sistema', 'GPU por software detectada: en modo automático se usan los backends de CPU (WASM), más rápidos en este caso.');

  // --- 3) Archivos locales ----------------------------------------------------
  loading.step('check', 'Comprobando archivos locales', 'run', 'lib/ y models/');
  const results = await checkAll(ASSETS, { simd });
  ctx.results = results;
  const errors = results.filter((r) => !r.ok && !r.asset.optional);
  const optionalMissing = results.filter((r) => !r.ok && r.asset.optional);
  const warnings = results.filter((r) => r.ok && r.level === 'warn');
  loading.step('check', `Archivos locales: ${results.filter((r) => r.ok).length} de ${results.length} correctos`, errors.length ? 'error' : 'ok',
    errors.length ? `${errors.length} archivo(s) necesario(s) con problemas — ver detalle abajo` : (optionalMissing.length ? `${optionalMissing.length} opcional(es) no disponible(s)` : 'todo en su sitio'));
  for (const r of errors) { loading.addFileIssue('error', r); log.add('error', 'sistema', `${r.message} Debe ir en ${r.asset.path}`); }
  for (const r of warnings) loading.addFileIssue('warn', r);
  for (const r of optionalMissing) {
    const why = r.problem === 'missing' ? 'no está instalado' : r.message;
    log.add('warn', 'sistema', `Opcional no disponible: ${r.asset.path}${r.asset.note ? ` (${r.asset.note})` : ''} — ${why}`);
  }
  ctx.fileOk = (path) => results.some((r) => r.asset.path === path && r.ok);
  const blockedBy = (mod) => errors.filter((r) => (r.asset.needs || []).includes(mod)).map((r) => r.asset.path);
  // Variantes de pose sin archivo: deshabilitadas en el selector; si el ajuste
  // guardado apunta a una que falta, se vuelve a "lite".
  const missingVariants = Object.keys(POSE_VARIANTS).filter((v) => v !== 'lite' && !ctx.fileOk(POSE_VARIANTS[v]));
  ui.markUnavailableOptions('pose.variant', missingVariants);
  if (missingVariants.includes(settings.get('pose.variant'))) {
    ctx.notices.push(`El modelo de pose «${settings.get('pose.variant')}» no está instalado; se usa «lite».`);
    settings.set('pose.variant', 'lite');
  }

  // --- Detectores (versión local; los workers los sustituyen si arrancan) ----
  ctx.mp = new MediaPipeRuntime({ bundlePath: MP_BUNDLE, wasmDir: MP_WASM_DIR, simd });
  const local = {
    pose: new PoseDetector(ctx.mp),
    hands: new HandDetector(ctx.mp),
    face: new FaceDetector(ctx.mp),
    objects: new ObjectDetector(),
    motion: new MotionDetector(),
  };
  for (const d of Object.values(local)) setDetector(ctx, d);
  ctx.delegates = delegateOrder(settings.get('perf.mpDelegate'), gpu);

  // --- 4) MediaPipe ---------------------------------------------------------------
  const mpIds = ['pose', 'hands', 'face'];
  for (const id of mpIds) {
    const missing = blockedBy(id);
    if (missing.length) ctx.det[id].setStatus('missing', `Faltan: ${missing.join(', ')}`);
  }
  let mpFilesOk = false;
  if (mpIds.some((id) => ctx.det[id].status !== 'missing')) {
    const wasm = `${MP_WASM_DIR}/${simd ? 'vision_wasm_internal' : 'vision_wasm_nosimd_internal'}.wasm`;
    const title = `Runtime MediaPipe Tasks ${VERSIONS.mediapipe} (WASM ${simd ? 'SIMD' : 'sin SIMD'})`;
    loading.step('mp', title, 'run', wasm);
    try {
      // Lectura con progreso: el navegador la reutiliza (caché) al instanciar el WASM.
      assertMagic(await fetchWithProgress(wasm, (g, t) => loading.progress('mp', g, t)), 'wasm', wasm);
      if (!ctx.useWorkers) await ctx.mp.load();
      mpFilesOk = true;
      loading.step('mp', title, 'ok', `delegados: ${ctx.delegates.join(' → ')}${ctx.useWorkers ? ' · un Web Worker por modelo' : ' · hilo principal'}`);
    } catch (e) {
      loading.step('mp', 'Runtime MediaPipe', 'error', e.message);
      for (const id of mpIds) if (ctx.det[id].status !== 'missing') ctx.det[id].setStatus('error', `Runtime MediaPipe: ${e.message}`);
    }
  }
  for (const id of mpIds) {
    if (ctx.det[id].status === 'missing') { loading.step(id, LABELS[id], 'skip', ctx.det[id].statusDetail); continue; }
    if (!mpFilesOk) { loading.step(id, LABELS[id], 'skip', 'runtime MediaPipe no disponible'); continue; }
    await loadMediaPipeDetector(ctx, id, (state, detail) => loading.step(id, LABELS[id], state, detail), (g, t) => loading.progress(id, g, t));
    const d = ctx.det[id];
    if (d.ready && d.delegate && d.delegate !== ctx.delegates[0]) ctx.notices.push(`${LABELS[id]}: delegado ${ctx.delegates[0]} no disponible, se usa ${d.delegate}.`);
  }

  // --- 5) TensorFlow.js + COCO-SSD -------------------------------------------------
  const objMissing = blockedBy('objects');
  if (objMissing.length) {
    ctx.det.objects.setStatus('missing', `Faltan: ${objMissing.join(', ')}`);
    loading.step('objects', LABELS.objects, 'skip', ctx.det.objects.statusDetail);
  } else {
    await loadObjects(ctx, (state, detail) => loading.step('objects', `${LABELS.objects} · TensorFlow.js`, state, detail), (f) => loading.progressFrac('objects', f));
  }

  // --- Módulo E (sin modelo) ------------------------------------------------------
  await loadMotion(ctx);
  loading.step('motion', LABELS.motion, ctx.det.motion.ready ? 'ok' : 'error', `diferencia de fotogramas, sin modelo · ${ctx.det.motion.backend || ctx.det.motion.statusDetail}`);

  engine.refreshConnections();
  updateBackendHeader(ctx);
  for (const n of ctx.notices.splice(0)) { log.add('warn', 'sistema', n); ui.toast(n, 'warn'); }
  ui._renderModules();

  const all = Object.values(ctx.det);
  const ready = all.filter((d) => d.id !== 'motion' && d.ready).map((d) => d.letter);
  const failed = all.filter((d) => d.status === 'error' || d.status === 'missing');
  log.add('system', 'sistema', `Motor listo. Módulos operativos: ${[...ready, 'E'].join(', ')}${failed.length ? ` · no disponibles: ${failed.map((d) => d.letter).join(', ')}` : ''}`);
  engine.setStatus(ready.length ? 'ready' : 'error', failed.map((d) => `${d.letter}: ${d.statusDetail}`).join(' | '));

  if (failed.length || errors.length) {
    const choice = await loading.waitForChoice({
      canContinue: true,
      summary: ready.length
        ? `Hay módulos sin cargar. Puedes continuar con los disponibles (${[...ready, 'E'].join(', ')}) o colocar los archivos que faltan y reintentar.`
        : 'Ningún modelo de IA ha podido cargarse: sólo funcionará el módulo E (movimiento). Coloca los archivos indicados y pulsa «Reintentar».',
    });
    if (choice === 'retry') { location.reload(); return; }
  }
  loading.hide();
  ui.toast(`Listo. Backend: ${ui.backendText}. Elige una fuente de vídeo.`, 'ok');
}

/** Registra (o sustituye) el detector activo de un módulo. */
function setDetector(ctx, d) {
  const prev = ctx.det[d.id];
  if (prev && prev !== d) prev.dispose();
  ctx.det[d.id] = d;
  ctx.engine.addDetector(d);
  if (d.id === 'objects') {
    d.minScore = ctx.settings.get('objects.minScore');
    d.maxResults = ctx.settings.get('objects.maxResults');
  }
}

function mpOptions(ctx, id) {
  const S = ctx.settings;
  if (id === 'pose') return { numPoses: S.get('pose.numPoses'), variant: S.get('pose.variant') };
  if (id === 'hands') return { numHands: S.get('hands.numHands') };
  return { numFaces: S.get('face.numFaces') };
}

/** Carga (o recarga) un modelo de MediaPipe: en worker si es posible, si no en local. */
async function loadMediaPipeDetector(ctx, id, onState, onProgress) {
  const { settings, delegates } = ctx;
  const path = id === 'pose' ? POSE_VARIANTS[settings.get('pose.variant')] : id === 'hands' ? 'models/hands/hand_landmarker.task' : 'models/face/face_landmarker.task';
  const current = ctx.det[id];
  current.setStatus('loading');
  let model;
  try {
    onState('run', `leyendo ${path}`);
    model = await fetchWithProgress(path, onProgress || (() => {}));
    assertMagic(model, 'zip', path);
  } catch (e) {
    current.setStatus('error', e.message);
    onState('error', e.message);
    return;
  }
  if (ctx.useWorkers) {
    const wd = new WorkerDetector({ id, letter: current.letter, name: current.name, cadence: current.cadence, priority: current.priority });
    try {
      onState('run', `inicializando en Web Worker (delegado ${delegates.join(' → ')})…`);
      await wd.start({ kind: 'mediapipe', task: id, bundleUrl: abs(MP_BUNDLE), wasmDir: abs(MP_WASM_DIR), simd: ctx.simd, model: model.slice(), delegates, options: mpOptions(ctx, id) });
      if (id === 'pose') wd.variant = settings.get('pose.variant');
      setDetector(ctx, wd);
      onState('ok', `${path} · ${wd.backend}`);
      ctx.engine.refreshConnections();
      return;
    } catch (e) {
      wd.dispose();
      ctx.notices.push(`${LABELS[id]}: no se pudo usar un Web Worker (${e.message}); se ejecuta en el hilo principal.`);
    }
  }
  // Respaldo: hilo principal.
  try {
    if (!ctx.mp.vision) await ctx.mp.load();
    const det = !ctx.det[id].isWorker ? ctx.det[id]
      : id === 'pose' ? new PoseDetector(ctx.mp) : id === 'hands' ? new HandDetector(ctx.mp) : new FaceDetector(ctx.mp);
    onState('run', `inicializando (delegado ${delegates.join(' → ')})…`);
    await det.load({ model, delegates, ...mpOptions(ctx, id) });
    setDetector(ctx, det);
    onState('ok', `${path} · ${det.backend}`);
  } catch (e) {
    ctx.det[id].setStatus('error', e.message);
    onState('error', e.message);
  }
  ctx.engine.refreshConnections();
}

/** Módulo E: en worker si es posible (la lectura de píxeles no bloquea el render). */
async function loadMotion(ctx) {
  if (ctx.useWorkers) {
    const wd = new MotionWorkerDetector();
    try {
      await wd.load();
      setDetector(ctx, wd);
      return;
    } catch (e) {
      wd.dispose();
      ctx.notices.push(`${LABELS.motion}: no se pudo usar un Web Worker (${e.message}); se calcula en el hilo principal.`);
    }
  }
  const d = ctx.det.motion.isWorker ? new MotionDetector() : ctx.det.motion;
  try {
    await d.load();
  } catch (e) {
    d.setStatus('error', e.message);
  }
  setDetector(ctx, d);
}

/** Carga COCO-SSD con TF.js: en worker si es posible; si no, en el hilo principal. */
async function loadObjects(ctx, onState, onProgress) {
  const { settings, gpu, log } = ctx;
  const pref = settings.get('perf.tfBackend');
  const order = tfBackendOrder(pref, gpu);
  const extra = [];
  if (ctx.fileOk('lib/tfjs/tf-backend-webgpu.min.js')) extra.push('lib/tfjs/tf-backend-webgpu.min.js');
  const wasmOk = ['tf-backend-wasm.min.js', 'tfjs-backend-wasm.wasm', 'tfjs-backend-wasm-simd.wasm'].every((f) => ctx.fileOk(`lib/tfjs/${f}`));
  if (wasmOk) extra.push('lib/tfjs/tf-backend-wasm.min.js');

  const report = (name, attempts) => {
    for (const a of (attempts || []).filter((x) => !x.ok)) log.add('system', 'sistema', `TF.js: backend ${a.name} descartado (${a.reason})`);
    if (pref !== 'auto' && name !== pref) ctx.notices.push(`TF.js: el backend preferido (${pref}) no está disponible; se usa ${backendLabel(name)}.`);
    else if (pref === 'auto' && name !== order[0]) ctx.notices.push(`TF.js: ${backendLabel(order[0])} no disponible; se usa ${backendLabel(name)}.`);
    log.add('system', 'sistema', `TF.js activo con backend ${backendLabel(name)}${ctx.det.objects.isWorker ? ' (en Web Worker)' : ''}`);
  };

  if (ctx.useWorkers) {
    const cur = ctx.det.objects;
    const wd = new WorkerDetector({ id: 'objects', letter: cur.letter, name: cur.name, cadence: cur.cadence, priority: cur.priority });
    try {
      onState('run', `Web Worker · backends a probar: ${order.join(' → ')}`);
      const m = await wd.start({
        kind: 'tfjs',
        urls: { tf: abs('lib/tfjs/tf.min.js'), extra: extra.map(abs) },
        wasmPrefix: abs('lib/tfjs/'),
        modelUrl: abs('models/coco-ssd/model.json'),
        order,
        auto: pref === 'auto',
      }, [], onProgress);
      setDetector(ctx, wd);
      for (const n of m.notices || []) ctx.notices.push(n);
      report(m.tfBackend, m.attempts);
      onState('ok', `models/coco-ssd · ${wd.backend}`);
      return;
    } catch (e) {
      wd.dispose();
      ctx.notices.push(`${LABELS.objects}: no se pudo usar un Web Worker (${e.message}); se ejecuta en el hilo principal.`);
    }
  }

  // Respaldo: hilo principal.
  try {
    if (!window.tf) {
      // tf.min.js incluye un regenerator-runtime antiguo que, si la variable
      // global no existe, intenta crearla con Function(): la CSP lo bloquea
      // (no hay 'unsafe-eval') y abortaría la carga. Predeclararla lo evita.
      if (!('regeneratorRuntime' in globalThis)) globalThis.regeneratorRuntime = undefined;
      await loadClassicScript('lib/tfjs/tf.min.js');
      for (const p of extra) await loadClassicScript(p).catch((e) => ctx.notices.push(`No se pudo cargar ${p}: ${e.message}`));
    }
    const tf = window.tf;
    if (!tf || !tf.loadGraphModel) throw new Error('TF.js no se inicializó correctamente');
    if (tf.wasm && tf.wasm.setWasmPaths) tf.wasm.setWasmPaths(abs('lib/tfjs/'));
    ctx.engine.tf = tf;
    const det = ctx.det.objects.isWorker ? new ObjectDetector() : ctx.det.objects;
    setDetector(ctx, det);
    det.setStatus('loading');
    let start = 0, lastErr = null;
    while (start < order.length) {
      let act;
      try { act = await activateTfBackend(tf, order.slice(start), { auto: pref === 'auto' }); } catch (e) { lastErr = e; break; }
      onState('run', `backend ${backendLabel(act.name)} · cargando models/coco-ssd/model.json`);
      try {
        await det.load({ tf, url: 'models/coco-ssd/model.json', onProgress });
        report(act.name, act.attempts);
        onState('ok', `models/coco-ssd · ${det.backend}`);
        return;
      } catch (e) {
        lastErr = e;
        det.dispose();
        ctx.notices.push(`TF.js: COCO-SSD falló con ${backendLabel(act.name)} (${e.message}); se prueba el siguiente backend.`);
        start = order.indexOf(act.name) + 1;
      }
    }
    throw lastErr || new Error('sin backend disponible');
  } catch (e) {
    ctx.det.objects.setStatus('error', e.message);
    onState('error', e.message);
  }
}

function updateBackendHeader(ctx) {
  const { det, ui, gpu } = ctx;
  const mpDet = ['pose', 'hands', 'face'].map((id) => det[id]).find((d) => d.ready);
  const tfName = det.objects.ready ? (det.objects.tfBackend ? backendLabel(det.objects.tfBackend) : det.objects.backend) : '—';
  const mpTxt = mpDet ? (mpDet.delegate === 'GPU' ? 'GPU' : 'CPU') : '—';
  const workers = Object.values(det).some((d) => d.isWorker);
  const title = `TensorFlow.js (objetos): ${det.objects.ready ? det.objects.backend : 'no disponible'}\nMediaPipe (pose/manos/rostro): ${mpDet ? mpDet.backend : 'no disponible'}\nGPU: ${gpu.renderer || 'sin WebGL2'}${gpu.software ? ' (por software)' : ''}`;
  ui.setBackendInfo(`TF.js ${tfName} · MP ${mpTxt}${workers ? ' · workers' : ''}`, title);
}

/** Opciones que reconfiguran un modelo ya cargado (sin recargar la página). */
function hookTaskOptions(ctx) {
  const { settings, log, ui } = ctx;
  settings.on('change', async ({ key, value }) => {
    const det = ctx.det;
    try {
      if (key === 'pose.numPoses' && det.pose.ready) await det.pose.setNumPoses(value);
      else if (key === 'hands.numHands' && det.hands.ready) await det.hands.setNumHands(value);
      else if (key === 'face.numFaces' && det.face.ready) await det.face.setNumFaces(value);
      else if (key === 'pose.variant') {
        if (value === det.pose.variant && det.pose.ready) return; // reversión o sin cambio
        const path = POSE_VARIANTS[value];
        if (!ctx.fileOk(path)) {
          ui.toast(`No está el modelo «${value}» (${path}). Descárgalo (ver README) y recarga.`, 'error');
          settings.set('pose.variant', det.pose.variant || 'lite');
          return;
        }
        await reloadDetector(ctx, 'pose');
      } else return;
      log.add('system', 'sistema', `Ajuste aplicado: ${key} = ${value}`);
    } catch (e) {
      ui.toast(`No se pudo aplicar ${key}: ${e.message}`, 'error');
    }
  });
}

/** Reintenta la carga de un módulo (botón «Reintentar» o cambio de variante). */
async function reloadDetector(ctx, id) {
  const { ui, log, engine } = ctx;
  const d0 = ctx.det[id];
  if (!d0) return;
  d0.consecutiveErrors = 0;
  ui.toast(`Recargando ${LABELS[id]}…`);
  if (id === 'objects') await loadObjects(ctx, () => {}, () => {});
  else if (id === 'motion') await loadMotion(ctx);
  else await loadMediaPipeDetector(ctx, id, () => {}, null);
  for (const n of ctx.notices.splice(0)) { log.add('warn', 'sistema', n); ui.toast(n, 'warn'); }
  updateBackendHeader(ctx);
  ui._renderModules();
  const d = ctx.det[id];
  if (d.ready) {
    log.add('system', 'sistema', `${LABELS[id]} recargado (${d.backend})`);
    ui.toast(`${d.name}: listo (${d.backend}).`, 'ok');
    if (engine.source.ready && engine.source.paused) engine.requestAnalysis();
  } else {
    ui.toast(`${d.name}: ${d.statusDetail}`, 'error');
  }
}

main().catch((e) => {
  console.error(e);
  const box = document.createElement('div');
  box.className = 'fatal';
  const inner = document.createElement('div');
  inner.className = 'box';
  const h2 = document.createElement('h2');
  h2.textContent = 'Error al iniciar la aplicación';
  const p = document.createElement('p');
  p.textContent = e && e.message ? e.message : String(e);
  inner.append(h2, p);
  box.append(inner);
  document.body.append(box);
});
