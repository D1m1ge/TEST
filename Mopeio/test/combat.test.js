'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../mope-cheat.user.js'), 'utf8');
const start = source.indexOf('  const PVP = (() => {');
const end = source.indexOf('  // ------------------------------------------------------------ socket tap', start);
assert.ok(start >= 0 && end > start);
const context = vm.createContext({ Math, Number, Map });
vm.runInContext(source.slice(start, end), context);
const PVP = vm.runInContext('PVP', context);
const origin = { x: 0, y: 0 };

test('intercept predicts stationary, crossing, receding and linear equal-speed motion', () => {
  for (const [speed, target, expected] of [
    [50, { x: 100, y: 0, vx: 0, vy: 0 }, 2],
    [50, { x: 120, y: 0, vx: 0, vy: 30 }, 3],
    [50, { x: 100, y: 0, vx: 25, vy: 0 }, 4],
    [50, { x: 100, y: 0, vx: -50, vy: 0 }, 1],
  ]) {
    const time = PVP.interceptTime(origin, speed, target, 10);
    assert.ok(Math.abs(time - expected) < 1e-9);
    assert.ok(Math.abs(Math.hypot(target.x + target.vx * time, target.y + target.vy * time) - speed * time) < 1e-7);
  }
});
test('intercept caps horizon and never extrapolates unreachable or invalid data', () => {
  assert.equal(PVP.interceptTime(origin, 50, { x: 100, y: 0, vx: 25, vy: 0 }, 0.4), 0.4);
  for (const target of [
    { x: 100, y: 0, vx: 60, vy: 0 },
    { x: 100, y: 0, vx: 0, vy: 60 },
    { x: Infinity, y: 0, vx: 0, vy: 0 },
    { x: 0, y: 0, vx: 1, vy: 0 },
  ]) assert.equal(PVP.interceptTime(origin, 50, target, 2), 0);
  assert.equal(PVP.interceptTime(origin, 0, { x: 10, y: 0, vx: 1, vy: 0 }, 2), 0);
});

test('candidate limits predicted turn across angle wrap and falls back on stale snapshots', () => {
  const from = source.indexOf('  function mkCand('), to = source.indexOf('  function tick()', from);
  assert.ok(from >= 0 && to > from);
  vm.runInContext(source.slice(from, to), context);
  vm.runInContext(`
    const CFG = { leadSec: 0.25, leadCapSec: 0.5, tailFrac: 1, tierWeight: 1, cursorWeight: 1 };
    let stale = false;
    const own = { x: 0, y: 0, vx: 50, vy: 0, angle: 0 };
    const bot = { tracker: { predict(id, now, lead) {
      if (stale) return null;
      if (id === 1) return own;
      return { x: 100, y: 0, vx: 0, vy: 10, angle: lead ? -0.2 : 3.1 };
    } } };
    const me = { id: 1, tier: 12, target: { position: { x: 0, y: 0 } } };
    const enemy = { id: 2, tier: 12, target: { position: { x: 100, y: 0 }, size: { x: 20 }, angle: -3.1 } };
    let candidate = mkCand(2, enemy, me, 1000);
  `, context);
  assert.ok(Number.isFinite(vm.runInContext('candidate.score', context)));
  assert.ok(Math.abs(vm.runInContext('PVP.angleDelta(3.1, candidate.base.angle)', context)) <= Math.PI / 4 + 1e-9);
  vm.runInContext('stale = true; candidate = mkCand(2, enemy, me, 2000)', context);
  assert.equal(vm.runInContext('candidate.base.angle', context), -3.1);
  assert.equal(vm.runInContext('candidate.base.ageMs', context), null);
});

test('tactics: U loop alternates flanks, windback snaps back, clockwork orbits, boost gates', () => {
  const me = origin, foe = { x: 100, y: 0 }, reach = 40;
  const opts = { cycleMs: 900, turn: 1.9, holdMs: 420, backDeg: 150, lapMs: 620, ringR: 1.6,
    every: 2, triggerR: 2.0, gapR: 2.2 };
  const u0 = PVP.uMoonwalk(me, foe, reach, 0, opts);
  const u1 = PVP.uMoonwalk(me, foe, reach, 450, opts);           // half a cycle later: other flank
  assert.ok(u0.y !== u1.y && Math.sign(u0.y) !== Math.sign(u1.y));
  assert.ok(Math.hypot(u0.x - me.x, u0.y - me.y) >= reach - 1e-6);
  const wHold = PVP.windback(me, foe, reach, 100, opts);         // inside the hold window
  const wBack = PVP.windback(me, foe, reach, 300, opts);         // past 60%: the snap-back
  assert.equal(wHold.boost, false);
  assert.equal(wBack.boost, true);
  assert.ok(Math.abs(wBack.y) > Math.abs(wHold.y));
  const c0 = PVP.clockwork(me, foe, reach, 0, opts);
  const c1 = PVP.clockwork(me, foe, reach, 155, opts);           // quarter lap later
  assert.ok(Math.abs(Math.hypot(c0.ring.x - foe.x, c0.ring.y - foe.y) - reach * 1.6) < 1e-6);
  assert.ok(Math.abs(Math.hypot(c1.ring.x - foe.x, c1.ring.y - foe.y) - reach * 1.6) < 1e-6);
  const near = PVP.defensiveBoost(me, { x: 70, y: 0 }, reach, 0, opts, 5);   // committed nose + closing
  const far = PVP.defensiveBoost(me, foe, reach, 0, opts, 5);
  assert.equal(near.boost, true);
  assert.equal(far.boost, false);
  const s0 = PVP.switchsideMoonwalk(me, foe, reach, 0, opts);
  const s1 = PVP.switchsideMoonwalk(me, foe, reach, 2 * opts.holdMs, opts);  // after `every` cycles
  assert.ok(Math.sign(s0.y) !== Math.sign(s1.y));
  const b = PVP.bait(me, foe, reach, 0, opts);
  assert.ok(Math.hypot(b.x - foe.x, b.y - foe.y) <= reach * opts.gapR + reach + 1e-6);
});
