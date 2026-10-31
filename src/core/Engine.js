/**
 * Engine.js — Orquestador: bucle de frames, planificación de modelos, control
 * de carga y conexión de resultados con la capa de inteligencia derivada.
 *
 * BUCLE DE FRAMES (requestAnimationFrame, ~60 Hz):
 *  1. Mide los FPS de render (ventana deslizante de 1 s).
 *  2. Si la fuente tiene un fotograma NUEVO (requestVideoFrameCallback), el
 *     planificador elige qué modelos tocan ("1 de cada N", urgencia y
 *     presupuesto en ms) y los ejecuta sobre un lienzo reducido compartido
 *     (la "resolución de inferencia", que baja con la degradación adaptativa).
 *     Los modelos de MediaPipe son síncronos; el de TF.js es asíncrono y su
 *     resultado llega en un frame posterior, sin bloquear.
 *  3. Cada resultado pasa por su Tracker (IDs persistentes) y por la analítica
 *     (actividad, caída, inmovilidad, gestos, métricas faciales, zonas,
 *     líneas, distancias), que genera eventos para el EventLog y el
 *     AlertManager. Los objetos pasan antes por el filtro anti-fantasmas
 *     (analytics/ObjectFilter.js) y el reconocimiento de 1000 cosas (módulo
 *     F) clasifica el visor central, la escena y el recorte de cada objeto.
 *  4. Se repinta el overlay SIEMPRE, haya o no análisis en ese frame: la
 *     interfaz sigue fluida aunque el análisis vaya a menos.
 *  5. Cada 0,5 s el control adaptativo decide si degradar o recuperar.
 *
 * Robustez: el siguiente requestAnimationFrame se programa ANTES de trabajar,
 * así ninguna excepción puede detener el bucle; los errores se registran.
 */
import { Emitter } from './Emitter.js';
import { Scheduler, AdaptiveController } from './Scheduler.js';
import { RateMeter, Ema } from './Stats.js';
import { Tracker, IdGenerator } from '../analytics/Tracker.js';
import { PoseState, poseFeatures, footPoint, StillnessMeter, bySensitivity, POSTURE_LABEL } from '../analytics/PoseAnalytics.js';
import { classifyHand, StableLabel } from '../analytics/HandAnalytics.js';
import { faceMetrics, FaceState, gazeLabel } from '../analytics/FaceAnalytics.js';
import { emaAlpha } from '../analytics/geometry.js';
import { filterDetections } from '../analytics/ObjectFilter.js';
import { reticleRoi, squareRoi, ScoreSmoother } from '../analytics/Recognition.js';
import { IMAGENET_ES, imagenetToCoco, CORRECTABLE } from '../analytics/imagenetLabels.js';

const KIND_LABEL = { webcam: 'WEBCAM', file: 'ARCHIVO', screen: 'PANTALLA' };
/** Confianza mínima de lo que piden los detectores de objetos (el resto lo filtra ObjectFilter). */
const OBJECT_FLOOR = 0.25;

export class Engine extends Emitter {
  constructor({ source, renderer, settings, log, alerts, zones }) {
    super();
    this.source = source;
    this.renderer = renderer;
    this.settings = settings;
    this.log = log;
    this.alerts = alerts;
    this.zones = zones;
    this.detectors = new Map();
    this.scheduler = new Scheduler();
    this.adaptive = new AdaptiveController();
    this.renderRate = new RateMeter(1000);
    this.analysisRate = new RateMeter(1000);
    this.frameWork = new Ema(0.1);
    this.ids = new IdGenerator(); // personas y objetos comparten numeración (#1, #2…)
    this.trackers = {
      person: new Tracker({ kind: 'person', idGen: this.ids, refPoint: 'foot', iouMin: 0.1, maxCenterDist: 1.0, maxAge: 1.5, minHits: 2, classAware: false }),
      object: new Tracker({ kind: 'object', idGen: this.ids, refPoint: 'center', iouMin: 0.15, maxCenterDist: 0.8, maxAge: 1.5, minHits: 2, classAware: true }),
      hand: new Tracker({ kind: 'hand', idGen: new IdGenerator(), iouMin: 0.05, maxCenterDist: 1.2, maxAge: 0.5, minHits: 1, classAware: false }),
      face: new Tracker({ kind: 'face', idGen: new IdGenerator(), iouMin: 0.1, maxCenterDist: 1.0, maxAge: 0.8, minHits: 1, classAware: false }),
    };
    this.scene = { persons: [], objects: [], hands: [], faces: [], distances: [], motion: null, motionCanvas: null, personSource: null, tentative: [] };
    this.connections = { pose: [], hand: [], face: { tess: [], contours: [], irises: [] } };
    this.unique = { persons: new Set(), objects: new Set() };
    this.motionStats = freshMotionStats();
    this.recog = freshRecog();
    this.filtered = 0; // detecciones descartadas por el filtro anti-fantasmas
    this._applyStrict(settings.get('precision.strict'));
    this.frameIndex = 0;
    this.sceneVersion = 0;
    this.settingsVersion = 0;
    this.skippedDraws = 0;
    this.gen = 0;
    this.lastT = null;
    this.inputCanvas = document.createElement('canvas');
    this.inputCtx = this.inputCanvas.getContext('2d', { alpha: false });
    this.inputSize = { w: 0, h: 0 };
    this.forceAnalysis = false;
    this.running = false;
    this.status = 'boot';
    this.mirror = false;
    this.tf = null;
    this.editor = { mode: null, points: [], cursor: null, a: null, selected: null };
    this._lastFrameSeq = -1;
    this._mainFreeAt = 0;
    this._lastStats = 0;
    this._loopErrors = 0;
    this._tick = this._tick.bind(this);
    this._onResult = this._onResult.bind(this);
    this._onError = this._onError.bind(this);
    document.addEventListener('visibilitychange', () => this.adaptive.hold(1500));
    settings.on('change', (e) => this._onSetting(e));
    source.on('started', () => this.resetTemporal('nueva fuente', true));
  }

  // ---------------------------------------------------------------------------
  // Registro y estado
  // ---------------------------------------------------------------------------

  addDetector(det) {
    det.enabled = !!this.settings.get(`${det.id}.enabled`);
    det.cadence = this.settings.get(`perf.cadence.${det.id}`) || det.cadence;
    if (det.id === 'objects') {
      // El detector entrega todo lo que supere un umbral bajo; el umbral del
      // usuario, las clases dudosas y el doble umbral se aplican en _onObjects.
      det.minScore = OBJECT_FLOOR;
      det.maxResults = 40;
    }
    if (det.id === 'pose') det.ghostFilter = !!this.settings.get('precision.strict');
    if (det.id === 'classifier') det.maxSide = 1280;
    this.detectors.set(det.id, det);
  }

