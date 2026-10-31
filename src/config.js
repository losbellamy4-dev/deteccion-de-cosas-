/**
 * config.js — Configuración central: manifiesto de archivos locales
 * (librerías y modelos) y esquema de ajustes de la interfaz.
 *
 * REGLA OFFLINE: todas las rutas son RELATIVAS a index.html. En este archivo
 * (y en todo /src) no aparece ningún dominio externo; el origen oficial de
 * cada archivo se describe en texto y las URLs de descarga están sólo en el
 * README y en tools/descargar_dependencias.py (herramienta de un solo uso).
 */

export const APP = { name: 'Detéctalo todo', version: '1.1.0' };

export const VERSIONS = {
  mediapipe: '0.10.35',
  tfjs: '4.22.0',
};

/**
 * Manifiesto de archivos que la app necesita en disco.
 *  - path:   ruta relativa a index.html
 *  - magic:  tipo esperado para validar el contenido (js | wasm | zip | tflite | json | bin)
 *  - size:   bytes de la versión fijada (sólo para avisar si difiere)
 *  - needs:  módulos que dependen del archivo
 *  - when:   'simd' / 'nosimd' → sólo se exige según la CPU/navegador
 *  - optional: no bloquea ningún módulo si falta (mejora rendimiento o variantes)
 *  - source: origen oficial (paquete y ruta interna; ver README §Archivos)
 */
