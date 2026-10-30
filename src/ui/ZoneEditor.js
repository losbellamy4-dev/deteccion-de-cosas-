/**
 * ZoneEditor.js — Dibujo y edición de zonas (polígonos) y líneas de cruce
 * directamente sobre el canvas del overlay.
 *
 *  - Modo «zona»: cada clic añade un vértice; se cierra con doble clic, Intro
 *    o clic sobre el primer vértice. Retroceso borra el último; Esc cancela.
 *  - Modo «línea»: dos clics (inicio y fin). La flecha indica el sentido de
 *    «entrada» (se puede invertir).
 *  - Sin modo: clic para seleccionar y arrastrar vértices/extremos.
 * Las coordenadas se guardan normalizadas respecto a la imagen de origen.
 */
import { pointInPolygon, pointSegmentDistance } from '../analytics/geometry.js';

export class ZoneEditor {
  constructor({ canvas, stage, renderer, engine, zones, hintEl, onChange, onSelect, onCreate }) {
    Object.assign(this, { canvas, stage, renderer, engine, zones, hintEl, onChange, onSelect, onCreate });
    this.ed = engine.editor;
    this.dragging = null;
    canvas.addEventListener('pointerdown', (e) => this._down(e));
    canvas.addEventListener('pointermove', (e) => this._move(e));
    canvas.addEventListener('pointerup', (e) => this._up(e));
    canvas.addEventListener('pointercancel', () => { this.dragging = null; });
    canvas.addEventListener('dblclick', (e) => { e.preventDefault(); if (this.ed.mode === 'zone') this.finishZone(true); });
    canvas.addEventListener('pointerleave', () => { this.ed.cursor = null; });
  }

  get mode() { return this.ed.mode; }

  setMode(mode) {
    this.ed.mode = mode;
    this.ed.points = [];
    this.ed.a = null;
    this.ed.cursor = null;
    this.stage.classList.toggle('drawing', !!mode);
    if (mode) this.select(null);
    this._hint();
  }

  cancel() {
    if (this.ed.mode) this.setMode(null);
    else this.select(null);
  }

  select(id) {
    this.ed.selected = id;
    if (this.onSelect) this.onSelect(id);
  }

  undoPoint() {
    if (this.ed.mode === 'zone' && this.ed.points.length) {
      this.ed.points.pop();
      this._hint();
    }
  }

  finishZone(fromDblClick = false) {
    const pts = this.ed.points;
    // El doble clic genera además dos clics: quita el vértice duplicado.
    if (fromDblClick && pts.length >= 2) {
      const a = pts[pts.length - 1], b = pts[pts.length - 2];
      if (Math.hypot(a.x - b.x, a.y - b.y) < 0.01) pts.pop();
    }
    if (pts.length < 3) { this._hint('Una zona necesita al menos 3 vértices.'); return; }
    const z = this.zones.addZone(pts);
    this.setMode(null);
    this.select(z.id);
    if (this.onCreate) this.onCreate(z, 'zone');
    this.onChange();
  }

  _pt(e) {
    const r = this.canvas.getBoundingClientRect();
    const p = this.renderer.unmap(e.clientX - r.left, e.clientY - r.top);
    return { x: Math.min(1, Math.max(0, p.x)), y: Math.min(1, Math.max(0, p.y)), cssX: e.clientX - r.left, cssY: e.clientY - r.top };
  }

  _down(e) {
    if (e.button !== 0) return;
    const p = this._pt(e);
    const ed = this.ed;
    if (ed.mode === 'zone') {
      if (ed.points.length >= 3 && this.renderer.cssDistance(ed.points[0], p.cssX, p.cssY) < 12) { this.finishZone(); return; }
      ed.points.push({ x: p.x, y: p.y });
      this._hint();
      return;
    }
    if (ed.mode === 'line') {
      if (!ed.a) { ed.a = { x: p.x, y: p.y }; this._hint(); return; }
      if (this.renderer.cssDistance(ed.a, p.cssX, p.cssY) < 10) return;
      const l = this.zones.addLine(ed.a, { x: p.x, y: p.y });
      this.setMode(null);
      this.select(l.id);
      if (this.onCreate) this.onCreate(l, 'line');
      this.onChange();
      return;
    }
    // Selección / arrastre de vértices.
    const hit = this._hitHandle(p);
    if (hit) {
      this.select(hit.id);
      this.dragging = hit;
      this.canvas.setPointerCapture(e.pointerId);
      return;
    }
    const sel = this._hitShape(p);
    this.select(sel);
  }

  _move(e) {
    const p = this._pt(e);
    this.ed.cursor = { x: p.x, y: p.y };
    if (!this.dragging) return;
    const d = this.dragging;
    if (d.type === 'zone') {
      const z = this.zones.zones.find((x) => x.id === d.id);
      if (z) z.points[d.index] = { x: p.x, y: p.y };
    } else {
      const l = this.zones.lines.find((x) => x.id === d.id);
      if (l) l[d.end] = { x: p.x, y: p.y };
    }
  }

  _up() {
    if (this.dragging) {
      this.dragging = null;
      this.onChange();
    }
  }

  _hitHandle(p) {
    const R = 10;
    const order = [...this.zones.zones.map((z) => ({ z })), ...this.zones.lines.map((l) => ({ l }))];
    // Prioriza los manejadores del elemento seleccionado.
    order.sort((a, b) => ((b.z || b.l).id === this.ed.selected) - ((a.z || a.l).id === this.ed.selected));
    for (const it of order) {
      if (it.z) {
        for (let i = 0; i < it.z.points.length; i++) {
          if (this.renderer.cssDistance(it.z.points[i], p.cssX, p.cssY) < R) return { type: 'zone', id: it.z.id, index: i };
        }
      } else {
        for (const end of ['a', 'b']) {
          if (this.renderer.cssDistance(it.l[end], p.cssX, p.cssY) < R) return { type: 'line', id: it.l.id, end };
        }
      }
    }
    return null;
  }

  _hitShape(p) {
    for (const l of this.zones.lines) {
      // Distancia en píxeles CSS al segmento (aprox. con el viewport actual).
      const A = { x: this.renderer.X(l.a.x) / this.renderer.dpr, y: this.renderer.Y(l.a.y) / this.renderer.dpr };
      const B = { x: this.renderer.X(l.b.x) / this.renderer.dpr, y: this.renderer.Y(l.b.y) / this.renderer.dpr };
      if (pointSegmentDistance({ x: p.cssX, y: p.cssY }, A, B) < 8) return l.id;
    }
    for (let i = this.zones.zones.length - 1; i >= 0; i--) {
      const z = this.zones.zones[i];
      if (pointInPolygon(p, z.points)) return z.id;
    }
    return null;
  }

  _hint(msg) {
    const ed = this.ed;
    let text = msg || '';
    if (!text && ed.mode === 'zone') {
      text = ed.points.length < 3
        ? `Zona: clic para añadir vértices (${ed.points.length}/3 mín.) · Esc cancela`
        : 'Zona: doble clic, Intro o clic en el primer vértice para cerrar · Retroceso deshace';
    } else if (!text && ed.mode === 'line') {
      text = ed.a ? 'Línea: clic en el punto final' : 'Línea: clic en el punto inicial · Esc cancela';
    }
    this.hintEl.textContent = text;
    this.hintEl.hidden = !text;
  }
}
