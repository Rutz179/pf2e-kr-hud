import { MODULE_ID, SimpleWindow, esc, localizeMaybe, readDragData, setting } from "./shared.mjs";

/* ======================================================================== *
 * Time of day + scene lighting (no SmallTime needed)
 * ======================================================================== */

function timeOfDay() {
  const dt = game.pf2e?.worldClock?.worldTime;
  if (dt && Number.isFinite(dt.hour)) return { h: dt.hour, m: dt.minute, label: dt.toFormat?.("yyyy.LL.dd") ?? "" };
  const s = ((game.time.worldTime % 86400) + 86400) % 86400;
  return { h: Math.floor(s / 3600), m: Math.floor((s % 3600) / 60), label: "" };
}

function phaseOf(h, m) {
  const t = h + m / 60;
  if (t >= 7 && t < 18) return { name: "낮", icon: "fa-sun" };
  if (t >= 5 && t < 7) return { name: "새벽", icon: "fa-cloud-sun" };
  if (t >= 18 && t < 20) return { name: "황혼", icon: "fa-cloud-moon" };
  return { name: "밤", icon: "fa-moon" };
}

/** 0 = full daylight, 1 = full night, with 2-hour dawn and dusk. */
function darknessFor(h, m) {
  const t = h + m / 60;
  if (t >= 7 && t < 18) return 0;
  if (t >= 20 || t < 5) return 1;
  if (t < 7) return 1 - (t - 5) / 2;
  return (t - 18) / 2;
}

function pf2eSyncsDarkness() {
  try { return !!game.settings.get("pf2e", "worldClock.syncDarkness"); } catch { return false; }
}

async function syncDarkness() {
  if (!game.users.activeGM?.isSelf || !setting("timeDarknessSync", true) || pf2eSyncsDarkness()) return;
  const scene = canvas?.scene;
  if (!scene || scene.getFlag(MODULE_ID, "noTimeSync")) return;
  const { h, m } = timeOfDay();
  const max = Math.clamp(Number(setting("timeDarknessMax", 0.85)) || 0.85, 0, 1);
  const target = Math.round(darknessFor(h, m) * max * 100) / 100;
  const current = Number(scene.environment?.darknessLevel ?? scene.darkness ?? 0);
  if (Math.abs(current - target) < 0.02) return;
  await scene.update({ "environment.darknessLevel": target }, { animateDarkness: 3000 });
}

async function setTimeOfDay(hh, mm) {
  const { h, m } = timeOfDay();
  let delta = (hh * 60 + mm - (h * 60 + m)) * 60;
  if (delta < 0) delta += 86400;
  if (delta) await game.time.advance(delta);
}

/* ======================================================================== *
 * Chat panel: calendar clock on top, dice bar floating above the input.
 * Neither is inserted into Foundry's chat layout (parts of it overlay that
 * area and swallowed the clicks); the dice bar is fixed-position and the chat
 * log gets matching bottom padding so no message hides behind it.
 * ======================================================================== */

const DICE = [
  { n: 4, icon: "fa-dice-d4" }, { n: 6, icon: "fa-dice-d6" }, { n: 8, icon: "fa-dice-d8" },
  { n: 10, icon: "fa-dice-d10" }, { n: 12, icon: "fa-dice-d12" }, { n: 20, icon: "fa-dice-d20" },
  { n: 100, icon: "fa-dice-d10", label: "%" }
];

function phaseEmoji(h, m) {
  const t = h + m / 60;
  if (t >= 7 && t < 18) return "☀️";
  if (t >= 5 && t < 7) return "🌅";
  if (t >= 18 && t < 20) return "🌇";
  return "🌙";
}

/* ------------------------------------------------------------------------ *
 * Calendar
 *
 * The date used to fall back to the plain Luxon date of PF2e's world clock —
 * i.e. the real-world calendar ("2026년 5월 11일"), because the clock exposes
 * no ready-made `date` string. The game date is built here instead, the same
 * way PF2e's own world clock does: its era, its year (with the era's year
 * offset, 2700 for Absalom Reckoning), the day, and the Golarion weekday.
 * ------------------------------------------------------------------------ */

const GOLARION_WEEKDAYS = ["문데이", "토일데이", "윌데이", "오스데이", "파이어데이", "스타데이", "선데이"];
const GOLARION_MONTHS = ["아바디우스", "칼리스트릴", "파라스트", "고즈란", "데스누스", "사레니스",
  "에라스투스", "아로두스", "로바", "라마샨", "네스", "쿠토나"];
const EARTH_WEEKDAYS = ["월요일", "화요일", "수요일", "목요일", "금요일", "토요일", "일요일"];

const ERAS = {
  AR: { label: "골라리온력", offset: 2700, golarion: true },
  IC: { label: "제국력", offset: 5200, golarion: true },
  AD: { label: "서기", offset: 0, golarion: false },
  CE: { label: "서기", offset: 0, golarion: false }
};

function dateTheme() {
  const wc = game.pf2e?.worldClock;
  let theme = wc?.dateTheme;
  if (!theme) { try { theme = game.settings.get("pf2e", "worldClock.dateTheme"); } catch { theme = "AR"; } }
  return ERAS[theme] ? theme : "AR";
}

/** The game's current moment as plain numbers (weekday 1 = Monday … 7 = Sunday). */
function gameMoment() {
  const dt = game.pf2e?.worldClock?.worldTime;
  if (dt?.isValid !== false && Number.isFinite(dt?.year)) {
    return { year: dt.year, month: dt.month, day: dt.day, weekday: dt.weekday, hour: dt.hour, minute: dt.minute };
  }
  // No PF2e clock: the same arithmetic on the raw setting, in UTC like PF2e.
  let base = 0;
  try { base = Date.parse(game.settings.get("pf2e", "worldClock.worldCreatedOn")) || 0; } catch { base = 0; }
  const d = new Date(base + Number(game.time.worldTime || 0) * 1000);
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate(),
    weekday: ((d.getUTCDay() + 6) % 7) + 1, hour: d.getUTCHours(), minute: d.getUTCMinutes() };
}

