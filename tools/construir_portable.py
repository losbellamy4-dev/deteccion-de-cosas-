#!/usr/bin/env python3
"""
construir_portable.py — Genera dist/detectalo-todo-portable.html: UN ÚNICO
archivo HTML con la app, las librerías y los modelos dentro, que funciona con
doble clic (file://), sin servidor, sin Python y sin conexión.

Cómo funciona el HTML generado:
  * El código de src/ se empaqueta en un solo <script type="module"> (cada
    módulo queda envuelto en su propia función; los import/export estáticos se
    convierten en un registro interno).
  * Cada archivo de lib/ y models/ se comprime con gzip y se incrusta en base64
    dentro de un <script type="application/x-detectalo-asset">, que el
    navegador NO ejecuta: sólo guarda el texto.
  * Un pequeño script inicial sustituye fetch(): las peticiones a esas rutas
    (lib/…, models/…) se responden desde los datos incrustados. Los binarios
    WASM y los scripts se entregan como URLs blob:, porque el navegador no
    deja leer file:// y Emscripten no carga WASM desde file://.
  * La CSP usa hashes de los scripts en línea y sólo permite data: y blob:
    para conexiones: el archivo no puede contactar con ninguna red.
  * En este modo los modelos se ejecutan en el hilo principal (sin Web
    Workers): la versión con servidor local sigue siendo la más fluida.

Requisito: tener descargadas las dependencias (python tools/descargar_dependencias.py).
Uso:  python tools/construir_portable.py [--salida dist/detectalo-todo-portable.html]
"""
import argparse
import base64
import gzip
import hashlib
import json
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# (ruta, tipo MIME) de lo que se incrusta. Se omiten las piezas opcionales
# (pose full/heavy, MediaPipe sin SIMD, EfficientDet-Lite2 y el modelo
# alternativo COCO-SSD con TensorFlow.js) para que el archivo pese menos: en
# el HTML portable esas opciones aparecen como «no instalado».
EMBED = [
    ("lib/mediapipe/vision_bundle.mjs", "text/javascript"),
    ("lib/mediapipe/wasm/vision_wasm_internal.js", "text/javascript"),
    ("lib/mediapipe/wasm/vision_wasm_internal.wasm", "application/wasm"),
    ("models/pose/pose_landmarker_lite.task", "application/octet-stream"),
    ("models/hands/hand_landmarker.task", "application/octet-stream"),
    ("models/face/face_landmarker.task", "application/octet-stream"),
    ("models/objects/efficientdet_lite0.tflite", "application/octet-stream"),
    ("models/classifier/efficientnet_lite0.tflite", "application/octet-stream"),
]

