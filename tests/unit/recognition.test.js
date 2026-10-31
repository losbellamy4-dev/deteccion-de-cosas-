// Módulo F (reconocimiento de 1000 cosas) y filtro anti-fantasmas.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { IMAGENET_ES, imagenetToCoco, CORRECTABLE } from '../../src/analytics/imagenetLabels.js';
import { reticleRoi, squareRoi, ScoreSmoother } from '../../src/analytics/Recognition.js';
import { filterDetections, threshold } from '../../src/analytics/ObjectFilter.js';
import { Tracker } from '../../src/analytics/Tracker.js';
import { plausiblePerson } from '../../src/detectors/PoseDetector.js';
import { bboxOf } from '../../src/analytics/geometry.js';

test('1000 etiquetas en español, únicas y en el orden del modelo', () => {
  assert.equal(IMAGENET_ES.length, 1000);
  assert.ok(IMAGENET_ES.every((s) => typeof s === 'string' && s.trim().length > 0));
  assert.equal(new Set(IMAGENET_ES).size, 1000, 'sin nombres repetidos');
  // Puntos de control del orden (labels_without_background.txt del modelo).
  assert.equal(IMAGENET_ES[0], 'tenca');            // tench
  assert.equal(IMAGENET_ES[207], 'golden retriever'); // golden retriever
  assert.equal(IMAGENET_ES[285], 'gato egipcio');    // Egyptian cat
  assert.equal(IMAGENET_ES[504], 'taza de café');    // coffee mug
  assert.equal(IMAGENET_ES[620], 'portátil');        // laptop
  assert.equal(IMAGENET_ES[933], 'hamburguesa con queso'); // cheeseburger
  assert.equal(IMAGENET_ES[999], 'papel higiénico'); // toilet tissue
});

test('grupos ImageNet → COCO para corregir al detector', () => {
  assert.equal(imagenetToCoco(207), 'perro');
  assert.equal(imagenetToCoco(263), 'perro');
  assert.equal(imagenetToCoco(281), 'gato');
  assert.equal(imagenetToCoco(817), 'coche');
  assert.equal(imagenetToCoco(779), 'autobús');
  assert.equal(imagenetToCoco(504), null);
  assert.ok(CORRECTABLE.has('perro') && CORRECTABLE.has('gato') && !CORRECTABLE.has('taza'));
});

test('ROI del visor y de objetos: cuadradas en píxeles y dentro de la imagen', () => {
  for (const aspect of [16 / 9, 4 / 3, 1, 9 / 16]) {
    const r = reticleRoi(aspect);
    const wPx = (r.right - r.left) * aspect, hPx = r.bottom - r.top;
    assert.ok(Math.abs(wPx - hPx) < 1e-9, `visor cuadrado (aspecto ${aspect})`);
    assert.ok(Math.abs((r.left + r.right) / 2 - 0.5) < 1e-9 && Math.abs((r.top + r.bottom) / 2 - 0.5) < 1e-9);
    // Caja estrecha pegada al borde derecho.
    const s = squareRoi({ x: 0.9, y: 0.6, w: 0.08, h: 0.35 }, aspect);
    assert.ok(s.left >= 0 && s.top >= 0 && s.right <= 1 + 1e-9 && s.bottom <= 1 + 1e-9, 'dentro de la imagen');
    assert.ok(Math.abs((s.right - s.left) * aspect - (s.bottom - s.top)) < 1e-9, 'cuadrada');
    assert.ok(s.left <= 0.9 && s.right >= 0.98 - 1e-9, 'contiene la caja');
  }
});

test('suavizado: el visor no salta por una clasificación suelta', () => {
  const sm = new ScoreSmoother({ tau: 0.6 });
  const taza = 504, vaso = 441;
  for (let i = 0; i < 10; i++) sm.update([{ i: taza, s: 0.8 }, { i: vaso, s: 0.1 }], i * 0.2);
  sm.update([{ i: vaso, s: 0.9 }], 2.0); // un fotograma dudoso
  assert.equal(sm.top(1)[0].i, taza, 'sigue siendo la taza');
  for (let i = 1; i <= 10; i++) sm.update([{ i: vaso, s: 0.9 }], 2.0 + i * 0.2);
  assert.equal(sm.top(1)[0].i, vaso, 'cambia si el cambio se mantiene');
  const w = new ScoreSmoother({ window: 3 });
  w.update([{ i: 1, s: 0.9 }], 0);
  w.update([{ i: 2, s: 0.6 }], 1);
  w.update([{ i: 2, s: 0.6 }], 2);
  assert.equal(w.top(1)[0].i, 2);
  assert.ok(Math.abs(w.top(2)[1].s - 0.3) < 1e-9, 'media de ventana');
});

const det = (label, score, bbox = { x: 0.3, y: 0.3, w: 0.2, h: 0.2 }, classId = 44) => ({ classId, label, score, bbox });