  /**
   * Modo estricto (anti-fantasmas): los objetos necesitan 3 detecciones para
   * confirmarse (2 si su confianza media es ≥ 0,7) y la pose descarta
   * esqueletos sin tronco reconocible.
   */
  _applyStrict(on) {
    const ot = this.trackers.object;
    ot.minHits = on ? 3 : 2;
    ot.fastConfirm = on ? { hits: 2, meanScore: 0.7 } : null;
    const p = this.get('pose');
    if (p) p.ghostFilter = !!on;
  }

  get(id) { return this.detectors.get(id); }

  /** Toma las conexiones (esqueleto, mano, malla) de los modelos ya cargados. */
  refreshConnections() {
    const p = this.get('pose'), h = this.get('hands'), f = this.get('face');
    if (p && p.connections.length) this.connections.pose = p.connections;
    if (h && h.connections.length) this.connections.hand = h.connections;
    if (f && f.connections.tess.length) this.connections.face = f.connections;
  }

  setStatus(s, detail = '') {
    this.status = s;
    this.emit('status', { status: s, detail });
  }

  start() {
    if (this.running) return;
    this.running = true;
    requestAnimationFrame(this._tick);
  }

  /** Fuerza el análisis completo del fotograma actual (pausa, avance, cambios). */
  requestAnalysis() { this.forceAnalysis = true; }

  // ---------------------------------------------------------------------------
  // Bucle de frames
  // ---------------------------------------------------------------------------

  _tick(now) {
    requestAnimationFrame(this._tick);
    const w0 = performance.now();
    try {
      this._frame(now);
      this._loopErrors = 0;
    } catch (e) {
      this._loopErrors++;
      if (this._loopErrors === 1 || this._loopErrors % 300 === 0) {
        console.error('[Engine] error en el bucle', e);
        this.log.add('error', 'sistema', `Error en el bucle de render: ${e.message}`);
      }
    }
    // Trabajo real del hilo principal en este frame (análisis + pintado).
    this.frameWork.push(performance.now() - w0);
  }

  _frame(now) {
    this.renderRate.tick(now);
    const src = this.source;
    src.pollFrame(now);
    if (src.ready) {
      const fresh = src.frameSeq !== this._lastFrameSeq;
      // Fotograma nuevo reproduciendo → planificador; fotograma nuevo en pausa
      // (búsqueda/avance) o petición explícita → análisis completo.
      if (fresh || this.forceAnalysis) {
        const force = this.forceAnalysis || src.paused;
        this._lastFrameSeq = src.frameSeq;
        this.forceAnalysis = false;
        this._analyze(now, force);
      }
    }
    this.alerts.tick();
    this._render(now);
    const fps = this.renderRate.rate(now);
    const change = this.adaptive.update(now, fps, {
      enabled: this.settings.get('perf.adaptive'),
      target: this.settings.get('perf.fpsTarget'),
      active: src.ready && !src.paused,
    });
    if (change) {
      this.log.add('system', 'sistema', change === 'down'
        ? `Carga alta (render ${fps.toFixed(0)} FPS < ${this.settings.get('perf.fpsTarget')}): degradación nivel ${this.adaptive.level} — resolución ${Math.round(this.adaptive.scale * 100)} %, cadencias ×${this.adaptive.multiplier}`
        : `Carga recuperada: nivel ${this.adaptive.level} — resolución ${Math.round(this.adaptive.scale * 100)} %, cadencias ×${this.adaptive.multiplier}`);
    }
    if (now - this._lastStats > 250) {
      this._lastStats = now;
      this.emit('stats', this.stats(now));
    }
  }

  _analyze(now, force) {
    const src = this.source;
    const t = src.isLive ? now / 1000 : (src.mediaTime || src.el.currentTime);
    if (this.lastT != null && (t < this.lastT - 1e-3 || t - this.lastT > 2.5)) {
      this.resetTemporal(t < this.lastT ? 'salto hacia atrás en el vídeo' : 'salto en el tiempo');
    }
    this.lastT = t;
    this.frameIndex++;
    const frame = { index: this.frameIndex, t, gen: this.gen, media: src.isLive ? null : t };
    const all = [...this.detectors.values()];
    const budget = this.settings.get('perf.budgetMs');
    const cores = navigator.hardwareConcurrency || 4;
    let due = force
      ? all.filter((d) => d.enabled && d.ready && !d.inFlight)
      : this.scheduler.select(all, this.frameIndex, {
        budgetMs: budget,
        multiplier: this.adaptive.multiplier,
        maxConcurrent: Math.max(1, cores - 2 - this.adaptive.concurrencyDrop),
        gapFactor: this.adaptive.gapFactor,
        now,
      });
    // Ciclo de trabajo del hilo principal: tras una inferencia local (sin
    // worker) de L ms se deja el hilo libre al menos L × (1 + hueco adaptativo)
    // ms para pintar. Con modelos lentos en el hilo principal (modo portable,
    // equipos sin GPU) el vídeo sigue viéndose fluido en vez de a saltos.
    if (!force && now < this._mainFreeAt) due = due.filter((d) => d.isWorker);
    if (!due.length) return;
    const input = this._prepareInput();
    const t0 = performance.now();
    let ran = 0, localMs = 0;
    for (const d of due) {
      // Comprobación real del presupuesto (la estimación puede quedarse corta).
      if (!force && ran > 0 && performance.now() - t0 > budget) break;
      // El módulo F recorta trozos pequeños (visor, objetos): se le da el
      // fotograma a resolución nativa (el worker lo limita a 1280 px) para
      // que cada recorte tenga detalle suficiente.
      if (d.id === 'classifier') d.rois = this._classifierRois(d, frame);
      const s0 = performance.now();
      d.run(d.id === 'classifier' ? this.source.el : input, frame, this._onResult, this._onError);
      if (!d.isWorker) localMs += performance.now() - s0;
      ran++;
    }
    if (localMs > 8) this._mainFreeAt = performance.now() + localMs * (1 + this.adaptive.gapFactor);
    if (ran) this.analysisRate.tick(now);
  }

