/**
 * PoseAnalytics.js — Inteligencia derivada de la pose (33 landmarks de
 * MediaPipe Pose): ángulos articulares, postura, marcha, brazos en alto,
 * heurística de caída e inmovilidad prolongada.
 *
 * TODO ES GEOMETRÍA sobre keypoints que ya produce el modelo de pose: no se
 * carga ningún peso adicional.
 *
 * Unidades: las posiciones se pasan a "unidades de alto" (x × aspecto, y) y las
 * velocidades se normalizan por la LONGITUD DEL TORSO (hombros↔caderas) de esa
 * persona, en "torsos por segundo" (TL/s). Así los umbrales valen igual para
 * alguien cerca o lejos de la cámara.
 *
 * AVISO: heurísticas aproximadas. La detección de caídas e inmovilidad NO es
 * apta para uso médico, de teleasistencia ni de seguridad crítica: producirá
 * falsos positivos (tumbarse a propósito, agacharse rápido) y falsos negativos
 * (caídas lentas, oclusiones, cámara mal orientada).
 */
import { angleAt, mid, bboxOf, clamp, lerp, emaAlpha, RAD2DEG } from './geometry.js';

export const PL = {
  NOSE: 0, LEFT_EYE_INNER: 1, LEFT_EYE: 2, LEFT_EYE_OUTER: 3, RIGHT_EYE_INNER: 4,
  RIGHT_EYE: 5, RIGHT_EYE_OUTER: 6, LEFT_EAR: 7, RIGHT_EAR: 8, MOUTH_LEFT: 9,
  MOUTH_RIGHT: 10, LEFT_SHOULDER: 11, RIGHT_SHOULDER: 12, LEFT_ELBOW: 13,
  RIGHT_ELBOW: 14, LEFT_WRIST: 15, RIGHT_WRIST: 16, LEFT_PINKY: 17, RIGHT_PINKY: 18,
  LEFT_INDEX: 19, RIGHT_INDEX: 20, LEFT_THUMB: 21, RIGHT_THUMB: 22, LEFT_HIP: 23,
  RIGHT_HIP: 24, LEFT_KNEE: 25, RIGHT_KNEE: 26, LEFT_ANKLE: 27, RIGHT_ANKLE: 28,
  LEFT_HEEL: 29, RIGHT_HEEL: 30, LEFT_FOOT_INDEX: 31, RIGHT_FOOT_INDEX: 32,
};

/** Ángulos que se muestran sobre el esqueleto: [nombre, a, vértice, c]. */
export const JOINT_ANGLES = [
  ['codo izq.', PL.LEFT_SHOULDER, PL.LEFT_ELBOW, PL.LEFT_WRIST],
  ['codo der.', PL.RIGHT_SHOULDER, PL.RIGHT_ELBOW, PL.RIGHT_WRIST],
  ['hombro izq.', PL.LEFT_HIP, PL.LEFT_SHOULDER, PL.LEFT_ELBOW],
  ['hombro der.', PL.RIGHT_HIP, PL.RIGHT_SHOULDER, PL.RIGHT_ELBOW],
  ['cadera izq.', PL.LEFT_SHOULDER, PL.LEFT_HIP, PL.LEFT_KNEE],
  ['cadera der.', PL.RIGHT_SHOULDER, PL.RIGHT_HIP, PL.RIGHT_KNEE],
  ['rodilla izq.', PL.LEFT_HIP, PL.LEFT_KNEE, PL.LEFT_ANKLE],
  ['rodilla der.', PL.RIGHT_HIP, PL.RIGHT_KNEE, PL.RIGHT_ANKLE],
];

const KEY_JOINTS = [PL.NOSE, PL.LEFT_SHOULDER, PL.RIGHT_SHOULDER, PL.LEFT_ELBOW, PL.RIGHT_ELBOW,
  PL.LEFT_WRIST, PL.RIGHT_WRIST, PL.LEFT_HIP, PL.RIGHT_HIP, PL.LEFT_KNEE, PL.RIGHT_KNEE,
  PL.LEFT_ANKLE, PL.RIGHT_ANKLE];

export const POSTURE_LABEL = {
  de_pie: 'de pie',
  sentado: 'sentada',
  tumbado: 'tumbada',
  indeterminado: 'indeterminada',
};

const inside = (p) => p.x > -0.02 && p.x < 1.02 && p.y > -0.02 && p.y < 1.02;

