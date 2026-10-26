import { MODULE_ID, SimpleWindow, esc, localizeMaybe, readDragData, setting, t } from "./shared.mjs";
import { actorLores, loreCheckLink, loreSlug, partyLores } from "./lore.mjs";

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
  const hour = h + m / 60;
  if (hour >= 7 && hour < 18) return { name: t("Clock.Phase.Day"), icon: "fa-sun" };
  if (hour >= 5 && hour < 7) return { name: t("Clock.Phase.Dawn"), icon: "fa-cloud-sun" };
  if (hour >= 18 && hour < 20) return { name: t("Clock.Phase.Dusk"), icon: "fa-cloud-moon" };
  return { name: t("Clock.Phase.Night"), icon: "fa-moon" };
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

// Lang keys (Calendar.Golarion.* / Calendar.Earth.* / Calendar.Era.*), read when the date is drawn.
const GOLARION_WEEKDAYS = ["Moonday", "Toilday", "Wealday", "Oathday", "Fireday", "Starday", "Sunday"].map(n => `Calendar.Golarion.${n}`);
const GOLARION_MONTHS = ["Abadius", "Calistril", "Pharast", "Gozran", "Desnus", "Sarenith",
  "Erastus", "Arodus", "Rova", "Lamashan", "Neth", "Kuthona"].map(n => `Calendar.Golarion.${n}`);
const EARTH_WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"].map(n => `Calendar.Earth.${n}`);

const ERAS = {
  AR: { label: "Calendar.Era.AR", offset: 2700, golarion: true },
  IC: { label: "Calendar.Era.IC", offset: 5200, golarion: true },
  AD: { label: "Calendar.Era.AD", offset: 0, golarion: false },
  CE: { label: "Calendar.Era.CE", offset: 0, golarion: false }
};

/** Earth month name in the user's language ("5월", "May"). */
function earthMonth(n) {
  try {
    return new Intl.DateTimeFormat(game.i18n.lang, { month: "long", timeZone: "UTC" }).format(new Date(Date.UTC(2000, n - 1, 1)));
  } catch (_) {
    return String(n);
  }
}

function monthName(era, month) {
  return era.golarion ? t(GOLARION_MONTHS[month - 1]) : t("Calendar.EarthMonth", { month, name: earthMonth(month) });
}

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
  return t("Calendar.Full", { year, day });
}

/** The same date in two lines: "골라리온력 4726년" / "3월 15일 문데이". */
export function formatGameDateParts(m, theme = dateTheme(), systemYear = null) {
  const era = ERAS[theme] ?? ERAS.AR;
  const year = Number.isFinite(systemYear) ? systemYear : m.year + era.offset;
  const weekday = t((era.golarion ? GOLARION_WEEKDAYS : EARTH_WEEKDAYS)[(m.weekday - 1 + 7) % 7]);
  return {
    year: t("Calendar.Year", { era: t(era.label), year }),
    day: t("Calendar.Day", { month: m.month, day: m.day, weekday, monthName: era.golarion ? t(GOLARION_MONTHS[m.month - 1]) : earthMonth(m.month) })
  };
}

/** "오후 3:05" — or "15:05" when the 24-hour clock is chosen. */
export function formatGameTime(h, min, twelveHour = true) {
  const mm = String(min).padStart(2, "0");
  if (!twelveHour) return `${String(h).padStart(2, "0")}:${mm}`;
  return t("Calendar.Time12", { ampm: t(h < 12 ? "Calendar.Am" : "Calendar.Pm"), h: h % 12 || 12, mm });
}

function calendarText() {
  const m = gameMoment();
  const theme = dateTheme();
  const wcYear = Number(game.pf2e?.worldClock?.year);
  const era = ERAS[theme];
  const parts = formatGameDateParts(m, theme, Number.isFinite(wcYear) ? wcYear : null);
  return {
    date: t("Calendar.Full", { year: parts.year, day: parts.day }),
    year: parts.year,
    day: parts.day,
    month: monthName(era, m.month),
    time: formatGameTime(m.hour, m.minute, setting("clock12h", true) !== false),
    emoji: phaseEmoji(m.hour, m.minute),
    phase: phaseOf(m.hour, m.minute).name
  };
}

