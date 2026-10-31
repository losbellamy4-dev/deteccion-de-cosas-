/**
 * EfficientDetDetector.js — Módulo D (modelo por defecto): objetos COCO con
 * EfficientDet-Lite (MediaPipe Object Detector).
 *
 * Frente a COCO-SSD (SSDLite MobileNet v2, mAP COCO ≈ 22) EfficientDet-Lite0
 * llega a ≈ 26 y Lite2 a ≈ 34: menos objetos inventados y cajas más ajustadas.
 * La NMS va dentro del propio modelo (sin cajas duplicadas de clases distintas
 * sobre el mismo objeto).
 *
 * El modelo devuelve todo lo que supere un umbral BAJO fijo (LOW_SCORE): el
 * filtrado fino (umbral del usuario, clases dudosas, tamaño mínimo…) se hace
 * después en JS (analytics/ObjectFilter.js). Así mover el control de
 * confianza no obliga a reconfigurar el modelo, y el tracker puede usar las
 * detecciones débiles para NO perder objetos ya confirmados (doble umbral).
 */
import { Detector } from './Detector.js';
import { COCO_LABELS } from '../config.js';

/** Umbral interno del modelo; por debajo, ni el tracker las aprovecha. */
export const LOW_SCORE = 0.25;

/**
 * Nombre (inglés) de la etiqueta del modelo → ID COCO. MediaPipe devuelve
 * `index = -1` con estos modelos, así que la clase se identifica por nombre
 * (mapa de etiquetas incluido en el propio .tflite, verificado).
 */
const COCO_ID = {
  person: 1, bicycle: 2, car: 3, motorcycle: 4, airplane: 5, bus: 6, train: 7, truck: 8, boat: 9,
  'traffic light': 10, 'fire hydrant': 11, 'stop sign': 13, 'parking meter': 14, bench: 15, bird: 16,
  cat: 17, dog: 18, horse: 19, sheep: 20, cow: 21, elephant: 22, bear: 23, zebra: 24, giraffe: 25,
  backpack: 27, umbrella: 28, handbag: 31, tie: 32, suitcase: 33, frisbee: 34, skis: 35, snowboard: 36,
  'sports ball': 37, kite: 38, 'baseball bat': 39, 'baseball glove': 40, skateboard: 41, surfboard: 42,
  'tennis racket': 43, bottle: 44, 'wine glass': 46, cup: 47, fork: 48, knife: 49, spoon: 50, bowl: 51,
  banana: 52, apple: 53, sandwich: 54, orange: 55, broccoli: 56, carrot: 57, 'hot dog': 58, pizza: 59,
  donut: 60, cake: 61, chair: 62, couch: 63, 'potted plant': 64, bed: 65, 'dining table': 67, toilet: 70,
  tv: 72, laptop: 73, mouse: 74, remote: 75, keyboard: 76, 'cell phone': 77, microwave: 78, oven: 79,
  toaster: 80, sink: 81, refrigerator: 82, book: 84, clock: 85, vase: 86, scissors: 87, 'teddy bear': 88,
  'hair drier': 89, toothbrush: 90,
};

export class EfficientDetDetector extends Detector {
  constructor(runtime) {
    super({ id: 'objects', letter: 'D', name: 'Objetos (EfficientDet)', cadence: 3, priority: 1 });
    this.runtime = runtime;
    this.task = null;
    this.variant = 'efficientdet_lite0';
  }

  /**
   * @param {object} o
   * @param {Uint8Array} o.model bytes del .tflite
   * @param {string[]} o.delegates orden de delegados
   * @param {string} [o.variant] efficientdet_lite0 | efficientdet_lite2 (informativo)
   */
  async load({ model, delegates, variant }) {
    const { vision } = this.runtime;
    this.dispose();
    const { task, delegate } = await this.runtime.createTask(vision.ObjectDetector, {
      baseOptions: { modelAssetBuffer: model },
      runningMode: 'VIDEO',
      scoreThreshold: LOW_SCORE,
      maxResults: 40,
    }, delegates);
    this.task = task;
    this.delegate = delegate;
    this.backend = delegate === 'GPU' ? 'GPU · WebGL2' : 'CPU · WASM';
    if (variant) this.variant = variant;
    this.setStatus('ready');
  }

  /** @returns {Array<{classId:number, label:string, score:number, bbox:{x,y,w,h}}>} */
  infer(input) {
    const W = input.width, H = input.height;
    const r = this.task.detectForVideo(input, this.nextTimestamp());
    const out = [];
    for (const d of r.detections || []) {
      const c = d.categories && d.categories[0];
      const b = d.boundingBox;
      if (!c || !b) continue;
      const classId = COCO_ID[c.categoryName] ?? (c.index >= 0 ? c.index + 1 : 0);
      const label = COCO_LABELS[classId];
      if (!label) continue;
      const x0 = clamp01(b.originX / W), y0 = clamp01(b.originY / H);
      const x1 = clamp01((b.originX + b.width) / W), y1 = clamp01((b.originY + b.height) / H);
      if (x1 - x0 < 1e-3 || y1 - y0 < 1e-3) continue;
      out.push({ classId, label, score: c.score, bbox: { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } });
    }
    return out;
  }

  dispose() {
    if (this.task) { try { this.task.close(); } catch { /* ignorar */ } }
    this.task = null;
  }
}

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
