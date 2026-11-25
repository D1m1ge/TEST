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
