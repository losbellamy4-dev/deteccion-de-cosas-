/**
 * VideoSource.js — Fuente de vídeo: webcam, archivo local o captura de
 * pantalla, todo con APIs locales del navegador (getUserMedia,
 * getDisplayMedia, URL.createObjectURL). Ningún fotograma sale del equipo.
 *
 * También expone el "reloj de frames": con requestVideoFrameCallback se sabe
 * exactamente cuándo hay un fotograma NUEVO, para no analizar dos veces el
 * mismo (con un vídeo de 30 fps y una pantalla de 60 Hz, la mitad de los
 * frames de render no traen imagen nueva).
 */
import { Emitter } from './Emitter.js';

const HAS_RVFC = typeof HTMLVideoElement !== 'undefined' && 'requestVideoFrameCallback' in HTMLVideoElement.prototype;

export class VideoSource extends Emitter {
  constructor(videoEl) {
    super();
    this.el = videoEl;
    this.kind = null;          // 'webcam' | 'file' | 'screen'
    this.stream = null;
    this.objectUrl = null;
    this.fileName = '';
    this.frameSeq = 0;         // se incrementa con cada fotograma presentado
    this.mediaTime = 0;
    this.frameDur = 1 / 30;
    this._rvfc = null;
    this._lastPoll = 0;
    this._lastPolledTime = -1;
    this._stepping = false;
    this.el.muted = true;
    this.el.playsInline = true;
    this.el.addEventListener('play', () => this.emit('state', this.state));
    this.el.addEventListener('pause', () => this.emit('state', this.state));
    this.el.addEventListener('ended', () => this.emit('state', this.state));
    this.el.addEventListener('seeked', () => { this.mediaTime = this.el.currentTime; this.emit('seeked', this.el.currentTime); });
  }

  get ready() { return !!this.kind && this.el.readyState >= 2 && this.el.videoWidth > 0; }
  get isLive() { return this.kind === 'webcam' || this.kind === 'screen'; }
  get paused() { return this.el.paused || this.el.ended; }
  get width() { return this.el.videoWidth; }
  get height() { return this.el.videoHeight; }
  get state() {
    return {
      kind: this.kind, paused: this.paused, live: this.isLive, time: this.el.currentTime,
      duration: Number.isFinite(this.el.duration) ? this.el.duration : null, rate: this.el.playbackRate,
      loop: this.el.loop, name: this.fileName, width: this.width, height: this.height,
    };
  }

  // ---- Fuentes ------------------------------------------------------------------

