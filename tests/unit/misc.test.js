// Métricas faciales, post-proceso SSD, log/exportación y planificador.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { eyeAspectRatio, headPoseFromMatrix, FaceState, FACE_IDX } from '../../src/analytics/FaceAnalytics.js';
import { decodeSSD } from '../../src/detectors/ObjectDetector.js';
import { Scheduler, AdaptiveController } from '../../src/core/Scheduler.js';
import { Ema } from '../../src/core/Stats.js';

test('EAR: ojo abierto ≈ 0,3; cerrado ≈ 0; corrige la relación de aspecto', () => {
  const lm = new Array(478).fill(null).map(() => ({ x: 0.5, y: 0.5, z: 0 }));
  const eye = (open) => {
    const [p1, p2, p3, p4, p5, p6] = FACE_IDX.RIGHT_EYE;
    lm[p1] = { x: 0.40, y: 0.5, z: 0 }; lm[p4] = { x: 0.46, y: 0.5, z: 0 };
    lm[p2] = { x: 0.42, y: 0.5 - open, z: 0 }; lm[p3] = { x: 0.44, y: 0.5 - open, z: 0 };
    lm[p6] = { x: 0.42, y: 0.5 + open, z: 0 }; lm[p5] = { x: 0.44, y: 0.5 + open, z: 0 };
  };
  eye(0.0);
  assert.ok(eyeAspectRatio(lm, FACE_IDX.RIGHT_EYE, 1) < 0.01);
  eye(0.009);
  assert.ok(Math.abs(eyeAspectRatio(lm, FACE_IDX.RIGHT_EYE, 1) - 0.3) < 0.01);
  // En un frame 16:9, las x normalizadas valen 16/9 veces más píxeles.
  assert.ok(Math.abs(eyeAspectRatio(lm, FACE_IDX.RIGHT_EYE, 16 / 9) - 0.3 * 9 / 16) < 0.01);
});