  /** Dibuja el fotograma en el lienzo de inferencia (aspecto conservado). */
  _prepareInput() {
    const v = this.source.el;
    const vw = v.videoWidth, vh = v.videoHeight;
    const maxSide = Math.max(256, Math.round(Number(this.settings.get('perf.maxSide')) * this.adaptive.scale));
    const s = Math.min(1, maxSide / Math.max(vw, vh));
    const w = Math.max(16, Math.round(vw * s)), h = Math.max(16, Math.round(vh * s));
    const c = this.inputCanvas;
    if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
    this.inputCtx.drawImage(v, 0, 0, w, h);
    this.inputSize = { w, h };
    return c;
  }

  _aspect() {
    const s = this.source;
    return s.width && s.height ? s.width / s.height : 16 / 9;
  }

  /** Olvida todo el estado temporal (pistas, velocidades, zonas ocupadas…). */
  resetTemporal(reason, silent = false) {
    this.gen++;
    this.sceneVersion++;
    for (const tr of Object.values(this.trackers)) tr.reset();
    this.zones.resetState();
    this.scene.persons = [];
    this.scene.objects = [];
    this.scene.hands = [];
    this.scene.faces = [];
    this.scene.distances = [];
    this.scene.tentative = [];
    this.scene.motion = null;
    this.scene.personSource = null;
    const m = this.get('motion');
    if (m && m.reset) m.reset();
    this.motionStats = freshMotionStats();
    this.recog = freshRecog();
    this.lastT = null;
    this.adaptive.hold(1500);
    if (!silent) this.log.add('system', 'sistema', `Reinicio del seguimiento (${reason})`);
  }

  // ---------------------------------------------------------------------------
  // Resultados
  // ---------------------------------------------------------------------------

  _onResult(result, frame, det) {
    if (frame.gen !== this.gen || !det.enabled) return; // resultado obsoleto
    this.sceneVersion++;
    switch (det.id) {
      case 'pose': this._onPose(result, frame); break;
      case 'objects': this._onObjects(result, frame); break;
      case 'hands': this._onHands(result, frame); break;
      case 'face': this._onFaces(result, frame); break;
      case 'motion': this._onMotion(result, frame); break;
      case 'classifier': this._onClassify(result, frame); break;
      default: break;
    }
  }

  /**
   * Marca de reloj real de la última vez que el tracker EMPAREJÓ cada pista.
   * El Renderer muestra siempre las pistas vistas en la última actualización
   * de su tracker y oculta las "en reserva" que llevan > 1,2 s sin verse (el
   * Tracker las conserva para no perder el ID si reaparecen).
   */
  _stamp(tracks) {
    const now = performance.now();
    for (const tr of tracks) if (tr.seenNow) tr.lastSeenWall = now;
  }

  _onError(e, det) {
    console.warn(`[${det.id}]`, e);
    if (det.consecutiveErrors === 1) this.log.add('error', 'sistema', `Error en ${det.letter} · ${det.name}: ${det.lastError}`);
    if (det.consecutiveErrors >= 5) {
      det.setStatus('error', det.lastError);
      this._clearModule(det.id);
      this.log.add('error', 'sistema', `${det.letter} · ${det.name} desactivado tras 5 errores seguidos. Usa «Reintentar» en el panel de modelos.`);
      this.emit('detector', det);
    }
  }

  _poseActive() {
    const p = this.get('pose');
    return !!(p && p.enabled && p.ready);
  }

  _onPose(persons, frame) {
    const aspect = this._aspect();
    const minVis = this.settings.get('pose.minVis');
    this.scene.personSource = 'pose';
    if (!this.settings.get('derived.tracking')) {
      this.trackers.person.reset();
      this.scene.persons = persons.map((p) => untracked('person', p, poseFeatures(p.landmarks, p.world, aspect, minVis)));
      this.scene.distances = [];
      return;
    }
    const dets = persons.map((p) => ({ bbox: p.bbox, ref: footPoint(p.landmarks, p.bbox, minVis), score: p.score, data: p }));
    const { tracks, created, removed } = this.trackers.person.update(dets, frame.t);
    for (const tr of created) {
      this.unique.persons.add(tr.id);
      this.log.add('info', 'pose', `Persona #${tr.id} detectada`, { id: tr.id }, frame.media);
    }
    for (const tr of removed) {
      if (tr.lastSeen - tr.firstSeen > 1) this.log.add('info', 'pose', `Persona #${tr.id} sale de escena`, { id: tr.id }, frame.media);
    }
    const cfg = this._poseCfg();
    for (const tr of tracks) {
      if (!tr.seenNow) continue;
      tr.features = poseFeatures(tr.data.landmarks, tr.data.world, aspect, minVis);
      const st = tr.state.pose || (tr.state.pose = new PoseState());
      for (const e of st.update(tr.features, frame.t, cfg)) this._poseEvent(tr, e, frame);
    }
    this.scene.persons = tracks;
    this._stamp(tracks);
    this._collectTentative();
    this._spatial(frame);
    this._distances(frame);
  }

  /**
   * Detecciones que aún no tienen ID (pista tentativa, primer avistamiento):
   * se DIBUJAN para que la respuesta visual sea inmediata, pero no cuentan en
   * contadores, zonas, líneas ni alertas hasta confirmarse. Con el filtro
   * anti-fantasmas, un objeto sin confirmar sólo se dibuja si es muy claro.
   */
  _collectTentative() {
    const strict = this.settings.get('precision.strict');
    const minObj = strict ? 0.75 : 0;
    const minPerson = strict && this.scene.personSource === 'objects' ? 0.75 : 0;
    const pick = (tr, min) => tr.tracks.filter((t) => !t.confirmed && t.seenNow && (t.score ?? 1) >= min);
    this.scene.tentative = [...pick(this.trackers.person, minPerson), ...pick(this.trackers.object, minObj)];
  }

  _poseCfg() {
    const S = this.settings;
    return {
      activity: S.get('derived.activity'),
      fall: S.get('derived.fall'),
      immobility: S.get('derived.immobility'),
      fallSensitivity: S.get('alert.fallSensitivity'),
      fallConfirmSec: S.get('alert.fallConfirmSec'),
      immobilitySeconds: S.get('alert.immobilitySec'),
      immobilitySensitivity: S.get('alert.immobilitySensitivity'),
    };
  }

