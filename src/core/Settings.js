/**
 * Settings.js — Almacén de ajustes con valores por defecto, validación y
 * persistencia en localStorage (sólo comodidad local del navegador; si el
 * almacenamiento no está disponible, la app funciona igual con los valores
 * por defecto).
 */
import { Emitter } from './Emitter.js';

export function safeStorage() {
  return {
    get(key) {
      try { const v = localStorage.getItem(key); return v == null ? null : JSON.parse(v); } catch { return null; }
    },
    set(key, value) {
      try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* sin almacenamiento */ }
    },
    remove(key) {
      try { localStorage.removeItem(key); } catch { /* ignorar */ }
    },
  };
}

export class Settings extends Emitter {
  constructor(schema, storageKey = 'detectalo.settings.v1') {
    super();
    this.schema = new Map(schema.map((s) => [s.key, s]));
    this.key = storageKey;
    this.store = safeStorage();
    this.values = {};
    for (const s of schema) this.values[s.key] = s.def;
    const saved = this.store.get(this.key);
    if (saved && typeof saved === 'object') {
      for (const [k, v] of Object.entries(saved)) if (this.schema.has(k)) this.values[k] = this._coerce(this.schema.get(k), v);
    }
  }

  get(key) { return this.values[key]; }

  set(key, value) {
    const s = this.schema.get(key);
    if (!s) return;
    const v = this._coerce(s, value);
    if (this.values[key] === v) return;
    this.values[key] = v;
    this.store.set(this.key, this.values);
    this.emit('change', { key, value: v, spec: s });
  }

  reset() {
    for (const s of this.schema.values()) this.values[s.key] = s.def;
    this.store.remove(this.key);
    this.emit('reset');
  }

  _coerce(s, v) {
    if (s.type === 'bool') return !!v;
    if (s.type === 'range') {
      const n = Number(v);
      if (!Number.isFinite(n)) return s.def;
      return Math.min(s.max, Math.max(s.min, n));
    }
    if (s.type === 'select') {
      const ok = s.options.some(([val]) => String(val) === String(v));
      return ok ? String(v) : s.def;
    }
    return v;
  }
}
