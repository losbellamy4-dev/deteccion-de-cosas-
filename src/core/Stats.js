/** Media móvil exponencial simple (para latencias por modelo). */
export class Ema {
  constructor(alpha = 0.1) { this.a = alpha; this.v = null; }
  push(x) { this.v = this.v == null ? x : this.v + this.a * (x - this.v); return this.v; }
  get value() { return this.v ?? 0; }
  get has() { return this.v != null; }
  reset() { this.v = null; }
}

/**
 * Medidor de frecuencia por ventana deslizante: cuenta eventos en los últimos
 * `windowMs` milisegundos. Se usa para FPS de render, FPS de análisis y Hz por
 * modelo (cifras reales medidas, no estimadas).
 */
export class RateMeter {
  constructor(windowMs = 1000) { this.w = windowMs; this.ts = []; }
  tick(now = performance.now()) { this.ts.push(now); this._trim(now); }
  _trim(now) { while (this.ts.length && this.ts[0] < now - this.w) this.ts.shift(); }
  rate(now = performance.now()) {
    this._trim(now);
    return (this.ts.length * 1000) / this.w;
  }
  reset() { this.ts = []; }
}
