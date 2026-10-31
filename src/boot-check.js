/*
 * boot-check.js — Comprobaciones previas en un script CLÁSICO (no módulo), para
 * poder avisar incluso cuando los módulos ES no llegan a cargarse:
 *  - la página se abrió con file:// (los módulos, WebGL y los modelos necesitan
 *    un servidor local);
 *  - navegador sin módulos ES / WebAssembly;
 *  - el módulo principal no arrancó (p. ej. el servidor sirve .js con un tipo
 *    MIME incorrecto, típico de algunos Windows con `python -m http.server`).
 * Escrito en ES5 a propósito.
 */
(function () {
  'use strict';

  function fatal(title, html) {
    var el = document.createElement('div');
    el.className = 'fatal';
    el.innerHTML = '<div class="box"><h2>' + title + '</h2>' + html + '</div>';
    document.body.appendChild(el);
  }

  var CMD = '<p><code>cd ruta/a/la/carpeta</code><br><code>python -m http.server 8000</code> (o <code>python serve.py</code>)</p>' +
    '<p>y abre en el navegador <code>localhost:8000</code></p>';

  if (location.protocol === 'file:' && !window.__DETECTALO_PORTABLE__) {
    fatal('Abre la app desde un servidor local',
      '<p>Has abierto <code>index.html</code> directamente (file://). El navegador bloquea así la carga de los modelos, los módulos JavaScript y WebGL.</p>' +
      '<p>En una terminal, dentro de la carpeta del proyecto:</p>' + CMD);
    return;
  }

  var noModules = !('noModule' in document.createElement('script'));
  if (noModules || typeof WebAssembly !== 'object') {
    fatal('Navegador no compatible',
      '<p>Se necesita un navegador moderno con módulos ES y WebAssembly (Chrome/Edge 113+, Firefox 115+ o Safari 17+).</p>');
    return;
  }

  // Vigilante: main.js marca window.__detectaloBooted al empezar a ejecutarse.
  setTimeout(function () {
    if (window.__detectaloBooted) return;
    fatal('La aplicación no ha podido arrancar',
      '<p>El módulo principal (<code>src/main.js</code>) no se ha ejecutado. Causas habituales:</p>' +
      '<ul><li>El servidor envía los <code>.js</code> con un tipo MIME incorrecto (p. ej. <code>text/plain</code> en algunos Windows). Solución: usa <code>python serve.py</code>, que fuerza los tipos correctos.</li>' +
      '<li>Falta algún archivo de <code>src/</code> o hay un error de sintaxis (mira la consola del navegador, F12).</li></ul>' + CMD);
  }, 8000);
})();