/** "골라리온력 4726년 5월 11일 문데이" */
export function formatGameDate(m, theme = dateTheme(), systemYear = null) {
  const { year, day } = formatGameDateParts(m, theme, systemYear);
  return `${year} ${day}`;
}

/** The same date in two lines: "골라리온력 4726년" / "3월 15일 문데이". */
export function formatGameDateParts(m, theme = dateTheme(), systemYear = null) {
  const era = ERAS[theme] ?? ERAS.AR;
  const year = Number.isFinite(systemYear) ? systemYear : m.year + era.offset;
  const weekday = (era.golarion ? GOLARION_WEEKDAYS : EARTH_WEEKDAYS)[(m.weekday - 1 + 7) % 7];
  return { year: `${era.label} ${year}년`, day: `${m.month}월 ${m.day}일 ${weekday}` };
}

/** "오후 3:05" — or "15:05" when the 24-hour clock is chosen. */
export function formatGameTime(h, min, twelveHour = true) {
  const mm = String(min).padStart(2, "0");
  if (!twelveHour) return `${String(h).padStart(2, "0")}:${mm}`;
  return `${h < 12 ? "오전" : "오후"} ${h % 12 || 12}:${mm}`;
}

function calendarText() {
  const m = gameMoment();
  const theme = dateTheme();
  const wcYear = Number(game.pf2e?.worldClock?.year);
  const era = ERAS[theme];
  const parts = formatGameDateParts(m, theme, Number.isFinite(wcYear) ? wcYear : null);
  return {
    date: `${parts.year} ${parts.day}`,
    year: parts.year,
    day: parts.day,
    month: era.golarion ? GOLARION_MONTHS[m.month - 1] : `${m.month}월`,
    time: formatGameTime(m.hour, m.minute, setting("clock12h", true) !== false),
    emoji: phaseEmoji(m.hour, m.minute),
    phase: phaseOf(m.hour, m.minute).name
  };
}

const TIME_STEPS = [
  [-86400, "−1일"], [-3600, "−1시간"], [-600, "−10분"],
  [600, "+10분"], [3600, "+1시간"], [86400, "+1일"]
];

/*
 * The clock floats like the dice bar: fixed position, aligned with the chat
 * input, sitting where the message list starts; the list gets a matching top
 * margin. Inside Foundry's chat layout its buttons were covered and never
 * received clicks. It is built once; later updates only change the text, so a
 * click can't land on a button that was just replaced.
 */
function clockSkeleton() {
  const steps = game.user.isGM
    ? `<div class="steps">${TIME_STEPS.map(([s, l]) =>
        `<button type="button" data-adv="${s}" class="${s < 0 ? "back" : "fwd"}" data-tooltip="${s < 0 ? "되돌리기" : "앞으로"} ${l.slice(1)}">${l}</button>`).join("")}</div>`
    : "";
  return `<div class="main"><span class="emoji"></span><span class="date"><span class="year"></span><span class="day"></span></span><b class="time"></b></div>${steps}`;
}

function updateClockText(clock) {
  const c = calendarText();
  const set = (sel, text) => { const el = clock.querySelector(sel); if (el && el.textContent !== text) el.textContent = text; };
  set(".emoji", c.emoji);
  set(".year", c.year);
  set(".day", c.day);
  set(".time", c.time);
  const main = clock.querySelector(".main");
  if (main) main.dataset.tooltip = `${esc(c.month)} · ${esc(c.phase)}${game.user.isGM ? "<br><small>눌러서 시각 지정 · 조명 설정</small>" : ""}`;
}

function mountClock() {
  let clock = document.getElementById("pkh-clock");
  if (!setting("chatDock", true)) { clock?.remove(); return; }
  if (clock && (clock.tagName !== "DIV" || clock.parentElement !== document.body)) { clock.remove(); clock = null; }
  if (!clock) {
    clock = document.createElement("div");
    clock.id = "pkh-clock";
    clock.innerHTML = clockSkeleton();
    clock.addEventListener("click", ev => {
      if (!game.user.isGM) return;
      const step = ev.target.closest("[data-adv]");
      if (step) return game.time.advance(Number(step.dataset.adv));
      if (ev.target.closest(".main")) openClock(clock);
    });
    document.body.appendChild(clock);
  }
  updateClockText(clock);
  placeDice();
}

function mountDice() {
  let bar = document.getElementById("pkh-dice");
  if (!setting("chatDock", true)) { bar?.remove(); return; }
  if (!bar) {
    bar = document.createElement("section");
    bar.id = "pkh-dice";
    bar.innerHTML = `<div class="pkh-dock-typing" aria-live="polite"></div>
      ${DICE.map(d => `<button type="button" data-die="${d.n}" data-tooltip="1d${d.n}<br><small>Shift: 2개</small>">
        <i class="fa-solid ${d.icon}"></i>${d.label ? `<b>${d.label}</b>` : ""}</button>`).join("")}
      <span class="sep"></span>
      ${[5, 11].map(dc => `<button type="button" class="flat" data-flat="${dc}" data-tooltip="플랫 체크 DC ${dc}${dc === 5 ? "<br><small>숨겨짐·집중 방해 등</small>" : "<br><small>은폐·감지 등</small>"}" aria-label="플랫 체크 DC ${dc}">
        <i class="fa-solid fa-dice-d20"></i><span class="dc">${dc}</span></button>`).join("")}`;
    bar.addEventListener("click", onDiceClick);
    document.body.appendChild(bar);
  }
  placeDice();
}

