/**
 * UIController.js — Interfaz: genera los controles a partir del esquema de
 * ajustes, conecta botones (fuentes, reproducción, zonas, exportación),
 * muestra métricas en vivo y el registro de eventos.
 *
 * Las métricas se refrescan a 4 Hz (no en cada frame) para no provocar
 * recálculos de estilo/layout que restarían FPS de render.
 */
import { SETTINGS, MODULES } from '../config.js';
import { h, download, stamp, fmtTime, clockTime } from './dom.js';
import { FaceMesh3DView } from './FaceMesh3DView.js';
import { ZoneEditor } from './ZoneEditor.js';
import { POSTURE_LABEL } from '../analytics/PoseAnalytics.js';
import { turnLabel } from '../analytics/FaceAnalytics.js';
import { safeStorage } from '../core/Settings.js';

const $ = (id) => document.getElementById(id);
const LEVELS = [['info', 'Info'], ['warn', 'Avisos'], ['alert', 'Alertas'], ['system', 'Sistema'], ['error', 'Errores']];
const STATUS_TEXT = { idle: 'en espera', loading: 'cargando…', ready: 'listo', error: 'error', missing: 'faltan archivos' };
const ALERT_NAMES = { intrusion: 'Intrusión', fall: 'Caída', immobility: 'Inmovilidad', drowsiness: 'Somnolencia', motion: 'Anomalía mov.', proximity: 'Proximidad' };
const NEEDS_TRACKING = ['derived.activity', 'derived.fall', 'derived.immobility', 'derived.zones', 'derived.tripwires', 'derived.trails', 'derived.distances'];

export class UIController {
  constructor({ engine, settings, log, alerts, zones, source, renderer, actions }) {
    Object.assign(this, { engine, settings, log, alerts, zones, source, renderer });
    this.actions = actions || {};
    this.controls = new Map();
    this.levelOn = new Set(LEVELS.map(([k]) => k));
    this.pendingLog = [];
    this.moduleRows = new Map();
    this.backendText = '—';
    this.lastStats = null;
    this.store = safeStorage();
  }

  build() {
    this._buildModules();
    this._buildGroup('derived', $('derived'));
    this._buildGroup('sens', $('sens'));
    this._buildGroup('perf', $('perf'));
    this._buildGroup('view', $('view'), true);
    this._refreshDependencies();
    this._bindSources();
    this._bindTransport();
    this._bindLog();
    this._bindExport();
    this._bindZones();
    this._bindKeys();
    this._bindDrop();

    this.zoneEditor = new ZoneEditor({
      canvas: $('overlay'),
      stage: $('stage'),
      renderer: this.renderer,
      engine: this.engine,
      zones: this.zones,
      hintEl: $('draw-hint'),
      onChange: () => this._zonesChanged(),
      onSelect: () => this._renderZoneList(),
      onCreate: (item, kind) => this.log.add('system', kind === 'zone' ? 'zona' : 'linea', `${item.name} creada`),
    });

    this.mesh3d = new FaceMesh3DView($('mesh3d'), {
      getFace: () => {
        const f = this.engine.scene.faces.find((x) => x.seenNow) || this.engine.scene.faces[0];
        if (f) f.aspect = this.source.width && this.source.height ? this.source.width / this.source.height : 1;
        return f;
      },
      getConnections: () => this.engine.connections.face,
      isEnabled: () => this.settings.get('face.enabled') && this.settings.get('face.show3d') && $('mesh-sec').open,
    });
    this.mesh3d.start();

    this.engine.on('stats', (s) => this._stats(s));
    this.engine.on('status', ({ status, detail }) => this.setEngineStatus(status, detail));
    this.engine.on('mirror', (m) => $('video').classList.toggle('mirror', m));
    this.engine.on('detector', () => this._renderModules());
    this.source.on('started', (st) => this._onSourceStarted(st));
    this.source.on('stopped', () => this._onSourceStopped());
    this.source.on('ended', (kind) => this.toast(kind === 'screen' ? 'Se ha dejado de compartir la pantalla.' : 'La fuente de vídeo ha terminado.', 'warn'));
    this.source.on('state', () => this._syncTransport());
    this.log.on('entry', (e) => this.pendingLog.push(e));
    this.log.on('clear', () => { $('log').replaceChildren(h('span', { class: 'empty', text: 'Registro vacío.' })); });
    this.alerts.on('alert', (a) => this._onAlert(a));
    this.settings.on('change', ({ key, spec }) => this._onSettingChanged(key, spec));
    this.settings.on('reset', () => this._syncAllControls());
    setInterval(() => this._flushLog(), 200);
    // El audio sólo puede activarse tras un gesto del usuario.
    document.addEventListener('pointerdown', () => this.alerts.unlockAudio(), { once: true });
    this._renderZoneList();
    this._syncTransport();
  }