/**
 * Extrae las características geométricas de una pose.
 * @param {Array<{x,y,z,visibility}>} lm landmarks normalizados (33)
 * @param {Array<{x,y,z}>|null} world landmarks 3D en metros (33) o null
 * @param {number} aspect ancho/alto del frame
 * @param {number} minVis visibilidad mínima para usar un punto
 */
export function poseFeatures(lm, world, aspect, minVis = 0.5) {
  const vis = (i) => lm[i] && (lm[i].visibility ?? 1) >= minVis && inside(lm[i]);
  // Las piernas exigen más confianza: en planos de medio cuerpo el modelo
  // "inventa" rodillas con visibilidad moderada y falsearía la postura.
  const legMin = Math.max(minVis, 0.65);
  const visLeg = (i) => lm[i] && (lm[i].visibility ?? 1) >= legMin && inside(lm[i]);
  const A = (i) => ({ x: lm[i].x * aspect, y: lm[i].y, z: 0 });
  const W = world && world.length === 33 ? (i) => world[i] : null;
  const pair = (l, r) => (vis(l) && vis(r) ? mid(A(l), A(r)) : vis(l) ? A(l) : vis(r) ? A(r) : null);

  const shoulderMid = pair(PL.LEFT_SHOULDER, PL.RIGHT_SHOULDER);
  const hipMid = pair(PL.LEFT_HIP, PL.RIGHT_HIP);
  const visible = [];
  for (let i = 0; i < lm.length; i++) if (vis(i)) visible.push(A(i));
  const box = bboxOf(visible);

  const f = {
    shoulderMid, hipMid, torso: false, torsoLen: null, torsoTilt: null,
    angles: {}, legs: [], legsVisible: false, bboxAspect: box ? box.w / Math.max(1e-6, box.h) : 1,
    armsUp: false, visibleCount: visible.length, joints: null,
  };

  // Ángulos articulares: se prefieren los landmarks 3D (no sufren el escorzo de
  // la perspectiva); si no hay, se usan los 2D corregidos por aspecto.
  for (const [name, a, b, c] of JOINT_ANGLES) {
    if (!(vis(a) && vis(b) && vis(c))) continue;
    const ang = W ? angleAt(W(a), W(b), W(c)) : angleAt(A(a), A(b), A(c));
    if (ang != null) f.angles[name] = ang;
  }

  if (shoulderMid && hipMid) {
    const tx = shoulderMid.x - hipMid.x, ty = shoulderMid.y - hipMid.y;
    const len = Math.hypot(tx, ty);
    if (len > 1e-4) {
      f.torso = true;
      f.torsoLen = len;
      // Inclinación del torso respecto a la vertical de la imagen:
      // 0° = erguido, 90° = horizontal (y crece hacia abajo).
      f.torsoTilt = Math.acos(clamp(-ty / len, -1, 1)) * RAD2DEG;
    }
  }

  // Piernas: para cada lado visible, ángulo de cadera/rodilla (3D si hay),
  // inclinación del muslo en la imagen y relación muslo/torso en 2D (un muslo
  // que apunta a la cámara, típico de alguien sentado de frente, se acorta).
  for (const [hip, knee, ankle, sh] of [
    [PL.LEFT_HIP, PL.LEFT_KNEE, PL.LEFT_ANKLE, PL.LEFT_SHOULDER],
    [PL.RIGHT_HIP, PL.RIGHT_KNEE, PL.RIGHT_ANKLE, PL.RIGHT_SHOULDER],
  ]) {
    if (!(visLeg(hip) && visLeg(knee))) continue;
    const H = A(hip), K = A(knee);
    const thighLen = Math.hypot(K.x - H.x, K.y - H.y);
    const leg = {
      ankle: visLeg(ankle),
      thighTilt: Math.acos(clamp((K.y - H.y) / Math.max(1e-6, thighLen), -1, 1)) * RAD2DEG,
      thighRatio: f.torsoLen ? thighLen / f.torsoLen : null,
      // Caída vertical cadera→tobillo en torsos: ~1,5 de pie, <1 sentado.
      ankleDrop: visLeg(ankle) && f.torsoLen ? (A(ankle).y - H.y) / f.torsoLen : null,
      hipAngle: vis(sh) ? (W ? angleAt(W(sh), W(hip), W(knee)) : angleAt(A(sh), H, K)) : null,
      kneeAngle: visLeg(ankle) ? (W ? angleAt(W(hip), W(knee), W(ankle)) : angleAt(H, K, A(ankle))) : null,
    };
    f.legs.push(leg);
  }
  f.legsVisible = f.legs.length > 0;

  // Brazos en alto: ambas muñecas claramente por encima de los hombros.
  if (f.torso && vis(PL.LEFT_WRIST) && vis(PL.RIGHT_WRIST)) {
    const m = 0.25 * f.torsoLen;
    const shY = Math.min(A(PL.LEFT_SHOULDER).y, A(PL.RIGHT_SHOULDER).y);
    f.armsUp = A(PL.LEFT_WRIST).y < shY - m && A(PL.RIGHT_WRIST).y < shY - m;
  }

  // Posiciones de articulaciones clave (para medir movimiento/inmovilidad).
  f.joints = KEY_JOINTS.map((i) => (vis(i) ? A(i) : null));
  return f;
}

