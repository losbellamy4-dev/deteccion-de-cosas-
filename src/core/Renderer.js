/**
 * Renderer.js — Pintado del overlay sobre el vídeo.
 *
 * Arquitectura de render:
 *  - El <video> se muestra tal cual (lo compone el navegador por su cuenta, así
 *    que el vídeo siempre se ve fluido aunque el análisis vaya más lento).
 *  - Encima hay un <canvas> transparente del mismo tamaño, redimensionado con
 *    ResizeObserver y escalado por devicePixelRatio (máx. 2) para que líneas y
 *    textos sean nítidos en pantallas HiDPI.
 *  - Todas las detecciones llegan en coordenadas NORMALIZADAS de la imagen de
 *    origen; aquí se transforman al rectángulo real del vídeo dentro del lienzo
 *    (equivalente a object-fit: contain). El modo espejo se aplica en esa
 *    transformación (x → 1 − x) en lugar de voltear el canvas con CSS, para que
 *    los textos no salgan al revés.
 *  - La misma función de dibujo sirve para la pantalla y para exportar una
 *    captura PNG a resolución nativa (otro "destino" con su propio viewport).
 *
 * Orden de capas: heatmap → zonas/líneas → estelas → objetos → personas →
 * manos → rostros → distancias → visor del escáner → alertas → editor → HUD.
 */
import { JOINT_ANGLES, POSTURE_LABEL } from '../analytics/PoseAnalytics.js';
import { polygonCentroid } from '../analytics/geometry.js';
import { gazeLabel, turnLabel } from '../analytics/FaceAnalytics.js';

const MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace';
const HAND_COLORS = { derecha: '#22d3ee', izquierda: '#f472b6' };
const FINGERTIPS = [4, 8, 12, 16, 20];

/** Color por certeza: rojo (baja) → amarillo → verde (alta). */
export const confColor = (v) => `hsl(${Math.round(Math.max(0, Math.min(1, v)) * 125)} 90% 55%)`;

