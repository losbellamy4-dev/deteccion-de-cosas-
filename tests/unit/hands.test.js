// Gestos con landmarks REALES (MediaPipe sobre sus imágenes de prueba oficiales).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { classifyHand, StableLabel } from '../../src/analytics/HandAnalytics.js';

const fx = JSON.parse(readFileSync(new URL('../fixtures/hands.json', import.meta.url)));
const pts = (arr) => arr.map(([x, y, z]) => ({ x, y, z }));

const EXPECTED = {
  right_hands: 'open',
  left_hands: 'open',
  thumb_up: 'thumbs_up',
  fist: 'fist',
  victory: 'victory',
  pointing_up: 'point',
};

for (const [image, gesture] of Object.entries(EXPECTED)) {
  test(`gesto en ${image}.jpg → ${gesture} (fusión 2D/3D y sólo 2D)`, () => {
    const { size, hands } = fx.images[image];
    const aspect = size[0] / size[1];
    assert.ok(hands.length >= 1);
    for (const h of hands) {
      assert.equal(classifyHand(pts(h.landmarks), pts(h.world), aspect).gesture, gesture);
      assert.equal(classifyHand(pts(h.landmarks), null, aspect).gesture, gesture);
    }
  });
}

test('conteo de dedos: mano abierta = 5, puño = 0, victoria = 2, señalar = 1', () => {
  const c = (img) => {
    const { size, hands } = fx.images[img];
    return classifyHand(pts(hands[0].landmarks), pts(hands[0].world), size[0] / size[1]).count;
  };
  assert.equal(c('right_hands'), 5);
  assert.equal(c('fist'), 0);
  assert.equal(c('victory'), 2);
  assert.equal(c('pointing_up'), 1);
});

test('lateralidad de MediaPipe con imagen sin espejar: right_hands → Right, left_hands → Left', () => {
  assert.ok(fx.images.right_hands.hands.every((h) => h.handedness === 'Right'));
  assert.ok(fx.images.left_hands.hands.every((h) => h.handedness === 'Left'));
});

test('StableLabel sólo confirma un valor sostenido', () => {
  const s = new StableLabel(0.4);
  assert.equal(s.update('puño', 0), false);
  assert.equal(s.update('puño', 0.2), false);
  assert.equal(s.update('puño', 0.45), true);
  assert.equal(s.value, 'puño');
  assert.equal(s.update('pinza', 0.5), false);   // parpadeo breve…
  assert.equal(s.update('puño', 0.55), false);   // …vuelve: no cambia
  assert.equal(s.value, 'puño');
});