/**
 * Dice bar: just above the chat input, as wide as it. Clock: where the message
 * list starts, equally wide. The log gets matching bottom padding and top
 * margin, so no message ever hides behind either.
 */
function placeDice() {
  const bar = document.getElementById("pkh-dice");
  const clock = document.getElementById("pkh-clock");
  const root = ui.chat?.element?.[0] ?? ui.chat?.element;
  const input = root?.querySelector?.("#chat-message, .chat-form, form, prose-mirror");
  const box = input?.getBoundingClientRect?.();
  const visible = !!box && box.width > 0 && root.offsetParent !== null;
  bar?.classList.toggle("hidden", !visible);
  if (visible && bar) {
    const controls = root.querySelector("#roll-privacy, .roll-privacy, .chat-controls, #chat-controls");
    const top = Math.min(box.top, controls?.getBoundingClientRect?.().top ?? box.top);
    bar.style.left = `${Math.round(box.left)}px`;
    bar.style.width = `${Math.round(box.width)}px`;
    bar.style.top = `${Math.round(top - bar.offsetHeight - 4)}px`;
    // Room for the bar and for the "입력 중" line riding on top of it.
    const typing = document.body.classList.contains("pkh-typing-in-dock") ? 20 : 0;
    root.style.setProperty("--pkh-dice-h", `${bar.offsetHeight + 6 + typing}px`);
    root.classList.add("pkh-has-dice");
  }

  if (!clock) return;
  const log = root?.querySelector?.("#chat-log, ol.chat-log, .chat-log");
  const logBox = log?.getBoundingClientRect?.();
  const clockVisible = visible && !!logBox && logBox.width > 0;
  clock.classList.toggle("hidden", !clockVisible);
  if (!clockVisible) { root?.classList.remove("pkh-has-clock"); return; }
  // The log's top without our margin is where the clock goes.
  const applied = root.classList.contains("pkh-has-clock") ? (parseFloat(getComputedStyle(log).marginTop) || 0) : 0;
  const top = logBox.top - applied;
  root.classList.add("pkh-has-clock");
  clock.style.left = `${Math.round(box.left)}px`;
  clock.style.width = `${Math.round(box.width)}px`;
  clock.style.top = `${Math.round(top + 2)}px`;
  root.style.setProperty("--pkh-clock-h", `${clock.offsetHeight + 6}px`);
}

function refreshClocks() {
  mountClock();
}

async function onDiceClick(ev) {
  const die = ev.target.closest("[data-die]");
  if (die) {
    const count = ev.shiftKey ? 2 : 1;
    const roll = await new Roll(`${count}d${die.dataset.die}`).evaluate();
    return roll.toMessage({ speaker: ChatMessage.getSpeaker(), flavor: `${count}d${die.dataset.die}` });
  }
  const flat = ev.target.closest("[data-flat]");
  if (flat) {
    const dc = Number(flat.dataset.flat);
    const roll = await new Roll("1d20").evaluate();
    const ok = roll.total >= dc;
    return roll.toMessage({
      speaker: ChatMessage.getSpeaker(),
      flavor: `플랫 체크 DC ${dc} — <b style="color:${ok ? "#3f7f2f" : "#a83a2f"}">${ok ? "성공" : "실패"}</b>`
    });
  }
}

function openClock(anchor) {
  document.getElementById("pkh-clock-pop")?.remove();
  const pop = document.createElement("section");
  pop.id = "pkh-clock-pop";
  const { h, m } = timeOfDay();
  const noSync = !!canvas?.scene?.getFlag(MODULE_ID, "noTimeSync");
  pop.innerHTML = `
    <div class="row">${[["6:00", "아침"], ["12:00", "정오"], ["18:00", "저녁"], ["0:00", "자정"]]
      .map(([t, l]) => `<button type="button" data-set="${t}">${l}</button>`).join("")}
      <input type="time" value="${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}"><button type="button" data-act="go">이동</button></div>
    <label class="row"><input type="checkbox" ${noSync ? "" : "checked"} data-act="sync"> 이 장면 조명을 시간에 맞추기</label>
    ${pf2eSyncsDarkness() ? `<p class="hint">PF2e 월드 시계의 '장면 어둠 동기화'가 켜져 있어 그쪽이 조명을 맞춥니다.</p>` : ""}`;
  document.body.appendChild(pop);
  const box = anchor.getBoundingClientRect();
  pop.style.left = `${Math.max(8, Math.min(window.innerWidth - pop.offsetWidth - 8, box.left))}px`;
  pop.style.top = `${Math.max(8, box.top - pop.offsetHeight - 6)}px`;
  pop.addEventListener("click", async e => {
    const b = e.target.closest("button, input[type=checkbox]");
    if (!b) return;
    if (b.dataset.adv) await game.time.advance(Number(b.dataset.adv));
    else if (b.dataset.set) await setTimeOfDay(...b.dataset.set.split(":").map(Number));
    else if (b.dataset.act === "go") await setTimeOfDay(...pop.querySelector("input[type=time]").value.split(":").map(Number));
    else if (b.dataset.act === "sync") {
      await canvas.scene?.setFlag(MODULE_ID, "noTimeSync", !b.checked);
      if (b.checked) await syncDarkness();
      return;
    }
    pop.remove();
  });
  setTimeout(() => document.addEventListener("pointerdown", function close(e) {
    if (!pop.contains(e.target)) { pop.remove(); document.removeEventListener("pointerdown", close, true); }
  }, true), 0);
}

/* ======================================================================== *
 * Roll request & macro generator (GM)
 * ======================================================================== */