  // ---------------------------------------------------------------------------
  // Controles generados desde el esquema
  // ---------------------------------------------------------------------------

  _control(spec) {
    const S = this.settings;
    const id = `set-${spec.key.replace(/\./g, '-')}`;
    let el, input, out;
    if (spec.type === 'bool') {
      input = h('input', { type: 'checkbox', id, checked: !!S.get(spec.key) });
      input.addEventListener('change', () => S.set(spec.key, input.checked));
      el = h('label', { class: 'switch', title: spec.help || '' }, input, h('span', { text: spec.label }));
    } else if (spec.type === 'range') {
      input = h('input', { type: 'range', id, min: String(spec.min), max: String(spec.max), step: String(spec.step), value: String(S.get(spec.key)) });
      out = h('output', { for: id, text: fmtSetting(spec, S.get(spec.key)) });
      input.addEventListener('input', () => { out.textContent = fmtSetting(spec, Number(input.value)); S.set(spec.key, Number(input.value)); });
      el = h('div', { class: 'ctl' }, h('label', { for: id }, h('span', { text: spec.label }), out), input);
    } else {
      input = h('select', { id }, ...spec.options.map(([v, t]) => h('option', { value: String(v), text: t })));
      input.value = String(S.get(spec.key));
      input.addEventListener('change', () => S.set(spec.key, input.value));
      el = h('div', { class: 'ctl' }, h('label', { for: id, text: spec.label }), input);
    }
    this.controls.set(spec.key, { el, input, out, spec });
    return el;
  }

  _buildGroup(group, container, prepend = false) {
    const items = SETTINGS.filter((s) => s.group === group).map((s) => this._control(s));
    if (prepend) container.prepend(...items);
    else container.append(...items);
  }

  _buildModules() {
    const box = $('modules');
    box.replaceChildren();
    for (const m of MODULES) {
      const spec = SETTINGS.find((s) => s.key === `${m.id}.enabled`);
      const sw = this._control(spec);
      const dot = h('span', { class: 'dot' });
      const st = h('span', { text: 'en espera' });
      const lat = h('span', { text: '' });
      const err = h('div', { class: 'module-err', hidden: true });
      const retry = h('button', { class: 'btn', hidden: true, text: 'Reintentar', onclick: () => this.actions.reloadDetector && this.actions.reloadDetector(m.id) });
      const opts = SETTINGS.filter((s) => s.group === `opt-${m.id}`).map((s) => this._control(s));
      const row = h('div', { class: 'module', 'data-module': m.id },
        h('div', { class: 'module-head' }, dot, sw),
        h('div', { class: 'module-meta' }, st, lat),
        err,
        retry,
        opts.length ? h('details', {}, h('summary', { class: 'hint', text: 'Opciones' }), h('div', { class: 'module-opts' }, ...opts)) : null,
      );
      box.append(row);
      this.moduleRows.set(m.id, { row, dot, st, lat, err, retry });
    }
  }

  _renderModules(stats = this.lastStats) {
    for (const m of MODULES) {
      const r = this.moduleRows.get(m.id);
      const d = this.engine.get(m.id);
      if (!r) continue;
      const status = d ? d.status : 'idle';
      r.dot.className = `dot ${status}`;
      const enabled = this.settings.get(`${m.id}.enabled`);
      r.row.classList.toggle('off', !enabled);
      const ds = stats && stats.detectors.find((x) => x.id === m.id);
      setText(r.st, `${STATUS_TEXT[status] || status}${d && d.backend && status === 'ready' ? ` · ${d.backend}` : ''}`);
      setText(r.lat, ds && ds.latency && enabled ? `${ds.latency.toFixed(0)} ms · ${ds.hz.toFixed(1)} Hz` : '');
      const bad = status === 'error' || status === 'missing';
      if (r.err.hidden === bad) r.err.hidden = !bad;
      setText(r.err, bad ? d.statusDetail : '');
      if (r.retry.hidden !== (status !== 'error')) r.retry.hidden = status !== 'error';
    }
  }

  _onSettingChanged(key, spec) {
    this._syncControl(key);
    if (key === 'derived.tracking') this._refreshDependencies();
    if (spec && spec.apply === 'reload') {
      this.toast(`«${spec.label}» se aplicará al recargar la página.`, 'warn', { label: 'Recargar ahora', fn: () => location.reload() });
    }
    if (key.endsWith('.enabled')) this._renderModules();
  }

