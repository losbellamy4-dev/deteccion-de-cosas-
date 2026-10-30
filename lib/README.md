# lib/ — librerías JavaScript locales

Esta carpeta debe contener (rutas exactas, ver `README.md` §3.1 para orígenes y SHA-256):

```
lib/mediapipe/vision_bundle.mjs                     obligatorio
lib/mediapipe/wasm/vision_wasm_internal.js          obligatorio
lib/mediapipe/wasm/vision_wasm_internal.wasm        obligatorio
lib/mediapipe/wasm/vision_wasm_nosimd_internal.js   navegadores sin WASM SIMD
lib/mediapipe/wasm/vision_wasm_nosimd_internal.wasm navegadores sin WASM SIMD
lib/tfjs/tf.min.js                                  obligatorio
lib/tfjs/tf-backend-webgpu.min.js                   recomendado (WebGPU)
lib/tfjs/tf-backend-wasm.min.js                     recomendado (sin GPU)
lib/tfjs/tfjs-backend-wasm.wasm                     recomendado
lib/tfjs/tfjs-backend-wasm-simd.wasm                recomendado
lib/tfjs/tfjs-backend-wasm-threaded-simd.wasm       opcional
```

Descárgalas de una vez con:

```bash
python tools/descargar_dependencias.py
```