// PF2e level-based DCs (GM Core table 10-5) and difficulty adjustments.
const LEVEL_DC = [14, 15, 16, 18, 19, 20, 22, 23, 24, 26, 27, 28, 30, 31, 32, 34, 35, 36, 38, 39, 40, 42, 44, 46, 48, 50];
const ADJUST = { "-10": "믿기 힘들 만큼 쉬움", "-5": "매우 쉬움", "-2": "쉬움", "0": "보통", "2": "어려움", "5": "매우 어려움", "10": "믿기 힘들 만큼 어려움" };
const SAVES = { fortitude: "인내", reflex: "반사", will: "의지" };

function checkOptions() {
  const skills = Object.entries(CONFIG.PF2E?.skills ?? {})
    .map(([slug, v]) => ({ slug, label: localizeMaybe(v?.label ?? v) || slug }))
    .sort((a, b) => a.label.localeCompare(b.label, "ko"));
  return [{ slug: "perception", label: "지각" }, ...Object.entries(SAVES).map(([slug, label]) => ({ slug, label, save: true })), ...skills];
}

function requestContent({ checks, dc, secret, basic, note }) {
  const parts = checks.map(c => {
    const params = [c.slug];
    if (dc) params.push(`dc:${dc}`);
    if (basic && SAVES[c.slug]) params.push("basic");
    if (secret) params.push("traits:secret");
    return `@Check[${params.join("|")}]`;
  });
  return `<div class="pkh-save-request"><header><i class="fa-solid fa-dice-d20"></i> <strong>굴림 요청</strong>${dc ? ` — DC <b>${dc}</b>` : ""}${secret ? " <em>(비밀)</em>" : ""}</header>
    ${note ? `<p>${esc(note)}</p>` : ""}<div class="checks">${parts.join(" ")}</div></div>`;
}

export function openRollRequest() {
  if (!game.user.isGM) return;
  const opts = checkOptions();
  const html = `<div class="pkh-request">
    <div class="pkh-req-grid">${opts.map(o => `<label class="${o.save ? "save" : ""}"><input type="checkbox" value="${o.slug}"> ${esc(o.label)}</label>`).join("")}</div>
    <div class="pkh-req-row">DC <input type="number" name="dc" min="0" max="60" style="width:70px" placeholder="없음">
      <span class="hint">레벨</span><select name="lv">${LEVEL_DC.map((d, i) => `<option value="${i}">${i}</option>`).join("")}</select>
      <select name="adj">${Object.entries(ADJUST).map(([v, l]) => `<option value="${v}" ${v === "0" ? "selected" : ""}>${l}</option>`).join("")}</select>
      <button type="button" data-act="lvdc">레벨 DC 넣기</button></div>
    <div class="pkh-req-row"><label><input type="checkbox" name="secret"> 비밀 굴림</label>
      <label><input type="checkbox" name="basic"> 기본 내성</label>
      <input type="text" name="note" placeholder="설명 (선택): 예) 함정이 작동합니다!" style="flex:1"></div>
    <div class="pkh-req-row"><input type="text" name="mname" placeholder="매크로 이름 (예: 함정 반사 DC 20)" style="flex:1">
      <button type="button" data-act="macro"><i class="fa-solid fa-scroll"></i> 매크로로 저장</button>
      <button type="button" data-act="send" class="primary"><i class="fa-solid fa-paper-plane"></i> 채팅에 보내기</button></div>
    <p class="hint">플레이어는 카드의 버튼으로 자기 캐릭터를 굴리고, GM은 토큰을 선택한 뒤 눌러 NPC를 굴립니다. 매크로는 GM 팔레트 빈칸에 자동으로 들어갑니다.</p>
  </div>`;
  new SimpleWindow({
    id: `${MODULE_ID}-roll-request`, title: "굴림 요청 · 매크로 만들기", width: 560, html,
    onRender: (root, app) => {
      const read = () => ({
        checks: [...root.querySelectorAll(".pkh-req-grid input:checked")].map(i => opts.find(o => o.slug === i.value)),
        dc: Number(root.querySelector("[name=dc]").value) || null,
        secret: root.querySelector("[name=secret]").checked,
        basic: root.querySelector("[name=basic]").checked,
        note: root.querySelector("[name=note]").value.trim()
      });
      root.addEventListener("click", async ev => {
        const act = ev.target.closest("button[data-act]")?.dataset.act;
        if (act === "lvdc") {
          const lv = Number(root.querySelector("[name=lv]").value);
          root.querySelector("[name=dc]").value = LEVEL_DC[lv] + Number(root.querySelector("[name=adj]").value);
          return;
        }
        if (act !== "send" && act !== "macro") return;
        const data = read();
        if (!data.checks.length) return ui.notifications.warn("PF2e-KR HUD | 굴림을 하나 이상 고르세요.");
        const content = requestContent(data);
        if (act === "send") {
          await ChatMessage.create({ speaker: ChatMessage.getSpeaker({ alias: "GM" }), content });
          return app.close();
        }
        const name = root.querySelector("[name=mname]").value.trim()
          || `${data.checks.map(c => c.label).join("·")}${data.dc ? ` DC ${data.dc}` : ""}`;
        const macro = await Macro.create({
          name, type: "script", img: "icons/svg/d20-highlight.svg",
          command: `ChatMessage.create({ speaker: ChatMessage.getSpeaker({ alias: "GM" }), content: ${JSON.stringify(content)} });`
        });
        const placed = await game.pkhPalette?.addEntry({ type: "macro", uuid: macro.uuid });
        ui.notifications.info(`PF2e-KR HUD | 매크로 "${name}"을 만들었습니다${placed ? " — GM 팔레트에 넣었습니다" : ""}.`);
      });
    }
  }).render({ force: true });
}

/* ======================================================================== *
 * GM palette: a small always-on grid of macros / effects / conditions that
 * apply to whichever tokens are selected.
 * ======================================================================== */

