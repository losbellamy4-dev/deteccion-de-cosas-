// Postura (landmarks reales) y heurísticas temporales (secuencias sintéticas).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { poseFeatures, classifyPosture, PoseState, StillnessMeter, PL } from '../../src/analytics/PoseAnalytics.js';

const fx = JSON.parse(readFileSync(new URL('../fixtures/pose_warrior.json', import.meta.url)));
const lmReal = fx.landmarks.map(([x, y, z, v]) => ({ x, y, z, visibility: v }));
const worldReal = fx.world.map(([x, y, z]) => ({ x, y, z }));

test('imagen "warrior" de MediaPipe: de pie (zancada), torso erguido, ángulos coherentes', () => {
  for (const world of [worldReal, null]) {
    const f = poseFeatures(lmReal, world, fx.size[0] / fx.size[1], 0.5);
    assert.equal(classifyPosture(f), 'de_pie');
    assert.ok(f.torsoTilt < 10, `inclinación ${f.torsoTilt}`);
    assert.equal(f.armsUp, false);
    assert.ok(f.angles['rodilla der.'] < 120, 'rodilla adelantada flexionada');
  }
});

/**
 * Persona sintética (coordenadas normalizadas, cámara frontal). `cx,cy` es el
 * centro de la cadera; `tilt` gira el cuerpo entero alrededor de la cadera.
 */
function synthPerson({ cx = 0.5, cy = 0.55, scale = 0.18, tilt = 0, knee = 180, armsUp = false }) {
  const pts = new Array(33).fill(null).map(() => ({ x: cx, y: cy, z: 0, visibility: 0.95 }));
  const rot = (dx, dy) => {
    const a = (tilt * Math.PI) / 180;
    return { x: cx + (dx * Math.cos(a) - dy * Math.sin(a)) * scale, y: cy + (dx * Math.sin(a) + dy * Math.cos(a)) * scale };
  };
  const set = (i, dx, dy) => { pts[i] = { ...rot(dx, dy), z: 0, visibility: 0.95 }; };
  set(PL.NOSE, 0, -1.35);
  set(PL.LEFT_SHOULDER, 0.3, -1); set(PL.RIGHT_SHOULDER, -0.3, -1);
  set(PL.LEFT_HIP, 0.2, 0); set(PL.RIGHT_HIP, -0.2, 0);
  set(PL.LEFT_ELBOW, 0.4, armsUp ? -1.5 : -0.55); set(PL.RIGHT_ELBOW, -0.4, armsUp ? -1.5 : -0.55);
  set(PL.LEFT_WRIST, 0.45, armsUp ? -2 : -0.1); set(PL.RIGHT_WRIST, -0.45, armsUp ? -2 : -0.1);
  // Pierna: muslo hacia abajo; con la rodilla doblada la tibia va hacia atrás/abajo.
  const k = ((180 - knee) * Math.PI) / 180;
  for (const [hip, kn, an, side] of [[PL.LEFT_HIP, PL.LEFT_KNEE, PL.LEFT_ANKLE, 0.2], [PL.RIGHT_HIP, PL.RIGHT_KNEE, PL.RIGHT_ANKLE, -0.2]]) {
    set(kn, side, 1.0);
    set(an, side + Math.sin(k) * 0.9, 1.0 + Math.cos(k) * 0.9);
    set(an + 2, side + Math.sin(k) * 0.9, 1.05 + Math.cos(k) * 0.9); // talón
  }
  return pts;
}

const CFG = { activity: true, fall: true, immobility: true, fallSensitivity: 5, fallConfirmSec: 2, immobilitySeconds: 5, immobilitySensitivity: 5 };

test('clasificación sintética: de pie, tumbado, brazos en alto', () => {
  assert.equal(classifyPosture(poseFeatures(synthPerson({}), null, 1)), 'de_pie');
  assert.equal(classifyPosture(poseFeatures(synthPerson({ tilt: 85 }), null, 1)), 'tumbado');
  assert.equal(poseFeatures(synthPerson({ armsUp: true }), null, 1).armsUp, true);
});

/** Ejecuta una secuencia de poses a `hz` y devuelve los eventos con su instante. */
function run(seq, hz, cfg = CFG) {
  const st = new PoseState();
  const out = [];
  for (let i = 0; ; i++) {
    const t = i / hz;
    const p = seq(t);
    if (!p) break;
    for (const e of st.update(poseFeatures(p, null, 1), t, cfg)) out.push({ t, ...e });
  }
  return out;
}

