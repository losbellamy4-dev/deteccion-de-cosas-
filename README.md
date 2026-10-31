# Detéctalo todo

Sistema web de **visión por computador y analítica de vídeo que funciona 100 % en local**: pose corporal multipersona, manos con gestos, malla facial 3D, objetos COCO con **filtro anti-fantasmas**, **reconocimiento de 1000 tipos de cosas** (animales y razas, comida, herramientas, instrumentos, vehículos, ropa, aparatos…) y movimiento, con *tracking*, alertas (caída, inmovilidad, intrusión, somnolencia…), zonas, líneas de cruce y exportación del registro. Una vez abierto **no hace ni una sola petición de red**: puedes desconectar el equipo.

**Versión web:** {{VERCEL_URL}} (la misma app, servida por Vercel; los fotogramas se procesan en tu navegador y nunca se envían a ningún servidor).

> **Aviso importante.** Las heurísticas (caída, inmovilidad, somnolencia, actividad, gestos, sonrisa, mirada) son **aproximadas**. No son aptas para uso médico, de teleasistencia, de conducción ni de seguridad crítica: tendrán falsos positivos y falsos negativos.

---

## Índice

1. [Inicio rápido](#1-inicio-rápido)
2. [Sección 0 — cómo se cumple "local y offline"](#2-sección-0--cómo-se-cumple-local-y-offline)
3. [Archivos a descargar (lista exacta)](#3-archivos-a-descargar-lista-exacta)
4. [Ejecución y requisitos](#4-ejecución-y-requisitos)
5. [Arquitectura](#5-arquitectura)
6. [Rendimiento](#6-rendimiento)
7. [Módulos de detección (A–F) y filtro anti-fantasmas](#7-módulos-de-detección-af-y-filtro-anti-fantasmas)
8. [Inteligencia derivada](#8-inteligencia-derivada)
9. [Interfaz, atajos y exportación](#9-interfaz-atajos-y-exportación)
10. [Errores y robustez](#10-errores-y-robustez)
11. [Criterios de aceptación: cómo verificarlos](#11-criterios-de-aceptación-cómo-verificarlos)
12. [Pruebas](#12-pruebas)
13. [Solución de problemas](#13-solución-de-problemas)
14. [Licencias de terceros](#14-licencias-de-terceros)

---

## 1. Inicio rápido

El repositorio **ya incluye** `lib/` y `models/` (salvo la variante opcional *heavy* de pose), así que basta con:

```bash
# 1) (Sólo si faltan lib/ o models/) descargarlos UNA VEZ desde sus orígenes oficiales
python tools/descargar_dependencias.py

# 2) Servir la carpeta en local
python -m http.server 8000          # o bien: python serve.py  (recomendado en Windows)

# 3) Abrir en el navegador
#    localhost:8000
```

A partir del paso 3 puedes desconectar la red. Si prefieres no usar el script, descarga a mano los archivos de la [sección 3](#3-archivos-a-descargar-lista-exacta) y colócalos en las rutas indicadas.

### Versión portable: un solo HTML con doble clic

Si no quieres usar servidor ni terminal, genera un único archivo con todo dentro (≈ 36 MB):

```bash
python tools/construir_portable.py
```

El resultado, `dist/detectalo-todo-portable.html`, se abre con **doble clic** en Chrome o Edge y funciona sin servidor y sin conexión (tarda unos segundos en arrancar). Lleva incrustados las librerías y los modelos imprescindibles; su CSP sólo permite datos `data:`/`blob:`, así que tampoco puede conectarse a ninguna red. Diferencia: en este modo los modelos se ejecutan en el hilo principal (sin Web Workers); un limitador de ciclo de trabajo deja el hilo libre para pintar tras cada inferencia, así que el vídeo se ve fluido aunque el análisis vaya más despacio. Para que pese menos no incluye las piezas opcionales (EfficientDet-Lite2, COCO-SSD/TF.js, pose full/heavy).

---

## 2. Sección 0 — cómo se cumple "local y offline"

| Requisito | Cómo se resuelve |
|---|---|
| Proyecto en carpeta | `index.html` + `src/` (código propio) + `lib/` (librerías) + `models/` (pesos) + `README.md`. |
| Rutas relativas, sin dominios externos | Todo se carga con rutas relativas al propio servidor. `tools/verificar_offline.py` comprueba que en `index.html` y `src/` no hay **ninguna** URL externa, `cdn.`, `//…` ni `ws://`. |
| Sin peticiones de red en ejecución | Una **Content-Security-Policy** en `index.html` sólo permite cargar código y datos del propio origen (`default-src 'self'`, `connect-src 'self'`…). Aunque una librería intentara contactar con Internet, **el navegador lo bloquearía** y la app lo anotaría en el registro («Bloqueado por la CSP»). |
| Servidor estático local | `python -m http.server 8000` (o `serve.py`, que además fija los tipos MIME y aplica la CSP también a los Web Workers). |
| Comprobación al arranque | Antes de inicializar nada se verifica **cada** archivo de `lib/` y `models/` (existe, no es una página HTML de error, no está truncado, tamaño de la versión verificada; los binarios se validan por su firma al cargarlos). Si falta algo se muestra **qué archivo, dónde debe ir y su origen oficial**, y el resto de módulos sigue funcionando. **Nunca** se intenta un CDN como alternativa. |
| Todo cargado de antemano | Todos los modelos se cargan al arrancar; activar o desactivar módulos después no necesita ninguna descarga. |

**Decisiones de versión verificadas:**

- **MediaPipe Tasks Vision se fija en la 0.10.35.** Las versiones 1.x del paquete incluyen un módulo de telemetría que envía datos de uso a un servidor externo de Google. La 0.10.35 no contiene ningún código de red aparte de leer los archivos que le pasamos (verificado inspeccionando el bundle). Además, la app no usa `FilesetResolver` con URL remota: construye a mano las rutas locales del WASM.
- **TensorFlow.js 4.22.0.** Su `tf.min.js` incluye un *regenerator-runtime* antiguo que, bajo una CSP estricta sin `unsafe-eval`, intentaría `Function(...)` y abortaría la carga. La app predeclara `globalThis.regeneratorRuntime` antes de cargarlo: así funciona con la CSP estricta sin relajarla.
- **Objetos con EfficientDet-Lite0** (MediaPipe Object Detector, float16) por defecto: más preciso que COCO-SSD (mAP COCO ≈ 26 frente a ≈ 22) y con la NMS dentro del modelo. **EfficientDet-Lite2** (int8, mAP ≈ 34) es la opción «más preciso, más lento». MediaPipe devuelve `index = -1` con estos modelos, así que la clase se identifica por el nombre de su mapa de etiquetas (verificado).
- **Reconocimiento de 1000 cosas con EfficientNet-Lite0** (MediaPipe Image Classifier, int8, ImageNet-1k). Se comparó con EfficientNet-Lite2 sobre las imágenes de prueba oficiales y Lite0 acertó más y es más rápido. Las 1000 etiquetas están traducidas al español en el mismo orden que el modelo (`src/analytics/imagenetLabels.js`, comprobado con un test).
- **COCO-SSD** (modelo alternativo, opcional) usa los pesos oficiales de `@tensorflow-models/coco-ssd` (SSDLite MobileNet v2), pero la inferencia y el post-proceso son propios: lectura de resultados 100 % asíncrona (el paquete original usa `dataSync()` y congela la interfaz) y NMS en JavaScript sin cambiar el backend global.

---

## 3. Archivos a descargar (lista exacta)

Rutas relativas a la carpeta del proyecto. `tools/descargar_dependencias.py` los descarga de estos orígenes y verifica el **SHA-256**; con `--verificar` comprueba lo que ya tienes.

### 3.1 Librerías → `/lib`

Origen oficial: **registro de npm** (paquetes versionados e inmutables). El archivo está dentro del tarball en la ruta indicada. Alternativa para descarga manual de un archivo suelto: el espejo de npm `https://cdn.jsdelivr.net/npm/<paquete>@<versión>/<ruta>` (sólo para descargarlo una vez; la app nunca lo usa).

| Destino | Paquete npm → ruta interna | Tamaño | Obligatorio | SHA-256 |
|---|---|---|---|---|
| `lib/mediapipe/vision_bundle.mjs` | [`@mediapipe/tasks-vision@0.10.35`](https://registry.npmjs.org/@mediapipe/tasks-vision/-/tasks-vision-0.10.35.tgz) → `vision_bundle.mjs` | 134 KB | **Sí** | `55d7ab624fbb70dcc5adc4ae6d7ea9cfcb569139d3dbfbf2b1deafcb966bc0fe` |
| `lib/mediapipe/wasm/vision_wasm_internal.js` | ídem → `wasm/vision_wasm_internal.js` | 315 KB | **Sí** | `e7fd9858e8e8f221d9b96eddc11f8e077f263e0b7bbd79d3cbe882b134274f8c` |
| `lib/mediapipe/wasm/vision_wasm_internal.wasm` | ídem → `wasm/vision_wasm_internal.wasm` | 10,6 MB | **Sí** | `6a5c64584c2ab61c763b6e204afbdbc7ce1caf7f5216187322bca8df94f646bc` |
| `lib/mediapipe/wasm/vision_wasm_nosimd_internal.js` | ídem → `wasm/vision_wasm_nosimd_internal.js` | 314 KB | Sólo navegadores sin WASM SIMD | `438d1fe8ff7f4d946025bc211c291543c037d8a3785ed4eee60f1f521b236296` |
| `lib/mediapipe/wasm/vision_wasm_nosimd_internal.wasm` | ídem → `wasm/vision_wasm_nosimd_internal.wasm` | 10,0 MB | Sólo navegadores sin WASM SIMD | `8a3092d34c79d3f57e6ba8592105e8a90f6b07c27891ffecd14cca428bfd3e31` |
| `lib/tfjs/tf.min.js` | [`@tensorflow/tfjs@4.22.0`](https://registry.npmjs.org/@tensorflow/tfjs/-/tfjs-4.22.0.tgz) → `dist/tf.min.js` | 1,4 MB | Sólo para COCO-SSD | `300dfae273d20b4046f46a06d735688f03675a807561e9bcb5f664eb2f3d2831` |
| `lib/tfjs/tf-backend-webgpu.min.js` | [`@tensorflow/tfjs-backend-webgpu@4.22.0`](https://registry.npmjs.org/@tensorflow/tfjs-backend-webgpu/-/tfjs-backend-webgpu-4.22.0.tgz) → `dist/tf-backend-webgpu.min.js` | 318 KB | Recomendado (WebGPU) | `c02ae6ef5e7fff6dc9cec8b14b45e36e8894614f3ef006973e98f7568b590f3f` |
| `lib/tfjs/tf-backend-wasm.min.js` | [`@tensorflow/tfjs-backend-wasm@4.22.0`](https://registry.npmjs.org/@tensorflow/tfjs-backend-wasm/-/tfjs-backend-wasm-4.22.0.tgz) → `dist/tf-backend-wasm.min.js` | 146 KB | Recomendado (equipos sin GPU) | `691bbec0ef8b5a7f17f212e9c5d85832030f90d030b46e99acb4dea1fb16f009` |
| `lib/tfjs/tfjs-backend-wasm.wasm` | ídem → `dist/tfjs-backend-wasm.wasm` | 304 KB | Recomendado | `70a5d516060464e5269f01c74bac1772d6b8ab6cb612acf16b5cdaf61f78d892` |
| `lib/tfjs/tfjs-backend-wasm-simd.wasm` | ídem → `dist/tfjs-backend-wasm-simd.wasm` | 415 KB | Recomendado | `77ebb28a6d34f371dbbf2086b7f2de8994acd8ea5a3cf1fa24d2c26c840cac7b` |
| `lib/tfjs/tfjs-backend-wasm-threaded-simd.wasm` | ídem → `dist/tfjs-backend-wasm-threaded-simd.wasm` | 425 KB | Opcional (con `serve.py --coi`) | `c052228d4bef185c27bbe59a9e029570c78bbb9f08b3cb46b597851650373de2` |

### 3.2 Modelos → `/models`

| Destino | Origen oficial (URL directa) | Tamaño | Obligatorio | SHA-256 |
|---|---|---|---|---|
| `models/pose/pose_landmarker_lite.task` | `https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task` | 5,5 MB | **Sí** | `59929e1d1ee95287735ddd833b19cf4ac46d29bc7afddbbf6753c459690d574a` |
| `models/pose/pose_landmarker_full.task` | `https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/1/pose_landmarker_full.task` | 9,0 MB | Opcional (variante "Full") | `5134a3aad27a58b93da0088d431f366da362b44e3ccfbe3462b3827a839011b1` |
| `models/pose/pose_landmarker_heavy.task` | `https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_heavy/float16/1/pose_landmarker_heavy.task` | 29,2 MB | Opcional (variante "Heavy") | `64437af838a65d18e5ba7a0d39b465540069bc8aae8308de3e318aad31fcbc7b` |
| `models/hands/hand_landmarker.task` | `https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task` | 7,5 MB | **Sí** | `fbc2a30080c3c557093b5ddfc334698132eb341044ccee322ccf8bcf3607cde1` |
| `models/face/face_landmarker.task` | `https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task` | 3,6 MB | **Sí** | `64184e229b263107bc2b804c6625db1341ff2bb731874b0bcc2fe6544e0bc9ff` |
| `models/objects/efficientdet_lite0.tflite` | `https://storage.googleapis.com/mediapipe-models/object_detector/efficientdet_lite0/float16/1/efficientdet_lite0.tflite` | 6,9 MB | **Sí** (objetos) | `4b59100025bea1235a84c1038879a6cccc9f6c49f5e41144e91e74d99e780993` |
| `models/objects/efficientdet_lite2.tflite` | `https://storage.googleapis.com/mediapipe-models/object_detector/efficientdet_lite2/int8/1/efficientdet_lite2.tflite` | 7,2 MB | Opcional («más preciso») | `b3f50554cb0ea559e90328845f7d9ba4d13c8bff372914d24e06bc8bb72fa896` |
| `models/classifier/efficientnet_lite0.tflite` | `https://storage.googleapis.com/mediapipe-models/image_classifier/efficientnet_lite0/int8/1/efficientnet_lite0.tflite` | 5,2 MB | **Sí** (1000 cosas) | `bc2ffe19c1118de0c0c2a9088992da5589722656e0fba81421385300a4a34b16` |
| `models/coco-ssd/model.json` | `https://storage.googleapis.com/tfjs-models/savedmodel/ssdlite_mobilenet_v2/model.json` | 515 KB | Opcional (COCO-SSD) | `3770b2528339b1e3340cb74360e1e40401816b009779aeb8d0cce3a4353ea3a9` |
| `models/coco-ssd/group1-shard1of5` | `https://storage.googleapis.com/tfjs-models/savedmodel/ssdlite_mobilenet_v2/group1-shard1of5` | 4,0 MB | Opcional | `0e7af0f713e98521252321f7f84892c31cefccccec3ac64c84e5065b75ed5646` |
| `models/coco-ssd/group1-shard2of5` | `…/ssdlite_mobilenet_v2/group1-shard2of5` | 4,0 MB | Opcional | `74cc6cfc2c4510c9cd81b8ad4cebf6f6a8f305119bb365ce0eb96276da38519a` |
| `models/coco-ssd/group1-shard3of5` | `…/ssdlite_mobilenet_v2/group1-shard3of5` | 4,0 MB | Opcional | `50383033f893eae136392a403e8f70ade5efd90867df5695c4ca5ac640e14f38` |
| `models/coco-ssd/group1-shard4of5` | `…/ssdlite_mobilenet_v2/group1-shard4of5` | 4,0 MB | Opcional | `d856dc534c780068bbf6c666ce1516df2c8433d87578aa31fcdf197de7058cc2` |
| `models/coco-ssd/group1-shard5of5` | `…/ssdlite_mobilenet_v2/group1-shard5of5` | 1,2 MB | Opcional | `3d356f1fb6dfca6af78c56db34d9326706d0196e303f9de6b04f236ca79ed309` |

Se usan rutas **versionadas** (`/1/`) de MediaPipe en lugar de `/latest/` para que el contenido no cambie bajo tus pies (de hecho, `pose_landmarker_full` difiere entre `/1/` y `/latest/`).

Opciones del script: `--minimo` (sólo lo imprescindible, ≈ 52 MB), `--pose-full`, `--pose-heavy`, `--forzar`, `--verificar`, `--sin-verificar`.

---

## 4. Ejecución y requisitos

- **Servidor:** `python -m http.server 8000` en la carpeta del proyecto y abrir `localhost:8000`. Hace falta servidor (no `file://`) porque los navegadores bloquean en `file://` los módulos ES, los workers y la carga de modelos; la app lo detecta y explica qué hacer.
- **`serve.py` (recomendado):** escucha sólo en `127.0.0.1`, fuerza tipos MIME correctos (en algunos Windows `python -m http.server` sirve `.js` como `text/plain` y la app no arranca), envía la CSP como cabecera (así también protege a los Web Workers) y, con `--coi`, activa el aislamiento entre orígenes para el backend WASM multihilo de TF.js.
- **Contexto seguro:** la cámara y la captura de pantalla sólo funcionan en `localhost` (o HTTPS). Si abres la app con la IP de la red local, se mostrará el motivo.
- **Navegador:** Chrome/Edge 113+ (recomendado), Firefox 115+, Safari 17+. Se necesitan módulos ES, WebAssembly (SIMD recomendado), WebGL2 y, para los workers, `OffscreenCanvas`.
- **Python 3** sólo para servir los archivos y, opcionalmente, para el script de descarga (sólo biblioteca estándar).

---

## 5. Arquitectura

```
index.html                 interfaz + CSS (tema oscuro) + CSP
src/
  main.js                  arranque: capacidades → comprobación de archivos → carga de modelos
  boot-check.js            script clásico: avisa si file://, navegador antiguo o el módulo no arranca
  config.js                manifiesto de archivos, esquema de ajustes, etiquetas COCO en español
  core/
    Engine.js              bucle rAF, planificación, conexión resultados → analítica → alertas
    Scheduler.js           cadencia "1 de cada N", presupuesto por frame, control adaptativo
    VideoSource.js         webcam / archivo / pantalla, reloj de frames (requestVideoFrameCallback)
    Renderer.js            canvas superpuesto HiDPI, todas las capas, exportación PNG
    BackendManager.js      WebGPU → WebGL → WASM → CPU; detección de GPU por software
    AssetChecker.js        comprobación de archivos, carga con progreso, validación de firmas
    Settings.js, Emitter.js, Stats.js
  detectors/
    Detector.js            clase base (estado, latencia total y coste en hilo principal)
    PoseDetector.js · HandDetector.js · FaceDetector.js      (MediaPipe Tasks)
    ObjectDetector.js      COCO-SSD con TF.js (post-proceso propio)
    MotionDetector.js      diferencia de frames, heatmap (sin modelo)
    MediaPipeRuntime.js    carga local del runtime y delegado GPU→CPU con prueba de arranque
    WorkerDetector.js      representante en el hilo principal de un modelo en Web Worker
  workers/inference.worker.js   aloja UN modelo por worker (MediaPipe, TF.js o movimiento)
  analytics/
    Tracker.js + hungarian.js     IDs persistentes (IoU + centroide + asignación óptima)
    PoseAnalytics.js       ángulos, postura, marcha, brazos en alto, caída, inmovilidad
    HandAnalytics.js       dedos y gestos
    FaceAnalytics.js       EAR/parpadeo/somnolencia, boca, sonrisa, orientación, mirada
    ZoneManager.js         zonas de intrusión y tripwires
    AlertManager.js        enfriamiento, alertas visibles, sonido sintetizado (WebAudio)
    EventLog.js            registro cronológico y exportación JSON/CSV
    geometry.js
  ui/
    UIController.js        paneles, controles generados desde el esquema, log, exportación
    LoadingScreen.js       progreso por modelo y tarjetas de archivos ausentes
    ZoneEditor.js          dibujo/edición de zonas y líneas sobre el canvas
    FaceMesh3DView.js      visor 3D de la malla facial (canvas 2D, sin librerías)
tools/
  descargar_dependencias.py   descarga única con verificación SHA-256
  verificar_offline.py        sin dominios externos en el código + archivos presentes
  construir_portable.py       genera el HTML portable (todo incrustado, doble clic)
serve.py                   servidor local opcional (MIME, CSP en cabecera, sólo localhost)
tests/                     pruebas unitarias (node --test) con landmarks reales de MediaPipe
```

**Flujo por fotograma:**

```
<video> ──(compositor del navegador: siempre fluido)──────────────────────────► pantalla
   │ requestVideoFrameCallback: ¿hay fotograma nuevo?
   ▼
Engine (rAF) ─ Scheduler: ¿qué modelos tocan? (cadencia, urgencia, presupuesto, workers libres)
   │  lienzo de inferencia reducido (resolución adaptativa) ─ ImageBitmap transferido ─► Workers
   │                                                         (pose · manos · rostro · objetos · movimiento)
   ◄──────────────────────────────── resultados (landmarks, cajas, energía) ─────────────┘
   │  Tracker (IDs) → analítica (postura, caída, gestos, EAR, zonas, líneas, distancias)
   │  → EventLog / AlertManager
   ▼
Renderer: canvas superpuesto (sólo se repinta si algo cambió) ──────────────────► pantalla
```

**Backends:** TF.js prueba **WebGPU → WebGL → WASM → CPU** (`tf.setBackend` + ejecución de prueba de COCO-SSD; si falla, pasa al siguiente y se anota el motivo). MediaPipe usa delegado **GPU (WebGL2) → CPU (WASM + XNNPACK)** con una inferencia de calentamiento (MediaPipe Tasks para web no ofrece delegado WebGPU en visión). Si la GPU detectada es un rasterizador por software (SwiftShader, llvmpipe…), en modo automático se prefieren los backends de CPU, porque emular WebGL en la CPU es mucho más lento (medido: ~1 s frente a ~80 ms por inferencia de pose). La cabecera muestra el backend activo de cada motor y los cambios se avisan con un mensaje. Se puede forzar en *Rendimiento*.

---

## 6. Rendimiento

**Diseño:**

- **Web Workers (por defecto):** cada modelo corre en su propio worker. El hilo principal sólo dibuja el fotograma en un lienzo reducido, crea un `ImageBitmap` (copia inmediata) y lo **transfiere** sin copiar; su coste es ≈ 1 ms por modelo, tarde lo que tarde la inferencia. Si los workers no están disponibles, se usa el hilo principal automáticamente (desactivable en *Rendimiento*).
- **Bucle `requestAnimationFrame`** con **cadencia por módulo** configurable ("1 de cada N fotogramas"; por defecto pose 1, manos 2, rostro 2, objetos 3, movimiento 2), urgencia anti-inanición y **presupuesto en ms por frame** para lo que corre en el hilo principal.
- **Control adaptativo:** si los FPS de render bajan del umbral (30 por defecto), sube un nivel de degradación (6 niveles): menor **resolución de inferencia**, cadencias ×2…×4, menos workers simultáneos y huecos tras cada inferencia (ciclo de trabajo < 100 % para liberar CPU). Recupera con histéresis (1 s para degradar, 3 s para recuperar). Nivel y resolución visibles en la cabecera.
- **Métricas separadas y medidas:** FPS de render, FPS de análisis, latencia media por modelo (ms), Hz por modelo, ms/frame del hilo principal y tensores vivos de TF.js.
- **Memoria:** entrada de TF.js creada en `tf.tidy`, salidas liberadas con `tf.dispose` en `finally`; el número de tensores se muestra en la interfaz (debe permanecer constante: verificado 262 → 262 tras miles de inferencias). Los resultados de MediaPipe se copian y se cierran (`close()`).
- El overlay sólo se repinta cuando cambia algo (resultados nuevos, ajustes, zonas, alertas, HUD).

**Medido durante el desarrollo** (Chromium headless **sin GPU física**: WebGL emulado por SwiftShader, 4 núcleos; un escenario más duro que un equipo normal con GPU). Vídeo de prueba 1280×720 a 30 fps; media de 6 s tras 2 s de calentamiento; "tareas largas" = bloqueos del hilo principal de más de 50 ms:

| Módulos activos | Render (media · mín–máx) | Hilo principal | Tareas largas |
|---|---|---|---|
| Ninguno | 60 FPS · 59–60 | 0,1 ms/frame | 0 |
| Pose (worker) | 37,5 FPS · 26–45 | 0,6 ms/frame | 0 |
| Pose + manos (workers) | 31,4 FPS · 15–45 | 0,9 ms/frame | 0 |
| **Pose + manos + objetos (workers)** | **30,5 FPS · 15–39** | 0,8 ms/frame | 0 |
| Los 5 módulos (workers) | 24,4 FPS · 13–35 | 1,2 ms/frame | 0 |
| Pose en **hilo principal** (workers desactivados) | 30,4 FPS · 11–43 | 28,6 ms/frame | 18 (hasta 320 ms) |

Con workers, el hilo principal apenas trabaja (≈ 1 ms/frame) y no hay bloqueos; lo que limita en esa máquina es la CPU compartida entre los modelos y el **renderizado por software** del propio navegador. En el modo sin workers la media parece similar, pero a base de tirones de hasta 320 ms: por eso los workers son el modo por defecto. En un equipo con GPU, el delegado GPU de MediaPipe y WebGL/WebGPU en TF.js sacan la inferencia de la CPU. **No he podido medir sobre una GPU real**: compruébalo en tu equipo con las métricas de la cabecera (ver [sección 11](#11-criterios-de-aceptación-cómo-verificarlos)).

Latencias por inferencia medidas en esa misma máquina (sin GPU): pose ≈ 75 ms, manos ≈ 90 ms (WASM); COCO-SSD ≈ 140 ms en WASM, ≈ 700 ms en WebGL emulado, ≈ 6 s en WebGPU emulado y ≈ 3,2 s en CPU JS, con **detecciones idénticas** en los cuatro backends.

---

## 7. Módulos de detección (A–F) y filtro anti-fantasmas

Todos se activan y desactivan en caliente y se combinan libremente.

- **A · Pose corporal** — MediaPipe Pose Landmarker (lite por defecto; full/heavy opcionales), hasta 6 personas, 33 puntos con visibilidad. Esqueleto coloreado por certeza (rojo → amarillo → verde), ángulos articulares en tiempo real (codos, hombros, caderas, rodillas) calculados con las coordenadas 3D del modelo.
- **B · Manos** — MediaPipe Hand Landmarker, 21 puntos por mano, izquierda/derecha diferenciadas (la lateralidad se verificó con las imágenes oficiales `right_hands.jpg`/`left_hands.jpg`: correcta con imagen sin espejar; hay un ajuste para cámaras que ya entregan imagen espejada). Gestos: puño, mano abierta, pinza, señalar, victoria, pulgar arriba/abajo, cuernos, OK y conteo de dedos. Cada mano se asocia a la persona cuya muñeca está más cerca.
- **C · Malla facial** — MediaPipe Face Landmarker: 478 puntos (con iris), dibujo de contornos, malla completa o puntos coloreados por profundidad, **visor 3D** girable, orientación de cabeza (giro, inclinación, ladeo) desde la matriz de transformación facial (convención verificada empíricamente) y mirada aproximada (iris + giro).
- **D · Objetos** — EfficientDet-Lite0 (por defecto), EfficientDet-Lite2 (más preciso) o COCO-SSD con TF.js (alternativo): 80 clases con caja, etiqueta en español, confianza e ID. Si el módulo F está activo, cada objeto lleva además su **etiqueta fina** («perro #3 · corgi Pembroke 48 %»).
- **E · Movimiento y anomalías** — diferencia de fotogramas (sin modelo), heatmap opcional, energía de movimiento con gráfica y alerta de **anomalía** (pico muy por encima de lo habitual en la escena). Contadores en vivo: personas (actuales/únicas), objetos (actuales/únicos), manos (izq./der.), rostros, ocupación de zonas y cruces.
- **F · Reconocer 1000 cosas** — clasificador EfficientNet-Lite0 (ImageNet, 1000 clases en español). Un clasificador no localiza, así que en cada ejecución clasifica varias regiones del mismo fotograma (a resolución nativa, hasta 1280 px):
  - **Visor central:** un recuadro violeta en el centro del vídeo; apunta la cámara a una cosa y aparece su nombre y confianza (p. ej. «◎ hamburguesa con queso 92 %»), con el top-3 en el panel *Escáner*. Cuando se decide por algo nuevo se anota en el registro.
  - **Escena completa:** top-5 de lo que hay en toda la imagen.
  - **Afinar objetos:** clasifica por turnos el recorte de cada objeto seguido por D y le añade la clase concreta (raza de perro, tipo de vehículo, comida exacta…). Con el filtro anti-fantasmas, si el clasificador contradice con claridad al detector dentro de grupos conocidos (perro ↔ gato, coche ↔ camión ↔ autobús…, sumando las clases finas de cada grupo) **corrige la etiqueta** y lo registra.
  - Las puntuaciones se suavizan en el tiempo para que el nombre no salte entre dos clases parecidas.

**Filtro anti-fantasmas** (sección *Precisión* del panel izquierdo, activado por defecto):

- Los objetos sólo reciben ID y aparecen en contadores, zonas y alertas tras **3 detecciones** (2 si su confianza media es ≥ 70 %); un objeto sin confirmar sólo se dibuja si es muy claro (≥ 75 %).
- A las clases que los detectores COCO más se inventan (mesa, silla, cama, sofá, televisor, inodoro, nevera, horno, fregadero, banco, cometa, paraguas, frisbi, pelota, bolso, corbata) se les exige +10 % de confianza.
- Se descartan cajas diminutas (tamaño mínimo configurable, 0,25 % de la imagen), astillas, cajas de pantalla completa con confianza dudosa y duplicados de distinta clase sobre el mismo objeto.
- **Doble umbral** (como ByteTrack): las detecciones algo por debajo del umbral nunca crean objetos, pero sí mantienen vivos los ya confirmados, así que un objeto real no parpadea cuando su confianza baja un momento.
- Pose: se descartan esqueletos con menos de 6 puntos fiables o sin tronco reconocible (hombro + nariz o cadera). MediaPipe usa confianza mínima 0,6 (en vez de 0,5) en pose, manos y rostro.
- El panel muestra cuántas detecciones dudosas se han descartado en la sesión.

---

## 8. Inteligencia derivada

Todo se calcula por geometría sobre los puntos y cajas que ya dan A–D: **no carga pesos nuevos**.

| Función | Cómo funciona |
|---|---|
| **Tracking con ID persistente** | Predicción por velocidad (EMA), coste 1 − IoU (o 1 + distancia entre centros en diagonales de caja si no hay solape), clase obligatoria para objetos, **asignación óptima con el algoritmo húngaro**. Las pistas nacen tentativas y reciben ID visible tras 2 emparejamientos; sobreviven 1,5 s a oclusiones. Los tiempos se estiran solos si el análisis va muy lento. Personas y objetos comparten numeración (#1, #2…). |
| **Actividad** | De pie / sentada / tumbada por inclinación del torso, ángulos 3D de cadera y rodilla, inclinación y escorzo del muslo y caída cadera→tobillo; caminando por velocidad horizontal sostenida de caderas (en torsos/s); brazos en alto si ambas muñecas quedan sobre los hombros. Cada estado debe sostenerse un tiempo antes de notificarse. |
| **Caída** | Estaba erguida y pasa a "abajo" (torso > 45–65°, tumbada o caderas muy bajas) con una **transición rápida** (giro medio del torso o bajada media de caderas/hombros entre la última muestra erguida y la actual) o picos de velocidad; luego **periodo de confirmación** (2 s por defecto) en el que debe seguir abajo. Si se recupera antes, se descarta. Tumbarse despacio no la dispara. Probado a 30, 10 y 3 Hz de análisis. |
| **Inmovilidad prolongada** | Desplazamiento de articulaciones clave suavizadas (elimina el temblor del modelo) en ventanas de 1 s, normalizado por la longitud del torso; alerta tras X s (10 por defecto) y aviso al volver a moverse. Sin pose, usa la caja de COCO-SSD. |
| **Dedos y gestos numéricos** | Estado de cada dedo con fusión 2D/3D (umbrales calibrados con las imágenes de prueba oficiales de MediaPipe). |
| **Métricas faciales** | EAR (con corrección de aspecto) y referencia de ojo abierto autocalibrada por persona → parpadeos/min, PERCLOS, **somnolencia** (ojos cerrados > 1,5 s); MAR → boca abierta y bostezo; sonrisa por ensanchamiento de la boca y elevación de comisuras. |
| **Zonas de intrusión** | Polígonos dibujados sobre el canvas; se usa el punto de apoyo (pies) de las personas y el centro de los objetos, con permanencia mínima para evitar parpadeos en el borde. Alerta al entrar un ID, registro de la salida y del tiempo dentro. |
| **Tripwire** | Lado de la línea con banda de histéresis: sin cruces falsos por temblor ni al aparecer una pista encima de la línea, sin perder cruces lentos, sin contar a quien rodea un extremo. Flecha de "entrada" invertible; contadores de entradas/salidas. |
| **Trayectorias** | Estela del punto de referencia de cada ID (últimos 6 s). |
| **Distancia entre personas** | Píxeles de la imagen de origen entre puntos de apoyo y su equivalente en "alturas corporales"; aviso opcional de proximidad. |

Todas las coordenadas se guardan **normalizadas respecto a la imagen de origen**: zonas y líneas siguen pegadas a la escena aunque cambie el tamaño de la ventana o el modo espejo.

---

## 9. Interfaz, atajos y exportación

- **Cabecera:** estado del motor, FPS de render, FPS de análisis, backend activo, nivel de carga y resolución de inferencia.
- **Panel izquierdo:** interruptores A–F (con estado, backend, latencia y opciones de cada modelo), funciones derivadas, herramientas de zonas/líneas, sensibilidad de alertas, rendimiento (cadencias, presupuesto, umbral FPS, resolución máxima, backend, workers) y vista.
- **Centro:** fuente (webcam con selector de cámara, archivo —también arrastrando— o pantalla), vídeo con overlay y transporte (play/pausa, avance de un fotograma también en directo, barra de posición, velocidad, bucle).
- **Panel derecho:** escáner de 1000 cosas (visor central, escena, objetos afinados), contadores en vivo, tabla de modelos (backend, 1/N efectivo, Hz, ms), alertas, **registro de eventos en directo** con filtros, entidades (postura, ángulos, EAR, parpadeos, orientación…), visor 3D de la malla y gráfica de movimiento.
- **Atajos:** `Espacio` play/pausa · `→` avanzar fotograma · `Z` dibujar zona · `L` dibujar línea · `Intro` cerrar zona · `Retroceso` deshacer vértice · `Supr` borrar selección · `Esc` cancelar · `W` webcam · `O` abrir archivo · `P` captura PNG.
- **Exportación local** (nada se sube a ningún sitio): registro en **JSON** o **CSV** (UTF-8 con BOM; celdas protegidas contra inyección de fórmulas) y **captura PNG** del fotograma con el overlay a resolución nativa.
- Ajustes y zonas se recuerdan en el almacenamiento local del navegador.

---

## 10. Errores y robustez

- Cámara o captura denegada, sin cámara, cámara ocupada por otra aplicación, contexto no seguro: mensajes específicos.
- Vídeo dañado, códec no soportado, archivo sin pista de vídeo o que no abre en 15 s: mensajes específicos.
- Archivo de modelo ausente, vacío, truncado, puntero de Git LFS o página HTML de error: tarjeta con el archivo, su ruta y su origen oficial; los demás módulos siguen.
- Backend no disponible: se pasa al siguiente y se avisa del motivo.
- Errores de inferencia: se registran; tras 5 seguidos el módulo se desactiva con botón **Reintentar**. El bucle de frames nunca se detiene (el siguiente frame se programa antes de trabajar).
- Saltos en el vídeo (buscar hacia atrás, pestaña oculta): se reinicia el seguimiento para no inventar velocidades ni cruces.

---

## 11. Criterios de aceptación: cómo verificarlos

| # | Criterio | Cómo comprobarlo | Verificado durante el desarrollo |
|---|---|---|---|
| 1 | Con WebGL, pose + manos + objetos activos, render ≥ 30 FPS aunque el análisis baje | Webcam, activa A, B y D; mira **Render** en la cabecera (en verde si ≥ umbral) y "hilo principal: X ms/frame" bajo la tabla de modelos. | Incluso en una máquina **sin GPU física** (WebGL emulado por software): 30,5 FPS de media con pose + manos + objetos, hilo principal 0,8 ms/frame y 0 tareas largas, con el análisis degradándose (nivel adaptativo y cadencias visibles). **No medido sobre GPU real.** |
| 2 | Funciona sin red tras el primer arranque | Arranca, espera a "Activo", desconecta el Wi-Fi/cable (o DevTools → Network → Offline) y usa la app. | Prueba automatizada: con el contexto del navegador **sin red** (`navigator.onLine = false`) se abrió un vídeo, se analizó y saltó la alerta de inmovilidad; se reactivaron módulos sin errores. Todo se carga al arrancar. |
| 3 | Ninguna referencia a dominios externos | `python tools/verificar_offline.py` | Resultado OK. Además, en todas las pruebas E2E hubo **0 peticiones** fuera de `127.0.0.1` y 0 violaciones de la CSP. |
| 4 | Alertas de zona, caída e inmovilidad visibles en canvas y log | Dibuja una zona y entra; quédate quieto 10 s; simula una caída. | Pruebas E2E con vídeo: "⚠ Intrusión en Zona A — ID #1 (persona)", "⚠ Posible caída — Persona #1" (borde rojo pulsante, banner y recuadro sobre la persona) y "⚠ Inmovilidad prolongada — Persona #1 (6 s sin moverse)". |
| 5 | IDs estables en movimiento normal | Camina por la escena y observa el #ID. | Tests unitarios (cruce de dos personas con orden de detecciones cambiante, oclusión breve, análisis a 0,5 Hz) y E2E (la misma persona conserva su ID durante todo el recorrido). |

---

## 12. Pruebas

```bash
npm test                         # o: node --test "tests/unit/*.test.js"   (Node 21+, sin dependencias)
python tools/verificar_offline.py --hash
python tools/descargar_dependencias.py --verificar
```

Las pruebas unitarias (48) cubren las 1000 etiquetas y su orden, el filtro anti-fantasmas, el doble umbral del tracker, el filtro de esqueletos fantasma, las regiones del escáner, gestos y postura con **landmarks reales** obtenidos con MediaPipe sobre sus imágenes de prueba oficiales (`tests/fixtures/`), y caída, inmovilidad, tracker, húngaro, zonas, tripwires, EAR, orientación de cabeza, post-proceso SSD, planificador y control adaptativo con secuencias sintéticas.

---

## 13. Solución de problemas

| Síntoma | Solución |
|---|---|
| "Abre la app desde un servidor local" | La abriste con `file://`. Usa `python -m http.server 8000` y `localhost:8000`. |
| "La aplicación no ha podido arrancar" / tipo MIME `text/plain` | Ocurre en algunos Windows. Usa `python serve.py`. |
| No se puede usar la cámara | Permiso denegado (icono de cámara de la barra de direcciones), otra app la está usando o no estás en `localhost`. |
| Va lento | Baja *Resolución máx. de inferencia*, sube las cadencias o desactiva módulos. Si la cabecera indica "GPU por software", activa la aceleración por hardware del navegador. |
| Lateralidad de manos invertida | Tu cámara ya entrega la imagen espejada: activa *Invertir izq./der.* en las opciones de B. |
| El CSV se ve en una sola columna en Excel | Importa con *Datos → Desde texto/CSV* (separador coma, UTF-8). |
| "Archivo necesario no disponible" | Ejecuta `python tools/descargar_dependencias.py` o descarga el archivo indicado de la [sección 3](#3-archivos-a-descargar-lista-exacta). |

---

## 14. Licencias de terceros

Los archivos de `lib/` y `models/` se incluyen sin modificar, tal como se publican en sus orígenes oficiales, y conservan sus licencias: MediaPipe Tasks y sus modelos —pose, manos, rostro, EfficientDet-Lite y EfficientNet-Lite— (Apache 2.0, Google), TensorFlow.js y sus backends (Apache 2.0, Google), COCO-SSD (Apache 2.0, Google). Las etiquetas de ImageNet se han traducido al español para esta app.
