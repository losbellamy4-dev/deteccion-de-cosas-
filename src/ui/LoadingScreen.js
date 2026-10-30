/**
 * LoadingScreen.js — Pantalla de carga con progreso POR MODELO y tarjetas de
 * error que dicen exactamente qué archivo falta y dónde debe ir.
 */
import { h } from './dom.js';
import { fmtBytes } from '../core/AssetChecker.js';
import { MODULES } from '../config.js';

const MODULE_LABEL = Object.fromEntries(MODULES.map((m) => [m.id, `${m.letter} · ${m.name}`]));

const ICON = { run: '◌', ok: '✓', error: '✕', skip: '–', warn: '!' };

export class LoadingScreen {
  constructor(root) {
    this.root = root;
    this.steps = root.querySelector('#load-steps');
    this.errors = root.querySelector('#load-errors');
    this.btnContinue = root.querySelector('#load-continue');
    this.btnRetry = root.querySelector('#load-retry');
    this.sub = root.querySelector('#load-sub');
    this.rows = new Map();
  }

  show() { this.root.hidden = false; }
  hide() { this.root.hidden = true; }

  /** Crea o actualiza una fila de progreso. */
  step(id, label, state = 'run', detail = '') {
    let r = this.rows.get(id);
    if (!r) {
      const ic = h('span', { class: 'ic' });
      const b = h('b');
      const small = h('small');
      const bytes = h('span', { class: 'bytes' });
      const bar = h('i');
      const el = h('div', { class: 'step' }, ic, h('div', { class: 'lbl' }, b, small), bytes, h('div', { class: 'bar' }, bar));
      this.steps.append(el);
      r = { el, ic, b, small, bytes, bar };
      this.rows.set(id, r);
    }
    r.el.className = `step ${state}`;
    r.ic.textContent = ICON[state] || '·';
    r.b.textContent = label;
    r.small.textContent = detail;
    if (state === 'ok') r.bar.style.width = '100%';
    if (state === 'error' || state === 'skip') r.bar.style.width = '0%';
  }

  progress(id, got, total) {
    const r = this.rows.get(id);
    if (!r) return;
    const f = total ? Math.min(1, got / total) : 0;
    r.bar.style.width = `${(f * 100).toFixed(1)}%`;
    r.bytes.textContent = total ? `${fmtBytes(got)} / ${fmtBytes(total)}` : fmtBytes(got);
  }

  progressFrac(id, f) {
    const r = this.rows.get(id);
    if (!r) return;
    r.bar.style.width = `${(Math.min(1, f) * 100).toFixed(1)}%`;
    r.bytes.textContent = `${Math.round(f * 100)} %`;
  }

  /**
   * Tarjeta de problema con un archivo.
   * @param {'error'|'warn'} level
   * @param {{asset:object, message:string}} res resultado de checkAsset
   */
  addFileIssue(level, res) {
    const a = res.asset;
    const mods = (a.needs || []).map((id) => MODULE_LABEL[id] || id).join(', ');
    this.errors.append(h('div', { class: `err-card ${level === 'warn' ? 'warn' : ''}` },
      h('b', { text: level === 'warn' ? (a.optional && !res.ok ? 'Archivo opcional ausente' : 'Aviso') : 'Archivo necesario no disponible' }),
      h('p', { text: res.message }),
      h('p', {}, 'Debe estar en: ', h('code', { text: `<carpeta del proyecto>/${a.path}` })),
      h('p', {}, 'Origen oficial: ', h('code', { text: a.source || '—' }), ' — URLs exactas en README.md, sección «Archivos a descargar».'),
      mods ? h('p', { text: `Afecta a: ${mods}${a.note ? ` (${a.note})` : ''}` }) : null,
    ));
  }

  addMessage(level, title, text) {
    this.errors.append(h('div', { class: `err-card ${level === 'warn' ? 'warn' : ''}` }, h('b', { text: title }), h('p', { text })));
  }

  /**
   * Espera a que el usuario decida: continuar con lo disponible o reintentar.
   * @returns {Promise<'continue'|'retry'>}
   */
  waitForChoice({ canContinue, summary }) {
    if (summary) this.sub.textContent = summary;
    this.btnRetry.hidden = false;
    this.btnContinue.hidden = !canContinue;
    return new Promise((resolve) => {
      this.btnContinue.onclick = () => resolve('continue');
      this.btnRetry.onclick = () => resolve('retry');
    });
  }
}