  _syncControl(key) {
    const c = this.controls.get(key);
    if (!c) return;
    const v = this.settings.get(key);
    if (c.spec.type === 'bool') c.input.checked = !!v;
    else c.input.value = String(v);
    if (c.out) c.out.textContent = fmtSetting(c.spec, v);
  }

  _syncAllControls() {
    for (const key of this.controls.keys()) this._syncControl(key);
    this._refreshDependencies();
  }

  /** Las funciones temporales dependen del tracking: se deshabilitan sin él. */
  _refreshDependencies() {
    const on = this.settings.get('derived.tracking');
    for (const k of NEEDS_TRACKING) {
      const c = this.controls.get(k);
      if (!c) continue;
      c.input.disabled = !on;
      c.el.title = on ? (c.spec.help || '') : 'Requiere «Tracking con ID persistente»';
    }
  }

  // ---------------------------------------------------------------------------
  // Fuentes de vídeo
  // ---------------------------------------------------------------------------

  _bindSources() {
    const start = (kind) => this.startSource(kind);
    $('src-webcam').addEventListener('click', () => start('webcam'));
    $('src-file').addEventListener('click', () => start('file'));
    $('src-screen').addEventListener('click', () => start('screen'));
    $('src-stop').addEventListener('click', () => this.source.stop());
    for (const b of document.querySelectorAll('#placeholder [data-src]')) b.addEventListener('click', () => start(b.dataset.src));
    $('file-input').addEventListener('change', (e) => {
      const f = e.target.files && e.target.files[0];
      e.target.value = '';
      if (f) this.openFile(f);
    });
    $('cam-select').addEventListener('change', (e) => this._runSource(() => this.source.startWebcam(e.target.value), 'webcam'));
  }

  startSource(kind) {
    if (kind === 'file') { $('file-input').click(); return; }
    if (kind === 'webcam') {
      const sel = $('cam-select');
      return this._runSource(() => this.source.startWebcam(sel.hidden ? undefined : sel.value || undefined), 'webcam');
    }
    if (kind === 'screen') return this._runSource(() => this.source.startScreen(), 'screen');
  }

  openFile(file) {
    return this._runSource(() => this.source.startFile(file), 'file');
  }

  async _runSource(fn, kind) {
    const btns = ['src-webcam', 'src-file', 'src-screen'].map($);
    btns.forEach((b) => { b.disabled = true; });
    try {
      await fn();
      if (kind === 'webcam') await this._fillCameras();
    } catch (e) {
      const msg = e && e.message ? e.message : String(e);
      this.toast(msg, 'error');
      this.log.add('error', 'sistema', msg);
    } finally {
      btns.forEach((b) => { b.disabled = false; });
    }
  }

  async _fillCameras() {
    const cams = await this.source.listCameras();
    const sel = $('cam-select');
    const track = this.source.stream && this.source.stream.getVideoTracks()[0];
    const current = track && track.getSettings ? track.getSettings().deviceId : '';
    sel.replaceChildren(...cams.map((c) => h('option', { value: c.id, text: c.label })));
    if (current) sel.value = current;
    sel.hidden = cams.length < 2;
  }

  _onSourceStarted(st) {
    $('placeholder').hidden = true;
    $('src-stop').disabled = false;
    $('btn-snapshot').disabled = false;
    const what = { webcam: 'webcam', file: `archivo «${st.name}»`, screen: 'captura de pantalla' }[st.kind];
    this.log.add('system', 'sistema', `Fuente activa: ${what} (${st.width}×${st.height})`);
    this.toast(`Fuente activa: ${what}`, 'ok');
    this._syncTransport();
  }

  _onSourceStopped() {
    $('placeholder').hidden = false;
    $('src-stop').disabled = true;
    $('btn-snapshot').disabled = true;
    $('cam-select').hidden = true;
    this.log.add('system', 'sistema', 'Fuente detenida');
    this._syncTransport();
  }

  // ---------------------------------------------------------------------------
  // Reproducción
  // ---------------------------------------------------------------------------

  _bindTransport() {
    $('tp-play').addEventListener('click', () => this.source.togglePlay());
    $('tp-step').addEventListener('click', () => this.step());
    $('tp-seek').addEventListener('input', (e) => {
      const d = this.source.el.duration;
      if (Number.isFinite(d)) this.source.seek((Number(e.target.value) / 1000) * d);
    });
    $('tp-rate').addEventListener('change', (e) => this.source.setRate(Number(e.target.value)));
    $('tp-loop').addEventListener('change', (e) => this.source.setLoop(e.target.checked));
  }