/**
 * Clasificación de postura a partir de las características (por orden):
 *  1. tumbado: torso a más de 60° de la vertical (o silueta muy apaisada con
 *     torso inclinado).
 *  2. sentado (evidencia fuerte): en TODAS las piernas visibles el muslo está
 *     casi horizontal, muy acortado por perspectiva (sentado de frente) o con
 *     cadera y rodilla claramente flexionadas.
 *  3. de pie: alguna pierna estirada (rodilla > 140°) cuyo tobillo queda bien
 *     por debajo de la cadera (> 0,8 torsos) — cubre zancadas y posturas
 *     asimétricas (verificado con la imagen de prueba "warrior" de MediaPipe,
 *     también a baja resolución de inferencia).
 *  4. sentado (evidencia débil) o, en caso de duda, por la caída cadera→tobillo.
 */
export function classifyPosture(f) {
  if (!f.torso) return 'indeterminado';
  if (f.torsoTilt > 60 || (f.bboxAspect > 1.6 && f.torsoTilt > 40)) return 'tumbado';
  if (!f.legsVisible) return 'indeterminado';
  const strongSeated = (l) => (l.thighRatio != null && l.thighRatio < 0.45) || l.thighTilt > 65 ||
    (l.hipAngle != null && l.hipAngle < 120 && l.kneeAngle != null && l.kneeAngle < 130);
  const standingLeg = (l) => l.kneeAngle != null && l.kneeAngle > 140 && l.ankleDrop != null && l.ankleDrop > 0.8;
  const seatedLeg = (l) => (l.hipAngle != null && l.hipAngle < 130 && (l.kneeAngle == null || l.kneeAngle < 150)) || l.thighTilt > 55;
  if (f.legs.every(strongSeated)) return 'sentado';
  if (f.legs.some(standingLeg)) return 'de_pie';
  if (f.legs.every(seatedLeg)) return 'sentado';
  const drops = f.legs.filter((l) => l.ankleDrop != null).map((l) => l.ankleDrop);
  if (drops.length) return Math.max(...drops) > 1.0 ? 'de_pie' : 'sentado';
  const meanTilt = f.legs.reduce((s, l) => s + l.thighTilt, 0) / f.legs.length;
  return meanTilt > 45 ? 'sentado' : 'de_pie';
}

/** Mapea una sensibilidad 1..10 a un valor entre `lo` (1) y `hi` (10). */
export const bySensitivity = (s, lo, hi) => lerp(lo, hi, clamp((s - 1) / 9, 0, 1));

/**
 * Detector de inmovilidad reutilizable: mide cuánto se desplazan unos puntos
 * (suavizados con EMA para eliminar el temblor del modelo) en una ventana de
 * ~1 s, normalizado por una escala corporal. Acumula tiempo "quieto" y emite
 * eventos al superar el umbral y al volver a moverse.
 */
export class StillnessMeter {
  constructor() {
    this.smooth = null;
    this.ring = [];
    this.stillTime = 0;
    this.alerted = false;
    this.rate = null;
    this.lastT = null;
  }

  reset() { this.smooth = null; this.ring = []; this.stillTime = 0; this.alerted = false; this.rate = null; this.lastT = null; }