export class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.dpr = 1;
    this.t = { ctx: this.ctx, vp: { x: 0, y: 0, w: 1, h: 1 }, mirror: false, k: 1, W: 1, H: 1 };
    this.sourceSize = { w: 0, h: 0 };
    if (typeof ResizeObserver !== 'undefined') {
      this._ro = new ResizeObserver(() => this.resize());
      this._ro.observe(canvas);
    }
    this.resize();
  }

  resize() {
    const r = this.canvas.getBoundingClientRect();
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = Math.max(1, Math.round(r.width * dpr));
    const h = Math.max(1, Math.round(r.height * dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    this.dpr = dpr;
  }

  static fitContain(cw, ch, vw, vh) {
    if (!vw || !vh) {
      // Sin fuente: lienzo 16:9 centrado (permite dibujar zonas de antemano).
      vw = 16; vh = 9;
    }
    const s = Math.min(cw / vw, ch / vh);
    const w = vw * s, h = vh * s;
    return { x: (cw - w) / 2, y: (ch - h) / 2, w, h };
  }

  /** Prepara el destino de pantalla para el frame actual. */
  setFrame(vw, vh, mirror) {
    this.sourceSize = { w: vw, h: vh };
    this.t = {
      ctx: this.ctx,
      vp: Renderer.fitContain(this.canvas.width, this.canvas.height, vw, vh),
      mirror,
      k: this.dpr,
      W: this.canvas.width,
      H: this.canvas.height,
    };
  }

  /** Coordenadas CSS del puntero → coordenadas normalizadas de la imagen. */
  unmap(cssX, cssY) {
    const { vp, mirror } = this.t;
    const px = cssX * this.dpr, py = cssY * this.dpr;
    let x = (px - vp.x) / vp.w;
    const y = (py - vp.y) / vp.h;
    if (mirror) x = 1 - x;
    return { x, y };
  }

  /** Distancia en píxeles CSS entre un punto normalizado y un punto CSS. */
  cssDistance(p, cssX, cssY) {
    return Math.hypot(this.X(p.x) / this.dpr - cssX, this.Y(p.y) / this.dpr - cssY);
  }

  X(x) { const { vp, mirror } = this.t; return vp.x + (mirror ? 1 - x : x) * vp.w; }
  Y(y) { const { vp } = this.t; return vp.y + y * vp.h; }

  // ---------------------------------------------------------------------------
  // Entrada principal
  // ---------------------------------------------------------------------------

  /**
   * @param {object} scene  entidades del Engine (persons, objects, hands, faces, motion, distances)
   * @param {object} o      opciones: layers, zones, editor, alerts, hud, connections, settings
   */
  draw(scene, o) {
    const { ctx } = this.t;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.t.W, this.t.H);
    if (!o.hasSource && !o.zones.zones.length && !o.zones.lines.length && !o.editor.mode) return;
    this.drawScene(scene, o);
  }

  drawScene(scene, o) {
    const L = o.layers;
    // Entidades no vistas en la última inferencia: atenuadas; si llevan más de
    // 1,2 s sin verse (análisis muy degradado), ocultas. En pausa se muestra
    // siempre el último resultado.
    const fresh = (tr) => o.paused || tr.seenNow || o.now - (tr.lastSeenWall || 0) < 1200;
    scene = {
      ...scene,
      persons: scene.persons.filter(fresh),
      objects: scene.objects.filter(fresh),
      hands: scene.hands.filter(fresh),
      faces: scene.faces.filter(fresh),
    };
    if (L.heatmap && scene.motionCanvas) this._heatmap(scene.motionCanvas);
    if (L.zones || L.lines || o.editor.mode) this._zones(o);
    if (L.trails) this._trails([...scene.persons, ...scene.objects]);
    const tentative = scene.tentative || [];
    if (L.objects) this._objects([...scene.objects, ...tentative.filter((t) => t.kind === 'object')], o);
    const tp = tentative.filter((t) => t.kind === 'person');
    if (L.pose || scene.persons.length || tp.length) this._persons([...scene.persons, ...tp], o);
    if (L.hands) this._hands(scene.hands, o);
    if (L.face) this._faces(scene.faces, o);
    if (L.distances) this._distances(scene.distances);
    if (o.reticle) this._reticle(o.reticle, o);
    this._alerts(scene, o);
    if (o.editor.mode || o.editor.selected) this._editor(o);
    if (L.hud && o.hud) this._hud(o.hud);
  }

  // ---------------------------------------------------------------------------
  // Primitivas
  // ---------------------------------------------------------------------------

  _rect(b) {
    const x0 = this.X(b.x), x1 = this.X(b.x + b.w);
    return { x: Math.min(x0, x1), y: this.Y(b.y), w: Math.abs(x1 - x0), h: b.h * this.t.vp.h };
  }

  _line(a, b) {
    const { ctx } = this.t;
    ctx.beginPath();
    ctx.moveTo(this.X(a.x), this.Y(a.y));
    ctx.lineTo(this.X(b.x), this.Y(b.y));
    ctx.stroke();
  }

  _dot(p, r, fill, stroke) {
    const { ctx } = this.t;
    ctx.beginPath();
    ctx.arc(this.X(p.x), this.Y(p.y), r, 0, Math.PI * 2);
    ctx.fillStyle = fill;
    ctx.fill();
    if (stroke) { ctx.strokeStyle = stroke; ctx.stroke(); }
  }

  /** Etiqueta con fondo (legible sobre cualquier vídeo). */
  _tag(text, x, y, { color = '#e5f6ff', bg = 'rgba(4,10,16,0.82)', align = 'left', size = 12, border = null } = {}) {
    const { ctx, k, W, H } = this.t;
    ctx.font = `600 ${Math.round(size * k)}px ${MONO}`;
    const pad = 4 * k;
    const w = ctx.measureText(text).width + pad * 2;
    const h = (size + 7) * k;
    let x0 = align === 'center' ? x - w / 2 : align === 'right' ? x - w : x;
    let y0 = y - h;
    x0 = Math.max(2, Math.min(W - w - 2, x0));
    y0 = Math.max(2, Math.min(H - h - 2, y0));
    ctx.fillStyle = bg;
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(x0, y0, w, h, 3 * k); else ctx.rect(x0, y0, w, h);
    ctx.fill();
    if (border) { ctx.strokeStyle = border; ctx.lineWidth = 1.5 * k; ctx.stroke(); }
    ctx.fillStyle = color;
    ctx.textBaseline = 'alphabetic';
    ctx.fillText(text, x0 + pad, y0 + h - 5.5 * k);
    return { x: x0, y: y0, w, h };
  }

  /** Esquinas tipo "visor" alrededor de una caja. */
  _brackets(r, color, lw) {
    const { ctx } = this.t;
    const c = Math.max(6, Math.min(r.w, r.h) * 0.22);
    ctx.strokeStyle = color;
    ctx.lineWidth = lw;
    ctx.beginPath();
    ctx.moveTo(r.x, r.y + c); ctx.lineTo(r.x, r.y); ctx.lineTo(r.x + c, r.y);
    ctx.moveTo(r.x + r.w - c, r.y); ctx.lineTo(r.x + r.w, r.y); ctx.lineTo(r.x + r.w, r.y + c);
    ctx.moveTo(r.x + r.w, r.y + r.h - c); ctx.lineTo(r.x + r.w, r.y + r.h); ctx.lineTo(r.x + r.w - c, r.y + r.h);
    ctx.moveTo(r.x + c, r.y + r.h); ctx.lineTo(r.x, r.y + r.h); ctx.lineTo(r.x, r.y + r.h - c);
    ctx.stroke();
  }

  // ---------------------------------------------------------------------------
  // Capas
  // ---------------------------------------------------------------------------

  _heatmap(heat) {
    const { ctx, vp, mirror } = this.t;
    ctx.save();
    ctx.globalAlpha = 0.7;
    ctx.imageSmoothingEnabled = true;
    if (mirror) {
      ctx.translate(vp.x + vp.w, vp.y);
      ctx.scale(-1, 1);
      ctx.drawImage(heat, 0, 0, vp.w, vp.h);
    } else {
      ctx.drawImage(heat, vp.x, vp.y, vp.w, vp.h);
    }
    ctx.restore();
  }

  _zones(o) {
    const { ctx, k } = this.t;
    const Z = o.zones;
    const alertedZones = new Set(o.alerts.filter((a) => a.type === 'intrusion').map((a) => a.key.split(':')[1]));
    if (o.layers.zones || o.editor.mode) {
      for (const z of Z.zones) {
        if (z.points.length < 3) continue;
        const hot = alertedZones.has(z.id);
        ctx.beginPath();
        z.points.forEach((p, i) => (i ? ctx.lineTo(this.X(p.x), this.Y(p.y)) : ctx.moveTo(this.X(p.x), this.Y(p.y))));
        ctx.closePath();
        ctx.globalAlpha = hot ? 0.28 + 0.12 * Math.sin(performance.now() / 120) : z.occupancy ? 0.2 : 0.1;
        ctx.fillStyle = hot ? '#f43f5e' : z.color;
        ctx.fill();
        ctx.globalAlpha = 1;
        ctx.lineWidth = (o.editor.selected === z.id ? 3 : 2) * k;
        ctx.strokeStyle = hot ? '#f43f5e' : z.color;
        ctx.setLineDash(o.editor.selected === z.id ? [6 * k, 4 * k] : []);
        ctx.stroke();
        ctx.setLineDash([]);
        const c = polygonCentroid(z.points);
        this._tag(`${z.name}${z.occupancy ? ` · ${z.occupancy} dentro` : ''}`, this.X(c.x), this.Y(c.y), { color: hot ? '#fff' : z.color, align: 'center', bg: hot ? 'rgba(127,16,38,0.85)' : undefined });
      }
    }
    if (o.layers.lines || o.editor.mode) {
      for (const l of Z.lines) {
        const sel = o.editor.selected === l.id;
        ctx.strokeStyle = '#38bdf8';
        ctx.lineWidth = (sel ? 4 : 3) * k;
        this._line(l.a, l.b);
        this._dot(l.a, 4 * k, '#38bdf8');
        this._dot(l.b, 4 * k, '#38bdf8');
        // Flecha de ENTRADA: normal a la derecha visual de A→B (ver ZoneManager).
        const ax = this.X(l.a.x), ay = this.Y(l.a.y), bx = this.X(l.b.x), by = this.Y(l.b.y);
        const mx = (ax + bx) / 2, my = (ay + by) / 2;
        let nx = -(by - ay), ny = bx - ax;
        if (this.t.mirror) { nx = -nx; ny = -ny; }
        const nl = Math.hypot(nx, ny) || 1;
        nx /= nl; ny /= nl;
        const len = 26 * k;
        ctx.strokeStyle = '#a7f3d0';
        ctx.fillStyle = '#a7f3d0';
        ctx.lineWidth = 2.5 * k;
        ctx.beginPath();
        ctx.moveTo(mx - nx * len * 0.4, my - ny * len * 0.4);
        ctx.lineTo(mx + nx * len, my + ny * len);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(mx + nx * len, my + ny * len);
        ctx.lineTo(mx + nx * (len - 9 * k) - ny * 6 * k, my + ny * (len - 9 * k) + nx * 6 * k);
        ctx.lineTo(mx + nx * (len - 9 * k) + ny * 6 * k, my + ny * (len - 9 * k) - nx * 6 * k);
        ctx.closePath();
        ctx.fill();
        this._tag(`${l.name}  ↘ent ${l.countIn} · sal ${l.countOut}`, mx - nx * 14 * k, my - ny * 14 * k, { color: '#bae6fd', align: 'center' });
      }
    }
  }

  _trails(tracks) {
    const { ctx, k } = this.t;
    ctx.lineCap = 'round';
    for (const tr of tracks) {
      const h = tr.history;
      if (!h || h.length < 2) continue;
      const n = h.length;
      ctx.strokeStyle = tr.color;
      for (let i = 1; i < n; i++) {
        ctx.globalAlpha = 0.08 + 0.75 * (i / n);
        ctx.lineWidth = (1 + 2.5 * (i / n)) * k;
        ctx.beginPath();
        ctx.moveTo(this.X(h[i - 1].x), this.Y(h[i - 1].y));
        ctx.lineTo(this.X(h[i].x), this.Y(h[i].y));
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    }
  }

  _objects(objects, o) {
    const { ctx, k } = this.t;
    for (const ob of objects) {
      // Discontinua: pista "en reserva" (no emparejada en la última inferencia)
      // o detección tentativa todavía sin ID.
      const stale = !ob.seenNow || ob.id <= 0;
      const r = this._rect(ob.bbox);
      ctx.globalAlpha = stale ? 0.45 : 1;
      ctx.setLineDash(stale ? [5 * k, 4 * k] : []);
      ctx.strokeStyle = ob.color;
      ctx.lineWidth = 1.5 * k;
      ctx.strokeRect(r.x, r.y, r.w, r.h);
      ctx.setLineDash([]);
      this._brackets(r, ob.color, 3 * k);
      ctx.globalAlpha = 1;
      if (o.layers.labels) {
        const id = ob.id > 0 ? ` #${ob.id}` : '';
        const name = ob.display || ob.label;
        // Detalle del módulo F (raza, tipo exacto) si aporta algo nuevo.
        const fine = ob.fine && ob.fine.label !== name ? ` · ${ob.fine.label} ${Math.round(ob.fine.score * 100)}%` : '';
        this._tag(`${name}${id} ${Math.round((ob.score || 0) * 100)}%${fine}`, r.x, r.y - 2 * k, { color: ob.color, border: ob.display ? '#a78bfa' : null });
      }
    }
  }

  /** Visor central del escáner (módulo F) con lo que reconoce dentro. */
  _reticle(rt, o) {
    const { ctx, k } = this.t;
    const b = rt.roi;
    const r = this._rect({ x: b.left, y: b.top, w: b.right - b.left, h: b.bottom - b.top });
    const col = rt.label ? '#a78bfa' : 'rgba(167,139,250,0.55)';
    this._brackets(r, col, 2.5 * k);
    // Cruz central discreta.
    const cx = r.x + r.w / 2, cy = r.y + r.h / 2, c = 7 * k;
    ctx.strokeStyle = col;
    ctx.lineWidth = 1.5 * k;
    ctx.beginPath();
    ctx.moveTo(cx - c, cy); ctx.lineTo(cx + c, cy);
    ctx.moveTo(cx, cy - c); ctx.lineTo(cx, cy + c);
    ctx.stroke();
    if (!o.layers.labels) return;
    const text = rt.label ? `◎ ${rt.label} ${Math.round(rt.score * 100)}%` : rt.waiting ? '◎ Escáner listo' : '◎ Apunta a una cosa…';
    this._tag(text, cx, r.y + r.h + 22 * k, { align: 'center', size: rt.label ? 14 : 11, color: rt.label ? '#ede9fe' : '#c4b5fd', bg: rt.label ? 'rgba(46,16,101,0.85)' : undefined, border: rt.label ? '#a78bfa' : null });
  }

  _persons(persons, o) {
    const { ctx, k } = this.t;
    const minVis = o.settings['pose.minVis'];
    const conn = o.connections.pose;
    for (const p of persons) {
      const d = p.data || {};
      const lm = d.landmarks;
      const r = this._rect(p.bbox);
      const st = p.state.pose;
      const fall = st && st.fall.state;
      if (lm && o.layers.pose) {
        // Esqueleto: cada segmento con el color de la certeza MÍNIMA de sus extremos.
        ctx.lineCap = 'round';
        ctx.lineWidth = 3 * k;
        for (const [a, b] of conn) {
          const v = Math.min(lm[a].visibility, lm[b].visibility);
          if (v < minVis * 0.6) continue;
          ctx.globalAlpha = 0.35 + 0.65 * v;
          ctx.strokeStyle = confColor(v);
          this._line(lm[a], lm[b]);
        }
        ctx.globalAlpha = 1;
        ctx.lineWidth = 1.2 * k;
        for (let i = 0; i < lm.length; i++) {
          const v = lm[i].visibility;
          if (v < minVis * 0.6 || (i > 0 && i < 11)) continue;
          this._dot(lm[i], (i >= 11 ? 3.6 : 2.6) * k, confColor(v), 'rgba(0,0,0,0.6)');
        }
        // Ángulos articulares (sólo con pocas personas para no saturar).
        if (o.settings['pose.showAngles'] && p.features && persons.length <= 3) {
          for (const [name, a, b, c] of JOINT_ANGLES) {
            const val = p.features.angles[name];
            if (val == null) continue;
            const B = lm[b];
            const ang0 = Math.atan2(this.Y(lm[a].y) - this.Y(B.y), this.X(lm[a].x) - this.X(B.x));
            const ang1 = Math.atan2(this.Y(lm[c].y) - this.Y(B.y), this.X(lm[c].x) - this.X(B.x));
            let da = ang1 - ang0;
            while (da > Math.PI) da -= 2 * Math.PI;
            while (da < -Math.PI) da += 2 * Math.PI;
            ctx.strokeStyle = 'rgba(253,224,71,0.85)';
            ctx.lineWidth = 1.5 * k;
            ctx.beginPath();
            ctx.arc(this.X(B.x), this.Y(B.y), 14 * k, ang0, ang0 + da, da < 0);
            ctx.stroke();
            this._tag(`${Math.round(val)}°`, this.X(B.x) + 8 * k, this.Y(B.y) - 6 * k, { color: '#fde047', size: 10, bg: 'rgba(4,10,16,0.65)' });
          }
        }
      }
      // Caja y etiqueta de la persona.
      const alertOn = o.alertTracks.has(`person:${p.id}`) || fall === 'fallen';
      const col = alertOn ? '#f43f5e' : fall === 'candidate' ? '#fbbf24' : p.color;
      ctx.globalAlpha = p.seenNow ? 1 : 0.5;
      this._brackets(r, col, (alertOn ? 4 : 2.5) * k);
      ctx.globalAlpha = 1;
      if (o.layers.labels && p.id > 0) {
        const parts = [`Persona #${p.id}`];
        if (st && st.posture && st.posture !== 'indeterminado') parts.push(POSTURE_LABEL[st.posture]);
        if (st && st.walking) parts.push('caminando');
        if (st && st.armsUp) parts.push('brazos arriba');
        if (fall === 'candidate') parts.push('¿caída?');
        if (fall === 'fallen') parts.push('CAÍDA');
        const still = st ? st.still : p.state.still;
        if (still && still.stillTime >= 3) parts.push(`quieta ${Math.floor(still.stillTime)}s`);
        this._tag(parts.join(' · '), r.x, r.y - 2 * k, { color: col === p.color ? '#e5f6ff' : col, border: col });
      }
    }
  }

  _hands(hands, o) {
    const { ctx, k } = this.t;
    const conn = o.connections.hand;
    for (const h of hands) {
      const d = h.data;
      if (!d) continue;
      const lm = d.landmarks;
      const col = HAND_COLORS[h.view?.side] || '#22d3ee';
      ctx.strokeStyle = col;
      ctx.lineWidth = 2.2 * k;
      ctx.globalAlpha = h.seenNow ? 0.95 : 0.4;
      for (const [a, b] of conn) this._line(lm[a], lm[b]);
      for (let i = 0; i < lm.length; i++) {
        this._dot(lm[i], (FINGERTIPS.includes(i) ? 4 : 2.6) * k, FINGERTIPS.includes(i) ? '#ffffff' : col, 'rgba(0,0,0,0.5)');
      }
      ctx.globalAlpha = 1;
      if (o.layers.labels && h.view) {
        const r = this._rect(d.bbox);
        const side = h.view.side === 'izquierda' ? 'izq.' : 'der.';
        const g = h.view.label ? ` · ${h.view.label}` : '';
        this._tag(`Mano ${side}${g}`, r.x, r.y - 2 * k, { color: col });
        if (h.view.count != null) this._tag(String(h.view.count), r.x + r.w, r.y + r.h, { color: '#0b1220', bg: col, size: 16, align: 'right' });
      }
    }
  }

  _faces(faces, o) {
    const { ctx, k } = this.t;
    const mode = o.settings['face.mesh'];
    const C = o.connections.face;
    for (const f of faces) {
      const d = f.data;
      if (!d) continue;
      const lm = d.landmarks;
      ctx.globalAlpha = f.seenNow ? 1 : 0.4;
      if (mode === 'profundidad') {
        // "3D": puntos coloreados por profundidad (z relativa de MediaPipe).
        let zmin = Infinity, zmax = -Infinity;
        for (let i = 0; i < 468; i++) { const z = lm[i].z; if (z < zmin) zmin = z; if (z > zmax) zmax = z; }
        const span = Math.max(1e-6, zmax - zmin);
        for (let i = 0; i < 468; i += 1) {
          const t = 1 - (lm[i].z - zmin) / span; // 1 = más cerca
          ctx.fillStyle = `hsl(${190 - t * 150} 95% ${35 + t * 35}%)`;
          ctx.fillRect(this.X(lm[i].x) - k, this.Y(lm[i].y) - k, 2.2 * k, 2.2 * k);
        }
      } else {
        if (mode === 'malla') {
          ctx.strokeStyle = 'rgba(148,163,184,0.35)';
          ctx.lineWidth = 0.6 * k;
          ctx.beginPath();
          for (const [a, b] of C.tess) {
            ctx.moveTo(this.X(lm[a].x), this.Y(lm[a].y));
            ctx.lineTo(this.X(lm[b].x), this.Y(lm[b].y));
          }
          ctx.stroke();
        }
        ctx.strokeStyle = 'rgba(167,243,208,0.9)';
        ctx.lineWidth = 1.3 * k;
        ctx.beginPath();
        for (const [a, b] of C.contours) {
          ctx.moveTo(this.X(lm[a].x), this.Y(lm[a].y));
          ctx.lineTo(this.X(lm[b].x), this.Y(lm[b].y));
        }
        ctx.stroke();
      }
      if (lm.length >= 478) {
        ctx.strokeStyle = '#fde047';
        ctx.lineWidth = 1.4 * k;
        ctx.beginPath();
        for (const [a, b] of C.irises) {
          ctx.moveTo(this.X(lm[a].x), this.Y(lm[a].y));
          ctx.lineTo(this.X(lm[b].x), this.Y(lm[b].y));
        }
        ctx.stroke();
      }
      // Flecha de mirada aproximada desde la punta de la nariz.
      const m = f.metrics;
      if (m) {
        const nose = lm[1];
        const len = Math.max(30 * k, d.bbox.w * this.t.vp.w * 0.45);
        let dx = Math.sin((m.gazeYaw * Math.PI) / 180) * len;
        const dy = -Math.sin((m.gazePitch * Math.PI) / 180) * len;
        if (this.t.mirror) dx = -dx;
        ctx.strokeStyle = 'rgba(253,224,71,0.9)';
        ctx.lineWidth = 2 * k;
        ctx.beginPath();
        ctx.moveTo(this.X(nose.x), this.Y(nose.y));
        ctx.lineTo(this.X(nose.x) + dx, this.Y(nose.y) + dy);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
      if (o.layers.labels) {
        const r = this._rect(d.bbox);
        const st = f.state.face;
        const parts = [`Rostro #${f.id}`];
        if (m && o.settings['derived.faceMetrics']) {
          parts.push(`EAR ${m.ear.toFixed(2)}`);
          if (st) {
            if (st.closed) parts.push('ojos cerrados');
            if (st.mouthOpen) parts.push('boca abierta');
            if (st.smiling) parts.push('sonríe');
          }
        }
        const alert = o.alertTracks.has(`face:${f.id}`);
        this._tag(parts.join(' · '), r.x, r.y - 2 * k, { color: alert ? '#fecdd3' : '#a7f3d0', border: alert ? '#f43f5e' : null });
        if (m && o.settings['derived.faceMetrics']) {
          this._tag(`giro ${turnLabel(m.yaw, 'izq.', 'der.')} · incl. ${turnLabel(m.pitch, 'arriba', 'abajo')} · mira ${gazeLabel(m)}`, r.x, r.y + r.h + 18 * k, { color: '#cbd5e1', size: 10 });
        }
      }
    }
  }

  _distances(list) {
    const { ctx, k } = this.t;
    for (const d of list) {
      ctx.strokeStyle = d.close ? '#f43f5e' : 'rgba(226,232,240,0.75)';
      ctx.lineWidth = (d.close ? 2.5 : 1.5) * k;
      ctx.setLineDash([6 * k, 5 * k]);
      this._line(d.a, d.b);
      ctx.setLineDash([]);
      const mx = (this.X(d.a.x) + this.X(d.b.x)) / 2, my = (this.Y(d.a.y) + this.Y(d.b.y)) / 2;
      this._tag(`${Math.round(d.px)} px · ${d.rel.toFixed(1)} alt.`, mx, my, { align: 'center', color: d.close ? '#fecdd3' : '#e2e8f0', size: 10 });
    }
  }

  _alerts(scene, o) {
    if (!o.alerts.length) return;
    const { ctx, k, vp } = this.t;
    const pulse = 0.55 + 0.45 * Math.sin(performance.now() / 140);
    ctx.strokeStyle = `rgba(244,63,94,${0.5 + 0.5 * pulse})`;
    ctx.lineWidth = 6 * k;
    ctx.strokeRect(vp.x + 3 * k, vp.y + 3 * k, vp.w - 6 * k, vp.h - 6 * k);
    // Anillo sobre cada entidad alertada.
    for (const a of o.alerts) {
      if (a.trackId == null) continue;
      const pool = a.kind === 'person' ? scene.persons : a.kind === 'object' ? scene.objects : a.kind === 'face' ? scene.faces : [];
      const tr = pool.find((x) => x.id === a.trackId);
      if (!tr) continue;
      const b = tr.data && tr.data.bbox ? tr.data.bbox : tr.bbox;
      const r = this._rect(b);
      ctx.strokeStyle = `rgba(244,63,94,${0.4 + 0.6 * pulse})`;
      ctx.lineWidth = 3 * k;
      ctx.strokeRect(r.x - 6 * k, r.y - 6 * k, r.w + 12 * k, r.h + 12 * k);
    }
    const last = o.alerts[o.alerts.length - 1];
    const extra = o.alerts.length > 1 ? `  (+${o.alerts.length - 1})` : '';
    this._tag(`${last.message}${extra}`, vp.x + vp.w / 2, vp.y + 34 * k, { align: 'center', size: 15, color: '#fff', bg: `rgba(190,18,60,${0.75 + 0.2 * pulse})` });
  }

  _editor(o) {
    const { ctx, k } = this.t;
    const ed = o.editor;
    if (ed.mode === 'zone' && ed.points.length) {
      ctx.strokeStyle = '#fbbf24';
      ctx.lineWidth = 2 * k;
      ctx.setLineDash([5 * k, 4 * k]);
      ctx.beginPath();
      ed.points.forEach((p, i) => (i ? ctx.lineTo(this.X(p.x), this.Y(p.y)) : ctx.moveTo(this.X(p.x), this.Y(p.y))));
      if (ed.cursor) ctx.lineTo(this.X(ed.cursor.x), this.Y(ed.cursor.y));
      ctx.stroke();
      ctx.setLineDash([]);
      ed.points.forEach((p, i) => this._dot(p, (i === 0 ? 6 : 4) * k, i === 0 ? '#fde68a' : '#fbbf24', '#000'));
    }
    if (ed.mode === 'line' && ed.a) {
      ctx.strokeStyle = '#38bdf8';
      ctx.lineWidth = 2.5 * k;
      ctx.setLineDash([5 * k, 4 * k]);
      if (ed.cursor) this._line(ed.a, ed.cursor);
      ctx.setLineDash([]);
      this._dot(ed.a, 5 * k, '#38bdf8', '#000');
    }
    // Manejadores de la zona/línea seleccionada (editables arrastrando).
    if (ed.selected) {
      const z = o.zones.zones.find((x) => x.id === ed.selected);
      const l = o.zones.lines.find((x) => x.id === ed.selected);
      const pts = z ? z.points : l ? [l.a, l.b] : [];
      for (const p of pts) this._dot(p, 6 * k, '#ffffff', '#0ea5e9');
    }
  }

  _hud(h) {
    const { k, vp } = this.t;
    this._tag(h.left, vp.x + 8 * k, vp.y + vp.h - 8 * k, { color: '#94a3b8', size: 11 });
    if (h.right) this._tag(h.right, vp.x + vp.w - 8 * k, vp.y + vp.h - 8 * k, { color: '#94a3b8', size: 11, align: 'right' });
  }

  /**
   * Captura PNG a resolución nativa: fotograma de vídeo + overlay.
   * @returns {Promise<Blob>}
   */
  async exportPNG(videoEl, scene, o) {
    const vw = videoEl.videoWidth, vh = videoEl.videoHeight;
    if (!vw || !vh) throw new Error('No hay fotograma que capturar.');
    const c = document.createElement('canvas');
    c.width = vw;
    c.height = vh;
    const ctx = c.getContext('2d');
    const mirror = this.t.mirror;
    ctx.save();
    if (mirror) { ctx.translate(vw, 0); ctx.scale(-1, 1); }
    ctx.drawImage(videoEl, 0, 0, vw, vh);
    ctx.restore();
    const saved = this.t;
    this.t = { ctx, vp: { x: 0, y: 0, w: vw, h: vh }, mirror, k: Math.max(1, vw / 1280), W: vw, H: vh };
    try {
      this.drawScene(scene, o);
    } finally {
      this.t = saved;
    }
    return new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('No se pudo generar la imagen.'))), 'image/png'));
  }
}
