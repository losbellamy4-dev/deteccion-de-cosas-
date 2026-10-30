/**
 * ZoneManager.js — Zonas de intrusión (polígonos) y tripwires (líneas de
 * cruce) definidas por el usuario sobre el canvas.
 *
 * Geometría en coordenadas normalizadas de la imagen de ORIGEN (no de la
 * pantalla): así las zonas siguen pegadas a la misma región de la escena
 * aunque cambie el tamaño de la ventana o se active el modo espejo.
 *
 *  - Intrusión: una pista entra en una zona cuando su punto de referencia
 *    (los pies de una persona, el centro de un objeto) cae dentro del polígono
 *    durante al menos `dwellSec` (filtra parpadeos en el borde). Se alerta
 *    una vez por entrada y se registra la salida.
 *  - Tripwire: para cada pista se guarda en qué LADO de la línea está, pero
 *    el lado sólo se actualiza cuando el punto se aleja más de una banda de
 *    histéresis (0,4 % del encuadre). Un cruce es un cambio de lado estable
 *    dentro de la extensión del segmento. Así:
 *      · el temblor sobre la línea no genera cruces falsos;
 *      · una pista que NACE encima de la línea no cuenta como cruce;
 *      · un cruce lento (pasos diminutos) no se pierde.
 *    "Entrada" es el sentido de la flecha dibujada (del lado negativo al
 *    positivo del producto vectorial; con y hacia abajo, el positivo es la
 *    derecha visual de A→B); "salida", el contrario.
 */
import { pointInPolygon, cross } from './geometry.js';

const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const ZONE_COLORS = ['#f59e0b', '#a78bfa', '#f472b6', '#2dd4bf', '#fb7185', '#60a5fa'];
const HYST = 0.004;        // banda de histéresis (unidades normalizadas)
const MIN_TRACK_AGE = 0.3; // s desde la confirmación antes de contar cruces

export class ZoneManager {
  constructor() {
    this.zones = [];
    this.lines = [];
    this._seq = 1;
    this.version = 0; // cambia con cualquier modificación visible (para repintar)
  }

  // ---- Edición ---------------------------------------------------------------
  addZone(points) {
    const idx = this.zones.length;
    const used = new Set(this.zones.map((z) => z.name));
    let name = `Zona ${LETTERS[idx % 26]}`;
    for (let k = 0; used.has(name); k++) name = `Zona ${LETTERS[k % 26]}${k >= 26 ? Math.floor(k / 26) : ''}`;
    const z = { id: `z${this._seq++}`, name, color: ZONE_COLORS[idx % ZONE_COLORS.length], points: points.map((p) => ({ x: p.x, y: p.y })), inside: new Map(), occupancy: 0, entries: 0 };
    this.zones.push(z);
    this.version++;
    return z;
  }

  addLine(a, b) {
    const n = this.lines.length + 1;
    const l = { id: `l${this._seq++}`, name: `Línea ${n}`, a: { ...a }, b: { ...b }, countIn: 0, countOut: 0, side: new Map(), last: new Map() };
    this.lines.push(l);
    this.version++;
    return l;
  }

  remove(id) {
    this.zones = this.zones.filter((z) => z.id !== id);
    this.lines = this.lines.filter((l) => l.id !== id);
    this.version++;
  }

  clear() { this.zones = []; this.lines = []; this.version++; }

  flipLine(id) {
    const l = this.lines.find((x) => x.id === id);
    if (!l) return;
    [l.a, l.b] = [l.b, l.a];
    [l.countIn, l.countOut] = [l.countOut, l.countIn];
    for (const [k, v] of l.side) l.side.set(k, -v);
    this.version++;
  }

  resetCounts() {
    for (const l of this.lines) { l.countIn = 0; l.countOut = 0; l.last.clear(); }
    for (const z of this.zones) z.entries = 0;
    this.version++;
  }

  /** Olvida el estado temporal (tras un salto en el vídeo), conservando la geometría. */
  resetState() {
    for (const l of this.lines) { l.side.clear(); l.last.clear(); }
    for (const z of this.zones) { z.inside.clear(); z.occupancy = 0; }
    this.version++;
  }

  // ---- Persistencia (sólo geometría) ------------------------------------------
  toJSON() {
    return {
      zones: this.zones.map((z) => ({ name: z.name, color: z.color, points: z.points })),
      lines: this.lines.map((l) => ({ name: l.name, a: l.a, b: l.b })),
    };
  }