const MP = `@mediapipe/tasks-vision@${VERSIONS.mediapipe}`;
const MPM = 'almacén oficial de modelos de MediaPipe (Google)';
const MP_USERS = ['pose', 'hands', 'face', 'objects', 'classifier'];
const COCO_NOTE = 'sólo para el modelo alternativo COCO-SSD (TensorFlow.js)';
export const ASSETS = [
  { id: 'mp-bundle', path: 'lib/mediapipe/vision_bundle.mjs', magic: 'js', size: 136993, needs: MP_USERS, source: `npm ${MP} → vision_bundle.mjs` },
  { id: 'mp-wasm-js', path: 'lib/mediapipe/wasm/vision_wasm_internal.js', magic: 'js', size: 322044, when: 'simd', needs: MP_USERS, source: `npm ${MP} → wasm/vision_wasm_internal.js` },
  { id: 'mp-wasm', path: 'lib/mediapipe/wasm/vision_wasm_internal.wasm', magic: 'wasm', size: 11153617, when: 'simd', needs: MP_USERS, source: `npm ${MP} → wasm/vision_wasm_internal.wasm` },
  { id: 'mp-wasm-nosimd-js', path: 'lib/mediapipe/wasm/vision_wasm_nosimd_internal.js', magic: 'js', size: 321847, when: 'nosimd', needs: MP_USERS, source: `npm ${MP} → wasm/vision_wasm_nosimd_internal.js` },
  { id: 'mp-wasm-nosimd', path: 'lib/mediapipe/wasm/vision_wasm_nosimd_internal.wasm', magic: 'wasm', size: 10481398, when: 'nosimd', needs: MP_USERS, source: `npm ${MP} → wasm/vision_wasm_nosimd_internal.wasm` },

  { id: 'tfjs', path: 'lib/tfjs/tf.min.js', magic: 'js', size: 1469843, optional: true, needs: ['objects'], source: `npm @tensorflow/tfjs@${VERSIONS.tfjs} → dist/tf.min.js`, note: COCO_NOTE },
  { id: 'tfjs-webgpu', path: 'lib/tfjs/tf-backend-webgpu.min.js', magic: 'js', size: 325535, optional: true, needs: ['objects'], source: `npm @tensorflow/tfjs-backend-webgpu@${VERSIONS.tfjs} → dist/tf-backend-webgpu.min.js`, note: `backend WebGPU, ${COCO_NOTE}` },
  { id: 'tfjs-wasm', path: 'lib/tfjs/tf-backend-wasm.min.js', magic: 'js', size: 149861, optional: true, needs: ['objects'], source: `npm @tensorflow/tfjs-backend-wasm@${VERSIONS.tfjs} → dist/tf-backend-wasm.min.js`, note: `backend WASM, ${COCO_NOTE}` },
  { id: 'tfjs-wasm-bin', path: 'lib/tfjs/tfjs-backend-wasm.wasm', magic: 'wasm', size: 311123, optional: true, needs: ['objects'], source: `npm @tensorflow/tfjs-backend-wasm@${VERSIONS.tfjs} → dist/tfjs-backend-wasm.wasm` },
  { id: 'tfjs-wasm-simd-bin', path: 'lib/tfjs/tfjs-backend-wasm-simd.wasm', magic: 'wasm', size: 424594, optional: true, needs: ['objects'], source: `npm @tensorflow/tfjs-backend-wasm@${VERSIONS.tfjs} → dist/tfjs-backend-wasm-simd.wasm` },
  { id: 'tfjs-wasm-threaded-bin', path: 'lib/tfjs/tfjs-backend-wasm-threaded-simd.wasm', magic: 'wasm', size: 435643, optional: true, needs: ['objects'], source: `npm @tensorflow/tfjs-backend-wasm@${VERSIONS.tfjs} → dist/tfjs-backend-wasm-threaded-simd.wasm` },

  { id: 'det-lite0', path: 'models/objects/efficientdet_lite0.tflite', magic: 'tflite', size: 7254339, needs: ['objects'], source: `${MPM}: object_detector/efficientdet_lite0/float16/1/efficientdet_lite0.tflite` },
  { id: 'det-lite2', path: 'models/objects/efficientdet_lite2.tflite', magic: 'tflite', size: 7515971, optional: true, needs: ['objects'], source: `${MPM}: object_detector/efficientdet_lite2/int8/1/efficientdet_lite2.tflite`, note: 'detector «preciso» EfficientDet-Lite2 (opcional)' },
  { id: 'classifier', path: 'models/classifier/efficientnet_lite0.tflite', magic: 'tflite', size: 5434517, needs: ['classifier'], source: `${MPM}: image_classifier/efficientnet_lite0/int8/1/efficientnet_lite0.tflite` },

  { id: 'pose-lite', path: 'models/pose/pose_landmarker_lite.task', magic: 'zip', size: 5777746, needs: ['pose'], source: `${MPM}: pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task` },
  { id: 'pose-full', path: 'models/pose/pose_landmarker_full.task', magic: 'zip', size: 9398198, optional: true, needs: ['pose'], source: `${MPM}: pose_landmarker/pose_landmarker_full/float16/1/pose_landmarker_full.task`, note: 'variante "full" (opcional)' },
  { id: 'pose-heavy', path: 'models/pose/pose_landmarker_heavy.task', magic: 'zip', size: 30664242, optional: true, needs: ['pose'], source: `${MPM}: pose_landmarker/pose_landmarker_heavy/float16/1/pose_landmarker_heavy.task`, note: 'variante "heavy" (opcional)' },
  { id: 'hands', path: 'models/hands/hand_landmarker.task', magic: 'zip', size: 7819105, needs: ['hands'], source: `${MPM}: hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task` },
  { id: 'face', path: 'models/face/face_landmarker.task', magic: 'zip', size: 3758596, needs: ['face'], source: `${MPM}: face_landmarker/face_landmarker/float16/1/face_landmarker.task` },

  { id: 'coco-json', path: 'models/coco-ssd/model.json', magic: 'json', size: 527315, optional: true, needs: ['objects'], source: 'almacén oficial de modelos de TensorFlow.js: savedmodel/ssdlite_mobilenet_v2/model.json', shardsFrom: true, note: COCO_NOTE },
  ...[1, 2, 3, 4, 5].map((i) => ({
    id: `coco-shard${i}`,
    path: `models/coco-ssd/group1-shard${i}of5`,
    magic: 'bin',
    size: i < 5 ? 4194304 : 1257312,
    optional: true,
    needs: ['objects'],
    source: `almacén oficial de modelos de TensorFlow.js: savedmodel/ssdlite_mobilenet_v2/group1-shard${i}of5`,
  })),
];

export const POSE_VARIANTS = {
  lite: 'models/pose/pose_landmarker_lite.task',
  full: 'models/pose/pose_landmarker_full.task',
  heavy: 'models/pose/pose_landmarker_heavy.task',
};