  _poseEvent(tr, e, frame) {
    const who = `Persona #${tr.id}`;
    const m = frame.media;
    const id = tr.id;
    switch (e.type) {
      case 'posture':
        this.log.add('info', 'pose', `${who} — postura: ${POSTURE_LABEL[e.value]}`, { id, postura: e.value }, m);
        break;
      case 'walking':
        this.log.add('info', 'pose', e.value ? `${who} — caminando` : `${who} — se detiene`, { id, caminando: e.value }, m);
        break;
      case 'arms_up':
        if (e.value) this.log.add('info', 'pose', `${who} — brazos en alto`, { id }, m);
        break;
      case 'fall_candidate':
        this.log.add('warn', 'pose', `${who} — posible caída en evaluación (confirmación ${this.settings.get('alert.fallConfirmSec')} s)…`, { id, bajada: +e.peakV.toFixed(2) }, m);
        break;
      case 'fall_confirmed':
        this.alerts.raise({ key: `fall:${id}`, type: 'fall', message: `⚠ Posible caída — ${who}`, track: tr, data: { id, velocidadBajada: +e.peakV.toFixed(2), inclinacionTorso: Math.round(e.tilt) }, media: m, cooldown: 10 });
        break;
      case 'fall_cancelled':
        this.log.add('info', 'pose', `${who} — caída descartada (se ha recuperado)`, { id }, m);
        break;
      case 'fall_recovered':
        this.log.add('info', 'pose', `${who} se ha levantado`, { id }, m);
        break;
      case 'immobile':
        this.alerts.raise({ key: `immobile:${id}`, type: 'immobility', message: `⚠ Inmovilidad prolongada — ${who} (${Math.round(e.seconds)} s sin moverse)`, track: tr, data: { id, segundos: Math.round(e.seconds) }, media: m, cooldown: 2 });
        break;
      case 'immobile_end':
        this.log.add('info', 'pose', `${who} vuelve a moverse tras ${Math.round(e.seconds)} s quieta`, { id, segundos: Math.round(e.seconds) }, m);
        break;
      default:
        break;
    }
  }

  _onObjects(objs, frame) {
    const S = this.settings;
    const poseActive = this._poseActive();
    // Filtro anti-fantasmas: umbral por clase, tamaño, forma y duplicados.
    const f = filterDetections(objs, {
      minScore: S.get('objects.minScore'),
      minAreaPct: S.get('objects.minArea'),
      strict: S.get('precision.strict'),
      aspect: this._aspect(),
      floor: OBJECT_FLOOR,
    });
    this.filtered += f.dropped;
    const persons = [], others = [];
    for (const o of [...f.strong.slice(0, S.get('objects.maxResults')), ...f.weak]) (o.classId === 1 ? persons : others).push(o);

    if (!S.get('derived.tracking')) {
      // Sin tracking no hay doble umbral: sólo se muestran las detecciones fuertes.
      this.trackers.object.reset();
      this.scene.objects = others.filter((o) => !o.weak).map((o) => untracked('object', o));
      if (!poseActive) {
        this.trackers.person.reset();
        this.scene.personSource = 'objects';
        this.scene.persons = persons.filter((o) => !o.weak).map((o) => untracked('person', o));
      }
      return;
    }

    const r = this.trackers.object.update(others.map((o) => ({ bbox: o.bbox, cls: o.label, label: o.label, score: o.score, data: o, weak: o.weak })), frame.t);
    for (const tr of r.created) {
      this.unique.objects.add(tr.id);
      this.log.add('info', 'objetos', `Objeto '${tr.label}' ID #${tr.id} rastreado`, { id: tr.id, clase: tr.label, confianza: +tr.score.toFixed(2) }, frame.media);
    }
    for (const tr of r.removed) {
      if (tr.lastSeen - tr.firstSeen > 3) this.log.add('info', 'objetos', `Objeto '${objLabel(tr)}' ID #${tr.id} fuera de escena`, { id: tr.id, clase: objLabel(tr) }, frame.media);
    }
    this.scene.objects = r.tracks;
    this._stamp(r.tracks);

    // Sin módulo de pose activo, las personas salen del detector de objetos (clase 1).
    if (!poseActive) {
      if (this.scene.personSource !== 'objects') {
        this.trackers.person.reset();
        this.scene.personSource = 'objects';
      }
      const pr = this.trackers.person.update(persons.map((o) => ({ bbox: o.bbox, score: o.score, data: { bbox: o.bbox, score: o.score }, weak: o.weak })), frame.t);
      for (const tr of pr.created) {
        this.unique.persons.add(tr.id);
        this.log.add('info', 'objetos', `Persona #${tr.id} detectada (detector de objetos)`, { id: tr.id }, frame.media);
      }
      if (this.settings.get('derived.immobility')) {
        const a = this._aspect();
        const S = this.settings;
        for (const tr of pr.tracks) {
          if (!tr.seenNow) continue;
          const st = tr.state.still || (tr.state.still = new StillnessMeter());
          const b = tr.bbox;
          const pts = [{ x: b.x * a, y: b.y }, { x: (b.x + b.w) * a, y: b.y }, { x: b.x * a, y: b.y + b.h }, { x: (b.x + b.w) * a, y: b.y + b.h }];
          const evs = st.update(pts, b.h * 0.35, frame.t, { seconds: S.get('alert.immobilitySec'), threshold: bySensitivity(S.get('alert.immobilitySensitivity'), 0.35, 0.05) });
          for (const e of evs) this._poseEvent(tr, e, frame);
        }
      }
      this.scene.persons = pr.tracks;
      this._stamp(pr.tracks);
      this._distances(frame);
    }
    this._collectTentative();
    this._spatial(frame);
  }

  _onHands(hands, frame) {
    const aspect = this._aspect();
    const swap = this.settings.get('hands.swap');
    const fingers = this.settings.get('derived.fingers');
    const { tracks } = this.trackers.hand.update(hands.map((h) => ({ bbox: h.bbox, data: h })), frame.t);
    for (const tr of tracks) {
      if (!tr.seenNow) continue;
      const h = tr.data;
      let side = h.handedness === 'Left' ? 'izquierda' : 'derecha';
      if (swap) side = side === 'izquierda' ? 'derecha' : 'izquierda';
      // Votación temporal: la lateralidad no cambia por un frame dudoso.
      const sv = tr.state.side || (tr.state.side = new StableLabel(0.3));
      sv.update(side, frame.t);
      if (sv.value == null) sv.value = side;
      side = sv.value;
      const g = fingers ? classifyHand(h.landmarks, h.world, aspect) : null;
      const owner = this._handOwner(h);
      tr.view = { side, gesture: g ? g.gesture : null, label: g ? g.label : null, count: g ? g.count : null, owner };
      if (g) {
        const st = tr.state.gesture || (tr.state.gesture = new StableLabel(0.45));
        if (st.update(g.label, frame.t)) {
          const who = owner ? `Persona #${owner} — mano ${side}` : `Mano ${side}`;
          this.log.add('info', 'manos', `${who}: ${g.label}`, { mano: side, gesto: g.gesture, dedos: g.count, persona: owner }, frame.media);
        }
      }
    }
    this.scene.hands = tracks;
    this._stamp(tracks);
  }

