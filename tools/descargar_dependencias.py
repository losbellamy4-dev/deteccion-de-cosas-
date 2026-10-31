#!/usr/bin/env python3
"""
descargar_dependencias.py — Descarga UNA SOLA VEZ las librerías y modelos que
«Detéctalo todo» necesita en /lib y /models, desde sus orígenes oficiales:

  * Librerías JS: registro oficial de npm (tarballs versionados e inmutables).
    Se extraen únicamente los archivos necesarios.
  * Modelos MediaPipe (pose, manos, rostro, objetos EfficientDet y
    reconocedor de 1000 cosas EfficientNet): almacén oficial de modelos de
    Google (rutas versionadas /1/).
  * Modelo COCO-SSD (alternativo): almacén oficial de modelos de TensorFlow.js.

NOTA: el repositorio ya incluye /lib y /models listos para usar. Este script
sólo hace falta si se borraron, o para las variantes de pose "full"/"heavy".

Cada archivo se verifica con su SHA-256 (calculado sobre las versiones
probadas con esta app). Sólo usa la biblioteca estándar de Python 3.

Uso (desde la carpeta del proyecto):
    python tools/descargar_dependencias.py               # necesarios + opcionales recomendados
    python tools/descargar_dependencias.py --minimo      # sólo los imprescindibles
    python tools/descargar_dependencias.py --pose-full --pose-heavy   # variantes extra de pose
    python tools/descargar_dependencias.py --verificar   # sólo comprueba lo que hay en disco

Después de esto la app funciona sin conexión: este script es la ÚNICA pieza
del proyecto que accede a Internet, y sólo cuando tú lo ejecutas.
"""
import argparse
import hashlib
import io
import os
import sys
import tarfile
import tempfile
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

NPM = "https://registry.npmjs.org"
MP_MODELS = "https://storage.googleapis.com/mediapipe-models"
TFJS_MODELS = "https://storage.googleapis.com/tfjs-models/savedmodel/ssdlite_mobilenet_v2"

TARBALLS = {
    "tasks-vision": f"{NPM}/@mediapipe/tasks-vision/-/tasks-vision-0.10.35.tgz",
    "tfjs": f"{NPM}/@tensorflow/tfjs/-/tfjs-4.22.0.tgz",
    "tfjs-webgpu": f"{NPM}/@tensorflow/tfjs-backend-webgpu/-/tfjs-backend-webgpu-4.22.0.tgz",
    "tfjs-wasm": f"{NPM}/@tensorflow/tfjs-backend-wasm/-/tfjs-backend-wasm-4.22.0.tgz",
}

