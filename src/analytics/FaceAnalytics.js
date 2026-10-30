/**
 * FaceAnalytics.js — Métricas faciales por GEOMETRÍA sobre la malla de 478
 * puntos de MediaPipe Face Landmarker (468 de malla + 10 de iris).
 *
 *  - EAR (Eye Aspect Ratio, Soukupová & Čech 2016): (|p2−p6| + |p3−p5|) / (2·|p1−p4|).
 *    Cae bruscamente al cerrar el ojo → parpadeo, PERCLOS, somnolencia.
 *  - MAR (Mouth Aspect Ratio): apertura interior de labios / anchura de boca.
 *  - Sonrisa aproximada: ensanchamiento de la boca respecto a la distancia
 *    entre ojos + elevación de las comisuras respecto al centro de los labios.
 *  - Orientación de cabeza: de la matriz de transformación facial (4×4,
 *    column-major, verificada empíricamente) o, si falta, de la normal del
 *    plano facial calculada con landmarks 3D.
 *  - Mirada aproximada: posición del centro del iris entre las comisuras de
 *    cada ojo, combinada con el giro de la cabeza.
 *
 * IMPORTANTE: son heurísticas aproximadas. No sirven para uso médico ni para
 * seguridad crítica (p. ej. vigilancia de conductores).
 *
 * Convención: los índices "derecho/izquierdo" son ANATÓMICOS (del sujeto). En
 * una imagen no espejada, el ojo derecho del sujeto (landmark 33) aparece a la
 * izquierda de la imagen. Los textos de dirección se dan también en términos
 * del sujeto ("gira a su izquierda").
 */
import { dist2, clamp, RAD2DEG, bboxOf, emaAlpha } from './geometry.js';

export const FACE_IDX = {
  // [p1 comisura externa, p2, p3 párpado superior, p4 comisura interna, p5, p6 párpado inferior]
  RIGHT_EYE: [33, 160, 158, 133, 153, 144],
  LEFT_EYE: [362, 385, 387, 263, 373, 380],
  MOUTH_UP_IN: 13, MOUTH_LOW_IN: 14,
  MOUTH_R: 61, MOUTH_L: 291, MOUTH_R_IN: 78, MOUTH_L_IN: 308,
  NOSE_TIP: 1, CHIN: 152, FOREHEAD: 10, CHEEK_R: 234, CHEEK_L: 454,
  R_EYE_OUT: 33, R_EYE_IN: 133, L_EYE_IN: 362, L_EYE_OUT: 263,
  R_LID_UP: 159, R_LID_LOW: 145, L_LID_UP: 386, L_LID_LOW: 374,
  R_IRIS: 468, L_IRIS: 473,
};

/** Convierte un landmark normalizado a píxeles relativos (x por aspecto). */
const px = (p, aspect) => ({ x: p.x * aspect, y: p.y, z: (p.z || 0) * aspect });

export function eyeAspectRatio(lm, idx, aspect) {
  const [p1, p2, p3, p4, p5, p6] = idx.map((i) => px(lm[i], aspect));
  const h = dist2(p1, p4);
  if (h < 1e-6) return 0;
  return (dist2(p2, p6) + dist2(p3, p5)) / (2 * h);
}

/**
 * Ángulos de la cabeza en grados, convención anatómica:
 *   yaw  > 0 → gira hacia SU izquierda · pitch > 0 → mira hacia arriba ·
 *   roll > 0 → ladea hacia SU hombro izquierdo.
 * Con la matriz column-major M: vector "frente" f = (M[8], M[9], M[10]) y
 * vector "arriba" u = (M[4], M[5], M[6]) en espacio cámara (y hacia arriba).
 * Para una imagen no espejada, "derecha de la imagen" = izquierda del sujeto.
 */
export function headPoseFromMatrix(m) {
  const d = m.data || m;
  const yaw = Math.atan2(d[8], d[10]) * RAD2DEG;
  const pitch = Math.atan2(d[9], d[10]) * RAD2DEG;
  const roll = Math.atan2(d[4], d[5]) * RAD2DEG;
  return { yaw, pitch, roll };
}

/** Alternativa geométrica: normal del plano facial con landmarks 3D. */
export function headPoseFromLandmarks(lm, aspect) {
  const R = px(lm[FACE_IDX.R_EYE_OUT], aspect), L = px(lm[FACE_IDX.L_EYE_OUT], aspect);
  const top = px(lm[FACE_IDX.FOREHEAD], aspect), bot = px(lm[FACE_IDX.CHIN], aspect);
  const e = { x: L.x - R.x, y: L.y - R.y, z: L.z - R.z };            // ojo der. → ojo izq.
  const v = { x: bot.x - top.x, y: bot.y - top.y, z: bot.z - top.z };  // frente → barbilla
  // n = e × v apunta hacia el interior de la pantalla; el "frente" es −n.
  const n = { x: e.y * v.z - e.z * v.y, y: e.z * v.x - e.x * v.z, z: e.x * v.y - e.y * v.x };
  const f = { x: -n.x, y: -n.y, z: -n.z };
  const yaw = Math.atan2(f.x, -f.z) * RAD2DEG;          // hacia la derecha de la imagen
  const pitch = Math.atan2(-f.y, -f.z) * RAD2DEG;       // y imagen crece hacia abajo
  const roll = Math.atan2(e.y, e.x) * RAD2DEG;          // ojo izq. más bajo → ladeo a su izq.
  return { yaw, pitch, roll };
}

