#!/usr/bin/env python3
"""
serve.py — Servidor estático local para «Detéctalo todo».

Funciona igual que `python -m http.server 8000`, pero además:
  * escucha sólo en 127.0.0.1 (no expone tu carpeta a la red local);
  * fuerza los tipos MIME correctos (.js/.mjs → text/javascript,
    .wasm → application/wasm): evita el fallo típico de algunos Windows,
    donde el registro asocia .js a text/plain y los módulos no cargan;
  * envía la misma política CSP del index.html como cabecera HTTP, de modo
    que también se aplica dentro de los Web Workers (una CSP en <meta> no
    alcanza a los workers);
  * opcional --coi: activa el aislamiento entre orígenes (COOP/COEP), que
    permite el backend WASM multihilo de TF.js en equipos sin GPU.

Uso:  python serve.py [--port 8000] [--coi]
"""
import argparse
import functools
import http.server
import os
import sys

MIME = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json",
    ".wasm": "application/wasm",
    ".task": "application/octet-stream",
    ".tflite": "application/octet-stream",
    ".bin": "application/octet-stream",
    ".md": "text/markdown; charset=utf-8",
    ".png": "image/png",
    ".svg": "image/svg+xml",
}

CSP = ("default-src 'self'; script-src 'self' blob: 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; "
       "img-src 'self' data: blob:; media-src 'self' blob: mediastream:; connect-src 'self' data: blob:; "
       "worker-src 'self' blob:; font-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; "
       "frame-ancestors 'none'")


class Handler(http.server.SimpleHTTPRequestHandler):
    coi = False

    def guess_type(self, path):
        ext = os.path.splitext(path)[1].lower()
        if ext in MIME:
            return MIME[ext]
        if os.path.basename(path).startswith("group1-shard"):
            return "application/octet-stream"
        return super().guess_type(path)

    def end_headers(self):
        self.send_header("Content-Security-Policy", CSP)
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("Cache-Control", "no-cache")
        if self.coi:
            self.send_header("Cross-Origin-Opener-Policy", "same-origin")
            self.send_header("Cross-Origin-Embedder-Policy", "require-corp")
        super().end_headers()

    def log_message(self, fmt, *args):
        # Sólo errores: la consola queda limpia con el tráfico normal.
        if len(args) >= 2 and str(args[1]).startswith(("4", "5")):
            sys.stderr.write(f"[{self.log_date_time_string()}] {self.address_string()} {fmt % args}\n")


def main():
    ap = argparse.ArgumentParser(description="Servidor local de Detéctalo todo")
    ap.add_argument("--port", type=int, default=8000)
    ap.add_argument("--host", default="127.0.0.1", help="interfaz de escucha (por defecto sólo este equipo)")
    ap.add_argument("--coi", action="store_true", help="activa COOP/COEP (WASM multihilo de TF.js)")
    args = ap.parse_args()
    root = os.path.dirname(os.path.abspath(__file__))
    Handler.coi = args.coi
    handler = functools.partial(Handler, directory=root)
    with http.server.ThreadingHTTPServer((args.host, args.port), handler) as httpd:
        shown = "localhost" if args.host in ("127.0.0.1", "localhost") else args.host
        print(f"Detéctalo todo — sirviendo {root}")
        print(f"Abre en el navegador:  http://{shown}:{args.port}")
        if args.host not in ("127.0.0.1", "localhost"):
            print("Aviso: fuera de localhost el navegador bloquea la cámara salvo con HTTPS.")
        print("Ctrl+C para detener.")
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\nServidor detenido.")


if __name__ == "__main__":
    main()