// Caída: de pie 2 s, cae en 0,5 s (gira 90° y baja), tumbada 4 s.
const fall = (t) => {
  if (t > 6.5) return null;
  if (t < 2) return synthPerson({});
  const k = Math.min(1, (t - 2) / 0.5);
  return synthPerson({ tilt: 90 * k, cy: 0.55 + 0.25 * k });
};

for (const hz of [30, 10, 3]) {
  test(`caída rápida detectada y confirmada (análisis a ${hz} Hz)`, () => {
    const ev = run(fall, hz);
    const cand = ev.find((e) => e.type === 'fall_candidate');
    const conf = ev.find((e) => e.type === 'fall_confirmed');
    assert.ok(cand, 'debe haber candidata');
    assert.ok(conf, 'debe confirmarse');
    assert.ok(conf.t - cand.t >= 2 - 1e-6, 'tras el periodo de confirmación');
  });
}

test('tumbarse DESPACIO (4 s) no se considera caída', () => {
  const slow = (t) => {
    if (t > 9) return null;
    if (t < 2) return synthPerson({});
    const k = Math.min(1, (t - 2) / 4);
    return synthPerson({ tilt: 90 * k, cy: 0.55 + 0.25 * k });
  };
  assert.equal(run(slow, 15).filter((e) => e.type === 'fall_confirmed').length, 0);
});

test('caída seguida de recuperación rápida → candidata descartada, sin alerta', () => {
  const recover = (t) => {
    if (t > 6) return null;
    if (t < 2) return synthPerson({});
    if (t < 2.5) { const k = (t - 2) / 0.5; return synthPerson({ tilt: 90 * k, cy: 0.55 + 0.25 * k }); }
    if (t < 3) return synthPerson({ tilt: 90, cy: 0.8 });
    return synthPerson({});
  };
  const ev = run(recover, 15);
  assert.ok(ev.some((e) => e.type === 'fall_candidate'));
  assert.ok(ev.some((e) => e.type === 'fall_cancelled'));
  assert.equal(ev.filter((e) => e.type === 'fall_confirmed').length, 0);
});

test('postura estable: sólo se notifica tras 0,8 s y una vez', () => {
  const ev = run((t) => (t > 3 ? null : synthPerson({})), 30);
  const postures = ev.filter((e) => e.type === 'posture');
  assert.equal(postures.length, 1);
  assert.equal(postures[0].value, 'de_pie');
  assert.ok(postures[0].t >= 0.8);
});

test('caminando: desplazamiento horizontal sostenido de una persona de pie', () => {
  const walk = (t) => (t > 5 ? null : synthPerson({ cx: 0.2 + 0.12 * t }));
  const ev = run(walk, 15);
  assert.ok(ev.some((e) => e.type === 'walking' && e.value === true));
});

test('inmovilidad: alerta tras X s quieta (con temblor del modelo) y fin al moverse', () => {
  let seed = 7;
  const noise = () => { seed = (seed * 16807) % 2147483647; return (seed / 2147483647 - 0.5) * 0.004; };
  const seq = (t) => {
    if (t > 9) return null;
    const p = synthPerson({ cx: t < 7 ? 0.5 : 0.5 + (t - 7) * 0.15 });
    return p.map((q) => ({ ...q, x: q.x + noise(), y: q.y + noise() }));
  };
  const ev = run(seq, 15);
  const imm = ev.find((e) => e.type === 'immobile');
  assert.ok(imm, 'debe alertar inmovilidad');
  assert.ok(imm.t >= 5 && imm.t < 7, `instante ${imm.t}`);
  assert.ok(ev.some((e) => e.type === 'immobile_end' && e.t > 7));
});

test('StillnessMeter: el movimiento continuo nunca acumula tiempo quieto', () => {
  const m = new StillnessMeter();
  let alerts = 0;
  for (let i = 0; i < 150; i++) {
    const t = i / 15;
    const x = 0.5 + 0.1 * Math.sin(t * 2);
    alerts += m.update([{ x, y: 0.5 }, { x: x + 0.1, y: 0.6 }], 0.2, t, { seconds: 3, threshold: 0.2 }).filter((e) => e.type === 'immobile').length;
  }
  assert.equal(alerts, 0);
});