/** Posición horizontal (0..1) del iris entre las comisuras izquierda/derecha DE LA IMAGEN. */
function irisRatio(lm, iris, cImgLeft, cImgRight, lidUp, lidLow, aspect) {
  const I = px(lm[iris], aspect), A = px(lm[cImgLeft], aspect), B = px(lm[cImgRight], aspect);
  const ax = B.x - A.x, ay = B.y - A.y;
  const len2 = ax * ax + ay * ay;
  if (len2 < 1e-9) return null;
  const h = ((I.x - A.x) * ax + (I.y - A.y) * ay) / len2;
  const U = px(lm[lidUp], aspect), D = px(lm[lidLow], aspect);
  const vh = D.y - U.y;
  const v = Math.abs(vh) > 1e-6 ? (I.y - U.y) / vh : 0.5;
  return { h, v };
}

/**
 * Métricas instantáneas de un rostro.
 * @param {Array<{x,y,z}>} lm 478 landmarks normalizados
 * @param {{data:number[]}|null} matrix matriz de transformación facial
 * @param {number} aspect ancho/alto del frame
 */
export function faceMetrics(lm, matrix, aspect) {
  const earR = eyeAspectRatio(lm, FACE_IDX.RIGHT_EYE, aspect);
  const earL = eyeAspectRatio(lm, FACE_IDX.LEFT_EYE, aspect);
  const P = (i) => px(lm[i], aspect);
  const mouthW = dist2(P(FACE_IDX.MOUTH_R), P(FACE_IDX.MOUTH_L));
  const mouthWIn = Math.max(1e-6, dist2(P(FACE_IDX.MOUTH_R_IN), P(FACE_IDX.MOUTH_L_IN)));
  const mar = dist2(P(FACE_IDX.MOUTH_UP_IN), P(FACE_IDX.MOUTH_LOW_IN)) / mouthWIn;
  const eyeDist = Math.max(1e-6, dist2(P(FACE_IDX.R_EYE_OUT), P(FACE_IDX.L_EYE_OUT)));
  const widthRatio = mouthW / eyeDist;
  // Elevación de comisuras: >0 si están por encima del centro de los labios.
  const lipMidY = (P(FACE_IDX.MOUTH_UP_IN).y + P(FACE_IDX.MOUTH_LOW_IN).y) / 2;
  const cornerY = (P(FACE_IDX.MOUTH_R).y + P(FACE_IDX.MOUTH_L).y) / 2;
  const cornerLift = (lipMidY - cornerY) / Math.max(1e-6, mouthW);

  const pose = matrix && (matrix.data || matrix).length >= 16 ? headPoseFromMatrix(matrix) : headPoseFromLandmarks(lm, aspect);

  let gazeH = 0, gazeV = 0;
  if (lm.length >= 478) {
    const r = irisRatio(lm, FACE_IDX.R_IRIS, FACE_IDX.R_EYE_OUT, FACE_IDX.R_EYE_IN, FACE_IDX.R_LID_UP, FACE_IDX.R_LID_LOW, aspect);
    const l = irisRatio(lm, FACE_IDX.L_IRIS, FACE_IDX.L_EYE_IN, FACE_IDX.L_EYE_OUT, FACE_IDX.L_LID_UP, FACE_IDX.L_LID_LOW, aspect);
    if (r && l) {
      gazeH = (r.h + l.h) / 2 - 0.5; // >0: iris hacia la derecha de la imagen
      gazeV = (r.v + l.v) / 2 - 0.5; // >0: iris hacia abajo
    }
  }
  // Dirección combinada (aprox.): giro de cabeza + desplazamiento del iris.
  const gazeYaw = pose.yaw + clamp(gazeH, -0.5, 0.5) * 70;
  const gazePitch = pose.pitch - clamp(gazeV, -0.5, 0.5) * 50;

  return {
    earR, earL, ear: (earR + earL) / 2, mar, widthRatio, cornerLift,
    yaw: pose.yaw, pitch: pose.pitch, roll: pose.roll,
    gazeH, gazeV, gazeYaw, gazePitch,
    bbox: bboxOf(lm.slice(0, 468)),
  };
}

export function gazeLabel(m) {
  const parts = [];
  if (m.gazePitch > 14) parts.push('arriba');
  else if (m.gazePitch < -14) parts.push('abajo');
  if (m.gazeYaw > 14) parts.push('a su izquierda');
  else if (m.gazeYaw < -14) parts.push('a su derecha');
  return parts.length ? parts.join(' y ') : 'al frente';
}

