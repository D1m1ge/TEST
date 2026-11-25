    const mx = me.target.position.x, my = me.target.position.y;
    const td = Math.hypot(tail.x - mx, tail.y - my);
    let score = td + (me.tier - e.tier) * CFG.tierWeight;
    if (bot.cursor) score += CFG.cursorWeight * Math.hypot(tail.x - bot.cursor.x, tail.y - bot.cursor.y);
    return { id, e, er, base, tail, td, score };
  }

  function tick() {
    window.__MOPE_SKIN = CFG.skinSubspecies | 0;   // read by the client-realm hook to pin the local skin
    const M = window.__M, E = window.__ENTS;
    const me = M && M.zy;
    if (!E || !me || !me.spawned) {
      bot.target = bot.threat = bot.tail = null;
      bot.mode = 'off';
      bot.hunterId = null;
      releaseWheel();   // hand the wheel back; a respawn/reconnect must not keep a stale holdUntil
      resetMotion();    // player is gone: every snapshot/id is stale from here on
      return;
    }
    const now = performance.now();
    // Shadow zx as soon as the client exists, not on our first send: the cursor read-back in wrappedZx has
    // to be warm before the very first target pick, otherwise round one ignores where the player aims.
    net(M);
    if (!bot.tracker) bot.tracker = new PVP.MotionTracker({
      smoothingMs: CFG.motionSmoothingMs, staleMs: CFG.motionStaleMs, resetGapMs: CFG.motionResetGapMs,
      maxSpeed: CFG.maxSpeed, maxAngularSpeed: CFG.maxAngularSpeed });
    if (!bot.lock) bot.lock = new PVP.TargetLock(CFG.lockMinHoldMs, CFG.lockSwitchRatio);
    // a reconnect hands us a new net client: every snapshot and entity id belongs to the old session
    if (bot.lastHf !== M.Hf) { bot.lastHf = M.Hf; resetMotion(); }

    const mt = me.target;
    // A half-synced self (spawn frame, reconnect, a renamed field) used to throw out of tick() and kill
    // every combat branch in silence. Now it just waits one frame and says why.
    if (!mt || !mt.position || !mt.size || !(mt.size.x > 0)) { bot.blk = 'нет снапшота'; return; }
    bot.blk = '';
    const mx = mt.position.x, my = mt.position.y;
    const mr = mt.size.x / 2, mang = mt.angle;
    const hx = Math.cos(mang), hy = Math.sin(mang);

    // feed the tracker ONLY from real decoded snapshots (the hook bumps __mopeSeq per packet); re-reading
    // target.* between packets is NOT a new measurement, so a still-but-live foe never decays to "stale".
    for (const [id, e] of E) {
      if (!e.spawned) { E.delete(id); bot.seq.delete(id); bot.tracker.remove(id); if (bot.hunterId === id) bot.hunterId = null; continue; }
      const s = e.__mopeSample;
      if (s && bot.seq.get(id) !== s.n) { bot.tracker.update(id, { x: s.x, y: s.y, angle: s.angle }, s.t); bot.seq.set(id, s.n); }
    }

    let predator = null, predatorD = Infinity, awayX = 0, awayY = 0;
    let hunter = null, hunterD = Infinity, hunterId = null;
    const cands = [];
    const myArena = arenaOf(me);

    for (const [id, e] of E) {
      if (e === me || e.hole || !e.spawned) continue;
      // Anything in a different arena is behind a fence: another pair's challenge we must not join, and
      // while we are duelling, the bystanders outside our own ring must not pull us off the opponent.
      if (arenaOf(e) !== myArena) continue;
      const dx = e.target.position.x - mx, dy = e.target.position.y - my;
      const d = Math.hypot(dx, dy) || 1;
      const er = e.target.size.x / 2;

      if (e.tier > me.tier) {
        if (d < CFG.dangerR) {
          const w = (CFG.dangerR - d) / CFG.dangerR;
          awayX -= dx / d * w; awayY -= dy / d * w;
          if (d < predatorD) { predatorD = d; predator = e; }
        }
        continue;
      }
      if (e.tier === me.tier) {
        // nose in my rear sector and pointed at me = going for my tail
        const aimed = -(dx * Math.cos(e.target.angle) + dy * Math.sin(e.target.angle));
        if (d < (mr + er) * 2.2 && dx * hx + dy * hy < mr * 0.5 && aimed > d * 0.5 && d < hunterD) {
          hunterD = d; hunter = e; hunterId = id;
        }
      }
      // attack candidate: see mkCand(). Only animals within reach of a real chase are offered.
      if (CFG.pvp) {
        const c = mkCand(id, e, me, now);
        if (c.td < CFG.engageR) cands.push(c);
      }
    }

    // The rear-sector gate flips off the instant we start turning toward the hunter, which would stall
    // the jink ~90 deg off (still showing our flank). Hold the same target until we are actually face-on.
    if (!hunter && bot.hunterId != null) {
      const e = E.get(bot.hunterId);
      if (e && e.spawned && !e.hole && e.tier === me.tier && arenaOf(e) === myArena) {
        const dx = e.target.position.x - mx, dy = e.target.position.y - my;
        const d = Math.hypot(dx, dy) || 1;
        const off = Math.abs(PVP.angleDelta(Math.atan2(dy, dx), mang));
        if (d < (mr + e.target.size.x / 2) * 2.6 && off > 0.35) { hunter = e; hunterId = bot.hunterId; }
      }
    }
    bot.hunterId = hunter ? hunterId : null;

    // attack-target hysteresis so two nearby tails can't flip control every tick (lock, not just hunterId)
    // the animal that is hunting our tail outranks a nearer snack: a duel is decided by who is actually
    // attacking, not by who happens to be closest. Only when the player has not picked someone themselves.
    // TargetLock only accepts a non-negative score, so clamp instead of letting the discount delete the hunter.
    if (CFG.retaliate && hunterId != null) for (const c of cands) if (c.id === hunterId) c.score = Math.max(1, c.score - CFG.hitWeight);

    let chosen = CFG.pvp ? bot.lock.choose(cands, now) : null;
    bot.targetKind = chosen ? 'auto' : null;
    if (CFG.pvp) {
      let forced = null;
      if (bot.pickId != null) {
        const p = E.get(bot.pickId);
        // The pick is the player's own order: it outranks tier, distance and the arena opponent, and it
        // is only ever dropped when the animal is gone. A bigger pick is warned about, not refused.
        if (!p || p === me || !p.spawned || p.hole) { bot.pickId = null; say('выбранная цель исчезла'); }
        else forced = mkCand(p.id, p, me, now);
      }
      if (!forced && CFG.autoDuel) {
        const opp = duelOpponent(me);
        // same tier only: the arena can pair us upward, and a bigger opponent is something to dodge, not bite
        if (opp && opp.spawned && !opp.hole && opp.tier <= me.tier) forced = mkCand(opp.id, opp, me, now);
      }
      if (forced) {
        chosen = forced;
        bot.targetKind = forced.id === bot.pickId ? 'manual' : 'duel';
        // hand the hysteresis lock to the forced id so releasing the pick does not re-decide from scratch
        if (bot.lock.id !== forced.id) { bot.lock.id = forced.id; bot.lock.since = now; }
      }
    }
    if ((bot.target && bot.target.id) !== (chosen && chosen.id) || !CFG.whip) {
      bot.whipReady = false;
    }
    bot.target = chosen ? chosen.e : null;
    bot.threat = predator || hunter || null;
    bot.tail = chosen ? chosen.tail : null;
    // The circle the client draws IS the wall the server burns you outside of, and the duel arena shrinks
    // while you fight, so the ring is re-read every frame: gap = our own margin (negative = already burning),
    // pickOut = the target is parked past it, which is a wall to drive against rather than a fight.
    bot.pickOut = false; bot.zoneSelfOut = false; bot.zoneGap = 0;
    if (arenaOf(me)) {
      const g = arenaRing(me);
      if (g) {
        bot.zoneR = g.R; bot.zoneLim = g.lim;
        const op = (me.target && me.target.position) || me.position;
        if (op) {
          const own = Math.hypot(op.x - g.c.x, op.y - g.c.y);
          bot.zoneGap = Math.round(g.R - own);
          bot.zoneSelfOut = own > g.R;
        }
        const q = chosen && chosen.e.target && chosen.e.target.position;
        if (q) bot.pickOut = Math.hypot(q.x - g.c.x, q.y - g.c.y) > g.R;
      }
    }

    if (CFG.dodge && predator) {
      bot.mode = 'evade';
      let vx = awayX, vy = awayY;
      if (vx * vx + vy * vy < 1e-6) { vx = mx - predator.target.position.x; vy = my - predator.target.position.y; }
      const bearing = Math.atan2(vy, vx) + Math.sin(now / 140) * CFG.weave;
      steer(M, me, mx + Math.cos(bearing) * 400, my + Math.sin(bearing) * 400);
      if (predatorD < CFG.fleeR) boost(M, me);
      return;
    }
    if (CFG.dodge && hunter) {
      // an equal-tier is lining up our tail: turn the nose onto it and keep it there, closing just enough
      // to stay nose-to-nose while the body snaps hard left-right so its tail-bite keeps missing.
      // (mope.io has no reverse/strafe -- the animal only ever drives toward the cursor.)
      bot.mode = 'jink';
      const hdx = hunter.target.position.x - mx, hdy = hunter.target.position.y - my;
      const hl = Math.hypot(hdx, hdy) || 1;
      const gx = hdx / hl, gy = hdy / hl;                       // unit toward the attacker
      const D = Math.max(mr * 1.2, Math.min(hl, mr * 2.4));     // advance a real distance, not inside our body
      const wag = Math.sin(now / CFG.faceWagMs) * CFG.jinkWeave * D;
      steer(M, me, mx + gx * D - gy * wag, my + gy * D + gx * wag);
      if (hl < mr * 1.9) boost(M, me);                          // dart to re-establish nose-to-nose
      return;
    }
    if (!chosen) {
      bot.mode = CFG.pvp ? 'seek' : 'manual';
      bot.diag = null;
      return;
    }

    const er = chosen.er, B = chosen.base, reach = mr + er;
    const geo = PVP.evaluateAttack(
      { x: mx, y: my, angle: mang }, { x: B.x, y: B.y, angle: B.angle },
      { mouthOffset: mr, tailOffset: er * CFG.tailFrac, biteDistance: er * CFG.biteReachFrac,
        rearHalfAngle: CFG.biteRearDeg * Math.PI / 180, maxHeadingError: CFG.biteHeadDeg * Math.PI / 180,
        frontDangerRadius: er * CFG.frontDangerFrac });
    bot.diag = { base: B, tail: chosen.tail, geo };

    const res = M.Ac && M.Ac.resource;
    // Guide rule 1 (conserve boosts): no finishing dart on a low tank, and rule 2 (be unpredictable):
    // never re-dash on the same rhythm -- a small alternating phase jitter spreads the cadence.
    const resBudget = !res || res.max <= 0 || res.value >= (CFG.dashMinRes + (bot.dashAlt ? 0.1 : 0)) * res.max;
    const boostReady = CFG.lunge && (now - bot.lastDash >= CFG.dashCdMs * (bot.dashAlt ? 1.25 : 1)) && resBudget;
    bot.dashAlt = !bot.dashAlt;
    // the hexagon darts must work even with the finishing-dart tuning off
    const whipReady = (now - bot.lastDash >= CFG.dashCdMs) &&
      (!res || res.max <= 0 || res.value >= CFG.dashMinRes * res.max);
    const tx = Math.cos(B.angle), ty = Math.sin(B.angle);
    const towardX = (B.x - mx) / (geo.centerDistance || 1), towardY = (B.y - my) / (geo.centerDistance || 1);

    // ---- v4 defensive states: an incoming dash and a kiting foe both outrank any attack commit ----
    const kiting = kiteOf(chosen.id, mx, my) && !stillFoe(chosen.id, now);
    const dashIn = dashOf(chosen.id, chosen.e, mx, my);
    const closing = closingRate(chosen.id, mx, my);   // null until the tracker has a sample of him
    // Latched ONCE per tick, in tick(), so the reflex and the orbit can never both claim a frame. Opens on
    // a body inside snapNearFrac sitting more than snapDeg off our own nose, closes at snapBackDeg - the
    // orbit's own resting angle - so a reflex cannot eat the lap it just interrupted.
    if (CFG.snapDeg < 180) {
      if (bot.snap) {
        if (Math.abs(geo.headingError) < CFG.snapBackDeg * Math.PI / 180) {
          bot.snap = false;
          // A pivot ends with the foe still on top of us, and the very next orbit tick would otherwise be a
          // dive (measured: pen 9 / jam 3 on the tight seeds). So the hand-back goes through the ring's own
          // emergency state: "inside the promise - back out and keep swinging", which clears itself the
          // moment the gap is legal again. The reflex borrows frames from the orbit; it does not spend it.
          bot.whipGuard = true;
        }
      }
      else if (Math.abs(geo.headingError) > CFG.snapDeg * Math.PI / 180 &&
               geo.centerDistance < reach * CFG.snapNearFrac &&
               (closing == null || closing > CFG.snapClosing)) { bot.snap = true; }
    }
    if (dashIn) {
      bot.dashSeenUntil = now + 400;
      bot.mode = 'dashdef';
      const s = defendStep(mx, my, B.x, B.y, reach, now);
      steer(M, me, s.x, s.y);
      if (CFG.dashDodge && now - bot.lastDodgeDash > 1200 && boost(M, me)) bot.lastDodgeDash = now;
      return;
    }
    // ---- TACTIC override: the selected guide move owns the frame, but the emergency pivot keeps its
    // priority (a tactic is a plan, a body on our tail is an emergency). The cursor point comes from
    // the pure PVP tactic functions; boost is the tactic's own request through the normal gate.
    if (CFG.pvp && CFG.tactic !== 'universal' && !bot.snap) {
      const T = CFG;
      const f = { x: B.x, y: B.y };
      const clos = closingRate(chosen.id, mx, my);
      let r = null;
      if (CFG.tactic === 'u') r = PVP.uMoonwalk({ x: mx, y: my }, f, reach, now,
        { cycleMs: T.tacticUCycleMs, turn: T.tacticUTurn });
      else if (CFG.tactic === 'windback') r = PVP.windback({ x: mx, y: my }, f, reach, now,
        { holdMs: T.tacticWindbackMs, backDeg: T.tacticWindbackDeg });
      else if (CFG.tactic === 'clockwork') r = PVP.clockwork({ x: mx, y: my }, f, reach, now,
        { lapMs: T.tacticClockMs, ringR: T.tacticClockR });
      else if (CFG.tactic === 'straight') r = PVP.straightMoonwalk({ x: mx, y: my }, f, reach, now,
        { holdMs: T.tacticStraightMs });
      else if (CFG.tactic === 'switchside') r = PVP.switchsideMoonwalk({ x: mx, y: my }, f, reach, now,
        { holdMs: T.tacticStraightMs, every: T.tacticSwitchEvery });
      else if (CFG.tactic === 'defboost') r = PVP.defensiveBoost({ x: mx, y: my }, f, reach, now,
        { triggerR: T.tacticDefBoostR }, clos);
      else if (CFG.tactic === 'bait') r = PVP.bait({ x: mx, y: my }, f, reach, now,
        { gapR: T.tacticBaitGap });
      if (r) {
        bot.mode = 'tactic:' + CFG.tactic;
        steer(M, me, r.x, r.y, r.boost && boostReady ? { lap: bot.whipLap, target: bot.target } : null);
        if (r.boost && boostReady) { boost(M, me); bot.lastDash = now; }
        return;
      }
    }
    if (CFG.whip && !bot.snap && now > bot.dashSeenUntil) {
      bot.mode = 'whip';
      const w = whipStep(mx, my, B, reach, now, mang);
      const hop = w.dart && CFG.whipDart && whipReady
        ? { lap: bot.whipLap, target: bot.target } : null;
      steer(M, me, w.x, w.y, hop);
      return;
    }
    if (kiting) {
      // foe faces us and backs off: committing now walks our nose into its turn. Swing wide around it and
      // hold the standoff ring -- the old version parked the cursor on its centre and then nosed into it.
      bot.mode = 'bait';
      const b = orbitPoint(mx, my, B, Math.sin(now / CFG.faceWagMs) * CFG.diamondWeave,
        Math.max(reach * CFG.aimLeadFrac, geo.centerDistance - reach * CFG.baitGap));
      steer(M, me, b.x, b.y);
      return;
    }

    // 1. geometrically behind it (rear cone) -> drive the nose through the predicted tail. Boost/ability
    //    only fires once the mouth is actually within bite reach AND roughly aligned, not just in-sector.
    if (geo.inRearSector) {
      bot.mode = 'bite';
      // aim just outside the tail, not past it: driving the cursor through the body is what made the bot
      // sit inside the foe instead of biting the end of it.
      steer(M, me, chosen.tail.x + tx * mr * CFG.biteLeadFrac, chosen.tail.y + ty * mr * CFG.biteLeadFrac);
      if (boostReady && !kiting && geo.mouthToTail <= er * CFG.biteReachFrac && geo.aligned) boost(M, me);
      return;
    }

    // 2. finishing dart: not proximity alone -- require the tail is reachable this dash, our heading is
    //    already near the intercept, and the line to it doesn't run through the target's head zone.
    if (boostReady && !kiting && now > bot.dashSeenUntil && geo.centerDistance < reach * 2.4 && geo.frontPathClear &&
        geo.mouthToTail < reach * 3 && Math.abs(geo.headingError) <= CFG.lungeHeadDeg * Math.PI / 180) {
      bot.mode = 'lunge';
      steer(M, me, chosen.tail.x + towardX * reach * CFG.lungeThrough,
        chosen.tail.y + towardY * reach * CFG.lungeThrough);
      boost(M, me);
      return;
    }

    // One PvP system, not three switches: far from the target we close face-first with a tight weave,
    // and inside CFG.feintR the same move widens into the diamond feint that sets up the dip.
    if (kiting === false && stillFoe(chosen.id, now)) {
      // The foe is parked: stop feinting, take the spot behind his tail and chew. The cursor sits a short
      // way PAST the tail on his own heading line and shakes left-right there, so the mouth is always on
      // the rear and the existing bite geometry does the actual closing.
      bot.mode = 'stalk';
      const wob = Math.sin(now / CFG.faceWagMs * Math.PI * 2) * CFG.stalkWeave;
      // his tail sits on the FAR side of his body from his nose, so the cursor line is his own heading
      // reversed, and it stops just past the tail rather than under his body
      const rear = B.angle + Math.PI + wob;
      const sd = Math.max(reach * CFG.aimLeadFrac,
        Math.hypot(chosen.tail.x - mx, chosen.tail.y - my) + reach * CFG.stalkGap);
      const st = orbitPoint(mx, my, B, rear - Math.atan2(B.y - my, B.x - mx), sd);
      steer(M, me, st.x, st.y);
      if (boostReady && !geo.inRearSector && geo.centerDistance > reach * 1.4) boost(M, me);
      return;
    }
    // ---- SNAP-TURN: a body is on our tail and close enough to bite. An orbit is a promise about
    // DISTANCE; a foe already inside it has called the promise, and the answer is not a wider arc but to
    // stop orbiting and turn. Rotation here is bought with cursor angle, not with boost: past 90 deg off
    // our own nose the client cuts speed to 35% while the heading still swings at the full 4 rad/s clamp,
    // so the body pivots on a circle of v/omega = 84/4 = 21 units and looks at him inside a third of a
    // second instead of finishing the lap first. Placed AFTER bite/lunge/stalk (take a bite we already
    // have) and BEFORE the orbit; the cursor sits on HIS line at the range we have, so we turn without
    // driving into the model that just landed on us.
    if (bot.snap) {
      bot.mode = 'snap';
      const phiOut = Math.atan2(B.y - my, B.x - mx);
      const head = Number.isFinite(mang) ? mang : phiOut;
      const dir = geo.headingError > 0 ? 1 : -1;                    // come round the SHORT way
      const off = Math.min(Math.abs(geo.headingError), CFG.snapLeadDeg * Math.PI / 180);
      const sv = orbitPoint(mx, my, B, head + dir * off - phiOut,
        Math.max(reach * CFG.aimLeadFrac, geo.centerDistance));
      steer(M, me, sv.x, sv.y);
      return;
    }
    const feint = CFG.diamond && geo.centerDistance < reach * CFG.feintR;
    bot.mode = feint ? 'diamond' : 'face';
    // The cursor is a vector from OUR nose again: an angle off the foe line (the wag) and a length that
    // stops on the standoff ring, so we weave AROUND the foe instead of parking our body inside it. The
    // feint is the same move swung wider and closer; the plain approach keeps the nose nearly on target.
    const wag = Math.sin(now / CFG.faceWagMs) * (feint ? CFG.diamondWeave : CFG.pvpWeave);
    const p = orbitPoint(mx, my, B, wag,
      Math.max(reach * CFG.aimLeadFrac, geo.centerDistance - reach * CFG.approachGap));
    steer(M, me, p.x, p.y);
    if (CFG.pvpFast) boost(M, me);
  }
  // A changed field name in the next game build must not switch the whole combat system off in silence:
  // the throw is caught, shown in the status line, and the next frame simply tries again.
  setInterval(() => {
    try { tick(); bot.err = ''; }
    catch (e) { bot.err = String((e && (e.message || e)) || 'tick'); }
  }, CFG.tickMs);
  window.__MOPE_TICK = tick;   // test-rig hook: advance one decision cycle under a virtual clock
  // test-rig hooks for the steering pump. The rig owns the virtual clock, so the pump's own setTimeout
  // cannot fire inside a scenario: __MOPE_WHEEL says WHEN the send is allowed, __MOPE_PUMP runs it at that
  // instant, __MOPE_RELEASE makes sure no armed pump escapes into wall-clock time once the scenario ends.
  window.__MOPE_PUMP = pumpWheel;
  window.__MOPE_RELEASE = releaseWheel;
  window.__MOPE_WHEEL = () => (wheel.timer
    ? { pending: true, due: bot.lastSteer + wheelMs(wheel.M, wheel.me), x: wheel.x, y: wheel.y }
    : { pending: false, due: 0, x: wheel.x, y: wheel.y });
  window.__MOPE_MODE = () => bot.mode;   // test-rig hook: which PvP phase the bot is in
  window.__MOPE_SNAP = () => !!bot.snap;  // test-rig hook: is the emergency pivot owning this tick
  // test-rig hooks: which entity the lock actually picked, the cursor we read back from opcode 114,
  // and a way to drive the internal-only tuning so a single PvP phase can be measured in isolation.
  window.__MOPE_TARGET = () => (bot.target ? bot.target.id : null);
  window.__MOPE_CURSOR = () => (bot.cursor ? { x: Math.round(bot.cursor.x), y: Math.round(bot.cursor.y) } : null);
  window.__MOPE_CFG = o => Object.assign(CFG, o);
  // snapshot taken before any test can mutate CFG, so the rig re-applies the shipped values instead of
  // hardcoding a copy that would silently drift away from the product.
  const TUNE_KEYS = ['pvpFast', 'lunge', 'diamond', 'tierWeight', 'cursorWeight', 'dashDodge',
    'kiteAim', 'kiteBack', 'dashClose', 'defPhaseMs', 'defStep',
    'whipR', 'whipCycleMs', 'whipFaceFrac', 'whipStepDeg', 'whipWag', 'whipArc', 'whipOrbitDeg', 'whipSwingDeg',
    'whipKGain', 'whipLeadDeg', 'whipBrakeFrac', 'whipBrakeDeg', 'whipBrakeLeadDeg', 'whipGuardFrac', 'whipHopFrac', 'whipHopNoseDeg', 'aimLeadFrac', 'whipDart', 'whipFlipMinMs', 'whipFlipMaxMs', 'whipFlipClearFrac', 'whipSnap', 'whipTwerkEvery', 'whipTwerkMs', 'whipTwerkDeg', 'whipDefEvery', 'whipDefNearFrac', 'whipDiveFrac', 'snapDeg', 'snapLeadDeg', 'snapBackDeg', 'snapNearFrac', 'snapClosing',
    'stalkHoldMs', 'stalkSpeed', 'stalkGap', 'stalkWeave',
    'approachGap', 'baitGap', 'biteLeadFrac', 'lungeThrough', 'faceWagMs', 'pvpWeave', 'diamondWeave', 'zoneMarginFrac'];
  const TUNE_DEFAULTS = TUNE_KEYS.reduce((o, k) => (o[k] = CFG[k], o), {});
  window.__MOPE_TUNE_DEFAULTS = () => Object.assign({}, TUNE_DEFAULTS);
  window.__MOPE_WHIP = () => ({ dir: bot.whipDir, k: bot.whipK, switches: bot.whipSwitches,
    flips: bot.whipFlips, lap: bot.whipLap, twerk: !!bot.whipTwerk, def: !!bot.whipDef,
    flipIn: Math.max(0, Math.round(bot.whipNextFlipAt - performance.now())) });
  window.__MOPE_BINDS = () => Object.assign({}, CFG.binds);
  window.__MOPE_ZONE = () => ({ r: Math.round(bot.zoneR), lim: Math.round(bot.zoneLim), gap: bot.zoneGap,
    out: bot.zoneOut, selfOut: bot.zoneSelfOut, pulls: bot.zonePulls });
  window.__MOPE_RESET = () => { bot.lastDash = bot.lastAb1 = 0; bot.hunterId = null; releaseWheel(); resetMotion(); };
  // test-rig introspection: prove the motion estimator is actually fed (measured velocity != raw snapshot)
  window.__MOPE_DIAG = () => (bot.diag ? {
    measured: !!bot.diag.base.measured, vx: bot.diag.base.vx, vy: bot.diag.base.vy, omega: bot.diag.base.omega,
    ageMs: bot.diag.base.ageMs, rear: bot.diag.geo.inRearSector, m2t: Math.round(bot.diag.geo.mouthToTail),
    headErrDeg: +(Math.abs(bot.diag.geo.headingError) * 180 / Math.PI).toFixed(1), frontClear: bot.diag.geo.frontPathClear,
  } : null);
  window.__MOPE_MOTION = id => { const st = bot.tracker && bot.tracker.get(id); return st ? { vx: st.vx, vy: st.vy, omega: st.omega, intervals: st.intervals, receivedAt: st.receivedAt } : null; };

  // ------------------------------------------------------------ overlay
  const overlay = document.createElement('canvas');
  overlay.id = 'mopeCheatOverlay';
  Object.assign(overlay.style, { position: 'fixed', inset: '0', width: '100vw', height: '100vh', pointerEvents: 'none', zIndex: '2147483647' });
  const ctx = overlay.getContext('2d');

  function fit() {
    const dpr = window.devicePixelRatio || 1;
    overlay.width = Math.round(window.innerWidth * dpr);
    overlay.height = Math.round(window.innerHeight * dpr);
  }
  window.addEventListener('resize', fit);
  fit();

  const COLOR = { predator: '#ff4d4d', prey: '#4dff88', same: '#ffd24d', self: '#4ddbff' };

  // corner minimap: every animal plotted as a tier-coloured dot relative to us, camera-independent
  function drawRadar(E, me, W, H) {
    const R = 110, cx = W - R - 18, cy = H - R - 18, range = CFG.radarRange || 2600;
    const px = me.position.x, py = me.position.y, scale = R / range;
    ctx.save();
    ctx.fillStyle = 'rgba(10,12,16,0.72)';
    ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = '#3a3f4a'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.stroke();
    for (const f of [0.34, 0.67]) { ctx.beginPath(); ctx.arc(cx, cy, R * f, 0, Math.PI * 2); ctx.stroke(); }
    ctx.beginPath();
    ctx.moveTo(cx - R, cy); ctx.lineTo(cx + R, cy);
    ctx.moveTo(cx, cy - R); ctx.lineTo(cx, cy + R);
    ctx.stroke();
    ctx.beginPath(); ctx.arc(cx, cy, R - 1, 0, Math.PI * 2); ctx.clip();
    for (const e of E.values()) {
      if (e === me || !e.spawned) continue;
      const dx = (e.position.x - px) * scale, dy = (e.position.y - py) * scale;
      ctx.fillStyle = e.tier > me.tier ? COLOR.predator : e.tier < me.tier ? COLOR.prey : COLOR.same;
      const rr = Math.max(2, Math.min(4, (e.target.size.x / 2) * scale * 3));
      ctx.beginPath(); ctx.arc(cx + dx, cy + dy, rr, 0, Math.PI * 2); ctx.fill();
    }
    ctx.restore();
    ctx.fillStyle = COLOR.self;
    ctx.beginPath(); ctx.arc(cx, cy, 3, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = COLOR.self; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(cx + Math.cos(me.angle) * 11, cy + Math.sin(me.angle) * 11); ctx.stroke();
    ctx.fillStyle = '#8892a0'; ctx.font = '10px monospace';
    ctx.fillText('радар ' + range, cx - R + 6, cy - R + 12);
  }

  function paint() {
    const dpr = window.devicePixelRatio || 1;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, overlay.width, overlay.height);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.lineWidth = 1.5;
    ctx.font = '11px monospace';
    const W = overlay.width / dpr, H = overlay.height / dpr;
    const M = window.__M, E = window.__ENTS;
    const me = M && M.zy, cam = M && M.Ar, canvas = cam && cam.canvas;
    if (!E || !me) return;
    // camera maths are needed by ESP AND by the PvP overlay (cursor mark, target ring, bite line), so the
    // gate is the camera, not the ESP switch: turning ESP off must not blind the combat diagnostics.
    const camOk = canvas && canvas.clientWidth > 0 && typeof cam.tq === 'function';
    // cam.tq returns BACKING-BUFFER (device) px; k = device px per CSS px. Convert exactly once, then
    // shift by the canvas' viewport offset (the game canvas is not guaranteed to fill the screen).
    const k = canvas ? canvas.width / canvas.clientWidth : 1;
    const rect = (canvas && typeof canvas.getBoundingClientRect === 'function') ? canvas.getBoundingClientRect() : { left: 0, top: 0 };
    const unit = cam ? cam.zoom / k : 1;
    const screen = (x, y) => { const p = cam.tq(x, y); return { x: p.x / k + (rect.left || 0), y: p.y / k + (rect.top || 0) }; };
    const ring = (s, r, color) => {
      ctx.strokeStyle = color;
      ctx.beginPath();
      ctx.arc(s.x, s.y, r, 0, Math.PI * 2);
      ctx.stroke();
    };

    if (camOk) {
    if (CFG.esp) {
    for (const e of E.values()) {
      if (e === me || !e.spawned) continue;
      const s = screen(e.position.x, e.position.y);
      const r = Math.max(5, e.target.size.x / 2 * unit);
      const color = e.tier > me.tier ? COLOR.predator : e.tier < me.tier ? COLOR.prey : COLOR.same;
      const onScreen = s.x > -r && s.x < W + r && s.y > -r && s.y < H + r;
      if (!onScreen) {
        if (e.tier <= me.tier) continue;
        // predator off screen: marker on the rim
        const cx = W / 2, cy = H / 2, bearing = Math.atan2(s.y - cy, s.x - cx);
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(cx + Math.cos(bearing) * (cx - 16), cy + Math.sin(bearing) * (cy - 16), 5, 0, Math.PI * 2);
        ctx.fill();
        continue;
      }
      ring(s, r, color);
      ctx.beginPath();                       // facing tick
      ctx.moveTo(s.x, s.y);
      ctx.lineTo(s.x + Math.cos(e.angle) * r * 1.35, s.y + Math.sin(e.angle) * r * 1.35);
      ctx.stroke();
      if (CFG.labels) {
        ctx.fillStyle = color;
        ctx.fillText(`${e.species} t${e.tier} ${Math.round(e.target.health)}%${e.name && e.name.text ? ' ' + e.name.text : ''}`, s.x + r + 3, s.y - r - 3);
      }
      // ESP draws the interpolated e.position; the bot acts on the server snapshot. Show the gap.
      const sp = screen(e.target.position.x, e.target.position.y);
      if (Math.hypot(sp.x - s.x, sp.y - s.y) > 3) { ctx.fillStyle = '#ffffff'; ctx.fillRect(sp.x - 1.5, sp.y - 1.5, 3, 3); }
    }
    }

    const self = screen(me.position.x, me.position.y);
    if (CFG.esp) ring(self, 8, COLOR.self);
    const line = (to, color) => {
      const s = screen(to.x, to.y);
      ctx.strokeStyle = color;
      ctx.setLineDash([6, 5]);
      ctx.beginPath();
      ctx.moveTo(self.x, self.y);
      ctx.lineTo(s.x, s.y);
      ctx.stroke();
      ctx.setLineDash([]);
    };
    if (CFG.pvp && bot.cursor) {                       // where the player is pointing (read from opcode 114)
      const c = screen(bot.cursor.x, bot.cursor.y);
      ctx.strokeStyle = 'rgba(102,255,204,0.75)';
      ctx.beginPath();
      ctx.moveTo(c.x - 7, c.y); ctx.lineTo(c.x + 7, c.y);
      ctx.moveTo(c.x, c.y - 7); ctx.lineTo(c.x, c.y + 7);
      ctx.stroke();
    }
    // The duel wall itself, redrawn from live data every frame, so a shrinking ring is visible as it
    // happens. Its pixel radius is measured through the same projection instead of trusting cam.zoom.
    if (arenaOf(me)) {
      const g = arenaRing(me);
      if (g) {
        const c = screen(g.c.x, g.c.y), e1 = screen(g.c.x + 100, g.c.y);
        const px = Math.hypot(e1.x - c.x, e1.y - c.y) / 100 * g.R;
        if (px > 4) ring(c, px, bot.zoneSelfOut ? 'rgba(255,70,70,0.95)'