test('orientación de cabeza desde la matriz column-major (convención verificada)', () => {
  const rotY = (deg) => { // giro alrededor del eje vertical de la cámara
    const a = (deg * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
    return [c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, 0, 0, -50, 1]; // columnas
  };
  assert.ok(Math.abs(headPoseFromMatrix({ data: rotY(20) }).yaw - 20) < 1e-6);
  assert.ok(Math.abs(headPoseFromMatrix({ data: rotY(0) }).pitch) < 1e-6);
});

test('somnolencia: ojos cerrados más de drowsySec → evento; parpadeo corto → no', () => {
  const st = new FaceState();
  const cfg = { eyeRatio: 0.6, drowsySec: 1.5 };
  const m = (ear) => ({ ear, mar: 0.1, widthRatio: 0.6, cornerLift: 0 });
  const ev = [];
  let t = 0;
  for (; t < 2; t += 1 / 30) ev.push(...st.update(m(0.3), t, cfg));
  for (const tt of [2.0, 2.05, 2.1]) ev.push(...st.update(m(0.05), tt, cfg)); // parpadeo
  for (t = 2.15; t < 3; t += 1 / 30) ev.push(...st.update(m(0.3), t, cfg));
  assert.ok(ev.some((e) => e.type === 'blink'));
  assert.ok(!ev.some((e) => e.type === 'drowsy'));
  for (t = 3; t < 5; t += 1 / 30) ev.push(...st.update(m(0.05), t, cfg));
  const d = ev.find((e) => e.type === 'drowsy');
  assert.ok(d && d.dur >= 1.5);
  assert.ok(st.perclos > 0.2);
});

test('decodeSSD: umbral, NMS por clase y etiquetas en español', () => {
  const N = 3, C = 90;
  const scores = new Float32Array(N * C);
  const boxes = new Float32Array(N * 4);
  // Ancla 0 y 1: "persona" (id 1 → columna 0) casi superpuestas; ancla 2: "silla" (id 62) solapada.
  scores[0 * C + 0] = 0.9; boxes.set([0.1, 0.1, 0.5, 0.4], 0);
  scores[1 * C + 0] = 0.8; boxes.set([0.11, 0.1, 0.5, 0.41], 4);
  scores[2 * C + 61] = 0.7; boxes.set([0.12, 0.1, 0.5, 0.4], 8);
  const out = decodeSSD(scores, boxes, N, C, 0.5, 20);
  assert.equal(out.length, 2, 'una persona (NMS) + la silla (otra clase)');
  assert.equal(out[0].label, 'persona');
  assert.equal(out[1].label, 'silla');
  assert.ok(Math.abs(out[0].bbox.x - 0.1) < 1e-6 && Math.abs(out[0].bbox.w - 0.3) < 1e-6);
  assert.equal(decodeSSD(scores, boxes, N, C, 0.95, 20).length, 0);
});

function fakeDet(id, { cadence = 1, cost = 5, priority = 0, worker = false } = {}) {
  const syncCost = new Ema(1);
  syncCost.push(cost);
  return { id, enabled: true, ready: true, inFlight: false, cadence, priority, lastRunFrame: -Infinity, lastEnd: 0, syncCost, latency: new Ema(1), isWorker: worker };
}

test('planificador: cadencia "1 de cada N", presupuesto y sin inanición', () => {
  const sch = new Scheduler();
  const pose = fakeDet('pose', { cadence: 1, cost: 12, priority: 3 });
  const hands = fakeDet('hands', { cadence: 2, cost: 12, priority: 2 });
  const objects = fakeDet('objects', { cadence: 3, cost: 6, priority: 1 });
  const runs = { pose: 0, hands: 0, objects: 0 };
  for (let f = 1; f <= 60; f++) {
    for (const d of sch.select([pose, hands, objects], f, { budgetMs: 16, multiplier: 1 })) { d.lastRunFrame = f; runs[d.id]++; }
  }
  assert.ok(runs.hands > 0 && runs.objects > 0, 'todos reciben turno');
  assert.ok(runs.pose > runs.hands && runs.hands >= runs.objects, `reparto ${JSON.stringify(runs)}`);
});

test('planificador: límite de workers simultáneos y hueco de ciclo de trabajo', () => {
  const sch = new Scheduler();
  const a = fakeDet('a', { worker: true, cost: 1 });
  const b = fakeDet('b', { worker: true, cost: 1 });
  const c = fakeDet('c', { worker: true, cost: 1 });
  a.inFlight = true;
  const sel = sch.select([a, b, c], 10, { budgetMs: 16, multiplier: 1, maxConcurrent: 2 });
  assert.equal(sel.length, 1, 'sólo cabe un worker más');
  b.latency.push(100); b.lastEnd = 1000; b.inFlight = false; a.inFlight = false;
  const sel2 = sch.select([b], 20, { budgetMs: 16, multiplier: 1, gapFactor: 1, now: 1050 });
  assert.equal(sel2.length, 0, 'aún dentro del hueco (latencia × 1)');
  assert.equal(sch.select([b], 20, { budgetMs: 16, multiplier: 1, gapFactor: 1, now: 1101 }).length, 1);
});

test('control adaptativo: degrada con FPS bajos y recupera con histéresis', () => {
  const ac = new AdaptiveController();
  const o = { enabled: true, target: 30, active: true };
  let now = 0;
  for (let i = 0; i < 10; i++) { now += 600; ac.update(now, 20, o); }
  assert.ok(ac.level >= 3, `nivel ${ac.level}`);
  assert.ok(ac.scale < 1 && ac.multiplier > 1);
  const lvl = ac.level;
  now += 600; ac.update(now, 60, o);
  assert.equal(ac.level, lvl, 'no recupera antes de 3 s');
  for (let i = 0; i < 40; i++) { now += 600; ac.update(now, 60, o); }
  assert.equal(ac.level, 0);
});