/**
 * Modelos del módulo D. `files`: lo que debe existir para poder usarlo (los
 * de MediaPipe necesitan además su runtime).
 */
export const OBJECT_MODELS = {
  efficientdet_lite0: { label: 'EfficientDet-Lite0', engine: 'mediapipe', path: 'models/objects/efficientdet_lite0.tflite', files: ['models/objects/efficientdet_lite0.tflite'] },
  efficientdet_lite2: { label: 'EfficientDet-Lite2', engine: 'mediapipe', path: 'models/objects/efficientdet_lite2.tflite', files: ['models/objects/efficientdet_lite2.tflite'] },
  'coco-ssd': { label: 'COCO-SSD', engine: 'tfjs', path: 'models/coco-ssd/model.json', files: ['lib/tfjs/tf.min.js', 'models/coco-ssd/model.json', ...[1, 2, 3, 4, 5].map((i) => `models/coco-ssd/group1-shard${i}of5`)] },
};

export const CLASSIFIER_MODEL = 'models/classifier/efficientnet_lite0.tflite';

export const MODULES = [
  { id: 'pose', letter: 'A', name: 'Pose corporal', short: 'Pose' },
  { id: 'hands', letter: 'B', name: 'Manos (21 puntos)', short: 'Manos' },
  { id: 'face', letter: 'C', name: 'Malla facial', short: 'Rostro' },
  { id: 'objects', letter: 'D', name: 'Objetos (80 tipos, con caja)', short: 'Objetos' },
  { id: 'motion', letter: 'E', name: 'Movimiento y anomalías', short: 'Movimiento' },
  { id: 'classifier', letter: 'F', name: 'Reconocimiento (1000 cosas)', short: 'Reconocer' },
];

/**
 * Esquema de ajustes. `group` decide en qué panel aparece cada control.
 * `apply`: 'live' (inmediato), 'task' (reconfigura el modelo), 'reload'
 * (requiere recargar la página: cambio de backend).
 */
