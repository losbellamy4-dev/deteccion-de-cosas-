/**
 * PoseDetector.js — Módulo A: pose corporal multipersona (MediaPipe Pose
 * Landmarker, 33 keypoints con visibilidad + coordenadas 3D "world" en metros).
 */
import { Detector } from './Detector.js';
import { bboxOf } from '../analytics/geometry.js';

export class PoseDetector extends Detector {
  constructor(runtime) {
    super({ id: 'pose', letter: 'A', name: 'Pose corporal', cadence: 1, priority: 3 });
    this.runtime = runtime;
    this.task = null;
    this.connections = [];
    this.options = { numPoses: 3 };
    this.variant = 'lite';
  }

  /**
   * @param {object} o
   * @param {Uint8Array} o.model bytes del archivo .task
   * @param {string[]} o.delegates orden de delegados
   * @param {number} o.numPoses
   * @param {string} o.variant lite | full | heavy (sólo informativo)
   */
  async load({ model, delegates, numPoses, variant }) {
    const { vision } = this.runtime;
    this.dispose();
    const { task, delegate } = await this.runtime.createTask(vision.PoseLandmarker, {
      baseOptions: { modelAssetBuffer: model },
      runningMode: 'VIDEO',
      numPoses,
      minPoseDetectionConfidence: 0.5,
      minPosePresenceConfidence: 0.5,
      minTrackingConfidence: 0.5,
      outputSegmentationMasks: false,
    }, delegates);
    this.task = task;
    this.backend = delegate === 'GPU' ? 'GPU · WebGL2' : 'CPU · WASM';
    this.delegate = delegate;
    this.connections = vision.PoseLandmarker.POSE_CONNECTIONS.map((c) => [c.start, c.end]);
    this.options.numPoses = numPoses;
    this.variant = variant;
    this.setStatus('ready');
  }

  async setNumPoses(n) {
    if (!this.task || n === this.options.numPoses) return;
    await this.task.setOptions({ numPoses: n });
    this.options.numPoses = n;
  }

  /** @returns {Array<{landmarks, world, bbox, score}>} */
  infer(input) {
    const r = this.task.detectForVideo(input, this.nextTimestamp());
    const persons = [];
    for (let i = 0; i < r.landmarks.length; i++) {
      // Copia defensiva: el resultado de MediaPipe se libera con close().
      const lm = r.landmarks[i].map((p) => ({ x: p.x, y: p.y, z: p.z, visibility: p.visibility ?? 1 }));
      const world = r.worldLandmarks && r.worldLandmarks[i] ? r.worldLandmarks[i].map((p) => ({ x: p.x, y: p.y, z: p.z })) : null;
      const vis = lm.filter((p) => p.visibility >= 0.3);
      const bbox = bboxOf(vis.length >= 4 ? vis : lm, 0.08);
      if (!bbox) continue;
      const score = vis.length / lm.length;
      persons.push({ landmarks: lm, world, bbox, score });
    }
    if (typeof r.close === 'function') r.close();
    return persons;
  }

  dispose() {
    if (this.task) { try { this.task.close(); } catch { /* ignorar */ } }
    this.task = null;
  }
}
