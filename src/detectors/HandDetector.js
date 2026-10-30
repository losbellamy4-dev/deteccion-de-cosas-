/**
 * HandDetector.js — Módulo B: manos (MediaPipe Hand Landmarker, 21 landmarks
 * por mano + lateralidad).
 *
 * Lateralidad verificada con las imágenes de prueba oficiales de MediaPipe
 * (right_hands.jpg → "Right", left_hands.jpg → "Left"): con la imagen de
 * cámara SIN espejar, la etiqueta corresponde a la mano real de la persona.
 * El ajuste "Invertir izq./der." cubre cámaras que ya entregan la imagen
 * espejada.
 */
import { Detector } from './Detector.js';
import { bboxOf } from '../analytics/geometry.js';

export class HandDetector extends Detector {
  constructor(runtime) {
    super({ id: 'hands', letter: 'B', name: 'Manos', cadence: 2, priority: 2 });
    this.runtime = runtime;
    this.task = null;
    this.connections = [];
    this.options = { numHands: 4 };
  }

  async load({ model, delegates, numHands }) {
    const { vision } = this.runtime;
    this.dispose();
    const { task, delegate } = await this.runtime.createTask(vision.HandLandmarker, {
      baseOptions: { modelAssetBuffer: model },
      runningMode: 'VIDEO',
      numHands,
      minHandDetectionConfidence: 0.5,
      minHandPresenceConfidence: 0.5,
      minTrackingConfidence: 0.5,
    }, delegates);
    this.task = task;
    this.backend = delegate === 'GPU' ? 'GPU · WebGL2' : 'CPU · WASM';
    this.delegate = delegate;
    this.connections = vision.HandLandmarker.HAND_CONNECTIONS.map((c) => [c.start, c.end]);
    this.options.numHands = numHands;
    this.setStatus('ready');
  }

  async setNumHands(n) {
    if (!this.task || n === this.options.numHands) return;
    await this.task.setOptions({ numHands: n });
    this.options.numHands = n;
  }

  /** @returns {Array<{landmarks, world, handedness:'Left'|'Right', score, bbox}>} */
  infer(input) {
    const r = this.task.detectForVideo(input, this.nextTimestamp());
    const hands = [];
    const hd = r.handedness || r.handednesses || [];
    for (let i = 0; i < r.landmarks.length; i++) {
      const lm = r.landmarks[i].map((p) => ({ x: p.x, y: p.y, z: p.z }));
      const world = r.worldLandmarks && r.worldLandmarks[i] ? r.worldLandmarks[i].map((p) => ({ x: p.x, y: p.y, z: p.z })) : null;
      const cat = hd[i] && hd[i][0];
      hands.push({
        landmarks: lm,
        world,
        handedness: cat ? cat.categoryName : 'Right',
        score: cat ? cat.score : 1,
        bbox: bboxOf(lm, 0.12),
      });
    }
    return hands;
  }

  dispose() {
    if (this.task) { try { this.task.close(); } catch { /* ignorar */ } }
    this.task = null;
  }
}