  async step() {
    if (!this.source.kind) return;
    await this.source.step();
    this.engine.requestAnalysis();
  }

  _syncTransport() {
    const st = this.source.state;
    const has = !!st.kind;
    const file = st.kind === 'file';
    $('tp-play').disabled = !has;
    $('tp-step').disabled = !has;
    $('tp-seek').disabled = !file;
    $('tp-rate').disabled = !file;
    $('tp-loop').disabled = !file;
    $('tp-loop').checked = st.loop;
    $('tp-play-path').setAttribute('d', st.paused ? 'M7 5l12 7-12 7z' : 'M7 5h4v14H7zM13 5h4v14h-4z');
    $('tp-play').title = st.paused ? 'Reproducir (Espacio)' : 'Pausar (Espacio)';
    this._syncTime(st);
  }

  _syncTime(st) {
    const file = st.kind === 'file';
    if (file && st.duration) {
      $('tp-time').textContent = `${fmtTime(st.time)} / ${fmtTime(st.duration)}`;
      if (document.activeElement !== $('tp-seek')) $('tp-seek').value = String(Math.round((st.time / st.duration) * 1000));
    } else {
      $('tp-time').textContent = st.kind ? (st.paused ? 'EN DIRECTO · PAUSA' : 'EN DIRECTO') : '--:-- / --:--';
    }
  }

  // ---------------------------------------------------------------------------
  // Registro de eventos y exportación
  // ---------------------------------------------------------------------------

  _bindLog() {
    const box = $('log-filters');
    for (const [k, label] of LEVELS) {
      const chip = h('button', { class: 'chip on', text: label, 'data-level': k });
      chip.addEventListener('click', () => {
        if (this.levelOn.has(k)) this.levelOn.delete(k); else this.levelOn.add(k);
        chip.classList.toggle('on', this.levelOn.has(k));
        this._rebuildLog();
      });
      box.append(chip);
    }
    $('log-clear').addEventListener('click', () => this.log.clear());
  }

  _logRow(e) {
    return h('div', { class: e.level, title: `${e.iso}${e.media != null ? ` · vídeo ${e.media.toFixed(2)} s` : ''} · ${e.category}` },
      h('time', { text: clockTime(e.iso) }), h('span', { text: e.message }));
  }

  _flushLog() {
    if (!this.pendingLog.length) return;
    const box = $('log');
    const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
    const empty = box.querySelector('.empty');
    if (empty) empty.remove();
    const frag = document.createDocumentFragment();
    for (const e of this.pendingLog) if (this.levelOn.has(e.level)) frag.append(this._logRow(e));
    this.pendingLog = [];
    box.append(frag);
    while (box.childElementCount > 400) box.firstElementChild.remove();
    if (nearBottom) box.scrollTop = box.scrollHeight;
  }

  _rebuildLog() {
    const box = $('log');
    const rows = this.log.entries.filter((e) => this.levelOn.has(e.level)).slice(-400).map((e) => this._logRow(e));
    box.replaceChildren(...(rows.length ? rows : [h('span', { class: 'empty', text: 'Sin eventos con este filtro.' })]));
    box.scrollTop = box.scrollHeight;
  }

  _bindExport() {
    $('exp-json').addEventListener('click', () => {
      download(`detectalo_eventos_${stamp()}.json`, this.log.toJSON(), 'application/json');
      this.toast(`Registro exportado (${this.log.entries.length} eventos, JSON).`, 'ok');
    });
    $('exp-csv').addEventListener('click', () => {
      download(`detectalo_eventos_${stamp()}.csv`, this.log.toCSV(), 'text/csv;charset=utf-8');
      this.toast(`Registro exportado (${this.log.entries.length} eventos, CSV).`, 'ok');
    });
    $('btn-snapshot').addEventListener('click', () => this.snapshot());
    $('btn-reset-settings').addEventListener('click', () => {
      if (confirm('¿Restablecer todos los ajustes a sus valores por defecto?')) this.settings.reset();
    });
  }

  async snapshot() {
    try {
      const blob = await this.engine.snapshot();
      download(`detectalo_captura_${stamp()}.png`, blob, 'image/png');
      this.log.add('system', 'sistema', 'Captura PNG guardada');
    } catch (e) {
      this.toast(`No se pudo capturar: ${e.message}`, 'error');
    }
  }

  // ---------------------------------------------------------------------------
  // Zonas y líneas
  // ---------------------------------------------------------------------------

