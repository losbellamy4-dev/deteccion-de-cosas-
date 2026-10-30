/**
 * BackendManager.js — Detección de capacidades y selección de backend.
 *
 *  - TensorFlow.js (objetos): WebGPU → WebGL → WASM → CPU. Cada candidato se
 *    activa con tf.setBackend(); si falla (navegador sin WebGPU, WebGL en lista
 *    negra, archivo opcional ausente…) se pasa al siguiente y se anota el
 *    motivo para mostrarlo en la interfaz.
 *  - MediaPipe (pose/manos/rostro): delegado GPU (WebGL2) → CPU (WASM+XNNPACK).
 *    MediaPipe Tasks para web no ofrece delegado WebGPU en tareas de visión.
 *  - Si la "GPU" es un rasterizador por software (SwiftShader, llvmpipe,
 *    Microsoft Basic Render…), en modo automático se prefieren los backends de
 *    CPU: emular WebGL en la CPU es mucho más lento que el WASM optimizado
 *    (medido: ~1 s frente a ~80 ms por inferencia de pose).
 */

export function detectGpu() {
  const info = { webgl2: false, renderer: '', software: false, webgpu: typeof navigator !== 'undefined' && !!navigator.gpu };
  try {
    const c = document.createElement('canvas');
    const gl = c.getContext('webgl2');
    if (gl) {
      info.webgl2 = true;
      const ext = gl.getExtension('WEBGL_debug_renderer_info');
      info.renderer = String((ext && gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) || gl.getParameter(gl.RENDERER) || '');
      const lose = gl.getExtension('WEBGL_lose_context');
      if (lose) lose.loseContext();
    }
  } catch { /* sin WebGL2 */ }
  info.software = /swiftshader|llvmpipe|softpipe|software|basic render/i.test(info.renderer);
  return info;
}

/** Soporte de WASM SIMD (módulo mínimo con una instrucción v128). */
export function wasmSimdSupported() {
  try {
    return WebAssembly.validate(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11]));
  } catch {
    return false;
  }
}

const ALL = ['webgpu', 'webgl', 'wasm', 'cpu'];

/** Orden de backends TF.js a probar según preferencia y GPU detectada. */
export function tfBackendOrder(pref, gpu) {
  if (pref && pref !== 'auto') return [pref, ...ALL.filter((b) => b !== pref)];
  return gpu.software ? ['wasm', 'cpu', 'webgl', 'webgpu'] : ALL.slice();
}

/**
 * Activa el primer backend que funcione de la lista.
 * @returns {Promise<{name:string, attempts:Array<{name:string, ok:boolean, reason?:string}>}>}
 */
export async function activateTfBackend(tf, order, { auto = true } = {}) {
  const attempts = [];
  for (const name of order) {
    if (!tf.findBackendFactory(name)) {
      attempts.push({ name, ok: false, reason: 'no disponible (archivo opcional no instalado)' });
      continue;
    }
    if (name === 'webgpu') {
      if (!navigator.gpu) { attempts.push({ name, ok: false, reason: 'el navegador no expone WebGPU' }); continue; }
      try {
        const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
        if (!adapter) { attempts.push({ name, ok: false, reason: 'sin adaptador WebGPU' }); continue; }
        const fallback = adapter.isFallbackAdapter || (adapter.info && adapter.info.isFallbackAdapter);
        if (auto && fallback) { attempts.push({ name, ok: false, reason: 'adaptador WebGPU por software' }); continue; }
      } catch (e) {
        attempts.push({ name, ok: false, reason: e.message });
        continue;
      }
    }
    try {
      const ok = await tf.setBackend(name);
      if (!ok) throw new Error('no se pudo inicializar');
      await tf.ready();
      attempts.push({ name, ok: true });
      return { name, attempts };
    } catch (e) {
      attempts.push({ name, ok: false, reason: e && e.message ? e.message : String(e) });
    }
  }
  const err = new Error(`Ningún backend de TF.js disponible: ${attempts.map((a) => `${a.name} (${a.reason})`).join('; ')}`);
  err.attempts = attempts;
  throw err;
}
