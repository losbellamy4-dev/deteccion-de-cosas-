// Tracker (IoU + centroide + húngaro) e IDs estables.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Tracker, IdGenerator } from '../../src/analytics/Tracker.js';
import { hungarian } from '../../src/analytics/hungarian.js';

test('húngaro: asignación óptima frente a la voraz', () => {
  // La voraz tomaría (0,0)=1 y dejaría (1,1)=10 → total 11; la óptima es 2+3 = 5.
  assert.deepEqual(hungarian([[1, 2], [3, 10]]), [1, 0]);
  assert.deepEqual(hungarian([[4, 1, 3], [2, 0, 5], [3, 2, 2]]), [1, 0, 2]);
  // Rectangular: más filas que columnas.
  const r = hungarian([[1], [0], [5]]);
  assert.equal(r.filter((j) => j === 0).length, 1);
  assert.equal(r[1], 0);
  assert.deepEqual(hungarian([]), []);
});

const box = (x, y, w = 0.1, h = 0.3) => ({ x, y, w, h });

test('IDs estables con movimiento normal y confirmación tras minHits', () => {
  const tr = new Tracker({ kind: 'person', minHits: 2 });
  let r = tr.update([{ bbox: box(0.1, 0.3) }], 0);
  assert.equal(r.tracks.length, 0, 'tentativa: aún sin ID visible');
  r = tr.update([{ bbox: box(0.11, 0.3) }], 0.033);
  assert.equal(r.tracks.length, 1);
  assert.equal(r.created.length, 1);
  const id = r.tracks[0].id;
  for (let i = 2; i < 90; i++) r = tr.update([{ bbox: box(0.1 + i * 0.005, 0.3) }], i / 30);
  assert.equal(r.tracks.length, 1);
  assert.equal(r.tracks[0].id, id);
  assert.ok(r.tracks[0].vx > 0.1, 'velocidad estimada hacia la derecha');
});

test('dos personas que se cruzan conservan su ID (orden de detecciones cambiante)', () => {
  const tr = new Tracker({ kind: 'person', minHits: 1 });
  let a = null, b = null;
  for (let i = 0; i <= 60; i++) {
    const t = i / 30;
    const xa = 0.1 + i * 0.012, xb = 0.85 - i * 0.012;
    const dets = [{ bbox: box(xa, 0.3) }, { bbox: box(xb, 0.32) }];
    if (i % 2) dets.reverse(); // MediaPipe no garantiza el orden
    const r = tr.update(dets, t);
    const left = r.tracks.find((x) => x.vx > 0) || r.tracks[0];
    if (i === 5) { a = r.tracks.find((x) => x.bbox.x < 0.5).id; b = r.tracks.find((x) => x.bbox.x > 0.5).id; }
    if (i === 60) {
      assert.equal(r.tracks.length, 2);
      assert.equal(r.tracks.find((x) => x.bbox.x > 0.5).id, a, 'A terminó a la derecha');
      assert.equal(r.tracks.find((x) => x.bbox.x < 0.5).id, b, 'B terminó a la izquierda');
    }
    void left;
  }
});

test('oclusión breve: la pista sobrevive maxAge y recupera su ID (análisis a 30 Hz)', () => {
  const tr = new Tracker({ kind: 'person', minHits: 1, maxAge: 1.2 });
  let id = null, r;
  for (let i = 0; i <= 120; i++) {
    const t = i / 30;
    const visible = t < 1 || (t >= 1.8 && t < 2);   // oculta 0,8 s y luego desaparece
    r = tr.update(visible ? [{ bbox: box(0.4 + t * 0.01, 0.3) }] : [], t);
    if (i === 0) id = r.tracks[0].id;
    if (t >= 1.8 && t < 2) assert.equal(r.tracks[0].id, id, 'mismo ID tras la oclusión');
  }
  assert.equal(r.tracks.length, 0, 'eliminada tras más de maxAge sin verse');
});

test('no empareja clases distintas y comparte numeración entre trackers', () => {
  const ids = new IdGenerator();
  const p = new Tracker({ kind: 'person', idGen: ids, minHits: 1, classAware: false });
  const o = new Tracker({ kind: 'object', idGen: ids, minHits: 1 });
  const rp = p.update([{ bbox: box(0.1, 0.1) }], 0);
  const ro = o.update([{ bbox: box(0.5, 0.5), cls: 'silla' }], 0);
  assert.notEqual(rp.tracks[0].id, ro.tracks[0].id);
  const r2 = o.update([{ bbox: box(0.5, 0.5), cls: 'perro' }], 0.1);
  assert.equal(r2.created.length, 1, 'la clase distinta crea otra pista');
});

test('historial del punto de referencia (estelas) acotado en el tiempo', () => {
  const tr = new Tracker({ kind: 'object', minHits: 1, historySeconds: 2 });
  for (let i = 0; i < 200; i++) tr.update([{ bbox: box(0.1 + i * 0.002, 0.4), cls: 'x' }], i / 30);
  const h = tr.confirmed[0].history;
  assert.ok(h[h.length - 1].t - h[0].t <= 2 + 1e-9);
});

test('análisis muy degradado (0,5 Hz): las pistas tentativas llegan a confirmarse', () => {
  const tr = new Tracker({ kind: 'object', minHits: 2 });
  let r;
  for (let i = 0; i < 6; i++) r = tr.update([{ bbox: box(0.3 + i * 0.01, 0.4), cls: 'gato' }], i * 2);
  assert.equal(r.tracks.length, 1);
  assert.equal(r.tracks[0].hits, 6);
});