  load(data) {
    this.clear();
    if (!data) return;
    const okPt = (p) => p && Number.isFinite(p.x) && Number.isFinite(p.y);
    for (const z of data.zones || []) {
      if (!Array.isArray(z.points) || z.points.length < 3 || !z.points.every(okPt)) continue;
      const nz = this.addZone(z.points);
      if (z.name) nz.name = String(z.name).slice(0, 40);
      if (z.color) nz.color = String(z.color).slice(0, 20);
    }
    for (const l of data.lines || []) {
      if (!okPt(l.a) || !okPt(l.b)) continue;
      const nl = this.addLine(l.a, l.b);
      if (l.name) nl.name = String(l.name).slice(0, 40);
    }
  }

  // ---- Lógica por frame ----------------------------------------------------------
  /**
   * @param {Array<object>} tracks TODAS las pistas confirmadas vivas (con `ref`, `seenNow`)
   * @param {number} t segundos
   * @param {{dwellSec:number, zones:boolean, lines:boolean}} cfg
   * @returns {Array<object>} eventos {type:'zone_enter'|'zone_exit'|'cross', ...}
   */
  update(tracks, t, cfg) {
    const ev = [];
    const alive = new Set(tracks.map((tr) => tr.id));

    if (cfg.zones) {
      for (const z of this.zones) {
        for (const tr of tracks) {
          if (!tr.seenNow) continue;
          const inPoly = pointInPolygon(tr.ref, z.points);
          let st = z.inside.get(tr.id);
          if (!st) { st = { inside: false, since: t, cand: null }; z.inside.set(tr.id, st); }
          st.kind = tr.kind;
          st.label = tr.label;
          if (inPoly !== st.inside) {
            if (st.cand !== inPoly) { st.cand = inPoly; st.candSince = t; }
            if (t - st.candSince >= cfg.dwellSec) {
              st.inside = inPoly;
              st.cand = null;
              if (inPoly) { st.since = t; z.entries++; ev.push({ type: 'zone_enter', zone: z, track: tr }); }
              else ev.push({ type: 'zone_exit', zone: z, track: tr, dwell: t - st.since });
            }
          } else st.cand = null;
        }
        // Pistas que desaparecen estando dentro: salen de la zona.
        for (const [id, st] of z.inside) {
          if (!alive.has(id)) {
            if (st.inside) ev.push({ type: 'zone_exit', zone: z, track: { id, kind: st.kind, label: st.label }, dwell: t - st.since, lost: true });
            z.inside.delete(id);
          }
        }
        let occ = 0;
        for (const st of z.inside.values()) if (st.inside) occ++;
        z.occupancy = occ;
      }
    }

    if (cfg.lines) {
      for (const l of this.lines) {
        const dx = l.b.x - l.a.x, dy = l.b.y - l.a.y;
        const len = Math.hypot(dx, dy);
        if (len < 1e-6) continue;
        for (const tr of tracks) {
          if (!tr.seenNow) continue;
          const p = tr.ref;
          const d = cross(l.a, l.b, p) / len;                       // distancia con signo
          if (Math.abs(d) <= HYST) continue;                       // dentro de la banda: sin decisión
          const side = d > 0 ? 1 : -1;
          const prev = l.side.get(tr.id);
          l.side.set(tr.id, side);
          if (prev == null || prev === side) continue;
          // Cambio de lado: ¿ocurrió a la altura del segmento (no rodeando un extremo)?
          const proj = ((p.x - l.a.x) * dx + (p.y - l.a.y) * dy) / (len * len);
          if (proj < -0.05 || proj > 1.05) continue;
          if (t - (tr.confirmedAt ?? tr.firstSeen ?? t) < MIN_TRACK_AGE) continue;
          const last = l.last.get(tr.id);
          if (last != null && t - last < 0.8) continue;            // enfriamiento por pista
          l.last.set(tr.id, t);
          const dir = side > 0 ? 'in' : 'out';
          if (dir === 'in') l.countIn++; else l.countOut++;
          ev.push({ type: 'cross', line: l, track: tr, dir });
        }
        for (const id of l.side.keys()) if (!alive.has(id)) l.side.delete(id);
        for (const id of l.last.keys()) if (!alive.has(id)) l.last.delete(id);
      }
    }
    if (ev.length) this.version++;
    return ev;
  }
}