# Script inicial: datos incrustados + fetch() local + URLs blob:.
RUNTIME = r"""(function () {
  'use strict';
  var origFetch = window.fetch.bind(window);
  var baseDir = new URL('.', document.baseURI).href;
  var index = null, bytesCache = new Map(), urlCache = new Map();

  // Índice de bloques de datos (ruta → elemento). Se construye cuando ya se
  // ha leído todo el documento (la app arranca después).
  function blocks() {
    if (index) return index;
    var found = {};
    var els = document.querySelectorAll('script[type="application/x-detectalo-asset"]');
    for (var i = 0; i < els.length; i++) {
      found[els[i].getAttribute('data-path')] = { el: els[i], size: +els[i].getAttribute('data-size'), type: els[i].getAttribute('data-type') };
    }
    if (document.readyState !== 'loading') index = found;
    return found;
  }
  function has(path) { return Object.prototype.hasOwnProperty.call(blocks(), path); }
  function info(path) { var b = blocks()[path]; return b ? { size: b.size, type: b.type } : null; }

  // base64 → gzip → bytes, con el decodificador nativo del navegador.
  function decode(b64) {
    return origFetch('data:application/octet-stream;base64,' + b64).then(function (res) {
      if (typeof DecompressionStream === 'undefined') throw new Error('Navegador demasiado antiguo: falta DecompressionStream (usa Chrome, Edge o Firefox recientes).');
      return new Response(res.body.pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
    }).then(function (buf) { return new Uint8Array(buf); });
  }
  function bytes(path) {
    if (!bytesCache.has(path)) {
      var b = blocks()[path];
      if (!b) return Promise.reject(new Error('Archivo no incrustado: ' + path));
      var p = decode(b.el.textContent);
      p.then(function () { b.el.textContent = ''; }, function () {}); // libera el texto base64
      bytesCache.set(path, p);
    }
    return bytesCache.get(path);
  }
  function blobUrl(path, type) {
    var key = path + '|' + (type || '');
    if (!urlCache.has(key)) {
      urlCache.set(key, bytes(path).then(function (u8) {
        return URL.createObjectURL(new Blob([u8], { type: type || info(path).type }));
      }));
    }
    return urlCache.get(key);
  }

  // fetch(): las rutas de la carpeta de la app se sirven desde los datos
  // incrustados (404 si no están); el resto (data:, blob:) sigue igual.
  function keyOf(url) {
    var abs;
    try { abs = new URL(url, document.baseURI).href; } catch (e) { return null; }
    if (abs.indexOf(baseDir) !== 0) return null;
    return decodeURIComponent(abs.slice(baseDir.length).split(/[?#]/)[0]);
  }
  window.fetch = function (input, init) {
    var url = typeof input === 'string' ? input : (input && input.url) || String(input);
    var key = keyOf(url);
    if (key === null) return origFetch(input, init);
    var method = String((init && init.method) || (input && input.method) || 'GET').toUpperCase();
    if (!has(key)) return Promise.resolve(new Response('No incluido en el HTML portable: ' + key, { status: 404, headers: { 'content-type': 'text/plain' } }));
    var meta = info(key);
    var headers = { 'content-type': meta.type, 'content-length': String(meta.size) };
    if (method === 'HEAD') return Promise.resolve(new Response(null, { status: 200, headers: headers }));
    return bytes(key).then(function (u8) { return new Response(u8, { status: 200, headers: headers }); });
  };

  window.__DETECTALO_PORTABLE__ = { has: has, info: info, bytes: bytes, blobUrl: blobUrl };
})();
"""

IMPORT_RE = re.compile(r"^import\s*\{([^}]*)\}\s*from\s*'([^']+)';[ \t]*$", re.M)
EXPORT_RE = re.compile(r"^export\s+((?:async\s+)?(?:function\*?|class|const|let))\s+([A-Za-z_$][\w$]*)", re.M)


def module_id(path):
    return os.path.relpath(path, ROOT).replace(os.sep, "/")


def resolve(mid, spec):
    return os.path.normpath(os.path.join(os.path.dirname(mid), spec)).replace(os.sep, "/")


def transform(mid, code):
    """Convierte un módulo ES (imports/exports estáticos) en una función del registro."""
    deps, exports = [], []

    def on_import(m):
        names = []
        for n in (x.strip() for x in m.group(1).split(",")):
            if not n:
                continue
            if " as " in n:
                a, b = (x.strip() for x in n.split(" as "))
                names.append(f"{a}: {b}")
            else:
                names.append(n)
        dep = resolve(mid, m.group(2))
        deps.append(dep)
        return f"const {{ {', '.join(names)} }} = __req({json.dumps(dep)});"

    def on_export(m):
        exports.append(m.group(2))
        return f"{m.group(1)} {m.group(2)}"

    code = IMPORT_RE.sub(on_import, code)
    code = EXPORT_RE.sub(on_export, code)
    if re.search(r"^\s*export\b", code, re.M):
        raise SystemExit(f"Sintaxis de export no soportada por el empaquetador en {mid}")
    if re.search(r"^\s*import\s+[^(]", code, re.M):
        raise SystemExit(f"Sintaxis de import no soportada por el empaquetador en {mid}")
    tail = f"\nObject.assign(__m, {{ {', '.join(exports)} }});" if exports else ""
    return deps, f"__defs[{json.dumps(mid)}] = function (__m) {{\n{code}{tail}\n}};\n"


