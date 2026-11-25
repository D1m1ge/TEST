// ==UserScript==
// @name         mope.io combat suite
// @namespace    vxnqrfx
// @version      1.4.0
// @description  ESP + один PvP-переключатель (цель кликом, дуэльный соперник, хвостовой укус, уклон) для mope.io
// @match        https://mope.io/*
// @match        https://*.mope.io/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

/*
 * Client facts this build leans on, read from the production bundle c/D8bNReW2.js
 * (2026-11-24). Minified names change per deploy; the opcodes did not between the
 * two builds checked.
 *
 *  realm   the bundle appends a hidden iframe and, on the next line, captures
 *          iframe.WebSocket.prototype.send and iframe.EventTarget.prototype.addEventListener.
 *          An appendChild hook is the only code that runs before that capture, so the
 *          script has to be injected at document-start.
 *  205     control packet: Ic.readString() = [u16 LE length][utf8], then Function('Game', src)($).
 *          That is the handle to the game singleton $.
 *  $.Hf    network client. zx(114,{Jb,zd}) = pointer target, Jb/zd = Mc.toPrecision(x, $.fw.bounds.max.x, 16)
 *          = round(clamp(x) / max * 65535). 192/219 boost press/release, 217/152 ability1,
 *          238/141 ability2, 97/44 dive.
 *  input   a 4ms loop streams the real cursor, paced to uA(): tier<10 30/s, tier>=10 60/s,
 *          tier>=15 or arena $.Yw.maxEventRate (120).
 *  entity  base class has synchronize / Qn / destroy (destroy sets spawned=false). Animals carry
 *          tier, size (diameter), target.position + target.angle (latest snapshot), name.text, species.
 *          $.zt.animals = { species index -> class }, all on the same base.
 *  camera  $.Ar.tq(x, y) = world -> canvas device px; $.Ar.Bx(x, y) = the same transform backwards
 *          (canvas device px -> world) and $.Ar.ql(point, filter, pad) is the client's OWN
 *          "what is under this pixel" hit test built on Bx. canvas.width / canvas.clientWidth =
 *          device px per CSS px. A real click is therefore turned into a world point through Bx and
 *          hit-tested there, which cannot drift with dpr, canvas offsets or zoom.
 *  arena   a challenge duel is an entity of its own: its Qn() reads two animal ids and stamps
 *          .arena = <that arena object> on BOTH players (arena.player1 / arena.player2 are the
 *          animal objects). Every entity also keeps a networked twin, so the stamp can be read from
 *          e.arena or e.target.arena -- arenaOf() checks both. Inside a duel that opponent is game
 *          data, not a guess, and any animal whose arena differs from ours is fenced off somewhere
 *          else and is not our fight.
 *          The ring is a CIRCLE, not a box: the client draws it at
 *          (arena.size.x - arena.wallThickness) / 2 (wallThickness itself comes from
 *          Rc.fromPrecision(readUint16(), size.x / 2, 16)), and contact with another animal is
 *          |pos|< ((size.x + other.size.x) / 2)^2. Outside that wall the opponent burns, so the
 *          steer point is clamped back inside it (arenaKeepInside).
 *  dash    an animal snapshot carries status.boosting (the client mirrors it as this.Ry), so an
 *          incoming dash is readable as a server flag as well as from measured closing speed.
 *
 * Server-side and UNCALIBRATED (values in CFG): boost cost and hold, bite geometry, how the
 * server treats input it considers too fast.
 */

