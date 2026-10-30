/**
 * WorkerDetector.js — Representante, en el hilo principal, de un modelo que
 * se ejecuta dentro de un Web Worker (ver workers/inference.worker.js).
 *
 * Para el Engine es un detector más con inferencia ASÍNCRONA: `infer()` crea
 * un ImageBitmap del lienzo de entrada (la copia se toma en el acto, así que
 * el lienzo puede reutilizarse en el frame siguiente), lo TRANSFIERE al worker
 * sin copiar y devuelve una Promise con el resultado. El coste en el hilo
 * principal es ~1 ms, independientemente de lo que tarde el modelo.
 */
import { Detector } from './Detector.js';
import { HeatPainter, MOTION_W } from './MotionDetector.js';

export class WorkerDetector extends Detector {
  constructor(meta) {
    super(meta);
    this.worker = null;
    this.seq = 0;
    this.pending = new Map();
    this.connections = meta.connections || [];
    this.memory = null;
    this.workerMs = 0;
    this.isWorker = true;
  }

  /**
   * Arranca el worker y le envía la configuración del modelo.
   * @param {object} init      mensaje de inicialización (ver protocolo del worker)
   * @param {Transferable[]} transfer  buffers a transferir (bytes del modelo)
   * @param {(f:number)=>void} [onProgress]
   * @returns {Promise<object>} mensaje "ready"
   */
  start(init, transfer = [], onProgress) {
    this.dispose();
    this.setStatus('loading');
    return new Promise((resolve, reject) => {
      let w;
      try {
        w = new Worker(new URL('../workers/inference.worker.js', import.meta.url));
      } catch (e) {
        reject(e);
        return;
      }
      this.worker = w;
      let settled = false;
      w.onmessage = (e) => {
        const m = e.data;
        if (m.type === 'ready') {
          settled = true;
          this.backend = `${m.backend} · worker`;
          this.delegate = m.delegate || null;
          this.tfBackend = m.tfBackend || null;
          if (m.connections) this.connections = m.connections;
          this.setStatus('ready');
          resolve(m);
        } else if (m.type === 'progress') {
          if (onProgress) onProgress(m.fraction);
        } else if (m.type === 'result' || m.type === 'done') {
          if (m.mem) this.memory = m.mem;
          if (m.ms) this.workerMs = m.ms;
          const p = this.pending.get(m.seq);
          if (p) { this.pending.delete(m.seq); p.resolve(m.result); }
        } else if (m.type === 'error') {
          const err = new Error(m.message);
          const p = m.seq != null ? this.pending.get(m.seq) : null;
          if (p) { this.pending.delete(m.seq); p.reject(err); }
          else if (!settled) { settled = true; reject(err); }
          else console.warn(`[worker ${this.id}]`, m.message);
        }
      };
      w.onerror = (e) => {
        if (e.preventDefault) e.preventDefault();
        const err = new Error(e.message || 'error en el worker');
        if (!settled) { settled = true; reject(err); }
        for (const p of this.pending.values()) p.reject(err);
        this.pending.clear();
      };
      w.postMessage({ type: 'init', ...init }, transfer);
    });
  }

  infer(input, frame) {
    const opts = this.minScore != null ? { minScore: this.minScore, maxResults: this.maxResults } : null;
    return createImageBitmap(input).then((bitmap) => this._send({ type: 'infer', bitmap, t: frame.t, opts }, [bitmap]));
  }

  _send(msg, transfer = []) {
    if (!this.worker) return Promise.reject(new Error('worker no iniciado'));
    return new Promise((resolve, reject) => {
      const seq = ++this.seq;
      this.pending.set(seq, { resolve, reject });
      this.worker.postMessage({ ...msg, seq }, transfer);
    });
  }

  call(method, ...args) { return this._send({ type: 'call', method, args }); }
  setNumPoses(n) { return this.call('setNumPoses', n); }
  setNumHands(n) { return this.call('setNumHands', n); }
  setNumFaces(n) { return this.call('setNumFaces', n); }

  dispose() {
    if (this.worker) this.worker.terminate();
    this.worker = null;
    for (const p of this.pending.values()) p.reject(new Error('worker cerrado'));
    this.pending.clear();
    this.inFlight = false;
  }
}

/**
 * Módulo E en worker: el fotograma se reduce a 128 px en la propia GPU
 * (createImageBitmap con resize) y la lectura de píxeles ocurre en el worker.
 * El hilo principal sólo recibe la energía y el heatmap (36 KB transferidos).
 */
export class MotionWorkerDetector extends WorkerDetector {
  constructor() {
    super({ id: 'motion', letter: 'E', name: 'Movimiento', cadence: 2, priority: 0 });
    this.painter = new HeatPainter();
    this.version = 0;
    this.last = null;
  }

  async load() {
    await this.start({ kind: 'motion' });
  }

  infer(input, frame) {
    const w = MOTION_W;
    const h = Math.max(8, Math.round((w * input.height) / Math.max(1, input.width)));
    return createImageBitmap(input, { resizeWidth: w, resizeHeight: h, resizeQuality: 'low' })
      .then((bitmap) => this._send({ type: 'infer', bitmap, t: frame.t, w, h }, [bitmap]))
      .then((r) => {
        this.last = r;
        this.version++;
        return { energy: r.energy, w: r.w, h: r.h };
      });
  }

  reset() {
    this.last = null;
    this.version++;
    if (this.worker) this.call('reset').catch(() => {});
  }

  paintHeat() {
    return this.last ? this.painter.paint(this.last.heat, this.last.w, this.last.h, this.version) : null;
  }
}
