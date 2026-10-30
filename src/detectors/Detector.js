/**
 * Detector.js — Clase base de los módulos de detección (A–E).
 *
 * Cada detector:
 *  - tiene un estado de carga visible (idle → loading → ready | error | missing);
 *  - declara su cadencia ("1 de cada N frames") y una prioridad para el
 *    planificador del Engine;
 *  - mide por separado la LATENCIA TOTAL de cada inferencia y su COSTE EN EL
 *    HILO PRINCIPAL (la parte síncrona, que es la que puede bajar los FPS de
 *    render). En modelos síncronos (MediaPipe) ambos coinciden; en TF.js la
 *    inferencia es asíncrona y el coste síncrono es mucho menor.
 *  - nunca deja que una excepción rompa el bucle de frames: los errores se
 *    cuentan y, si se repiten, el Engine desactiva el módulo con un mensaje.
 */
import { Ema, RateMeter } from '../core/Stats.js';

export class Detector {
  constructor({ id, letter, name, cadence = 1, priority = 0 }) {
    this.id = id;
    this.letter = letter;
    this.name = name;
    this.cadence = cadence;
    this.priority = priority;
    this.enabled = true;
    this.status = 'idle';
    this.statusDetail = '';
    this.backend = '';
    this.latency = new Ema(0.15);
    this.syncCost = new Ema(0.2);
    this.rate = new RateMeter(2000);
    this.lastRunFrame = -Infinity;
    this.lastEnd = 0;
    this.inFlight = false;
    this.consecutiveErrors = 0;
    this.totalErrors = 0;
    this.lastError = '';
  }

  get ready() { return this.status === 'ready'; }

  setStatus(status, detail = '') {
    this.status = status;
    this.statusDetail = detail;
  }

  /** Carga del modelo (implementada por cada subclase). */
  async load() { throw new Error('load() no implementado'); }

  /** Inferencia sobre `input` (canvas reducido del frame). Puede devolver una Promise. */
  infer() { throw new Error('infer() no implementado'); }

  /** Libera recursos del modelo. */
  dispose() {}

  /**
   * Ejecuta una inferencia midiendo tiempos y capturando errores.
   * @param {HTMLCanvasElement} input
   * @param {{index:number, t:number, gen:number}} frame metadatos del frame
   * @param {(result:any, frame:object, det:Detector)=>void} onResult
   * @param {(error:Error, det:Detector)=>void} onError
   */
  run(input, frame, onResult, onError) {
    const t0 = performance.now();
    this.lastRunFrame = frame.index;
    let out;
    try {
      out = this.infer(input, frame);
    } catch (e) {
      this.syncCost.push(performance.now() - t0);
      this._fail(e, onError);
      return;
    }
    const t1 = performance.now();
    this.syncCost.push(t1 - t0);
    if (out && typeof out.then === 'function') {
      this.inFlight = true;
      out.then(
        (r) => { this.inFlight = false; this._ok(r, performance.now() - t0, frame, onResult); },
        (e) => { this.inFlight = false; this._fail(e, onError); },
      );
    } else {
      this._ok(out, t1 - t0, frame, onResult);
    }
  }

  _ok(result, ms, frame, cb) {
    this.lastEnd = performance.now();
    this.latency.push(ms);
    this.rate.tick();
    this.consecutiveErrors = 0;
    cb(result, frame, this);
  }

  _fail(e, cb) {
    this.lastEnd = performance.now();
    this.consecutiveErrors++;
    this.totalErrors++;
    this.lastError = String(e && e.message ? e.message : e);
    cb(e, this);
  }

  /** Marca de tiempo estrictamente creciente (MediaPipe VIDEO lo exige). */
  nextTimestamp() {
    const now = Math.round(performance.now());
    this._lastTs = Math.max(now, (this._lastTs ?? 0) + 1);
    return this._lastTs;
  }
}
