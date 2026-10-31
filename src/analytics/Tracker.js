/**
 * Tracker.js — Seguimiento multi-objeto con ID persistente (IoU + centroide).
 *
 * Problema: los modelos devuelven, frame a frame, listas de detecciones SIN
 * identidad (MediaPipe puede incluso cambiar el orden de las personas entre
 * frames). El Tracker convierte esas listas en "pistas" (tracks) con un ID
 * estable que sobrevive al movimiento normal y a oclusiones breves.
 *
 * Algoritmo por actualización (update):
 *  1. PREDICCIÓN: cada pista proyecta su caja al instante actual con su
 *     velocidad suavizada (modelo de velocidad constante, extrapolación
 *     limitada a 0,5 s para no "disparar" pistas perdidas).
 *  2. COSTE: para cada par (pista, detección) se calcula un coste:
 *       - 1 − IoU si el solape es suficiente (IoU ≥ iouMin)   → rango [0, 1)
 *       - 1 + d si no hay solape pero los centros están cerca → rango [1, 2]
 *         (d = distancia entre centros en "diagonales de caja", así el umbral
 *         escala con el tamaño del objeto: una persona cercana puede moverse
 *         más píxeles que una lejana).
 *       - PROHIBIDO si cambia la clase (silla ≠ perro), si el tamaño cambia de
 *         forma inverosímil, o si están demasiado lejos.
 *     Así cualquier emparejamiento por solape gana a uno por proximidad.
 *  3. ASIGNACIÓN ÓPTIMA con el algoritmo húngaro (mínimo coste global).
 *  4. ACTUALIZACIÓN de pistas emparejadas (caja, velocidad EMA, historial),
 *     envejecimiento de las no emparejadas y creación de pistas nuevas.
 *
 * Ciclo de vida: una pista nace "tentativa" (ID temporal negativo) y sólo
 * recibe un ID visible (#1, #2, …) cuando acumula `minHits` emparejamientos
 * (o `fastConfirm.hits` si su confianza media es muy alta). Esto filtra
 * falsos positivos de pocos frames ("objetos fantasma") y mantiene la
 * numeración limpia. Una pista confirmada que deja de verse sigue "en
 * reserva" durante `maxAge` segundos (oclusión breve) antes de eliminarse.
 *
 * Doble umbral (como ByteTrack): las detecciones marcadas `weak` (confianza
 * por debajo del umbral del usuario pero no despreciable) se emparejan en una
 * segunda pasada SÓLO con pistas ya confirmadas que no encontraron pareja
 * fuerte. Sirven para no perder un objeto real cuando su confianza baja un
 * momento, pero nunca crean pistas nuevas ni confirman tentativas.
 *
 * Todo el tiempo se mide en SEGUNDOS del eje temporal del análisis (tiempo
 * del medio en archivos, reloj de pared en directo), no en frames: así el
 * comportamiento no depende de la cadencia del modelo ni de la degradación.
 * Además, los tiempos de vida se estiran automáticamente si las
 * actualizaciones llegan muy espaciadas (análisis degradado a 1 Hz o menos):
 * una pista tentativa debe poder esperar a su segunda detección.
 */
import { hungarian } from './hungarian.js';
import { iou, boxCenter, boxFoot, emaAlpha, colorForId } from './geometry.js';

const FORBIDDEN = 1e6;

/** Generador de IDs compartible entre trackers (personas y objetos comparten numeración). */
export class IdGenerator {
  constructor(start = 1) { this.next = start; }
  take() { return this.next++; }
  reset(start = 1) { this.next = start; }
}

export class Tracker {
  /**
   * @param {object} o
   * @param {string} o.kind            'person' | 'object' | 'hand' | 'face'
   * @param {IdGenerator} [o.idGen]    generador de IDs (compartido o propio)
   * @param {number} [o.iouMin=0.15]   solape mínimo para emparejar por IoU
   * @param {number} [o.maxCenterDist=1.0] distancia máx. entre centros (en diagonales)
   * @param {number} [o.maxAge=1.2]    s que sobrevive una pista confirmada sin verse
   * @param {number} [o.tentativeMaxAge=0.4] s que sobrevive una pista tentativa
   * @param {number} [o.minHits=2]     emparejamientos para confirmar
   * @param {boolean} [o.classAware=true] no emparejar clases distintas
   * @param {'foot'|'center'} [o.refPoint='center'] punto de referencia por defecto
   * @param {number} [o.historySeconds=6] duración del historial (estelas/cruces)
   * @param {{hits:number, meanScore:number}|null} [o.fastConfirm] confirmación
   *        anticipada si la confianza media de la pista es alta
   */
  constructor(o = {}) {
    this.kind = o.kind || 'object';
    this.ids = o.idGen || new IdGenerator();
    this.iouMin = o.iouMin ?? 0.15;
    this.maxCenterDist = o.maxCenterDist ?? 1.0;
    this.maxAge = o.maxAge ?? 1.2;
    this.tentativeMaxAge = o.tentativeMaxAge ?? 0.4;
    this.minHits = o.minHits ?? 2;
    this.fastConfirm = o.fastConfirm || null;
    this.classAware = o.classAware ?? true;
    this.refPoint = o.refPoint || 'center';
    this.historySeconds = o.historySeconds ?? 6;
    this.historyMax = o.historyMax ?? 240;
    this.tracks = [];
    this._tmp = -1;
    this._lastUpdate = null;
    this._dtEma = null;
  }