  _bindZones() {
    $('tool-zone').addEventListener('click', () => this._tool('zone'));
    $('tool-line').addEventListener('click', () => this._tool('line'));
    $('tool-flip').addEventListener('click', () => {
      const id = this.engine.editor.selected;
      if (!id) return;
      this.zones.flipLine(id);
      this._zonesChanged();
    });
    $('tool-rename').addEventListener('click', () => this._rename());
    $('tool-delete').addEventListener('click', () => this._deleteSelected());
    $('tool-reset-counts').addEventListener('click', () => {
      this.zones.resetCounts();
      this.log.add('system', 'zona', 'Contadores de zonas y líneas reiniciados');
      this._renderZoneList();
    });
    $('tool-clear').addEventListener('click', () => {
      if (!this.zones.zones.length && !this.zones.lines.length) return;
      if (!confirm('¿Borrar todas las zonas y líneas?')) return;
      this.zones.clear();
      this.zoneEditor.select(null);
      this._zonesChanged();
    });
  }

  _tool(mode) {
    const next = this.zoneEditor.mode === mode ? null : mode;
    this.zoneEditor.setMode(next);
    $('tool-zone').classList.toggle('active', next === 'zone');
    $('tool-line').classList.toggle('active', next === 'line');
  }

  _rename() {
    const id = this.engine.editor.selected;
    const item = this.zones.zones.find((z) => z.id === id) || this.zones.lines.find((l) => l.id === id);
    if (!item) return;
    const name = prompt('Nuevo nombre:', item.name);
    if (name && name.trim()) {
      item.name = name.trim().slice(0, 40);
      this._zonesChanged();
    }
  }

  _deleteSelected() {
    const id = this.engine.editor.selected;
    if (!id) return;
    const item = this.zones.zones.find((z) => z.id === id) || this.zones.lines.find((l) => l.id === id);
    this.zones.remove(id);
    this.zoneEditor.select(null);
    if (item) this.log.add('system', 'zona', `${item.name} eliminada`);
    this._zonesChanged();
  }

  _zonesChanged() {
    this.zones.version++;
    this.store.set('detectalo.zones.v1', this.zones.toJSON());
    $('tool-zone').classList.toggle('active', this.zoneEditor.mode === 'zone');
    $('tool-line').classList.toggle('active', this.zoneEditor.mode === 'line');
    this._renderZoneList();
  }

  _renderZoneList() {
    const sel = this.engine.editor.selected;
    const isLine = this.zones.lines.some((l) => l.id === sel);
    $('tool-flip').disabled = !isLine;
    $('tool-rename').disabled = !sel;
    $('tool-delete').disabled = !sel;
    const key = JSON.stringify([sel, this.zones.zones.map((z) => [z.id, z.name, z.color, z.occupancy, z.entries]), this.zones.lines.map((l) => [l.id, l.name, l.countIn, l.countOut])]);
    patch($('zone-list'), key, () => this._zoneItems(sel));
  }

  _zoneItems(sel) {
    const items = [
      ...this.zones.zones.map((z) => h('div', { class: `zone-item${z.id === sel ? ' sel' : ''}`, onclick: () => this.zoneEditor.select(z.id) },
        h('span', { class: 'sw', style: { background: z.color } }), h('span', { class: 'nm', text: z.name }),
        h('span', { class: 'ct', text: `${z.occupancy} dentro · ${z.entries} entradas` }))),
      ...this.zones.lines.map((l) => h('div', { class: `zone-item${l.id === sel ? ' sel' : ''}`, onclick: () => this.zoneEditor.select(l.id) },
        h('span', { class: 'sw', style: { background: '#38bdf8' } }), h('span', { class: 'nm', text: l.name }),
        h('span', { class: 'ct', text: `ent ${l.countIn} · sal ${l.countOut}` }))),
    ];
    return items.length ? items : [h('p', { class: 'hint', text: 'No hay zonas ni líneas. Dibuja una sobre el vídeo.' })];
  }

  // ---------------------------------------------------------------------------
  // Teclado y arrastrar-soltar
  // ---------------------------------------------------------------------------

