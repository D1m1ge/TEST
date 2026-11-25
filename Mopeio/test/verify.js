// Comprehensive, deterministic verification of EVERY userscript feature against the local harness
// (nothing here touches mope.io). Spawns headless Edge, injects the userscript at document-start,
// loads harness.html, then drives every PvP/Evade/ESP/Radar/Diamond/Skin scenario under the virtual
// clock and checks the panel buttons + F1-F5/Insert hotkeys. Prints a PASS/FAIL table + raw JSON.
'use strict';
const fs = require('fs'), path = require('path'), http = require('http'), { spawn } = require('child_process');

const STATIC = Number(process.env.VERIFY_PORT) || 0;   // 0 = ephemeral: no leftover server can collide
const ROOT = path.join(__dirname, '..');
const PROFILE = path.join(process.env.TEMP || '/tmp', 'mope-cdp-verify-' + process.pid);
const EDGE = process.env.EDGE_PATH || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const SCRIPT = fs.readFileSync(path.join(ROOT, 'mope-cheat.user.js'), 'utf8');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png' };

const getJson = u => new Promise((res, rej) => http.get(u, r => { let d = ''; r.on('data', c => d += c); r.on('end', () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } }); }).on('error', rej));
const sleep = ms => new Promise(r => setTimeout(r, ms));
// a devtools socket that never opens must fail loudly -- otherwise the whole run hangs with no output
const openSock = ws => new Promise((res, rej) => { const s = new WebSocket(ws); const to = setTimeout(() => { try { s.close(); } catch (_) {} rej(new Error('devtools ws timeout')); }, 20000); s.onopen = () => { clearTimeout(to); res(s); }; s.onerror = () => { clearTimeout(to); rej(new Error('ws')); }; });
class CDP {
  constructor(ws) { this.ws = ws; this.n = 0; this.p = new Map(); ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id != null && this.p.has(m.id)) { const { r, j, to } = this.p.get(m.id); this.p.delete(m.id); clearTimeout(to); m.error ? j(new Error(JSON.stringify(m.error))) : r(m.result); } }; }
  send(method, params = {}, sid) { return new Promise((r, j) => { const id = ++this.n; const to = setTimeout(() => { this.p.delete(id); j(new Error('CDP timeout: ' + method)); }, 90000); this.p.set(id, { r, j, to }); const msg = { id, method, params }; if (sid) msg.sessionId = sid; this.ws.send(JSON.stringify(msg)); }); }
}

// ---------- the four probe programs (run inside the page) ----------
const SCEN = `(() => {
  const slim = r => !r ? null : r.err ? { err: r.err } : {
    mode: r.mode, modes: r.modeHist, bot114: r.bot114, client114: r.client114, boosts: r.boosts,
    rate: r.rate, wheelErr: r.wheelErr, wheelLate: r.wheelLate, wheelReplaced: r.wheelReplaced,
    wheelMaxReplaced: r.wheelMaxReplaced, wheelPending: r.wheelPending,
    bites: r.bites, deaths: r.deaths, focusMin: r.focusMin, aimMaxDeg: r.aimMaxDeg, aimAvgDeg: r.aimAvgDeg,
    aimWorstDeg: r.aimWorstDeg, shakeFlips: r.shakeFlips, perpFlips: r.perpFlips,
    endAimDeg: r.endAimDeg, jinkWagAmp: r.jinkWagAmp, turnMs: r.turnMs,
    wantId: r.wantId, targetId: r.targetId, cursor: r.cursor,
    topTargetId: r.topTargetId, tgtHist: r.tgtHist, pickId: r.pick && r.pick.id, pickKind: r.pick && r.pick.kind,
    pickArmed: r.pick && r.pick.armed, pickMsg: r.pick && r.pick.msg, click: r.click, miss: r.miss,
    whip: r.whip, zone: r.zone, zoneWorst: r.zoneWorst, zoneLim: r.zoneLim,
    zoneSelf: r.zoneSelf, zoneGap: r.zoneGap, bodyOutMax: r.bodyOutMax, bodyOutTicks: r.bodyOutTicks,
    zoneOver: r.zoneOver, zoneTailOver: r.zoneTailOver, zoneRseq: r.zoneRseq, ringR: r.ringR, ringD: r.ringD,
    whipAimAvgDeg: r.whipAimAvgDeg, whipAimWorstDeg: r.whipAimWorstDeg, whipTicks: r.whipTicks, whipRange: r.whipRange,
    contact: r.contact, whipPenMax: r.whipPenMax, penMax: r.penMax, whipJamTicks: r.whipJamTicks,
    whipPenSelf: r.whipPenSelf, whipPenFoe: r.whipPenFoe, whipJamSelf: r.whipJamSelf, whipJamFoe: r.whipJamFoe,
    jamTicks: r.jamTicks, jamPct: r.jamPct, whipSweepDeg: r.whipSweepDeg, whipSweepAbs: r.whipSweepAbs,
    whipSweepRate: r.whipSweepRate, whipFacePct: r.whipFacePct, whipSnapPct: r.whipSnapPct, hopStride: r.hopStride,
    rearTicks: r.rearTicks, rearPct: r.rearPct, snapTicks: r.snapTicks, snapRuns: r.snapRuns, snapAvgMs: r.snapAvgMs, snapWorstMs: r.snapWorstMs,
    faceRuns: r.faceRuns, faceAvgMs: r.faceAvgMs, faceWorstMs: r.faceWorstMs, nearD: r.nearD,
    swingDegS: r.swingDegS, swingMaxDeg: r.swingMaxDeg, swingHz: r.swingHz, turnDegS: r.turnDegS,
    twerkTicks: r.twerkTicks, defTicks: r.defTicks, whipLaps: r.whipLaps,
    baitTicks: r.baitTicks, baitAimAvgDeg: r.baitAimAvgDeg, baitRange: r.baitRange, dashdefTicks: r.dashdefTicks, focusEnd: r.focusEnd,
    diagTicks: r.diagTicks, diagBlocked: r.diagBlocked, diagBlockedWhileRear: r.diagBlockedWhileRear, diagClearBehind: r.diagClearBehind,
    diagLungeBlocked: r.diagLungeBlocked, firstLungeIx: r.firstLungeIx, firstBlockedIx: r.firstBlockedIx,
    perpAbs: r.perpAbs, op217: r.op217, self: r.selfSubspecies, tracked: r.tracked,
    errs: (r.errors || []).length, err0: (r.errors || [])[0] || null };
  // The third argument overrides CFG for that one run on top of the scenario's own tune: one knob, one
  // difference, no forked scenario table. Every shipped scenario passes undefined here.
  const run = (n, ms, ex) => { try { return H.step(n, ms, ex); } catch (e) { return { err: String((e && e.message) || e) }; } };
  const motionSnap = () => { try { return { diag: window.__MOPE_DIAG ? window.__MOPE_DIAG() : null, motion: window.__MOPE_MOTION ? window.__MOPE_MOTION(H.focus) : null }; } catch (e) { return { err: String((e && e.message) || e) }; } };
  const R = {};
  R.boot = { hooked: !!window.__HOOKED, M: !!window.__M, realm: H.realmCapturedPatched };
  R.S0_manual = slim(run('S0_manual', 1200));
  R.S1_bite_still = slim(run('S1_bite_still', 3000)); R.motionStill = motionSnap();
  R.S2_bite_moving = slim(run('S2_bite_moving', 5500)); R.motionMoving = motionSnap();
  R.S3_guard = slim(run('S3_guard', 1500));
  R.S4_evade_on = slim(run('S4_evade_on', 4000));
  R.S4_evade_off = slim(run('S4_evade_off', 4000));
  const p5 = run('S5_purge', 1500); R.S5_purge = slim(p5); if (R.S5_purge) R.S5_purge.focus = H.focus;
  R.S6_esp = (() => {
    const x = run('S6_esp', 1500); try { window.__MOPE_DRAW(); } catch (e) {}
    const fp = H.focusPos(); const near = fp ? H.sample(fp.x, fp.y) : -9;
    let rp = 0; const ov = document.getElementById('mopeCheatOverlay');
    if (ov) { const dpr = devicePixelRatio || 1, W = ov.width / dpr, Hh = ov.height / dpr, Rc = 110;
      const sx = Math.round((W - Rc - 18) * dpr), sy = Math.round((Hh - Rc - 18) * dpr), rad = Math.round(Rc * dpr);
      const id = ov.getContext('2d').getImageData(Math.max(0, sx - rad), Math.max(0, sy - rad), rad * 2, rad * 2).data;
      for (let i = 3; i < id.length; i += 4) if (id[i]) rp++; }
    return Object.assign(slim(x), { espPixels: near, radarPixels: rp });
  })();
  R.S7_idle = slim(run('S7_idle_on', 1500));
  R.S8_diamond = slim(run('S8_diamond', 1200));
  R.S9_face = slim(run('S9_face', 2000));
  R.S10_fast = slim(run('S10_fast', 2000));
  R.S11_lunge = slim(run('S11_lunge', 1200));
  try { R.S11_diag = window.__MOPE_DIAG ? window.__MOPE_DIAG() : null; } catch (e) { R.S11_diag = null; }
  // same geometry, nose to nose: the dart must be REFUSED (this gate was dead in both directions before)
  R.S17_headon = slim(run('S17_no_headon', 1500));
  try { R.S17_diag = window.__MOPE_DIAG ? window.__MOPE_DIAG() : null; } catch (e) { R.S17_diag = null; }
  R.S12_ability = slim(run('S12_ability', 1500));
  // the combat overlay has to be visible even with ESP off (the user must SEE what got locked)
  const mark = name => {
    const x = run(name, 900);
    try { window.__MOPE_DRAW(); } catch (e) {}
    const fp = H.focusPos();
    const cu = typeof window.__MOPE_CURSOR === 'function' ? window.__MOPE_CURSOR() : null;
    return Object.assign(slim(x), { markPx: fp ? H.sample(fp.x, fp.y) : -9, curPx: cu ? H.sample(cu.x, cu.y) : -9 });
  };
  R.S18_mark = mark('S18_mark');
  R.S19_blind = mark('S19_blind');
  // target selection: what the lock actually picked vs what the scenario intends
  R.S13_tier = slim(run('S13_tier', 1500));
  R.S14_cursor = slim(run('S14_cursor', 1500));
  R.S15_tier_ctl = slim(run('S15_tier_ctl', 1500));
  R.S16_cursor_ctl = slim(run('S16_cursor_ctl', 1500));
  // --- the challenge arena (game data) and click-to-target: the "in an arena it fights bystanders" complaint
  R.S20_duel_far = slim(run('S20_duel_far_on', 2000));
  R.S21_duel_off = slim(run('S21_duel_far_off', 2000));
  R.S22_fence = slim(run('S22_fence_pair', 1500));
  R.S23_fence_ctl = slim(run('S23_fence_ctl', 1500));
  R.S24_pick = slim(run('S24_pick_far', 2000));
  R.S25_pick_dead = slim(run('S25_pick_dead', 2000));
  R.S26_pick_big = slim(run('S26_pick_big', 900));
  R.S27_pick_miss = slim(run('S27_pick_miss', 1200));
  R.S28_retaliate = slim(run('S28_retaliate', 1500));
  R.S29_retaliate_ctl = slim(run('S29_retaliate_off', 1500));
  R.S30_pick_duel = slim(run('S30_pick_vs_duel', 1500));
  // --- v4: hexagon footwork, kiting defence, incoming-dash defence, duel-ring discipline
  R.S13_whip = slim(run('S13_whip', 6000));
  // SHARPNESS A/B: the identical world with the square-wave switch thrown back to the eased cosine. Every
  // other knob stays at the shipped value, so the only difference in these two rows is edge shape.
  // A/B for "без плавности, быстро, резко": the SAME scenario with the wave as it was before the sharpening
  // (cosine dive, sine wag, cycle 520, leash 34, no beats). One knob-group difference, same physics, same foe.
  R.S13_whip_soft = slim(run('S13_whip', 6000, { whipSnap: false, whipTwerkEvery: 0, whipDefEvery: 0,
    whipCycleMs: 520, whipLeadDeg: 34, whipFaceFrac: 0.5 }));
  R.S14_bait = slim(run('S14_bait', 3000));
  R.S14_bait_ctl = slim(run('S14_bait_ctl', 3000));
  R.S35_afk = slim(run('S35_afk', 5000));
  R.S35_afk_ctl = slim(run('S35_afk_ctl', 5000));
  R.S36_snap = slim(run('S36_snap', 5000));
  R.S36_snap_ctl = slim(run('S36_snap_ctl', 5000));
  R.S37_snap_near = slim(run('S37_snap_near', 4000));
  R.S37_snap_near_ctl = slim(run('S37_snap_near_ctl', 4000));
  R.MEASURE = [R.S13_whip, R.S13_whip_soft, R.S35_afk, R.S35_afk_ctl, R.S36_snap, R.S36_snap_ctl, R.S37_snap_near, R.S37_snap_near_ctl, R.S14_bait].map(r => r && ({
    modes: r.modes, aimAvg: r.aimAvgDeg, aimWorst: r.aimWorstDeg, rear: r.rearTicks, rearPct: r.rearPct,
    snapT: r.snapTicks, runs: r.snapRuns, snapAvg: r.snapAvgMs, snapWorst: r.snapWorstMs,
    face: r.faceAvgMs, faceWorst: r.faceWorstMs, faceN: r.faceRuns, gate: r.nearD, bites: r.bites, boosts: r.boosts,
    min: r.focusMin, pen: r.penMax, jam: r.jamTicks, deaths: r.deaths, errs: r.errs,
    ringPen: r.whipPenMax, ringJam: r.whipJamTicks, selfPen: r.whipPenSelf, foePen: r.whipPenFoe, gross: r.whipSweepAbs, sw: r.whip && r.whip.switches,
    faceP: r.whipFacePct, rng: r.whipRange && r.whipRange.avg, hopN: r.hopStride && r.hopStride.n,
    swp: r.swingDegS, swpMax: r.swingMaxDeg, hz: r.swingHz, turn: r.turnDegS,
    twk: r.twerkTicks, df: r.defTicks, laps: r.whipLaps }));
  // TEMPORARY knob sweep, driven by the SWEEPS env var; deleted before delivery. Three reps per row
  // because the orbit reversal uses Math.random(): one run cannot tell a bad knob from a lucky flip.
${process.env.SWEEPS ? 'R.SWEEPS = JSON.parse(' + JSON.stringify(process.env.SWEEPS) + ').map(o => {const A = []; for (let k = 0; k < (o.reps || 3); k++) { const x = run(o.s || "S13_whip", o.ms || 6000, o.ex || {});if (x && x.err) return { tag: o.tag, err: x.err }; A.push(x); }const w = f => A.map(f).filter(v => v != null), mx = f => Math.max.apply(null, w(f)), mn = f => Math.min.apply(null, w(f));const av = f => { const q = w(f); return q.length ? Math.round(q.reduce((a, b) => a + b, 0) / q.length) : null; };return { tag: o.tag, pen: mx(x => x.whipPenMax), jam: mx(x => x.whipJamTicks), gross: mn(x => x.whipSweepAbs),sw: mn(x => x.whip && x.whip.switches), faceP: mn(x => x.whipFacePct), rngMax: mx(x => x.whipRange && x.whipRange.avg),hopMin: mn(x => x.hopStride && x.hopStride.avg), hopN: mx(x => x.hopStride && x.hopStride.n),aim: av(x => x.whipAimAvgDeg), swp: av(x => x.swingDegS), swpMax: av(x => x.swingMaxDeg),hz: av(x => x.swingHz), turn: av(x => x.turnDegS), twk: av(x => x.twerkTicks), df: av(x => x.defTicks),bo: av(x => x.boosts), lp: av(x => x.whipLaps),psAll: w(x => x.whipPenSelf).join(","), gAll: w(x => x.whipSweepAbs).join(","), ps: mx(x => x.whipPenSelf), pf: mx(x => x.whipPenFoe), js: mx(x => x.whipJamSelf), jf: mx(x => x.whipJamFoe),fa: mx(x => x.faceAvgMs), faMin: mn(x => x.faceAvgMs), fw: mx(x => x.faceWorstMs), fN: mn(x => x.faceRuns), st: mx(x => x.snapTicks),pm: mx(x => x.penMax), jm: mx(x => x.jamTicks), bites: mn(x => x.bites),deaths: mx(x => x.deaths), errs: mx(x => x.errs) };});' : ''}
  R.S15_dash = slim(run('S15_dash', 3000));
  R.S15_dash_dodge = slim(run('S15_dash_dodge', 3000));
  R.S31_zone = slim(run('S31_zone_hold', 2500));
  R.S32_zone_off = slim(run('S32_zone_off', 2500));
  // the ring shrinks mid-fight, and the ring data can live on the networked twin instead of the entity
  R.S33_shrink = slim(run('S33_zone_shrink', 3000));
  R.S34_ring_tgt = slim(run('S34_zone_target', 2500));
  // the pick trigger exactly the way a player uses it: no arming, a short tap, a right button, and a
  // press that must NOT pick because a hold is the game's own boost
  R.S40_tap = slim(run('S40_pick_tap', 1500));
  R.S41_rmb = slim(run('S41_pick_rmb', 1500));
  R.S42_drag = slim(run('S42_hold_drag', 1200));
  R.S43_press = slim(run('S43_press_only', 1200));
  R.S45_tap_duel = slim(run('S45_tap_over_duel', 1500));
  // --- the cursor tempo itself, measured off the wire for every rate the client's uA() can return
  R.S50_rate_arena = slim(run('S50_rate_arena', 2000));
  R.S51_rate_mid = slim(run('S51_rate_mid', 2000));
  R.S52_rate_low = slim(run('S52_rate_low', 2000));
  return R;
})()`;

