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
