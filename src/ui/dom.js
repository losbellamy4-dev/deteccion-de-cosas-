/**
 * dom.js — Utilidades mínimas de DOM. Todo el contenido dinámico se inserta
 * como TEXTO (textContent), nunca como HTML, para que nombres de archivo,
 * nombres de zona o mensajes de error no puedan inyectar marcado.
 */

/** Crea un elemento: h('div', {class:'x', text:'hola', onclick: fn}, ...hijos). */
export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (typeof v !== 'string' && k in el) el[k] = v;
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : String(c));
  }
  return el;
}

/** Descarga local de un Blob o texto (sin subir nada a ningún sitio). */
export function download(name, data, type = 'application/octet-stream') {
  const blob = data instanceof Blob ? data : new Blob([data], { type });
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

export function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

export function fmtTime(s) {
  if (!Number.isFinite(s)) return '--:--';
  const m = Math.floor(s / 60);
  const r = Math.floor(s % 60);
  return `${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`;
}

export function clockTime(iso) {
  const d = new Date(iso);
  return d.toLocaleTimeString('es-ES', { hour12: false });
}
