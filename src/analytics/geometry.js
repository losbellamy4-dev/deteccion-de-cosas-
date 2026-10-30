/**
 * geometry.js — Utilidades geométricas puras (sin DOM) usadas por toda la capa
 * de inteligencia derivada. Todas las detecciones del sistema se expresan en
 * coordenadas NORMALIZADAS de la imagen de origen: x ∈ [0,1] hacia la derecha,
 * y ∈ [0,1] hacia abajo. Cuando una métrica depende de distancias reales en el
 * plano de imagen (ángulos, ratios), se convierte antes a "unidades de alto"
 * multiplicando x por la relación de aspecto (ancho/alto), para que un mismo
 * desplazamiento horizontal y vertical midan lo mismo.
 */

export const RAD2DEG = 180 / Math.PI;

export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
export const lerp = (a, b, t) => a + (b - a) * t;

/** Distancia euclídea 2D entre dos puntos {x,y}. */
export function dist2(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/** Distancia euclídea 3D entre dos puntos {x,y,z}. */
export function dist3(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y, (a.z || 0) - (b.z || 0));
}

/** Punto medio de dos puntos (2D/3D). */
export function mid(a, b) {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, z: ((a.z || 0) + (b.z || 0)) / 2 };
}

/**
 * Ángulo (grados) en el vértice b formado por los segmentos b→a y b→c.
 * Funciona en 2D o 3D (si los puntos traen z). Devuelve null si algún
 * segmento es degenerado.
 */
export function angleAt(a, b, c) {
  const ux = a.x - b.x, uy = a.y - b.y, uz = (a.z || 0) - (b.z || 0);
  const vx = c.x - b.x, vy = c.y - b.y, vz = (c.z || 0) - (b.z || 0);
  const nu = Math.hypot(ux, uy, uz), nv = Math.hypot(vx, vy, vz);
  if (nu < 1e-9 || nv < 1e-9) return null;
  const cos = clamp((ux * vx + uy * vy + uz * vz) / (nu * nv), -1, 1);
  return Math.acos(cos) * RAD2DEG;
}

/** Convierte un punto normalizado a "unidades de alto" (x escalado por aspecto). */
export function toAspect(p, aspect) {
  return { x: p.x * aspect, y: p.y, z: (p.z || 0) * aspect };
}

/** Caja {x,y,w,h} que envuelve una lista de puntos, con margen relativo. */
export function bboxOf(points, pad = 0) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of points) {
    if (p.x < x0) x0 = p.x;
    if (p.y < y0) y0 = p.y;
    if (p.x > x1) x1 = p.x;
    if (p.y > y1) y1 = p.y;
  }
  if (!isFinite(x0)) return null;
  const w = x1 - x0, h = y1 - y0;
  const px = w * pad, py = h * pad;
  return { x: x0 - px, y: y0 - py, w: w + 2 * px, h: h + 2 * py };
}

/** Intersección sobre unión de dos cajas {x,y,w,h}. */
export function iou(a, b) {
  const x0 = Math.max(a.x, b.x), y0 = Math.max(a.y, b.y);
  const x1 = Math.min(a.x + a.w, b.x + b.w), y1 = Math.min(a.y + a.h, b.y + b.h);
  const iw = x1 - x0, ih = y1 - y0;
  if (iw <= 0 || ih <= 0) return 0;
  const inter = iw * ih;
  const uni = a.w * a.h + b.w * b.h - inter;
  return uni > 0 ? inter / uni : 0;
}

export function boxCenter(b) {
  return { x: b.x + b.w / 2, y: b.y + b.h / 2 };
}

/** Punto inferior-central de una caja (≈ apoyo de los pies sobre el suelo). */
export function boxFoot(b) {
  return { x: b.x + b.w / 2, y: b.y + b.h };
}

/** Test punto-en-polígono por paridad de cruces (ray casting). */
export function pointInPolygon(p, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if ((a.y > p.y) !== (b.y > p.y)) {
      const xCross = ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x;
      if (p.x < xCross) inside = !inside;
    }
  }
  return inside;
}

/** Producto vectorial 2D de (b-a)×(c-a). Signo = lado de c respecto a la recta a→b. */
export function cross(a, b, c) {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}

/**
 * ¿Se cortan los segmentos p1→p2 y q1→q2? (cruce estricto, sin colinealidad).
 * Es invariante a escalados no uniformes, por eso puede usarse directamente
 * con coordenadas normalizadas.
 */
export function segmentsIntersect(p1, p2, q1, q2) {
  const d1 = cross(q1, q2, p1), d2 = cross(q1, q2, p2);
  const d3 = cross(p1, p2, q1), d4 = cross(p1, p2, q2);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

/** Distancia (en las mismas unidades) de un punto a un segmento. */
export function pointSegmentDistance(p, a, b) {
  const vx = b.x - a.x, vy = b.y - a.y;
  const len2 = vx * vx + vy * vy;
  if (len2 < 1e-12) return dist2(p, a);
  const t = clamp(((p.x - a.x) * vx + (p.y - a.y) * vy) / len2, 0, 1);
  return Math.hypot(p.x - (a.x + t * vx), p.y - (a.y + t * vy));
}

/** Centroide simple de un polígono (media de vértices; suficiente para etiquetas). */
export function polygonCentroid(poly) {
  let x = 0, y = 0;
  for (const p of poly) { x += p.x; y += p.y; }
  return { x: x / poly.length, y: y / poly.length };
}

/** Media exponencial con constante de tiempo (independiente del ritmo de muestreo). */
export function emaAlpha(dt, tau) {
  if (!(dt > 0)) return 1;
  return 1 - Math.exp(-dt / tau);
}

/** Color estable por ID (ángulo áureo → tonos bien separados). */
export function colorForId(id, s = 85, l = 60) {
  const hue = (id * 137.508) % 360;
  return `hsl(${hue.toFixed(1)} ${s}% ${l}%)`;
}