const SKIN = `(() => {
  const si = document.querySelector('#mopeCheatPanel input[type=number]');
  si.value = '3'; si.dispatchEvent(new Event('change'));
  const r = H.step('S1_bite_still', 1200);
  if (window.__MOPE_REFRESH_SKINS) window.__MOPE_REFRESH_SKINS();
  const sel = document.querySelector('#mopeCheatPanel select');
  return { self: r.selfSubspecies, initCalls: r.initCalls, optCount: sel ? sel.options.length : 0,
    opts: sel ? [...sel.options].map(o => o.value + ':' + o.text) : null,
    disabled: sel ? !!sel.disabled : null, errs: (r.errors || []).length,
    cfg: window.__MOPE_SKIN };
})()`;

const MENU = `(() => {
  const disp = () => { const p = document.getElementById('mopeCheatPanel'), o = document.getElementById('mopeCheatOpen');
    return { panel: getComputedStyle(p).display, open: getComputedStyle(o).display }; };
  const before = disp();
  document.querySelector('#mopeCheatClose').click(); const hidden = disp();
  document.getElementById('mopeCheatOpen').click(); const shown = disp();
  return { before, hidden, shown };
})()`;

const KEYS = `(() => {
  // rows are data, not indices: resolve every switch through its own key chip so a reordered menu
  // cannot make this test press F3 and measure some other row. The key codes themselves are read
  // from the live bind map (__MOPE_BINDS), so a changed default can never fake a pass.
  const box = a => { const c = document.querySelector('#mopeCheatPanel button[data-bind="' + a + '"]');
    return c && c.parentElement.querySelector('input[type=checkbox]'); };
  const press = c => window.dispatchEvent(new KeyboardEvent('keydown', { code: c, bubbles: true }));
  const binds = window.__MOPE_BINDS();
  const rows = ['pvp', 'dodge', 'esp', 'radar', 'labels', 'ability', 'whip'];
  const toggles = {}, unbound = [];
  for (const a of rows) {
    const code = binds[a];
    if (!code) { unbound.push(a); toggles[a] = 'unbound'; continue; }
    const b = box(a); if (!b) { toggles[a] = false; continue; }
    const before = b.checked; press(code); toggles[a] = b.checked !== before; press(code);
  }
  const pd = () => getComputedStyle(document.getElementById('mopeCheatPanel')).display;
  const i0 = pd(); press(binds.menu); const i1 = pd(); press(binds.menu);
  const ps = () => window.__MOPE_PICKSTATE();
  const arm0 = ps(); press(binds.pick); const arm1 = ps();
  window.__MOPE_CLEAR_PICK(); const arm2 = ps();
  return { count: document.querySelectorAll('#mopeCheatPanel input[type=checkbox]').length,
    binds, toggles, unbound,
    insert: { i0, i1, changed: i0 !== i1 },
    pick: { before: arm0.armed, armedByF6: arm1.armed, idByF6: arm1.id, cleared: !arm2.armed && arm2.id === null } };
})()`;

// the panel itself: one PvP switch, translucent, and small enough to leave the arena visible
const PANEL = `(() => {
  const show = () => { const p = document.getElementById('mopeCheatPanel');
    if (getComputedStyle(p).display === 'none') document.getElementById('mopeCheatOpen').click(); return p; };
  const p = show();
  const rows = [...p.querySelectorAll('input[type=checkbox]')].map(cb => {
    const row = cb.parentElement;
    return { label: row.querySelector('span').textContent, chip: (row.querySelector('button[data-bind]') || {}).textContent,
      desc: (row.querySelector('span') || {}).title || '' };
  });
  const bg = getComputedStyle(p).backgroundColor;
  const alpha = +((bg.match(/rgba?\\(([^)]*)\\)/) || [0, '0,0,0,1'])[1].split(',')[3]);
  const desc = document.getElementById('mopeCheatDesc');
  const idle = desc.textContent;
  const r0 = p.querySelector('input[type=checkbox]').parentElement;
  r0.dispatchEvent(new MouseEvent('mouseenter'));
  const hovered = desc.textContent;
  r0.dispatchEvent(new MouseEvent('mouseleave'));
  const rect = p.getBoundingClientRect();
  const pickBtn = document.getElementById('mopeCheatPick');
  const pickChip = p.querySelector('button[data-bind="pick"]');
  return { rows, bg, alpha, idle, hovered,
    pick: pickBtn && pickChip ? { label: pickBtn.textContent, chip: pickChip.textContent } : null, w: Math.round(rect.width), h: Math.round(rect.height),
    vw: innerWidth, vh: innerHeight, cover: +(rect.width * rect.height / (innerWidth * innerHeight)).toFixed(3),
    blur: getComputedStyle(p).backdropFilter || getComputedStyle(p).webkitBackdropFilter };
})()`;