def bundle(entry="src/main.js"):
    order, seen = [], set()

    def visit(mid):
        if mid in seen:
            return
        seen.add(mid)
        with open(os.path.join(ROOT, mid), encoding="utf-8") as f:
            deps, out = transform(mid, f.read())
        for d in deps:
            visit(d)
        order.append(out)

    visit(entry)
    head = ("const __defs = Object.create(null), __cache = Object.create(null);\n"
            "function __req(id) { let m = __cache[id]; if (m) return m; m = __cache[id] = {}; "
            "const f = __defs[id]; if (!f) throw new Error('Módulo no incluido: ' + id); f(m); return m; }\n")
    return head + "".join(order) + f"__req({json.dumps(entry)});\n", len(order)


def csp_hash(text):
    return "'sha256-" + base64.b64encode(hashlib.sha256(text.encode("utf-8")).digest()).decode() + "'"


def main():
    ap = argparse.ArgumentParser(description="Genera el HTML portable de Detéctalo todo")
    ap.add_argument("--salida", default=os.path.join(ROOT, "dist", "detectalo-todo-portable.html"))
    args = ap.parse_args()

    missing = [p for p, _ in EMBED if not os.path.isfile(os.path.join(ROOT, p))]
    if missing:
        print("Faltan dependencias; ejecuta antes: python tools/descargar_dependencias.py")
        for p in missing:
            print("  -", p)
        return 1

    app, nmods = bundle()
    with open(os.path.join(ROOT, "src", "boot-check.js"), encoding="utf-8") as f:
        boot = f.read()
    for name, text in (("app", app), ("boot-check", boot), ("runtime", RUNTIME)):
        if "</script" in text.lower() or "<!--" in text:
            raise SystemExit(f"El script {name} contiene una secuencia que rompería el HTML")

    blocks, raw_total = [], 0
    for path, mime in EMBED:
        with open(os.path.join(ROOT, path), "rb") as f:
            data = f.read()
        raw_total += len(data)
        b64 = base64.b64encode(gzip.compress(data, compresslevel=9, mtime=0)).decode("ascii")
        blocks.append(f'<script type="application/x-detectalo-asset" data-path="{path}" data-type="{mime}" data-size="{len(data)}">{b64}</script>')
        print(f"  + {path}  ({len(data) / 1048576:.1f} MB → {len(b64) / 1048576:.1f} MB en base64)")

    csp = ("default-src 'none'; "
           f"script-src {csp_hash(RUNTIME)} {csp_hash(boot)} {csp_hash(app)} blob: 'wasm-unsafe-eval'; "
           "style-src 'unsafe-inline'; img-src data: blob:; media-src blob: mediastream:; "
           "connect-src data: blob:; worker-src blob:; font-src 'none'; object-src 'none'; "
           "base-uri 'none'; form-action 'none'")

    with open(os.path.join(ROOT, "index.html"), encoding="utf-8") as f:
        html = f.read()
    html, n1 = re.subn(r'<meta http-equiv="Content-Security-Policy" content="[^"]*">',
                       f'<meta http-equiv="Content-Security-Policy" content="{csp}">', html)
    html, n2 = re.subn(r"<title>[^<]*</title>", "<title>Detéctalo todo (portable)</title>", html)
    html, n3 = re.subn(r'\s*<script src="src/boot-check.js" defer></script>\s*<script type="module" src="src/main.js"></script>',
                       f"\n  <script>{RUNTIME}</script>", html)
    if (n1, n2, n3) != (1, 1, 1):
        raise SystemExit("index.html no tiene la estructura esperada (CSP, title y scripts)")
    tail = "\n".join(blocks) + f"\n<script>{boot}</script>\n<script type=\"module\">{app}</script>\n"
    if html.count("</body>") != 1:
        raise SystemExit("index.html no tiene la estructura esperada (</body>)")
    html = html.replace("</body>", tail + "</body>")

    os.makedirs(os.path.dirname(args.salida), exist_ok=True)
    with open(args.salida, "w", encoding="utf-8", newline="\n") as f:
        f.write(html)
    size = os.path.getsize(args.salida)
    print(f"\n{nmods} módulos empaquetados · {raw_total / 1048576:.1f} MB de librerías y modelos")
    print(f"Generado: {os.path.relpath(args.salida, ROOT)}  ({size / 1048576:.1f} MB)")
    print("Ábrelo con doble clic en Chrome o Edge: funciona sin servidor y sin conexión.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
