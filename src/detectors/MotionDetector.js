/**
 * MotionDetector.js — Módulo E: movimiento por diferencia de frames, sin
 * modelo de IA.
 *
 *  1. Se reduce el frame a 128 px de ancho y se pasa a escala de grises.
 *  2. Diferencia absoluta con el frame anterior; los píxeles que cambian más
 *     de un umbral (ruido del sensor) cuentan como "movimiento".
 *  3. Energía de movimiento = fracción de píxeles en movimiento (0..1). El
 *     Engine la compara con su propia media y desviación recientes para
 *     detectar ANOMALÍAS (actividad brusca respecto a lo habitual).
 *  4. Heatmap acumulado con decaimiento exponencial, pintado con un mapa de
 *     color sobre un lienzo pequeño que el Renderer escala con suavizado.
 *
 * Leer píxeles de un lienzo acelerado por GPU (getImageData) obliga a una
 * sincronización GPU→CPU que puede bloquear el hilo principal decenas de ms
 * (medido). Por eso, cuando hay workers, el cálculo se hace en un worker
 * (MotionCore es independiente del DOM) y el hilo principal sólo pinta el
 * heatmap recibido.
 */
import { Detector } from './Detector.js';

export const MOTION_W = 128;

/** Núcleo de cálculo (sin DOM): reutilizable en el hilo principal o en un worker. */
export class MotionCore {
  constructor() {
    this.prev = null;
    this.heat = null;
    this.w = 0;
    this.h = 0;
    this.lastT = null;
  }

  reset() {
    this.prev = null;
    if (this.heat) this.heat.fill(0);
    this.lastT = null;
  }

  /**
   * @param {Uint8ClampedArray} px píxeles RGBA (w×h)
   * @param {number} t segundos
   * @returns {{energy:number, heat:Float32Array, w:number, h:number}}
   */
  process(px, w, h, t) {
    const n = w * h;
    if (w !== this.w || h !== this.h) {
      this.w = w;
      this.h = h;
      this.prev = null;
      this.heat = new Float32Array(n);
    }
    const cur = new Uint8ClampedArray(n);
    for (let i = 0, j = 0; i < n; i++, j += 4) cur[i] = (px[j] * 77 + px[j + 1] * 150 + px[j + 2] * 29) >> 8;
    const dt = this.lastT == null ? 0 : Math.max(0, Math.min(1, t - this.lastT));
    this.lastT = t;
    let moving = 0;
    if (this.prev) {
      const decay = Math.exp(-dt / 1.6); // el calor se disipa en ~1,6 s
      const heat = this.heat, prev = this.prev;
      for (let i = 0; i < n; i++) {
        const d = cur[i] > prev[i] ? cur[i] - prev[i] : prev[i] - cur[i];
        let hv = heat[i] * decay;
        if (d > 22) { moving++; hv += 0.35; }
        heat[i] = hv > 1 ? 1 : hv;
      }
    }
    this.prev = cur;
    return { energy: moving / n, heat: this.heat, w, h };
  }
}

/** Pinta un heatmap (Float32Array 0..1) en un lienzo pequeño. Sólo hilo principal. */
export class HeatPainter {
  constructor() {
    this.canvas = document.createElement('canvas');
    this.ctx = this.canvas.getContext('2d');
    this.img = null;
    this.version = -1;
  }

  paint(heat, w, h, version) {
    if (!heat) return this.canvas;
    if (version === this.version) return this.canvas;
    this.version = version;
    if (this.canvas.width !== w || this.canvas.height !== h || !this.img) {
      this.canvas.width = w;
      this.canvas.height = h;
      this.img = this.ctx.createImageData(w, h);
    }
    const d = this.img.data;
    for (let i = 0, j = 0; i < heat.length; i++, j += 4) {
      const v = heat[i];
      if (v < 0.04) { d[j + 3] = 0; continue; }
      // Mapa de color: azul → cian → amarillo → rojo.
      d[j] = v < 0.5 ? 0 : Math.min(255, (v - 0.5) * 510);
      d[j + 1] = v < 0.5 ? v * 2 * 255 : 255 - (v - 0.5) * 300;
      d[j + 2] = v < 0.5 ? 255 - v * 300 : 40;
      d[j + 3] = Math.min(220, 60 + v * 200);
    }
    this.ctx.putImageData(this.img, 0, 0);
    return this.canvas;
  }
}

/** Detector de movimiento en el hilo principal (respaldo si no hay workers). */
export class MotionDetector extends Detector {
  constructor() {
    super({ id: 'motion', letter: 'E', name: 'Movimiento', cadence: 2, priority: 0 });
    this.core = new MotionCore();
    this.painter = null;
    this.version = 0;
    this.last = null;
  }

  async load() {
    this.work = document.createElement('canvas');
    this.wctx = this.work.getContext('2d', { willReadFrequently: true });
    this.painter = new HeatPainter();
    this.backend = 'CPU · JS';
    this.setStatus('ready');
  }

  reset() {
    this.core.reset();
    this.last = null;
    this.version++;
  }

  infer(input, frame) {
    const W = MOTION_W;
    const H = Math.max(8, Math.round((W * input.height) / Math.max(1, input.width)));
    if (this.work.width !== W || this.work.height !== H) { this.work.width = W; this.work.height = H; }
    this.wctx.drawImage(input, 0, 0, W, H);
    const r = this.core.process(this.wctx.getImageData(0, 0, W, H).data, W, H, frame.t);
    this.last = r;
    this.version++;
    return { energy: r.energy, w: W, h: H };
  }

  paintHeat() {
    return this.last ? this.painter.paint(this.last.heat, this.last.w, this.last.h, this.version) : null;
  }
}