  /**
   * @param {Array<{x,y}|null>} points puntos (unidades de alto) o null si no visibles
   * @param {number} scale escala corporal (p. ej. longitud del torso)
   * @param {number} t segundos
   * @param {{seconds:number, threshold:number}} cfg umbral en escalas/s
   */
  update(points, scale, t, cfg) {
    const ev = [];
    const dt = this.lastT == null ? 0 : t - this.lastT;
    this.lastT = t;
    if (!this.smooth || this.smooth.length !== points.length) this.smooth = points.map((p) => (p ? { ...p } : null));
    const a = emaAlpha(dt, 0.35);
    for (let i = 0; i < points.length; i++) {
      const p = points[i];
      if (!p) continue;
      const s = this.smooth[i];
      if (!s) { this.smooth[i] = { x: p.x, y: p.y }; continue; }
      s.x += (p.x - s.x) * a;
      s.y += (p.y - s.y) * a;
    }
    // Anillo de muestras a ≥10 Hz con 3 s de historia.
    const last = this.ring[this.ring.length - 1];
    if (!last || t - last.t >= 0.1) this.ring.push({ t, pts: this.smooth.map((s) => (s ? { x: s.x, y: s.y } : null)) });
    while (this.ring.length && this.ring[0].t < t - 3) this.ring.shift();

    // Busca la muestra más cercana a hace 1 s.
    let ref = null;
    for (const r of this.ring) if (t - r.t >= 0.95) ref = r;
    if (ref && scale > 1e-4) {
      let sum = 0, n = 0;
      for (let i = 0; i < points.length; i++) {
        const s = this.smooth[i], q = ref.pts[i];
        if (!s || !q) continue;
        sum += Math.hypot(s.x - q.x, s.y - q.y);
        n++;
      }
      if (n >= 2) {
        this.rate = sum / n / ((t - ref.t) * scale);
        const still = this.rate < cfg.threshold;
        if (still) this.stillTime += Math.max(0, dt);
        else {
          if (this.alerted) ev.push({ type: 'immobile_end', seconds: this.stillTime });
          this.stillTime = 0;
          this.alerted = false;
        }
        if (still && !this.alerted && this.stillTime >= cfg.seconds) {
          this.alerted = true;
          ev.push({ type: 'immobile', seconds: this.stillTime });
        }
      }
    }
    return ev;
  }
}

/**
 * Estado temporal de pose por persona (vinculado a su pista del Tracker).
 * Gestiona postura estable, marcha, brazos en alto, caída e inmovilidad.
 */
export class PoseState {
  constructor() {
    this.posture = null;
    this._pCand = null;
    this._pSince = 0;
    this.walking = false;
    this._walkScore = 0;
    this.armsUp = false;
    this._armsCand = false;
    this._armsSince = 0;
    this.samples = [];                // historial corto para la heurística de caída
    this.hipSmooth = null;
    this.speed = 0;                   // velocidad horizontal de caderas (TL/s)
    this.fall = { state: 'normal', tCand: 0, down: 0, total: 0, uprightSince: null, lastAlert: -Infinity, peakV: 0 };
    this.still = new StillnessMeter();
    this.tlRef = null;                // longitud de torso de referencia (de pie)
    this.uprightHipY = null;
    this.lastT = null;
    this.angles = {};
  }