  /** Persona dueña de una mano: la de la muñeca (pose) más cercana. */
  _handOwner(h) {
    if (this.scene.personSource !== 'pose') return null;
    const w = h.landmarks[0];
    let best = null, bd = 0.08;
    for (const p of this.scene.persons) {
      const lm = p.data && p.data.landmarks;
      if (!lm || p.id <= 0) continue;
      for (const i of [15, 16]) {
        const q = lm[i];
        if ((q.visibility ?? 1) < 0.3) continue;
        const d = Math.hypot(q.x - w.x, q.y - w.y);
        if (d < bd) { bd = d; best = p.id; }
      }
    }
    return best;
  }

  _onFaces(faces, frame) {
    const aspect = this._aspect();
    const metricsOn = this.settings.get('derived.faceMetrics');
    const { tracks } = this.trackers.face.update(faces.map((f) => ({ bbox: f.bbox, data: f })), frame.t);
    const cfg = { eyeRatio: this.settings.get('alert.eyeRatio'), drowsySec: this.settings.get('alert.drowsySec') };
    for (const tr of tracks) {
      if (!tr.seenNow) continue;
      tr.metrics = faceMetrics(tr.data.landmarks, tr.data.matrix, aspect);
      if (!metricsOn) continue;
      const st = tr.state.face || (tr.state.face = new FaceState());
      for (const e of st.update(tr.metrics, frame.t, cfg)) this._faceEvent(tr, e, frame);
      const gz = tr.state.gaze || (tr.state.gaze = new StableLabel(1.5));
      if (gz.update(gazeLabel(tr.metrics), frame.t)) {
        this.log.add('info', 'rostro', `Rostro #${tr.id} — mira ${gz.value}`, { id: tr.id, giro: Math.round(tr.metrics.yaw), inclinacion: Math.round(tr.metrics.pitch) }, frame.media);
      }
    }
    this.scene.faces = tracks;
    this._stamp(tracks);
  }

  _faceEvent(tr, e, frame) {
    const who = `Rostro #${tr.id}`;
    const m = frame.media;
    switch (e.type) {
      case 'drowsy':
        this.alerts.raise({ key: `drowsy:${tr.id}`, type: 'drowsiness', message: `⚠ Posible somnolencia — ${who} (ojos cerrados ${e.dur.toFixed(1)} s)`, track: tr, data: { id: tr.id, segundos: +e.dur.toFixed(1) }, media: m, cooldown: 8 });
        break;
      case 'drowsy_end':
        this.log.add('info', 'rostro', `${who} abre los ojos tras ${e.dur.toFixed(1)} s`, { id: tr.id }, m);
        break;
      case 'yawn':
        this.log.add('warn', 'rostro', `${who} — bostezo`, { id: tr.id }, m);
        break;
      case 'smile':
        if (e.value) this.log.add('info', 'rostro', `${who} — sonríe`, { id: tr.id }, m);
        break;
      default:
        break; // parpadeos y boca abierta sólo se muestran en el panel (hablar los dispara sin parar)
    }
  }

  _onMotion(r, frame) {
    this.scene.motion = r;
    // Anomalía: puntuación z de la energía frente a su media/varianza
    // exponenciales (τ ≈ 8 s). Un pico muy por encima de lo habitual en la
    // escena (entrada brusca, objeto que cae, cambio de luz) dispara la alerta.
    const ms = this.motionStats;
    const e = r.energy;
    const dt = ms.lastT == null ? 0 : Math.max(0, frame.t - ms.lastT);
    ms.lastT = frame.t;
    ms.history.push(e);
    if (ms.history.length > 120) ms.history.shift();
    ms.n++;
    if (ms.n === 1) { ms.mean = e; ms.var = 0.0004; return; }
    const z = (e - ms.mean) / (Math.sqrt(ms.var) + 0.01);
    ms.z = z;
    const thr = bySensitivity(this.settings.get('alert.motionSensitivity'), 7, 2.5);
    if (this.settings.get('motion.anomaly') && ms.n > 20 && z > thr && e > 0.05) {
      this.alerts.raise({ key: 'motion', type: 'motion', message: `⚠ Anomalía de movimiento: actividad brusca (${Math.round(e * 100)} % de la imagen)`, data: { energia: +e.toFixed(3), z: +z.toFixed(1) }, media: frame.media, cooldown: 10 });
    }
    const a = emaAlpha(dt, 8);
    const d = e - ms.mean;
    ms.mean += a * d;
    ms.var = (1 - a) * (ms.var + a * d * d);
  }

  // ---------------------------------------------------------------------------
  // Módulo F: reconocimiento de 1000 cosas
  // ---------------------------------------------------------------------------

  /**
   * Regiones que clasificará el módulo F en esta ejecución, por prioridad:
   * visor central (siempre), escena completa (una de cada tres ejecuciones) y
   * objetos seguidos por turnos (el que lleva más tiempo sin clasificarse
   * primero). En el hilo principal (sin workers) se clasifican menos regiones
   * por ejecución para no restar FPS de render.
   */
  _classifierRois(det, frame) {
    const S = this.settings;
    const A = this._aspect();
    const rec = this.recog;
    const max = det.isWorker ? 3 : 1;
    rec.run++;
    const out = [];
    if (S.get('classifier.reticle')) out.push({ key: 'reticle', roi: reticleRoi(A) });
    if (S.get('classifier.scene') && (rec.run % 3 === 1 || !out.length)) out.push({ key: 'scene', roi: null });
    const obj = this.get('objects');
    if (S.get('classifier.refine') && obj && obj.enabled && obj.ready) {
      const cands = this.scene.objects
        .filter((o) => o.id > 0 && o.seenNow && o.bbox.w * o.bbox.h >= 0.005)
        .sort((a, b) => (a.state.fineAt ?? -1) - (b.state.fineAt ?? -1));
      for (const o of cands) {
        if (out.length >= max) break;
        o.state.fineAt = frame.index;
        out.push({ key: `obj:${o.id}`, roi: squareRoi(o.bbox, A, 1.15) });
      }
    }
    return out.slice(0, max);
  }