// the pick button itself: arming label, the menu-click guard, a real field click, ×, and a miss
const PICKUI = `(() => {
  const ps = () => window.__MOPE_PICKSTATE();
  const btn = document.getElementById('mopeCheatPick');
  const clr = document.getElementById('mopeCheatClearTarget');
  const panel = document.getElementById('mopeCheatPanel');
  const disp = el => getComputedStyle(el).display;
  const r = { start: ps() };
  // earlier programs toggle keys; this one needs PvP on so the world has a target to click
  window.__MOPE_CFG({ pvp: true, autoDuel: true, retaliate: true });   // earlier programs toggle keys; this one needs PvP on
  H.step('S1_bite_still', 100);                     // a known world: one equal-tier animal 600 east
  r.label0 = btn.textContent; r.clear0 = disp(clr);
  btn.click();
  r.armedByButton = ps().armed; r.labelArmed = btn.textContent;
  panel.dispatchEvent(new MouseEvent('mousedown', { button: 0, bubbles: true }));
  r.afterMenuClick = { armed: ps().armed, id: ps().id };
  // clicking the menu CANCELS the pending click, so arm it again for the field test below
  btn.click();
  const fp = H.focusPos(), sp = H.toScreen(fp.x, fp.y);
  r.point = sp;
  H.clickXY(sp.x, sp.y);
  r.afterFieldClick = ps(); r.clearAfterPick = disp(clr);
  clr.click();
  r.afterClear = ps(); r.clearAfterClear = disp(clr);
  H.armPick(); H.clickXY(15, 780);
  r.afterMiss = ps();
  // the point of the whole rework: a bare tap, with nothing armed, picks
  window.__MOPE_CLEAR_PICK();
  const tp = H.toScreen(H.focusPos().x, H.focusPos().y);
  H.clickXY(tp.x, tp.y);
  r.tapNoArm = ps(); r.tapPoint = tp;
  window.__MOPE_CLEAR_PICK();
  return r;
})()`;

// remappable binds: click a chip, press a key, that key (not the old one) now drives that switch
const BINDS = `(() => {
  const panel = document.getElementById('mopeCheatPanel');
  if (getComputedStyle(panel).display === 'none') document.getElementById('mopeCheatOpen').click();
  const box = a => document.querySelector('#mopeCheatPanel button[data-bind="' + a + '"]').parentElement.querySelector('input[type=checkbox]');
  const chip = a => document.querySelector('#mopeCheatPanel button[data-bind="' + a + '"]');
  const press = c => window.dispatchEvent(new KeyboardEvent('keydown', { code: c, bubbles: true }));
  const flip = (c, a) => { const b = box(a).checked; press(c); return box(a).checked !== b; };
  const out = { labels: [...document.querySelectorAll('#mopeCheatPanel button[data-bind]')].map(b => b.dataset.bind + '=' + b.textContent) };
  // 1) ESP moves from F3 to J; F3 must go dead, J must work, chip must repaint
  chip('esp').click();
  out.arming = chip('esp').textContent;
  press('KeyJ');
  out.espLabel = chip('esp').textContent;
  out.oldKeyDead = !flip('F3', 'esp');
  out.newKeyWorks = flip('KeyJ', 'esp');
  flip('KeyJ', 'esp');                                   // leave ESP as it was
  // 2) RADAR steals J -> ESP releases it, so one key never drives two switches
  chip('radar').click(); press('KeyJ');
  out.stolen = flip('KeyJ', 'radar');
  out.espReleased = !flip('KeyJ', 'esp');
  out.espLabelAfterSteal = chip('esp').textContent;
  // 3) Escape cancels the capture and keeps the old bind
  const before = chip('dodge').textContent;
  chip('dodge').click(); press('Escape');
  out.escapeLabel = chip('dodge').textContent;
  out.escapeKeptOld = flip('F2', 'dodge');
  flip('F2', 'dodge');                                   // restore DODGE
  // 4) a row that shipped without a key (ability) can be bound and keeps the same chip contract
  chip('ability').click(); press('KeyK');
  out.abilityLabel = chip('ability').textContent;
  out.abilityWorks = flip('KeyK', 'ability');
  flip('KeyK', 'ability');
  out.store = (() => { try { return JSON.parse(localStorage.getItem('mopeCheat.v1') || 'null'); } catch (e) { return null; } })();
  out.stored = out.store && out.store.binds ? ('radar=' + out.store.binds.radar + ' esp=' + JSON.stringify(out.store.binds.esp) + ' dodge=' + out.store.binds.dodge) : null;
  return out;
})()`;

// a genuine hold: press and release are two separate CDP calls with real wall-clock time in between, so
// the product's own performance.now() decides -- the tap window cannot be faked from the rig.
const HOLD_PRE = `(() => {
  H.step('S44_hold_world', 200);
  const fp = H.focusPos(), s = window.__M.Ar.tq(fp.x, fp.y);
  const k = window.__M.Ar.canvas.width / window.__M.Ar.canvas.clientWidth || 1;
  const p = H.holdXY(s.x / k, s.y / k);
  return { p, whileHeld: window.__MOPE_PICKSTATE(), foeId: H.focus };
})()`;
const HOLD_POST = (p, foeId) => `(() => {
  H.upXY(${p.x}, ${p.y});
  const held = window.__MOPE_PICKSTATE();
  const fp = H.focusPos(), s = window.__M.Ar.tq(fp.x, fp.y);
  const k = window.__M.Ar.canvas.width / window.__M.Ar.canvas.clientWidth || 1;
  H.clickXY(s.x / k, s.y / k);                        // the same point, released instantly this time
  return { held, tapped: window.__MOPE_PICKSTATE(), foeId: ${foeId} };
})()`;

// persistence, tested across a REAL page reload: flip the first tick, reload, read what came back
const PERSIST_PRE = `(() => {
  const cb = document.querySelector('#mopeCheatPanel input[type=checkbox]');   // the PvP row
  const want = !cb.checked;
  cb.checked = want; cb.dispatchEvent(new Event('change'));
  let st = null; try { st = JSON.parse(localStorage.getItem('mopeCheat.v1') || 'null'); } catch (e) {}
  return { want, stored: st ? st.pvp : null, binds: st && st.binds ? st.binds.radar + '/' + st.binds.esp : null };
})()`;
const PERSIST_POST = `(() => {
  const cbs = [...document.querySelectorAll('#mopeCheatPanel input[type=checkbox]')];
  const chip = a => (document.querySelector('#mopeCheatPanel button[data-bind="' + a + '"]') || {}).textContent;
  let st = null; try { st = JSON.parse(localStorage.getItem('mopeCheat.v1') || 'null'); } catch (e) {}
  return { pvpChecked: cbs[0].checked, espChip: chip('esp'), radarChip: chip('radar'),
    stored: st ? st.pvp : null, inj: !!window.__MOPE_CHEAT__, skin: st && st.skinSubspecies };
})()`;

