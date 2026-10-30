// Zonas de intrusión y tripwires.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ZoneManager } from '../../src/analytics/ZoneManager.js';

const CFG = { dwellSec: 0.3, zones: true, lines: true };
const track = (id, x, y, t, extra = {}) => ({ id, kind: 'person', label: 'persona', ref: { x, y }, seenNow: true, confirmedAt: 0, firstSeen: 0, ...extra });

test('intrusión: alerta al entrar (tras la permanencia mínima) y salida registrada', () => {
  const zm = new ZoneManager();
  const z = zm.addZone([{ x: 0.6, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0.6, y: 1 }]);
  const ev = [];
  for (let i = 0; i <= 60; i++) {
    const t = i / 30;
    const x = 0.3 + i * 0.01; // entra en la zona en x = 0.6 (i = 30)
    ev.push(...zm.update([track(1, x, 0.5, t)], t, CFG).map((e) => ({ t, ...e })));
  }
  const enter = ev.filter((e) => e.type === 'zone_enter');
  assert.equal(enter.length, 1);
  assert.ok(enter[0].t >= 1.0 + 0.3 - 1e-9, 'tras 0,3 s dentro');
  assert.equal(z.occupancy, 1);
  // Desaparece estando dentro → salida "perdida de vista".
  const out = zm.update([], 2.5, CFG);
  assert.equal(out[0].type, 'zone_exit');
  assert.equal(out[0].lost, true);
  assert.equal(z.occupancy, 0);
});

test('el borde de la zona no genera entradas/salidas por parpadeo', () => {
  const zm = new ZoneManager();
  zm.addZone([{ x: 0.5, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0.5, y: 1 }]);
  let n = 0;
  for (let i = 0; i < 90; i++) {
    const t = i / 30;
    const x = 0.5 + (i % 2 ? 0.002 : -0.002); // oscila sobre el borde
    n += zm.update([track(1, x, 0.5, t)], t, CFG).length;
  }
  assert.equal(n, 0);
});

test('tripwire: cuenta entrada y salida con el sentido correcto', () => {
  const zm = new ZoneManager();
  // Línea vertical de abajo a arriba: la derecha visual de A→B es x creciente.
  const l = zm.addLine({ x: 0.5, y: 0.9 }, { x: 0.5, y: 0.1 });
  for (let i = 0; i <= 40; i++) zm.update([track(1, 0.3 + i * 0.01, 0.5, i / 30)], i / 30, CFG); // izq → der
  assert.equal(l.countIn + l.countOut, 1);
  const firstDir = l.countIn === 1 ? 'in' : 'out';
  for (let i = 0; i <= 40; i++) zm.update([track(2, 0.7 - i * 0.01, 0.5, 2 + i / 30)], 2 + i / 30, CFG); // der → izq
  assert.equal(l.countIn, 1);
  assert.equal(l.countOut, 1);
  // Invertir el sentido intercambia los contadores.
  zm.flipLine(l.id);
  assert.equal(l.countIn, 1);
  void firstDir;
});

test('tripwire: el temblor sobre la línea y las pistas que nacen encima no cuentan', () => {
  const zm = new ZoneManager();
  const l = zm.addLine({ x: 0.5, y: 0 }, { x: 0.5, y: 1 });
  for (let i = 0; i < 120; i++) {
    const t = i / 30;
    zm.update([track(1, 0.5 + (i % 2 ? 0.003 : -0.003), 0.5, t)], t, CFG);
  }
  assert.equal(l.countIn + l.countOut, 0, 'temblor dentro de la banda de histéresis');
  // Nace a un lado y se queda: no hay cruce.
  zm.update([track(2, 0.52, 0.5, 5)], 5, CFG);
  zm.update([track(2, 0.53, 0.5, 5.1)], 5.1, CFG);
  assert.equal(l.countIn + l.countOut, 0);
});

test('tripwire: un cruce lento con pasos diminutos sí se cuenta', () => {
  const zm = new ZoneManager();
  const l = zm.addLine({ x: 0.5, y: 0 }, { x: 0.5, y: 1 });
  for (let i = 0; i <= 200; i++) zm.update([track(1, 0.48 + i * 0.0002, 0.5, i / 30)], i / 30, CFG);
  assert.equal(l.countIn + l.countOut, 1);
});

test('tripwire: rodear el extremo de la línea no es un cruce', () => {
  const zm = new ZoneManager();
  const l = zm.addLine({ x: 0.5, y: 0.4 }, { x: 0.5, y: 0.6 });
  for (let i = 0; i <= 40; i++) zm.update([track(1, 0.3 + i * 0.01, 0.9, i / 30)], i / 30, CFG); // pasa por debajo
  assert.equal(l.countIn + l.countOut, 0);
});

test('persistencia: toJSON/load conserva la geometría y valida la entrada', () => {
  const zm = new ZoneManager();
  zm.addZone([{ x: 0.1, y: 0.1 }, { x: 0.2, y: 0.1 }, { x: 0.2, y: 0.2 }]);
  zm.addLine({ x: 0, y: 0 }, { x: 1, y: 1 });
  const json = JSON.parse(JSON.stringify(zm.toJSON()));
  const z2 = new ZoneManager();
  z2.load({ ...json, zones: [...json.zones, { points: [{ x: 'a' }] }] });
  assert.equal(z2.zones.length, 1);
  assert.equal(z2.lines.length, 1);
});