  _bindKeys() {
    document.addEventListener('keydown', (e) => {
      const tag = (e.target && e.target.tagName) || '';
      if (/INPUT|SELECT|TEXTAREA/.test(tag) && e.target.type !== 'checkbox' && e.target.type !== 'range') return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const k = e.key;
      if (k === ' ') { e.preventDefault(); this.source.togglePlay(); }
      else if (k === 'ArrowRight' && e.target.type !== 'range') { e.preventDefault(); this.step(); }
      else if (k === 'z' || k === 'Z') this._tool('zone');
      else if (k === 'l' || k === 'L') this._tool('line');
      else if (k === 'Escape') { this.zoneEditor.cancel(); this._zonesChanged(); }
      else if (k === 'Enter' && this.zoneEditor.mode === 'zone') this.zoneEditor.finishZone();
      else if (k === 'Backspace' && this.zoneEditor.mode === 'zone') { e.preventDefault(); this.zoneEditor.undoPoint(); }
      else if ((k === 'Delete' || k === 'Backspace') && this.engine.editor.selected) { e.preventDefault(); this._deleteSelected(); }
      else if (k === 'w' || k === 'W') this.startSource('webcam');
      else if (k === 'o' || k === 'O') this.startSource('file');
      else if ((k === 'p' || k === 'P') && this.source.ready) this.snapshot();
    });
  }

  _bindDrop() {
    const stage = $('stage');
    stage.addEventListener('dragover', (e) => { e.preventDefault(); stage.classList.add('dragover'); });
    stage.addEventListener('dragleave', () => stage.classList.remove('dragover'));
    stage.addEventListener('drop', (e) => {
      e.preventDefault();
      stage.classList.remove('dragover');
      const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (f) this.openFile(f);
    });
  }

  // ---------------------------------------------------------------------------
  // Estado, métricas y avisos
  // ---------------------------------------------------------------------------

  setEngineStatus(status, detail = '') {
    const pill = $('engine-status');
    const txt = {
      boot: 'Iniciando…', loading: 'Cargando modelos…', ready: 'Activo · sin fuente', running: 'Activo · analizando',
      paused: 'Activo · en pausa', error: 'Error de inicialización',
    }[status] || status;
    pill.className = `pill ${status === 'ready' ? 'is-ready' : status === 'running' ? 'is-running' : status === 'error' ? 'is-error' : ''}`;
    pill.querySelector('b').textContent = txt;
    pill.title = detail || txt;
  }

  setBackendInfo(text, title) {
    this.backendText = text;
    $('m-backend').textContent = text;
    $('m-backend').parentElement.title = title || text;
  }

  setSystemInfo(text) { $('sys-info').textContent = text; }

  /** Deshabilita opciones de un selector cuyo archivo no está instalado. */
  markUnavailableOptions(key, values) {
    const c = this.controls.get(key);
    if (!c || c.spec.type !== 'select') return;
    for (const opt of c.input.options) {
      const off = values.includes(opt.value);
      opt.disabled = off;
      const base = (c.spec.options.find(([v]) => String(v) === opt.value) || [null, opt.textContent])[1];
      opt.textContent = off ? `${base} — no instalado` : base;
    }
  }

  toast(msg, level = 'info', action = null) {
    const el = h('div', { class: `toast ${level}`, role: level === 'error' ? 'alert' : 'status' }, h('div', { text: msg }));
    if (action) el.append(h('div', { style: { marginTop: '6px' } }, h('button', { class: 'btn', text: action.label, onclick: action.fn })));
    $('toasts').append(el);
    setTimeout(() => el.remove(), level === 'error' ? 9000 : action ? 10000 : 4500);
    while ($('toasts').childElementCount > 5) $('toasts').firstElementChild.remove();
  }

  _onAlert() {
    const stage = $('stage');
    stage.classList.add('alerting');
    clearTimeout(this._alertTimer);
    this._alertTimer = setTimeout(() => stage.classList.remove('alerting'), 5000);
  }

  _stats(s) {
    this.lastStats = s;
    const target = this.settings.get('perf.fpsTarget');
    const mr = $('m-render');
    setText(mr, s.renderFps.toFixed(0));
    const cls = `metric${s.renderFps < target * 0.8 ? ' bad' : s.renderFps < target ? ' warn' : ''}`;
    if (mr.parentElement.className !== cls) mr.parentElement.className = cls;
    mr.parentElement.title = `FPS de la interfaz (bucle requestAnimationFrame). Trabajo del hilo principal: ${s.frameWork.toFixed(1)} ms/frame`;
    setText($('m-analysis'), s.analysisFps.toFixed(0));
    setText($('m-level'), `N${s.level}`);
    setText($('m-res'), s.input.w ? `${s.input.w}×${s.input.h}` : '');
    $('m-level').parentElement.title = `Degradación adaptativa nivel ${s.level}: resolución de inferencia ${Math.round(s.scale * 100)} %, cadencias ×${s.mult}`;
    if (this.engine.status === 'ready' || this.engine.status === 'running' || this.engine.status === 'paused') {
      const next = !s.source.kind ? 'ready' : s.source.paused ? 'paused' : 'running';
      if (next !== this.engine.status) this.engine.setStatus(next);
    }
    this._renderModules(s);
    this._renderModels(s);
    this._renderCounters(s);
    this._renderEntities(s);
    this._renderAlerts(s);
    this._renderSpark(s);
    this._syncTime(s.source);
    if (s.zones.length || s.lines.length) this._renderZoneList();
    setText($('mem-info'), `${s.tf ? `TF.js: ${s.tf.numTensors} tensores vivos · ${(s.tf.numBytes / 1048576).toFixed(1)} MB (constante = sin fugas) · ` : ''}hilo principal: ${s.frameWork.toFixed(1)} ms/frame`);
  }