  /**
   * @param {object} f características de poseFeatures()
   * @param {number} t segundos
   * @param {object} cfg configuración (sensibilidades, tiempos y flags)
   * @returns {Array<object>} eventos
   */
  update(f, t, cfg) {
    const ev = [];
    const dt = this.lastT == null ? 0 : Math.max(0, t - this.lastT);
    this.lastT = t;
    this.angles = f.angles;
    const rawPosture = classifyPosture(f);

    // Referencias "de pie": longitud de torso y altura de cadera con el torso
    // erguido. Se usan para normalizar velocidades y medir cuánto ha bajado.
    if (f.torso && f.torsoTilt < 30) {
      this.tlRef = this.tlRef == null ? f.torsoLen : this.tlRef + (f.torsoLen - this.tlRef) * emaAlpha(dt, 2);
      this.uprightHipY = this.uprightHipY == null ? f.hipMid.y : this.uprightHipY + (f.hipMid.y - this.uprightHipY) * emaAlpha(dt, 1);
    }
    const tl = this.tlRef || f.torsoLen;

    // --- Postura estable (histéresis temporal 0,8 s) -----------------------------
    if (cfg.activity) {
      if (rawPosture !== this.posture) {
        if (rawPosture !== this._pCand) { this._pCand = rawPosture; this._pSince = t; }
        else if (t - this._pSince >= 0.8) {
          const prev = this.posture;
          this.posture = rawPosture;
          this._pCand = null;
          if (rawPosture !== 'indeterminado') ev.push({ type: 'posture', value: rawPosture, prev });
        }
      } else this._pCand = null;
    }

    // --- Velocidad de caderas (suavizada) → marcha ---------------------------
    if (f.hipMid && tl) {
      if (!this.hipSmooth) this.hipSmooth = { x: f.hipMid.x, y: f.hipMid.y, t };
      else {
        const a = emaAlpha(dt, 0.2);
        const nx = this.hipSmooth.x + (f.hipMid.x - this.hipSmooth.x) * a;
        const vx = dt > 0 ? (nx - this.hipSmooth.x) / dt : 0;
        this.speed += (Math.abs(vx) / tl - this.speed) * emaAlpha(dt, 0.4);
        this.hipSmooth.x = nx;
        this.hipSmooth.y += (f.hipMid.y - this.hipSmooth.y) * a;
      }
      if (cfg.activity) {
        const target = this.posture === 'de_pie' && this.speed > 0.45 ? 1 : 0;
        this._walkScore += (target - this._walkScore) * emaAlpha(dt, 0.35);
        const walking = this.walking ? this._walkScore > 0.3 : this._walkScore > 0.7;
        if (walking !== this.walking) { this.walking = walking; ev.push({ type: 'walking', value: walking }); }
      }
    }

    // --- Brazos en alto (0,5 s estable) -------------------------------------------
    if (cfg.activity) {
      if (f.armsUp !== this.armsUp) {
        if (f.armsUp !== this._armsCand) { this._armsCand = f.armsUp; this._armsSince = t; }
        else if (t - this._armsSince >= 0.5) { this.armsUp = f.armsUp; ev.push({ type: 'arms_up', value: f.armsUp }); }
      } else this._armsCand = this.armsUp;
    }

    // --- Heurística de caída -------------------------------------------------------
    if (cfg.fall && f.torso) this._updateFall(f, t, tl, rawPosture, cfg, ev);

    // --- Inmovilidad prolongada --------------------------------------------------
    if (cfg.immobility && tl) {
      const thr = bySensitivity(cfg.immobilitySensitivity, 0.35, 0.05);
      ev.push(...this.still.update(f.joints, tl, t, { seconds: cfg.immobilitySeconds, threshold: thr }));
    }
    return ev;
  }