# (destino, origen, ruta dentro del tarball o None, tamaño, sha256, grupo)
# grupo: "necesario" | "recomendado" (se descarga por defecto) | "pose-full" | "pose-heavy"
FILES = [
    ("lib/mediapipe/vision_bundle.mjs", "tasks-vision", "package/vision_bundle.mjs", 136993,
     "55d7ab624fbb70dcc5adc4ae6d7ea9cfcb569139d3dbfbf2b1deafcb966bc0fe", "necesario"),
    ("lib/mediapipe/wasm/vision_wasm_internal.js", "tasks-vision", "package/wasm/vision_wasm_internal.js", 322044,
     "e7fd9858e8e8f221d9b96eddc11f8e077f263e0b7bbd79d3cbe882b134274f8c", "necesario"),
    ("lib/mediapipe/wasm/vision_wasm_internal.wasm", "tasks-vision", "package/wasm/vision_wasm_internal.wasm", 11153617,
     "6a5c64584c2ab61c763b6e204afbdbc7ce1caf7f5216187322bca8df94f646bc", "necesario"),
    ("lib/mediapipe/wasm/vision_wasm_nosimd_internal.js", "tasks-vision", "package/wasm/vision_wasm_nosimd_internal.js", 321847,
     "438d1fe8ff7f4d946025bc211c291543c037d8a3785ed4eee60f1f521b236296", "recomendado"),
    ("lib/mediapipe/wasm/vision_wasm_nosimd_internal.wasm", "tasks-vision", "package/wasm/vision_wasm_nosimd_internal.wasm", 10481398,
     "8a3092d34c79d3f57e6ba8592105e8a90f6b07c27891ffecd14cca428bfd3e31", "recomendado"),
    ("lib/tfjs/tf.min.js", "tfjs", "package/dist/tf.min.js", 1469843,
     "300dfae273d20b4046f46a06d735688f03675a807561e9bcb5f664eb2f3d2831", "recomendado"),
    ("lib/tfjs/tf-backend-webgpu.min.js", "tfjs-webgpu", "package/dist/tf-backend-webgpu.min.js", 325535,
     "c02ae6ef5e7fff6dc9cec8b14b45e36e8894614f3ef006973e98f7568b590f3f", "recomendado"),
    ("lib/tfjs/tf-backend-wasm.min.js", "tfjs-wasm", "package/dist/tf-backend-wasm.min.js", 149861,
     "691bbec0ef8b5a7f17f212e9c5d85832030f90d030b46e99acb4dea1fb16f009", "recomendado"),
    ("lib/tfjs/tfjs-backend-wasm.wasm", "tfjs-wasm", "package/dist/tfjs-backend-wasm.wasm", 311123,
     "70a5d516060464e5269f01c74bac1772d6b8ab6cb612acf16b5cdaf61f78d892", "recomendado"),
    ("lib/tfjs/tfjs-backend-wasm-simd.wasm", "tfjs-wasm", "package/dist/tfjs-backend-wasm-simd.wasm", 424594,
     "77ebb28a6d34f371dbbf2086b7f2de8994acd8ea5a3cf1fa24d2c26c840cac7b", "recomendado"),
    ("lib/tfjs/tfjs-backend-wasm-threaded-simd.wasm", "tfjs-wasm", "package/dist/tfjs-backend-wasm-threaded-simd.wasm", 435643,
     "c052228d4bef185c27bbe59a9e029570c78bbb9f08b3cb46b597851650373de2", "recomendado"),

    ("models/pose/pose_landmarker_lite.task", f"{MP_MODELS}/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task", None, 5777746,
     "59929e1d1ee95287735ddd833b19cf4ac46d29bc7afddbbf6753c459690d574a", "necesario"),
    ("models/pose/pose_landmarker_full.task", f"{MP_MODELS}/pose_landmarker/pose_landmarker_full/float16/1/pose_landmarker_full.task", None, 9398198,
     "5134a3aad27a58b93da0088d431f366da362b44e3ccfbe3462b3827a839011b1", "pose-full"),
    ("models/pose/pose_landmarker_heavy.task", f"{MP_MODELS}/pose_landmarker/pose_landmarker_heavy/float16/1/pose_landmarker_heavy.task", None, 30664242,
     "64437af838a65d18e5ba7a0d39b465540069bc8aae8308de3e318aad31fcbc7b", "pose-heavy"),
    ("models/hands/hand_landmarker.task", f"{MP_MODELS}/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task", None, 7819105,
     "fbc2a30080c3c557093b5ddfc334698132eb341044ccee322ccf8bcf3607cde1", "necesario"),
    ("models/face/face_landmarker.task", f"{MP_MODELS}/face_landmarker/face_landmarker/float16/1/face_landmarker.task", None, 3758596,
     "64184e229b263107bc2b804c6625db1341ff2bb731874b0bcc2fe6544e0bc9ff", "necesario"),
    ("models/objects/efficientdet_lite0.tflite", f"{MP_MODELS}/object_detector/efficientdet_lite0/float16/1/efficientdet_lite0.tflite", None, 7254339,
     "4b59100025bea1235a84c1038879a6cccc9f6c49f5e41144e91e74d99e780993", "necesario"),
    ("models/objects/efficientdet_lite2.tflite", f"{MP_MODELS}/object_detector/efficientdet_lite2/int8/1/efficientdet_lite2.tflite", None, 7515971,
     "b3f50554cb0ea559e90328845f7d9ba4d13c8bff372914d24e06bc8bb72fa896", "recomendado"),
    ("models/classifier/efficientnet_lite0.tflite", f"{MP_MODELS}/image_classifier/efficientnet_lite0/int8/1/efficientnet_lite0.tflite", None, 5434517,
     "bc2ffe19c1118de0c0c2a9088992da5589722656e0fba81421385300a4a34b16", "necesario"),

    # Modelo alternativo COCO-SSD (TensorFlow.js).
    ("models/coco-ssd/model.json", f"{TFJS_MODELS}/model.json", None, 527315,
     "3770b2528339b1e3340cb74360e1e40401816b009779aeb8d0cce3a4353ea3a9", "recomendado"),
    ("models/coco-ssd/group1-shard1of5", f"{TFJS_MODELS}/group1-shard1of5", None, 4194304,
     "0e7af0f713e98521252321f7f84892c31cefccccec3ac64c84e5065b75ed5646", "recomendado"),
    ("models/coco-ssd/group1-shard2of5", f"{TFJS_MODELS}/group1-shard2of5", None, 4194304,
     "74cc6cfc2c4510c9cd81b8ad4cebf6f6a8f305119bb365ce0eb96276da38519a", "recomendado"),
    ("models/coco-ssd/group1-shard3of5", f"{TFJS_MODELS}/group1-shard3of5", None, 4194304,
     "50383033f893eae136392a403e8f70ade5efd90867df5695c4ca5ac640e14f38", "recomendado"),
    ("models/coco-ssd/group1-shard4of5", f"{TFJS_MODELS}/group1-shard4of5", None, 4194304,
     "d856dc534c780068bbf6c666ce1516df2c8433d87578aa31fcdf197de7058cc2", "recomendado"),
    ("models/coco-ssd/group1-shard5of5", f"{TFJS_MODELS}/group1-shard5of5", None, 1257312,
     "3d356f1fb6dfca6af78c56db34d9326706d0196e303f9de6b04f236ca79ed309", "recomendado"),
]


