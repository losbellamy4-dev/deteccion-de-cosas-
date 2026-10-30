#!/usr/bin/env python3
"""
verificar_offline.py — Comprueba los requisitos "local y offline":

  1. Ninguna referencia a dominios externos en el CÓDIGO DE LA APP
     (index.html, src/**): ni http(s)://, ni //cdn…, ni cdn., ni ws(s)://,
     ni @import de hojas de estilo remotas.
  2. Los archivos imprescindibles de /lib y /models están presentes (y, con
     --hash, que su SHA-256 coincide con la versión verificada).
  3. Informativo: URLs que aparecen como TEXTO dentro de las librerías de
     terceros de /lib (enlaces de documentación en mensajes de error). No son
     peticiones: la app no las invoca y, además, la CSP del index.html
     bloquearía cualquier conexión a otro origen.

Uso:  python tools/verificar_offline.py [--hash]
"""
import argparse
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from descargar_dependencias import FILES, ROOT, sha256_file  # noqa: E402

PATTERNS = [
    (re.compile(r"https?://", re.I), "URL http(s)"),
    (re.compile(r"wss?://", re.I), "WebSocket"),
    (re.compile(r"(?<![\w.])//[a-z0-9-]+\.[a-z]{2,}", re.I), "URL relativa al protocolo"),
    (re.compile(r"\bcdn\.", re.I), "dominio cdn."),
    (re.compile(r"@import\s+url\(", re.I), "@import remoto"),
]


def app_files():
    yield os.path.join(ROOT, "index.html")
    for base, _dirs, files in os.walk(os.path.join(ROOT, "src")):
        for f in files:
            if f.endswith((".js", ".mjs", ".css", ".html", ".json")):
                yield os.path.join(base, f)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--hash", action="store_true", help="verifica también el SHA-256 de cada archivo")
    args = ap.parse_args()
    problems = 0

    print("1) Referencias externas en el código de la app (index.html + src/):")
    hits = 0
    for path in app_files():
        rel = os.path.relpath(path, ROOT)
        with open(path, encoding="utf-8") as f:
            for n, line in enumerate(f, 1):
                for rx, what in PATTERNS:
                    if rx.search(line):
                        hits += 1
                        print(f"   ✕ {rel}:{n} [{what}] {line.strip()[:120]}")
    if hits:
        problems += hits
    else:
        print("   ✓ Ninguna. El código sólo usa rutas relativas al propio servidor local.")

    print("\n2) Archivos locales imprescindibles:")
    missing = 0
    for rel, _src, _m, _size, sha, group in FILES:
        path = os.path.join(ROOT, rel)
        if not os.path.isfile(path):
            if group == "necesario":
                missing += 1
                print(f"   ✕ falta {rel}")
            continue
        if args.hash and sha256_file(path) != sha:
            print(f"   ! {rel}: SHA-256 distinto de la versión verificada")
            if group == "necesario":
                missing += 1
    if missing:
        problems += missing
        print("   → Ejecuta: python tools/descargar_dependencias.py")
    else:
        print("   ✓ Todos presentes" + (" y verificados." if args.hash else "."))

    print("\n3) Informativo — URLs como texto dentro de librerías de terceros (/lib):")
    lib = os.path.join(ROOT, "lib")
    found = {}
    if os.path.isdir(lib):
        rx = re.compile(rb"https?://[A-Za-z0-9.\-]+")
        for base, _d, files in os.walk(lib):
            for f in files:
                if not f.endswith((".js", ".mjs")):
                    continue
                with open(os.path.join(base, f), "rb") as fh:
                    for m in rx.findall(fh.read()):
                        host = m.decode("ascii", "replace").split("//", 1)[1]
                        found.setdefault(host, set()).add(f)
    if found:
        for host, fs in sorted(found.items()):
            print(f"   · {host}  ({', '.join(sorted(fs))})")
        print("   Son textos (licencias, enlaces de ayuda en mensajes de error), no peticiones.")
        print("   La CSP de index.html (connect-src/script-src 'self') impide cualquier conexión externa.")
    else:
        print("   (sin librerías en /lib todavía)")

    print("\nResultado:", "OK" if not problems else f"{problems} problema(s)")
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
