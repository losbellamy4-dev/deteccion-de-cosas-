/**
 * AlertManager.js — Centraliza las alertas (intrusión, caída, inmovilidad,
 * somnolencia, anomalía de movimiento, proximidad…):
 *  - aplica un ENFRIAMIENTO por clave (p. ej. "caida:3") para no repetir la
 *    misma alerta en bucle;
 *  - la registra en el EventLog con nivel "alert";
 *  - la mantiene "activa" unos segundos para que el Renderer la pinte en el
 *    canvas (banner, borde rojo y anillo sobre la entidad);
 *  - opcionalmente emite un pitido sintetizado con WebAudio (sin archivos de
 *    sonido, nada que descargar).
 */
import { Emitter } from '../core/Emitter.js';

export const ALERT_CATEGORY = {
  intrusion: 'zona',
  fall: 'pose',
  immobility: 'pose',
  drowsiness: 'rostro',
  motion: 'movimiento',
  proximity: 'distancia',
};

export class AlertManager extends Emitter {
  constructor(eventLog, { cooldownSec = 6, ttlSec = 5 } = {}) {
    super();
    this.log = eventLog;
    this.cooldown = cooldownSec;
    this.ttl = ttlSec;
    this.active = [];
    this.last = new Map();
    this.counts = {};
    this.total = 0;
    this.sound = false;
    this._audio = null;
    this._seq = 0;
  }

  /**
   * @param {object} a
   * @param {string} a.key      clave de enfriamiento (tipo + entidad)
   * @param {string} a.type     intrusion | fall | immobility | drowsiness | motion | proximity
   * @param {string} a.message  texto para log y banner
   * @param {object} [a.track]  pista asociada (para resaltarla en el canvas)
   * @param {object} [a.data]   datos estructurados para el log
   * @param {number|null} [a.media] instante del vídeo
   * @param {number} [a.cooldown] enfriamiento específico (s)
   * @returns {boolean} true si se emitió (false si estaba en enfriamiento)
   */
  raise(a) {
    const now = performance.now() / 1000;
    const cd = a.cooldown ?? this.cooldown;
    const prev = this.last.get(a.key);
    if (prev != null && now - prev < cd) return false;
    this.last.set(a.key, now);
    const alert = {
      id: ++this._seq,
      key: a.key,
      type: a.type,
      message: a.message,
      trackId: a.track ? a.track.id : null,
      kind: a.track ? a.track.kind : null,
      t0: now,
      ttl: this.ttl,
    };
    this.active.push(alert);
    this.counts[a.type] = (this.counts[a.type] || 0) + 1;
    this.total++;
    this.log.add('alert', ALERT_CATEGORY[a.type] || 'alerta', a.message, { type: a.type, ...(a.data || {}) }, a.media ?? null);
    this.emit('alert', alert);
    if (this.sound) this._beep(a.type);
    return true;
  }

  /** Elimina alertas caducadas. Se llama una vez por frame de render. */
  tick() {
    const now = performance.now() / 1000;
    if (this.active.length) this.active = this.active.filter((x) => now - x.t0 < x.ttl);
  }

  isTrackAlerted(id, kind) {
    return this.active.some((a) => a.trackId === id && (kind == null || a.kind === kind));
  }

  reset() {
    this.active = [];
    this.last.clear();
  }

  /** El navegador sólo permite audio tras un gesto del usuario: se llama desde un clic. */
  unlockAudio() {
    try {
      if (!this._audio) {
        const Ctx = window.AudioContext || window.webkitAudioContext;
        if (Ctx) this._audio = new Ctx();
      }
      if (this._audio && this._audio.state === 'suspended') this._audio.resume();
    } catch { /* sin audio: no es crítico */ }
  }

  _beep(type) {
    const ctx = this._audio;
    if (!ctx || ctx.state !== 'running') return;
    try {
      const t = ctx.currentTime;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'square';
      osc.frequency.setValueAtTime(type === 'fall' ? 880 : 660, t);
      osc.frequency.setValueAtTime(type === 'fall' ? 660 : 880, t + 0.12);
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(0.08, t + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.3);
      osc.connect(gain).connect(ctx.destination);
      osc.start(t);
      osc.stop(t + 0.32);
    } catch { /* ignorar */ }
  }
}