// [seconds, unit key under Time.*, amount]
const TIME_STEPS = [
  [-86400, "D", 1], [-3600, "H", 1], [-600, "M", 10],
  [600, "M", 10], [3600, "H", 1], [86400, "D", 1]
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
    ? `<div class="steps">${TIME_STEPS.map(([s, unit, n]) => {
        const amount = t(`Time.${unit}`, { n });
        return `<button type="button" data-adv="${s}" class="${s < 0 ? "back" : "fwd"}" data-tooltip="${t(s < 0 ? "Clock.Back" : "Clock.Forward", { amount })}">${s < 0 ? "−" : "+"}${amount}</button>`;
      }).join("")}</div>`
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
  if (main) main.dataset.tooltip = `${esc(c.month)} · ${esc(c.phase)}${game.user.isGM ? `<br><small>${t("Clock.GmHint")}</small>` : ""}`;
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
      ${DICE.map(d => `<button type="button" data-die="${d.n}" data-tooltip="1d${d.n}<br><small>${t("Dice.ShiftTwo")}</small>">
        <i class="fa-solid ${d.icon}"></i>${d.label ? `<b>${d.label}</b>` : ""}</button>`).join("")}
      <span class="sep"></span>
      ${[5, 11].map(dc => `<button type="button" class="flat" data-flat="${dc}" data-tooltip="${t("Dice.Flat", { dc })}<br><small>${t(dc === 5 ? "Dice.Flat5" : "Dice.Flat11")}</small>" aria-label="${t("Dice.Flat", { dc })}">
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
    // Rutz's Cinematic Stage puts its speaker row above the chat controls: sit above that.
    const speakers = document.querySelector("#rcs-speakers.inflow:not(.hidden)");
    const tops = [box.top, controls?.getBoundingClientRect?.().top, speakers?.getBoundingClientRect?.().top].filter(t => Number.isFinite(t) && t > 0);
    const top = Math.min(...tops);
    bar.style.left = `${Math.round(box.left)}px`;
    bar.style.width = `${Math.round(box.width)}px`;
    bar.style.top = `${Math.round(top - bar.offsetHeight - 4)}px`;
    // Room for the bar and for the "입력 중" line riding on top of it.
    const typing = document.body.classList.contains("pkh-typing-in-dock") ? 24 : 0;
    root.style.setProperty("--pkh-dice-h", `${bar.offsetHeight + 6 + typing}px`);
    // Reserve the bar's room below the scrolling box (not as padding inside it),
    // so scrolled-up cards never slide under the bar or the "입력 중" line.
    const scroller = chatScroller(root);
    for (const el of document.querySelectorAll(".pkh-dice-reserve")) if (el !== scroller) el.classList.remove("pkh-dice-reserve");
    scroller?.classList.add("pkh-dice-reserve");
    root.classList.add("pkh-has-dice");
  }

  if (!clock) return;
  // Reserve the space on the element that scrolls (the log or its scroll box),
  // never on the scrolling content: that box stays put however far you scroll.
  const scroller = chatScroller(root);
  const box2 = scroller?.getBoundingClientRect?.();
  const clockVisible = visible && !!box2 && box2.width > 0;
  clock.classList.toggle("hidden", !clockVisible);
  for (const el of document.querySelectorAll(".pkh-clock-reserve")) if (el !== scroller || !clockVisible) el.classList.remove("pkh-clock-reserve");
  if (!clockVisible) return;
  const applied = scroller.classList.contains("pkh-clock-reserve") ? (parseFloat(getComputedStyle(scroller).marginTop) || 0) : 0;
  const top = box2.top - applied;
  scroller.classList.add("pkh-clock-reserve");
  clock.style.left = `${Math.round(box.left)}px`;
  clock.style.width = `${Math.round(box.width)}px`;
  clock.style.top = `${Math.round(top + 2)}px`;
  root.style.setProperty("--pkh-clock-h", `${clock.offsetHeight + 6}px`);
}

/** The chat log, or the nearest box around it that actually scrolls. */
function chatScroller(root) {
  const log = root?.querySelector?.("#chat-log, ol.chat-log, .chat-log");
  for (let el = log; el && el !== root; el = el.parentElement) {
    const oy = getComputedStyle(el).overflowY;
    if (oy === "auto" || oy === "scroll") return el;
  }
  return log ?? null;
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
      flavor: `${t("Dice.Flat", { dc })} — <b style="color:${ok ? "#3f7f2f" : "#a83a2f"}">${t(ok ? "Dice.Success" : "Dice.Failure")}</b>`
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
    <div class="row">${[["6:00", "Clock.Morning"], ["12:00", "Clock.Noon"], ["18:00", "Clock.Evening"], ["0:00", "Clock.Midnight"]]
      .map(([time, key]) => `<button type="button" data-set="${time}">${t(key)}</button>`).join("")}
      <input type="time" value="${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}"><button type="button" data-act="go">${t("Clock.Go")}</button></div>
    <label class="row"><input type="checkbox" ${noSync ? "" : "checked"} data-act="sync"> ${t("Clock.SyncScene")}</label>
    ${pf2eSyncsDarkness() ? `<p class="hint">${t("Clock.Pf2eSyncs")}</p>` : ""}`;
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
// Difficulty labels are lang keys (Request.Adjust.*); save labels are read when drawn.
const ADJUST = { "-10": "IncrediblyEasy", "-5": "VeryEasy", "-2": "Easy", "0": "Normal", "2": "Hard", "5": "VeryHard", "10": "IncrediblyHard" };

/** The party's level (rounded average of the party's characters; else the players' characters), or null. */
function partyLevel() {
  const party = (game.actors?.party?.members ?? []).filter(a => a?.type === "character");
  const pool = party.length ? party : (game.actors?.filter?.(a => a.type === "character" && a.hasPlayerOwner) ?? []);
  const levels = pool.map(a => Number(a.level ?? a.system?.details?.level?.value) || 0).filter(n => n > 0);
  if (!levels.length) return null;
  return Math.max(0, Math.min(LEVEL_DC.length - 1, Math.round(levels.reduce((a, b) => a + b, 0) / levels.length)));
}
const SAVES = {
  get fortitude() { return t("Saves.fortitude"); },
  get reflex() { return t("Saves.reflex"); },
  get will() { return t("Saves.will"); }
};

function checkOptions() {
  const skills = Object.entries(CONFIG.PF2E?.skills ?? {})
    .map(([slug, v]) => ({ slug, label: localizeMaybe(v?.label ?? v) || slug }))
    .sort((a, b) => a.label.localeCompare(b.label, "ko"));
  return [{ slug: "perception", label: t("Hud.Perception") }, ...Object.entries(SAVES).map(([slug, label]) => ({ slug, label, save: true })), ...skills];
}

export function requestContent({ checks, dc, secret, note }) {
  const parts = checks.map(c => {
    if (c.lore) return loreCheckLink(c.slug, c.label, { dc: c.dc ?? dc, secret });
    const params = [c.slug];
    const d = c.dc ?? dc;
    if (d) params.push(`dc:${d}`);
    if (c.basic && SAVES[c.slug]) params.push("basic");
    if (secret) params.push("traits:secret");
    return `@Check[${params.join("|")}]`;
  });
  const dcs = [...new Set(checks.map(c => c.dc ?? dc).filter(Boolean))];
  return `<div class="pkh-save-request"><header><i class="fa-solid fa-dice-d20"></i> <strong>${t("Request.Title")}</strong>${dcs.length === 1 ? ` — DC <b>${dcs[0]}</b>` : ""}${secret ? ` <em>(${t("Request.SecretTag")})</em>` : ""}</header>
    ${note ? `<p>${esc(note)}</p>` : ""}<div class="checks">${parts.join(" ")}</div></div>`;
}

/**
 * A small window: pick checks from a drop-down (saves and skills on their
 * own tabs); every pick becomes a row with its own DC (empty = the default DC
 * below) and, for saves, "basic". Sending keeps the window open, so several
 * requests can go out one after another.
 */
export function openRollRequest({ actor = null } = {}) {
  if (!game.user.isGM) return;
  const opts = checkOptions();
  // Lore: the selected character's own lores first, then the rest of the party's.
  const focusActor = () => canvas?.tokens?.controlled?.[0]?.actor ?? actor ?? null;
  const loreList = () => {
    const who = focusActor();
    const own = who ? actorLores(who).map(l => ({ slug: l.slug, label: l.label, lore: true, own: true, mod: l.mod, actors: [who.name] })) : [];
    const mine = new Set(own.map(l => l.slug));
    return [...own, ...partyLores().filter(l => !mine.has(l.slug))];
  };
  let lores = loreList();
  const picked = [];
  let tab = "save";
  // The level-based DC for the party's level is filled in from the start; changing the level or the
  // difficulty puts the new DC in (the field stays editable, and can be emptied for "no DC").
  const pl = partyLevel();
  const startLv = pl ?? 1;
  const loreOptions = () => {
    const own = lores.filter(o => o.own);
    const rest = lores.filter(o => !o.own);
    const signed = n => (Number.isFinite(n) ? ` (${n >= 0 ? "+" : ""}${n})` : "");
    const ownHtml = own.map(o => `<option value="${esc(o.slug)}">${esc(o.label)}${signed(o.mod)}</option>`).join("");
    const restHtml = rest.map(o => `<option value="${esc(o.slug)}">${esc(o.label)} (${esc(o.actors.join(", "))})</option>`).join("");
    if (!own.length) return restHtml;
    return `<optgroup label="${esc(t("Request.OwnLores", { name: own[0].actors[0] }))}">${ownHtml}</optgroup>`
      + (rest.length ? `<optgroup label="${esc(t("Request.PartyLores"))}">${restHtml}</optgroup>` : "");
  };
  const optionList = () => tab === "lore"
    ? `<option value="">${t("Request.PickLore")}</option>` + loreOptions()
    : opts.filter(o => (tab === "save" ? o.save : !o.save))
      .map(o => `<option value="${esc(o.slug)}">${esc(o.label)}</option>`).join("");
  const rowsHtml = () => picked.length ? picked.map((c, i) => `<div class="pkh-req-pick" data-i="${i}">
      <b>${esc(c.label)}</b>
      <input type="number" data-f="dc" min="0" max="60" value="${c.dc ?? ""}" placeholder="${t("Request.DefaultDc")}" title="${t("Request.RowDcTip")}">
      ${c.save ? `<label title="${t("Request.BasicSave")}"><input type="checkbox" data-f="basic" ${c.basic ? "checked" : ""}> ${t("Request.Basic")}</label>` : "<span></span>"}
      <button type="button" data-act="del" data-i="${i}" aria-label="${t("Request.Remove")}"><i class="fa-solid fa-xmark"></i></button></div>`).join("")
    : `<p class="hint">${t("Request.PickHint")}</p>`;
  const html = `<div class="pkh-request small">
    <div class="pkh-req-tabs"><button type="button" data-tab="save" class="on">${t("Request.Tab.Saves")}</button><button type="button" data-tab="skill">${t("Request.Tab.Skills")}</button><button type="button" data-tab="lore">${t("Request.Tab.Lore")}</button></div>
    <div class="pkh-req-row"><select name="pick" aria-label="${t("Request.PickAria")}">${optionList()}</select><button type="button" data-act="add" class="primary"><i class="fa-solid fa-plus"></i> ${t("Request.Add")}</button></div>
    <div class="pkh-req-lore" hidden><label>${t("Request.LoreName")}<input type="text" name="loreName" maxlength="120" placeholder="${t("Request.LorePlaceholder")}"></label><p class="hint">${t("Request.LoreHint")}</p></div>
    <div class="pkh-req-picks">${rowsHtml()}</div>
    <div class="pkh-req-row">${t("Request.DefaultDc")} <input type="number" name="dc" min="0" max="60" style="width:62px" placeholder="${t("Request.None")}" value="${LEVEL_DC[startLv]}">
      <select name="lv" title="${t("Request.Level")}">${LEVEL_DC.map((d, i) => `<option value="${i}" ${i === startLv ? "selected" : ""}>Lv ${i}${i === pl ? ` (${t("Request.PartyLevel")})` : ""}</option>`).join("")}</select>
      <select name="adj">${Object.entries(ADJUST).map(([v, l]) => `<option value="${v}" ${v === "0" ? "selected" : ""}>${t(`Request.Adjust.${l}`)}</option>`).join("")}</select>
      <button type="button" data-act="lvdc" title="${t("Request.LevelDc")}"><i class="fa-solid fa-arrow-left"></i></button></div>
    <div class="pkh-req-row"><label><input type="checkbox" name="secret"> ${t("Request.SecretLabel")}</label>
      <input type="text" name="note" placeholder="${t("Request.Note")}" style="flex:1"></div>
    <div class="pkh-req-row"><input type="text" name="mname" placeholder="${t("Request.MacroName")}" style="flex:1">
      <button type="button" data-act="macro" title="${t("Request.SaveMacro")}"><i class="fa-solid fa-scroll"></i></button>
      <button type="button" data-act="send" class="primary"><i class="fa-solid fa-paper-plane"></i> ${t("Request.Send")}</button></div>
  </div>`;
  new SimpleWindow({
    id: `${MODULE_ID}-roll-request`, title: t("Request.Title"), width: 460, html,
    onRender: (root) => {
      const redraw = () => { root.querySelector(".pkh-req-picks").innerHTML = rowsHtml(); };
      const read = () => ({
        checks: picked.map(c => ({ ...c })),
        dc: Number(root.querySelector("[name=dc]").value) || null,
        secret: root.querySelector("[name=secret]").checked,
        note: root.querySelector("[name=note]").value.trim()
      });
      root.addEventListener("input", ev => {
        if (ev.target.name === "loreName") root.querySelector("[name=pick]").value = "";
        const row = ev.target.closest(".pkh-req-pick");
        if (!row) return;
        const c = picked[Number(row.dataset.i)];
        if (ev.target.dataset.f === "dc") c.dc = Number(ev.target.value) || null;
        if (ev.target.dataset.f === "basic") c.basic = ev.target.checked;
      });
      const levelDc = () => {
        const lv = Number(root.querySelector("[name=lv]").value);
        root.querySelector("[name=dc]").value = LEVEL_DC[lv] + Number(root.querySelector("[name=adj]").value);
      };
      root.addEventListener("change", ev => {
        if (ev.target.name === "lv" || ev.target.name === "adj") { levelDc(); return; }
        if (tab === "lore" && ev.target.name === "pick") {
          const lore = lores.find(l => l.slug === ev.target.value);
          if (lore) root.querySelector("[name=loreName]").value = lore.label;
        }
      });
      root.addEventListener("click", async ev => {
        const tabBtn = ev.target.closest("[data-tab]");
        if (tabBtn) {
          tab = tabBtn.dataset.tab;
          if (tab === "lore") lores = loreList();
          root.querySelectorAll("[data-tab]").forEach(b => b.classList.toggle("on", b === tabBtn));
          root.querySelector("[name=pick]").innerHTML = optionList();
          root.querySelector(".pkh-req-lore").hidden = tab !== "lore";
          return;
        }
        const btn = ev.target.closest("button[data-act]");
        const act = btn?.dataset.act;
        if (act === "add") {
          const value = root.querySelector("[name=pick]").value;
          let o = (tab === "lore" ? lores : opts).find(x => x.slug === value);
          if (tab === "lore" && !o) {
            const label = root.querySelector("[name=loreName]").value.trim();
            const slug = loreSlug(label);
            if (!label || !slug) return ui.notifications.warn(`PF2e-KR HUD | ${t("Request.NeedLore")}`);
            o = lores.find(l => l.label === label || l.slug === slug) ?? { slug, label, lore: true };
          }
          if (o && !picked.some(c => c.slug === o.slug)) { picked.push({ ...o, dc: null, basic: false }); redraw(); }
          return;
        }
        if (act === "del") { picked.splice(Number(btn.dataset.i), 1); redraw(); return; }
        if (act === "lvdc") { levelDc(); return; }
        if (act !== "send" && act !== "macro") return;
        const data = read();
        if (!data.checks.length) return ui.notifications.warn(`PF2e-KR HUD | ${t("Request.NeedCheck")}`);
        const content = requestContent(data);
        if (act === "send") {
          await ChatMessage.create({ speaker: ChatMessage.getSpeaker({ alias: "GM" }), content });
          ui.notifications.info(`PF2e-KR HUD | ${t("Request.Sent")}`);
          return;
        }
        const name = root.querySelector("[name=mname]").value.trim()
          || `${data.checks.map(c => c.label).join("·")}${data.dc ? ` DC ${data.dc}` : ""}`;
        const macro = await Macro.create({
          name, type: "script", img: "icons/svg/d20-highlight.svg",
          command: `ChatMessage.create({ speaker: ChatMessage.getSpeaker({ alias: "GM" }), content: ${JSON.stringify(content)} });`
        });
        const placed = await game.pkhPalette?.addEntry({ type: "macro", uuid: macro.uuid });
        ui.notifications.info(`PF2e-KR HUD | ${t(placed ? "Request.MacroMadePlaced" : "Request.MacroMade", { name })}`);
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
      return `<div class="cell t-${e.type}" data-i="${i}" data-tooltip="${esc(name)}<br><small>${t(e.type === "condition" ? "Palette.CondHelp" : e.type === "effect" ? "Palette.EffectHelp" : "Palette.MacroHelp")} · ${t("Palette.OnSelected")}</small>">
        <img src="${esc(img)}" alt=""></div>`;
    }).join("");
    this.el.classList.toggle("unlocked", !d.locked);
    this.el.style.setProperty("--cols", cols);
    this.el.style.setProperty("--pal-opacity", String(setting("paletteOpacity", 0.75)));
    this.el.innerHTML = `
      <header data-drag>
        <span>${t("Palette.Title")}</span>
        <button type="button" data-act="lock" data-tooltip="${t(d.locked ? "Palette.Locked" : "Palette.Editing")}"><i class="fa-solid ${d.locked ? "fa-lock" : "fa-lock-open"}"></i></button>
        <button type="button" data-act="close" data-tooltip="${t("Common.Close")}"><i class="fa-solid fa-xmark"></i></button>
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
    if (!targets.length) return ui.notifications.warn(`PF2e-KR HUD | ${t("Notify.SelectToken")}`);
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
    if (!entry) return ui.notifications.warn(`PF2e-KR HUD | ${t("Palette.OnlyTypes")}`);
    const [c, r] = SIZES[setting("paletteSize", "3x2")] ?? [3, 2];
    const slots = Array.from({ length: c * r }, (_, i) => d.slots[i] ?? null);
    const at = cell ? Number(cell.dataset.i) : slots.findIndex(s => !s);
    if (at < 0) return ui.notifications.warn(`PF2e-KR HUD | ${t("Palette.Full")}`);
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

/*
 * Default health labels. These Korean strings are the settings' stored default
 * VALUES (data, kept as they were); while a world still has them, the labels
 * are shown in the user's language instead. Edited labels are shown as typed.
 */
const HEALTH_FULL_DEFAULT = "건강함";
const HEALTH_ZERO_DEFAULT = "쓰러짐";
const HEALTH_LEVELS_DEFAULT = "75:가벼운 부상|50:부상|25:심한 부상|1:죽음의 문턱";

function healthText(key, storedDefault, langKey) {
  const value = String(setting(key, "") || "");
  return !value || value === storedDefault ? t(langKey) : value;
}

function healthLevels() {
  const text = healthText("healthLevels", HEALTH_LEVELS_DEFAULT, "Health.DefaultLevels");
  return text.split("|").map(p => p.split(":")).map(([pct, label]) => ({ pct: Number(pct), label: (label ?? "").trim() }))
    .filter(l => Number.isFinite(l.pct) && l.label).sort((a, b) => b.pct - a.pct);
}

export function healthEstimate(actor) {
  const hp = actor?.system?.attributes?.hp;
  if (!hp || !Number(hp.max)) return null;
  const pct = Math.max(0, Number(hp.value)) / Number(hp.max) * 100;
  const levels = healthLevels();
  if (pct <= 0) return { label: healthText("healthZero", HEALTH_ZERO_DEFAULT, "Health.Zero"), pct, depth: 1, top: 0, floor: 0, rank: levels.length + 1 };
  if (pct >= 100) return { label: healthText("healthFull", HEALTH_FULL_DEFAULT, "Health.Full"), pct, depth: 0, top: 100, floor: 100, rank: 0 };
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
  s("chatDock", { name: "PKH.Settings.chatDock.Name", hint: "PKH.Settings.chatDock.Hint", scope: "client", config: true, type: Boolean, default: true, onChange: redock });
  s("clock12h", { name: "PKH.Settings.clock12h.Name", hint: "PKH.Settings.clock12h.Hint", scope: "client", config: true, type: Boolean, default: true, onChange: () => mountClock() });
  s("timeDarknessSync", { name: "PKH.Settings.timeDarknessSync.Name", hint: "PKH.Settings.timeDarknessSync.Hint", scope: "world", config: true, type: Boolean, default: true });
  s("timeDarknessMax", { name: "PKH.Settings.timeDarknessMax.Name", scope: "world", config: true, type: Number, default: 0.85, range: { min: 0.3, max: 1, step: 0.05 } });
  s("paletteSize", { name: "PKH.Settings.paletteSize.Name", scope: "client", config: true, type: String, default: "3x2", choices: Object.fromEntries(Object.keys(SIZES).map(k => [k, `PKH.Settings.paletteSize.Choices.S${k}`])), onChange: () => game.pkhPalette?.render() });
  s("paletteOpacity", { name: "PKH.Settings.paletteOpacity.Name", hint: "PKH.Settings.paletteOpacity.Hint", scope: "client", config: true, type: Number, default: 0.75, range: { min: 0.2, max: 1, step: 0.05 }, onChange: () => game.pkhPalette?.render() });
  s("healthOnHover", { name: "PKH.Settings.healthOnHover.Name", hint: "PKH.Settings.healthOnHover.Hint", scope: "world", config: true, type: Boolean, default: true });
  s("healthShowGM", { name: "PKH.Settings.healthShowGM.Name", scope: "client", config: true, type: Boolean, default: false });
  s("tokenTipDistance", { name: "PKH.Settings.tokenTipDistance.Name", hint: "PKH.Settings.tokenTipDistance.Hint", scope: "client", config: true, type: String, default: "always", choices: { always: "PKH.Settings.tokenTipDistance.Choices.always", encounters: "PKH.Settings.tokenTipDistance.Choices.encounters", never: "PKH.Settings.tokenTipDistance.Choices.never" }, onChange: () => applyDistanceOwnership() });
  s("healthFull", { name: "PKH.Settings.healthFull.Name", scope: "world", config: true, type: String, default: HEALTH_FULL_DEFAULT });
  s("healthFullShow", { name: "PKH.Settings.healthFullShow.Name", hint: "PKH.Settings.healthFullShow.Hint", scope: "world", config: true, type: String, default: "combat", choices: { combat: "PKH.Settings.healthFullShow.Choices.combat", always: "PKH.Settings.healthFullShow.Choices.always", never: "PKH.Settings.healthFullShow.Choices.never" } });
  s("healthLevels", { name: "PKH.Settings.healthLevels.Name", hint: "PKH.Settings.healthLevels.Hint", scope: "world", config: true, type: String, default: HEALTH_LEVELS_DEFAULT });
  s("healthZero", { name: "PKH.Settings.healthZero.Name", scope: "world", config: true, type: String, default: HEALTH_ZERO_DEFAULT });
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
  // Only after the mouse rests on a token for a moment (passing over shows nothing).
  let tipTimer = 0;
  Hooks.on("hoverToken", (token, hovered) => {
    clearTimeout(tipTimer);
    if (!hovered) return showHealth(token, false);
    tipTimer = setTimeout(() => { if (token.hover !== false) showHealth(token, true); }, 500);
  });
  Hooks.on("canvasPan", () => requestAnimationFrame(() => placeTokenTip(hoverToken)));
  Hooks.on("updateActor", actor => { if (hoverToken?.actor === actor) showHealth(hoverToken, true); });
  Hooks.on("controlToken", () => { if (hoverToken) showHealth(hoverToken, true); });
  Hooks.on("refreshToken", token => { if (token === hoverToken) placeTokenTip(token); });
  Hooks.on("canvasTearDown", () => { hoverToken = null; hoverEl?.classList.add("hidden"); });
  document.addEventListener("pointerdown", () => { if (hoverToken) hoverEl?.classList.add("hidden"); }, { capture: true, passive: true });
  game.pf2eKrHud = { ...(game.pf2eKrHud ?? {}), openRollRequest, palette };
}
