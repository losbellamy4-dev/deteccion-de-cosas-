/**
 * FaceMesh3DView.js — Visor 3D de la malla facial (478 puntos) en un canvas 2D
 * con proyección en perspectiva propia: sin WebGL ni librerías extra.
 * Se puede girar arrastrando; si no se toca, oscila suavemente para mostrar la
 * profundidad. Sólo dibuja cuando es visible (ahorra CPU).
 */
export class FaceMesh3DView {
  constructor(canvas, { getFace, getConnections, isEnabled }) {
    this.c = canvas;
    this.ctx = canvas.getContext('2d');
    this.getFace = getFace;
    this.getConnections = getConnections;
    this.isEnabled = isEnabled;
    this.yaw = 0;
    this.pitch = -0.1;
    this.userYaw = 0;
    this.userPitch = 0;
    this.drag = null;
    this.lastDraw = 0;
    this.lastInteraction = -1e9;
    canvas.addEventListener('pointerdown', (e) => {
      this.drag = { x: e.clientX, y: e.clientY, yaw: this.userYaw, pitch: this.userPitch };
      canvas.setPointerCapture(e.pointerId);
    });
    canvas.addEventListener('pointermove', (e) => {
      if (!this.drag) return;
      this.userYaw = this.drag.yaw + (e.clientX - this.drag.x) * 0.012;
      this.userPitch = Math.max(-1.2, Math.min(1.2, this.drag.pitch + (e.clientY - this.drag.y) * 0.012));
      this.lastInteraction = performance.now();
    });
    const end = () => { this.drag = null; };
    canvas.addEventListener('pointerup', end);
    canvas.addEventListener('pointercancel', end);
  }

  start() {
    const loop = (now) => {
      requestAnimationFrame(loop);
      if (now - this.lastDraw < 33) return; // ~30 fps es suficiente
      if (!this.c.offsetParent || !this.isEnabled()) return;
      this.lastDraw = now;
      try { this.draw(now); } catch (e) { /* el visor nunca debe romper la app */ }
    };
    requestAnimationFrame(loop);
  }

  draw(now) {
    const c = this.c, ctx = this.ctx;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = Math.round(c.clientWidth * dpr), hgt = Math.round(c.clientWidth * 0.75 * dpr);
    if (c.width !== w || c.height !== hgt) { c.width = w; c.height = hgt; }
    ctx.clearRect(0, 0, w, hgt);
    const face = this.getFace();
    if (!face || !face.data) {
      ctx.fillStyle = '#52657a';
      ctx.font = `${12 * dpr}px ui-monospace, monospace`;
      ctx.textAlign = 'center';
      ctx.fillText('Sin rostro detectado', w / 2, hgt / 2);
      return;
    }
    const lm = face.data.landmarks;
    const aspect = face.aspect || 1;
    // Centrado y escala (z de MediaPipe está en la escala del ancho de imagen).
    let cx = 0, cy = 0, cz = 0;
    const n = Math.min(468, lm.length);
    for (let i = 0; i < n; i++) { cx += lm[i].x; cy += lm[i].y; cz += lm[i].z; }
    cx /= n; cy /= n; cz /= n;
    let ext = 1e-6;
    const P = new Array(lm.length);
    for (let i = 0; i < lm.length; i++) {
      const x = (lm[i].x - cx) * aspect, y = lm[i].y - cy, z = (lm[i].z - cz) * aspect;
      P[i] = [x, y, z];
      ext = Math.max(ext, Math.abs(x), Math.abs(y));
    }
    const idle = performance.now() - this.lastInteraction > 4000;
    const yaw = this.userYaw + (idle ? Math.sin(now / 1400) * 0.6 : 0);
    const pitch = this.pitch + this.userPitch;
    const cyw = Math.cos(yaw), syw = Math.sin(yaw), cp = Math.cos(pitch), sp = Math.sin(pitch);
    const scale = (Math.min(w, hgt) * 0.42) / ext;
    const S = new Array(P.length);
    for (let i = 0; i < P.length; i++) {
      const [x, y, z] = P[i];
      const x1 = x * cyw + z * syw;
      const z1 = -x * syw + z * cyw;
      const y2 = y * cp - z1 * sp;
      const z2 = y * sp + z1 * cp;
      const f = 2.4 / (2.4 + z2 / ext);
      S[i] = [w / 2 + x1 * scale * f, hgt / 2 + y2 * scale * f, z2];
    }
    const conn = this.getConnections();
    ctx.lineWidth = 0.7 * dpr;
    ctx.strokeStyle = 'rgba(34,211,238,0.35)';
    ctx.beginPath();
    for (const [a, b] of conn.tess) {
      if (!S[a] || !S[b]) continue;
      ctx.moveTo(S[a][0], S[a][1]);
      ctx.lineTo(S[b][0], S[b][1]);
    }
    ctx.stroke();
    ctx.strokeStyle = 'rgba(167,243,208,0.9)';
    ctx.lineWidth = 1.2 * dpr;
    ctx.beginPath();
    for (const [a, b] of conn.contours) {
      if (!S[a] || !S[b]) continue;
      ctx.moveTo(S[a][0], S[a][1]);
      ctx.lineTo(S[b][0], S[b][1]);
    }
    ctx.stroke();
    for (const i of [468, 473]) {
      if (!S[i]) continue;
      ctx.fillStyle = '#fde047';
      ctx.beginPath();
      ctx.arc(S[i][0], S[i][1], 2.5 * dpr, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.fillStyle = '#7f93a8';
    ctx.font = `${10.5 * dpr}px ui-monospace, monospace`;
    ctx.textAlign = 'left';
    ctx.fillText(`Rostro #${face.id} · ${lm.length} puntos`, 8 * dpr, 16 * dpr);
  }
}
