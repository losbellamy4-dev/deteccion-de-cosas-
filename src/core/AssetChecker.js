/**
 * AssetChecker.js — Comprobación de archivos locales al arranque y utilidades
 * de carga (scripts, módulos y binarios con progreso).
 *
 * Antes de inicializar nada se verifica CADA archivo del manifiesto:
 *  - existe (HTTP 200) en su ruta relativa (petición HEAD: sin descargar el
 *    cuerpo, así el servidor no ve conexiones cortadas a medias);
 *  - no es una página HTML de error ni un archivo truncado / puntero de Git
 *    LFS (tamaño ridículo frente al esperado);
 *  - los JS/JSON (pequeños) se leen enteros para validar su contenido;
 *  - los binarios grandes (.wasm, .task) se validan por su firma al CARGARLOS
 *    (assertMagic), cuando ya se están leyendo completos;
 *  - su tamaño coincide con la versión fijada (si no, sólo se avisa).
 * Si algo falla se informa de QUÉ archivo falta y DÓNDE debe ir. Nunca se
 * intenta descargar nada de Internet como alternativa.
 */

export class AssetError extends Error {
  constructor(message, asset) {
    super(message);
    this.name = 'AssetError';
    this.asset = asset;
  }
}

/**
 * Firmas esperadas y hasta qué desplazamiento se buscan. Los .task de
 * MediaPipe son archivos ZIP precedidos de 2 bytes nulos (firma "PK\x03\x04"
 * en el desplazamiento 2, verificado con los modelos oficiales). Los .tflite
 * son FlatBuffers con el identificador "TFL3" en el desplazamiento 4.
 */
const MAGIC = {
  wasm: { sig: [0x00, 0x61, 0x73, 0x6d], maxOffset: 0, name: 'WebAssembly' }, // \0asm
  zip: { sig: [0x50, 0x4b, 0x03, 0x04], maxOffset: 8, name: 'modelo .task (ZIP)' },
  tflite: { sig: [0x54, 0x46, 0x4c, 0x33], maxOffset: 4, name: 'modelo TFLite' }, // TFL3
};

function hasSignature(head, { sig, maxOffset }) {
  for (let off = 0; off <= maxOffset && off + sig.length <= head.length; off++) {
    if (sig.every((b, i) => head[off + i] === b)) return true;
  }
  return false;
}

/**
 * Valida la firma de un binario ya leído; lanza un error claro si no cuadra.
 * @param {Uint8Array} bytes
 * @param {'wasm'|'zip'|'tflite'} kind
 * @param {string} path
 */
export function assertMagic(bytes, kind, path) {
  const m = MAGIC[kind];
  if (!m) return;
  const head = bytes.subarray(0, 64);
  const text = String.fromCharCode(...head.subarray(0, 48));
  if (/^version /.test(text) && text.includes('git-lfs')) {
    throw new AssetError(`«${path}» es un puntero de Git LFS, no el archivo real. Descárgalo de nuevo desde su origen oficial.`, { path });
  }
  if (!hasSignature(head, m)) {
    throw new AssetError(`«${path}» no es un ${m.name} válido: puede estar dañado o ser otro archivo. Vuelve a descargarlo (ver README).`, { path });
  }
}

const firstNonSpace = (s) => s.replace(/^[\s\uFEFF]+/, '').charAt(0);
const TEXT_LIMIT = 3 * 1024 * 1024;

/**
 * Verifica un archivo del manifiesto.
 * @returns {Promise<{asset, ok:boolean, level:'ok'|'warn'|'error', problem?:string, message:string, size:number|null}>}
 */
export async function checkAsset(asset) {
  const textual = asset.magic === 'js' || asset.magic === 'json';
  let res;
  let usedGet = false;
  try {
    res = await fetch(asset.path, { method: 'HEAD', cache: 'no-cache' });
    if (res.status === 405 || res.status === 501) {
      // Servidor sin HEAD: GET; el cuerpo de los binarios se descarta abajo.
      res = await fetch(asset.path, { cache: 'no-cache' });
      usedGet = true;
    }
  } catch (e) {
    return fail(asset, 'red', `No se pudo leer «${asset.path}» (${e.message}). ¿Sigue en marcha el servidor local?`);
  }
  if (usedGet && !textual && res.body) res.body.cancel().catch(() => {});
  if (res.status === 404) return fail(asset, 'missing', `Falta el archivo «${asset.path}».`);
  if (!res.ok) return fail(asset, 'http', `El servidor respondió HTTP ${res.status} para «${asset.path}».`);
  const ctype = (res.headers.get('content-type') || '').toLowerCase();
  const lenHeader = res.headers.get('content-length');
  const len = lenHeader == null ? null : Number(lenHeader);
  if (!textual && ctype.includes('text/html')) {
    return fail(asset, 'html', `«${asset.path}» contiene una página HTML (probablemente un error de descarga o el servidor no encuentra el archivo).`);
  }
  if (len === 0) return fail(asset, 'empty', `El archivo «${asset.path}» está vacío.`);
  if (len != null && asset.size > 100000 && len < 2048) {
    return fail(asset, 'truncated', `«${asset.path}» ocupa sólo ${len} bytes (se esperaban ${fmtBytes(asset.size)}): está truncado o es un puntero de Git LFS.`);
  }
  if (textual && (len == null || len <= TEXT_LIMIT)) {
    // Archivos de texto pequeños: se leen enteros (sin cortar la conexión).
    let text;
    try {
      text = usedGet ? await res.text() : await (await fetch(asset.path, { cache: 'no-cache' })).text();
    } catch (e) {
      return fail(asset, 'red', `No se pudo leer «${asset.path}» (${e.message}).`);
    }
    const start = text.slice(0, 200);
    if (/^version /.test(start) && start.includes('git-lfs')) {
      return fail(asset, 'lfs', `«${asset.path}» es un puntero de Git LFS, no el archivo real. Descárgalo de nuevo desde su origen oficial.`);
    }
    if (firstNonSpace(start) === '<') return fail(asset, 'html', `«${asset.path}» contiene HTML en lugar de ${asset.magic === 'json' ? 'JSON' : 'JavaScript'}.`);
    if (asset.magic === 'json' && firstNonSpace(start) !== '{') return fail(asset, 'type', `«${asset.path}» no es un JSON válido.`);
  }
  if (asset.size && len && len !== asset.size) {
    return {
      asset, ok: true, level: 'warn', size: len, problem: 'size',
      message: `«${asset.path}» mide ${fmtBytes(len)} y la versión verificada mide ${fmtBytes(asset.size)}: puede ser otra versión o una descarga incompleta.`,
    };
  }
  return { asset, ok: true, level: 'ok', size: len, message: 'ok' };
}