  _renderModels(s) {
    const key = JSON.stringify(s.detectors.map((d) => [d.enabled, d.status, d.backend, d.effCadence, d.hz.toFixed(1), d.latency.toFixed(0)]));
    patch($('models-body'), key, () => this._modelRows(s));
  }

  _modelRows(s) {
    return s.detectors.map((d) => h('tr', { class: d.enabled && d.status === 'ready' ? '' : 'off' },
      h('td', { text: `${d.letter} · ${d.name}` }),
      h('td', { text: d.status === 'ready' ? d.backend : STATUS_TEXT[d.status] || d.status }),
      h('td', { class: 'num', text: d.enabled ? String(d.effCadence) : '—' }),
      h('td', { class: 'num', text: d.enabled && d.status === 'ready' ? d.hz.toFixed(1) : '—' }),
      h('td', { class: 'num', text: d.latency ? d.latency.toFixed(0) : '—' })));
  }

  _renderCounters(s) {
    const c = s.counts;
    const crossIn = s.lines.reduce((n, l) => n + l.in, 0), crossOut = s.lines.reduce((n, l) => n + l.out, 0);
    const occ = s.zones.reduce((n, z) => n + z.occupancy, 0);
    const card = (value, label, sub) => h('div', { class: 'counter' }, h('b', { text: String(value) }), h('span', { text: label }), sub ? h('small', { text: ` ${sub}` }) : null);
    const key = JSON.stringify([c.persons, c.personsUnique, c.objects, c.objectsUnique, c.hands, c.handsL, c.handsR, c.faces, occ, s.zones.length, crossIn, crossOut, s.lines.length, s.tracking, c.classes, c.personSource]);
    if ($('counters')._patchKey === key) return;
    $('counters')._patchKey = key;
    $('counters').replaceChildren(
      card(c.persons, 'Personas', s.tracking ? `· ${c.personsUnique} únicas` : ''),
      card(c.objects, 'Objetos', s.tracking ? `· ${c.objectsUnique} únicos` : ''),
      card(c.hands, 'Manos', `· izq ${c.handsL} · der ${c.handsR}`),
      card(c.faces, 'Rostros', ''),
      card(occ, 'En zonas', `· ${s.zones.length} zonas`),
      card(`${crossIn}/${crossOut}`, 'Entradas/salidas', `· ${s.lines.length} líneas`),
    );
    const chips = c.classes.map(([label, n]) => h('span', { class: 'chip', text: `${label} ×${n}` }));
    if (c.personSource === 'objects') chips.unshift(h('span', { class: 'chip', title: 'Pose desactivada: las personas se obtienen de COCO-SSD', text: 'personas vía COCO-SSD' }));
    $('class-chips').replaceChildren(...chips);
  }