const SIZES = { "3x2": [3, 2], "4x2": [4, 2], "4x3": [4, 3], "5x3": [5, 3], "6x2": [6, 2] };

class GmPalette {
  constructor() { this.el = null; }

  data() {
    return foundry.utils.mergeObject({ slots: [], x: null, y: null, locked: true, open: false },
      game.user.getFlag(MODULE_ID, "palette") ?? {}, { inplace: false });
  }

  async save(changes) {
    await game.user.setFlag(MODULE_ID, "palette", { ...this.data(), ...changes });
  }

  async toggle() {
    await this.save({ open: !this.data().open });
    this.render();
  }

  async addEntry(entry) {
    const d = this.data();
    const [c, r] = SIZES[setting("paletteSize", "3x2")] ?? [3, 2];
    const slots = Array.from({ length: c * r }, (_, i) => d.slots[i] ?? null);
    const i = slots.findIndex(s => !s);
    if (i < 0) return false;
    slots[i] = entry;
    await this.save({ slots, open: true });
    this.render();
    return true;
  }

  render() {
    if (!game.user.isGM) return;
    const d = this.data();
    if (!d.open) { this.el?.remove(); this.el = null; return; }
    const [cols, rows] = SIZES[setting("paletteSize", "3x2")] ?? [3, 2];
    if (!this.el) {
      this.el = document.createElement("section");
      this.el.id = "pkh-palette";
      document.body.appendChild(this.el);
      this.el.addEventListener("click", ev => this.onClick(ev));
      this.el.addEventListener("contextmenu", ev => this.onContext(ev));
      this.el.addEventListener("dragover", ev => { if (!this.data().locked) ev.preventDefault(); });
      this.el.addEventListener("drop", ev => this.onDrop(ev));
      this.el.addEventListener("pointerdown", ev => this.onDragWindow(ev));
    }
    const cells = Array.from({ length: cols * rows }, (_, i) => {
      const e = d.slots[i];
      if (!e) return `<div class="cell empty" data-i="${i}"></div>`;
      const doc = e.uuid ? fromUuidSync(e.uuid) : null;
      const name = e.name ?? doc?.name ?? "?";
      const img = e.img ?? doc?.img ?? "icons/svg/mystery-man.svg";
      return `<div class="cell t-${e.type}" data-i="${i}" data-tooltip="${esc(name)}<br><small>${e.type === "condition" ? "클릭 +1 · 우클릭 −1" : e.type === "effect" ? "클릭: 넣기/빼기" : "클릭: 실행"} · 선택한 토큰에</small>">
        <img src="${esc(img)}" alt=""></div>`;
    }).join("");
    this.el.classList.toggle("unlocked", !d.locked);
    this.el.style.setProperty("--cols", cols);
    this.el.style.setProperty("--pal-opacity", String(setting("paletteOpacity", 0.75)));
    this.el.innerHTML = `
      <header data-drag>
        <span>GM 팔레트</span>
        <button type="button" data-act="lock" data-tooltip="${d.locked ? "잠김 — 눌러서 편집(이동·추가·제거)" : "편집 중 — 끌어서 이동, 끌어다 놓아 추가, 우클릭 제거"}"><i class="fa-solid ${d.locked ? "fa-lock" : "fa-lock-open"}"></i></button>
        <button type="button" data-act="close" data-tooltip="닫기"><i class="fa-solid fa-xmark"></i></button>
      </header>
      <div class="grid">${cells}</div>`;
    const x = d.x ?? window.innerWidth - 360;
    const y = d.y ?? 120;
    this.el.style.left = `${Math.max(0, Math.min(window.innerWidth - 60, x))}px`;
    this.el.style.top = `${Math.max(0, Math.min(window.innerHeight - 40, y))}px`;
  }

  targets() {
    return (canvas?.tokens?.controlled ?? []).map(t => t.actor).filter(a => a?.isOwner);
  }

  async onClick(ev) {
    const act = ev.target.closest("button[data-act]")?.dataset.act;
    if (act === "lock") { await this.save({ locked: !this.data().locked }); return this.render(); }
    if (act === "close") return this.toggle();
    const cell = ev.target.closest(".cell:not(.empty)");
    if (!cell) return;
    const e = this.data().slots[Number(cell.dataset.i)];
    if (e.type === "macro") return (await fromUuid(e.uuid))?.execute();
    const targets = this.targets();
    if (!targets.length) return ui.notifications.warn("PF2e-KR HUD | 먼저 토큰을 선택하세요.");
    if (e.type === "condition") for (const a of targets) await a.increaseCondition?.(e.slug);
    if (e.type === "effect") await toggleEffect(targets, e.uuid);
  }

  async onContext(ev) {
    ev.preventDefault();
    const cell = ev.target.closest(".cell:not(.empty)");
    if (!cell) return;
    const d = this.data();
    const i = Number(cell.dataset.i);
    if (!d.locked) {
      const slots = [...d.slots];
      slots[i] = null;
      await this.save({ slots });
      return this.render();
    }
    const e = d.slots[i];
    const targets = this.targets();
    if (e.type === "condition") for (const a of targets) await a.decreaseCondition?.(e.slug);
    if (e.type === "effect") await toggleEffect(targets, e.uuid, { removeOnly: true });
  }