(() => {
  'use strict';
  if (window.__MOPE_CHEAT__) return;
  window.__MOPE_CHEAT__ = true;

  const STARTED_LATE = document.readyState !== 'loading' || !!document.querySelector('script[type="module"]');

  const CFG = {
    esp: true,           //         rings + labels on an overlay
    labels: true,        //         species / tier / hp / name next to each ring
    radar: true,         //         corner minimap: every animal as a dot, tier-coloured
    radarRange: 2600,    //         world units shown across the radar radius
    pvp: true,           //         ONE combat switch: chase, square up, footwork, tail bite, dart
    dodge: true,         //         run from predators, square up to tail hunters
    autoDuel: true,      //         in a challenge arena, fight the arena's other player and nobody else
    retaliate: true,     //         outside a duel, prefer the animal that is actually going for our tail
    ability: false,      //         also fire ability1 during a dart
    // internal tuning, deliberately NOT in the menu: the PvP system runs all of them together and
    // picks the phase from geometry. The test rig overrides them to measure one phase in isolation.
    pvpFast: true,       //         keep boosting through the duel instead of creeping
    lunge: true,         //         spend boost to whip onto the tail when the intercept is clean
    diamond: true,       //         face-first feint once we are close (never orbit our back to it)
    leadSec: 0.25,       //         UNCALIBRATED aim-ahead for a moving tail
    tailFrac: 2 / 2.15,  //         tail offset from centre, in radii (sprite: size.x / 2.15)
    dashHoldMs: 150,     //         UNCALIBRATED boost press length
    dashCdMs: 460,       //         UNCALIBRATED min gap between boosts (lower = darts more often)
    dashMinRes: 0.2,     //         UNCALIBRATED fraction of the resource bar a boost needs
    weave: 0.45,         //         radians of side-to-side while running from a predator
    faceWagMs: 100,      //         UNCALIBRATED ms for a full left-right nose-shake (lower = snappier)
    pvpWeave: 0.62,      //         RADIANS the approach cursor sits off the foe line at full swing. These
    diamondWeave: 1.05,  //         two used to be laterals in reaches, which parked the cursor ON the
                         //         target centre -- that is exactly what drove our body into its model.
    jinkWeave: 0.7,      //         tail-shake width when an equal-tier hunter goes for our back
    engageR: 1100,       //         world units to look for tails
    dangerR: 750,        //         world units to look for predators
    fleeR: 520,          //         boost away once a predator is this close
    // The decision period, NOT a send rate: the pump still spaces op114 by the client's own uA() pace.
    // 4ms is the client's own input loop, so a fresher point is always parked before the next boundary
    // opens and the allowed rate gets used instead of a fraction of it.
    tickMs: 4,
    showMenu: true,      // Insert
    skinSubspecies: 0,   // 0 = normal; otherwise force this skin (subspecies) id on the local player

    // --- motion estimation (MopePvpCore.MotionTracker). Numbers are starting points, NOT tuned to
    //     the live server; confirm in-game. maxSpeed/maxAngularSpeed bound the derivative reset.
    motionSmoothingMs: 90,   // EMA window for velocity / angular velocity
    motionStaleMs: 500,      // older than this => treat the entity as stale, no prediction
    motionResetGapMs: 350,   // a sample gap this large (teleport/respawn) resets the filter
    maxSpeed: 2400,          // world-units/s above which a jump is a teleport, not motion
    maxAngularSpeed: 14,     // rad/s cap on angular velocity estimate
    leadCapSec: 0.45,        // hard cap on the prediction horizon
    // --- attack geometry (MopePvpCore.evaluateAttack). biteDistance / tailOffset remain MODELS.
    biteRearDeg: 70,         // rear cone half-angle: only commit when this behind the target's centre
    biteHeadDeg: 75,         // max nose-vs-tail heading error to treat as a committed bite
    biteReachFrac: 0.6,      // mouth-to-tail must be <= er * this (MODEL, not a confirmed hitbox)
    lungeHeadDeg: 60,        // heading error allowed to fire a finishing dart
    lockMinHoldMs: 350,      // keep an attack target this long before switching (anti flip-flop)
    lockSwitchRatio: 0.75,   // only switch early if the new candidate scores this fraction of the old
    frontDangerFrac: 1.1,    // er * this = radius around the target's NOSE a dart path must not enter (MODEL)
    feintR: 2.8,             // switch from the approach to the close-in feint inside this many reaches
    approachGap: 1.1,        // UNCALIBRATED standoff ring the plain approach walks, in reaches: the cursor
                             // stops on the foe's skin instead of on its centre -- the "into the model".
    baitGap: 1.5,            // UNCALIBRATED and wider against a foe that kites: we want the strafe lane,
                             // not a nose-to-nose shoving match with an animal backing up on purpose.
    biteLeadFrac: 0.2,       // UNCALIBRATED how far past the tail the bite cursor reaches, in body radii.
                             // The hardcoded 0.5 pulled the point back INTO the target's body.
    lungeThrough: 0.15,      // UNCALIBRATED the same for the finishing dart (was 0.4 straight through it)
    // --- target choice: fight what the player is actually pointing at, and prefer a real duel.
    //     score = distance to the predicted tail + tier bias + how far the target sits from the cursor.
    tierWeight: 400,         // world units of penalty per tier BELOW us, so snacks don't hijack a duel
    cursorWeight: 0.5,       // weight on the cursor->target distance (cursor read back from opcode 114)
    hitWeight: 900,          // score discount for the animal hunting our tail, so a duel beats a snack
    // --- click-to-target. A SHORT left tap (or the right button) on an animal picks it; a held left
    //     button is the game's own boost and never re-targets. Hit test runs in WORLD units against the
    //     cursor point decoded from opcode 114, so it cannot drift with dpr / zoom / canvas offsets.
    pickTapMs: 250,        // press->release under this and pickTapPx = a tap, not a boost hold
    pickTapPx: 14,         // how far the mouse may travel during a tap
    pickGrabWorld: 55,     // world units of slack around a body centre (UNCALIBRATED)
    pickGrabPx: 14,        // same slack in screen px for the projected fallback path
    pickArmMs: 5000,       // how long an armed pick (bind / menu button) waits for the click
    // --- defensive states (v4, all UNCALIBRATED) ---
    kiteAim: 0.5,        // aimed above this = the foe faces us while kiting
    kiteBack: 60,        // units/s of drift against its own nose that counts as kiting
    dashClose: 700,      // units/s of closing speed toward us that counts as an incoming dash
    defPhaseMs: 70,      // ms per defend tap; full cycle = 3x; MUST stay below the animal turn time
    defStep: 1.1,        // defend tap distance, in reaches
    dashDodge: false,    // answer an incoming dash with one defensive boost of our own
    // --- WHIP: face-on orbit at a standoff, one hop per real shift (SEPARATE button, UNCALIBRATED) ---
    whip: false,         // F8: arc and one successful hop per waypoint transition
    whipR: 1.5,          // standoff ring radius, in reaches (1.0 = the bodies touch). Measured on the
                         // rabbit duel, where contact sits at 80 units: 1.35 held the closest approach at
                         // 98, 1.5 at 106 -- 1.3 body diameters of clear air, which is what "чуть подальше"
                         // asks for without leaving bite range forever.
    whipCycleMs: 400,    // one full orbit step. 520 was the smooth wave: the ring is meant to read as fast
                         // feet, and a longer cycle only smears the tap, the brake and the arc into a glide.
    whipSnap: true,      // SHARP programme: no cosine ramp into the dive, a SQUARE idle shake, and the def
                         // and twerk beats land as discrete beats. false restores the blended wave - that
                         // off/on pair IS the A/B for "движение должны быть без плавности быстро резко".
    whipTwerkEvery: 3,   // UNCALIBRATED laps between TWERK beats: on that lap the face tap is shaken hard
                         // left-right instead of held steady. "иногда" - on every lap it is just a shimmy.
    whipTwerkMs: 90,     // UNCALIBRATED twerk period: one full left-right-right in 90ms, square, not sine
    whipTwerkDeg: 26,    // UNCALIBRATED twerk amplitude in degrees of cursor swing about the foe line
    whipDefEvery: 4,     // UNCALIBRATED laps between DEF beats: the ring spends one beat on the REAL
                         // defensive sidestep (the same move the 'def' state runs) instead of the arc
    whipDiveFrac: 2.2,   // the tap only dives when the foe is at least this many REACHES
                         // away. reach IS the contact distance here (mr + er), so this is a body-clearance
                         // gate: a dive from closer than 1.4 diameters cannot be paid back, because the
                         // client has no reverse -- a cursor behind us is a handbrake at 35% speed, not a
                         // walk away, and 35% of 240 for the half second it takes to slew is a penetration.
                         // 1.7 left exactly that on the table: 8-11 self-penetrating ticks in two runs of
                         // ten, every one of them our own nose, because a foe who hops at 2.4x closes the
                         // 44-unit brake arc we can buy in the tap window. 2.2 (176 units, 1.47 ring radii)
                         // measured 0/10 on both pen and jam while cursor swing only fell 1017 -> 980 deg/s
                         // and the face threat stayed 6.1% -- the tap is just as sharp, it is launched from
                         // far enough that a charging hop can no longer land inside us.
    whipDefNearFrac: 1.45,// UNCALIBRATED: a def beat only fires inside this many ring radii, i.e. when a
                         // defense is actually answering something and not just skipping an orbit step.
    // Two timed branches (poke / hop) cannot hold
                         // a ring -- only a programme whose MEAN nose angle sits past the tangent can, so
                         // the step is one wave: a flick of the nose onto the foe, then a long ride round
                         // the outside of the circle.
    whipStepDeg: 60,     // six evenly spaced waypoints per full orbit
    whipWag: 0.18,       // radians of left-right during the face tap (~13 deg: the nose stays on the foe)
    whipArc: 1.15,       // shift cursor distance ahead of our OWN nose, in ring radii
    aimLeadFrac: 0.55,   // UNCALIBRATED no steer point anywhere in PvP sits closer than this many reaches
                         // to our own nose: a cursor under the body jumps the heading every single tick
    whipOrbitDeg: 92,    // the resting nose angle around the foe line, degrees, measured on our own nose.
                         // Past 90 = past the tangent, so the ride around the foe doubles as the step back
                         // off them: sin(92)=1.0 keeps the orbit at full tangential speed, cos(92)=-0.035
                         // is what pays for the flick onto their face. Below 90 the ring collapses.
    whipSwingDeg: 66,    // how far the SQUARE dive reaches back toward the foe line: 92-60 = 32 deg off it
                         // for half a tap, then out again. Depth stopped being the problem once the dive
                         // refused a burning hop: at 60 deg the eight-rep sweep is pen 0 / jam 0 with the
                         // travel still at 384 deg, while 50 deg bought nothing but a slower orbit.
    whipFaceFrac: 0.6,   // share of the wave spent on the face tap. Small = the ring holds and the orbit
                         // stays fast; the tap is a feint that threatens a bite, not a commitment to one.
                         // Raised from .5 with the square dive: half the tap holds the tangent and only the
                         // second half leans in, so the threat needs a longer window to actually read as a
                         // face (measured: .5 -> 4.3% of ticks with the nose inside 30 deg, .55 -> 6.1%).
    whipKGain: 40,       // degrees the whole programme shifts per half-ring of radius
                         // error: too far = the wave tightens onto the foe, too close = it swings wider.
                         // Without this the ring is not an attractor -- the step either sticks to the
                         // enemy model or runs off to 3+ reaches, depending on a three-degree nudge.
    whipGuardFrac: 1.15, // fraction of the ring radius at which the dive is cancelled. The short wave
                         // dives more often per second, so the promise has to be collected earlier: at 1.0
                         // the five-rep sweep still landed pen 6-11 on some flip seeds (the client has no
                         // reverse, so once the nose is inside a contact diameter the brake can only slow
                         // the body, not walk it back). 1.15 measured pen 0 / jam 0 with the travel intact.
    whipBrakeFrac: 0.18, // UNCALIBRATED share of the wave spent braking out of the face tap
    whipBrakeDeg: 55,    // UNCALIBRATED how far short of straight-out the brake cursor sits
    whipBrakeLeadDeg: 115,// UNCALIBRATED the ONLY place the cursor may go past the beam: a deliberate
                         // handbrake. Past 90 deg off the nose the client drops us to 35% speed, which
                         // is how a flick gets paid for instead of walking into the enemy body.
    whipLeadDeg: 62,     // how far off our OWN nose the cursor may sit on a tap/arc beat. The leash on how
                         // fast the body is allowed to change its mind: 120 deg is the client's brake, not a
                         // turn, while 34 capped the flick to a lean and made the whole wave crawl. Measured
                         // over five reps: 34 -> 788 deg/s of cursor swing, 48 -> 1037-1088, 62 -> 1040-1107
                         // with the ring contract intact, 70+ started eating the standoff. This is where the
                         // "движение оч резкие" actually lives -- the turn rate is clamped, the LEASH is not.
    whipHopNoseDeg: 110, // degrees off the us->foe line our own NOSE has to clear before the
                         // ring is allowed to spend a burst. 90 = the tangent, where the hop is pure travel;
                         // short of it the same 2.4x is a charge into the enemy model.
    whipHopFrac: 0.42,   // hop only while less than this fraction of the step has been swept: the boost is
                         // there to MAKE a shift happen, never as a drumbeat under one we already have.
                         // Tightened with the shorter wave so a faster cycle does not quietly become more
                         // boost per second (the check that pins "one hop per real shift" is hopStride.n).
    whipDart: true,      // the shift step may spend a boost
    // Legacy tuning keys remain readable; waypoint movement does not use random reversals.
    whipFlipMinMs: 2000,
    whipFlipMaxMs: 3500,
    whipFlipClearFrac: 1.6,
    // --- SNAP-TURN and AFK STALK: the two things an orbit cannot do by itself (UNCALIBRATED) ---
    snapNearFrac: 1.6,   // A reflex needs a threat, but it needs to see it EARLY. The pivot arms when the foe is
                         // this many body-reaches away (reach = mr + er, so 1.6 ~ 128 units rabbit vs
                         // rabbit) AND already turned on his tail. Measured on the near-tail arena: 1.4 armed
                         // the pivot only once the teeth were nearly on us and the turn cost 520ms; 1.6 takes
                         // the same swing at 416ms against 936ms for the orbit left to itself. It stops there
                         // on purpose - 1.9 bought the same 416ms but pulled the reflex into the ring duel
                         // (343 pivot ticks and pen 11 there), and the standoff is worth more than a reflex
                         // spent on a body that cannot bite for another half second.
    snapClosing: 90,     // UNCALIBRATED units/s: the pivot is a REFLEX, so it arms on a body that is
                         // actually arriving at our tail, not on one our own orbit happened to turn its
                         // back to. The ring swings the nose 92-125 deg off the foe line on purpose, which
                         // used to trip the emergency every couple of laps (measured: 61-222 pivot ticks in
                         // the slow-foe ring world) and every residual penetration in that run was one of
                         // those frames. 90 sits between a ring duel's idle drift and a tail pounce.
    snapDeg: 150,        // how far off our own nose the foe must sit before the orbit drops
                         // everything and PIVOTS. Deliberately past the tangent: a cursor beyond 90 deg is
                         // the client's handbrake (35% speed), so the heading swings at its full rate while
                         // the body stays put -- which is what "моментально повернуться в лицо" means in a
                         // game that has no strafe and no reverse. It also has to sit ABOVE the brake
                         // phase's own nose angle (125 deg), or the orbit trips its own emergency every lap.
    snapLeadDeg: 105,    // how far off our OWN nose the reflex is allowed to put the cursor while it swings
                         // round to his line. Past 90 deg the client drops us to 35% speed but the heading
                         // still swings at the full 4 rad/s clamp, so the body pivots on a circle of
                         // v/omega = 84/4 = 21 units: we face him without driving into him. 150 was tried and
                         // put the cursor 30 deg from HIS line -- the reflex turned into an approach and the
                         // model overlap came back (pen 8-11). 70 never reaches the handbrake and is slower.
    snapBackDeg: 120,    // the reflex releases as soon as the foe is off our tail, which is the orbit's own
                         // resting angle: a pivot is a REFLEX, not a duel, and the lap it interrupted resumes
                         // on its own clock untouched. Tightening this to 30 deg of heading costs ~130ms of
                         // face-up time, leaving it loose lets the ring keep its own phase
    stalkHoldMs: 2000,   // an enemy whose position has not changed for this long is an AFK snack: get
                         // behind it and bite, instead of strafing it like a kiting duellist
    stalkSpeed: 26,      // UNCALIBRATED units/s ceiling for "standing" (a moving animal is 100+)
    stalkGap: 0.55,      // UNCALIBRATED stalk cursor stand-off, in reaches past the tail
    stalkWeave: 0.5,     // UNCALIBRATED radians of left-right while parked on his tail
    // --- stay inside the duel ring (server burns whoever stands outside the wall, UNCALIBRATED) ---
    zoneMarginFrac: 1.5, // body radii we keep off the wall before the steer point is pulled back
    // --- menu keys, remappable; see the binds block. EVERY row needs a slot here, even an unbound one:
    //     the loader below only restores keys it finds in this object, so a missing slot silently throws
    //     away whatever the user bound to that row on the next reload.
    binds: { pvp: 'F1', dodge: 'F2', esp: 'F3', radar: 'F4', labels: 'F5',
      ability: '', pick: 'F6', whip: 'F8', menu: 'Insert',
      tactics: 'F7', tacticU: '', tacticWindback: '', tacticClock: '', tacticStraight: '',
      tacticSwitch: '', tacticDefBoost: '', tacticBait: '' },
    // --- TACTICS (from the guide video): one active at a time, on top of the phase engine.
    //     'universal' = no override, the phase engine picks from geometry. Times are ms (UNCALIBRATED).
    tactic: 'universal',
    tacticUCycleMs: 900,     // U-moonwalk: one full left-to-right U loop
    tacticUTurn: 1.9,        // rad of cursor swing per half-loop (the U's depth)
    tacticWindbackMs: 420,   // windback: hold the bite line, then snap the cursor back this long
    tacticWindbackDeg: 150,  // how far back the cursor swings on the windback
    tacticClockR: 1.6,       // clockwork orbit radius, in reaches (constant angular speed)
    tacticClockMs: 620,      // clockwork full-lap period
    tacticStraightMs: 1200,  // straight-line moonwalk: retreat along the aim line this long, then re-check
    tacticSwitchEvery: 2,    // switchside: change flanks after this many straight retreats
    tacticDefBoostR: 2.0,    // defensive boost: fire when a foe nose is this close, in reaches
    tacticBaitGap: 2.2,      // bait standoff ring, in reaches
  };

  // What the user ticked and which keys they bound survives a reload; the panel is the only writer.
  const STORE = 'mopeCheat.v1';
  // autoDuel / retaliate are deliberately NOT stored and not on the menu: they are internal tie-breakers
  // of the fallback picker, and a stale saved 'false' from an older build would silently switch them off.
  const STORED = ['pvp', 'dodge', 'esp', 'radar', 'labels', 'ability', 'whip', 'showMenu'];
  try {
    const raw = localStorage.getItem(STORE);
    if (raw) {
      const o = JSON.parse(raw) || {};
      for (const k of STORED) if (typeof o[k] === 'boolean') CFG[k] = o[k];
      if (Number.isFinite(o.skinSubspecies) && o.skinSubspecies >= 0) CFG.skinSubspecies = o.skinSubspecies | 0;
      if (o.binds) for (const a in CFG.binds) if (typeof o.binds[a] === 'string') CFG.binds[a] = o.binds[a];
      // Firefox eats F7 for caret browsing, and the user lives in Firefox: the whip moves to F8 and a
      // saved F7 is carried over with it (nobody picks F7 on purpose -- it is the only key we use it for).
      if (CFG.binds.whip === 'F7') CFG.binds.whip = 'F8';
      if (CFG.binds.whip) for (const a in CFG.binds) if (a !== 'whip' && CFG.binds[a] === CFG.binds.whip) CFG.binds[a] = '';
    }
  } catch (_) { }      // storage can be blocked; defaults are then just re-applied
  const saveCfg = () => {
    try {
      const o = { binds: CFG.binds, skinSubspecies: CFG.skinSubspecies };
      for (const k of STORED) o[k] = CFG[k];
      localStorage.setItem(STORE, JSON.stringify(o));
    } catch (_) { }
  };

  // ------------------------------------------------------------ motion + attack geometry core
  // Trimmed from the reviewed MopePvpCore reference to the primitives this bot actually uses. Plain
  // JS, no deps. Contract: positions/distances in WORLD units, angles in RADIANS, heading=(cos a,sin a),
  // time = performance.now() ms, velocity = world-units/s. update() is fed only by REAL decoded snapshots
  // (the client hook bumps __mopeSample), never by the interpolated render position or by repeated ticks.
  const PVP = (() => {
    const EPS = 1e-8, TAU = Math.PI * 2;
    const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
    const wrapAngle = v => { let r = (v + Math.PI) % TAU; if (r < 0) r += TAU; return r - Math.PI; };
    const angleDelta = (from, to) => wrapAngle(to - from);
    const heading = a => ({ x: Math.cos(a), y: Math.sin(a) });
    const offset = (p, a, d) => ({ x: p.x + Math.cos(a) * d, y: p.y + Math.sin(a) * d });
    const segDist = (p, a, b) => { const dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy;
      if (l2 < EPS) return Math.hypot(p.x - a.x, p.y - a.y);
      const t = clamp(((p.x - a.x) * dx + (p.y - a.y) * dy) / l2, 0, 1);
      return Math.hypot(p.x - (a.x + dx * t), p.y - (a.y + dy * t)); };
    const cross = (a, b, c) => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
    function segsWithin(a, b, c, d, r) {
      const c1 = cross(a, b, c), c2 = cross(a, b, d), c3 = cross(c, d, a), c4 = cross(c, d, b);
      if (((c1 > 0 && c2 < 0) || (c1 < 0 && c2 > 0)) && ((c3 > 0 && c4 < 0) || (c3 < 0 && c4 > 0))) return true;
      return Math.min(segDist(a, c, d), segDist(b, c, d), segDist(c, a, b), segDist(d, a, b)) <= r;
    }

    class MotionTracker {
      constructor(o) { this.smoothingMs = o.smoothingMs; this.staleMs = o.staleMs; this.resetGapMs = o.resetGapMs;
        this.maxSpeed = o.maxSpeed; this.maxAngularSpeed = o.maxAngularSpeed; this.states = new Map(); }
      // sample: {x,y,angle,reset?}. Call once per decoded snapshot at time `now`.
      update(id, s, now) {
        const old = this.states.get(id);
        if (old && now < old.receivedAt) return;                       // out-of-order packet, ignore
        const gapMs = old ? now - old.receivedAt : Infinity;
        const move = old ? Math.hypot(old.x - s.x, old.y - s.y) : 0;
        const reset = !old || s.reset || gapMs > this.resetGapMs ||
          (gapMs > 0 && move / (gapMs / 1000) > this.maxSpeed);       // teleport / respawn / id reuse
        let vx = 0, vy = 0, omega = 0, intervals = 0;
        if (!reset && gapMs > 0) {
          const dt = gapMs / 1000, alpha = -Math.expm1(-gapMs / this.smoothingMs);
          vx = old.vx + alpha * ((s.x - old.x) / dt - old.vx);
          vy = old.vy + alpha * ((s.y - old.y) / dt - old.vy);
          omega = old.omega + alpha * (clamp(angleDelta(old.angle, s.angle) / dt,
            -this.maxAngularSpeed, this.maxAngularSpeed) - old.omega);  // wrapped -> no pi->-pi spike
          intervals = old.intervals + 1;
        }
        this.states.set(id, { id, x: s.x, y: s.y, angle: wrapAngle(s.angle), vx, vy, omega,
          receivedAt: now, positionChangedAt: (!old || reset || move > EPS) ? now : old.positionChangedAt, intervals });
      }
      get(id) { return this.states.get(id) || null; }
      // null when the entity has no snapshot or is stale -> caller must fall back or skip, never fabricate.
      predict(id, now, leadSec, maxPred) {
        const st = this.states.get(id); if (!st) return null;
        const ageMs = Math.max(0, now - st.receivedAt); if (ageMs > this.staleMs) return null;
        const horizon = Math.min(maxPred, ageMs / 1000 + leadSec);     // shrink with poor measurement
        return { x: st.x + st.vx * horizon, y: st.y + st.vy * horizon, angle: wrapAngle(st.angle + st.omega * horizon),
          vx: st.vx, vy: st.vy, omega: st.omega, ageMs, horizon, measured: st.intervals > 0 };
      }
      remove(id) { this.states.delete(id); }
      clear() { this.states.clear(); }
    }

    // geometric evaluation, NOT a server collision prediction; offsets are caller-supplied models.
    function evaluateAttack(me, target, o) {
      const mouth = offset(me, me.angle, o.mouthOffset);
      const tail = offset(target, target.angle, -o.tailOffset);
      const dx = me.x - target.x, dy = me.y - target.y, cd = Math.hypot(dx, dy);
      const h = heading(target.angle);
      const rearAlignment = cd > EPS ? -(dx * h.x + dy * h.y) / cd : -1;   // ~1 = directly behind
      const adx = tail.x - mouth.x, ady = tail.y - mouth.y, m2t = Math.hypot(adx, ady);
      const desiredAngle = m2t > EPS ? Math.atan2(ady, adx) : me.angle;
      const headingError = angleDelta(me.angle, desiredAngle);
      const inRearSector = cd > EPS && rearAlignment >= Math.cos(o.rearHalfAngle);
      const head = offset(target, target.angle, o.tailOffset);
      // Danger zone = the foe's NOSE, not its centre: the tail point we aim at always sits ~0.93*er from
      // the centre, so measuring against the centre (or centre->head) puts every path "inside" the body and
      // the dart becomes unreachable. head->head makes segsWithin a plain point-to-segment distance test.
      const frontPathClear = o.frontDangerRadius <= 0 || !segsWithin(me, tail, head, head, o.frontDangerRadius);
      return { mouth, tail, rearAlignment, centerDistance: cd, mouthToTail: m2t, desiredAngle, headingError,
        inRearSector, aligned: Math.abs(headingError) <= o.maxHeadingError, frontPathClear,
        biteGeometry: inRearSector && m2t <= o.biteDistance && Math.abs(headingError) <= o.maxHeadingError };
    }

    class TargetLock {
      constructor(minHoldMs, switchRatio) { this.minHoldMs = minHoldMs; this.r = switchRatio; this.reset(); }
      reset() { this.id = null; this.since = 0; }
      choose(cands, now) {
        let best = null, cur = null;
        for (const c of cands) { if (c.id == null || !(c.score >= 0)) continue;
          if (!best || c.score < best.score) best = c; if (c.id === this.id) cur = c; }
        if (!best) { this.reset(); return null; }
        let sel = best;
        if (cur && best.id !== cur.id) {                               // sticky: hold unless clearly better
          if (now - this.since < this.minHoldMs || best.score >= cur.score * this.r) sel = cur;
        }
        if (sel.id !== this.id) { this.id = sel.id; this.since = now; }
        return sel;
      }
    }
    function interceptTime(origin, speed, target, maxSeconds) {
      const values = [origin.x, origin.y, speed, target.x, target.y, target.vx, target.vy, maxSeconds];
      if (!values.every(Number.isFinite) || speed <= 0 || maxSeconds <= 0) return 0;
      const x = target.x - origin.x, y = target.y - origin.y;
      const a = target.vx ** 2 + target.vy ** 2 - speed ** 2;
      const b = 2 * (x * target.vx + y * target.vy), c = x * x + y * y;
      if (!c) return 0;
      let roots;
      if (Math.abs(a) <= 1e-9 * Math.max(speed ** 2, target.vx ** 2 + target.vy ** 2, 1)) {
        roots = b ? [-c / b] : [];
      } else {
        const disc = b * b - 4 * a * c;
        if (disc < 0) return 0;
        const q = -0.5 * (b + (b < 0 ? -1 : 1) * Math.sqrt(disc));
        roots = q ? [q / a, c / q] : [];
      }
      const positive = roots.filter(t => Number.isFinite(t) && t >= 0);
      return positive.length ? Math.min(maxSeconds, ...positive) : 0;
    }

    // ---- TACTICS (guide video). Each returns a cursor point in world units from our own nose
    // ---- plus an optional boost request. Pure: no game state, all inputs explicit. `now` in ms.
    // U Moonwalk (defense): cursor sweeps one deep U across the foe line -- approach on the right
    // flank, swing the nose 180 through the foe's line, exit on the left, repeat.
    function uMoonwalk(me, foe, reach, now, o) {
      const t = (now % o.cycleMs) / o.cycleMs;            // 0..1 across the loop
      const half = t < 0.5 ? 1 : -1;                      // right flank first, then the left one
      const phase = t < 0.5 ? t * 2 : (t - 0.5) * 2;
      const swing = o.turn * (0.35 + 0.65 * phase);       // ease into the U's depth, no snap start
      const base = Math.atan2(foe.y - me.y, foe.x - me.x);
      const a = base + half * swing;
      const d = Math.max(reach, Math.hypot(foe.x - me.x, foe.y - me.y));
      return { x: me.x + Math.cos(a) * d, y: me.y + Math.sin(a) * d, boost: false };
    }
    // The windback (offense): hold the bite line for holdMs, then whip the cursor back behind our
    // tail -- the client handbrakes and the nose snaps round onto the foe as he turns to follow.
    function windback(me, foe, reach, now, o) {
      const back = (now % o.holdMs) > o.holdMs * 0.6;
      const base = Math.atan2(foe.y - me.y, foe.x - me.x);
      const a = back ? base + Math.PI - o.backDeg * Math.PI / 180 * 0.5 : base;
      const d = back ? reach * 2.2 : Math.max(reach, Math.hypot(foe.x - me.x, foe.y - me.y));
      return { x: me.x + Math.cos(a) * d, y: me.y + Math.sin(a) * d, boost: back };
    }
    // Clockwork (strategy): constant angular speed on a fixed ring around the foe, nose leaned inward.
    // The cursor IS the ring point (measured from the foe), so the orbit radius never drifts with
    // our own distance; the inward lean is a bounded extra pull, not a redefinition of the ring.
    function clockwork(me, foe, reach, now, o) {
      const t = (now % o.lapMs) / o.lapMs * Math.PI * 2;
      const r = reach * o.ringR;
      const px = foe.x + Math.cos(t) * r, py = foe.y + Math.sin(t) * r;
      const dx = px - me.x, dy = py - me.y, l = Math.hypot(dx, dy) || 1;
      const step = Math.min(l, l * 1.2);                       // full pull to the ring, slight overshoot bias
      return { x: me.x + dx / l * step, y: me.y + dy / l * step, boost: false, ring: { x: px, y: py } };
    }
    // Straight-line moonwalk (defense): retreat nose-first along the away line with the cursor held
    // behind us; straightR checks the escape line each cycle so the failsafe can pick it up outside.
    function straightMoonwalk(me, foe, reach, now, o) {
      const away = Math.atan2(me.y - foe.y, me.x - foe.x);
      const side = (Math.floor(now / o.holdMs) % 2) ? 0.18 : -0.18;  // slight alternating bias: no same move twice
      const a = away + side;
      const d = reach * 2.6;
      return { x: me.x + Math.cos(a) * d, y: me.y + Math.sin(a) * d, boost: false };
    }
    // Switchside moonwalk: straight retreats that change flank every `every` cycles.
    function switchsideMoonwalk(me, foe, reach, now, o) {
      const cycle = Math.floor(now / o.holdMs);
      const flank = (Math.floor(cycle / o.every) % 2) ? 1 : -1;
      const away = Math.atan2(me.y - foe.y, me.x - foe.x) + flank * 0.5;
      const d = reach * 2.6;
      return { x: me.x + Math.cos(away) * d, y: me.y + Math.sin(away) * d, boost: false };
    }
    // Defensive boost (defense): hold the standoff ring, and when the foe's nose commits our way,
    // boost along the escape arc -- never straight back (the client handbrakes).
    function defensiveBoost(me, foe, reach, now, o, closing) {
      const dist = Math.hypot(foe.x - me.x, foe.y - me.y);
      const away = Math.atan2(me.y - foe.y, me.x - foe.x);
      const fire = dist < reach * o.triggerR && (closing == null || closing > 0);
      const a = fire ? away + 0.6 : away;
      const d = Math.max(reach * 1.8, dist);
      return { x: me.x + Math.cos(a) * d, y: me.y + Math.sin(a) * d, boost: fire };
    }
    // Bait: park on a wide ring the foe cannot ignore, then punish the commit (the bite engine runs
    // underneath as soon as he turns his tail).
    function bait(me, foe, reach, now, o) {
      const t = (now % 1600) / 1600 * Math.PI * 2;
      const r = reach * o.gapR;
      const a = Math.atan2(me.y - foe.y, me.x - foe.x);
      const px = foe.x + Math.cos(a + Math.sin(t) * 0.3) * r, py = foe.y + Math.sin(a + Math.sin(t) * 0.3) * r;
      const dx = px - me.x, dy = py - me.y, l = Math.hypot(dx, dy) || 1;
      return { x: me.x + dx / l * Math.min(l, reach), y: me.y + dy / l * Math.min(l, reach), boost: false };
    }
    return { clamp, wrapAngle, angleDelta, heading, offset, MotionTracker, evaluateAttack, TargetLock, interceptTime,
      uMoonwalk, windback, clockwork, straightMoonwalk, switchsideMoonwalk, defensiveBoost, bait };
  })();

  // ------------------------------------------------------------ socket tap
  const tap = { realm: null, socks: new Map(), socket: null };

  function patchGameRealm(w) {
    if (!w || tap.realm === w) return;
    try {
      const WS = w.WebSocket, ET = w.EventTarget.prototype;
      if (!WS || !ET) return;
      const send = WS.prototype.send, add = ET.addEventListener;
      WS.prototype.send = function (data) {
        mark(this);
        return send.call(this, data);
      };
      ET.addEventListener = function (type, fn, opts) {
        try {
          if (this instanceof WS && type === 'message' && typeof fn === 'function') mark(this).handlers.push(fn);
        } catch (_) {}
        return add.call(this, type, fn, opts);
      };
      tap.realm = w;
    } catch (_) {}
  }

  const appendChild = Node.prototype.appendChild;
  Node.prototype.appendChild = function (child, ...rest) {
    const node = appendChild.call(this, child, ...rest);
    try {
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
          : bot.pickOut ? 'rgba(255,120,120,0.85)' : 'rgba(255,212,121,0.55)');
        // working limit the bot actually steers inside, so a user can see the margin it respects
        if (px > 12) { ctx.setLineDash([5, 7]); ring(c, Math.max(4, px / g.R * g.lim), 'rgba(255,212,121,0.25)'); ctx.setLineDash([]); }
      }
    }
    if (bot.diag) {
      const d = bot.diag, g = d.geo;
      line(d.tail, COLOR.prey);
      const pc = screen(d.base.x, d.base.y), tc = screen(d.tail.x, d.tail.y), mc = screen(g.mouth.x, g.mouth.y);
      ctx.strokeStyle = '#ffb84d';                       // predicted centre vs raw snapshot diverge
      ctx.beginPath(); ctx.arc(pc.x, pc.y, 4, 0, Math.PI * 2); ctx.stroke();
      const kindColor = bot.targetKind === 'manual' ? '#57d7ff' : bot.targetKind === 'duel' ? '#ffe14d' : '#ff5566';
      const kindLabel = bot.targetKind === 'manual' ? 'ТВОЯ ЦЕЛЬ' : bot.targetKind === 'duel' ? 'ДУЭЛЬ' : 'ЦЕЛЬ';
      ctx.strokeStyle = kindColor; ctx.lineWidth = 2;    // the locked target, so a wrong pick is visible
      ctx.beginPath(); ctx.arc(pc.x, pc.y, 14, 0, Math.PI * 2); ctx.stroke(); ctx.lineWidth = 1;
      ctx.fillStyle = kindColor; ctx.font = '10px monospace';
      ctx.fillText(kindLabel, pc.x + 17, pc.y + 3); ctx.font = '11px monospace';
      ctx.strokeStyle = COLOR.prey;                      // tail cross
      ctx.beginPath();
      ctx.moveTo(tc.x - 5, tc.y - 5); ctx.lineTo(tc.x + 5, tc.y + 5);
      ctx.moveTo(tc.x + 5, tc.y - 5); ctx.lineTo(tc.x - 5, tc.y + 5);
      ctx.stroke();
      ctx.fillStyle = COLOR.self;                        // our mouth point
      ctx.beginPath(); ctx.arc(mc.x, mc.y, 2.5, 0, Math.PI * 2); ctx.fill();
      ctx.setLineDash([2, 3]); ctx.strokeStyle = '#ffb84d'; // mouth -> tail approach line
      ctx.beginPath(); ctx.moveTo(mc.x, mc.y); ctx.lineTo(tc.x, tc.y); ctx.stroke(); ctx.setLineDash([]);
      ctx.fillStyle = '#8892a0'; ctx.font = '10px monospace';
      ctx.fillText(`age ${d.base.ageMs != null ? Math.round(d.base.ageMs) : '-'}ms  m2t ${Math.round(g.mouthToTail)}  ` +
        `h±${Math.round(Math.abs(g.headingError) * 180 / Math.PI)}°  rear ${g.inRearSector ? 'Y' : 'n'}  ` +
        `front ${g.frontPathClear ? 'clear' : 'BLOCKED'}`, tc.x + 8, tc.y - 6);
      ctx.font = '11px monospace';
    } else if (bot.tail) {
      line(bot.tail, COLOR.prey);
      const s = screen(bot.tail.x, bot.tail.y);
      ctx.strokeStyle = COLOR.prey;
      ctx.beginPath();
      ctx.moveTo(s.x - 5, s.y - 5); ctx.lineTo(s.x + 5, s.y + 5);
      ctx.moveTo(s.x + 5, s.y - 5); ctx.lineTo(s.x - 5, s.y + 5);
      ctx.stroke();
    }
    if (bot.threat) line(bot.threat.target.position, COLOR.predator);
    ctx.fillStyle = bot.mode === 'evade' ? COLOR.predator : '#dddddd';
    ctx.fillText(MODE_RU[bot.mode] || bot.mode, self.x + 12, self.y + 24);
    }

    if (performance.now() < bot.pickArmed) {              // one-shot click mode is armed: say what to do
      ctx.fillStyle = '#ffd479'; ctx.font = 'bold 14px monospace'; ctx.textAlign = 'center';
      ctx.fillText('КЛИКНИ ЛЕВОЙ КНОПКОЙ ПО ПРОТИВНИКУ', W / 2, 34);
      ctx.textAlign = 'left'; ctx.font = '11px monospace';
    }

    if (CFG.radar) drawRadar(E, me, W, H);
  }
  function loop() { requestAnimationFrame(loop); paint(); }
  requestAnimationFrame(loop);
  window.__MOPE_DRAW = paint;   // test-rig hook: paint one ESP frame without spawning an extra rAF chain

  // ------------------------------------------------------------ menu
  // One PvP switch instead of four: the phases (chase / square up / feint / dart / bite) are picked by
  // geometry, so the user only decides whether the bot fights at all. Rows are one line each and the
  // explanation appears in the footer only while the mouse is on the row, which keeps the window small.
  const ROWS = [
    ['pvp', 'PvP-система', 'Всё бою одной кнопкой. Цель — та, по которой ты кликнул (короткий клик или правая кнопка); пока не выбирал, берёт равного под курсором, а в челлендж-арене — соперника из этой арены. Преследует, встаёт нос к носу, вблизи финт, чистый заход -> рывок на хвост и укус. Кто стоит на месте дольше двух секунд -- тот не соперник, а еда: бот перестаёт фехтовать, заходит ему в хвост и кусает сзади. Если сели НА НАШ хвост, орбита бросается: курсор уходит за тормоз и корпус разворачивается в лицо за полсекунды вместо трёх. Внутри дуэльного кольца за стену не лезет: кольцо сужается -- граница читается заново каждый кадр.'],
    ['dodge', 'Уклонение + защита', 'Убегает от более крупных; разворачивается лицом к равным по силе, целящимся в хвост.'],
    ['esp', 'ESP', 'Кольца + засечки направления на каждом звере; метка на краю экрана для хищников вне обзора.'],
    ['radar', 'Радар', 'Мини-карта в углу: каждый зверь точкой по уровню, не зависит от камеры.'],
    ['labels', 'Подписи', 'Вид / уровень / здоровье / имя печатаются рядом с каждым кольцом.'],
    ['ability', 'Способность при рывке', 'Заодно использует способность1 во время рывка (нужно включённое PvP).'],
    ['whip', 'Вихрь: 6 точек', 'Равномерный обход цели по шести точкам: дуга с движением лицом влево-вправо, затем один рывок на переход. Точки считаются по фактическому перемещению, направление не меняется случайно. Откат, запас ресурса и опасное сближение могут задержать рывок. Защита от атак имеет приоритет. Выбери цель кликом и включи F8; выключено по умолчанию.'],
  ];
  const panel = document.createElement('div');
  panel.id = 'mopeCheatPanel';
  Object.assign(panel.style, {
    position: 'fixed', top: '14px', left: '14px', zIndex: '2147483647',
    background: 'rgba(10,12,16,0.42)', color: '#e6edf3', font: '11px/1.35 monospace',
    padding: '6px 8px', borderRadius: '7px', border: '1px solid rgba(140,170,200,0.35)',
    minWidth: '196px', maxWidth: '240px', userSelect: 'none',
    backdropFilter: 'blur(3px)', textShadow: '0 1px 2px #000',
  });
  const rowsBox = document.createElement('div');
  const descBox = document.createElement('div');
  descBox.id = 'mopeCheatDesc';
  descBox.style.cssText = 'color:#9fb3c8;font-size:10px;line-height:1.25;min-height:13px;margin:2px 0 1px';
  const inputs = {}, bindChips = {};
  const chipStyle = 'min-width:38px;background:rgba(30,36,44,0.7);color:#9fd7ff;border:1px solid #3a4350;border-radius:3px;font:10px monospace;padding:1px 3px;cursor:pointer;text-shadow:none';
  const pretty = code => !code ? '—' : String(code).replace(/^Key/, '').replace(/^Digit/, '').replace('Insert', 'Ins').replace('Arrow', '');
  function paintBinds() {
    for (const a in bindChips) bindChips[a].textContent = pretty(CFG.binds[a]);
    if (menuChip) menuChip.textContent = pretty(CFG.binds.menu);
  }
  let arming = null;
  function armBind(action, el) {
    const prev = arming;
    if (prev) { prev.chip.textContent = pretty(CFG.binds[prev.action]); prev.chip.style.color = '#9fd7ff'; }
    arming = null;
    if (prev && prev.action === action) return;                    // clicking the same chip again cancels
    arming = { action, chip: el };
    el.textContent = 'клава?';
    el.style.color = '#ffd479';
  }
  for (const [key, name, desc] of ROWS) {
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;align-items:center;gap:5px;padding:1px 0';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = CFG[key];
    cb.addEventListener('change', () => { CFG[key] = cb.checked; saveCfg(); });
    const txt = document.createElement('span');
    txt.textContent = name;
    txt.style.cssText = 'flex:1;cursor:pointer';
    txt.title = desc;
    txt.addEventListener('click', () => { cb.checked = !cb.checked; cb.dispatchEvent(new Event('change')); });
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.dataset.bind = key;
    chip.title = 'Кнопка вкл/выкл — нажми и задай новую';
    chip.style.cssText = chipStyle;
    chip.addEventListener('click', () => armBind(key, chip));
    row.append(cb, txt, chip);
    rowsBox.appendChild(row);
    inputs[key] = cb;
    bindChips[key] = chip;   // every row owns a chip, even a currently unbound one (it must repaint to '—')
    row.addEventListener('mouseenter', () => { descBox.textContent = desc; });
    row.addEventListener('mouseleave', () => { descBox.textContent = ''; });
  }

  // ---- PvP tactics page: guide-video moves as one-active-at-a-time buttons. 'universal' hands the
  // frame back to the phase engine; a named tactic owns the cursor until switched off or replaced.
  const TACTIC_ROWS = [
    ['universal', 'Универсальное ПвП', 'Базовый режим: фазовый движок сам выбирает поведение по геометрии (уклон, тряска, деф, вихрь, байт, укус, рывок) и соблюдает правила из гайда — беречь буст, не повторять одно и то же движение, не лезть за стену арены.'],
    ['u', 'U Moonwalk (деф)', 'Дуга «U»: заход одним бортом, разворот носа на 180° через линию противника, выход другим бортом, повтор. Курсор ведётся плавно, без рывков; при срыве противника в погоню петля не дожимается — разворот лицом.'],
    ['windback', 'Windback (атака)', 'Держим линию укуса, затем резкий откат курсора назад: противник, разворачиваясь в ответ, подставляет хвост второй раз. Рывок в момент отката.'],
    ['clockwork', 'Clockwork (стратегия)', 'Равномерное вращение по кругу вокруг противника с постоянной угловой скоростью, нос чуть внутрь круга. Изматывание и выживание в зоне; буст не тратится. Выход в укус, когда противник потерял позицию.'],
    ['straight', 'Straight Line Moonwalk (деф)', 'Отход по прямой «лунной походкой»: курсор за спиной, тело пятится. Если прямая ведёт в стену или красный круг — переключиться на U-петлю (Failsafe), не меняя ритма.'],
    ['switchside', 'Switchside Moonwalk (деф)', 'Тот же отход, но со сменой борта каждые несколько циклов: противник не может предсказать, с какой стороны заходить.'],
    ['defboost', 'Defensive Boost (деф)', 'Рывок не от противника, а по дуге 60–90° в сторону от траектории его носа, с сохранением дистанции. Тратится только когда нос противника уже смотрит на нас.'],
    ['bait', 'Байт (приманка)', 'Держим широкий кольцо-стойку, которое враг не может игнорировать; как только он разворачивает хвост — подключается движок укуса и наказывает.'],
  ];
  const TACTIC_LABEL = { universal: 'Универсальное ПвП', u: 'U Moonwalk', windback: 'Windback',
    clockwork: 'Clockwork', straight: 'Straight Line', switchside: 'Switchside',
    defboost: 'Defensive Boost', bait: 'Байт' };

  const tacticsPage = document.createElement('div');
  tacticsPage.style.display = 'none';
  for (const [key, name, desc] of TACTIC_ROWS) {
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;align-items:center;gap:5px;padding:1px 0';
    const rb = document.createElement('input');
    rb.type = 'radio'; rb.name = 'mopeTactic'; rb.checked = CFG.tactic === key;
    rb.addEventListener('change', () => { if (rb.checked) { CFG.tactic = key; saveCfg(); } });
    const txt = document.createElement('span');
    txt.textContent = name;
    txt.style.cssText = 'flex:1;cursor:pointer';
    txt.title = desc;
    const chipKey = 'tactic' + key.charAt(0).toUpperCase() + key.slice(1);
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.dataset.bind = chipKey;
    chip.title = 'Клавиша включить тактику — нажми и задай новую';
    chip.style.cssText = chipStyle;
    chip.addEventListener('click', () => armBind(chipKey, chip));
    row.append(rb, txt, chip);
    row.addEventListener('mouseenter', () => { descBox.textContent = desc; });
    row.addEventListener('mouseleave', () => { descBox.textContent = ''; });
    tacticsPage.appendChild(row);
    bindChips[chipKey] = chip;
  }
  const TACTIC_KEYS = TACTIC_ROWS.map(r => r[0]);
  function setTactic(key) {
    if (!TACTIC_KEYS.includes(key)) return;
    CFG.tactic = key; saveCfg();
    const radios = tacticsPage.querySelectorAll('input[type=radio]');
    radios.forEach((rb, i) => { rb.checked = TACTIC_KEYS[i] === key; });
    say('тактика: ' + (TACTIC_LABEL[key] || key));
  }
  window.__MOPE_SET_TACTIC = setTactic;      // test-rig + bind hook
  window.__MOPE_GET_TACTIC = () => CFG.tactic;

  const pages = document.createElement('div');
  pages.style.cssText = 'display:flex;gap:4px;margin:2px 0';
  const tabPageBtns = [];
  function showPage(n) {
    rowsBox.style.display = n === 0 ? 'block' : 'none';
    tacticsPage.style.display = n === 1 ? 'block' : 'none';
    tabPageBtns.forEach((b, i) => { b.style.color = i === n ? '#7fd7ff' : '#e6edf3'; b.style.borderColor = i === n ? '#7fd7ff' : '#3a4350'; });
  }
  ['Функции', 'Функции PvP'].forEach((label, n) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = label;
    b.style.cssText = 'flex:1;background:rgba(30,36,44,0.7);color:#e6edf3;border:1px solid #3a4350;border-radius:3px;font:10px monospace;padding:2px 4px;cursor:pointer;text-shadow:none';
    b.addEventListener('click', () => showPage(n));
    pages.appendChild(b);
    tabPageBtns.push(b);
  });

  // ---- click-to-target. mope.io steers with the mouse and boosts with a held left button, so a click
  // may only be read as "this one" while the pick is ARMED (button or its bind): otherwise every boost
  // press would re-target. The chosen animal then beats both the arena opponent and the scoring.
  const targetRow = document.createElement('div');
  targetRow.style.cssText = 'display:flex;align-items:center;gap:5px;padding:3px 0 1px';
  const btnStyle = 'flex:1;min-width:0;background:rgba(30,36,44,0.7);color:#e6edf3;border:1px solid #3a4350;border-radius:3px;font:10px monospace;padding:1px 3px;cursor:pointer;text-shadow:none';
  const pickBtn = document.createElement('button');
  pickBtn.type = 'button';
  pickBtn.id = 'mopeCheatPick';
  pickBtn.style.cssText = btnStyle;
  pickBtn.addEventListener('click', () => armPick());
  const pickChip = document.createElement('button');
  pickChip.type = 'button';
  pickChip.dataset.bind = 'pick';
  pickChip.title = 'Клавиша "выбрать цель кликом" — нажми и задай новую';
  pickChip.style.cssText = chipStyle;
  pickChip.addEventListener('click', () => armBind('pick', pickChip));
  const clearBtn = document.createElement('button');
  clearBtn.type = 'button';
  clearBtn.id = 'mopeCheatClearTarget';
  clearBtn.textContent = '×';
  clearBtn.title = 'Снять выбранную цель';
  clearBtn.style.cssText = 'min-width:18px;background:rgba(30,36,44,0.7);color:#cdd7e2;border:1px solid #3a4350;border-radius:3px;font:11px monospace;padding:0 3px;cursor:pointer;text-shadow:none';
  clearBtn.addEventListener('click', () => clearPick());
  targetRow.append(pickBtn, pickChip, clearBtn);
  bindChips.pick = pickChip;
  rowsBox.appendChild(targetRow);
  const TARGET_DESC = 'Обычный клик (короткий) или правая кнопка по зверю = он цель, и PvP бьёт только его, пока он жив. Долгое зажатие левой кнопки остаётся бустом игры и цель не меняет. Кнопка/клавиша ниже только подсказывает: можно и с неё. × снимает выбор.';
  targetRow.title = TARGET_DESC;
  targetRow.addEventListener('mouseenter', () => { descBox.textContent = TARGET_DESC; });
  targetRow.addEventListener('mouseleave', () => { descBox.textContent = ''; });

  function syncTargetRow() {
    const armed = performance.now() < bot.pickArmed;
    const has = bot.pickId != null;
    pickBtn.textContent = armed ? 'жми по врагу' : has ? 'сменить цель' : 'цель: клик/ПКМ';
    pickBtn.style.color = armed ? '#ffd479' : '#e6edf3';
    clearBtn.style.display = has ? 'inline-block' : 'none';
  }
  function armPick() {
    const me = window.__M && window.__M.zy;
    if (!me || !me.spawned) { say('сначала войди в матч'); syncTargetRow(); return; }
    bot.pickArmed = performance.now() + CFG.pickArmMs;
    bot.pickMsg = '';
    syncTargetRow();
  }
  function clearPick() {
    bot.pickId = null; bot.pickArmed = 0; bot.targetKind = null; bot.lock && bot.lock.reset();
    say('цель снята, дальше сам');
    syncTargetRow();
  }
  // Where the pointer is in WORLD units. cam.Bx() is the client's own screen->world transform (the one
  // its hover/pick code uses), fed canvas device px; bot.cursor is the world point the server itself was
  // told about. Either one alone is enough -- and both are better than projecting every body, which
  // breaks the moment the device pixel ratio or a canvas offset moves.
  function worldUnderPointer(cam, cssX, cssY) {
    if (!cam || typeof cam.Bx !== 'function' || !cam.canvas) return null;
    const cv = cam.canvas;
    if (!(cv.clientWidth > 0) || !(cv.width > 0)) return null;
    const k = cv.width / cv.clientWidth || 1;
    const rect = cv.getBoundingClientRect ? cv.getBoundingClientRect() : { left: 0, top: 0 };
    const p = cam.Bx((cssX - (rect.left || 0)) * k, (cssY - (rect.top || 0)) * k);
    const x = p && p.x, y = p && p.y;
    return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null;
  }
  // Hit test. Tier 1: the click point through the client's own transform. Tier 2: the cursor point
  // decoded from opcode 114. Tier 3: project every body into CSS px. A pick that quietly found nobody
  // was the complaint, so no single shape may be the only way to land one.
  function pickAt(cssX, cssY) {
    const M = window.__M, E = window.__ENTS, me = M && M.zy, cam = M && M.Ar;
    if (!E || !me || !me.spawned) { say('нет матча'); syncTargetRow(); return null; }
    const cur = bot.cursor && performance.now() - bot.cursor.t < 1500 ? bot.cursor : null;
    const proj = !!(cam && typeof cam.tq === 'function' && cam.canvas && cam.canvas.clientWidth > 0);
    const k = proj ? (cam.canvas.width / cam.canvas.clientWidth || 1) : 1;
    const rect = proj && cam.canvas.getBoundingClientRect ? cam.canvas.getBoundingClientRect() : { left: 0, top: 0 };
    const ox = rect.left || 0, oy = rect.top || 0, unit = proj ? cam.zoom / k : 1;
    const passWorld = wp => {
      let best = null, bestD = Infinity;
      for (const e of E.values()) {
        if (e === me || !e.spawned || e.hole) continue;
        const t = e.target;
        if (!t || !t.position || !t.size) continue;        // never guess about a half-synced animal
        const p = e.position || t.position, d = Math.hypot(p.x - wp.x, p.y - wp.y);
        if (d > t.size.x / 2 + CFG.pickGrabWorld || d >= bestD) continue;   // nearest body wins
        bestD = d; best = e;
      }
      return best;
    };
    const passScreen = () => {
      let best = null, bestD = Infinity;
      for (const e of E.values()) {
        if (e === me || !e.spawned || e.hole) continue;
        const t = e.target;
        if (!t || !t.position || !t.size) continue;
        const p = e.position || t.position, s = cam.tq(p.x, p.y);
        const d = Math.hypot(s.x / k + ox - cssX, s.y / k + oy - cssY);
        if (d > Math.max(t.size.x / 2 * unit, CFG.pickGrabPx) || d >= bestD) continue;
        bestD = d; best = e;
      }
      return best;
    };
    let best = null;
    const wp = worldUnderPointer(cam, cssX, cssY);
    if (wp) best = passWorld(wp);
    if (!best && cur) best = passWorld(cur);
    if (!best && proj) best = passScreen();
    if (!best) { say('под курсором никого'); syncTargetRow(); return null; }
    bot.pickId = best.id;
    bot.targetKind = 'manual';        // label the ring on this frame, not after the next tick
    bot.lock && bot.lock.reset();
    // The player decides -- even about a bigger animal, but they hear what that costs.
    say(entName(best) + (best.tier > me.tier ? ' — крупнее нас, рискуем' : ' — цель'));
    syncTargetRow();
    return best;
  }
  // A left tap (press+release, short and still) is the picker: mope.io only boosts while the button is
  // HELD, so a tap costs nothing and never fights the boost. The right button is ours outright, and an
  // armed pick (bind / menu button) still accepts a click of any length.
  let tapDown = null;
  const overMenu = t => t instanceof Node && (panel.contains(t) || openBtn.contains(t));
  window.addEventListener('mousedown', e => {
    if (e.button === 2) {
      if (overMenu(e.target)) return;
      e.preventDefault();
      pickAt(e.clientX, e.clientY);
      bot.pickArmed = 0;
      return;
    }
    if (e.button !== 0) return;
    tapDown = { x: e.clientX, y: e.clientY, t: performance.now(), menu: overMenu(e.target) };
    if (tapDown.menu && performance.now() < bot.pickArmed) { bot.pickArmed = 0; syncTargetRow(); }
  }, true);
  window.addEventListener('mouseup', e => {
    if (e.button !== 0 || !tapDown) return;
    const t = tapDown; tapDown = null;
    if (t.menu) return;                                  // the menu swallows the click, as always
    const armed = performance.now() < bot.pickArmed;
    const held = performance.now() - t.t;
    const moved = Math.hypot(e.clientX - t.x, e.clientY - t.y);
    if (!armed && (held > CFG.pickTapMs || moved > CFG.pickTapPx)) return;   // a boost hold: hands off
    pickAt(e.clientX, e.clientY);
    bot.pickArmed = 0;
    syncTargetRow();
  }, true);
  window.addEventListener('contextmenu', e => { if (!overMenu(e.target)) e.preventDefault(); }, true);
  // test-rig hooks: arm the pick and read back the whole pick state (the rig clicks with a real event)
  window.__MOPE_ARM_PICK = armPick;
  window.__MOPE_CLEAR_PICK = clearPick;
  window.__MOPE_PICKSTATE = () => ({
    armed: performance.now() < bot.pickArmed, id: bot.pickId,
    kind: bot.targetKind, msg: performance.now() < bot.pickMsgUntil ? bot.pickMsg : '',
  });
  const skinRow = document.createElement('div');
  skinRow.style.cssText = 'display:flex;gap:6px;padding:5px 0 1px;align-items:center';
  const skinLabel = document.createElement('span');
  skinLabel.textContent = 'Скин';
  skinLabel.style.cssText = 'min-width:32px';
  const skinSel = document.createElement('select');
  skinSel.style.cssText = 'flex:1;min-width:0;background:rgba(30,36,44,0.7);color:#e6edf3;border:1px solid #3a4350;border-radius:3px;padding:1px 3px;font:10.5px monospace;text-shadow:none';
  skinSel.disabled = true;
  const skinInput = document.createElement('input');
  skinInput.type = 'number'; skinInput.min = '0'; skinInput.step = '1'; skinInput.value = String(CFG.skinSubspecies);
  skinInput.title = 'id скина (подвид) — ручной ввод';
  skinInput.style.cssText = 'width:46px;background:rgba(30,36,44,0.7);color:#e6edf3;border:1px solid #3a4350;border-radius:3px;padding:1px 3px;font:11px monospace;text-shadow:none';
  const applySkin = id => { CFG.skinSubspecies = Math.max(0, id | 0); skinInput.value = String(CFG.skinSubspecies); skinSel.value = String(CFG.skinSubspecies); window.__MOPE_SKIN = CFG.skinSubspecies; saveCfg(); };
  skinInput.addEventListener('change', () => applySkin(skinInput.value));
  skinSel.addEventListener('change', () => applySkin(skinSel.value));
  skinRow.append(skinLabel, skinSel, skinInput);
  const SKIN_DESC = 'Скин текущего зверя: список появится в матче, поле id — ручной ввод (подвид).';
  skinRow.title = SKIN_DESC;
  skinRow.addEventListener('mouseenter', () => { descBox.textContent = SKIN_DESC; });
  skinRow.addEventListener('mouseleave', () => { descBox.textContent = ''; });

  let lastSkinSig = '';
  function refreshSkinList() {
    const M = window.__M, me = M && M.zy;
    // texture path uses animalConfig.subspeciesEnum (zg()); the entity's own subspeciesEnum field
    // on some species is the ability enum, so prefer the config and fall back to the instance.
    const en = (me && me.animalConfig && me.animalConfig.subspeciesEnum) || (me && me.subspeciesEnum);
    if (!en || typeof en !== 'object') {
      if (lastSkinSig !== 'none') {
        lastSkinSig = 'none'; skinSel.disabled = true; skinSel.innerHTML = '';
        const o = document.createElement('option'); o.value = '0'; o.textContent = '(войдите в матч)'; skinSel.appendChild(o);
      }
      return;
    }
    const ids = Object.keys(en).filter(k => /^\d+$/.test(k)).map(Number).sort((a, b) => a - b);
    const sig = ids.map(i => i + ':' + en[i]).join(',');
    if (sig === lastSkinSig) return;
    lastSkinSig = sig;
    skinSel.disabled = false; skinSel.innerHTML = '';
    const off = document.createElement('option'); off.value = '0'; off.textContent = '0 — обычный'; skinSel.appendChild(off);
    for (const id of ids) { const o = document.createElement('option'); o.value = String(id); o.textContent = id + ' — ' + en[id]; skinSel.appendChild(o); }
    skinSel.value = String(CFG.skinSubspecies);
  }
  window.__MOPE_REFRESH_SKINS = refreshSkinList;   // test-rig hook: rebuild the skin <select> from the live enum

  const status = document.createElement('div');
  status.style.cssText = 'margin-top:3px;color:#9fb3c8;font-size:10px';
  const hint = document.createElement('div');
  hint.style.cssText = 'color:#7f8b99;font-size:10px;display:flex;align-items:center;gap:4px;margin-top:1px';
  const menuChip = document.createElement('button');
  menuChip.type = 'button';
  menuChip.dataset.bind = 'menu';
  menuChip.title = 'Клавиша показать/скрыть меню — нажми и задай новую';
  menuChip.style.cssText = chipStyle;
  menuChip.addEventListener('click', () => armBind('menu', menuChip));
  hint.append(document.createTextNode('меню'), menuChip, document.createTextNode('· тяни за заголовок'));
  const title = document.createElement('div');
  title.style.cssText = 'display:flex;justify-content:space-between;align-items:center;cursor:move;font-weight:bold;margin-bottom:3px;color:#7fd7ff';
  const titleText = document.createElement('span');
  titleText.textContent = 'mope боевой набор';
  const closeBtn = document.createElement('span');
  closeBtn.id = 'mopeCheatClose';
  closeBtn.textContent = '×';
  closeBtn.title = 'Скрыть меню';
  closeBtn.style.cssText = 'cursor:pointer;color:#cdd7e2;font-size:16px;line-height:1;padding:0 5px;border-radius:4px';
  closeBtn.addEventListener('pointerdown', e => e.stopPropagation());
  closeBtn.addEventListener('click', () => { CFG.showMenu = false; syncMenu(); saveCfg(); });
  title.append(titleText, closeBtn);
  panel.append(title, pages, rowsBox, tacticsPage, descBox, skinRow, status, hint);

  const openBtn = document.createElement('div');
  openBtn.id = 'mopeCheatOpen';
  openBtn.textContent = 'Меню';
  openBtn.title = 'Показать меню';
  Object.assign(openBtn.style, {
    position: 'fixed', top: '14px', left: '14px', zIndex: '2147483647',
    background: 'rgba(10,12,16,0.45)', color: '#9fd7ff', font: 'bold 11px monospace',
    padding: '4px 8px', borderRadius: '6px', border: '1px solid rgba(140,170,200,0.3)', cursor: 'pointer',
    userSelect: 'none', display: 'none', backdropFilter: 'blur(3px)', textShadow: '0 1px 2px #000',
  });
  openBtn.addEventListener('click', () => { CFG.showMenu = true; syncMenu(); saveCfg(); });

  function syncMenu() {
    for (const [key] of ROWS) inputs[key].checked = CFG[key];
    paintBinds();
    syncTargetRow();
    panel.style.display = CFG.showMenu ? 'block' : 'none';
    openBtn.style.display = CFG.showMenu ? 'none' : 'block';
  }
  syncMenu();
  showPage(0);

  function mountUI() {
    // mope.io rewrites <html> during bootstrap, which drops anything appended at document-start.
    // Re-attach whenever the page has orphaned our nodes; the JS state (window.__*) survives.
    const host = document.documentElement;
    if (!host) return;
    if (!overlay.isConnected) host.appendChild(overlay);
    if (!panel.isConnected) host.appendChild(panel);
    if (!openBtn.isConnected) host.appendChild(openBtn);
  }
  mountUI();

  setInterval(() => {
    mountUI();
    const M = window.__M, me = M && M.zy;
    if (!M) {
      status.textContent = STARTED_LATE
        ? 'скрипт стартовал после модуля игры: перезагрузи вкладку, поставив в менеджере скриптов режим document-start'
        : 'жду сокет игры';
      return;
    }
    if (!window.__HOOKED) { status.textContent = 'игра найдена, хук сущностей не сел'; return; }
    net(M);          // warm the zx shadow before the client's first pointer packet, so the cursor is known
    if (me) refreshSkinList();
    if (bot.pickMsg && performance.now() > bot.pickMsgUntil) bot.pickMsg = '';
    syncTargetRow();      // the 'кликни по врагу' label has to expire even when nothing else repaints
    const kindRu = { manual: 'выбрана', duel: 'дуэль', auto: 'авто' }[bot.targetKind] || 'нет';
    status.textContent = `${me ? 'уровень ' + me.tier : 'меню'} | зверей ${window.__ENTS.size} | ` +
      `${CFG.pvp ? (MODE_RU[bot.mode] || bot.mode) : 'pvp выкл (F1)'} | ` +
      (bot.err ? 'сбой: ' + bot.err.slice(0, 52) + ' | ' : '') +
      (bot.blk ? 'не едем: ' + bot.blk + ' | ' : '') +
      (arenaOf(me) ? 'кольцо ' + Math.round(bot.zoneR) + ' · до стены ' + bot.zoneGap + ' | ' : '') +
      (bot.pickMsg || 'цель: ' + entName(bot.target) + ' · ' + kindRu + (bot.pickOut ? ' · вне кольца' : ''));
  }, 500);

  let dragging = null;
  title.addEventListener('pointerdown', e => {
    dragging = { x: e.clientX - panel.offsetLeft, y: e.clientY - panel.offsetTop };
    title.setPointerCapture(e.pointerId);
  });
  title.addEventListener('pointermove', e => {
    if (!dragging) return;
    panel.style.left = e.clientX - dragging.x + 'px';
    panel.style.top = e.clientY - dragging.y + 'px';
  });
  title.addEventListener('pointerup', () => { dragging = null; });

  // Binds are data, not hardcoded: a chip click arms capture, the next key claims that action and frees
  // whoever held it before, so one key never drives two switches.
  window.addEventListener('keydown', e => {
    const t = e.target;
    if (arming) {
      const a = arming;
      arming = null;
      if (e.code !== 'Escape') {
        for (const other in CFG.binds) if (other !== a.action && CFG.binds[other] === e.code) CFG.binds[other] = '';
        CFG.binds[a.action] = e.code;
        saveCfg();
      }
      e.preventDefault();
      e.stopImmediatePropagation();
      syncMenu();
      return;
    }
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;   // let the game's chat / our number box type normally
    const action = Object.keys(CFG.binds).find(k => CFG.binds[k] === e.code);
    if (!action) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    if (action === 'pick') armPick();                       // an action, not a switch: it waits for one click
    else if (action === 'menu') CFG.showMenu = !CFG.showMenu;
    else if (action.startsWith('tactic') && action !== 'tactics') {
      const key = action === 'tacticU' ? 'u'
        : action === 'tacticWindback' ? 'windback'
        : action === 'tacticClock' ? 'clockwork'
        : action === 'tacticStraight' ? 'straight'
        : action === 'tacticSwitch' ? 'switchside'
        : action === 'tacticDefBoost' ? 'defboost'
        : action === 'tacticBait' ? 'bait' : null;
      if (key) setTactic(CFG.tactic === key ? 'universal' : key);   // same key again -> back to universal
    }
    else CFG[action] = !CFG[action];
    syncMenu();
    saveCfg();
  }, true);
})();