export function turnLabel(deg, pos, neg, eps = 8) {
  if (deg > eps) return `${Math.round(deg)}° ${pos}`;
  if (deg < -eps) return `${Math.round(-deg)}° ${neg}`;
  return 'centrado';
}

/**
 * Estado temporal de un rostro: calibra el ojo abierto de esa persona, cuenta
 * parpadeos, mide PERCLOS y detecta somnolencia, bostezo y sonrisa.
 */
export class FaceState {
  constructor() {
    this.openRef = null;      // EAR de referencia con el ojo abierto (se autocalibra)
    this.neutralWidth = null; // anchura de boca neutra (relativa a ojos)
    this.closed = false;
    this.closedSince = 0;
    this.blinks = [];         // instantes de parpadeo (últimos 60 s)
    this.perclosBuf = [];     // {t, closed}
    this.drowsyAlerted = false;
    this.yawnSince = null;
    this.yawnAlerted = false;
    this.mouthOpen = false;
    this.smiling = false;
    this.smileScore = 0;
    this.lastT = null;
  }

  /**
   * @param {object} m métricas de faceMetrics()
   * @param {number} t segundos
   * @param {{eyeRatio:number, drowsySec:number}} cfg
   * @returns {Array<object>} eventos
   */
  update(m, t, cfg) {
    const ev = [];
    const dt = this.lastT == null ? 0 : Math.max(0, t - this.lastT);
    this.lastT = t;

    // --- Autocalibración del ojo abierto -------------------------------------
    // Sube rápido y baja despacio: aproxima el percentil alto del EAR propio de
    // cada persona (los ojos rasgados dan EAR más bajos que la media).
    if (this.openRef == null) this.openRef = Math.max(0.2, m.ear);
    else if (m.ear > this.openRef) this.openRef += (m.ear - this.openRef) * emaAlpha(dt, 0.5);
    else if (m.ear > this.openRef * 0.75) this.openRef += (m.ear - this.openRef) * emaAlpha(dt, 20);
    const thr = Math.max(0.1, this.openRef * cfg.eyeRatio);
    const closedNow = m.ear < thr;

    // --- Parpadeo / somnolencia ------------------------------------------------
    if (closedNow && !this.closed) {
      this.closed = true;
      this.closedSince = t;
    } else if (!closedNow && this.closed) {
      const dur = t - this.closedSince;
      this.closed = false;
      if (dur >= 0.04 && dur <= 0.5) {
        this.blinks.push(t);
        ev.push({ type: 'blink', dur });
      }
      if (this.drowsyAlerted) ev.push({ type: 'drowsy_end', dur });
      this.drowsyAlerted = false;
    }
    if (this.closed && !this.drowsyAlerted && t - this.closedSince >= cfg.drowsySec) {
      this.drowsyAlerted = true;
      ev.push({ type: 'drowsy', dur: t - this.closedSince });
    }
    while (this.blinks.length && this.blinks[0] < t - 60) this.blinks.shift();
    this.perclosBuf.push({ t, c: closedNow ? 1 : 0 });
    while (this.perclosBuf.length && this.perclosBuf[0].t < t - 60) this.perclosBuf.shift();

    // --- Boca abierta / bostezo --------------------------------------------------
    const open = m.mar > 0.35;
    if (open !== this.mouthOpen) {
      this.mouthOpen = open;
      ev.push({ type: 'mouth', open });
    }
    if (m.mar > 0.6) {
      if (this.yawnSince == null) this.yawnSince = t;
      if (!this.yawnAlerted && t - this.yawnSince >= 1.5) {
        this.yawnAlerted = true;
        ev.push({ type: 'yawn' });
      }
    } else {
      this.yawnSince = null;
      this.yawnAlerted = false;
    }

    // --- Sonrisa aproximada --------------------------------------------------------
    // La anchura neutra sólo se aprende con la boca cerrada y sin elevación
    // marcada de comisuras, para no "acostumbrarse" a una sonrisa sostenida.
    if (!open && m.cornerLift < 0.03) {
      this.neutralWidth = this.neutralWidth == null ? m.widthRatio : this.neutralWidth + (m.widthRatio - this.neutralWidth) * emaAlpha(dt, 8);
    }
    const base = this.neutralWidth ?? 0.62;
    const widen = m.widthRatio / base - 1;          // ensanchamiento relativo
    const score = clamp(widen * 4 + m.cornerLift * 6, 0, 1);
    this.smileScore += (score - this.smileScore) * emaAlpha(dt, 0.15);
    const smiling = this.smiling ? this.smileScore > 0.35 : this.smileScore > 0.5;
    if (smiling !== this.smiling) {
      this.smiling = smiling;
      ev.push({ type: 'smile', value: smiling });
    }
    return ev;
  }

  get blinkRate() { return this.blinks.length; } // parpadeos en los últimos 60 s
  get perclos() {
    const n = this.perclosBuf.length;
    if (!n) return 0;
    let s = 0;
    for (const p of this.perclosBuf) s += p.c;
    return s / n;
  }
}