  async onDrop(ev) {
    const d = this.data();
    if (d.locked) return;
    ev.preventDefault();
    const data = readDragData(ev);
    const cell = ev.target.closest(".cell");
    let entry = null;
    if (data?.type === "Macro" && data.uuid) entry = { type: "macro", uuid: data.uuid };
    else if (data?.type === "Item" && data.uuid) {
      const doc = await fromUuid(data.uuid);
      if (doc?.type === "condition") entry = { type: "condition", slug: doc.slug, name: doc.name, img: doc.img };
      else if (doc?.type === "effect") entry = { type: "effect", uuid: doc.parent ? (doc._stats?.compendiumSource ?? doc.uuid) : doc.uuid };
    }
    if (!entry) return ui.notifications.warn("PF2e-KR HUD | 매크로, 효과, 상태만 올릴 수 있습니다.");
    const [c, r] = SIZES[setting("paletteSize", "3x2")] ?? [3, 2];
    const slots = Array.from({ length: c * r }, (_, i) => d.slots[i] ?? null);
    const at = cell ? Number(cell.dataset.i) : slots.findIndex(s => !s);
    if (at < 0) return ui.notifications.warn("PF2e-KR HUD | 빈칸이 없습니다.");
    slots[at] = entry;
    await this.save({ slots });
    this.render();
  }

  onDragWindow(ev) {
    if (this.data().locked || !ev.target.closest("[data-drag]") || ev.target.closest("button")) return;
    const el = this.el;
    const start = { x: ev.clientX - el.offsetLeft, y: ev.clientY - el.offsetTop };
    const move = e => { el.style.left = `${e.clientX - start.x}px`; el.style.top = `${e.clientY - start.y}px`; };
    const up = () => {
      document.removeEventListener("pointermove", move);
      document.removeEventListener("pointerup", up);
      this.save({ x: el.offsetLeft, y: el.offsetTop });
    };
    document.addEventListener("pointermove", move);
    document.addEventListener("pointerup", up);
  }
}

async function toggleEffect(targets, uuid, { removeOnly = false } = {}) {
  const source = await fromUuid(uuid);
  if (!source) return;
  const slug = source.slug ?? source.system?.slug;
  for (const actor of targets) {
    const existing = actor.itemTypes?.effect?.find(e =>
      (e._stats?.compendiumSource ?? e.flags?.core?.sourceId) === uuid || (slug && e.slug === slug));
    if (existing) await existing.delete();
    else if (!removeOnly) {
      const data = source.toObject();
      delete data._id;
      data._stats = { ...(data._stats ?? {}), compendiumSource: source.uuid };
      await actor.createEmbeddedDocuments("Item", [data]);
    }
  }
}

/* ======================================================================== *
 * Health estimate on hover (for tokens you can't see the HP of)
 * ======================================================================== */

function healthLevels() {
  const text = String(setting("healthLevels", "") || "75:가벼운 부상|50:부상|25:심한 부상|1:죽음의 문턱");
  return text.split("|").map(p => p.split(":")).map(([pct, label]) => ({ pct: Number(pct), label: (label ?? "").trim() }))
    .filter(l => Number.isFinite(l.pct) && l.label).sort((a, b) => b.pct - a.pct);
}

export function healthEstimate(actor) {
  const hp = actor?.system?.attributes?.hp;
  if (!hp || !Number(hp.max)) return null;
  const pct = Math.max(0, Number(hp.value)) / Number(hp.max) * 100;
  const levels = healthLevels();
  if (pct <= 0) return { label: setting("healthZero", "쓰러짐") || "쓰러짐", pct, depth: 1, top: 0, floor: 0, rank: levels.length + 1 };
  if (pct >= 100) return { label: setting("healthFull", "건강함") || "건강함", pct, depth: 0, top: 100, floor: 100, rank: 0 };
  let index = levels.findIndex(l => pct >= l.pct);
  if (index < 0) index = levels.length - 1;
  const hit = levels[index];
  // The band this HP falls in, and how far down it sits: 0 at its top, 1 at its floor.
  const top = index > 0 ? levels[index - 1].pct : 100;
  const floor = hit?.pct ?? 0;
  const depth = top > floor ? Math.clamp((top - pct) / (top - floor), 0, 1) : 0;
  return { label: hit?.label ?? "", pct, depth, top, floor, rank: index + 1 };
}

/*
 * Colour of the label.
 *
 * Each label keeps its own hue (taken from the middle of its band: green for
 * a scratch, yellow, orange, red near death), so labels never blur into one
 * another. Within a label the colour deepens — darker and more saturated —
 * as HP falls toward the bottom of that band. Two "심한 부상" therefore read
 * differently: one just inside the band, one about to drop out of it.
 */
export function healthColour(est) {
  // Full health is what people see most: a calm, muted green rather than a bright one.
  if (!Number(est.rank)) return { hue: 140, sat: 20, light: 28 };
  const mid = (Number(est.top) + Number(est.floor)) / 2;
  const hue = Math.round(Math.clamp(mid, 0, 100) * 1.2);
  const depth = Math.clamp(Number(est.depth) || 0, 0, 1);
  const sat = Math.round(46 + depth * 24);
  const light = Math.round(Math.max(12, 38 - (Number(est.rank) || 0) * 2 - depth * 16));
  return { hue, sat, light };
}

/*
 * Token tooltip: distance and health estimate, stacked above the hovered token
 *
 *        [ 📏 35 ft. ]      ← distance from your token (top)
 *     [ 가벼운 부상 ]        ← health estimate (under it)
 *        ┌──────┐
 *        │token │
 *        └──────┘
 *          name             ← Foundry's nameplate stays below, untouched
 *
 * This is how PF2e HUD's token tooltip does it: one stack above the token,
 * with the distance as a tab on top of the status, and the PF2e system's own
 * hover-distance label switched off so the two never collide. Here the
 * system label is only hidden by CSS while our distance is on (the system
 * setting itself is left alone). Near the top edge of the screen the stack
 * flips below the token, under its nameplate.
 */

