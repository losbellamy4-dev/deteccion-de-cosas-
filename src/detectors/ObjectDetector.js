/**
 * ObjectDetector.js — Módulo D: objetos COCO (80 clases) con el modelo
 * COCO-SSD (SSDLite MobileNet v2) ejecutado con TensorFlow.js.
 *
 * Se cargan los mismos pesos oficiales que usa el paquete @tensorflow-models/
 * coco-ssd, pero la inferencia y el post-proceso están implementados aquí:
 *  - la lectura de resultados es 100 % asíncrona (`await tensor.data()`): el
 *    paquete original usa `dataSync()`, que bloquea el hilo principal hasta que
 *    la GPU termina y congela la interfaz;
 *  - el paquete original cambia el backend GLOBAL a 'cpu' para hacer la NMS;
 *    aquí la NMS se hace en JS puro, sin tocar el backend;
 *  - NMS por clase (no se suprimen objetos distintos solapados) y etiquetas en
 *    español.
 *
 * Gestión de memoria: el tensor de entrada se crea dentro de `tf.tidy` y los
 * tensores de salida se liberan con `tf.dispose` en un `finally`, también si
 * hay error. El número de tensores vivos se muestra en la interfaz para
 * detectar fugas en sesiones largas.
 */
import { Detector } from './Detector.js';
import { COCO_LABELS } from '../config.js';

const OUTPUT_NODES = ['Postprocessor/Slice', 'Postprocessor/ExpandDims_1'];

export class ObjectDetector extends Detector {
  constructor() {
    super({ id: 'objects', letter: 'D', name: 'Objetos (COCO-SSD)', cadence: 3, priority: 1 });
    this.tf = null;
    this.model = null;
    this.minScore = 0.5;
    this.maxResults = 20;
    this._named = true;
  }

  /**
   * @param {object} o
   * @param {object} o.tf      espacio de nombres global de TF.js
   * @param {string} o.url     ruta local de model.json
   * @param {(f:number)=>void} [o.onProgress] progreso de carga 0..1
   */
  async load({ tf, url, onProgress }) {
    this.tf = tf;
    this.dispose();
    this.model = await tf.loadGraphModel(url, { onProgress });
    await this.warmup();
    this.backend = backendLabel(tf.getBackend());
    this.setStatus('ready');
  }

  /** Primera ejecución: compila shaders/kernels; si el backend falla, lanza aquí. */
  async warmup() {
    const tf = this.tf;
    const x = tf.zeros([1, 300, 300, 3], 'int32');
    try {
      const outs = await this._exec(x);
      const arr = Array.isArray(outs) ? outs : [outs];
      await Promise.all(arr.map((t) => t.data()));
      tf.dispose(outs);
    } finally {
      x.dispose();
    }
  }

  async _exec(x) {
    if (this._named) {
      try { return await this.model.executeAsync(x, OUTPUT_NODES); } catch (e) {
        // Modelo con nombres de salida distintos: usar las salidas por defecto.
        if (!/not found|output/i.test(String(e && e.message))) throw e;
        this._named = false;
      }
    }
    return this.model.executeAsync(x);
  }

  async infer(input) {
    const tf = this.tf;
    // fromPixels lee el canvas YA (de forma síncrona), así que el Engine puede
    // reutilizar el lienzo de entrada en el frame siguiente sin problema.
    const x = tf.tidy(() => tf.expandDims(tf.browser.fromPixels(input), 0));
    let outs;
    try {
      outs = await this._exec(x);
    } finally {
      x.dispose();
    }
    try {
      const arr = Array.isArray(outs) ? outs : [outs];
      // Identifica salidas por forma: cajas [1,N,1,4] y puntuaciones [1,N,C].
      const boxesT = arr.find((t) => t.shape[t.shape.length - 1] === 4);
      const scoresT = arr.find((t) => t !== boxesT);
      const [scores, boxes] = await Promise.all([scoresT.data(), boxesT.data()]);
      return decodeSSD(scores, boxes, scoresT.shape[1], scoresT.shape[2], this.minScore, this.maxResults);
    } finally {
      tf.dispose(outs);
    }
  }

  dispose() {
    if (this.model) { try { this.model.dispose(); } catch { /* ignorar */ } }
    this.model = null;
  }
}

export function backendLabel(name) {
  return { webgpu: 'WebGPU', webgl: 'WebGL', wasm: 'WASM · CPU', cpu: 'CPU · JS' }[name] || name;
}

/**
 * Post-proceso SSD: puntuación máxima por ancla → umbral → NMS por clase.
 * @param {Float32Array} scores [N × C] probabilidades (C = 90 IDs COCO, sin fondo)
 * @param {Float32Array} boxes  [N × 4] (ymin, xmin, ymax, xmax) normalizadas
 * @returns {Array<{classId:number, label:string, score:number, bbox:{x,y,w,h}}>}
 */
export function decodeSSD(scores, boxes, numBoxes, numClasses, minScore = 0.5, maxResults = 20, iouThr = 0.5) {
  const cands = [];
  for (let i = 0; i < numBoxes; i++) {
    let best = -1, bestScore = minScore;
    const off = i * numClasses;
    for (let c = 0; c < numClasses; c++) {
      const s = scores[off + c];
      if (s > bestScore) { bestScore = s; best = c; }
    }
    if (best < 0) continue;
    const classId = best + 1;
    const label = COCO_LABELS[classId];
    if (!label) continue; // IDs sin uso en COCO 2017
    const b = i * 4;
    const y0 = clamp01(boxes[b]), x0 = clamp01(boxes[b + 1]), y1 = clamp01(boxes[b + 2]), x1 = clamp01(boxes[b + 3]);
    if (x1 - x0 < 1e-3 || y1 - y0 < 1e-3) continue;
    cands.push({ classId, label, score: bestScore, bbox: { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } });
  }
  cands.sort((a, b) => b.score - a.score);
  const keep = [];
  for (const c of cands) {
    let ok = true;
    for (const k of keep) {
      if (k.classId === c.classId && boxIou(k.bbox, c.bbox) > iouThr) { ok = false; break; }
    }
    if (ok) {
      keep.push(c);
      if (keep.length >= maxResults) break;
    }
  }
  return keep;
}

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

function boxIou(a, b) {
  const x0 = Math.max(a.x, b.x), y0 = Math.max(a.y, b.y);
  const x1 = Math.min(a.x + a.w, b.x + b.w), y1 = Math.min(a.y + a.h, b.y + b.h);
  const iw = x1 - x0, ih = y1 - y0;
  if (iw <= 0 || ih <= 0) return 0;
  const inter = iw * ih;
  return inter / (a.w * a.h + b.w * b.h - inter);
}