  _renderEntities(s) {
    const key = JSON.stringify([s.persons.map((p) => [p.id, p.posture, p.walking, p.armsUp, p.fall, Math.floor(p.still), Object.entries(p.angles || {}).map(([k, v]) => [k, Math.round(v / 3)])]),
      s.faces.map((f) => [f.id, f.ear.toFixed(2), f.blinks, Math.round(f.perclos * 100), f.mar.toFixed(2), Math.round(f.yaw / 4), Math.round(f.pitch / 4), Math.round(f.roll / 4), f.gaze, f.closed, f.mouthOpen, f.smiling])]);
    if ($('entities')._patchKey === key) return;
    $('entities')._patchKey = key;
    const out = [];
    for (const p of s.persons) {
      const a = p.angles || {};
      const ang = ['codo izq.', 'codo der.', 'rodilla izq.', 'rodilla der.'].filter((k) => a[k] != null).map((k) => `${k} ${Math.round(a[k])}°`).join(' · ');
      const flags = [p.walking && 'caminando', p.armsUp && 'brazos en alto', p.fall === 'candidate' && '¿caída?', p.fall === 'fallen' && 'CAÍDA', p.still >= 3 && `quieta ${Math.floor(p.still)} s`].filter(Boolean).join(' · ');
      out.push(h('div', { class: 'entity', style: { borderLeftColor: p.color } },
        h('span', { class: 't', text: `Persona #${p.id} — ${p.posture ? POSTURE_LABEL[p.posture] : '…'}` }),
        flags ? h('span', { class: 'k', text: flags }) : null,
        ang ? h('span', { class: 'k', text: ang }) : null));
    }
    for (const f of s.faces) {
      const st = [f.closed && 'ojos cerrados', f.mouthOpen && 'boca abierta', f.smiling && 'sonríe'].filter(Boolean).join(' · ');
      out.push(h('div', { class: 'entity', style: { borderLeftColor: '#a7f3d0' } },
        h('span', { class: 't', text: `Rostro #${f.id}${st ? ` — ${st}` : ''}` }),
        h('span', { class: 'k', text: `EAR ${f.ear.toFixed(2)} · parpadeos ${f.blinks}/min · PERCLOS ${(f.perclos * 100).toFixed(0)} % · MAR ${f.mar.toFixed(2)}` }),
        h('span', { class: 'k', text: `giro ${turnLabel(f.yaw, 'a su izq.', 'a su der.')} · inclinación ${turnLabel(f.pitch, 'arriba', 'abajo')} · ladeo ${turnLabel(f.roll, 'a su izq.', 'a su der.')}` }),
        h('span', { class: 'k', text: `mirada aprox.: ${f.gaze}` })));
    }
    $('entities').replaceChildren(...(out.length ? out : [h('p', { class: 'hint', text: 'Aparecerán aquí las personas y rostros analizados.' })]));
  }

  _renderAlerts(s) {
    setText($('alert-total'), String(s.alerts.total));
    const entries = Object.entries(s.alerts.byType);
    patch($('alerts-sum'), JSON.stringify(entries), () => (entries.length
      ? entries.map(([k, n]) => h('span', { text: `${ALERT_NAMES[k] || k}: ${n}` }))
      : [h('span', { text: 'Sin alertas', style: { opacity: '.6', background: 'none', borderColor: 'var(--line2)', color: 'var(--muted)' } })]));
  }

  _renderSpark(s) {
    const c = $('motion-spark');
    const ctx = c.getContext('2d');
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = Math.round(c.clientWidth * dpr), hh = Math.round(70 * dpr);
    if (c.width !== w || c.height !== hh) { c.width = w; c.height = hh; }
    ctx.clearRect(0, 0, w, hh);
    const hist = s.motion.history;
    if (!hist.length) {
      ctx.fillStyle = '#52657a';
      ctx.font = `${11 * dpr}px ui-monospace, monospace`;
      ctx.fillText(this.settings.get('motion.enabled') ? 'Esperando vídeo…' : 'Módulo E desactivado', 8 * dpr, 20 * dpr);
      return;
    }
    const max = Math.max(0.05, ...hist);
    ctx.strokeStyle = '#22d3ee';
    ctx.lineWidth = 1.5 * dpr;
    ctx.beginPath();
    hist.forEach((v, i) => {
      const x = (i / Math.max(1, hist.length - 1)) * w;
      const y = hh - 4 * dpr - (v / max) * (hh - 12 * dpr);
      if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y);
    });
    ctx.stroke();
    ctx.fillStyle = '#7f93a8';
    ctx.font = `${10.5 * dpr}px ui-monospace, monospace`;
    ctx.fillText(`${((s.motion.energy || 0) * 100).toFixed(1)} % en movimiento · z ${s.motion.z.toFixed(1)}`, 8 * dpr, 14 * dpr);
  }
}

/** Asigna texto sólo si cambia (evita invalidar estilo/layout sin necesidad). */
function setText(el, text) {
  if (el.textContent !== text) el.textContent = text;
}

/** Reconstruye los hijos de `el` sólo si la clave de contenido cambió. */
function patch(el, key, build) {
  if (el._patchKey === key) return;
  el._patchKey = key;
  el.replaceChildren(...build());
}

function fmtSetting(spec, v) {
  switch (spec.fmt) {
    case 'pct': return `${Math.round(v * 100)} %`;
    case 's': return `${Number(v).toFixed(spec.step < 1 ? 1 : 0)} s`;
    case 'ms': return `${v} ms`;
    case 'fps': return `${v} FPS`;
    case 'n': return `1/${v}`;
    case 'x': return `${Number(v).toFixed(2)}`;
    default: return String(v);
  }
}