export const SETTINGS = [
  // --- Módulos A–F (interruptores principales) -------------------------------
  { key: 'pose.enabled', type: 'bool', def: true, group: 'modules', module: 'pose', label: 'A · Pose corporal' },
  { key: 'hands.enabled', type: 'bool', def: true, group: 'modules', module: 'hands', label: 'B · Manos' },
  { key: 'face.enabled', type: 'bool', def: true, group: 'modules', module: 'face', label: 'C · Malla facial' },
  { key: 'objects.enabled', type: 'bool', def: true, group: 'modules', module: 'objects', label: 'D · Objetos' },
  { key: 'motion.enabled', type: 'bool', def: true, group: 'modules', module: 'motion', label: 'E · Movimiento' },
  { key: 'classifier.enabled', type: 'bool', def: true, group: 'modules', module: 'classifier', label: 'F · Reconocer 1000 cosas' },

  // --- Opciones por módulo --------------------------------------------------------
  { key: 'pose.variant', type: 'select', def: 'lite', group: 'opt-pose', label: 'Modelo', options: [['lite', 'Lite (rápido)'], ['full', 'Full'], ['heavy', 'Heavy (preciso)']], apply: 'task' },
  { key: 'pose.numPoses', type: 'range', def: 3, min: 1, max: 6, step: 1, group: 'opt-pose', label: 'Personas máx.', apply: 'task' },
  { key: 'pose.minVis', type: 'range', def: 0.5, min: 0.2, max: 0.9, step: 0.05, group: 'opt-pose', label: 'Confianza mín. de punto', fmt: 'pct' },
  { key: 'pose.showAngles', type: 'bool', def: true, group: 'opt-pose', label: 'Ángulos articulares' },
  { key: 'hands.numHands', type: 'range', def: 4, min: 1, max: 8, step: 1, group: 'opt-hands', label: 'Manos máx.', apply: 'task' },
  { key: 'hands.swap', type: 'bool', def: false, group: 'opt-hands', label: 'Invertir izq./der. (cámara ya espejada)' },
  { key: 'face.numFaces', type: 'range', def: 2, min: 1, max: 4, step: 1, group: 'opt-face', label: 'Rostros máx.', apply: 'task' },
  { key: 'face.mesh', type: 'select', def: 'contornos', group: 'opt-face', label: 'Dibujo', options: [['contornos', 'Contornos'], ['malla', 'Malla completa'], ['profundidad', 'Puntos por profundidad (3D)']] },
  { key: 'face.show3d', type: 'bool', def: true, group: 'opt-face', label: 'Visor 3D de la malla' },
  { key: 'objects.model', type: 'select', def: 'efficientdet_lite0', group: 'opt-objects', label: 'Modelo', options: [['efficientdet_lite0', 'EfficientDet-Lite0 (recomendado)'], ['efficientdet_lite2', 'EfficientDet-Lite2 (más preciso, más lento)'], ['coco-ssd', 'COCO-SSD (TensorFlow.js)']], apply: 'task' },
  { key: 'objects.minScore', type: 'range', def: 0.5, min: 0.3, max: 0.9, step: 0.05, group: 'opt-objects', label: 'Confianza mínima', fmt: 'pct' },
  { key: 'objects.maxResults', type: 'range', def: 20, min: 1, max: 40, step: 1, group: 'opt-objects', label: 'Detecciones máx.' },
  { key: 'motion.heatmap', type: 'bool', def: false, group: 'opt-motion', label: 'Heatmap de movimiento' },
  { key: 'motion.anomaly', type: 'bool', def: true, group: 'opt-motion', label: 'Alerta de anomalía (actividad brusca)' },
  { key: 'classifier.reticle', type: 'bool', def: true, group: 'opt-classifier', label: 'Visor central: apunta a una cosa y dice qué es' },
  { key: 'classifier.refine', type: 'bool', def: true, group: 'opt-classifier', label: 'Afinar objetos (raza, tipo exacto…)', help: 'Clasifica el recorte de cada objeto seguido: «perro» → «golden retriever». Con el filtro anti-fantasmas también corrige confusiones perro/gato, coche/camión…' },
  { key: 'classifier.scene', type: 'bool', def: true, group: 'opt-classifier', label: 'Describir la escena completa' },
  { key: 'classifier.minScore', type: 'range', def: 0.3, min: 0.1, max: 0.9, step: 0.05, group: 'opt-classifier', label: 'Confianza mínima', fmt: 'pct' },

  // --- Precisión (anti-fantasmas) ---------------------------------------------------
  { key: 'precision.strict', type: 'bool', def: true, group: 'precision', label: 'Filtro anti-fantasmas', help: 'Un objeto sólo aparece si se confirma en 3 análisis seguidos (2 si es muy claro); se exige más confianza a las clases que más se inventan (mesa, silla, televisor, bolso…); se descartan cajas diminutas, astillas, cajas de pantalla completa dudosas, duplicados y esqueletos de pose sin tronco reconocible.' },
  { key: 'objects.minArea', type: 'range', def: 0.25, min: 0, max: 3, step: 0.05, group: 'precision', label: 'Tamaño mínimo de objeto', fmt: 'pctn' },

  // --- Inteligencia derivada (sección 4) -----------------------------------------
  { key: 'derived.tracking', type: 'bool', def: true, group: 'derived', label: 'Tracking con ID persistente', help: 'Necesario para actividad, caída, inmovilidad, zonas, líneas, estelas y distancias.' },
  { key: 'derived.activity', type: 'bool', def: true, group: 'derived', label: 'Actividad (de pie, sentada, tumbada, caminando, brazos en alto)', needs: 'pose' },
  { key: 'derived.fall', type: 'bool', def: true, group: 'derived', label: 'Heurística de caída', needs: 'pose' },
  { key: 'derived.immobility', type: 'bool', def: true, group: 'derived', label: 'Inmovilidad prolongada' },
  { key: 'derived.fingers', type: 'bool', def: true, group: 'derived', label: 'Conteo de dedos y gestos', needs: 'hands' },
  { key: 'derived.faceMetrics', type: 'bool', def: true, group: 'derived', label: 'Métricas faciales (EAR, boca, sonrisa, mirada)', needs: 'face' },
  { key: 'derived.zones', type: 'bool', def: true, group: 'derived', label: 'Zonas de intrusión' },
  { key: 'derived.tripwires', type: 'bool', def: true, group: 'derived', label: 'Líneas de cruce (entradas/salidas)' },
  { key: 'derived.trails', type: 'bool', def: true, group: 'derived', label: 'Trayectorias (estelas)' },
  { key: 'derived.distances', type: 'bool', def: true, group: 'derived', label: 'Distancia entre personas (px)' },

  // --- Sensibilidad de alertas -----------------------------------------------------
  { key: 'alert.fallSensitivity', type: 'range', def: 5, min: 1, max: 10, step: 1, group: 'sens', label: 'Caída: sensibilidad' },
  { key: 'alert.fallConfirmSec', type: 'range', def: 2, min: 0.5, max: 5, step: 0.5, group: 'sens', label: 'Caída: confirmación', fmt: 's' },
  { key: 'alert.immobilitySec', type: 'range', def: 10, min: 3, max: 120, step: 1, group: 'sens', label: 'Inmovilidad: tiempo', fmt: 's' },
  { key: 'alert.immobilitySensitivity', type: 'range', def: 5, min: 1, max: 10, step: 1, group: 'sens', label: 'Inmovilidad: sensibilidad' },
  { key: 'alert.drowsySec', type: 'range', def: 1.5, min: 0.5, max: 4, step: 0.1, group: 'sens', label: 'Somnolencia: ojos cerrados', fmt: 's' },
  { key: 'alert.eyeRatio', type: 'range', def: 0.6, min: 0.4, max: 0.85, step: 0.05, group: 'sens', label: 'Ojo cerrado si EAR < (× abierto)', fmt: 'x' },
  { key: 'alert.zoneDwellSec', type: 'range', def: 0.3, min: 0, max: 2, step: 0.1, group: 'sens', label: 'Intrusión: permanencia mínima', fmt: 's' },
  { key: 'alert.zoneTargets', type: 'select', def: 'all', group: 'sens', label: 'Zonas/líneas afectan a', options: [['all', 'Personas y objetos'], ['persons', 'Sólo personas']] },
  { key: 'alert.proximity', type: 'range', def: 0.8, min: 0.2, max: 3, step: 0.1, group: 'sens', label: 'Proximidad (alturas corporales)', fmt: 'x' },
  { key: 'alert.proximityAlert', type: 'bool', def: false, group: 'sens', label: 'Alertar por proximidad' },
  { key: 'alert.motionSensitivity', type: 'range', def: 5, min: 1, max: 10, step: 1, group: 'sens', label: 'Anomalía de movimiento: sensibilidad' },
  { key: 'alert.sound', type: 'bool', def: false, group: 'sens', label: 'Sonido en alertas' },

  // --- Rendimiento -------------------------------------------------------------------
  { key: 'perf.cadence.pose', type: 'range', def: 1, min: 1, max: 10, step: 1, group: 'perf', label: 'Pose: 1 de cada N frames', fmt: 'n' },
  { key: 'perf.cadence.hands', type: 'range', def: 2, min: 1, max: 10, step: 1, group: 'perf', label: 'Manos: 1 de cada N', fmt: 'n' },
  { key: 'perf.cadence.face', type: 'range', def: 2, min: 1, max: 10, step: 1, group: 'perf', label: 'Malla facial: 1 de cada N', fmt: 'n' },
  { key: 'perf.cadence.objects', type: 'range', def: 3, min: 1, max: 10, step: 1, group: 'perf', label: 'Objetos: 1 de cada N', fmt: 'n' },
  { key: 'perf.cadence.motion', type: 'range', def: 2, min: 1, max: 10, step: 1, group: 'perf', label: 'Movimiento: 1 de cada N', fmt: 'n' },
  { key: 'perf.cadence.classifier', type: 'range', def: 6, min: 2, max: 20, step: 1, group: 'perf', label: 'Reconocimiento: 1 de cada N', fmt: 'n' },
  { key: 'perf.workers', type: 'bool', def: true, group: 'perf', label: 'Inferencia en Web Workers (recomendado)', apply: 'reload', help: 'Cada modelo se ejecuta en su propio hilo: el render no se bloquea aunque la inferencia sea lenta. Si falla, se usa el hilo principal.' },
  { key: 'perf.adaptive', type: 'bool', def: true, group: 'perf', label: 'Control de carga adaptativo' },
  { key: 'perf.fpsTarget', type: 'range', def: 30, min: 20, max: 55, step: 1, group: 'perf', label: 'Umbral FPS de render', fmt: 'fps' },
  { key: 'perf.budgetMs', type: 'range', def: 16, min: 4, max: 40, step: 1, group: 'perf', label: 'Presupuesto de análisis por frame', fmt: 'ms' },
  { key: 'perf.maxSide', type: 'select', def: '640', group: 'perf', label: 'Resolución máx. de inferencia', options: [['320', '320 px'], ['480', '480 px'], ['640', '640 px'], ['960', '960 px'], ['1280', '1280 px']] },
  { key: 'perf.tfBackend', type: 'select', def: 'auto', group: 'perf', label: 'Backend TF.js (sólo COCO-SSD)', options: [['auto', 'Automático'], ['webgpu', 'WebGPU'], ['webgl', 'WebGL'], ['wasm', 'WASM (CPU)'], ['cpu', 'CPU (JS)']], apply: 'reload' },
  { key: 'perf.mpDelegate', type: 'select', def: 'auto', group: 'perf', label: 'Delegado MediaPipe', options: [['auto', 'Automático'], ['GPU', 'GPU (WebGL2)'], ['CPU', 'CPU (WASM)']], apply: 'reload' },

  // --- Vista ---------------------------------------------------------------------------
  { key: 'view.mirror', type: 'select', def: 'auto', group: 'view', label: 'Espejo', options: [['auto', 'Auto (sólo webcam)'], ['on', 'Siempre'], ['off', 'Nunca']] },
  { key: 'view.labels', type: 'bool', def: true, group: 'view', label: 'Etiquetas sobre el vídeo' },
  { key: 'view.hud', type: 'bool', def: true, group: 'view', label: 'HUD con hora y contadores' },
];

