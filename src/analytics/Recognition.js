/**
 * Recognition.js — Utilidades del módulo F (reconocimiento de 1000 cosas):
 * regiones de interés para el clasificador y suavizado temporal de sus
 * puntuaciones.
 *
 * Coordenadas normalizadas de la imagen (0..1). Para que el clasificador no
 * vea las cosas deformadas, las ROI se hacen CUADRADAS en píxeles reales
 * (teniendo en cuenta la relación de aspecto de la imagen).
 */

/** Lado del visor central, como fracción del lado corto de la imagen. */
export const RETICLE_SIZE = 0.5;

/** ROI del visor central (cuadrado centrado). */
export function reticleRoi(aspect, size = RETICLE_SIZE) {
  const s = size * Math.min(aspect, 1);
  const sx = s / aspect, sy = s;
  return { left: 0.5 - sx / 2, top: 0.5 - sy / 2, right: 0.5 + sx / 2, bottom: 0.5 + sy / 2 };
}

/**
 * ROI cuadrada que contiene una caja, ampliada `pad` veces y recolocada para
 * no salirse de la imagen.
 */
export function squareRoi(b, aspect, pad = 1.15) {
  // En píxeles con alto = 1 y ancho = aspect.
  const cx = (b.x + b.w / 2) * aspect, cy = b.y + b.h / 2;
  const side = Math.min(Math.max(b.w * aspect, b.h) * pad, aspect, 1);
  const x0 = Math.max(0, Math.min(aspect - side, cx - side / 2));
  const y0 = Math.max(0, Math.min(1 - side, cy - side / 2));
  return { left: x0 / aspect, top: y0, right: (x0 + side) / aspect, bottom: y0 + side };
}

/**
 * Suavizado de puntuaciones por clase entre ejecuciones sucesivas del
 * clasificador. Dos modos:
 *  - `tau` (s): media exponencial en el tiempo (visor y escena: responden en
 *    ~1 s y no parpadean entre dos clases parecidas);
 *  - `window`: media de las últimas N clasificaciones (objetos, que se
 *    clasifican de forma intermitente).
 * Las clases que no aparecen en una ejecución cuentan como 0.
 */
export class ScoreSmoother {
  constructor({ tau = null, window = 5 } = {}) {
    this.tau = tau;
    this.window = window;
    this.scores = new Map();
    this.n = 0;
    this.lastT = null;
  }

  /** @param {Array<{i:number, s:number}>} cats  @param {number} t segundos */
  update(cats, t) {
    this.n++;
    let a;
    if (this.n === 1) a = 1;
    else if (this.tau) a = 1 - Math.exp(-Math.max(0, t - this.lastT) / this.tau);
    else a = 1 / Math.min(this.n, this.window);
    this.lastT = t;
    for (const [i, s] of this.scores) this.scores.set(i, s * (1 - a));
    for (const c of cats) this.scores.set(c.i, (this.scores.get(c.i) || 0) + a * c.s);
    for (const [i, s] of this.scores) if (s < 0.005) this.scores.delete(i);
  }

  /** Las k clases con más puntuación: [{i, s}] de mayor a menor. */
  top(k = 5) {
    return [...this.scores].map(([i, s]) => ({ i, s })).sort((x, y) => y.s - x.s).slice(0, k);
  }

  reset() {
    this.scores.clear();
    this.n = 0;
    this.lastT = null;
  }
}
