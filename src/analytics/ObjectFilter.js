/**
 * ObjectFilter.js — Filtro anti-fantasmas para las detecciones de objetos.
 *
 * Un "objeto fantasma" es una detección que no corresponde a nada real: una
 * sombra tomada por un bolso, el monitor del fondo visto como «televisor» de
 * pantalla completa, una mesa en cualquier superficie lisa… Casi siempre
 * tienen una o varias de estas señas: confianza justa, clase de las que los
 * detectores COCO confunden a menudo, caja diminuta o que ocupa toda la
 * imagen, forma de astilla, o caja duplicada con otra clase sobre el mismo
 * objeto. Este módulo aplica esas reglas y separa las detecciones en:
 *  - strong: pasan el umbral del usuario (crean y confirman pistas);
 *  - weak:   algo por debajo del umbral; sólo pueden mantener vivas pistas ya
 *            confirmadas (doble umbral del Tracker), nunca crear objetos.
 * La confirmación temporal (3 fotogramas) la hace el Tracker.
 */
import { iou } from './geometry.js';

/**
 * Clases que los detectores COCO "ven" con frecuencia donde no están
 * (superficies, marcos, sombras, objetos redondos). Se les exige +0,1 de
 * confianza en modo estricto.
 */
export const NOISY_CLASSES = new Set([
  'mesa', 'silla', 'cama', 'sofá', 'televisor', 'inodoro', 'nevera', 'horno', 'fregadero',
  'banco', 'cometa', 'paraguas', 'frisbi', 'pelota', 'bolso', 'corbata',
]);

/**
 * @param {Array<{classId:number, label:string, score:number, bbox:{x,y,w,h}}>} dets
 * @param {object} o
 * @param {number} o.minScore  umbral del usuario (0..1)
 * @param {number} [o.minAreaPct=0.25] área mínima en % de la imagen
 * @param {boolean} [o.strict=true] reglas anti-fantasma completas
 * @param {number} [o.aspect=16/9] ancho/alto de la imagen (para la forma real de la caja)
 * @param {number} [o.weakMargin=0.2] cuánto por debajo del umbral se aceptan débiles
 * @param {number} [o.floor=0.25] confianza por debajo de la cual se descarta todo
 * @returns {{strong:object[], weak:object[], dropped:number}}
 */
export function filterDetections(dets, { minScore, minAreaPct = 0.25, strict = true, aspect = 16 / 9, weakMargin = 0.2, floor = 0.25 } = {}) {
  const minArea = Math.max(0, minAreaPct) / 100;
  const kept = [];
  let dropped = 0;
  for (const d of dets) {
    const thr = threshold(d.label, minScore, strict);
    const weakThr = Math.max(floor, thr - weakMargin);
    if (d.score < weakThr) { dropped++; continue; }
    const b = d.bbox;
    const area = b.w * b.h;
    if (area < minArea) { dropped++; continue; }
    if (strict) {
      // Caja que ocupa casi toda la imagen con confianza no muy alta.
      if (area > 0.85 && d.score < Math.max(thr, 0.7)) { dropped++; continue; }
      // Astillas (muy estrechas o muy planas) pegadas a la imagen.
      const r = (b.w * aspect) / Math.max(1e-6, b.h);
      if (r > 8 || r < 1 / 8) { dropped++; continue; }
    }
    kept.push({ ...d, weak: d.score < thr, margin: d.score - thr });
  }
  // Duplicados de distinta clase sobre el mismo objeto (perro y gato a la vez):
  // gana la que más supera el umbral de SU clase (una mesa dudosa no tapa una
  // botella clara aunque tengan la misma confianza).
  kept.sort((a, b) => b.margin - a.margin);
  const out = [];
  for (const d of kept) {
    if (strict && out.some((k) => k.classId !== d.classId && iou(k.bbox, d.bbox) > 0.7)) { dropped++; continue; }
    out.push(d);
  }
  // Fuertes de más a menos confianza (el Engine recorta a «Detecciones máx.»).
  const strong = out.filter((d) => !d.weak).sort((a, b) => b.score - a.score);
  return { strong, weak: out.filter((d) => d.weak), dropped };
}

/** Umbral efectivo de una clase. */
export function threshold(label, minScore, strict = true) {
  return Math.min(0.95, minScore + (strict && NOISY_CLASSES.has(label) ? 0.1 : 0));
}