  reset() { this.tracks = []; this._lastUpdate = null; this._dtEma = null; }

  /** Pistas confirmadas (las únicas que se muestran y generan eventos). */
  get confirmed() { return this.tracks.filter((t) => t.confirmed); }

  /**
   * @param {Array<{bbox:{x,y,w,h}, cls?:string, label?:string, score?:number, ref?:{x,y}, data?:any, weak?:boolean}>} dets
   * @param {number} t instante del análisis en segundos
   * @returns {{tracks:object[], created:object[], removed:object[]}}
   *   `tracks`: pistas confirmadas vivas (con `seenNow` = vista en este frame);
   *   `created`: pistas que se acaban de confirmar; `removed`: confirmadas eliminadas.
   */
  update(allDets, t) {
    const created = [];
    const removed = [];
    const tracks = this.tracks;
    const dets = allDets.filter((d) => !d.weak);
    const weak = allDets.filter((d) => d.weak);

    // Intervalo medio entre actualizaciones → tiempos de vida efectivos.
    if (this._lastUpdate != null) {
      const gap = t - this._lastUpdate;
      if (gap > 0 && gap < 5) this._dtEma = this._dtEma == null ? gap : this._dtEma + 0.2 * (gap - this._dtEma);
    }
    this._lastUpdate = t;
    const slack = this._dtEma || 0;
    const maxAge = Math.max(this.maxAge, 3 * slack);
    const tentativeMaxAge = Math.max(this.tentativeMaxAge, 2.5 * slack);

    // --- 1) Predicción de la caja de cada pista al instante t -----------------
    const preds = tracks.map((tr) => {
      const dt = Math.min(Math.max(0.5, 1.5 * slack), Math.max(0, t - tr.lastSeen));
      return { x: tr.bbox.x + tr.vx * dt, y: tr.bbox.y + tr.vy * dt, w: tr.bbox.w, h: tr.bbox.h };
    });

    // --- 2) Matriz de costes pista × detección --------------------------------
    let assign = [];
    if (tracks.length && dets.length) {
      const cost = preds.map((pb, i) => dets.map((d) => this._cost(tracks[i], pb, d)));
      // --- 3) Asignación óptima global ----------------------------------------
      assign = hungarian(cost).map((j, i) => (j >= 0 && cost[i][j] < FORBIDDEN ? j : -1));
    } else {
      assign = new Array(tracks.length).fill(-1);
    }

    // --- 4a) Actualiza pistas emparejadas --------------------------------------
    const usedDet = new Uint8Array(dets.length);
    for (let i = 0; i < tracks.length; i++) {
      const tr = tracks[i];
      const j = assign[i];
      tr.seenNow = false;
      if (j < 0) continue;
      usedDet[j] = 1;
      this._applyDetection(tr, dets[j], t);
      tr.seenNow = true;
      if (!tr.confirmed && this._shouldConfirm(tr)) {
        this._confirm(tr);
        created.push(tr);
      }
    }

    // --- 4a') Segunda pasada: detecciones débiles ↔ confirmadas sin pareja ---
    if (weak.length) {
      const idx = [];
      for (let i = 0; i < tracks.length; i++) if (assign[i] < 0 && tracks[i].confirmed) idx.push(i);
      if (idx.length) {
        const cost = idx.map((i) => weak.map((d) => this._cost(tracks[i], preds[i], d)));
        hungarian(cost).forEach((j, k) => {
          if (j < 0 || cost[k][j] >= FORBIDDEN) return;
          const tr = tracks[idx[k]];
          this._applyDetection(tr, weak[j], t);
          tr.seenNow = true;
        });
      }
    }

    // --- 4b) Envejece / elimina pistas no vistas -----------------------------
    this.tracks = tracks.filter((tr) => {
      if (tr.seenNow) return true;
      const age = t - tr.lastSeen;
      const limit = tr.confirmed ? maxAge : tentativeMaxAge;
      if (age > limit) {
        if (tr.confirmed) removed.push(tr);
        return false;
      }
      return true;
    });

    // --- 4c) Crea pistas nuevas para detecciones sin pareja -------------------
    for (let j = 0; j < dets.length; j++) {
      if (usedDet[j]) continue;
      const tr = this._newTrack(dets[j], t);
      this.tracks.push(tr);
      if (this._shouldConfirm(tr)) {
        this._confirm(tr);
        created.push(tr);
      }
    }

    return { tracks: this.tracks.filter((tr) => tr.confirmed), created, removed };
  }

