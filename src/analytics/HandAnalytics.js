/**
 * HandAnalytics.js — Conteo de dedos y gestos a partir de los 21 landmarks de
 * MediaPipe Hands. No usa ningún modelo adicional: todo es geometría.
 *
 * Se trabaja con los landmarks "world" (3D métricos, centrados en la mano)
 * cuando están disponibles, porque son invariantes a la rotación de la mano en
 * la imagen y a su distancia a la cámara; si no, con los 2D (x escalado por el
 * aspecto para no deformar ángulos).
 *
 * Índices (MediaPipe): 0 muñeca · pulgar 1-4 · índice 5-8 · corazón 9-12 ·
 * anular 13-16 · meñique 17-20 (MCP, PIP, DIP, punta).
 */
import { angleAt, dist3 } from './geometry.js';

export const HL = {
  WRIST: 0,
  THUMB_CMC: 1, THUMB_MCP: 2, THUMB_IP: 3, THUMB_TIP: 4,
  INDEX_MCP: 5, INDEX_PIP: 6, INDEX_DIP: 7, INDEX_TIP: 8,
  MIDDLE_MCP: 9, MIDDLE_PIP: 10, MIDDLE_DIP: 11, MIDDLE_TIP: 12,
  RING_MCP: 13, RING_PIP: 14, RING_DIP: 15, RING_TIP: 16,
  PINKY_MCP: 17, PINKY_PIP: 18, PINKY_DIP: 19, PINKY_TIP: 20,
};

const LONG_FINGERS = {
  index: [HL.INDEX_MCP, HL.INDEX_PIP, HL.INDEX_DIP, HL.INDEX_TIP],
  middle: [HL.MIDDLE_MCP, HL.MIDDLE_PIP, HL.MIDDLE_DIP, HL.MIDDLE_TIP],
  ring: [HL.RING_MCP, HL.RING_PIP, HL.RING_DIP, HL.RING_TIP],
  pinky: [HL.PINKY_MCP, HL.PINKY_PIP, HL.PINKY_DIP, HL.PINKY_TIP],
};

export const GESTURES = {
  fist: 'puño',
  open: 'mano abierta',
  pinch: 'pinza',
  ok: 'OK',
  point: 'señalar',
  victory: 'victoria',
  thumbs_up: 'pulgar arriba',
  thumbs_down: 'pulgar abajo',
  rock: 'cuernos',
  call: 'llamar',
  number: 'número',
};

/** Umbrales de "dedo recto": relajados para 3D, más estrictos para 2D. */
const LOOSE = { pip: 150, dip: 130, reach: 1.1, thumbIp: 145 };
const STRICT = { pip: 160, dip: 140, reach: 1.15, thumbIp: 155 };

/**
 * Estado (extendido/flexionado) de cada dedo en un espacio concreto (2D o 3D).
 * - Dedos largos: extendido si la articulación PIP está casi recta, la DIP no
 *   está muy doblada y la punta queda más lejos de la muñeca que la PIP (esto
 *   último descarta un dedo recto pero plegado sobre el nudillo).
 * - Pulgar: extendido si su articulación IP está recta y la punta se separa
 *   del nudillo del índice (>0,6 anchos de palma) y del meñique (>1,2): en un
 *   puño el pulgar queda cruzado sobre los dedos, cerca de ambas referencias.
 *   Umbrales calibrados con las imágenes de prueba oficiales de MediaPipe
 *   (fist, thumb_up, victory, pointing_up, right_hands).
 */
export function fingerStates(P, th = LOOSE) {
  const wrist = P[HL.WRIST];
  const res = {};
  for (const [name, [mcp, pip, dip, tip]] of Object.entries(LONG_FINGERS)) {
    const aPip = angleAt(P[mcp], P[pip], P[dip]) ?? 0;
    const aDip = angleAt(P[pip], P[dip], P[tip]) ?? 0;
    const farther = dist3(wrist, P[tip]) > dist3(wrist, P[pip]) * th.reach;
    res[name] = aPip > th.pip && aDip > th.dip && farther;
  }
  const palmW = Math.max(1e-6, dist3(P[HL.INDEX_MCP], P[HL.PINKY_MCP]));
  const aIp = angleAt(P[HL.THUMB_MCP], P[HL.THUMB_IP], P[HL.THUMB_TIP]) ?? 0;
  const away = dist3(P[HL.THUMB_TIP], P[HL.INDEX_MCP]) / palmW;
  const awayPinky = dist3(P[HL.THUMB_TIP], P[HL.PINKY_MCP]) / palmW;
  res.thumb = aIp > th.thumbIp && away > 0.6 && awayPinky > 1.2;
  return res;
}

