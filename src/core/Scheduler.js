/**
 * Scheduler.js — Planificador de inferencias y control de carga adaptativo.
 *
 * PLANIFICADOR (por cada fotograma de vídeo nuevo):
 *  - Un modelo "toca" cuando han pasado al menos cadencia × multiplicador
 *    frames desde su última ejecución ("1 de cada N").
 *  - Entre los que tocan, se ordena por URGENCIA = frames de retraso /
 *    periodo. Así ningún modelo se queda sin turno (inanición): cuanto más
 *    espera, más urgente se vuelve.
 *  - Se ejecutan en orden mientras el coste estimado en hilo principal (EMA
 *    medida de cada modelo) quepa en el PRESUPUESTO por frame. El primero se
 *    ejecuta siempre. Lo que no cabe se queda para el frame siguiente: el
 *    análisis se reparte en el tiempo en vez de congelar un frame.
 *  - Modelos en Web Worker: apenas cuestan en el hilo principal, pero sí CPU.
 *    Se limita cuántos infieren a la vez (núcleos − 2, para dejar sitio al
 *    render, la decodificación de vídeo y el compositor) y, al degradar, se
 *    impone un hueco tras cada inferencia proporcional a su latencia (ciclo
 *    de trabajo < 100 %), de modo que la CPU vuelva a quedar libre.
 *
 * CONTROL ADAPTATIVO (cada 0,5 s):
 *  - Si los FPS de RENDER medidos caen por debajo del umbral, sube un nivel de
 *    degradación: reduce la resolución de inferencia y multiplica las
 *    cadencias (salta frames de análisis).
 *  - Si sobran FPS (umbral × 1,35 + 2) durante 3 s, recupera un nivel.
 *  - Histéresis temporal (1 s para degradar, 3 s para recuperar) para no
 *    oscilar. El nivel actual se muestra en la interfaz.
 */

export class Scheduler {
  /**
   * @param {Array<import('../detectors/Detector.js').Detector>} detectors
   * @param {number} frameIndex índice del frame de vídeo actual
   * @param {{budgetMs:number, multiplier:number}} o
   */
  select(detectors, frameIndex, { budgetMs, multiplier, maxConcurrent = Infinity, gapFactor = 0, now = performance.now() }) {
    const due = [];
    let busyWorkers = 0;
    for (const d of detectors) if (d.inFlight && d.isWorker) busyWorkers++;
    for (const d of detectors) {
      if (!d.enabled || !d.ready || d.inFlight) continue;
      const period = Math.max(1, Math.round(d.cadence * multiplier));
      const since = frameIndex - d.lastRunFrame;
      if (since < period) continue;
      if (gapFactor > 0 && d.latency.has && now - d.lastEnd < d.latency.value * gapFactor) continue;
      due.push({ d, urgency: since / period });
    }
    due.sort((a, b) => b.urgency - a.urgency || b.d.priority - a.d.priority);
    const out = [];
    let est = 0;
    for (const { d } of due) {
      if (d.isWorker) {
        if (busyWorkers >= maxConcurrent) continue;
        busyWorkers++;
      }
      const cost = d.syncCost.has ? d.syncCost.value : 8;
      if (out.length === 0 || est + cost <= budgetMs) {
        out.push(d);
        est += cost;
      }
    }
    return out;
  }
}

/** scale: resolución de inferencia · mult: cadencias · gap: hueco tras cada inferencia (× latencia) · drop: workers simultáneos menos. */
export const ADAPTIVE_LEVELS = [
  { scale: 1.0, mult: 1, gap: 0, drop: 0 },
  { scale: 0.8, mult: 1, gap: 0, drop: 0 },
  { scale: 0.7, mult: 2, gap: 0.25, drop: 0 },
  { scale: 0.55, mult: 2, gap: 0.5, drop: 1 },
  { scale: 0.45, mult: 3, gap: 1, drop: 2 },
  { scale: 0.4, mult: 4, gap: 2, drop: 3 },
];

export class AdaptiveController {
  constructor() {
    this.level = 0;
    this.lastCheck = 0;
    this.lastChange = 0;
    this.holdUntil = 0;
  }

  get scale() { return ADAPTIVE_LEVELS[this.level].scale; }
  get multiplier() { return ADAPTIVE_LEVELS[this.level].mult; }
  get gapFactor() { return ADAPTIVE_LEVELS[this.level].gap; }
  get concurrencyDrop() { return ADAPTIVE_LEVELS[this.level].drop; }
  get maxLevel() { return ADAPTIVE_LEVELS.length - 1; }

  /** Pausa las decisiones un tiempo (p. ej. tras volver de una pestaña oculta). */
  hold(ms, now = performance.now()) { this.holdUntil = Math.max(this.holdUntil, now + ms); }

  reset() { this.level = 0; this.lastChange = 0; }

  /**
   * @param {number} now ms
   * @param {number} fps FPS de render medidos en el último segundo
   * @param {{enabled:boolean, target:number, active:boolean}} o
   * @returns {'down'|'up'|null} cambio aplicado
   */
  update(now, fps, { enabled, target, active }) {
    if (!enabled) {
      if (this.level !== 0) { this.level = 0; return 'up'; }
      return null;
    }
    if (!active || now < this.holdUntil || now - this.lastCheck < 500) return null;
    this.lastCheck = now;
    if (fps < target && this.level < this.maxLevel && now - this.lastChange > 1000) {
      this.level++;
      this.lastChange = now;
      return 'down';
    }
    if (fps > target * 1.35 + 2 && this.level > 0 && now - this.lastChange > 3000) {
      this.level--;
      this.lastChange = now;
      return 'up';
    }
    return null;
  }
}