  // ---------------------------------------------------------------------------

  _cost(tr, pb, d) {
    if (this.classAware && (tr.cls ?? null) !== (d.cls ?? null)) return FORBIDDEN;
    const db = d.bbox;
    const areaT = Math.max(1e-6, pb.w * pb.h), areaD = Math.max(1e-6, db.w * db.h);
    const ratio = areaD / areaT;
    if (ratio > 6 || ratio < 1 / 6) return FORBIDDEN; // cambio de escala inverosímil
    const ov = iou(pb, db);
    if (ov >= this.iouMin) return 1 - ov;
    const ca = boxCenter(pb), cb = boxCenter(db);
    const diag = Math.max(Math.hypot(pb.w, pb.h), Math.hypot(db.w, db.h), 1e-6);
    const dn = Math.hypot(ca.x - cb.x, ca.y - cb.y) / diag;
    if (dn <= this.maxCenterDist) return 1 + dn;
    return FORBIDDEN;
  }

  _refOf(d) {
    if (d.ref) return { x: d.ref.x, y: d.ref.y };
    return this.refPoint === 'foot' ? boxFoot(d.bbox) : boxCenter(d.bbox);
  }

  _newTrack(d, t) {
    const c = boxCenter(d.bbox);
    const tr = {
      id: this._tmp--,
      kind: this.kind,
      cls: d.cls ?? null,
      label: d.label ?? d.cls ?? this.kind,
      bbox: { ...d.bbox },
      center: c,
      ref: this._refOf(d),
      vx: 0,
      vy: 0,
      score: d.score ?? 1,
      scoreSum: d.score ?? 1,
      hits: 1,
      firstSeen: t,
      lastSeen: t,
      confirmed: false,
      seenNow: true,
      history: [],
      data: d.data,
      state: {},         // bolsa de estado para la analítica (pose, gestos, zonas…)
      color: '#9ca3af',
    };
    tr.history.push({ t, x: tr.ref.x, y: tr.ref.y });
    return tr;
  }

  _shouldConfirm(tr) {
    if (tr.hits >= this.minHits) return true;
    const f = this.fastConfirm;
    return !!f && tr.hits >= f.hits && tr.scoreSum / tr.hits >= f.meanScore;
  }

  _confirm(tr) {
    tr.confirmed = true;
    tr.id = this.ids.take();
    tr.color = colorForId(tr.id);
    tr.confirmedAt = tr.lastSeen;
  }

  _applyDetection(tr, d, t) {
    const dt = t - tr.lastSeen;
    const c = boxCenter(d.bbox);
    if (dt > 1e-3) {
      // Velocidad instantánea del centro, suavizada con EMA de τ = 0,25 s.
      // La constante de tiempo (no un α fijo) hace que el suavizado sea
      // equivalente a 5 Hz o a 30 Hz de análisis.
      const a = emaAlpha(dt, 0.25);
      tr.vx += a * ((c.x - tr.center.x) / dt - tr.vx);
      tr.vy += a * ((c.y - tr.center.y) / dt - tr.vy);
    }
    tr.bbox = { ...d.bbox };
    tr.center = c;
    tr.ref = this._refOf(d);
    // Confianza mostrada: media móvil (una detección débil puntual no la hunde).
    const s = d.score ?? tr.score;
    tr.score = tr.score + 0.35 * (s - tr.score);
    tr.label = d.label ?? tr.label;
    tr.data = d.data;
    if (!d.weak) { tr.hits += 1; tr.scoreSum += s; }
    tr.lastSeen = t;
    // Historial del punto de referencia (estelas, tripwires).
    const h = tr.history;
    if (!h.length || t > h[h.length - 1].t) h.push({ t, x: tr.ref.x, y: tr.ref.y });
    else h[h.length - 1] = { t, x: tr.ref.x, y: tr.ref.y };
    const tMin = t - this.historySeconds;
    while (h.length > this.historyMax || (h.length && h[0].t < tMin)) h.shift();
  }
}