  async startWebcam(deviceId) {
    this._assertMediaDevices('getUserMedia');
    const ideal = { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } };
    const video = deviceId ? { ...ideal, deviceId: { exact: deviceId } } : { ...ideal, facingMode: 'user' };
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video, audio: false });
    } catch (e) {
      // Cámara que no admite las restricciones pedidas: reintento sin ellas.
      if (e && (e.name === 'OverconstrainedError' || e.name === 'ConstraintNotSatisfiedError')) {
        stream = await navigator.mediaDevices.getUserMedia({ video: deviceId ? { deviceId: { exact: deviceId } } : true, audio: false })
          .catch((e2) => { throw new Error(describeMediaError(e2, 'webcam')); });
      } else {
        throw new Error(describeMediaError(e, 'webcam'));
      }
    }
    await this._attachStream(stream, 'webcam');
  }

  async startScreen() {
    this._assertMediaDevices('getDisplayMedia');
    let stream;
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: 30 } }, audio: false });
    } catch (e) {
      throw new Error(describeMediaError(e, 'screen'));
    }
    await this._attachStream(stream, 'screen');
  }

  async startFile(file) {
    if (!file) throw new Error('No se ha seleccionado ningún archivo.');
    const okExt = /\.(mp4|m4v|webm|ogv|ogg|mov|mkv)$/i.test(file.name);
    if (file.type && !file.type.startsWith('video/') && !okExt) {
      throw new Error(`«${file.name}» no parece un vídeo (tipo ${file.type}). Usa MP4 (H.264) o WebM (VP8/VP9/AV1).`);
    }
    this.stop();
    this.objectUrl = URL.createObjectURL(file);
    this.fileName = file.name;
    this.el.srcObject = null;
    this.el.src = this.objectUrl;
    this.el.loop = true;
    this.kind = 'file';
    try {
      await this._waitMetadata(15000, 'file');
    } catch (e) {
      this.stop();
      throw e;
    }
    await this.el.play().catch(() => { /* reproducción bloqueada: el usuario pulsará ▶ */ });
    this._watchFrames();
    this.emit('started', this.state);
  }

  stop() {
    if (this._rvfc != null && HAS_RVFC) { try { this.el.cancelVideoFrameCallback(this._rvfc); } catch { /* ignorar */ } }
    this._rvfc = null;
    if (this.stream) { for (const t of this.stream.getTracks()) t.stop(); }
    this.stream = null;
    this.el.pause();
    this.el.removeAttribute('src');
    this.el.srcObject = null;
    try { this.el.load(); } catch { /* ignorar */ }
    if (this.objectUrl) URL.revokeObjectURL(this.objectUrl);
    this.objectUrl = null;
    const had = this.kind;
    this.kind = null;
    this.fileName = '';
    if (had) this.emit('stopped');
  }

  async listCameras() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return [];
    try {
      const devs = await navigator.mediaDevices.enumerateDevices();
      return devs.filter((d) => d.kind === 'videoinput').map((d, i) => ({ id: d.deviceId, label: d.label || `Cámara ${i + 1}` }));
    } catch {
      return [];
    }
  }

  // ---- Reproducción ---------------------------------------------------------------

  play() { if (this.kind) return this.el.play().catch(() => {}); }
  pause() { if (this.kind) this.el.pause(); }
  togglePlay() { if (this.paused) this.play(); else this.pause(); }
  setRate(r) { this.el.playbackRate = r; this.emit('state', this.state); }
  setLoop(b) { this.el.loop = !!b; this.emit('state', this.state); }

  seek(t) {
    if (this.kind !== 'file') return;
    const d = this.el.duration;
    this.el.currentTime = Math.max(0, Math.min(Number.isFinite(d) ? d : t, t));
  }

  /**
   * Avance de un fotograma. En archivos: pausa y adelanta la duración de un
   * frame (estimada de los metadatos del vídeo). En directo: deja pasar
   * exactamente un fotograma nuevo y vuelve a pausar.
   */
  async step() {
    if (!this.kind || this._stepping) return;
    this._stepping = true;
    try {
      if (this.kind === 'file') {
        this.el.pause();
        const target = this.el.currentTime + this.frameDur;
        await new Promise((res) => {
          const done = () => { this.el.removeEventListener('seeked', done); res(); };
          this.el.addEventListener('seeked', done);
          this.seek(target);
          setTimeout(done, 1500);
        });
      } else {
        const seq = this.frameSeq;
        await this.el.play().catch(() => {});
        const t0 = performance.now();
        while (this.frameSeq === seq && performance.now() - t0 < 1000) await new Promise((r) => setTimeout(r, 8));
        this.el.pause();
      }
    } finally {
      this._stepping = false;
    }
  }

  /**
   * Sondeo de frames nuevos para navegadores sin requestVideoFrameCallback:
   * en archivos detecta cambios de currentTime; en directo asume ~30 fps.
   */
  pollFrame(now) {
    if (HAS_RVFC || !this.ready) return;
    if (this.kind === 'file') {
      if (this.el.currentTime !== this._lastPolledTime) {
        this._lastPolledTime = this.el.currentTime;
        this.mediaTime = this.el.currentTime;
        this.frameSeq++;
      }
    } else if (!this.paused && now - this._lastPoll >= 33) {
      this._lastPoll = now;
      this.frameSeq++;
    }
  }

  // ---- Internos -----------------------------------------------------------------

  _assertMediaDevices(fn) {
    if (!window.isSecureContext) {
      throw new Error('El navegador sólo permite cámara y captura en un contexto seguro: abre la app como localhost:8000 (no con la IP de la red ni con file://).');
    }
    if (!navigator.mediaDevices || typeof navigator.mediaDevices[fn] !== 'function') {
      throw new Error(fn === 'getDisplayMedia'
        ? 'Este navegador no permite capturar la pantalla (en móviles no suele estar disponible).'
        : 'Este navegador no permite acceder a la cámara.');
    }
  }

  async _attachStream(stream, kind) {
    this.stop();
    this.stream = stream;
    this.kind = kind;
    this.el.srcObject = stream;
    const track = stream.getVideoTracks()[0];
    if (track) {
      track.addEventListener('ended', () => {
        if (this.stream === stream) {
          this.emit('ended', kind);
          this.stop();
        }
      });
    }
    try {
      await this._waitMetadata(10000, kind);
      await this.el.play();
    } catch (e) {
      this.stop();
      throw e instanceof Error ? e : new Error(String(e));
    }
    this._watchFrames();
    this.emit('started', this.state);
  }

  _waitMetadata(timeoutMs, kind) {
    return new Promise((resolve, reject) => {
      const el = this.el;
      if (el.readyState >= 1 && el.videoWidth > 0) { resolve(); return; }
      let timer = null;
      const cleanup = () => {
        clearTimeout(timer);
        el.removeEventListener('loadedmetadata', onMeta);
        el.removeEventListener('error', onErr);
      };
      const onMeta = () => {
        if (el.videoWidth === 0) {
          cleanup();
          reject(new Error(kind === 'file' ? 'El archivo no contiene una pista de vídeo (¿sólo audio?).' : 'La fuente no entrega imagen.'));
          return;
        }
        cleanup();
        resolve();
      };
      const onErr = () => { cleanup(); reject(new Error(describeVideoElementError(el.error, kind))); };
      timer = setTimeout(() => {
        cleanup();
        reject(new Error(kind === 'file'
          ? 'El vídeo tarda demasiado en abrirse: puede estar dañado o usar un códec no soportado.'
          : 'La fuente de vídeo no responde.'));
      }, timeoutMs);
      el.addEventListener('loadedmetadata', onMeta);
      el.addEventListener('error', onErr);
    });
  }

  _watchFrames() {
    if (!HAS_RVFC) return;
    let lastMedia = null;
    const cb = (now, meta) => {
      this.frameSeq++;
      this.mediaTime = meta.mediaTime;
      // Duración de frame estimada a partir de la diferencia entre frames.
      if (lastMedia != null) {
        const d = meta.mediaTime - lastMedia;
        if (d > 0.004 && d < 0.2) this.frameDur += (d - this.frameDur) * 0.2;
      }
      lastMedia = meta.mediaTime;
      if (this.kind) this._rvfc = this.el.requestVideoFrameCallback(cb);
    };
    this._rvfc = this.el.requestVideoFrameCallback(cb);
  }
}