def sha256_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def fmt_mb(n):
    return f"{n / 1048576:.1f} MB"


def fetch(url, label):
    """Descarga a memoria con barra de progreso sencilla."""
    req = urllib.request.Request(url, headers={"User-Agent": "detectalo-todo-descargador/1.0"})
    with urllib.request.urlopen(req, timeout=120) as res:
        total = int(res.headers.get("Content-Length") or 0)
        buf = io.BytesIO()
        got = 0
        while True:
            chunk = res.read(1 << 16)
            if not chunk:
                break
            buf.write(chunk)
            got += len(chunk)
            if total:
                pct = got * 100 // total
                sys.stdout.write(f"\r    {label}: {fmt_mb(got)} / {fmt_mb(total)} ({pct} %)   ")
                sys.stdout.flush()
        sys.stdout.write("\n")
        return buf.getvalue()


def write_atomic(dest, data):
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    tmp = dest + ".part"
    with open(tmp, "wb") as f:
        f.write(data)
    os.replace(tmp, dest)


def status_of(rel, sha, verify=True):
    path = os.path.join(ROOT, rel)
    if not os.path.isfile(path):
        return "falta"
    if verify and sha256_file(path) != sha:
        return "distinto"
    return "ok"


def main():
    ap = argparse.ArgumentParser(description="Descarga las dependencias locales de Detéctalo todo.")
    ap.add_argument("--minimo", action="store_true", help="sólo los archivos imprescindibles")
    ap.add_argument("--pose-full", action="store_true", help="incluye la variante full del modelo de pose (9 MB)")
    ap.add_argument("--pose-heavy", action="store_true", help="incluye la variante heavy del modelo de pose (29 MB)")
    ap.add_argument("--forzar", action="store_true", help="vuelve a descargar aunque el archivo exista y sea correcto")
    ap.add_argument("--verificar", action="store_true", help="no descarga: sólo comprueba los archivos presentes")
    ap.add_argument("--sin-verificar", action="store_true", help="no comprueba SHA-256 (si el origen publicó otra versión)")
    args = ap.parse_args()

    groups = {"necesario"}
    if not args.minimo:
        groups.add("recomendado")
    if args.pose_full:
        groups.add("pose-full")
    if args.pose_heavy:
        groups.add("pose-heavy")
    selected = [f for f in FILES if f[5] in groups]

    if args.verificar:
        bad = 0
        for rel, _src, _member, size, sha, group in FILES:
            st = status_of(rel, sha)
            req = group == "necesario"
            mark = {"ok": "OK      ", "falta": "FALTA   ", "distinto": "DISTINTO"}[st]
            print(f"  [{mark}] {rel}  ({fmt_mb(size)}, {group})")
            if st != "ok" and req:
                bad += 1
        print("\nTodo lo imprescindible está en su sitio." if not bad else f"\n{bad} archivo(s) imprescindible(s) ausentes o distintos.")
        return 1 if bad else 0

    todo = [f for f in selected if args.forzar or status_of(f[0], f[4], not args.sin_verificar) != "ok"]
    print(f"Destino: {ROOT}")
    print(f"{len(selected)} archivo(s) seleccionados, {len(todo)} por descargar.\n")
    if not todo:
        print("Nada que hacer: todo está descargado y verificado.")
        return 0

    tar_cache = {}
    errors = 0
    for rel, src, member, size, sha, group in todo:
        dest = os.path.join(ROOT, rel)
        print(f"  → {rel}  ({fmt_mb(size)}, {group})")
        try:
            if member:
                if src not in tar_cache:
                    tar_cache[src] = fetch(TARBALLS[src], f"npm {src}")
                with tarfile.open(fileobj=io.BytesIO(tar_cache[src]), mode="r:gz") as tf:
                    # Sólo se lee el miembro exacto pedido; nunca se extrae el tarball entero.
                    info = tf.getmember(member)
                    if not info.isfile():
                        raise RuntimeError(f"{member} no es un archivo en el paquete")
                    data = tf.extractfile(info).read()
            else:
                data = fetch(src, os.path.basename(rel))
            digest = hashlib.sha256(data).hexdigest()
            if not args.sin_verificar and digest != sha:
                raise RuntimeError(f"SHA-256 inesperado ({digest}); no se guarda. Usa --sin-verificar si el origen publicó otra versión.")
            write_atomic(dest, data)
        except Exception as e:  # noqa: BLE001
            errors += 1
            print(f"    ERROR: {e}")
    print()
    if errors:
        print(f"{errors} archivo(s) no se pudieron descargar. Revisa la conexión/proxy y vuelve a ejecutar.")
        return 1
    print("Listo. Ahora puedes desconectarte de la red y arrancar la app:")
    print("    python -m http.server 8000      (o: python serve.py)")
    print("    y abre en el navegador:  localhost:8000")
    return 0


if __name__ == "__main__":
    sys.exit(main())