/** Top edge, in canvas coordinates, of anything drawn above the token (elevation text and the like). */
function decorationTop(token) {
  let top = Infinity;
  const mid = (token.bounds?.y ?? token.y) + (token.bounds?.height ?? token.h) / 2;
  for (const child of [token.tooltip, token.nameplate]) {
    if (!child?.parent || !child.visible || !child.text) continue;
    try {
      const local = child.getLocalBounds();
      const y = canvas.stage.toLocal(child.toGlobal(new PIXI.Point(0, local.y))).y;
      if (y < mid) top = Math.min(top, y);
    } catch (_) { /* not drawn yet */ }
  }
  return top;
}

/** Bottom edge of a token's nameplate in canvas coordinates, or null. */
function nameplateBottom(token) {
  const np = token?.nameplate;
  const NONE = CONST.TOKEN_DISPLAY_MODES?.NONE ?? 0;
  if (!np?.parent || token.document?.displayName === NONE || !np.text) return null;
  try {
    const local = np.getLocalBounds();
    const global = np.toGlobal(new PIXI.Point(0, local.y + local.height));
    return canvas.stage.toLocal(global).y;
  } catch (_) {
    return null;
  }
}

/** The token distances are measured from: the one you control, else your character's. */
function distanceOrigin(hovered) {
  const controlled = canvas.tokens?.controlled ?? [];
  const origin = controlled.length === 1 ? controlled[0] : controlled.length ? null : game.user.character?.getActiveTokens?.()[0];
  if (!origin || origin === hovered || origin.isPreview || origin.animation) return null;
  return origin;
}

export function distanceText(distance, units) {
  if (!Number.isFinite(distance)) return "";
  const n = Math.round(distance * 10) / 10;
  return `${Number.isInteger(n) ? n : n.toFixed(1)} ${units ?? ""}`.trim();
}

function tokenDistance(hovered) {
  const mode = setting("tokenTipDistance", "always");
  if (mode === "never" || (mode === "encounters" && !game.combat?.started)) return "";
  const origin = distanceOrigin(hovered);
  if (!origin) return "";
  let d = null;
  try {
    d = typeof origin.distanceTo === "function" ? origin.distanceTo(hovered)
      : canvas.grid.measurePath([origin.center, hovered.center]).distance;
  } catch (_) {
    return "";
  }
  return distanceText(Number(d), canvas.scene?.grid?.units ?? canvas.grid?.units ?? "");
}

function healthLine(token) {
  const actor = token?.actor;
  if (!actor || !setting("healthOnHover", true)) return null;
  const visibleHp = actor.testUserPermission(game.user, "OBSERVER");
  if (visibleHp && !(game.user.isGM && setting("healthShowGM", false))) return null;
  const est = healthEstimate(actor);
  // "건강함" is the usual state: by default only worth showing in a fight.
  if (est && !est.rank) {
    const mode = setting("healthFullShow", "combat");
    if (mode === "never" || (mode === "combat" && !game.combat?.started)) return null;
  }
  return est;
}

let hoverEl = null;
let hoverToken = null;
function showHealth(token, hovered) {
  hoverEl ??= Object.assign(document.body.appendChild(document.createElement("div")), { id: "pkh-health" });
  if (!hovered || !token) {
    if (!token || token === hoverToken) { hoverToken = null; hoverEl.classList.add("hidden"); }
    return;
  }
  hoverToken = token;
  // Secret tokens give nothing away.
  const SECRET = CONST.TOKEN_DISPOSITIONS?.SECRET ?? -2;
  if (token.document?.disposition === SECRET && !token.isOwner) { hoverEl.classList.add("hidden"); return; }

  const est = healthLine(token);
  const dist = tokenDistance(token);
  if (!est && !dist) { hoverEl.classList.add("hidden"); return; }

  const parts = [];
  if (dist) parts.push(`<div class="dist">${esc(dist)}</div>`);
  if (est) {
    const c = healthColour(est);
    parts.push(`<span class="health" style="--h:${c.hue};--s:${c.sat}%;--l:${c.light}%">${esc(est.label)}</span>`);
  }
  hoverEl.innerHTML = parts.join("");
  hoverEl.classList.toggle("only-dist", !est);
  hoverEl.classList.remove("hidden");
  placeTokenTip(token);
}

function placeTokenTip(token) {
  if (!hoverEl || !token || hoverEl.classList.contains("hidden")) return;
  const b = token.bounds ?? { x: token.x, y: token.y, width: token.w, height: token.h };
  const size = canvas.dimensions?.size ?? 100;
  const gap = Math.max(3, size * 0.04);
  const toScreen = point => canvas.clientCoordinatesFromCanvas?.(point) ?? canvas.stage.worldTransform.apply(point);

  const above = toScreen({ x: b.x + b.width / 2, y: Math.min(b.y, decorationTop(token)) - gap });
  const height = hoverEl.getBoundingClientRect?.().height || 44;
  const flip = above.y - height < 8;
  let point = above;
  if (flip) {
    const below = Math.max(b.y + b.height, nameplateBottom(token) ?? (b.y + b.height + size * 0.2));
    point = toScreen({ x: b.x + b.width / 2, y: below + gap });
  }
  hoverEl.classList.toggle("below", flip);
  hoverEl.style.left = `${Math.round(point.x)}px`;
  hoverEl.style.top = `${Math.round(point.y)}px`;
}

/** With our distance on, PF2e's own hover-distance label would sit in the same place. */
function applyDistanceOwnership() {
  document.body.classList.toggle("pkh-own-distance", setting("tokenTipDistance", "always") !== "never");
}

/* ======================================================================== */