  _onClassify(res, frame) {
    const rec = this.recog;
    const minScore = this.settings.get('classifier.minScore');
    for (const it of res.items || []) {
      if (it.key === 'scene') {
        rec.scene.update(it.cats, frame.t);
      } else if (it.key === 'reticle') {
        rec.reticle.update(it.cats, frame.t);
        const top = rec.reticle.top(1)[0];
        const idx = top && top.s >= minScore ? top.i : null;
        // Se anota en el registro cuando el visor "se decide" por algo nuevo.
        if (rec.reticleLabel.update(idx, frame.t) && idx != null) {
          this.log.add('info', 'escaner', `◎ Escáner: ${IMAGENET_ES[idx]} (${Math.round(top.s * 100)} %)`, { cosa: IMAGENET_ES[idx], confianza: +top.s.toFixed(2) }, frame.media);
        }
      } else if (it.key.startsWith('obj:')) {
        const id = Number(it.key.slice(4));
        const tr = this.trackers.object.tracks.find((x) => x.id === id);
        if (!tr) continue;
        const sm = tr.state.fine || (tr.state.fine = new ScoreSmoother({ window: 5 }));
        sm.update(it.cats, frame.t);
        this._refineObject(tr, minScore, frame);
      }
    }
  }

  /**
   * Etiqueta fina de un objeto («perro» → «golden retriever») y, con el filtro
   * anti-fantasmas, corrección de la clase del detector cuando el clasificador
   * la contradice con claridad (perro ↔ gato, coche ↔ camión…).
   */
  _refineObject(tr, minScore, frame) {
    const sm = tr.state.fine;
    const ranked = sm.top(20);
    const top = ranked[0];
    // Etiqueta fina: la clase concreta más probable, si es lo bastante segura.
    tr.fine = top && top.s >= minScore ? { label: IMAGENET_ES[top.i], score: top.s, coco: imagenetToCoco(top.i) } : null;
    if (tr.fine) {
      const st = tr.state.fineLabel || (tr.state.fineLabel = new StableLabel(1));
      if (st.update(tr.fine.label, frame.t)) {
        this.log.add('info', 'escaner', `◎ Objeto '${objLabel(tr)}' #${tr.id}: ${tr.fine.label} (${Math.round(top.s * 100)} %)`, { id: tr.id, clase: objLabel(tr), detalle: tr.fine.label, confianza: +top.s.toFixed(2) }, frame.media);
      }
    }
    // Corrección por GRUPO: se suman las clases finas de cada categoría COCO
    // (todas las razas de perro, todos los gatos…). Así «gato egipcio 30 % +
    // gato atigrado 20 %» cuenta como «gato 50 %» frente al «perro» del detector.
    const groups = new Map();
    for (const { i, s } of ranked) {
      const g = imagenetToCoco(i);
      if (g) groups.set(g, (groups.get(g) || 0) + s);
    }
    let best = null, bestS = 0;
    for (const [g, s] of groups) if (s > bestS) { best = g; bestS = s; }
    const own = groups.get(tr.label) || 0;
    const contradicts = !!best && best !== tr.label && CORRECTABLE.has(tr.label) && bestS >= 0.3 && bestS > own + 0.15;
    if (this.settings.get('precision.strict') && contradicts && sm.n >= 2) {
      if (tr.display !== best) {
        tr.display = best;
        const why = tr.fine ? `${tr.fine.label} ${Math.round(tr.fine.score * 100)} %` : `${Math.round(bestS * 100)} %`;
        this.log.add('warn', 'escaner', `Objeto #${tr.id}: «${tr.label}» corregido a «${best}» (${why})`, { id: tr.id, antes: tr.label, despues: best, confianza: +bestS.toFixed(2) }, frame.media);
      }
    } else if (tr.display && !contradicts) {
      tr.display = null;
    }
  }

  /**
   * Zonas de intrusión y tripwires. Se pasan SIEMPRE todas las pistas vivas
   * (personas y, si procede, objetos): una pista ausente se interpreta como
   * "perdida de vista", así que no se puede evaluar sólo un subconjunto.
   */
  _spatial(frame) {
    if (!this.zones.zones.length && !this.zones.lines.length) return;
    const tracks = this.settings.get('alert.zoneTargets') === 'all' ? [...this.scene.persons, ...this.scene.objects] : this.scene.persons;
    const evs = this.zones.update(tracks.filter((t) => t.id > 0), frame.t, {
      dwellSec: this.settings.get('alert.zoneDwellSec'),
      zones: this.settings.get('derived.zones'),
      lines: this.settings.get('derived.tripwires'),
    });
    for (const e of evs) {
      const tr = e.track;
      const desc = describeTrack(tr);
      const tipo = tr.kind === 'person' ? 'persona' : `objeto '${objLabel(tr)}'`;
      if (e.type === 'zone_enter') {
        this.alerts.raise({ key: `intrusion:${e.zone.id}:${tr.kind}:${tr.id}`, type: 'intrusion', message: `⚠ Intrusión en ${e.zone.name} — ID #${tr.id} (${tipo})`, track: tr, data: { zona: e.zone.name, id: tr.id, tipo }, media: frame.media, cooldown: 0 });
      } else if (e.type === 'zone_exit') {
        this.log.add('info', 'zona', `${desc} sale de ${e.zone.name} (${e.dwell.toFixed(1)} s dentro${e.lost ? ', perdida de vista' : ''})`, { zona: e.zone.name, id: tr.id, segundos: +e.dwell.toFixed(1) }, frame.media);
      } else if (e.type === 'cross') {
        this.log.add('info', 'linea', `↔ Cruce en ${e.line.name}: ${e.dir === 'in' ? 'entrada' : 'salida'} — ${desc} (entradas ${e.line.countIn} · salidas ${e.line.countOut})`, { linea: e.line.name, sentido: e.dir === 'in' ? 'entrada' : 'salida', id: tr.id, entradas: e.line.countIn, salidas: e.line.countOut }, frame.media);
      }
    }
  }