test('filtro anti-fantasmas: umbrales, tamaño, forma y duplicados', () => {
  const o = { minScore: 0.5, aspect: 16 / 9 };
  // Clase dudosa: necesita +0,1.
  assert.equal(threshold('mesa', 0.5), 0.6);
  assert.equal(threshold('mesa', 0.5, false), 0.5);
  let f = filterDetections([det('mesa', 0.55, { x: 0, y: 0.5, w: 0.5, h: 0.4 }, 67), det('botella', 0.55)], o);
  assert.deepEqual(f.strong.map((d) => d.label), ['botella']);
  assert.deepEqual(f.weak.map((d) => d.label), ['mesa'], 'la mesa dudosa sólo vale para mantener una pista');
  // Misma caja y misma confianza: la clase dudosa no tapa a la clara.
  f = filterDetections([det('mesa', 0.55, undefined, 67), det('botella', 0.55)], o);
  assert.deepEqual(f.strong.map((d) => d.label), ['botella']);
  assert.equal(f.weak.length, 0);
  // Débiles: por debajo del umbral pero por encima del suelo.
  f = filterDetections([det('botella', 0.4), det('botella', 0.2, { x: 0.7, y: 0.1, w: 0.1, h: 0.2 })], o);
  assert.equal(f.strong.length, 0);
  assert.equal(f.weak.length, 1);
  assert.equal(f.dropped, 1);
  // Diminuta.
  f = filterDetections([det('botella', 0.9, { x: 0.1, y: 0.1, w: 0.02, h: 0.02 })], o);
  assert.equal(f.strong.length, 0);
  // Pantalla completa con confianza justa → fuera; con confianza alta → vale.
  f = filterDetections([det('televisor', 0.65, { x: 0, y: 0, w: 1, h: 0.95 }, 72)], o);
  assert.equal(f.strong.length + f.weak.length, 0);
  f = filterDetections([det('gato', 0.85, { x: 0, y: 0, w: 1, h: 0.95 }, 17)], o);
  assert.equal(f.strong.length, 1);
  // Astilla.
  f = filterDetections([det('botella', 0.9, { x: 0.98, y: 0, w: 0.01, h: 0.9 })], o);
  assert.equal(f.strong.length, 0);
  // Dos clases sobre el mismo objeto: gana la más segura.
  f = filterDetections([det('perro', 0.7, undefined, 18), det('gato', 0.62, { x: 0.31, y: 0.3, w: 0.2, h: 0.2 }, 17)], o);
  assert.deepEqual(f.strong.map((d) => d.label), ['perro']);
  // Sin modo estricto: sólo umbral y tamaño.
  f = filterDetections([det('mesa', 0.55, undefined, 67), det('televisor', 0.6, { x: 0, y: 0, w: 1, h: 1 }, 72)], { ...o, strict: false });
  assert.equal(f.strong.length, 2);
});

test('tracker: confirmación en 3 detecciones, rápida si es muy clara, y doble umbral', () => {
  const b = (x) => ({ x, y: 0.3, w: 0.2, h: 0.2 });
  const tr = new Tracker({ kind: 'object', minHits: 3, fastConfirm: { hits: 2, meanScore: 0.7 } });
  // Fantasma de 2 fotogramas con confianza justa: nunca llega a tener ID.
  let r = tr.update([{ bbox: b(0.1), cls: 'bolso', score: 0.55 }], 0);
  r = tr.update([{ bbox: b(0.1), cls: 'bolso', score: 0.56 }], 0.1);
  assert.equal(r.tracks.length, 0);
  r = tr.update([], 0.2);
  r = tr.update([], 0.7);
  assert.equal(tr.tracks.length, 0, 'la tentativa desaparece');
  // Objeto claro: confirmado en 2.
  r = tr.update([{ bbox: b(0.5), cls: 'taza', score: 0.9 }], 1);
  r = tr.update([{ bbox: b(0.5), cls: 'taza', score: 0.85 }], 1.1);
  assert.equal(r.tracks.length, 1);
  const id = r.tracks[0].id;
  // Su confianza baja un rato: las detecciones débiles lo mantienen.
  for (let i = 0; i < 30; i++) r = tr.update([{ bbox: b(0.5), cls: 'taza', score: 0.35, weak: true }], 1.2 + i * 0.1);
  assert.equal(r.tracks.length, 1);
  assert.equal(r.tracks[0].id, id);
  assert.ok(r.tracks[0].seenNow);
  // Una detección débil nunca crea un objeto nuevo.
  r = tr.update([{ bbox: b(0.5), cls: 'taza', score: 0.9 }, { bbox: b(0.1), cls: 'silla', score: 0.4, weak: true }], 5);
  assert.equal(tr.tracks.length, 1);
});

test('pose: el filtro anti-fantasma acepta una persona real y rechaza un esqueleto dudoso', () => {
  const fx = JSON.parse(readFileSync(new URL('../fixtures/pose_warrior.json', import.meta.url)));
  const lm = fx.landmarks.map(([x, y, z, v]) => ({ x, y, z, visibility: v }));
  assert.ok(plausiblePerson(lm, bboxOf(lm, 0.08)), 'persona de la imagen oficial "warrior"');
  const ghost = lm.map((p, i) => ({ ...p, visibility: i < 5 ? 0.7 : 0.3 }));
  assert.ok(!plausiblePerson(ghost, bboxOf(ghost, 0.08)), 'sin tronco fiable');
});
