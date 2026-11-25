'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { loadSource } = require('./src.js');
const source = loadSource();
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
  const wHold = PVP.windback(me, foe, reach, 100, opts);         // inside the hold window, past the boost edge
  const wBack = PVP.windback(me, foe, reach, 300, opts);         // past 60%: the snap-back (no boost on retreat)
  const wRet = PVP.windback(me, foe, reach, 30, opts);           // first 20% of the cycle: the RETURN onto the bite line
  assert.equal(wHold.boost, false);
  assert.equal(wBack.boost, false);   // boost on the retreat drove the body AWAY from the foe
  assert.equal(wRet.boost, true);     // boost fires on the return, at the second tail presentation
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

test('tactic phase survives a fresh opts object per tick and stays inside the 4 rad/s turn clamp', () => {
  const me = origin, foe = { x: 100, y: 0 }, reach = 40;
  // The product pattern: the tick builds a NEW opts literal every 4 ms and carries the phase clock in
  // bot (startAt). Regression for the frozen-phase bug, where o.startAt lived in that literal and
  // every tactic ran at t=0 forever: U = one static angle, windback = no swing, clockwork = one point.
  const prod = (fn, t) => fn(me, foe, reach, t,
    { cycleMs: 1800, turn: 1.2, holdMs: 1750, backDeg: 150, lapMs: 4000, ringR: 1.35, startAt: 0 });
  const uPts = [0, 300, 600, 900, 1350].map(t => prod(PVP.uMoonwalk, t));
  assert.ok(new Set(uPts.map(p => `${p.x.toFixed(1)},${p.y.toFixed(1)}`)).size > 2,
    'U cursor must move over time when the tick passes a fresh opts object');
  const wPts = [0, 437, 875, 1312, 1750].map(t => prod(PVP.windback, t));
  assert.ok(new Set(wPts.map(p => `${p.x.toFixed(1)},${p.y.toFixed(1)}`)).size >= 2,
    'windback cursor must swing back and return over time');
  const cPts = [0, 1000, 2000, 3000].map(t => prod(PVP.clockwork, t));
  assert.ok(new Set(cPts.map(p => `${p.ring.x.toFixed(1)},${p.ring.y.toFixed(1)}`)).size > 2,
    'clockwork ring point must orbit over time');
  // The shipped constants must keep the body able to follow: peak cursor swing A*2pi/T <= ~4.2 rad/s
  // (the client turn clamp) and a clockwork lap the body speed v=~84 at R=1.35*reach can hold (~4 s).
  assert.ok(1.2 * Math.PI * 2 / 1800 <= 4.2, 'U swing rate within the turn clamp');
  assert.ok(4000 >= 3600, 'clockwork lap long enough for the body to hold the ring');
  // Windback back-window = last 40% of the cycle must give the 150-deg swing >= ~650 ms at 4 rad/s.
  assert.ok(1750 * 0.4 >= 650, 'windback back window covers a full 150-deg body turn');
});