  /** Distancia entre personas en el plano de imagen (píxeles de la fuente). */
  _distances(frame) {
    this.scene.distances = [];
    if (!this.settings.get('derived.distances')) return;
    const P = this.scene.persons.filter((p) => p.id > 0 && p.seenNow);
    const vw = this.source.width || 1, vh = this.source.height || 1;
    const thr = this.settings.get('alert.proximity');
    for (let i = 0; i < P.length; i++) {
      for (let j = i + 1; j < P.length; j++) {
        const a = P[i].ref, b = P[j].ref;
        const px = Math.hypot((a.x - b.x) * vw, (a.y - b.y) * vh);
        const hRef = ((P[i].bbox.h + P[j].bbox.h) / 2) * vh;
        const rel = px / Math.max(1, hRef);
        const close = rel < thr;
        this.scene.distances.push({ a, b, px, rel, close, ids: [P[i].id, P[j].id] });
        if (close && this.settings.get('alert.proximityAlert')) {
          const [x, y] = [P[i].id, P[j].id].sort((m, n) => m - n);
          this.alerts.raise({ key: `prox:${x}-${y}`, type: 'proximity', message: `⚠ Proximidad: Persona #${x} y Persona #${y} (${rel.toFixed(1)} alturas, ${Math.round(px)} px)`, data: { ids: [x, y], px: Math.round(px), alturas: +rel.toFixed(2) }, media: frame.media, cooldown: 15 });
        }
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Ajustes en caliente
  // ---------------------------------------------------------------------------

  _onSetting({ key, value }) {
    this.settingsVersion++;
    const m = key.match(/^(\w+)\.enabled$/);
    if (m && this.detectors.has(m[1])) {
      const d = this.detectors.get(m[1]);
      d.enabled = value;
      if (!value) this._clearModule(m[1]);
      this.log.add('system', 'sistema', `Módulo ${d.letter} · ${d.name} ${value ? 'activado' : 'desactivado'}`);
      if (this.source.ready && this.source.paused) this.requestAnalysis();
      return;
    }
    const c = key.match(/^perf\.cadence\.(\w+)$/);
    if (c && this.detectors.has(c[1])) { this.detectors.get(c[1]).cadence = value; return; }
    if (key === 'precision.strict') this._applyStrict(value);
    if (key === 'alert.sound') this.alerts.sound = value;
    if (key === 'derived.tracking') this.resetTemporal(value ? 'tracking activado' : 'tracking desactivado');
    if (key === 'perf.adaptive' && !value) this.adaptive.reset();
    if (this.source.ready && this.source.paused) this.requestAnalysis();
  }

  /** Olvida el estado de un módulo (al desactivarlo o cambiar de modelo). */
  clearModule(id) { this._clearModule(id); }

  _clearModule(id) {
    this.sceneVersion++;
    switch (id) {
      case 'pose':
        this.trackers.person.reset();
        this.scene.persons = [];
        this.scene.personSource = null;
        break;
      case 'objects':
        this.trackers.object.reset();
        this.scene.objects = [];
        if (this.scene.personSource === 'objects') {
          this.trackers.person.reset();
          this.scene.persons = [];
          this.scene.personSource = null;
        }
        break;
      case 'hands':
        this.trackers.hand.reset();
        this.scene.hands = [];
        break;
      case 'face':
        this.trackers.face.reset();
        this.scene.faces = [];
        break;
      case 'motion':
        this.scene.motion = null;
        this.scene.motionCanvas = null;
        if (this.get('motion')) this.get('motion').reset();
        break;
      case 'classifier':
        this.recog = freshRecog();
        for (const o of this.trackers.object.tracks) { o.fine = null; o.display = null; delete o.state.fine; delete o.state.fineLabel; }
        break;
      default:
        break;
    }
    this.scene.distances = [];
    this.scene.tentative = this.scene.tentative.filter((t) => (t.kind === 'person' ? this.scene.personSource : this.get('objects') && this.get('objects').enabled));
  }

  // ---------------------------------------------------------------------------
  // Render y estadísticas
  // ---------------------------------------------------------------------------

  _mirrorWanted() {
    const pref = this.settings.get('view.mirror');
    return pref === 'on' || (pref === 'auto' && this.source.kind === 'webcam');
  }

  renderOptions() {
    const S = this.settings;
    const tracking = S.get('derived.tracking');
    const layers = {
      pose: S.get('pose.enabled'),
      hands: S.get('hands.enabled'),
      face: S.get('face.enabled'),
      objects: S.get('objects.enabled'),
      heatmap: S.get('motion.enabled') && S.get('motion.heatmap'),
      zones: S.get('derived.zones'),
      lines: S.get('derived.tripwires'),
      trails: S.get('derived.trails') && tracking,
      distances: S.get('derived.distances') && tracking,
      labels: S.get('view.labels'),
      hud: S.get('view.hud'),
    };
    const alertTracks = new Set(this.alerts.active.filter((a) => a.trackId != null).map((a) => `${a.kind}:${a.trackId}`));
    const cls = this.get('classifier');
    let reticle = null;
    if (cls && cls.enabled && cls.ready && S.get('classifier.reticle') && this.source.ready) {
      const top = this.recog.reticle.top(1)[0];
      const ok = top && top.s >= S.get('classifier.minScore');
      reticle = { roi: reticleRoi(this._aspect()), label: ok ? IMAGENET_ES[top.i] : null, score: ok ? top.s : 0, waiting: !this.recog.reticle.n };
    }
    return {
      hasSource: this.source.ready,
      layers,
      reticle,
      zones: this.zones,
      editor: this.editor,
      alerts: this.alerts.active,
      alertTracks,
      connections: this.connections,
      settings: S.values,
      hud: this.source.ready ? this._hudText() : null,
      now: performance.now(),
      paused: this.source.paused,
    };
  }

  _render() {
    const src = this.source;
    const mirror = this._mirrorWanted();
    if (mirror !== this.mirror) {
      this.mirror = mirror;
      this.emit('mirror', mirror);
    }
    this.renderer.setFrame(src.width, src.height, mirror);
    const md = this.get('motion');
    this.scene.motionCanvas = this.settings.get('motion.heatmap') && md && md.enabled && this.scene.motion ? md.paintHeat() : null;
    // El overlay sólo se repinta si cambia algo visible (resultados nuevos,
    // ajustes, tamaño, reloj del HUD, zonas, alertas o edición). El bucle y el
    // vídeo siguen a su ritmo; se ahorra trabajo de pintado redundante.
    const c = this.renderer.canvas;
    const hud = this.settings.get('view.hud') && src.ready ? (src.kind === 'file' ? Math.floor(src.el.currentTime * 10) : Math.floor(Date.now() / 1000)) : 0;
    const sig = `${this.sceneVersion}|${this.settingsVersion}|${this.zones.version}|${c.width}x${c.height}|${mirror}|${src.ready}|${src.width}x${src.height}|${hud}|${this.alerts.active.length}|${Math.floor(performance.now() / 500)}`;
    const animating = this.alerts.active.length > 0 || !!this.editor.mode || !!this.editor.selected;
    if (!animating && sig === this._lastSig) { this.skippedDraws++; return; }
    this._lastSig = sig;
    this.renderer.draw(this.scene, this.renderOptions());
  }

  /** Fuerza el repintado del overlay en el próximo frame. */
  markDirty() { this.sceneVersion++; }

  _hudText() {
    const s = this.source;
    const d = new Date();
    const ts = d.toLocaleDateString('es-ES') + ' ' + d.toLocaleTimeString('es-ES');
    let left = `${ts} · ${KIND_LABEL[s.kind] || ''} ${s.width}×${s.height}`;
    if (s.kind === 'file') left += ` · ${fmtClock(s.el.currentTime)}`;
    const c = this.scene;
    const right = `PERS ${c.persons.filter((p) => p.seenNow).length} · OBJ ${c.objects.filter((o) => o.seenNow).length} · MANOS ${c.hands.filter((h) => h.seenNow).length} · ROSTROS ${c.faces.filter((f) => f.seenNow).length}`;
    return { left, right };
  }

  /** Capta el fotograma actual con overlay (PNG a resolución nativa). */
  snapshot() {
    return this.renderer.exportPNG(this.source.el, this.scene, this.renderOptions());
  }

  stats(now = performance.now()) {
    const S = this.settings;
    const sc = this.scene;
    const dets = [...this.detectors.values()].map((d) => ({
      id: d.id, letter: d.letter, name: d.name, status: d.status, detail: d.statusDetail, backend: d.backend,
      enabled: d.enabled, latency: d.latency.value, sync: d.syncCost.value, hz: d.rate.rate(now),
      cadence: d.cadence, effCadence: Math.max(1, Math.round(d.cadence * this.adaptive.multiplier)), errors: d.totalErrors,
    }));
    const handsSeen = sc.hands.filter((h) => h.seenNow);
    const classes = new Map();
    for (const o of sc.objects) if (o.seenNow) classes.set(objLabel(o), (classes.get(objLabel(o)) || 0) + 1);
    const minRec = S.get('classifier.minScore');
    const named = (list) => list.map(({ i, s }) => ({ label: IMAGENET_ES[i], score: s }));
    const recog = {
      reticle: S.get('classifier.reticle') ? named(this.recog.reticle.top(3)) : null,
      scene: S.get('classifier.scene') ? named(this.recog.scene.top(5)) : null,
      objects: sc.objects.filter((o) => o.id > 0 && o.fine).slice(0, 8)
        .map((o) => ({ id: o.id, color: o.color, label: objLabel(o), corrected: !!o.display, from: o.label, fine: o.fine.label, score: o.fine.score })),
      minScore: minRec,
    };
    return {
      renderFps: this.renderRate.rate(now),
      analysisFps: this.analysisRate.rate(now),
      frameWork: this.frameWork.value,
      level: this.adaptive.level,
      scale: this.adaptive.scale,
      mult: this.adaptive.multiplier,
      input: this.inputSize,
      detectors: dets,
      counts: {
        persons: sc.persons.filter((p) => p.seenNow).length,
        personsUnique: this.unique.persons.size,
        objects: sc.objects.filter((o) => o.seenNow).length,
        objectsUnique: this.unique.objects.size,
        hands: handsSeen.length,
        handsL: handsSeen.filter((h) => h.view && h.view.side === 'izquierda').length,
        handsR: handsSeen.filter((h) => h.view && h.view.side === 'derecha').length,
        faces: sc.faces.filter((f) => f.seenNow).length,
        classes: [...classes.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6),
        personSource: sc.personSource,
      },
      zones: this.zones.zones.map((z) => ({ id: z.id, name: z.name, color: z.color, occupancy: z.occupancy, entries: z.entries })),
      lines: this.zones.lines.map((l) => ({ id: l.id, name: l.name, in: l.countIn, out: l.countOut })),
      alerts: { total: this.alerts.total, byType: { ...this.alerts.counts } },
      motion: { energy: sc.motion ? sc.motion.energy : null, history: this.motionStats.history, z: this.motionStats.z ?? 0 },
      tf: this.tf && this.tf.memory ? this.tf.memory() : (this.get('objects') && this.get('objects').memory) || null,
      source: this.source.state,
      persons: sc.persons.filter((p) => p.id > 0 && p.state.pose).slice(0, 6).map((p) => {
        const st = p.state.pose;
        return {
          id: p.id, color: p.color, posture: st.posture, walking: st.walking, armsUp: st.armsUp,
          still: st.still.stillTime, fall: st.fall.state, angles: p.features ? p.features.angles : {},
        };
      }),
      faces: sc.faces.filter((f) => f.metrics).slice(0, 4).map((f) => {
        const st = f.state.face;
        return {
          id: f.id, ear: f.metrics.ear, mar: f.metrics.mar, yaw: f.metrics.yaw, pitch: f.metrics.pitch, roll: f.metrics.roll,
          gaze: gazeLabel(f.metrics), blinks: st ? st.blinkRate : 0, perclos: st ? st.perclos : 0,
          smiling: st ? st.smiling : false, closed: st ? st.closed : false, mouthOpen: st ? st.mouthOpen : false,
        };
      }),
      tracking: S.get('derived.tracking'),
      recog,
      filtered: this.filtered,
    };
  }
}

function freshMotionStats() {
  return { mean: 0, var: 0, n: 0, lastT: null, history: [], z: 0 };
}

/** Estado del módulo F: visor (responde en ~0,6 s) y escena (~1,5 s). */
function freshRecog() {
  return { reticle: new ScoreSmoother({ tau: 0.6 }), scene: new ScoreSmoother({ tau: 1.5 }), reticleLabel: new StableLabel(0.4), run: 0 };
}

/** Nombre mostrado de un objeto: el corregido por el módulo F, si lo hay. */
export function objLabel(tr) {
  return tr.display || tr.label;
}

/** Pseudo-pista para cuando el tracking está desactivado (sin ID ni estado). */
function untracked(kind, d, features) {
  return {
    id: 0, kind, cls: d.label || null, label: d.label || kind, bbox: d.bbox, ref: { x: d.bbox.x + d.bbox.w / 2, y: d.bbox.y + d.bbox.h },
    score: d.score, data: d, state: {}, seenNow: true, color: kind === 'person' ? '#94a3b8' : '#38bdf8', history: [], features,
  };
}

export function describeTrack(tr) {
  if (tr.kind === 'person') return `Persona #${tr.id}`;
  if (tr.kind === 'object') return `Objeto '${objLabel(tr)}' #${tr.id}`;
  return `#${tr.id}`;
}

function fmtClock(s) {
  if (!Number.isFinite(s)) return '--:--';
  const m = Math.floor(s / 60), r = s - m * 60;
  return `${String(m).padStart(2, '0')}:${r.toFixed(1).padStart(4, '0')}`;
}
