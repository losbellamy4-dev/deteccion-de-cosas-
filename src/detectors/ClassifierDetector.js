/**
 * ClassifierDetector.js — Módulo F: reconocimiento de 1000 tipos de cosas
 * (MediaPipe Image Classifier con EfficientNet-Lite0, entrenado en ImageNet:
 * animales y razas, comida, herramientas, instrumentos, vehículos, ropa,
 * muebles, aparatos…).
 *
 * Un clasificador no localiza: dice QUÉ hay en una región. Por eso cada
 * ejecución clasifica varias regiones de interés (ROI) del mismo fotograma,
 * que decide el Engine en `this.rois`:
 *  - 'reticle': el visor central (apuntas la cámara a una cosa y te dice qué es);
 *  - 'scene':   la imagen completa (de qué va la escena);
 *  - 'obj:<id>': la caja de un objeto ya seguido, para afinar su etiqueta
 *    (p. ej. «perro» → «golden retriever», o corregir perro/gato).
 * Las ROI llegan normalizadas {left, top, right, bottom} y MediaPipe recorta y
 * escala cada una a 224×224 internamente.
 */
import { Detector } from './Detector.js';

export class ClassifierDetector extends Detector {
  constructor(runtime) {
    super({ id: 'classifier', letter: 'F', name: 'Reconocimiento (1000 cosas)', cadence: 6, priority: 0 });
    this.runtime = runtime;
    this.task = null;
    /** @type {Array<{key:string, roi:{left,top,right,bottom}}>} */
    this.rois = [];
    this.topK = 5;
  }

  async load({ model, delegates }) {
    const { vision } = this.runtime;
    this.dispose();
    const { task, delegate } = await this.runtime.createTask(vision.ImageClassifier, {
      baseOptions: { modelAssetBuffer: model },
      runningMode: 'IMAGE',
      maxResults: this.topK,
    }, delegates);
    this.task = task;
    this.delegate = delegate;
    this.backend = delegate === 'GPU' ? 'GPU · WebGL2' : 'CPU · WASM';
    this.setStatus('ready');
  }

  /** @returns {{items: Array<{key:string, cats:Array<{i:number, s:number}>}>}} */
  infer(input) {
    const items = [];
    const rois = this.rois && this.rois.length ? this.rois : [{ key: 'scene', roi: null }];
    for (const { key, roi } of rois) {
      const r = roi ? this.task.classify(input, { regionOfInterest: safeRoi(roi) }) : this.task.classify(input);
      const cl = r.classifications && r.classifications[0];
      items.push({ key, cats: cl ? cl.categories.map((c) => ({ i: c.index, s: c.score })) : [] });
    }
    return { items };
  }

  dispose() {
    if (this.task) { try { this.task.close(); } catch { /* ignorar */ } }
    this.task = null;
  }
}

/** MediaPipe exige 0 ≤ left < right ≤ 1 y 0 ≤ top < bottom ≤ 1. */
function safeRoi(r) {
  const c = (v) => Math.max(0, Math.min(1, v));
  let left = c(r.left), right = c(r.right), top = c(r.top), bottom = c(r.bottom);
  if (right - left < 0.01) { left = Math.max(0, left - 0.005); right = Math.min(1, left + 0.01); }
  if (bottom - top < 0.01) { top = Math.max(0, top - 0.005); bottom = Math.min(1, top + 0.01); }
  return { left, top, right, bottom };
}
