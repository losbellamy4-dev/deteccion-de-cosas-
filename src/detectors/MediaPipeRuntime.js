/**
 * MediaPipeRuntime.js — Carga local de MediaPipe Tasks Vision y creación de
 * tareas con selección de delegado (GPU ↔ CPU) y prueba de arranque.
 *
 * Inicialización de modelos (paso a paso):
 *  1. Se importa el bundle ES `lib/mediapipe/vision_bundle.mjs` (ruta local).
 *  2. Se construye a mano el "fileset" WASM con rutas locales. NO se usa
 *     FilesetResolver con una URL base remota: así es imposible que la
 *     librería intente descargar nada de una red de distribución externa.
 *     Se elige la variante SIMD o no-SIMD según lo que soporte el navegador.
 *  3. Cada tarea (pose, manos, rostro) se crea a partir de los BYTES del
 *     modelo `.task` (descargados localmente con barra de progreso), probando
 *     los delegados en orden. Tras crearla se hace una inferencia de
 *     calentamiento sobre un lienzo vacío: compila los shaders de GPU y, si el
 *     delegado falla en la práctica, se descarta y se prueba el siguiente.
 *
 * Versión fijada: 0.10.35. Las versiones 1.x del paquete incluyen un módulo
 * de telemetría que envía datos a un servidor externo; por eso no se usan.
 */
import { importModule, baseUrl, portable } from '../core/AssetChecker.js';

export class MediaPipeRuntime {
  constructor({ bundlePath, wasmDir, simd }) {
    this.bundlePath = bundlePath;
    this.wasmDir = wasmDir.replace(/\/$/, '');
    this.simd = simd;
    this.vision = null;
    this.fileset = null;
  }

  async load() {
    this.vision = await importModule(this.bundlePath);
    const base = this.simd ? 'vision_wasm_internal' : 'vision_wasm_nosimd_internal';
    const js = `${this.wasmDir}/${base}.js`, wasm = `${this.wasmDir}/${base}.wasm`;
    const P = portable();
    // En modo portable el cargador y el binario se sirven como blobs: Emscripten
    // no puede leer URLs file:// y el navegador bloquea fetch() sobre file://.
    this.fileset = P && P.has(js)
      ? { wasmLoaderPath: await P.blobUrl(js, 'text/javascript'), wasmBinaryPath: await P.blobUrl(wasm, 'application/wasm') }
      : { wasmLoaderPath: new URL(js, baseUrl()).href, wasmBinaryPath: new URL(wasm, baseUrl()).href };
    return this.vision;
  }

  /**
   * Crea una tarea probando los delegados en el orden indicado.
   * @param {Function} TaskClass  p. ej. vision.PoseLandmarker
   * @param {object} options      opciones de la tarea (baseOptions sin delegate)
   * @param {Array<'GPU'|'CPU'>} order orden de delegados a probar
   * @returns {Promise<{task:any, delegate:string, errors:string[]}>}
   */
  async createTask(TaskClass, options, order) {
    const errors = [];
    for (const delegate of order) {
      let task = null;
      try {
        task = await TaskClass.createFromOptions(this.fileset, {
          ...options,
          baseOptions: { ...options.baseOptions, delegate },
        });
        warmup(task, options.runningMode);
        return { task, delegate, errors };
      } catch (e) {
        errors.push(`${delegate}: ${e && e.message ? e.message : e}`);
        try { task && task.close(); } catch { /* ignorar */ }
      }
    }
    throw new Error(`No se pudo crear la tarea con ningún delegado (${errors.join(' | ')})`);
  }
}

let blank = null;
/** Inferencia de calentamiento sobre un lienzo negro de 64×64 (también en workers). */
function warmup(task, mode) {
  if (!blank) {
    blank = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(64, 64) : document.createElement('canvas');
    blank.width = 64;
    blank.height = 64;
    const ctx = blank.getContext('2d');
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, 64, 64);
  }
  const r = mode === 'VIDEO' ? task.detectForVideo(blank, 1) : task.detect(blank);
  if (r && typeof r.close === 'function') r.close();
}

/** Orden de delegados según preferencia y capacidades detectadas. */
export function delegateOrder(pref, gpu) {
  if (!gpu.webgl2) return ['CPU'];
  if (pref === 'GPU') return ['GPU', 'CPU'];
  if (pref === 'CPU') return ['CPU', 'GPU'];
  // Automático: con GPU por software (SwiftShader, llvmpipe…) el delegado
  // CPU/WASM es mucho más rápido que emular WebGL en la CPU.
  return gpu.software ? ['CPU', 'GPU'] : ['GPU', 'CPU'];
}