  /**
   * Máquina de estados de caída:
   *   normal → candidata: estaba erguida (torso < 35°) y ahora está "abajo"
   *            (torso muy inclinado, postura tumbada o caderas muy bajas), y
   *            además se cumple alguna de estas firmas de caída:
   *              · transición rápida: entre la última muestra erguida y la
   *                actual (≤ 2 s), el torso gira de media ≥ 45–110 °/s o
   *                caderas/hombros bajan de media ≥ 0,6–1,6 torsos/s. Al usar
   *                la media entre dos muestras, funciona aunque el análisis
   *                vaya a sólo 3 Hz;
   *              · velocidad de bajada pico ≥ 0,9–3,2 torsos/s;
   *              · velocidad de giro del torso pico ≥ 90–260 °/s.
   *            (los rangos dependen de la sensibilidad 1..10).
   *   candidata → confirmada: sigue "abajo" ≥ 75 % del periodo de confirmación.
   *   candidata → normal: se recupera antes (falsa alarma descartada).
   *   confirmada → normal: vuelve a estar erguida ≥ 1,5 s ("se ha levantado").
   * Sentarse o tumbarse despacio NO dispara la alerta (transición lenta).
   */
  _updateFall(f, t, tl, posture, cfg, ev) {
    const s = cfg.fallSensitivity;
    const vThr = bySensitivity(s, 3.2, 0.9);        // TL/s de bajada
    const tiltRateThr = bySensitivity(s, 260, 90);  // °/s de giro del torso
    const tiltDown = bySensitivity(s, 65, 45);      // ° para considerar "abajo"
    const maxTrans = 2;                              // s máx. entre muestra erguida y "abajo"
    const tiltAvgThr = bySensitivity(s, 110, 45);    // °/s de giro medio
    const dropAvgThr = bySensitivity(s, 1.6, 0.6);   // torsos/s de bajada media

    this.samples.push({ t, hipY: f.hipMid.y, shY: f.shoulderMid.y, tilt: f.torsoTilt });
    while (this.samples.length && this.samples[0].t < t - 3) this.samples.shift();

    const dropped = this.uprightHipY != null && tl ? (f.hipMid.y - this.uprightHipY) / tl : 0;
    const isDown = f.torsoTilt > tiltDown || posture === 'tumbado' || dropped > 0.9;
    const isUpright = f.torsoTilt < 35 && posture !== 'tumbado' && dropped < 0.5;

    const fs = this.fall;
    if (fs.state === 'normal') {
      if (!isDown || !tl) return;
      // Ventana hacia atrás: ¿estaba erguida? ¿bajó deprisa?
      let lastUpright = null, peakV = 0, peakTilt = 0;
      const win = this.samples.filter((p) => p.t >= t - Math.max(1.5, maxTrans + 0.5));
      for (let i = 0; i < win.length; i++) {
        if (win[i].tilt < 35 && win[i].t < t - 0.05) lastUpright = win[i];
        for (let j = i + 1; j < win.length; j++) {
          const dtp = win[j].t - win[i].t;
          if (dtp < 0.12 || dtp > 0.8) continue;
          const v = Math.max(win[j].hipY - win[i].hipY, win[j].shY - win[i].shY) / dtp / tl;
          const vt = (win[j].tilt - win[i].tilt) / dtp;
          if (v > peakV) peakV = v;
          if (vt > peakTilt) peakTilt = vt;
        }
      }
      if (!lastUpright) return;
      const trans = t - lastUpright.t;
      const drop = Math.max(f.hipMid.y - lastUpright.hipY, f.shoulderMid.y - lastUpright.shY) / tl;
      const dTilt = f.torsoTilt - lastUpright.tilt;
      const fastTransition = trans > 0 && trans <= maxTrans && (dTilt / trans >= tiltAvgThr || drop / trans >= dropAvgThr);
      if ((fastTransition || peakV >= vThr || peakTilt >= tiltRateThr) && t - fs.lastAlert > 8) {
        fs.state = 'candidate';
        fs.tCand = t;
        fs.down = 0;
        fs.total = 0;
        fs.peakV = Math.max(peakV, trans > 0 ? drop / trans : 0);
        ev.push({ type: 'fall_candidate', peakV: fs.peakV, peakTilt });
      }
    } else if (fs.state === 'candidate') {
      fs.total++;
      if (isDown) fs.down++;
      if (isUpright && t - fs.tCand > 0.3) {
        fs.state = 'normal';
        ev.push({ type: 'fall_cancelled' });
      } else if (t - fs.tCand >= cfg.fallConfirmSec) {
        if (fs.total === 0 || fs.down / fs.total >= 0.75) {
          fs.state = 'fallen';
          fs.lastAlert = t;
          fs.uprightSince = null;
          ev.push({ type: 'fall_confirmed', peakV: fs.peakV, tilt: f.torsoTilt });
        } else {
          fs.state = 'normal';
          ev.push({ type: 'fall_cancelled' });
        }
      }
    } else if (fs.state === 'fallen') {
      if (isUpright) {
        if (fs.uprightSince == null) fs.uprightSince = t;
        if (t - fs.uprightSince >= 1.5) {
          fs.state = 'normal';
          ev.push({ type: 'fall_recovered' });
        }
      } else fs.uprightSince = null;
    }
  }
}

/**
 * Punto de apoyo (normalizado): media de tobillos/talones visibles, o el borde
 * inferior de la caja si no se ven los pies. Se usa en zonas, líneas y
 * distancias porque representa la posición sobre el suelo.
 */
export function footPoint(lm, bbox, minVis = 0.5) {
  const pts = [PL.LEFT_ANKLE, PL.RIGHT_ANKLE, PL.LEFT_HEEL, PL.RIGHT_HEEL]
    .map((i) => lm[i])
    .filter((p) => p && (p.visibility ?? 1) >= minVis && inside(p));
  if (pts.length) {
    return { x: pts.reduce((s, p) => s + p.x, 0) / pts.length, y: pts.reduce((s, p) => s + p.y, 0) / pts.length };
  }
  return { x: bbox.x + bbox.w / 2, y: bbox.y + bbox.h };
}
