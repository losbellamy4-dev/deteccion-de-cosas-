/**
 * EventLog.js — Registro cronológico de eventos (búfer circular) con
 * exportación local a JSON y CSV. Nada sale del navegador: la exportación
 * genera un Blob y lo descarga con un enlace temporal.
 */
import { Emitter } from '../core/Emitter.js';

export class EventLog extends Emitter {
  constructor({ max = 10000 } = {}) {
    super();
    this.max = max;
    this.entries = [];
    this.seq = 0;
    this.t0 = performance.now();
    this.counts = { info: 0, warn: 0, alert: 0, system: 0, error: 0 };
  }

  /**
   * @param {'info'|'warn'|'alert'|'system'|'error'} level
   * @param {string} category  pose | manos | rostro | objetos | movimiento | zona | linea | sistema
   * @param {string} message   texto legible ("Persona #1 — postura: sentada")
   * @param {object} [data]    datos estructurados (IDs, valores) para el JSON/CSV
   * @param {number|null} [media] instante del vídeo en segundos (si aplica)
   */
  add(level, category, message, data = {}, media = null) {
    const now = Date.now();
    const e = {
      seq: ++this.seq,
      iso: new Date(now).toISOString(),
      epoch: now,
      session: +((performance.now() - this.t0) / 1000).toFixed(3),
      media: media == null ? null : +media.toFixed(3),
      level,
      category,
      message,
      data,
    };
    this.entries.push(e);
    if (this.entries.length > this.max) this.entries.splice(0, this.entries.length - this.max);
    this.counts[level] = (this.counts[level] || 0) + 1;
    this.emit('entry', e);
    return e;
  }

  clear() {
    this.entries = [];
    for (const k of Object.keys(this.counts)) this.counts[k] = 0;
    this.emit('clear');
  }

  toJSON() {
    return JSON.stringify({
      app: 'Detéctalo todo',
      exportedAt: new Date().toISOString(),
      count: this.entries.length,
      events: this.entries,
    }, null, 2);
  }

  /**
   * CSV RFC 4180 (coma, comillas dobles, UTF-8 con BOM para que Excel respete
   * los acentos). Las celdas que empiezan por = + - @ se prefijan con un
   * apóstrofo para evitar inyección de fórmulas al abrirlo en una hoja de
   * cálculo (los nombres de zona los escribe el usuario).
   */
  toCSV() {
    const cell = (v) => {
      let s = v == null ? '' : typeof v === 'string' ? v : typeof v === 'object' ? JSON.stringify(v) : String(v);
      if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
      return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const head = ['seq', 'fecha_iso', 'sesion_s', 'video_s', 'nivel', 'categoria', 'mensaje', 'datos'];
    const rows = this.entries.map((e) => [e.seq, e.iso, e.session, e.media, e.level, e.category, e.message, e.data].map(cell).join(','));
    return '﻿' + [head.join(','), ...rows].join('\r\n') + '\r\n';
  }
}