export function registerGmToolSettings() {
  const redock = () => { document.getElementById("pkh-clock")?.remove(); mountClock(); mountDice(); };
  const s = (key, data) => game.settings.register(MODULE_ID, key, data);
  s("chatDock", { name: "채팅창 시계와 주사위", hint: "채팅창 맨 위에 날짜·시간, 입력칸 위에 주사위와 플랫 체크(5·11) 버튼을 띄웁니다.", scope: "client", config: true, type: Boolean, default: true, onChange: redock });
  s("clock12h", { name: "채팅창 시계: 오전/오후 12시간제", hint: "끄면 24시간제(15:05)로 표시합니다.", scope: "client", config: true, type: Boolean, default: true, onChange: () => mountClock() });
  s("timeDarknessSync", { name: "시간에 맞춰 장면 조명 조절", hint: "게임 시간이 바뀌면 현재 장면의 어둠을 낮·새벽·황혼·밤에 맞춥니다 (장면별로 끌 수 있음). PF2e 월드 시계의 동기화가 켜져 있으면 그쪽이 우선합니다.", scope: "world", config: true, type: Boolean, default: true });
  s("timeDarknessMax", { name: "한밤중 어둠 정도", scope: "world", config: true, type: Number, default: 0.85, range: { min: 0.3, max: 1, step: 0.05 } });
  s("paletteSize", { name: "GM 팔레트 크기", scope: "client", config: true, type: String, default: "3x2", choices: Object.fromEntries(Object.keys(SIZES).map(k => [k, `${k.replace("x", " × ")}칸`])), onChange: () => game.pkhPalette?.render() });
  s("paletteOpacity", { name: "GM 팔레트 투명도", hint: "마우스를 올리면 불투명해집니다.", scope: "client", config: true, type: Number, default: 0.75, range: { min: 0.2, max: 1, step: 0.05 }, onChange: () => game.pkhPalette?.render() });
  s("healthOnHover", { name: "토큰에 마우스를 올리면 체력 상태 표시", hint: "HP를 볼 권한이 없는 토큰(보통 NPC)에 '가벼운 부상' 같은 대략적인 상태만 보여줍니다.", scope: "world", config: true, type: Boolean, default: true });
  s("healthShowGM", { name: "GM에게도 체력 상태 표시", scope: "client", config: true, type: Boolean, default: false });
  s("tokenTipDistance", { name: "토큰에 마우스를 올리면 거리 표시", hint: "선택한 내 토큰(없으면 내 캐릭터)에서 그 토큰까지의 거리를 체력 상태 위에 쌓아 보여줍니다. 켜 두면 PF2e 기본 거리 표시는 겹치지 않도록 숨깁니다. '표시 안 함'이면 PF2e 기본 표시를 그대로 씁니다.", scope: "client", config: true, type: String, default: "always", choices: { always: "항상", encounters: "전투 중에만", never: "표시 안 함 (PF2e 기본 표시 사용)" }, onChange: () => applyDistanceOwnership() });
  s("healthFull", { name: "체력 상태: 최대일 때", scope: "world", config: true, type: String, default: "건강함" });
  s("healthFullShow", { name: "'건강함' 표시", hint: "HP가 가득 찬 상태는 가장 흔해서 평소에는 숨기고 전투 중에만 보여주는 것이 기본입니다.", scope: "world", config: true, type: String, default: "combat", choices: { combat: "전투 중에만", always: "항상", never: "표시 안 함" } });
  s("healthLevels", { name: "체력 상태 단계", hint: "\"퍼센트:이름\"을 |로 구분. 그 퍼센트 이상이면 그 이름. 예) 75:가벼운 부상|50:부상|25:심한 부상|1:죽음의 문턱", scope: "world", config: true, type: String, default: "75:가벼운 부상|50:부상|25:심한 부상|1:죽음의 문턱" });
  s("healthZero", { name: "체력 상태: 0일 때", scope: "world", config: true, type: String, default: "쓰러짐" });
}

/** The label used to be "멀쩡함"; worlds that kept the old default get the new one. */
async function migrateHealthLabel() {
  if (!game.user.isGM) return;
  try {
    if (game.settings.get(MODULE_ID, "healthFull") === "멀쩡함") await game.settings.set(MODULE_ID, "healthFull", "건강함");
  } catch (_) { /* setting not ready */ }
}

export function initGmTools() {
  migrateHealthLabel();
  document.body.classList.toggle("pkh-gm", game.user.isGM);
  const palette = new GmPalette();
  game.pkhPalette = palette;
  palette.render();
  mountClock();
  mountDice();
  Hooks.on("renderChatLog", () => { mountClock(); mountDice(); });
  Hooks.on("changeSidebarTab", () => setTimeout(() => { mountClock(); placeDice(); }, 50));
  Hooks.on("collapseSidebar", () => setTimeout(placeDice, 300));
  window.addEventListener("resize", () => placeDice());
  setInterval(placeDice, 1500); // chat input grows/shrinks with its toolbar
  Hooks.on("updateWorldTime", () => { refreshClocks(); syncDarkness(); });
  Hooks.on("canvasReady", () => syncDarkness());
  applyDistanceOwnership();
  Hooks.on("hoverToken", (token, hovered) => showHealth(token, hovered));
  Hooks.on("canvasPan", () => requestAnimationFrame(() => placeTokenTip(hoverToken)));
  Hooks.on("updateActor", actor => { if (hoverToken?.actor === actor) showHealth(hoverToken, true); });
  Hooks.on("controlToken", () => { if (hoverToken) showHealth(hoverToken, true); });
  Hooks.on("refreshToken", token => { if (token === hoverToken) placeTokenTip(token); });
  Hooks.on("canvasTearDown", () => { hoverToken = null; hoverEl?.classList.add("hidden"); });
  document.addEventListener("pointerdown", () => { if (hoverToken) hoverEl?.classList.add("hidden"); }, { capture: true, passive: true });
  game.pf2eKrHud = { ...(game.pf2eKrHud ?? {}), openRollRequest, palette };
}