function fail(asset, problem, message) {
  return { asset, ok: false, level: 'error', problem, message, size: null };
}

/**
 * Comprueba todo el manifiesto en paralelo. Para el model.json de TF.js
 * también comprueba que existan todos los fragmentos de pesos que declara.
 */
export async function checkAll(assets, { simd }) {
  const relevant = assets.filter((a) => !a.when || (a.when === 'simd') === simd);
  const results = await Promise.all(relevant.map(checkAsset));
  for (const r of results) {
    if (!r.ok || !r.asset.shardsFrom) continue;
    try {
      const json = await (await fetch(r.asset.path, { cache: 'no-cache' })).json();
      const base = r.asset.path.slice(0, r.asset.path.lastIndexOf('/') + 1);
      const declared = (json.weightsManifest || []).flatMap((g) => g.paths || []);
      if (!declared.length) {
        Object.assign(r, fail(r.asset, 'type', `«${r.asset.path}» no declara pesos (weightsManifest vacío).`));
        continue;
      }
      for (const p of declared) {
        const path = base + p;
        if (results.some((x) => x.asset.path === path)) continue;
        const extra = await checkAsset({ id: `shard:${p}`, path, magic: 'bin', needs: r.asset.needs, source: r.asset.source.replace('model.json', p) });
        results.push(extra);
      }
    } catch (e) {
      Object.assign(r, fail(r.asset, 'type', `No se pudo interpretar «${r.asset.path}»: ${e.message}`));
    }
  }
  return results;
}

export function fmtBytes(n) {
  if (n == null) return '?';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** Descarga local con progreso (bytes recibidos / total). */
export async function fetchWithProgress(path, onProgress) {
  const res = await fetch(path);
  if (!res.ok) throw new AssetError(`HTTP ${res.status} al leer «${path}»`, { path });
  const total = Number(res.headers.get('content-length')) || 0;
  if (!res.body || !res.body.getReader) {
    const buf = new Uint8Array(await res.arrayBuffer());
    onProgress && onProgress(buf.length, buf.length);
    return buf;
  }
  const reader = res.body.getReader();
  const chunks = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    got += value.length;
    onProgress && onProgress(got, Math.max(total, got));
  }
  const out = new Uint8Array(got);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.length; }
  return out;
}

/**
 * Modo portable: un único HTML con librerías y modelos incrustados (lo genera
 * tools/construir_portable.py). Expone `has(ruta)` y `blobUrl(ruta, tipo)`;
 * fuera de ese modo es null y todo se carga desde archivos.
 */
export const portable = () => globalThis.__DETECTALO_PORTABLE__ || null;

/** URL base para resolver rutas relativas (documento o, dentro de un worker, el script). */
export function baseUrl() {
  return typeof document !== 'undefined' ? document.baseURI : self.location.href;
}

/** Inserta un <script> clásico local (para los bundles UMD de TF.js). */
export async function loadClassicScript(path) {
  const P = portable();
  const src = P && P.has(path) ? await P.blobUrl(path, 'text/javascript') : path;
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.async = false;
    s.onload = () => resolve();
    s.onerror = () => reject(new AssetError(`No se pudo cargar el script «${path}»`, { path }));
    document.head.appendChild(s);
  });
}

/**
 * Importa un módulo ES local. Si falla (p. ej. un servidor antiguo que sirve
 * `.mjs` con un tipo MIME incorrecto), lo reintenta leyendo el texto y
 * cargándolo desde un Blob con el tipo correcto. Sigue siendo 100 % local.
 */
export async function importModule(path) {
  const P = portable();
  if (P && P.has(path)) return import(await P.blobUrl(path, 'text/javascript'));
  const abs = new URL(path, baseUrl()).href;
  try {
    return await import(abs);
  } catch (e) {
    const res = await fetch(abs);
    if (!res.ok) throw new AssetError(`No se pudo importar «${path}» (HTTP ${res.status})`, { path });
    const code = await res.text();
    const url = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
    try {
      return await import(url);
    } catch (e2) {
      throw new AssetError(`No se pudo importar «${path}»: ${e2.message}`, { path });
    } finally {
      URL.revokeObjectURL(url);
    }
  }
}
