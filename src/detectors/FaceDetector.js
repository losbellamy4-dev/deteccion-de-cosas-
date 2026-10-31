/**
 * FaceDetector.js — Módulo C: malla facial (MediaPipe Face Landmarker: 478
 * landmarks 3D con iris + matriz de transformación facial 4×4 para la
 * orientación de la cabeza). Los blendshapes se desactivan: las métricas
 * (parpadeo, boca, sonrisa) se calculan por geometría en FaceAnalytics.
 */
import { Detector } from './Detector.js';
import { bboxOf } from '../analytics/geometry.js';

export class FaceDetector extends Detector {
  constructor(runtime) {
    super({ id: 'face', letter: 'C', name: 'Malla facial', cadence: 2, priority: 1 });
    this.runtime = runtime;
    this.task = null;
    this.connections = { tess: [], contours: [], irises: [] };
    this.options = { numFaces: 2 };
  }

  async load({ model, delegates, numFaces }) {
    const { vision } = this.runtime;
    this.dispose();
    const { task, delegate } = await this.runtime.createTask(vision.FaceLandmarker, {
      baseOptions: { modelAssetBuffer: model },
      runningMode: 'VIDEO',
      numFaces,
      minFaceDetectionConfidence: 0.6,
      minFacePresenceConfidence: 0.6,
      minTrackingConfidence: 0.5,
      outputFaceBlendshapes: false,
      outputFacialTransformationMatrixes: true,
    }, delegates);
    this.task = task;
    this.backend = delegate === 'GPU' ? 'GPU · WebGL2' : 'CPU · WASM';
    this.delegate = delegate;
    const F = vision.FaceLandmarker;
    const pairs = (list) => (list || []).map((c) => [c.start, c.end]);
    this.connections = {
      tess: pairs(F.FACE_LANDMARKS_TESSELATION),
      contours: pairs(F.FACE_LANDMARKS_CONTOURS),
      irises: [...pairs(F.FACE_LANDMARKS_LEFT_IRIS), ...pairs(F.FACE_LANDMARKS_RIGHT_IRIS)],
    };
    this.options.numFaces = numFaces;
    this.setStatus('ready');
  }

  async setNumFaces(n) {
    if (!this.task || n === this.options.numFaces) return;
    await this.task.setOptions({ numFaces: n });
    this.options.numFaces = n;
  }

  /** @returns {Array<{landmarks, matrix, bbox}>} */
  infer(input) {
    const r = this.task.detectForVideo(input, this.nextTimestamp());
    const faces = [];
    for (let i = 0; i < r.faceLandmarks.length; i++) {
      const lm = r.faceLandmarks[i].map((p) => ({ x: p.x, y: p.y, z: p.z }));
      const m = r.facialTransformationMatrixes && r.facialTransformationMatrixes[i];
      faces.push({
        landmarks: lm,
        matrix: m ? { rows: m.rows, columns: m.columns, data: Array.from(m.data) } : null,
        bbox: bboxOf(lm.slice(0, 468), 0.05),
      });
    }
    return faces;
  }

  dispose() {
    if (this.task) { try { this.task.close(); } catch { /* ignorar */ } }
    this.task = null;
  }
}