const FINGER_KEYS = ['thumb', 'index', 'middle', 'ring', 'pinky'];

/**
 * Clasifica el gesto de una mano.
 *
 * Fusión 2D/3D: los landmarks 3D ("world") son invariantes a la rotación pero
 * su profundidad estimada a veces dobla de más un dedo recto; los 2D no sufren
 * eso pero acortan los dedos que apuntan a la cámara. Un dedo se considera
 * extendido si lo dice el 3D (umbral normal) o el 2D (umbral estricto).
 *
 * @param {Array<{x,y,z}>} lm   landmarks normalizados (imagen)
 * @param {Array<{x,y,z}>|null} world landmarks 3D en metros (opcional)
 * @param {number} aspect ancho/alto del frame
 * @returns {{gesture:string, label:string, count:number, fingers:object, pinch:number}}
 */
export function classifyHand(lm, world, aspect = 1) {
  const P2 = lm.map((p) => ({ x: p.x * aspect, y: p.y, z: 0 }));
  const P3 = world && world.length === 21 ? world : null;
  const f2 = fingerStates(P2, STRICT);
  const f3 = P3 ? fingerStates(P3, LOOSE) : null;
  const f = {};
  for (const k of FINGER_KEYS) f[k] = f3 ? f3[k] || f2[k] : fingerStates(P2, LOOSE)[k];
  f.count = FINGER_KEYS.reduce((n, k) => n + (f[k] ? 1 : 0), 0);

  // Pinza: puntas de pulgar e índice muy juntas (relativo al tamaño de la
  // palma), la punta del índice adelantada respecto a la palma y el índice
  // sólo arqueado (PIP > 100°). Las dos últimas condiciones evitan confundir
  // un puño (índice enroscado junto al pulgar) con una pinza.
  const Pp = P3 || P2;
  const palm = Math.max(1e-6, dist3(Pp[HL.WRIST], Pp[HL.MIDDLE_MCP]));
  const pinch = dist3(Pp[HL.THUMB_TIP], Pp[HL.INDEX_TIP]) / palm;
  const indexReach = dist3(Pp[HL.WRIST], Pp[HL.INDEX_TIP]) / palm;
  const indexPip = angleAt(Pp[HL.INDEX_MCP], Pp[HL.INDEX_PIP], Pp[HL.INDEX_DIP]) ?? 0;
  const isPinch = pinch < 0.25 && indexReach > 0.9 && indexPip > 100;
  const { thumb, index, middle, ring, pinky, count } = f;

  let gesture = 'number';
  if (isPinch) {
    gesture = middle && ring && pinky ? 'ok' : 'pinch';
  } else if (!index && !middle && !ring && !pinky) {
    if (thumb) {
      // Dirección del pulgar en la IMAGEN (y crece hacia abajo).
      const tipY = lm[HL.THUMB_TIP].y, mcpY = lm[HL.THUMB_MCP].y, wristY = lm[HL.WRIST].y;
      const handH = Math.abs(lm[HL.MIDDLE_MCP].y - wristY) + 1e-6;
      if (mcpY - tipY > 0.35 * handH) gesture = 'thumbs_up';
      else if (tipY - mcpY > 0.35 * handH) gesture = 'thumbs_down';
      else gesture = 'number';
    } else {
      gesture = 'fist';
    }
  } else if (index && middle && ring && pinky) {
    gesture = thumb ? 'open' : 'number';
  } else if (index && !middle && !ring && !pinky) {
    gesture = 'point';
  } else if (index && middle && !ring && !pinky) {
    gesture = 'victory';
  } else if (index && !middle && !ring && pinky) {
    gesture = 'rock';
  } else if (thumb && !index && !middle && !ring && pinky) {
    gesture = 'call';
  }

  const label = gesture === 'number' ? `${count} ${count === 1 ? 'dedo' : 'dedos'}` : GESTURES[gesture];
  return { gesture, label, count, fingers: f, pinch };
}

/**
 * Estabilizador de etiquetas: sólo da por bueno un gesto cuando se mantiene
 * `holdSec` segundos, para no inundar el log con parpadeos de clasificación.
 */
export class StableLabel {
  constructor(holdSec = 0.4) {
    this.hold = holdSec;
    this.value = null;
    this.candidate = null;
    this.since = 0;
  }
  /** @returns {boolean} true si el valor estable cambió en esta llamada. */
  update(v, t) {
    if (v === this.value) { this.candidate = null; return false; }
    if (v !== this.candidate) { this.candidate = v; this.since = t; return false; }
    if (t - this.since >= this.hold) {
      this.value = v;
      this.candidate = null;
      return true;
    }
    return false;
  }
}
