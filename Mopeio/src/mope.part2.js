      if (child && child.tagName === 'IFRAME' && child.hidden === true &&
          child.getAttribute('aria-hidden') === 'true' && child.contentWindow) {
        patchGameRealm(child.contentWindow);
      }
    } catch (_) {}
    return node;
  };

  function mark(sock) {
    let rec = tap.socks.get(sock);
    if (rec) return rec;
    rec = { handlers: [] };
    // trim the FIFO of tracked sockets, but never evict the socket we are wiring up or the one the
    // poll is injecting into -- clearing them would leave inject() reading an empty rec forever
    while (tap.socks.size > 8) {
      const oldest = tap.socks.keys().next().value;
      if (oldest === undefined || oldest === sock || oldest === tap.socket) break;
      tap.socks.delete(oldest);
    }
    tap.socks.set(sock, rec);
    tap.socket = sock;
    // the hook can land once the client has registered its message handler for this socket
    const started = performance.now();
    const poll = () => {
      if (window.__HOOKED || performance.now() - started > 60000 || tap.socket !== sock) return;
      inject();
      setTimeout(poll, 400);
    };
    setTimeout(poll, 400);
    return rec;
  }

  function inject() {
    const rec = tap.socks.get(tap.socket);
    if (!rec || rec.handlers.length === 0) return;
    // Function('Game', src)($) runs src as a body, so it must be a CALL, not a bare
    // function expression: '(' + src + ')' alone builds the closure and discards it.
    const src = new TextEncoder().encode('(' + hookPayload.toString() + ')(Game)');
    const frame = new Uint8Array(3 + src.length);
    frame[0] = 205;
    frame[1] = src.length & 255;
    frame[2] = src.length >> 8;
    frame.set(src, 3);
    for (const fn of rec.handlers.slice()) {
      try { fn({ isTrusted: true, data: frame.buffer }); } catch (_) {}
    }
  }

  // Runs inside the client as Function('Game', src)($). No closure access here: window only.
  function hookPayload(Game) {
    var w = window, G = Game;
    w.__M = G;
    var E = w.__ENTS || (w.__ENTS = new Map());
    var reg = G.zt && G.zt.animals;
    if (!reg) return;
    var classes = [];
    for (var k in reg) classes.push(reg[k]);
    for (var i = 0; i < classes.length; i++) {
      var cur = classes[i], base = null;
      while (typeof cur === 'function' && cur.prototype) {
        var parent = Object.getPrototypeOf(cur.prototype);
        if (parent && typeof parent.synchronize === 'function' && typeof parent.Qn === 'function') {
          cur = parent.constructor;
          continue;
        }
        base = cur.prototype;
        break;
      }
      if (!base || typeof base.synchronize !== 'function' || typeof base.Qn !== 'function') continue;
      if (!base.__mopeHook) {
        var sync = base.synchronize, qn = base.Qn;
        function forceSkin(e) {
          var id = w.__MOPE_SKIN | 0;
          if (!id) return;
          var s = G.zy;
          // The sprite path (get Ag -> zg(animalConfig, subspecies)) is baked into the textures
          // inside init(); setting .subspecies alone leaves the old skin. Re-run init on the SELF
          // entity only, only when the pinned id changes, guarded: this is a local self-view recolor.
          if (s && (e === s || e.id === s.id) && e.__mopeSkinId !== id) {
            e.__mopeSkinId = id;
            try {
              e.subspecies = id;
              if (typeof e.init === 'function') e.init();
            } catch (_) {}
          }
        }
        // capture the raw server snapshot the instant a packet applies it: this is what feeds the
        // motion tracker (real receivedAt + sample), distinct from the interpolated render position.
        function note(e) {
          var p = e.target && e.target.position;
          if (!p) return;
          e.__mopeSeq = (e.__mopeSeq | 0) + 1;
          e.__mopeSample = { x: p.x, y: p.y, angle: e.target.angle, t: performance.now(), n: e.__mopeSeq };
        }
        base.synchronize = function () {
          var out = sync.apply(this, arguments);
          if (this.type === 'animal') { E.set(this.id, this); note(this); forceSkin(this); }
          return out;
        };
        base.Qn = function () {
          var out = qn.apply(this, arguments);
          if (this.type === 'animal') { E.set(this.id, this); note(this); forceSkin(this); }
          return out;
        };
        base.__mopeHook = true;
      }
      w.__HOOKED = true;
      return;
    }
  }

  // ------------------------------------------------------------ output
  const bot = { mode: 'off', target: null, threat: null, tail: null, holdUntil: 0, hunterId: null,
    lastSteer: 0, lastDash: 0, lastAb1: 0, lastX: NaN, lastY: NaN, cursor: null,
    tracker: null, lock: null, seq: new Map(), lastHf: null, diag: null,
    // click-to-target: pickId is the animal the player chose, pickArmed the deadline for the pending
    // click, targetKind how the current target was decided ('manual' | 'duel' | 'auto').
    pickId: null, pickArmed: 0, targetKind: null, pickMsg: '', pickMsgUntil: 0,
    whipK: 0, whipDir: 1, whipBase: 0, whipStepPhi: 0, whipHopAt: 0, whipVertexAt: 0, whipNextFlipAt: 0,
    whipSwitches: 0, whipFlips: 0, lastDodgeDash: 0, dashSeenUntil: 0, snap: false,
    whipTwerk: false, whipLap: 0, whipDef: false,
    zoneR: 0, zoneLim: 0, zonePulls: 0, zoneOut: 0, zoneSelfOut: false, zoneGap: 0, pickOut: false,
    blk: '', err: '' };
  // display-only labels; the internal bot.mode strings stay English so the test hooks keep working
  const MODE_RU = { off: 'выкл', seek: 'поиск', manual: 'ручной', evade: 'уход', guard: 'защита', jink: 'тряска', bite: 'укус', lunge: 'рывок', diamond: 'ромб', face: 'лицом', bait: 'байт', dashdef: 'деф', whip: 'вихрь', snap: 'поворот в лицо', stalk: 'в спину' };
  const zx = { net: null, orig: null };

  function net(M) {
    const n = M.Hf;
    if (!n || typeof n.zx !== 'function') return null;
    if (zx.net !== n) {
      zx.net = n;
      zx.orig = n.zx;
      n.zx = wrappedZx;                     // own property shadows the prototype method
    }
    return n;
  }

  function wrappedZx(op, payload, flag) {
    if (op === 114) {
      // the client's own pointer packet IS the mouse position, in the same 16-bit form we send: read it
      // back so target choice follows what the player aims at. The bot sends through zx.orig, so this
      // only ever sees cursor packets, never our own steering.
      const M = window.__M, b = M && M.fw && M.fw.bounds && M.fw.bounds.max;
      if (b && payload && Number.isFinite(payload.Jb) && Number.isFinite(payload.zd)) {
        bot.cursor = { x: payload.Jb / 65535 * b.x, y: payload.zd / 65535 * b.y, t: performance.now() };
      }
      if (performance.now() < bot.holdUntil) return this;    // the bot holds the wheel: drop the cursor
    }
    return zx.orig.call(this, op, payload, flag);
  }

  function send(M, op, payload) {
    if (!M) return false;               // boost/ability release fires on a timeout that may outlive the socket
    const n = net(M);
    if (!n) return false;
    zx.orig.call(n, op, payload);
    return true;
  }

  // same normalisation as Mc.toPrecision for 16 unsigned bits
  function prec(v, max) {
    if (!(max > 0)) return 0;
    if (v < 0) v = 0; else if (v > max) v = max;
    return Math.round(v / max * 65535);
  }

  // Deciding where to go and pushing the packet out are two different jobs. They used to be one: steer()
  // rate-limited itself, so a point computed a hair before the next allowed boundary was DISCARDED and the
  // next attempt had to wait for the following tick. At a 16ms tick that capped the arena at ~62 sends/s
  // against the 120/s the client itself may use, and low tier at ~21/s against 30 -- the bot was slowest
  // exactly where sharpness matters. Now steer() only parks the freshest point in `wheel` (no queue, the
  // newest decision wins) and pumpWheel() releases a point on the game's own boundary.
  const wheel = { x: NaN, y: NaN, timer: 0, M: null, me: null, hf: null };
  // the client's native input pace, i.e. the bundle's uA(): arena or top tier streams at maxEventRate,
  // then 60, then 30 Hz. This is the SERVER's tolerance: the pump spaces sends by it, never beats it.
  function wheelMs(M, me) {
    const high = !!arenaOf(me) || me.tier >= 15;
    return 1000 / (high ? (M.Yw && M.Yw.maxEventRate || 120) : me.tier >= 10 ? 60 : 30);
  }
  // Transaction order stays fixed so a failed dispatch never steals the wheel: validate -> send -> and ONLY
  // THEN commit lastSteer / lastX/Y / holdUntil. The bot's own 114 goes through send() -> zx.orig, which
  // bypasses the wrappedZx suppression (verified, not assumed). There is deliberately no lastX/lastY
  // de-dup here: the pump has to cross every boundary even when the point did not move, and de-dup used to
  // swallow the first commands after a respawn.
  function pumpWheel() {
    wheel.timer = 0;                                  // this callback owns the id: forget it first
    const M = wheel.M, me = wheel.me;
    if (!M || !me || !me.spawned) return;             // a parked point must never yank a fresh animal
    if (M.Hf !== wheel.hf) { wheel.x = wheel.y = NaN; return; }  // reconnected: the point belongs to a dead socket
    const b = M.fw && M.fw.bounds && M.fw.bounds.max;
    // the world bounds are what turns a world point into the 16-bit packet: without them nothing moves
    if (!b || !(b.x > 0) || !(b.y > 0)) { wheel.x = wheel.y = NaN; return; }
    if (!Number.isFinite(wheel.x) || !Number.isFinite(wheel.y)) return;
    const interval = wheelMs(M, me);
    const wait = bot.lastSteer + interval - performance.now();
    // THE fix: early means WAIT, not drop. Newer steer() calls overwrite the parked point while we wait.
    if (wait > 0.5) { wheel.timer = setTimeout(pumpWheel, wait); return; }
    let x = wheel.x, y = wheel.y;
    if (arenaOf(me)) { const z = arenaKeepInside(me, x, y); x = z.x; y = z.y; }  // never steer out of the ring
    const cx = PVP.clamp(x, 0, b.x), cy = PVP.clamp(y, 0, b.y);
    if (!send(M, 114, { Jb: prec(cx, b.x), zd: prec(cy, b.y) })) { bot.blk = 'нет сокета'; return; }
    bot.blk = '';
    const sent = performance.now();
    bot.lastSteer = sent; bot.lastX = cx; bot.lastY = cy;             // commit only after success
    // holdUntil has to span the WHOLE next gap, not this instant: if it lapsed while the pump was waiting,
    // wrappedZx would stop muting the client's op114 and the player's raw mouse would fight the bot again.
    bot.holdUntil = sent + interval + CFG.tickMs * 2 + 10;
    wheel.x = wheel.y = NaN;
    const hop = wheel.hop;
    wheel.hop = null;
    if (hop && CFG.whip && bot.mode === 'whip' && bot.whipReady &&
        hop.lap === bot.whipLap && hop.target === bot.target && !bot.whipHopped && boost(M, me)) {
      bot.whipHopAt = sent;
      bot.whipHopped = true;
    }
  }

  function steer(M, me, x, y, hop = null) {
    if (!Number.isFinite(x) || !Number.isFinite(y)) { releaseWheel(); bot.blk = 'nan steer'; return false; }
    const b = M && M.fw && M.fw.bounds && M.fw.bounds.max;
    if (!b || !Number.isFinite(b.x) || !Number.isFinite(b.y) || !(b.x > 0) || !(b.y > 0)) {
      releaseWheel(); bot.blk = 'нет bounds'; return false;
    }
    wheel.hop = hop;
    wheel.M = M; wheel.me = me; wheel.hf = M.Hf; wheel.x = x; wheel.y = y;
    if (!wheel.timer) pumpWheel();      // nothing armed: find out right now whether this point has to wait
    return true;
  }

  function boost(M, me) {
    const now = performance.now();
    if (now - bot.lastDash < CFG.dashCdMs) return false;
    const res = M.Ac && M.Ac.resource;
    if (res && res.max > 0 && res.value < CFG.dashMinRes * res.max) return false;
    if (!send(M, 192)) return false;
    bot.lastDash = now;
    const n = net(M);
    setTimeout(() => send(n === M.Hf ? M : null, 219), CFG.dashHoldMs);
    if (CFG.ability && now - bot.lastAb1 >= 3000) {
      bot.lastAb1 = now;
      send(M, 217);
      setTimeout(() => send(n === M.Hf ? M : null, 152), 200);
    }
    return true;
  }

  // Let go of the wheel so the user's cursor flows again; used when the bot can't or shouldn't steer. The
  // parked point and the armed pump go with it -- tick() already calls this whenever me.spawned is false,
  // and without the cancel a deferred packet would fire a moment after the respawn and yank the new
  // animal toward the old fight.
  function releaseWheel() {
    if (wheel.timer) clearTimeout(wheel.timer);
    wheel.timer = 0; wheel.x = wheel.y = NaN; wheel.M = wheel.me = wheel.hf = wheel.hop = null;
    bot.holdUntil = 0; bot.lastSteer = 0; bot.lastX = bot.lastY = NaN;
    bot.whipReady = false;
  }
  // motion + targeting state is meaningless across a respawn / reconnect: drop every snapshot and lock.
  function resetMotion() {
    bot.tracker && bot.tracker.clear(); bot.lock && bot.lock.reset(); bot.seq.clear(); bot.diag = null;
    bot.pickId = null; bot.pickArmed = 0; bot.targetKind = null;   // entity ids belong to the old round
    bot.whipK = 0; bot.whipDir = 1; bot.whipVertexAt = 0; bot.whipNextFlipAt = 0;
    bot.whipGuard = false; bot.snap = false;
    bot.whipStepPhi = 0; bot.whipHopAt = 0;
    bot.whipLap = 0; bot.whipTwerk = false; bot.whipDef = false;   // the lap counter owns the beat schedule
    bot.whipSwitches = 0; bot.whipFlips = 0; bot.dashSeenUntil = 0; bot.lastDodgeDash = 0;
    bot.zoneR = 0; bot.zoneLim = 0; bot.zonePulls = 0; bot.zoneOut = 0; bot.pickOut = false;
    bot.zoneSelfOut = false; bot.zoneGap = 0;
  }

  function say(msg) { bot.pickMsg = msg; bot.pickMsgUntil = performance.now() + 4000; }

  function entName(e) {
    if (!e) return 'нет';
    return (e.name && e.name.text) || ((e.species || 'зверь') + ' #' + e.id);
  }

  // kiting: nose on us, body drifting backwards. Velocity from the MotionTracker (units/s).
  function kiteOf(id, mx, my) {
    const st = bot.tracker && bot.tracker.get(id);
    if (!st || st.intervals < 1) return false;          // no measurement yet -> never guess
    const dx = mx - st.x, dy = my - st.y, d = Math.hypot(dx, dy) || 1;
    const hx = Math.cos(st.angle), hy = Math.sin(st.angle);
    const aimed = (hx * dx + hy * dy) / d;              // 1 = its nose exactly on us
    const back = -(st.vx * hx + st.vy * hy);            // >0 = drifting against its own nose
    return aimed > CFG.kiteAim && back > CFG.kiteBack;  // UNCALIBRATED
  }
  // Standing still long enough = an AFK snack, not a duellist. Read from the tracker only (never a guess
  // from our own position) and it needs BOTH gates: the smoothed velocity and a position that genuinely
  // has not changed -- an animal that shuffles in place still fails the second one.
  function stillFoe(id, now) {
    const st = bot.tracker && bot.tracker.get(id);
    if (!st || st.intervals < 2) return false;
    return Math.hypot(st.vx, st.vy) < CFG.stalkSpeed && (now - st.positionChangedAt) > CFG.stalkHoldMs;
  }
  // incoming dash: server flag OR closing speed. The flag is only set when equippedItemId is
  // non-empty in the client, so it can never be the sole detector.
  function dashOf(id, e, mx, my) {
    if (e && e.status && e.status.boosting === true) return true;
    const st = bot.tracker && bot.tracker.get(id);
    if (!st || st.intervals < 1) return false;
    const dx = mx - st.x, dy = my - st.y, d = Math.hypot(dx, dy) || 1;
    return (st.vx * dx + st.vy * dy) / d > CFG.dashClose;   // UNCALIBRATED, units/s
  }
  // The same number dashOf thresholds, as a rate: units/s the foe is spending on the line toward us.
  // Positive = closing. null = the tracker has no fresh sample of him yet, which must never be read as
  // "safe" -- an unseen body is exactly the one that lands on a tail.
  function closingRate(id, mx, my) {
    const st = bot.tracker && bot.tracker.get(id);
    if (!st || st.intervals < 1) return null;
    const dx = mx - st.x, dy = my - st.y, d = Math.hypot(dx, dy) || 1;
    return (st.vx * dx + st.vy * dy) / d;
  }
  // 3-tap defend cycle: [0]=short back tap (cursor near our own tail), [1]=left tap, [2]=right tap.
  // mope.io has no reverse gear: the animal only drives toward the cursor. Taps are shorter than
  // the turn animation, so the nose never completes a turn -- it jitters around the attacker
  // while the body shuffle-steps backwards.
  function defendStep(mx, my, ex, ey, reach, now) {
    const tx = ex - mx, ty = ey - my, tl = Math.hypot(tx, ty) || 1;
    const t = { x: tx / tl, y: ty / tl }, n = { x: -t.x, y: -t.y }, p = { x: -t.y, y: t.x };
    const ph = Math.floor(now / CFG.defPhaseMs) % 3;
    let d;
    if (ph === 0)      d = { x: n.x * 0.9 + t.x * 0.15, y: n.y * 0.9 + t.y * 0.15 };
    else if (ph === 1) d = { x: p.x + t.x * 0.35,       y: p.y + t.y * 0.35 };
    else               d = { x: -p.x + t.x * 0.35,      y: -p.y + t.y * 0.35 };
    const dl = Math.hypot(d.x, d.y) || 1, R = reach * CFG.defStep;
    return { x: mx + d.x / dl * R, y: my + d.y / dl * R };
  }
  // Orbit primitive. mope.io gives us exactly one lever -- a point the animal drives toward -- so every
  // close-range phase is written here as a POLAR vector around the foe: an ANGLE off the line to it
  // (0 = straight in, 90 = slide along the circle, >90 = lean back out) and a LENGTH measured from our
  // own nose. The length is what fixes "runs inside the enemy model": the cursor rests on a standoff ring
  // instead of on their centre. The angle is what fixes a near miss flipping the heading -- a lateral
  // offset in world units becomes a 90-degree aim jump once the body is on top of it, an angle never can.
  function orbitPoint(mx, my, B, ang, len) {
    const dx = B.x - mx, dy = B.y - my, d = Math.hypot(dx, dy) || 1;
    const cx = Math.cos(ang) * len, cy = Math.sin(ang) * len;
    return { x: mx + (dx * cx - dy * cy) / d, y: my + (dx * cy + dy * cx) / d };
  }
  function whipStep(mx, my, B, reach, now, mang) {
    const R = Math.max(reach, reach * CFG.whipR);
    const dx = mx - B.x, dy = my - B.y, d = Math.hypot(dx, dy) || 1;
    const phi = Math.atan2(dy, dx);
    // mx,my is US and B is the foe: phi is the bearing of our own body around them (that is what the
    // step counter and the harness both track), while the orbit point is written OUT FROM US, so the
    // nose programme has to be measured on the us->foe line. Mixing the two frames is what drove the
    // whole wave 180 degrees off: a "lean out" that pointed straight into the enemy body.
    const phiOut = Math.atan2(B.y - my, B.x - mx);
    const head = Number.isFinite(mang) ? mang : phiOut;
    const rad = Math.PI / 180;
    // The snap-turn reflex used to live HERE, overriding the orbit target. It was the fastest thing
    // measured (364ms from a tail hit to a face-up) and it spent the ring to buy it: the tight seeds came
    // back pen 9-11 / jam 3.3%, because a pivot leans on the foe at the exact moment the brake phase is
    // trying to walk off him. So the reflex is a PvP STATE of its own now (see tick()) armed by the same
    // numbers and the orbit below never sees it: the ring owns distance, the reflex owns facing.
    const points = Math.max(3, Math.min(24, Math.round(360 / CFG.whipStepDeg) || 6));
    const spacing = Math.PI * 2 / points;
    if (!bot.whipReady || !bot.whipVertexAt || now < bot.whipVertexAt || bot.whipPoints !== points) {
      bot.whipReady = true; bot.whipPoints = points;
      bot.whipBase = phi; bot.whipStepPhi = phi; bot.whipHopAt = 0;
      bot.whipK = 0; bot.whipVertexAt = now; bot.whipProgress = 0;
      bot.whipPrevPhi = phi; bot.whipLap = 0; bot.whipHopped = false;
      bot.whipTwerk = false; bot.whipNextFlipAt = 0;
    }
    bot.whipProgress += PVP.wrapAngle(phi - bot.whipPrevPhi) * -bot.whipDir;
    bot.whipPrevPhi = phi;
    const completed = Math.max(0, Math.floor((bot.whipProgress + 1e-9) / spacing));
    if (completed > 0) {
      bot.whipProgress -= completed * spacing;
      bot.whipSwitches += completed;
      bot.whipLap += completed;
      bot.whipK = bot.whipLap % points;
      bot.whipBase = PVP.wrapAngle(bot.whipBase - bot.whipDir * completed * spacing);
      bot.whipVertexAt = now; bot.whipStepPhi = phi; bot.whipHopped = false;
      bot.whipTwerk = CFG.whipTwerkEvery > 0 && bot.whipLap % CFG.whipTwerkEvery === 0;
    }
    const t = Math.min(Math.max(0, now - bot.whipVertexAt), CFG.whipCycleMs);
    // The mean of the programme has to sit on the tangent: pointing at a foe you orbit is closing on
    // them, and this game has no strafe and no reverse to pay for that. Everything below is measured on
    // the us->foe line, in degrees, positive toward the direction we are circling.
    const u = t / CFG.whipCycleMs;
    const duty = Math.min(0.8, Math.max(0.05, CFG.whipFaceFrac));
    const brk = Math.max(0, Math.min(0.8, CFG.whipBrakeFrac));
    const rErr = (d - R) / (R * 0.5);
    const orbit = Math.max(0, Math.min(165, CFG.whipOrbitDeg - rErr * CFG.whipKGain));
    const near = Math.max(5, orbit - CFG.whipSwingDeg);
    // Hysteresis governor: the ring radius is a promise, and once it is broken the wave stops diving
    // altogether until we are clear of it again. room fades the dive out in the meantime so the nose
    // never sees a hard flip at the boundary.
    if (bot.whipGuard) { if (d > R * 1.15) bot.whipGuard = false; }
    else if (d < R * CFG.whipGuardFrac) bot.whipGuard = true;
    const room = Math.min(1, Math.max(0, (d - R * 0.75) / (R * 0.5)));
    // Three moves per wave, not two: the face tap that threatens the bite, the brake that pays for it,
    // the arc that carries us to the next spot. Without the middle one the tap is a debt the ring can
    // never settle -- every flick walks us into the enemy model, which is exactly the old bug.
    // SHARP: the dive is a STEP, not a ramp. The tap holds the tangent for its first half and then snaps to
    // the foe-facing angle for its second, so every move of the wave is an instantaneous cursor jump: tangent
    // -> face -> brake -> arc. The old cosine eased in, which spent a quarter of every wave accelerating
    // instead of turning - the "плавность" the user is removing. Same time-average depth as the cosine, so
    // the ring geometry it was tuned against still holds; only the edges changed.
    // A hop is 2.4x speed for a SECOND, not for the 150ms we hold the key, and the wave keeps running
    // while it burns. Diving inside that window closes the gap faster than the brake phase can ever pay it
    // back (0.24s at 576 units/s is 138 units of ground against a 44-unit brake arc) -- measured, it is the
    // whole residual penetration: self 5-7 at eight reps, all of it our own nose on him. So the boost is
    // spent on TRAVEL and the tap stays on the tangent until the burst is over. Our own dart cooldown is
    // the conservative length: it is the gap we are willing to wait before asking for speed again.
    const hot = now - bot.lastDash < CFG.dashCdMs;
    const dive = CFG.whipSnap
      ? (!hot && d > reach * CFG.whipDiveFrac && u >= duty * 0.5 ? near : orbit)
      : orbit - Math.max(0, Math.cos((u / duty - 0.5) * Math.PI)) * room * (orbit - near);
    let want, maxErr = CFG.whipLeadDeg * rad;
    // The beat schedule: one lap in CFG.whipDefEvery is spent on the real defensive sidestep instead of the
    // dive, and one lap in CFG.whipTwerkEvery shakes the cursor hard left-right about the foe line. Both are
    // gated on the caller having measured a foe close enough for the move to mean something ("с дефом и
    // тверком иногда") and on whipSnap, so turning the switch off restores the plain smooth wave for A/B.
    bot.whipDef = !bot.whipGuard && CFG.whipSnap && CFG.whipDefEvery > 0 &&
      d <= R * CFG.whipDefNearFrac && bot.whipLap % CFG.whipDefEvery === CFG.whipDefEvery - 1;
    if (bot.whipGuard) {                             // inside the ring: back out and keep swinging
      want = phiOut + bot.whipDir * (180 - CFG.whipBrakeDeg) * rad;
      maxErr = CFG.whipBrakeLeadDeg * rad;
    } else if (u < duty) {                           // dive depth is rationed by the room left in the ring
      if (bot.whipDef) {                             // the sidestep, spoken in the us->foe frame
        const ds = defendStep(mx, my, B.x, B.y, Math.max(reach, R * CFG.whipDefNearFrac), now);
        want = Math.atan2(ds.y - my, ds.x - mx);
        maxErr = 180 * rad;                          // the sidestep IS the move - nothing to leash
      } else {
        want = phiOut + bot.whipDir * dive * rad;
      }
    } else if (u < duty + brk) {
      want = phiOut + bot.whipDir * (180 - CFG.whipBrakeDeg) * rad;
      maxErr = CFG.whipBrakeLeadDeg * rad;
    } else {
      want = phiOut + bot.whipDir * orbit * rad;
    }
    // Cursor LENGTH. The tap is the phase that closes, so on a snap wave it is capped to about 0.7 of the
    // real gap: at the dive angle the programme uses (~45 deg off the foe line) a point that far out still
    // lands OUTSIDE the enemy silhouette, while the old full-ring lead threw the cursor clean through her
    // body -- and the animal then had to drive through it to find out. 0.7 is the tangency margin for
    // reach == the contact distance, not a taste value. The travel phases keep the full standoff ring.
    const len = CFG.whipSnap && u < duty
      ? Math.max(reach * CFG.aimLeadFrac, Math.min(R * CFG.whipArc, d * 0.7))
      : Math.max(reach * CFG.aimLeadFrac, R * CFG.whipArc);
    let dart = false;
    const travel = d > reach && !bot.whipDef && u >= duty + brk;
    if (travel && !bot.whipHopped) {
      const offLine = Math.abs(PVP.wrapAngle(head - phiOut)) > CFG.whipHopNoseDeg * rad;
      const remaining = spacing - bot.whipProgress;
      dart = CFG.whipDart && offLine && remaining > spacing * (1 - CFG.whipHopFrac);
    }
    // Handbrake law: the client scales our speed by cos(cursor - heading), so the cursor is placed as
    // near the nose as the turn rate allows and only then shaken left-right. A cursor thrown wide is not
    // a sharper turn, it is a slower animal.
    const err = PVP.wrapAngle(want - head);
    const twk = CFG.whipSnap && bot.whipTwerk && u < duty && !bot.whipDef;   // the shake replaces the hold
    const wag = (twk || CFG.whipSnap ? Math.sign(Math.sin(t / (twk ? CFG.whipTwerkMs : CFG.faceWagMs) * Math.PI * 2))
                                     : Math.sin(t / CFG.faceWagMs * Math.PI * 2)) *
      (twk ? CFG.whipTwerkDeg * rad : CFG.whipWag) * bot.whipDir;
    const p = orbitPoint(mx, my, B, head + Math.max(-maxErr, Math.min(maxErr, err)) + wag - phiOut, len);
    p.dart = dart;
    return p;
  }

  // Ring geometry straight off the arena entity. The bundle keeps every number twice -- interpolated
  // (arena.size / arena.wallThickness, what it draws) and networked (arena.target.*, what it parsed) --
  // so both are read, and the value is recomputed every call because the duel ring SHRINKS.
  // The duel arena is stamped on the animal, but the client keeps every field twice (interpolated object
  // + networked .target), so read whichever carries it instead of betting the whole PvP on one shape.
  const arenaOf = e => (e && (e.arena || (e.target && e.target.arena))) || null;
  function arenaRing(me) {
    const A = arenaOf(me);
    const at = A && A.target;
    const c = A && (A.position || (at && at.position));
    const s = A && (A.size || (at && at.size));
    if (!c || !s || !(s.x > 0)) return null;
    const wall = Number.isFinite(A.wallThickness) ? A.wallThickness
      : Number.isFinite(at && at.wallThickness) ? at.wallThickness : 0;      // UNCALIBRATED
    const R = Math.max(0, (s.x - wall) / 2);
    const ms = me.target && me.target.size;
    const mr = (ms && ms.x / 2) || 0;
    return { c, R, mr, lim: Math.max(mr, R - mr * CFG.zoneMarginFrac) };
  }
  // The duel ring is a CIRCLE and the client draws its wall at (size.x - wallThickness)/2; the server
  // starts burning whoever stands outside it. Pull the steer point back inside that ring -- every mode
  // funnels through steer(), so one clamp covers chase, footwork, dart and defence alike.
  function arenaKeepInside(me, x, y) {
    const g = arenaRing(me);
    if (!g) return { x, y };
    const c = g.c, R = g.R, lim = g.lim;
    bot.zoneR = R; bot.zoneLim = lim;
    const op = (me.target && me.target.position) || me.position;   // a thrown here would kill all of PvP
    if (!op) return { x, y };
    const odx = (op.x || 0) - c.x, ody = (op.y || 0) - c.y;
    const od = Math.hypot(odx, ody);
    // already outside: aim back inside our own side of the ring, not across the whole arena
    if (od > lim) { bot.zoneOut++; return { x: c.x + odx / od * lim * 0.7, y: c.y + ody / od * lim * 0.7 }; }
    const dx = x - c.x, dy = y - c.y, d = Math.hypot(dx, dy);
    if (!(d > lim)) return { x, y };
    bot.zonePulls++;
    return { x: c.x + dx / d * lim, y: c.y + dy / d * lim };
  }

  // The duel arena is game data, not a guess: the arena entity's Qn() reads two animal ids and stamps
  // .arena = <arena object> on BOTH players, keeping the objects in player1/player2. Inside a duel that
  // other player IS the fight -- distance, tier and cursor all lose to it.
  function duelOpponent(me) {
    const A = arenaOf(me);
    if (!A || !A.player1 || !A.player2) return null;
    const isMe = a => !!a && (a === me || a.id === me.id);
    if (isMe(A.player1)) return A.player2;
    return isMe(A.player2) ? A.player1 : null;    // not one of the two listed: stale sync, invent nothing
  }

  // Score one animal as an attack candidate: distance to the PREDICTED tail (centre AND angle advanced by
  // measured velocity; predict() is null when stale, then we fall back to the raw snapshot) plus two
  // biases that keep the bot in a real fight -- animals below our tier are food, not a duel, and a target
  // the cursor is not pointing at is a side track.
  function mkCand(id, e, me, now) {
    const er = e.target.size.x / 2;
    const current = bot.tracker.predict(id, now, 0, CFG.leadCapSec);
    const own = bot.tracker.predict(me.id, now, 0, CFG.leadCapSec);
    const speed = own ? Math.hypot(own.vx, own.vy) : 0;
    const lead = current && speed > 0
      ? PVP.interceptTime(me.target.position, speed, current, CFG.leadCapSec) : CFG.leadSec;
    const pr = bot.tracker.predict(id, now, lead, CFG.leadCapSec);
    const base = pr || { x: e.target.position.x, y: e.target.position.y, angle: e.target.angle, vx: 0, vy: 0, ageMs: null };
    if (pr && current) base.angle = current.angle + PVP.clamp(
      PVP.angleDelta(current.angle, pr.angle), -Math.PI / 4, Math.PI / 4);
    const tail = PVP.offset(base, base.angle, -er * CFG.tailFrac);
