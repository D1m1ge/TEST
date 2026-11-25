'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { loadSource } = require('./src.js');
const source = loadSource();
function section(start, end) {
  const a = source.indexOf(start), b = source.indexOf(end, a);
  assert.ok(a >= 0 && b > a);
  return source.slice(a, b);
}
function rig() {
  let now = 1000, accept = true;
  const packets = [], pending = [];
  const context = vm.createContext({
    performance: { now: () => now }, Math, Map, Number,
    setTimeout: fn => (pending.push(fn), pending.length), clearTimeout: () => {},
    PVP: { wrapAngle: x => Math.atan2(Math.sin(x), Math.cos(x)), clamp: (x, a, b) => Math.max(a, Math.min(b, x)) },
    arenaOf: () => null, arenaKeepInside: (_, x, y) => ({ x, y }),
    prec: (v, max) => Math.round(v / max * 65535),
    net: M => M.Hf,
    send: (_, op) => { if (accept) packets.push(op); return accept; },
  });
  vm.runInContext(section('  const CFG = {', '  const STORE ='), context);
  vm.runInContext(section('  const bot = {', '  // display-only'), context);
  vm.runInContext(section('  function defendStep(', '  function tick()'), context);
  vm.runInContext(section('  const wheel = {', '  function say('), context);
  return {
    run: code => vm.runInContext(code, context), packets, pending,
    time: value => { now = value; }, accept: value => { accept = value; },
  };
}
function point(r, angle, now) {
  const radius = r.run('100 * CFG.whipR * (CFG.whipGuardFrac + 0.1)');
  return r.run(`whipStep(${radius * Math.cos(angle)}, ${radius * Math.sin(angle)}, {x:0,y:0}, 100, ${now}, ${angle - Math.PI / 3})`);
}
test('six evenly spaced points form one circle, in both directions', () => {
  for (const direction of [1, -1]) {
    const r = rig(); r.run(`bot.whipDir = ${direction}`);
    const count = r.run('Math.round(360 / CFG.whipStepDeg)');
    assert.equal(count, 6);
    const spacing = 2 * Math.PI / count;
    point(r, 0, 1000);
    for (let i = 1; i <= count; i++) {
      point(r, -direction * i * spacing, 1000 + i * 500);
      assert.equal(r.run('bot.whipSwitches'), i);
      assert.equal(r.run('bot.whipK'), i % count);
      assert.equal(r.run('bot.whipFlips'), 0);
    }
  }
});
test('stationary time and reverse movement do not create waypoints', () => {
  const r = rig(); point(r, 0, 1000);
  for (let t = 2000; t <= 10000; t += 1000) point(r, 0, t);
  assert.equal(r.run('bot.whipSwitches'), 0);
  point(r, 0.8, 11000); point(r, 0, 12000);
  assert.equal(r.run('bot.whipSwitches'), 0);
});
test('skipped samples preserve angular remainder and count multiple points', () => {
  const r = rig(); point(r, 0, 1000);
  point(r, -2.5, 1500);
  assert.equal(r.run('bot.whipSwitches'), 2);
  assert.ok(Math.abs(r.run('bot.whipProgress') - (2.5 - 2 * Math.PI / 3)) < 1e-9);
});
test('one hop remains eligible until confirmed, then stops until the next point', () => {
  const r = rig(); point(r, 0, 1000);
  assert.equal(point(r, 0, 1400).dart, true);
  assert.equal(point(r, 0, 1500).dart, true);
  r.run('bot.whipHopped = true');
  assert.equal(point(r, 0, 1600).dart, false);
  point(r, -Math.PI / 3, 1700);
  assert.equal(r.run('bot.whipHopped'), false);
});
function prepare(r) {
  r.run(`CFG.whip = true; CFG.ability = false;
    bot.mode = 'whip'; bot.whipReady = true; bot.whipLap = 0;
    bot.target = {}; bot.whipHopped = false;
    globalThis.M = { Hf: {}, fw: {bounds: {max: {x:1000,y:1000}}}, Ac: {resource:{value:100,max:100}} };
    globalThis.me = {spawned:true,tier:15};
    globalThis.hop = {lap:0,target:bot.target};`);
}
test('steering is sent before the hop, only once per point', () => {
  const r = rig(); prepare(r);
  r.run('steer(M, me, 100, 100, hop)');
  assert.deepEqual(r.packets, [114, 192]);
  assert.equal(r.run('bot.whipHopped'), true);
  r.time(2000); r.run('steer(M, me, 110, 100, hop)');
  assert.deepEqual(r.packets, [114, 192, 114]);
});
test('cooldown, insufficient resource and send failure allow a later retry', () => {
  for (const block of ['cooldown', 'resource', 'send']) {
    const r = rig(); prepare(r);
    if (block === 'cooldown') r.run('bot.lastDash = 900');
    if (block === 'resource') r.run('M.Ac.resource.value = 0');
    if (block === 'send') r.accept(false);
    r.run('steer(M, me, 100, 100, hop)');
    assert.equal(r.run('bot.whipHopped'), false);
    assert.equal(r.packets.includes(192), false);
    r.accept(true); r.time(2000); r.run('M.Ac.resource.value = 100; steer(M, me, 100, 100, hop)');
    assert.equal(r.run('bot.whipHopped'), true);
  }
});
test('queued steering delays the hop and a changed target cancels it', () => {
  for (const change of [false, true]) {
    const r = rig(); prepare(r); r.run('bot.lastSteer = 999; steer(M, me, 100, 100, hop)');
    assert.deepEqual(r.packets, []);
    if (change) r.run('bot.target = {}');
    r.time(1010); r.pending[0]();
    assert.deepEqual(r.packets, change ? [114] : [114, 192]);
  }
});
test('release clears pending hop and restarts waypoint state', () => {
  const r = rig(); prepare(r);
  r.run('bot.lastSteer = 999; steer(M, me, 100, 100, hop); releaseWheel()');
  assert.equal(r.run('wheel.hop'), null);
  assert.equal(r.run('bot.whipReady'), false);
  r.time(2000); r.pending[0]();
  assert.deepEqual(r.packets, []);
});
test('ring guard permits outward travel but contact and inward heading block a hop', () => {
  for (const radius of [100, 150]) {
    const r = rig();
    r.run(`whipStep(${radius}, 0, {x:0,y:0}, 100, 1000, -Math.PI / 3)`);
    assert.equal(r.run(`whipStep(${radius}, 0, {x:0,y:0}, 100, 1400, -Math.PI / 3).dart`), radius > 100);
    assert.equal(r.run(`whipStep(${radius}, 0, {x:0,y:0}, 100, 1500, Math.PI).dart`), false);
  }
});
test('protocol routing preserves every non-pointer opcode during wheel ownership', () => {
  const r = rig();
  r.run(`globalThis.window = {__M: {fw: {bounds: {max: {x:2000,y:1000}}}}};
    globalThis.forwarded = [];
    globalThis.connection = {};
    globalThis.payload = {Jb: 32767, zd: 16383};`);
  r.run(section('  const zx = {', '  // same normalisation'));
  r.run(`zx.orig = function(...args) { forwarded.push({receiver:this,args}); return 'sent'; };
    bot.holdUntil = 2000;`);
  for (let opcode = 0; opcode < 256; opcode++) {
    const before = r.run('forwarded.length');
    r.run(`wrappedZx.call(connection, ${opcode}, payload, true)`);
    assert.equal(r.run('forwarded.length') - before, opcode === 114 ? 0 : 1);
    if (opcode !== 114) {
      assert.equal(r.run('forwarded.at(-1).receiver === connection'), true);
      assert.equal(r.run('forwarded.at(-1).args[0]'), opcode);
      assert.equal(r.run('forwarded.at(-1).args[1] === payload'), true);
      assert.equal(r.run('forwarded.at(-1).args[2]'), true);
    }
  }
  assert.equal(r.run('bot.cursor.x'), 32767 / 65535 * 2000);
  assert.equal(r.run('bot.cursor.y'), 16383 / 65535 * 1000);
  r.time(2000);
  assert.equal(r.run('wrappedZx.call(connection, 114, payload, false)'), 'sent');
  assert.equal(r.run('forwarded.at(-1).args[0]'), 114);
});

test('invalid latest steering cancels the queued point, timer and hop', () => {
  for (const invalid of ['steer(M, me, NaN, 0, {lap:1,target:7})', 'M.fw.bounds.max.x = Infinity; steer(M, me, 10, 10)']) {
    const r = rig(); prepare(r);
    r.run(`bot.lastSteer=1000; steer(M, me, 200, 200, {lap:1,target:7})`);
    assert.ok(r.run('wheel.timer'));
    r.run(invalid);
    assert.equal(r.run('wheel.timer'), 0);
    assert.equal(r.run('wheel.hop'), null);
    r.time(1100);
    r.run('pumpWheel()');
    assert.equal(r.packets.length, 0);
    assert.equal(r.run('bot.holdUntil'), 0);
  }
});