(async () => {
  // static server for harness.html + userscript (ephemeral port; wait until it is actually up)
  const server = http.createServer((req, res) => {
    let p = decodeURIComponent(req.url.split('?')[0]); const file = path.join(ROOT, p);
    if (file !== ROOT && !file.startsWith(ROOT + path.sep)) { res.writeHead(403); return res.end('forbidden'); }
    fs.readFile(file, (e, d) => { if (e) { res.writeHead(404); return res.end('nf'); }
      res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' }); res.end(d); });
  });
  await new Promise((res, rej) => { server.once('error', rej); server.listen(STATIC, '127.0.0.1', res); });
  const HARNESS = `http://127.0.0.1:${server.address().port}/test/harness.html`;

  fs.rmSync(PROFILE, { recursive: true, force: true });
  // A FIXED debug port is how this suite used to hang: a previous run that left an orphan behind owns the
  // port, the new browser silently fails to bind, and the script then drives the stale instance forever.
  // port=0 makes Edge publish the real port in <profile>/DevToolsActivePort, so collision is impossible.
  const child = spawn(EDGE, ['--headless=new', '--window-size=1280,800', '--remote-allow-origins=*', '--disable-gpu',
    '--remote-debugging-port=0', `--user-data-dir=${PROFILE}`, '--no-first-run', '--no-default-browser-check', 'about:blank'], { stdio: 'ignore' });
  process.on('exit', () => { try { child.kill(); } catch (_) {} });   // never leak a headless browser
  let ver, port = 0, t0 = Date.now();
  while (true) {
    if (!port) { try { port = parseInt(fs.readFileSync(path.join(PROFILE, 'DevToolsActivePort'), 'utf8').split('\n')[0], 10); } catch (_) { } }
    if (port > 0) { try { ver = await getJson(`http://127.0.0.1:${port}/json/version`); break; } catch (_) { } }
    if (Date.now() - t0 > 25000) { child.kill(); server.close(); throw new Error('no CDP endpoint (devtools port never answered)'); }
    await sleep(400);
  }
  console.log(`devtools port ${port}`);
  const cdp = new CDP(await openSock(ver.webSocketDebuggerUrl));
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  await cdp.send('Page.enable', {}, sessionId);
  await cdp.send('Runtime.enable', {}, sessionId);
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false }, sessionId);
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: SCRIPT }, sessionId);
  await cdp.send('Page.navigate', { url: HARNESS }, sessionId);
  await sleep(2500);

  const ev = async src => { const r = await cdp.send('Runtime.evaluate', { expression: src, returnByValue: true, awaitPromise: true }, sessionId);
    if (r.exceptionDetails) throw new Error('page: ' + JSON.stringify(r.exceptionDetails.exception || r.exceptionDetails.text)); return r.result.value; };

  const R = await ev(SCEN);
  const K = await ev(SKIN);
  const MENU_R = await ev(MENU);
  const KEYS_R = await ev(KEYS);
  // PANEL/BINDS last: BINDS deliberately re-binds ESP/RADAR away from F3/F4, and PANEL only needs a
  // visible, un-dragged panel -- both would poison the earlier programs.
  const PANEL_R = await ev(PANEL);
  const PICKUI_R = await ev(PICKUI);
  // BINDS (below) only re-binds keys and PANEL only reads the DOM: neither can undo a measured pick,
  // so the real-hold pair runs safely in between.
  const HOLD_A = await ev(HOLD_PRE);
  await sleep(420);
  const HOLD_B = await ev(HOLD_POST(HOLD_A.p, HOLD_A.foeId));
  const BINDS_R = await ev(BINDS);
  // last: this really reloads the document, so nothing after it can use the page
  const P1 = await ev(PERSIST_PRE);
  await cdp.send('Page.reload', {}, sessionId);
  await sleep(3000);
  const P2 = await ev(PERSIST_POST);

  try { cdp.ws.close(); } catch (_) {}
  child.kill(); server.close();
  // profile cleanup is best-effort: Edge can hold the lock a beat after kill() — never let it mask results
  const cleanup = () => { try { fs.rmSync(PROFILE, { recursive: true, force: true }); } catch (_) {} };
  setTimeout(cleanup, 1500);

  // ---------- assertions ----------
  const checks = [];
  const add = (name, pass, info) => checks.push({ name, pass: !!pass, info });
  const m = (r, k) => (r && r.modes && r.modes[k]) || 0;
  const clean = r => r && !r.err && (r.errs === 0);

  add('boot: hook+realm', R.boot.hooked && R.boot.M && R.boot.realm, JSON.stringify(R.boot));
  add('S0 manual: idle, client drives, no bot steer', R.S0_manual && R.S0_manual.mode === 'manual' && R.S0_manual.bot114 === 0 && R.S0_manual.client114 > 0 && clean(R.S0_manual), R.S0_manual && `${R.S0_manual.mode} bot=${R.S0_manual.bot114} client=${R.S0_manual.client114}`);
  add('S1 PvP bite (still prey)', R.S1_bite_still && R.S1_bite_still.bites >= 1 && clean(R.S1_bite_still), R.S1_bite_still && `bites=${R.S1_bite_still.bites} min=${R.S1_bite_still.focusMin}`);
  add('S2 PvP bite (moving prey)', R.S2_bite_moving && R.S2_bite_moving.bites >= 1 && clean(R.S2_bite_moving), R.S2_bite_moving && `bites=${R.S2_bite_moving.bites} min=${R.S2_bite_moving.focusMin}`);
  // the whole motion upgrade is inert if predict() always falls back to the raw snapshot; prove it measures
  add('motion: moving prey velocity is MEASURED (tracker live, not raw fallback)', R.motionMoving && R.motionMoving.diag && R.motionMoving.diag.measured === true && (Math.abs(R.motionMoving.diag.vx) + Math.abs(R.motionMoving.diag.vy)) > 20 && typeof R.motionMoving.diag.frontClear === 'boolean', R.motionMoving && R.motionMoving.diag && `measured=${R.motionMoving.diag.measured} v=${Math.round(Math.hypot(R.motionMoving.diag.vx, R.motionMoving.diag.vy))} intervals=${R.motionMoving.motion && R.motionMoving.motion.intervals}`);
  add('motion: still prey stays fresh but near-zero (no fabricated lead)', R.motionStill && R.motionStill.diag && R.motionStill.diag.measured === true && (Math.abs(R.motionStill.diag.vx) + Math.abs(R.motionStill.diag.vy)) < 40, R.motionStill && R.motionStill.diag && `measured=${R.motionStill.diag.measured} v=${Math.round(Math.hypot(R.motionStill.diag.vx, R.motionStill.diag.vy))}`);
  add('S3 jink: turn onto the tail-hunter and shake, back ends protected', R.S3_guard && m(R.S3_guard, 'jink') >= 1 && R.S3_guard.endAimDeg != null && R.S3_guard.endAimDeg <= 50 && R.S3_guard.jinkWagAmp > 0 && clean(R.S3_guard), R.S3_guard && `jink=${m(R.S3_guard, 'jink')} endAim=${R.S3_guard.endAimDeg} wag=${R.S3_guard.jinkWagAmp}`);
  // guard for the harness itself: it once turned instantly clockwise, which faked every aim number
  add('model: turn rate really clamped at 4 rad/s (aim numbers are physical)', R.S3_guard && R.S3_guard.turnMs >= 400 && R.S3_guard.turnMs <= 1300, R.S3_guard && `turnMs=${R.S3_guard.turnMs}`);
  add('S4 evade ON: no deaths', R.S4_evade_on && R.S4_evade_on.deaths === 0 && m(R.S4_evade_on, 'evade') >= 1, R.S4_evade_on && `deaths=${R.S4_evade_on.deaths} evade=${m(R.S4_evade_on, 'evade')}`);
  add('S4 evade OFF: dies (control)', R.S4_evade_off && R.S4_evade_off.deaths >= 1, R.S4_evade_off && `deaths=${R.S4_evade_off.deaths}`);
  add('S5 purge: dead entity dropped from tracking', R.S5_purge && clean(R.S5_purge) && !R.S5_purge.tracked.includes(R.S5_purge.focus), R.S5_purge && `focus=${R.S5_purge.focus} tracked=${JSON.stringify(R.S5_purge.tracked)}`);
  add('S6 ESP ring pixels + radar dial', R.S6_esp && R.S6_esp.espPixels > 0 && R.S6_esp.radarPixels > 0 && clean(R.S6_esp), R.S6_esp && `espPx=${R.S6_esp.espPixels} radarPx=${R.S6_esp.radarPixels}`);
  add('S7 PvP on, no target in range: seek', R.S7_idle && R.S7_idle.mode === 'seek' && clean(R.S7_idle), R.S7_idle && R.S7_idle.mode);
  add('S8 diamond: face-first feint, never back-turned, boosts', R.S8_diamond && m(R.S8_diamond, 'diamond') >= 1 && R.S8_diamond.boosts >= 1 && R.S8_diamond.aimWorstDeg <= 100 && R.S8_diamond.shakeFlips >= 2 && clean(R.S8_diamond), R.S8_diamond && `diamond=${m(R.S8_diamond, 'diamond')} boosts=${R.S8_diamond.boosts} aimWorst=${R.S8_diamond.aimWorstDeg} shakes=${R.S8_diamond.shakeFlips}`);
  add('S9 face-only: faces foe, weaves, no boost', R.S9_face && m(R.S9_face, 'face') >= 1 && R.S9_face.aimAvgDeg != null && R.S9_face.aimAvgDeg <= 25 && R.S9_face.aimWorstDeg <= 100 && R.S9_face.perpFlips >= 2 && R.S9_face.boosts === 0 && clean(R.S9_face), R.S9_face && `aimAvg=${R.S9_face.aimAvgDeg} aimWorst=${R.S9_face.aimWorstDeg} flips=${R.S9_face.perpFlips} abs=${R.S9_face.perpAbs} boosts=${R.S9_face.boosts}`);
  add('S10 fast duel: faces foe through boost + boosts', R.S10_fast && m(R.S10_fast, 'face') >= 1 && R.S10_fast.boosts >= 1 && R.S10_fast.aimAvgDeg <= 30 && R.S10_fast.aimWorstDeg <= 100 && clean(R.S10_fast), R.S10_fast && `aimAvg=${R.S10_fast.aimAvgDeg} aimWorst=${R.S10_fast.aimWorstDeg} boosts=${R.S10_fast.boosts}`);
  add('S11 lunge: boost dart onto an exposed tail', R.S11_lunge && m(R.S11_lunge, 'lunge') >= 1 && R.S11_lunge.boosts >= 1 && clean(R.S11_lunge), R.S11_lunge && `lunge=${m(R.S11_lunge, 'lunge')} boosts=${R.S11_lunge.boosts} bites=${R.S11_lunge.bites} frontClear=${R.S11_diag && R.S11_diag.frontClear}`);
  add('S17 head-on: dart refused while its nose blocks the path, and the gate really closes',
    R.S17_headon && R.S17_headon.diagTicks > 20 && R.S17_headon.diagBlocked >= 5 &&
    (R.S17_headon.firstLungeIx === -1 || R.S17_headon.firstLungeIx >= 5) && clean(R.S17_headon),
    R.S17_headon && `ticks=${R.S17_headon.diagTicks} blocked=${R.S17_headon.diagBlocked}@${R.S17_headon.firstBlockedIx} firstLunge=${R.S17_headon.firstLungeIx} modes=${JSON.stringify(R.S17_headon.modes)}`);
  // the safety invariant for EVERY fight scenario: a committed dart never happens with the nose in the way
  const lungeRuns = [['S8', R.S8_diamond], ['S10', R.S10_fast], ['S11', R.S11_lunge], ['S12', R.S12_ability], ['S13', R.S13_tier], ['S14', R.S14_cursor], ['S17', R.S17_headon]];
  add('invariant: no lunge tick ever had its path through the target nose (all fight scenarios)',
    lungeRuns.every(([, r]) => r && r.diagLungeBlocked === 0), lungeRuns.map(([n, r]) => n + '=' + (r ? r.diagLungeBlocked : 'x')).join(' '));
  add('S11/S17 control: the same gate stays closed head-on and opens once behind (not a constant)',
    R.S11_lunge && R.S11_lunge.diagClearBehind >= 1 && R.S11_lunge.diagBlockedWhileRear === 0,
    R.S11_lunge && `blocked=${R.S11_lunge.diagBlocked} clearBehind=${R.S11_lunge.diagClearBehind} bad=${R.S11_lunge.diagBlockedWhileRear}`);
  add('S12 ability: opcode 217 fired on the lunge', R.S12_ability && R.S12_ability.op217 >= 1 && m(R.S12_ability, 'lunge') >= 1 && clean(R.S12_ability), R.S12_ability && `op217=${R.S12_ability.op217} lunge=${m(R.S12_ability, 'lunge')}`);
  // ---- target choice (the "it fights whatever is nearest instead of my duel" complaint)
  const pt = r => r && `want=${r.wantId} got=${r.targetId} cursor=${r.cursor && r.cursor.x + ',' + r.cursor.y}`;
  add('target: equal-tier duel wins over a nearer low-tier snack', R.S13_tier && R.S13_tier.targetId === R.S13_tier.wantId && clean(R.S13_tier), pt(R.S13_tier));
  add('target: foe under the mouse wins over a nearer off-cursor foe', R.S14_cursor && R.S14_cursor.targetId === R.S14_cursor.wantId && clean(R.S14_cursor), pt(R.S14_cursor));
  add('cursor: read back from the client opcode 114 (world point of the pointer)', R.S14_cursor && R.S14_cursor.cursor && Math.abs(R.S14_cursor.cursor.x - 7767) <= 2 && Math.abs(R.S14_cursor.cursor.y - 6750) <= 2, R.S14_cursor && pt(R.S14_cursor));
  add('control: tierWeight=0 lets the snack hijack (so the bias really decides)', R.S15_tier_ctl && R.S15_tier_ctl.targetId === R.S15_tier_ctl.wantId && R.S15_tier_ctl.wantId !== R.S13_tier.wantId, pt(R.S15_tier_ctl));
  add('control: cursorWeight=0 lets the nearer off-cursor foe win', R.S16_cursor_ctl && R.S16_cursor_ctl.targetId === R.S16_cursor_ctl.wantId && R.S16_cursor_ctl.wantId !== R.S14_cursor.wantId, pt(R.S16_cursor_ctl));
  add('target: PvP off means no lock at all (manual stays manual)', R.S0_manual && R.S0_manual.targetId === null && R.S0_manual.cursor !== null, pt(R.S0_manual));
  // ---- the challenge arena: the opponent is read from game data, bystanders are fenced off
  const pk = r => r && `want=${r.wantId} got=${r.targetId} top=${r.topTargetId} id=${r.pickId} kind=${r.pickKind} msg="${r.pickMsg}"`;
  add('arena: the duel opponent is fought past the engage radius, and the bot closes on it',
    R.S20_duel_far && R.S20_duel_far.targetId === R.S20_duel_far.wantId &&
    R.S20_duel_far.topTargetId === R.S20_duel_far.wantId && R.S20_duel_far.pickKind === 'duel' &&
    R.S20_duel_far.focusMin < 1300 && clean(R.S20_duel_far),
    R.S20_duel_far && pk(R.S20_duel_far) + ` min=${R.S20_duel_far.focusMin} mode=${R.S20_duel_far.mode}`);
  add('arena control: with the duel opponent off the same world has nothing to fight (so S20 is the data)',
    R.S21_duel_off && R.S21_duel_off.targetId === null && R.S21_duel_off.mode === 'seek' && clean(R.S21_duel_off),
    R.S21_duel_off && `${R.S21_duel_off.mode} got=${R.S21_duel_off.targetId} min=${R.S21_duel_off.focusMin}`);
  add('arena fence: somebody else duel is ignored even when those animals are the closest',
    R.S22_fence && R.S22_fence.targetId === R.S22_fence.wantId && R.S22_fence.pickKind === 'auto' && clean(R.S22_fence), pt(R.S22_fence));
  add('fence control: the identical world without arenas picks the nearest of that pair',
    R.S23_fence_ctl && R.S23_fence_ctl.targetId === R.S23_fence_ctl.wantId &&
    R.S23_fence_ctl.wantId !== R.S22_fence.wantId, pt(R.S23_fence_ctl));
  // ---- click-to-target
  add('pick: a real click on the field locks THAT animal and PvP stops fighting anyone else',
    R.S24_pick && R.S24_pick.pickId === R.S24_pick.wantId && R.S24_pick.pickKind === 'manual' &&
    R.S24_pick.targetId === R.S24_pick.wantId && R.S24_pick.topTargetId === R.S24_pick.wantId && clean(R.S24_pick),
    R.S24_pick && pk(R.S24_pick) + ` click=${JSON.stringify(R.S24_pick.click)}`);
  add('pick: when the chosen animal dies the lock clears, says why, and falls back to the auto pick',
    R.S25_pick_dead && R.S25_pick_dead.pickId === null && /исчезла/.test(R.S25_pick_dead.pickMsg || '') &&
    R.S25_pick_dead.pickKind === 'auto' && clean(R.S25_pick_dead), pk(R.S25_pick_dead));
  add('pick: a BIGGER animal is taken anyway (the player decides) and the cost is spoken out loud',
    R.S26_pick_big && R.S26_pick_big.pickId === R.S26_pick_big.wantId &&
    R.S26_pick_big.pickKind === 'manual' && R.S26_pick_big.targetId === R.S26_pick_big.wantId &&
    /крупнее/.test(R.S26_pick_big.pickMsg || '') && clean(R.S26_pick_big), pk(R.S26_pick_big));
  add('pick: a click on empty ground keeps the previous choice',
    R.S27_pick_miss && R.S27_pick_miss.pickId === R.S27_pick_miss.wantId &&
    /никого/.test(R.S27_pick_miss.pickMsg || '') && R.S27_pick_miss.targetId === R.S27_pick_miss.wantId,
    R.S27_pick_miss && pk(R.S27_pick_miss) + ` miss=${JSON.stringify(R.S27_pick_miss.miss)}`);
  add('pick: an explicit click outranks the arena opponent (the player decides)',
    R.S30_pick_duel && R.S30_pick_duel.pickId === R.S30_pick_duel.wantId &&
    R.S30_pick_duel.pickKind === 'manual' && R.S30_pick_duel.targetId === R.S30_pick_duel.wantId, pk(R.S30_pick_duel));
  add('pick UI: the button arms one click, the label changes, and × appears only with a target',
    PICKUI_R && PICKUI_R.armedByButton === true && PICKUI_R.labelArmed !== PICKUI_R.label0 && /врагу/.test(PICKUI_R.labelArmed) &&
    PICKUI_R.clear0 === 'none' && PICKUI_R.clearAfterPick !== 'none',
    PICKUI_R && `armedByButton=${PICKUI_R.armedByButton} label="${PICKUI_R.labelArmed}" x=${PICKUI_R.clear0}->${PICKUI_R.clearAfterPick} start=${JSON.stringify(PICKUI_R.start)}`);
  add('pick UI: a click inside the menu picks nobody and cancels the pending click',
    PICKUI_R && PICKUI_R.afterMenuClick.armed === false && PICKUI_R.afterMenuClick.id === null,
    PICKUI_R && JSON.stringify(PICKUI_R.afterMenuClick));
  // THE complaint: "i clack the target and nothing happens". Nothing armed, no ritual -- a short left tap
  // on a foe that sits far from the streamed cursor point must still lock it. That rules out the old
  // cursor-only hit test and proves the click coordinates themselves drive the pick.
  add('pick: a bare left TAP (nothing armed) locks the animal under the real click point',
    R.S40_tap && R.S40_tap.pickId === R.S40_tap.wantId && R.S40_tap.pickKind === 'manual' &&
    R.S40_tap.targetId === R.S40_tap.wantId && R.S40_tap.topTargetId === R.S40_tap.wantId && clean(R.S40_tap),
    R.S40_tap && pk(R.S40_tap) + ' click=' + JSON.stringify(R.S40_tap.click) + ' cursor=' + JSON.stringify(R.S40_tap.cursor));
  add('pick: the RIGHT button picks instantly, boost hold or not',
    R.S41_rmb && R.S41_rmb.pickId === R.S41_rmb.wantId && R.S41_rmb.pickKind === 'manual' &&
    R.S41_rmb.targetId === R.S41_rmb.wantId && clean(R.S41_rmb), pk(R.S41_rmb));
  add('pick: press-drag-release is an aim gesture, not a pick',
    R.S42_drag && R.S42_drag.pickId === null && R.S42_drag.pickKind !== 'manual' && clean(R.S42_drag), pk(R.S42_drag));
  add('pick: a press with no release yet picks nobody (the game is still boosting)',
    R.S43_press && R.S43_press.pickId === null && clean(R.S43_press), pk(R.S43_press));
  add('pick: a 420ms HOLD of one point is a boost; a TAP of the same point is a pick',
    HOLD_A && HOLD_B && HOLD_A.whileHeld.id === null && HOLD_B.held.id === null &&
    HOLD_B.tapped.id != null && HOLD_B.tapped.id === HOLD_B.foeId && HOLD_B.tapped.kind === 'manual',
    'press=' + JSON.stringify(HOLD_A.whileHeld) + ' release=' + JSON.stringify(HOLD_B.held) +
    ' tap=' + JSON.stringify(HOLD_B.tapped) + ' foe=' + String(HOLD_B.foeId));
  add('pick UI: the same bare tap works straight from the panel, with nothing armed',
    PICKUI_R && PICKUI_R.tapNoArm && PICKUI_R.tapNoArm.id != null && PICKUI_R.tapNoArm.kind === 'manual' &&
    PICKUI_R.tapNoArm.armed === false, PICKUI_R && JSON.stringify(PICKUI_R.tapNoArm));
  add('pick: the tap wins over the arena opponent without any arming',
    R.S45_tap_duel && R.S45_tap_duel.pickId === R.S45_tap_duel.wantId &&
    R.S45_tap_duel.pickKind === 'manual' && R.S45_tap_duel.targetId === R.S45_tap_duel.wantId, pk(R.S45_tap_duel));
  add('pick UI: the field click locks the animal under the cursor and the x-button releases it',
    PICKUI_R && PICKUI_R.afterFieldClick.id != null && PICKUI_R.afterFieldClick.kind === 'manual' &&
    /цель|крупнее/.test(PICKUI_R.afterFieldClick.msg) && PICKUI_R.afterClear.id === null && PICKUI_R.clearAfterClear === 'none',
    PICKUI_R && `pick=${JSON.stringify(PICKUI_R.afterFieldClick)} after=${JSON.stringify(PICKUI_R.afterClear)}`);
  add('pick UI: a click on empty ground picks nothing and reports it',
    PICKUI_R && PICKUI_R.afterMiss.id === null && /никого/.test(PICKUI_R.afterMiss.msg),
    PICKUI_R && JSON.stringify(PICKUI_R.afterMiss));
  // ---- retaliation
  add('retaliate: whoever is going for our tail holds the lock over a nearer snack',
    R.S28_retaliate && R.S28_retaliate.topTargetId === R.S28_retaliate.wantId && clean(R.S28_retaliate),
    R.S28_retaliate && pk(R.S28_retaliate) + ` hist=${JSON.stringify(R.S28_retaliate.tgtHist || {})}`);
  add('retaliate control: with the switch off the nearer snack wins the same world',
    R.S29_retaliate_ctl && R.S29_retaliate_ctl.topTargetId === R.S29_retaliate_ctl.wantId &&
    R.S29_retaliate_ctl.wantId !== R.S28_retaliate.wantId, pt(R.S29_retaliate_ctl));
  // ---- v4: hexagon footwork, kiting bait, incoming-dash defence, duel-ring discipline
  const wh = r => r && `hex=${JSON.stringify(r.whip)} aimAvg=${r.whipAimAvgDeg} aimWorst=${r.whipAimWorstDeg} contact=${r.contact} range=${JSON.stringify(r.whipRange)} pen=${r.whipPenMax}/${r.penMax}(self ${r.whipPenSelf} / foe ${r.whipPenFoe}) jam=${r.whipJamTicks}/${r.jamTicks}(${r.jamPct}%) selfJam=${r.whipJamSelf}/${r.whipJamFoe} orbit=${r.whipSweepDeg}d net@${r.whipSweepRate}d/s gross=${r.whipSweepAbs}d face=${r.whipFacePct}% snap=${r.whipSnapPct}% hop=${JSON.stringify(r.hopStride)} boosts=${r.boosts} deaths=${r.deaths} bites=${r.bites} modes=${JSON.stringify(r.modes)}`;
  // The whip is an ORBIT, so the MEAN nose angle sits on the tangent (~90 deg) and the worst aim is
  // whatever a random reversal leaves behind -- those two numbers cannot be tightened, and the old
  // thresholds (range.min <= 110, aimWorst <= 160) were only reachable by driving INTO the enemy model,
  // which is the exact complaint. What has to hold now is the ring contract:
  //   never inside the model (pre-push overlap == 0, zero jammed ticks),
  //   a real standoff (mean range ~2 body diameters),
  //   fast feet (gross bearing travel, since direction reversals cancel NET progress by design),
  //   one hop per shift (a boost only where the body actually moved).
  add('whip: orbits the foe at a standoff without ever entering her model, fast, one hop per real shift',
    R.S13_whip && m(R.S13_whip, 'whip') >= 100 && R.S13_whip.whip &&
    R.S13_whip.whipPenMax === 0 && R.S13_whip.whipJamTicks === 0 &&
    R.S13_whip.contact != null && R.S13_whip.whipRange &&
    R.S13_whip.whipRange.avg >= R.S13_whip.contact * 1.8 &&
    R.S13_whip.whipRange.avg <= R.S13_whip.contact * 2.6 &&
    R.S13_whip.whipSweepAbs >= 380 && R.S13_whip.whip.switches >= 8 && R.S13_whip.whip.flips >= 1 &&
    R.S13_whip.boosts >= 1 && R.S13_whip.boosts <= R.S13_whip.whip.switches &&
    R.S13_whip.hopStride && R.S13_whip.hopStride.n <= 5 && R.S13_whip.hopStride.avg >= 60 &&
    R.S13_whip.whipFacePct >= 4 && R.S13_whip.whipSnapPct >= 5 &&
    R.S13_whip.whipAimAvgDeg >= 60 && R.S13_whip.whipAimAvgDeg <= 115 &&
    R.S13_whip.deaths === 0 && clean(R.S13_whip), wh(R.S13_whip));
  // The other three PvP postures are allowed to lean on the foe (that is what a bite needs), but a whip
  // tick must be the ONLY thing that ever parks us inside the enemy silhouette.
  add('whip standoff is not paid for by jamming somewhere else: face/diamond/bait overlap stays bounded',
    [R.S9_face, R.S8_diamond, R.S14_bait].every(r => r && r.penMax != null && r.penMax <= 40) &&
    R.S13_whip.jamPct === 0,
    [R.S9_face, R.S8_diamond, R.S14_bait].map(r => r && `pen=${r.penMax} jam=${r.jamTicks}/${r.jamPct}%`).join(' ') +
    ' whip jam=' + (R.S13_whip && R.S13_whip.jamPct) + '%');
  add('whip is a SEPARATE switch: with it off no other scenario ever enters the hexagon',
    [R.S1_bite_still, R.S2_bite_moving, R.S11_lunge, R.S13_tier, R.S20_duel_far].every(r => r && m(r, 'whip') === 0),
    [R.S1_bite_still, R.S2_bite_moving, R.S11_lunge, R.S13_tier, R.S20_duel_far].map(r => r && JSON.stringify(r.modes)).join(' '));
  // (3) "суть вихря - очень быстрое перемещение по кругу с дефом и тверком иногда ... без плавности". The
  // testable word is SHARP. swingDegS = total |change of the cursor measured about our own NOSE| per second
  // over whip-owned ticks: a ramp that ends in the same place scores a fraction of a jump, so this is the
  // smoothness meter, not another travel meter. 10-12 rep sweeps: sharpened wave 980-1045 deg/s against the
  // pre-task wave (cycle 520, leash 34, cosine dive, sine wag) at 715-717 -> 1.37-1.46x. The floor below is
  // 1.2x so a single run has room, and 800 deg/s absolute, which no smooth variant of this ring ever reached.
  const sh = R.S13_whip, sf = R.S13_whip_soft;
  add('whip feet are JUMPS, not a glide: cursor swing per second beats the smooth wave by 1.2x and clears 800',
    sh && sf && sh.swingDegS != null && sf.swingDegS != null &&
    sh.swingDegS >= sf.swingDegS * 1.2 && sh.swingDegS >= 800 && sh.swingMaxDeg >= 60,
    'sharp=' + (sh && sh.swingDegS) + 'deg/s smooth=' + (sf && sf.swingDegS) + 'deg/s ratio=' +
    (sh && sf && sf.swingDegS ? (sh.swingDegS / sf.swingDegS).toFixed(2) : null) +
    ' biggestJump=' + (sh && sh.swingMaxDeg) + 'deg flips/s=' + (sh && sh.swingHz) + ' body=' + (sh && sh.turnDegS) + 'deg/s');
  // "с дефом и тверком ИНОГДА": both beats have to really happen inside the ring, and "иногда" is the binding
  // half of the sentence - a beat on every wave is not spice, it is a new routine (and the lap counter proves
  // the schedule is being walked, not randomly sampled once).
  add('the ring sprinkles a defensive sidestep and a twerk without either one becoming the whole wave',
    sh && sh.whipLaps >= 4 && sh.twerkTicks >= 1 && sh.defTicks >= 1 &&
    sh.twerkTicks <= sh.whipTicks * 0.6 && sh.defTicks <= sh.whipTicks * 0.6,
    'laps=' + (sh && sh.whipLaps) + ' twerk=' + (sh && sh.twerkTicks) + '/' + (sh && sh.whipTicks) +
    'ticks def=' + (sh && sh.defTicks) + '/' + (sh && sh.whipTicks) + 'ticks over ' + (sh && sh.whipLaps) + ' laps');
  add('both beats belong to the sharp switch: the smooth control runs neither',
    sf && sf.twerkTicks === 0 && sf.defTicks === 0,
    'smooth twerk=' + (sf && sf.twerkTicks) + ' def=' + (sf && sf.defTicks));
  // Sharpening is only worth shipping if it is free: the ring must still cover the same ground and still
  // threaten the same face. Measured sharp vs smooth over 10 reps - travel 356-444 vs 345-419, face threat
  // 6.1% vs 4.3-5.2% - so the 0.85x bound is generous and the real claim is "nothing was traded away".
  add('sharpness is not paid for with ground or threat: travel and face share hold up against the smooth wave',
    sh && sf && sh.whipSweepAbs >= sf.whipSweepAbs * 0.85 && sh.whipFacePct >= sf.whipFacePct &&
    sh.whipRange.avg <= sh.contact * 2.6 && sh.whipPenSelf === 0 && sh.whipPenFoe === 0,
    'gross ' + (sh && sh.whipSweepAbs) + ' vs ' + (sf && sf.whipSweepAbs) + 'd, face ' + (sh && sh.whipFacePct) +
    '% vs ' + (sf && sf.whipFacePct) + '%, self/foe penetration ' + (sh && sh.whipPenSelf) + '/' + (sh && sh.whipPenFoe) +
    ' vs ' + (sf && sf.whipPenSelf) + '/' + (sf && sf.whipPenFoe));
  const rx = r => r && `face=${r.faceAvgMs}ms(worst ${r.faceWorstMs}ms n=${r.faceRuns} gate@${r.nearD}) tailEvent=${r.snapAvgMs}ms pivotTicks=${r.snapTicks} bites=${r.bites} boosts=${r.boosts} pen=${r.penMax} jam=${r.jamTicks} deaths=${r.deaths} modes=${JSON.stringify(r.modes)}`;
  // (2) a foe that stopped moving is not a duellist: the bot has to walk round to its tail and chew
  add('AFK snack: a foe standing still for 2s is taken from behind and bitten, not stared at',
    R.S35_afk && m(R.S35_afk, 'stalk') >= 30 && m(R.S35_afk, 'bait') === 0 && R.S35_afk.bites >= 1 &&
    R.S35_afk.deaths === 0 && clean(R.S35_afk), rx(R.S35_afk));
  add('AFK control: kill the standstill detector and the SAME motionless foe is never bitten (so it is the detector)',
    R.S35_afk_ctl && m(R.S35_afk_ctl, 'stalk') === 0 && R.S35_afk_ctl.bites === 0 &&
    m(R.S35_afk_ctl, 'face') + m(R.S35_afk_ctl, 'diamond') >= 300, rx(R.S35_afk_ctl));
  // (1) whoever lands on our tail has to be faced NOW. The pivot is a handbrake turn (a cursor past 90 deg
  // off our own nose is the client's brake: 35% speed, the heading still swinging at the full 4 rad/s), so
  // rotation is bought without driving the body into the attacker. faceAvgMs is the reflex's own clock --
  // it starts only when the foe is ALREADY inside biting range, so a long approach cannot inflate the win.
  // A control that NEVER finishes the turn inside the window is the strongest result the reflex can have,
  // and the old assertion scored it as a null and failed the run. An unfinished episode is charged at its
  // open cost (the scenario length it was still turned away for), which is the honest infinity here.
  const ctlFace = R.S37_snap_near_ctl && (R.S37_snap_near_ctl.faceAvgMs != null
    ? R.S37_snap_near_ctl.faceAvgMs : R.S37_snap_near_ctl.faceWorstMs);
  add('snap-turn: a body already on our tail is faced 2x faster than the orbit ever gets there',
    R.S37_snap_near && R.S37_snap_near_ctl && R.S37_snap_near.snapTicks >= 100 &&
    R.S37_snap_near.faceAvgMs != null && ctlFace != null &&
    R.S37_snap_near.faceAvgMs <= ctlFace * 0.5 &&
    m(R.S37_snap_near, 'whip') >= 100 && R.S37_snap_near.deaths === 0 && clean(R.S37_snap_near),
    'on: ' + rx(R.S37_snap_near) + ' || off(charged)=' + ctlFace + 'ms ' + rx(R.S37_snap_near_ctl));
  add('snap-turn on a real chase: the tail event gets shorter, the reflex owns the frames it is there for',
    R.S36_snap && R.S36_snap_ctl && R.S36_snap.snapTicks >= 100 && R.S36_snap.snapAvgMs != null &&
    R.S36_snap_ctl.snapAvgMs != null && R.S36_snap.snapAvgMs <= R.S36_snap_ctl.snapAvgMs &&
    R.S36_snap.deaths === 0 && R.S36_snap.penMax <= 40 && clean(R.S36_snap),
    'on: ' + rx(R.S36_snap) + ' || off: ' + rx(R.S36_snap_ctl));
  // The reflex must be paid for OUTSIDE the ring, not out of it: an earlier build pivoted from inside
  // whipStep and scored a better reaction by spending the standoff (pen 9-11, jam 3.3%). Now the orbit's
  // own window still has to come back clean.
  add('snap-turn is bought outside the orbit: the ring window still never enters the model or jams',
    R.S13_whip && R.S13_whip.whipPenMax === 0 && R.S13_whip.whipJamTicks === 0 &&
    R.S13_whip.deaths === 0 && R.S13_whip.penMax <= 40 && clean(R.S13_whip) &&
    m(R.S13_whip, 'whip') >= 100 && R.S37_snap_near && R.S37_snap_near.jamTicks <= 60 &&
    R.S37_snap_near.deaths === 0,
    'S13 ring pen=' + (R.S13_whip && R.S13_whip.whipPenMax) + '/' + (R.S13_whip && R.S13_whip.penMax) +
    ' jam=' + (R.S13_whip && R.S13_whip.whipJamTicks) + '/' + (R.S13_whip && R.S13_whip.jamTicks) +
    ' pivotTicks=' + (R.S13_whip && R.S13_whip.snapTicks) +
    ' modes=' + JSON.stringify(R.S13_whip && R.S13_whip.modes) + ' || S37 ' + rx(R.S37_snap_near));
  const bt = r => r && `baitTicks=${r.baitTicks} baitAim=${r.baitAimAvgDeg} faceAim=${r.aimAvgDeg} bites=${r.bites} boosts=${r.boosts} min=${r.focusMin} end=${r.focusEnd} modes=${JSON.stringify(r.modes)}`;
  add('bait: a foe that faces us and backs off is strafed, never bitten and never darted at',
    R.S14_bait && m(R.S14_bait, 'bait') >= 1 && R.S14_bait.baitTicks >= 100 && R.S14_bait.bites === 0 &&
    R.S14_bait.boosts === 0 && R.S14_bait.baitAimAvgDeg >= 12 && clean(R.S14_bait), bt(R.S14_bait));
  // A foe that holds its nose on us can never be bitten by ANY bot (the bite probe needs our nose within
  // half its radius of a tail that sits on the far side of its body), so the control cannot be scored on
  // bites. What the gate really changes is the approach: detector off -> the bot drives into the head;
  // detector on -> it swings wide around it. That difference is what is measured here.
  add('bait control: switch the detector off and the SAME kiting foe is charged head-on (so bait is the gate)',
    R.S14_bait_ctl && R.S14_bait_ctl.baitTicks === 0 && m(R.S14_bait_ctl, 'bait') === 0 &&
    m(R.S14_bait_ctl, 'face') + m(R.S14_bait_ctl, 'diamond') >= 100 &&
    R.S14_bait_ctl.aimAvgDeg != null && R.S14_bait.baitAimAvgDeg != null &&
    R.S14_bait.baitAimAvgDeg > R.S14_bait_ctl.aimAvgDeg,
    'on: ' + bt(R.S14_bait) + ' || off: ' + bt(R.S14_bait_ctl));
  add('dashdef: an incoming dash is answered by the defend cycle, without spending a boost',
    R.S15_dash && m(R.S15_dash, 'dashdef') >= 1 && R.S15_dash.boosts === 0 && R.S15_dash.deaths === 0 && clean(R.S15_dash),
    R.S15_dash && `def=${R.S15_dash.dashdefTicks} boosts=${R.S15_dash.boosts} deaths=${R.S15_dash.deaths} min=${R.S15_dash.focusMin}`);
  add('dashdef: the defensive boost is gated (fires a few times, not every tick)',
    R.S15_dash_dodge && m(R.S15_dash_dodge, 'dashdef') >= 1 && R.S15_dash_dodge.boosts >= 1 &&
    R.S15_dash_dodge.boosts <= 4 && R.S15_dash_dodge.deaths === 0,
    R.S15_dash_dodge && `def=${R.S15_dash_dodge.dashdefTicks} boosts=${R.S15_dash_dodge.boosts} min=${R.S15_dash_dodge.focusMin}`);
  add('ring: the bot never asks to steer outside the duel wall, and keeps fighting the ring foe',
    R.S31_zone && R.S31_zone.zone && R.S31_zone.zone.pulls >= 1 && R.S31_zone.zoneWorst != null &&
    R.S31_zone.zoneLim != null && R.S31_zone.zoneWorst <= R.S31_zone.zoneLim + 40 &&
    R.S31_zone.targetId === R.S31_zone.wantId && clean(R.S31_zone),
    R.S31_zone && `worst=${R.S31_zone.zoneWorst} lim=${R.S31_zone.zoneLim} r=${R.S31_zone.zone && R.S31_zone.zone.r} pulls=${R.S31_zone.zone && R.S31_zone.zone.pulls} out=${R.S31_zone.zone && R.S31_zone.zone.out} bodyMax=${R.S31_zone.bodyOutMax} bodyOut=${R.S31_zone.bodyOutTicks} got=${R.S31_zone.targetId}`);
  // The body, not just the steer point, has to stay inside the burning wall: momentum can carry us past
  // the limit we aim at, so the margin has to be wide enough for the turn radius.
  add('ring: momentum included, our own body still never crosses the burning wall',
    R.S31_zone && R.S31_zone.zone && R.S31_zone.bodyOutMax != null &&
    R.S31_zone.bodyOutMax <= R.S31_zone.zone.r && R.S31_zone.bodyOutTicks === 0,
    R.S31_zone && `bodyMax=${R.S31_zone.bodyOutMax} r=${R.S31_zone.zone && R.S31_zone.zone.r} outTicks=${R.S31_zone.bodyOutTicks} lim=${R.S31_zone.zoneLim}`);
  add('ring control: neutralise the clamp and the same ring is walked straight out of',
    R.S32_zone_off && R.S32_zone_off.zone && R.S32_zone_off.zone.pulls === 0 &&
    R.S31_zone && R.S32_zone_off.zoneWorst > R.S31_zone.zoneLim + 200 &&
    R.S32_zone_off.bodyOutMax > R.S31_zone.zone.r,
    R.S32_zone_off && `worst=${R.S32_zone_off.zoneWorst} pulls=${R.S32_zone_off.zone && R.S32_zone_off.zone.pulls} out=${R.S32_zone_off.zone && R.S32_zone_off.zone.out} bodyMax=${R.S32_zone_off.bodyOutMax}`);
  // "notice the edges when the territory shrinks" -- the ring is re-read every frame, so a smaller
  // circle that appears mid-fight is walked back into instead of being remembered as the big one.
  add('ring: the duel circle SHRINKS mid-fight and the bot returns inside the new wall',
    R.S33_shrink && R.S33_shrink.zoneRseq && R.S33_shrink.zoneRseq.length >= 2 &&
    R.S33_shrink.zone && R.S33_shrink.zone.pulls >= 1 &&
    R.S33_shrink.zoneTailOver != null && R.S33_shrink.zoneTailOver <= 0 &&
    R.S33_shrink.zoneSelf === false && R.S33_shrink.zoneGap > 0 &&
    R.S33_shrink.targetId === R.S33_shrink.wantId && clean(R.S33_shrink),
    R.S33_shrink && 'radii=' + JSON.stringify(R.S33_shrink.zoneRseq) + ' over=' + String(R.S33_shrink.zoneOver) +
    ' tailOver=' + String(R.S33_shrink.zoneTailOver) + ' gap=' + String(R.S33_shrink.zoneGap) +
    ' r=' + String(R.S33_shrink.zone && R.S33_shrink.zone.r) + ' pulls=' + String(R.S33_shrink.zone && R.S33_shrink.zone.pulls));
  add('ring: the same guard reads the wall off the networked twin (arena.target), not only arena.size',
    R.S34_ring_tgt && R.S34_ring_tgt.ringR != null && R.S34_ring_tgt.zone &&
    R.S34_ring_tgt.zone.r === R.S34_ring_tgt.ringR && R.S34_ring_tgt.zone.pulls >= 1 &&
    R.S34_ring_tgt.bodyOutTicks === 0 && R.S34_ring_tgt.zoneWorst <= R.S34_ring_tgt.zoneLim + 40 &&
    R.S34_ring_tgt.targetId === R.S34_ring_tgt.wantId && clean(R.S34_ring_tgt),
    R.S34_ring_tgt && 'read=' + String(R.S34_ring_tgt.zone && R.S34_ring_tgt.zone.r) + ' geo=' + String(R.S34_ring_tgt.ringR) +
    ' worst=' + String(R.S34_ring_tgt.zoneWorst) + ' lim=' + String(R.S34_ring_tgt.zoneLim) +
    ' bodyOut=' + String(R.S34_ring_tgt.bodyOutTicks) + ' got=' + String(R.S34_ring_tgt.targetId));
  // ---- cursor send tempo (the point of the steer()/pumpWheel() split)
  // steer() used to rate-limit itself and DROP a point that arrived a hair early, so the sent rate was a
  // fraction of what the client is allowed: ~62/s in an arena against 120, ~21/s against 30. The check is
  // two-sided on purpose -- a gap floor means nobody can pass it by pushing the pump BELOW the native
  // interval, which the server would read as too-fast input.
  const rt = r => (r && r.rate ? `n=${r.rate.n} ${r.rate.perSec}/s gaps ${r.rate.gapMin}..${r.rate.gapMax} max1s=${r.rate.maxPerSec}` : 'no rate');
  const tempo = (r, want) => {
    const iv = 1000 / want;
    return r && r.rate && r.rate.n >= want * 0.6 && r.rate.perSec >= want * 0.9 && r.rate.perSec <= want * 1.15 &&
      r.rate.gapMax <= iv * 1.4 && r.rate.gapMin >= iv * 0.9 && clean(r);
  };
  add('tempo: in a duel arena the bot really sends ~120 cursor packets/s (was ~62 before the pump)',
    tempo(R.S50_rate_arena, 120), R.S50_rate_arena && rt(R.S50_rate_arena) + ' ' + (R.S50_rate_arena.mode || ''));
  add('tempo: tier 12 outside an arena sends ~60/s', tempo(R.S51_rate_mid, 60), R.S51_rate_mid && rt(R.S51_rate_mid));
  add('tempo: tier 1 sends ~30/s, i.e. a deferred point is never lost', tempo(R.S52_rate_low, 30), R.S52_rate_low && rt(R.S52_rate_low));
  // the parked point must be the one that leaves, and it must leave ON its boundary: newest decision wins,
  // nothing queued behind it (several decisions land inside one 33ms window at tier 1)
  add('tempo: a deferred send carries the NEWEST parked point, exactly on its boundary',
    R.S52_rate_low && R.S52_rate_low.wheelPending >= 10 && R.S52_rate_low.wheelErr <= 1 &&
    R.S52_rate_low.wheelLate <= 0.01 && R.S52_rate_low.wheelReplaced >= R.S52_rate_low.wheelPending * 0.5,
    R.S52_rate_low && 'sent=' + String(R.S52_rate_low.wheelPending) + ' pointErr=' + String(R.S52_rate_low.wheelErr) +
    ' dueErr=' + String(R.S52_rate_low.wheelLate) + ' overwritten=' + String(R.S52_rate_low.wheelReplaced) +
    ' maxInWindow=' + String(R.S52_rate_low.wheelMaxReplaced));
  add('skin: numeric id pins local subspecies', K && K.self === 3 && K.cfg === 3 && K.errs === 0, K && `self=${K.self} cfg=${K.cfg}`);
  add('skin: pin re-runs init() to swap the local sprite', K && K.initCalls >= 1, K && `initCalls=${K.initCalls}`);
  add('skin: dropdown lists real skins from animalConfig.subspeciesEnum', K && K.disabled === false && K.optCount >= 4 && K.opts.some(o => /SUMMER/.test(o)), K && JSON.stringify(K.opts));
  add('menu: × hides panel, shows MOPE', MENU_R && MENU_R.before.panel === 'block' && MENU_R.before.open === 'none' && MENU_R.hidden.panel === 'none' && MENU_R.hidden.open === 'block', JSON.stringify(MENU_R));
  add('menu: MOPE reopens panel', MENU_R && MENU_R.shown.panel === 'block' && MENU_R.shown.open === 'none', JSON.stringify(MENU_R && MENU_R.shown));
  add('hotkeys: every bound row toggles its own switch (keys read from __MOPE_BINDS)',
    KEYS_R && Object.values(KEYS_R.toggles).every(v => v === true || v === 'unbound') &&
    KEYS_R.toggles.pvp === true && KEYS_R.toggles.dodge === true && KEYS_R.toggles.esp === true &&
    KEYS_R.toggles.radar === true && KEYS_R.toggles.labels === true && KEYS_R.toggles.whip === true,
    KEYS_R && JSON.stringify(KEYS_R.toggles));
  // Firefox owns F7 for caret browsing and the user lives in Firefox: the whip ships on F8 instead.
  add('whip row is present and bound to F8 by default (F7 is Firefox caret browsing)',
    KEYS_R && KEYS_R.binds.whip === 'F8' && KEYS_R.toggles.whip === true,
    KEYS_R && `binds=${JSON.stringify(KEYS_R.binds)} unbound=${JSON.stringify(KEYS_R.unbound)}`);
  add('hotkey F6 arms the click-to-target without picking anything', KEYS_R && KEYS_R.pick.armedByF6 === true && KEYS_R.pick.idByF6 === null && KEYS_R.pick.cleared === true, KEYS_R && JSON.stringify(KEYS_R.pick));
  add('hotkey Insert toggles menu visibility', KEYS_R && KEYS_R.insert.changed, KEYS_R && JSON.stringify(KEYS_R.insert));
  // ---- one PvP switch (was autopvp + fast duel + diamond + dart)
  const rowNames = PANEL_R && PANEL_R.rows.map(r => r.label).join('|');
  add('menu: exactly 7 switches, one of them the whole PvP system', PANEL_R && PANEL_R.rows.length === 7 && /PvP/.test(rowNames), rowNames);
  // both of these were "what is that for?" rows: the duel-opponent preference and retaliation are internal
  // tie-breakers now, and the ring itself is read from arena data and painted -- no switch to remember.
  add('menu: the arena-duel and retaliation switches are GONE (only the ring behaviour stayed)',
    !/арене|дуэль/i.test(rowNames) && !/агрессору/i.test(rowNames), rowNames);
  add('menu: the PvP row text says the click IS the target and the ring is respected',
    PANEL_R && /клик/i.test(PANEL_R.rows[0].desc || '') && /кольц/i.test(PANEL_R.rows[0].desc || ''),
    PANEL_R && String(PANEL_R.rows[0].desc).slice(0, 80));
  add('menu: the pick row owns a button and a key chip', PANEL_R && PANEL_R.pick && PANEL_R.pick.chip === 'F6' && PANEL_R.pick.label.length > 3, PANEL_R && JSON.stringify(PANEL_R.pick));
  add('menu: no leftover per-phase switches (fast duel / face / diamond are automatic)', PANEL_R && PANEL_R.rows.filter(r => /PvP/i.test(r.label)).length === 1 && !/ромб|быстр|face|face-only/i.test(rowNames), rowNames);
  add('menu: every row shows its key chip', PANEL_R && PANEL_R.rows.every(r => r.chip && r.chip.length > 0), PANEL_R && JSON.stringify(PANEL_R.rows.map(r => r.label + ':' + r.chip)));
  // ---- compact + translucent (the "window covers everything" complaint)
  add('panel: translucent background (alpha < 0.6) with blur', PANEL_R && PANEL_R.alpha > 0 && PANEL_R.alpha < 0.6 && /blur/.test(String(PANEL_R.blur)), PANEL_R && `${PANEL_R.bg} blur=${PANEL_R.blur}`);
  add('panel: covers < 12% of a 1280x800 screen', PANEL_R && PANEL_R.cover < 0.12, PANEL_R && `${PANEL_R.w}x${PANEL_R.h} = ${(PANEL_R.cover * 100).toFixed(1)}%`);
  add('panel: description hidden until hover, text still reachable', PANEL_R && PANEL_R.idle === '' && PANEL_R.hovered.length > 10, PANEL_R && `idle="${PANEL_R.idle}" hover="${PANEL_R.hovered.slice(0, 24)}…"`);
  // ---- remappable binds
  add('binds: chip click arms capture, new key drives the switch, old key dies', BINDS_R && BINDS_R.arming === 'клава?' && BINDS_R.espLabel === 'J' && BINDS_R.oldKeyDead && BINDS_R.newKeyWorks, BINDS_R && `arm=${BINDS_R.arming} label=${BINDS_R.espLabel} oldDead=${BINDS_R.oldKeyDead} newWorks=${BINDS_R.newKeyWorks}`);
  add('binds: a re-claimed key is freed by its previous owner (no double binding)', BINDS_R && BINDS_R.stolen && BINDS_R.espReleased && BINDS_R.espLabelAfterSteal === '—', BINDS_R && `radar=${BINDS_R.stolen} espFreed=${BINDS_R.espReleased} chip=${BINDS_R.espLabelAfterSteal}`);
  add('binds: Escape cancels, previous key keeps working', BINDS_R && BINDS_R.escapeLabel === 'F2' && BINDS_R.escapeKeptOld, BINDS_R && `label=${BINDS_R.escapeLabel} f2=${BINDS_R.escapeKeptOld}`);
  add('binds: a row that shipped keyless (ability) takes a new key and its chip follows', BINDS_R && BINDS_R.abilityLabel === 'K' && BINDS_R.abilityWorks === true, BINDS_R && `chip=${BINDS_R.abilityLabel} works=${BINDS_R.abilityWorks}`);
  add('binds survive a reload (written to storage)', BINDS_R && BINDS_R.stored === 'radar=KeyJ esp="" dodge=F2', BINDS_R && String(BINDS_R.stored));
  // ---- target marker is readable without ESP (the "why that one?" problem)
  add('overlay: target ring + cursor mark painted with ESP off, PvP on', R.S18_mark && R.S18_mark.markPx > 0 && R.S18_mark.curPx > 0 && clean(R.S18_mark), R.S18_mark && `targetPx=${R.S18_mark.markPx} cursorPx=${R.S18_mark.curPx}`);
  add('overlay control: same probe paints nothing with PvP and ESP both off', R.S19_blind && R.S19_blind.markPx === 0 && R.S19_blind.targetId === null, R.S19_blind && `targetPx=${R.S19_blind.markPx} got=${R.S19_blind.targetId}`);
  // ---- persistence across a real document reload
  add('cfg: checkbox + bind changes are written to storage immediately', P1 && P1.stored === P1.want && P1.binds === 'KeyJ/', JSON.stringify(P1));
  add('cfg: after a real reload the panel comes back with the same tick and keys', P2 && P2.inj && P2.pvpChecked === P1.want && P2.radarChip === 'J' && P2.espChip === '—' && P2.stored === P1.want, JSON.stringify({ P1, P2 }));

  let pass = 0;
  console.log('\n==================== MOPE CHEAT VERIFICATION ====================');
  for (const c of checks) { if (c.pass) pass++; console.log(`${c.pass ? 'PASS' : 'FAIL'}  ${c.name}${c.info ? '   [' + c.info + ']' : ''}`); }
  console.log('\n----- PvP in the challenge arena (the complaint) -----');
  for (const [n, r] of [['S20 duel foe at 1500px', R.S20_duel_far], ['S21 control: duel read off', R.S21_duel_off]]) {
    console.log(String(n).padEnd(26) + pk(r) + ` mode=${r && r.mode} min=${r && Math.round(r.focusMin)}`);
  }
  console.log('\n----- bystanders fenced out + retaliation -----');
  for (const [n, r] of [['S22 other pair in an arena', R.S22_fence], ['S23 control: no arenas', R.S23_fence_ctl], ['S28 tail-hunter preferred', R.S28_retaliate], ['S29 control: retaliate off', R.S29_retaliate_ctl]]) {
    console.log(String(n).padEnd(26) + pk(r));
  }
  console.log('\n----- click-to-target (real mouse events on the page) -----');
  for (const [n, r] of [['S40 bare tap', R.S40_tap], ['S41 right button', R.S41_rmb], ['S42 press-drag', R.S42_drag],
                        ['S43 press, no release', R.S43_press], ['S45 tap vs duel foe', R.S45_tap_duel],
                        ['S24 armed click', R.S24_pick], ['S25 the pick dies', R.S25_pick_dead],
                        ['S26 a BEAR (tier 2)', R.S26_pick_big], ['S27 empty ground', R.S27_pick_miss],
                        ['S30 pick vs duel', R.S30_pick_duel]]) {
    console.log(String(n).padEnd(22) + pk(r) + ' click=' + JSON.stringify(r && r.click));
  }
  console.log('  hold 420ms then release : ' + JSON.stringify(HOLD_A && HOLD_A.whileHeld) + ' -> ' + JSON.stringify(HOLD_B && HOLD_B.held));
  console.log('  the same point, tapped  : ' + JSON.stringify(HOLD_B && HOLD_B.tapped));
  console.log('\n----- MEASURE: rear dwell (reaction) + AFK stalk -----');
  for (const r of R.MEASURE || []) console.log('  ' + JSON.stringify(r));
  if (R.SWEEPS) { console.log('----- SWEEPS -----'); for (const r of R.SWEEPS) console.log('  ' + JSON.stringify(r)); }
  console.log('\n----- duel ring (edges, shrink, field shape) -----');
  for (const [n, r] of [['S31 clamp on', R.S31_zone], ['S32 clamp off', R.S32_zone_off],
                        ['S33 ring shrinks', R.S33_shrink], ['S34 ring on .target', R.S34_ring_tgt]]) {
    console.log(String(n).padEnd(22) + 'readR=' + String(r && r.zone && r.zone.r) + ' geoR=' + String(r && r.ringR) +
      ' lim=' + String(r && r.zoneLim) + ' worst=' + String(r && r.zoneWorst) + ' over=' + String(r && r.zoneOver) +
      ' tailOver=' + String(r && r.zoneTailOver) + ' bodyMax=' + String(r && r.bodyOutMax) +
      ' bodyOut=' + String(r && r.bodyOutTicks) + ' pulls=' + String(r && r.zone && r.zone.pulls) +
      ' gap=' + String(r && r.zoneGap) + ' radii=' + String(r && JSON.stringify(r.zoneRseq)));
  }
  console.log('\n----- cursor send tempo (opcode 114, measured off the wire) -----');
  for (const [n, r, want] of [['arena (uA=120)', R.S50_rate_arena, 120], ['tier>=10 (uA=60)', R.S51_rate_mid, 60],
                              ['tier<10 (uA=30)', R.S52_rate_low, 30]]) {
    const q = r && r.rate;
    const head = q ? 'want ' + String(want).padStart(3) + '/s  got ' + String(q.perSec).padStart(6) + '/s  n=' +
      String(q.n).padStart(4) + ' over ' + q.span + 'ms  gap ' + q.gapMin + '..' + q.gapMax + 'ms  best-1s=' + q.maxPerSec : 'no data';
    const tail = r && r.wheelPending ? '  deferred=' + r.wheelPending + ' overwritten=' + r.wheelReplaced +
      ' maxInWindow=' + r.wheelMaxReplaced + ' ptErr=' + r.wheelErr + ' dueErr=' + r.wheelLate : '';
    console.log(String(n).padEnd(20) + head + tail);
  }
  const failed = checks.filter(c => !c.pass);
  console.log('\n' + (failed.length === 0 ? `ALL ${pass}/${checks.length} CHECKS PASSED` : `${pass}/${checks.length} PASSED, FAILED: ` + failed.map(c => c.name).join(' | ')));
  if (failed.length) console.log(JSON.stringify({ R: Object.fromEntries(Object.entries(R).map(([k, v]) => [k, v])), PICKUI_R, PANEL_R, KEYS_R, BINDS_R }, null, 1));
  process.exit(pass === checks.length ? 0 : 2);
})().catch(e => { console.error('VERIFY FAIL: ' + e.message); process.exit(1); });