/** Nombres en español de las 80 clases COCO, indexados por ID original (1..90). */
export const COCO_LABELS = {
  1: 'persona', 2: 'bicicleta', 3: 'coche', 4: 'moto', 5: 'avión', 6: 'autobús', 7: 'tren', 8: 'camión',
  9: 'barco', 10: 'semáforo', 11: 'boca de incendios', 13: 'señal de stop', 14: 'parquímetro', 15: 'banco',
  16: 'pájaro', 17: 'gato', 18: 'perro', 19: 'caballo', 20: 'oveja', 21: 'vaca', 22: 'elefante', 23: 'oso',
  24: 'cebra', 25: 'jirafa', 27: 'mochila', 28: 'paraguas', 31: 'bolso', 32: 'corbata', 33: 'maleta',
  34: 'frisbi', 35: 'esquís', 36: 'snowboard', 37: 'pelota', 38: 'cometa', 39: 'bate de béisbol',
  40: 'guante de béisbol', 41: 'monopatín', 42: 'tabla de surf', 43: 'raqueta de tenis', 44: 'botella',
  46: 'copa de vino', 47: 'taza', 48: 'tenedor', 49: 'cuchillo', 50: 'cuchara', 51: 'cuenco', 52: 'plátano',
  53: 'manzana', 54: 'sándwich', 55: 'naranja', 56: 'brócoli', 57: 'zanahoria', 58: 'perrito caliente',
  59: 'pizza', 60: 'dónut', 61: 'tarta', 62: 'silla', 63: 'sofá', 64: 'planta en maceta', 65: 'cama',
  67: 'mesa', 70: 'inodoro', 72: 'televisor', 73: 'portátil', 74: 'ratón', 75: 'mando a distancia',
  76: 'teclado', 77: 'móvil', 78: 'microondas', 79: 'horno', 80: 'tostadora', 81: 'fregadero', 82: 'nevera',
  84: 'libro', 85: 'reloj', 86: 'jarrón', 87: 'tijeras', 88: 'osito de peluche', 89: 'secador de pelo',
  90: 'cepillo de dientes',
};