/** Traduce los errores de getUserMedia/getDisplayMedia a mensajes claros. */
export function describeMediaError(e, kind) {
  const what = kind === 'screen' ? 'la captura de pantalla' : 'la cámara';
  const name = e && e.name;
  switch (name) {
    case 'NotAllowedError':
    case 'PermissionDeniedError':
      return kind === 'screen'
        ? 'Has cancelado o denegado la captura de pantalla.'
        : 'Permiso de cámara denegado. Permite el acceso desde el icono de la cámara en la barra de direcciones y vuelve a intentarlo.';
    case 'NotFoundError':
    case 'DevicesNotFoundError':
      return 'No se ha encontrado ninguna cámara conectada.';
    case 'NotReadableError':
    case 'TrackStartError':
      return `No se puede usar ${what}: probablemente otra aplicación la está usando.`;
    case 'OverconstrainedError':
      return 'La cámara no admite la configuración solicitada.';
    case 'SecurityError':
      return `El navegador bloquea ${what} en esta página (se requiere localhost o HTTPS).`;
    case 'AbortError':
      return `Se interrumpió el acceso a ${what}.`;
    default:
      return `Error al acceder a ${what}: ${e && e.message ? e.message : e}`;
  }
}

/** Traduce los errores del elemento <video> (MediaError). */
export function describeVideoElementError(err, kind) {
  if (kind !== 'file') return 'La fuente de vídeo ha fallado.';
  const code = err && err.code;
  if (code === 3) return 'El vídeo está dañado: no se pudo decodificar.';
  if (code === 4) return 'Formato o códec no soportado por el navegador (prueba MP4 H.264 o WebM VP9).';
  if (code === 2) return 'Error de lectura del archivo.';
  if (code === 1) return 'Se canceló la carga del vídeo.';
  return 'No se pudo abrir el vídeo.';
}
