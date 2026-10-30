/** Emisor de eventos mínimo (on/off/emit) para desacoplar núcleo e interfaz. */
export class Emitter {
  constructor() { this._handlers = new Map(); }

  on(type, fn) {
    if (!this._handlers.has(type)) this._handlers.set(type, new Set());
    this._handlers.get(type).add(fn);
    return () => this.off(type, fn);
  }

  off(type, fn) { this._handlers.get(type)?.delete(fn); }

  emit(type, payload) {
    const hs = this._handlers.get(type);
    if (!hs) return;
    for (const fn of hs) {
      try { fn(payload); } catch (e) { console.error(`[Emitter] error en el manejador de "${type}"`, e); }
    }
  }
}
