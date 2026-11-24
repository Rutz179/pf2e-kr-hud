import { MODULE_ID, SimpleWindow, displayName, esc, localizeMaybe, t } from "./shared.mjs";
import { LEVEL_DC } from "./gm-tools.mjs";
import { partyPcs } from "./xp.mjs";

/*
 * 파티 굴림 (group challenge)
 * - The GM picks the skills, a DC and the participants; one public card with a roll button per skill goes to chat.
 * - Each participant rolls once with their own character. Points: critical success +2, success +1, failure 0, critical failure -1.
 * - When the total reaches the target (default: half the participants, rounded up) the challenge is overcome and the buttons go: 완전 성공 if every roll was a success or better, else 일반 성공. If everyone rolled (or the GM pressed 끝내기) short of the target: 실패 (total >= 0) or 대실패 (total < 0).
 * - The roll is a normal PF2e check on the roller's screen; its degree goes to the active GM over the module socket, who checks it, writes it into the message (flags.<module>.group) and redraws the card.
 */

const FLAG = "group";
const SOCKET = `module.${MODULE_ID}`;
export const TIERS = ["full", "success", "failure", "critFailure"];
// By PF2e's degree of success: 0 critical failure … 3 critical success.
const POINTS = [-1, 0, 1, 2];
const DEGREES = ["criticalFailure", "failure", "success", "criticalSuccess"];
// Quick DC buttons next to the party level's DC (labels: Request.Adjust.*).
const ADJUST = [["Easy", -2], ["Hard", 2], ["VeryHard", 5]];

const isActiveGM = () => !!game.users.activeGM?.isSelf;
const dataOf = message => message?.flags?.[MODULE_ID]?.[FLAG] ?? null;
const clone = data => foundry.utils.deepClone(data);

/* pure helpers (tested in node) */

/** Points for one roll's degree of success (0…3); anything else counts 0. */
export function points(degree) {
  return Number.isInteger(degree) ? POINTS[degree] ?? 0 : 0;
}

/** Default target: half the participants, rounded up (at least 1). */
export function targetFor(n) {
  return Math.max(1, Math.ceil((Number(n) || 0) / 2));
}

export function totalOf(rolls) {
  return (rolls ?? []).reduce((sum, r) => sum + (Number(r?.points) || 0), 0);
}

/**
 * The outcome, or null while the challenge is still open.
 * `finished`: everyone has rolled or the GM ended it. Reaching the target wins at once.
 */
export function tierOf({ rolls = [], target = 1, finished = false } = {}) {
  const total = totalOf(rolls);
  if (total >= target) return { tier: rolls.every(r => r.degree >= 2) ? "full" : "success", total };
  if (!finished) return null;
  return { tier: total >= 0 ? "failure" : "critFailure", total };
}

/** What the card shows: total, target, bar width, who still has to roll, the outcome. */
export function summary(data) {
  const rolls = data?.rolls ?? [];
  const total = totalOf(rolls);
  const target = Math.max(1, Number(data?.target) || 1);
  const rolled = new Set(rolls.map(r => r.id));
  return {
    total, target,
    pct: Math.min(100, Math.max(0, total / target * 100)),
    waiting: (data?.ids ?? []).filter(id => !rolled.has(id)),
    outcome: data?.done ?? null
  };
}

/** The data with this roll added (and the outcome if it ends it); null when the roll doesn't count. */
export function recordRoll(data, { id, name, skill, degree } = {}) {
  if (!data || data.done) return null;
  if (!data.ids?.includes(id) || (data.rolls ?? []).some(r => r.id === id)) return null;
  if (!data.skills?.includes(skill) || !Number.isInteger(degree) || degree < 0 || degree > 3) return null;
  const next = clone(data);
  next.rolls = [...(next.rolls ?? []), { id, name: String(name ?? ""), skill, degree, points: points(degree) }];
  next.done = tierOf({ rolls: next.rolls, target: next.target, finished: next.rolls.length >= next.ids.length });
  return next;
}

/** The GM's 끝내기: failed (or badly) by the total, unless it was already over. */
export function endCheck(data) {
  if (!data || data.done) return null;
  const next = clone(data);
  next.done = tierOf({ rolls: next.rolls ?? [], target: next.target, finished: true });
  return next;
}

/** Rounded average level of these characters (0…25), or null. */
export function partyLevelOf(actors) {
  const levels = (actors ?? []).map(a => Number(a?.level ?? a?.system?.details?.level?.value)).filter(n => Number.isFinite(n) && n >= 0);
  if (!levels.length) return null;
  return Math.min(LEVEL_DC.length - 1, Math.round(levels.reduce((a, b) => a + b, 0) / levels.length));
}

/* skills */

/** Perception, then PF2e's skills in the user's language. */
export function skillChoices() {
  const skills = Object.entries(globalThis.CONFIG?.PF2E?.skills ?? {})
    .map(([slug, v]) => ({ slug, label: localizeMaybe(v?.label ?? v) || slug }))
    .sort((a, b) => a.label.localeCompare(b.label, game.i18n.lang));
  return [{ slug: "perception", label: t("Hud.Perception") }, ...skills];
}

function skillLabel(slug, list = skillChoices()) {
  return list.find(s => s.slug === slug)?.label ?? slug;
}

function statisticOf(actor, slug) {
  return actor?.getStatistic?.(slug) ?? actor?.skills?.[slug] ?? (slug === "perception" ? actor?.perception : null) ?? null;
}

/* the chat card */

function resultText(data, tier) {
  return String(data.texts?.[tier] ?? "").trim() || t(`Group.Text.${tier}`);
}

const pointsText = p => (p > 0 ? `+${p}` : p < 0 ? `−${-p}` : "0");

export function cardHtml(data) {
  const s = summary(data);
  const done = data.done;
  const list = skillChoices();
  const label = slug => skillLabel(slug, list);
  const rolls = (data.rolls ?? []).map(r => `<li class="d${r.degree}">
      <span class="who">${esc(r.name)}</span><span class="skill">${esc(label(r.skill))}</span>
      <span class="deg">${esc(t(`Group.Degree.${DEGREES[r.degree]}`))}</span><b class="pts">${pointsText(r.points)}</b></li>`).join("");
  const names = s.waiting.map(id => displayName(game.actors?.get(id)?.name ?? "?"));
  const tail = done
    ? `<div class="pkh-gc-result ${done.tier}"><b>${esc(t(`Group.Tier.${done.tier}`))}</b><p>${esc(resultText(data, done.tier))}</p></div>`
    : `${names.length ? `<p class="pkh-gc-wait">${esc(t("Group.Wait", { names: names.join(" · ") }))}</p>` : ""}
      <div class="pkh-gc-buttons">${data.skills.map(slug => `<button type="button" data-gc="roll" data-skill="${esc(slug)}">
        <i class="fa-solid fa-dice-d20"></i> ${esc(label(slug))}</button>`).join("")}</div>`;
  return `<div class="pkh-gc ${done ? `done ${done.tier}` : "open"}">
    <header><i class="fa-solid fa-people-group"></i> <strong>${esc(data.title || t("Group.Title"))}</strong></header>
    <div class="pkh-gc-meta"><span>${esc(data.skills.map(label).join(" · "))}</span>
      <span class="dc">${data.showDc ? `DC ${Number(data.dc) || 0}` : esc(t("Group.HiddenDc"))}</span></div>
    <div class="pkh-gc-meter${s.total < 0 ? " neg" : ""}"><div class="bar"><i style="width:${s.pct.toFixed(1)}%"></i></div>
      <b>${esc(t("Group.Progress", { total: s.total, target: s.target }))}</b></div>
    ${rolls ? `<ol class="pkh-gc-rolls">${rolls}</ol>` : ""}
    ${tail}
  </div>`;
}

/* the active GM records */

let chain = Promise.resolve(false);
/** One change at a time: two rolls arriving together both land on the card. */
function queue(fn) {
  chain = chain.then(fn).catch(err => { console.warn(`${MODULE_ID} | group check`, err); return false; });
  return chain;
}

function write(message, data) {
  return message.update({ content: cardHtml(data), [`flags.${MODULE_ID}.${FLAG}`]: data });
}

/** Who sent it: Foundry's sender id when it gives one (then the payload must agree), else the payload's. */
function senderOf(user, senderId) {
  if (senderId && user && senderId !== user) return null;
  return game.users.get(senderId ?? user) ?? null;
}

async function applyRoll({ messageId, actorId, skill, degree, user } = {}, senderId = null) {
  if (!isActiveGM()) return false;
  const message = game.messages.get(messageId);
  const data = dataOf(message);
  const sender = senderOf(user, senderId);
  const actor = game.actors.get(actorId);
  if (!data || data.done || !sender || !actor) return false;
  // Only the character's owner (or a GM) may roll for it.
  if (!sender.isGM && !actor.testUserPermission(sender, "OWNER")) return false;
  const next = recordRoll(data, { id: actor.id, name: displayName(actor.name), skill, degree: Number(degree) });
  if (!next) return false;
  await write(message, next);
  return true;
}

async function applyEnd({ messageId, user } = {}, senderId = null) {
  if (!isActiveGM() || !senderOf(user, senderId)?.isGM) return false;
  const message = game.messages.get(messageId);
  const next = endCheck(dataOf(message));
  if (!next) return false;
  await write(message, next);
  return true;
}

/** Active GM: check a roll sent from a player's screen (or its own) and put it on the card. Resolves true when recorded. */
export function receiveRoll(payload, senderId = null) {
  return queue(() => applyRoll(payload, senderId));
}

export function receiveEnd(payload, senderId = null) {
  return queue(() => applyEnd(payload, senderId));
}

function onSocket(payload, senderId) {
  const from = typeof senderId === "string" ? senderId : null;
  if (payload?.action === "group-roll") receiveRoll(payload, from);
  else if (payload?.action === "group-end") receiveEnd(payload, from);
}

/* rolling from the card */

/** Participants still to roll whom this user may roll for. */
function rollable(data) {
  return summary(data).waiting.map(id => game.actors.get(id)).filter(a => a?.isOwner);
}

/** A player with several: the HUD's character, else their assigned one, else the first. */
function pickOwn(list) {
  const hud = game.pf2eKrHud?.hud?.actor;
  return list.find(a => a.id === hud?.id) ?? list.find(a => a.id === game.user.character?.id) ?? list[0] ?? null;
}

/** Roll the check; true once the result is on its way to the GM. */
async function rollFor(message, skill, actor) {
  const data = dataOf(message);
  if (!data || data.done) return false;
  if (!actor) { ui.notifications.warn(`Rutz's HUD | ${t("Group.Notify.NoActor")}`); return false; }
  const stat = statisticOf(actor, skill);
  if (!stat?.roll) { ui.notifications.warn(`Rutz's HUD | ${t("Group.Notify.NoSkill", { name: displayName(actor.name) })}`); return false; }
  // Nobody could record it: don't spend the roll.
  if (!game.users.activeGM) { ui.notifications.warn(`Rutz's HUD | ${t("Group.Notify.NoGm")}`); return false; }
  const roll = await stat.roll({
    // visible: false keeps PF2e's own card from showing the DC to players.
    dc: { value: Number(data.dc) || 0, visible: !!data.showDc },
    label: `${data.title || t("Group.Title")}: ${stat.label ?? skillLabel(skill)}`,
    extraRollOptions: ["action:group-check"]
  });
  const degree = roll?.degreeOfSuccess ?? roll?.options?.degreeOfSuccess;
  if (!Number.isInteger(degree)) return false;   // the roll dialog was closed
  const payload = { action: "group-roll", messageId: message.id, actorId: actor.id, skill, degree, user: game.user.id };
  if (isActiveGM()) receiveRoll(payload, game.user.id);
  else game.socket.emit(SOCKET, payload);
  return true;
}

function endFromCard(message) {
  const payload = { action: "group-end", messageId: message.id, user: game.user.id };
  if (isActiveGM()) receiveEnd(payload, game.user.id);
  else game.socket.emit(SOCKET, payload);
}

/** Buttons on the card: a player rolls for their own character; the GM picks whom from a list and may end it. */
function wireCard(message, html) {
  const root = html instanceof HTMLElement ? html : html?.[0];
  const card = root?.querySelector?.(".pkh-gc");
  const data = dataOf(message);
  if (!card || !data) return;
  if (data.done) { card.querySelector(".pkh-gc-buttons")?.remove(); return; }
  const mine = rollable(data);
  let select = null;
  if (game.user.isGM) {
    const picked = (globalThis.canvas?.tokens?.controlled ?? []).map(tk => tk.actor?.id).find(id => mine.some(a => a.id === id));
    const row = document.createElement("div");
    row.className = "pkh-gc-gm";
    row.innerHTML = `<select aria-label="${esc(t("Group.Roller"))}" data-tooltip="${esc(t("Group.Roller"))}">${mine.map(a =>
      `<option value="${a.id}"${a.id === picked ? " selected" : ""}>${esc(displayName(a.name))}</option>`).join("")}</select>
      <button type="button" data-gc="end"><i class="fa-solid fa-flag-checkered"></i> ${esc(t("Group.End"))}</button>`;
    card.append(row);
    select = row.querySelector("select");
    row.querySelector("[data-gc=end]").addEventListener("click", ev => {
      ev.currentTarget.disabled = true;
      endFromCard(message);
    });
  }
  const buttons = [...card.querySelectorAll("button[data-gc=roll]")];
  for (const btn of buttons) {
    if (!mine.length) { btn.disabled = true; continue; }
    btn.addEventListener("click", async () => {
      const actor = game.user.isGM ? game.actors.get(select?.value ?? "") ?? null : pickOwn(mine);
      buttons.forEach(b => (b.disabled = true));
      let sent = false;
      try { sent = await rollFor(message, btn.dataset.skill, actor); } finally {
        // Sent: the card is redrawn by the GM. Not sent: try again.
        if (!sent) buttons.forEach(b => (b.disabled = false));
      }
    });
  }
}

/* the GM's setup window */

let setup = null;   // kept for this session: the next challenge often uses the same skills and people
let win = null;

function candidates() {
  return partyPcs();
}

function freshSetup() {
  return { title: "", skills: [], dc: null, showDc: true, ids: candidates().map(a => a.id), target: null, texts: {} };
}

function chosen() {
  const ids = new Set(setup.ids);
  return candidates().filter(a => ids.has(a.id));
}

function levelInfo() {
  const level = partyLevelOf(chosen());
  return level === null ? null : { level, dc: LEVEL_DC[level] };
}

function quickHtml() {
  const info = levelInfo();
  if (!info) return "";
  const btn = (dc, label) => `<button type="button" data-dc="${dc}">${esc(label)} <b>${dc}</b></button>`;
  return btn(info.dc, t("Group.LevelDc", { lv: info.level })) + ADJUST.map(([key, d]) => btn(info.dc + d, t(`Request.Adjust.${key}`))).join("");
}

function autoTargetText() {
  return t("Group.Auto", { n: targetFor(setup.ids.length) });
}

function setupHtml() {
  const pcs = candidates();
  const ids = new Set(setup.ids);
  const skills = new Set(setup.skills);
  const dc = setup.dc ?? levelInfo()?.dc ?? LEVEL_DC[1];
  const chips = skillChoices().map(s => `<button type="button" class="chip${skills.has(s.slug) ? " on" : ""}" data-skill="${esc(s.slug)}">${esc(s.label)}</button>`).join("");
  const people = pcs.length
    ? pcs.map(a => `<label><input type="checkbox" data-id="${a.id}"${ids.has(a.id) ? " checked" : ""}> ${esc(displayName(a.name))}</label>`).join("")
    : `<p class="hint">${esc(t("Group.NoPcs"))}</p>`;
  const texts = TIERS.map(tier => `<label for="pkh-gc-text-${tier}">${esc(t(`Group.Tier.${tier}`))}</label>
    <input type="text" id="pkh-gc-text-${tier}" data-text="${tier}" maxlength="300" value="${esc(setup.texts[tier] ?? "")}" placeholder="${esc(t(`Group.Text.${tier}`))}">`).join("");
  return `<div class="pkh-gc-setup">
    <input type="text" name="title" maxlength="80" value="${esc(setup.title)}" placeholder="${esc(t("Group.Name"))}">
    <div><h4>${esc(t("Group.Skills"))}</h4><div class="pkh-gc-chips">${chips}</div></div>
    <div class="row">
      <label>DC <input type="number" name="dc" min="1" max="60" value="${dc}"></label>
      <span class="quick">${quickHtml()}</span>
    </div>
    <label class="row"><input type="checkbox" name="showDc"${setup.showDc ? " checked" : ""}> ${esc(t("Group.ShowDc"))}</label>
    <div><h4>${esc(t("Group.People"))}</h4><div class="pkh-gc-people">${people}</div></div>
    <div class="row" data-tooltip="${esc(t("Group.TargetTip"))}">
      <label>${esc(t("Group.Target"))} <input type="number" name="target" min="1" max="99" value="${setup.target ?? ""}" placeholder="${targetFor(setup.ids.length)}"></label>
      <small class="auto">${esc(autoTargetText())}</small>
    </div>
    <details class="texts"><summary>${esc(t("Group.Texts"))}</summary><div class="pkh-gc-texts">${texts}</div></details>
    <div class="pkh-seat-buttons"><button type="button" data-act="start" class="primary"><i class="fa-solid fa-people-group"></i> ${esc(t("Group.Start"))}</button></div>
  </div>`;
}

/** Fresh numbers after the participants change: the level DCs, the automatic target. */
function refreshDerived(root) {
  root.querySelector(".quick").innerHTML = quickHtml();
  root.querySelector(".auto").textContent = autoTargetText();
  root.querySelector("[name=target]").placeholder = String(targetFor(setup.ids.length));
}

async function start(root, app) {
  const ids = chosen().map(a => a.id);
  const skills = skillChoices().map(s => s.slug).filter(slug => setup.skills.includes(slug));
  const dc = Math.round(Number(root.querySelector("[name=dc]").value) || 0);
  if (!skills.length) return ui.notifications.warn(`Rutz's HUD | ${t("Group.Notify.NeedSkill")}`);
  if (!ids.length) return ui.notifications.warn(`Rutz's HUD | ${t("Group.Notify.NeedPeople")}`);
  if (!(dc > 0)) return ui.notifications.warn(`Rutz's HUD | ${t("Group.Notify.NeedDc")}`);
  const typed = Math.round(Number(setup.target) || 0);
  const texts = Object.fromEntries(TIERS.map(tier => [tier, String(setup.texts[tier] ?? "").trim()]).filter(([, v]) => v));
  const data = {
    title: setup.title.trim(), skills, dc, showDc: !!setup.showDc,
    target: typed > 0 ? typed : targetFor(ids.length), ids, rolls: [], texts, done: null
  };
  await ChatMessage.create({ speaker: { alias: t("Group.Title") }, content: cardHtml(data), flags: { [MODULE_ID]: { [FLAG]: data } } });
  // Skills, DC and people stay for the next one.
  Object.assign(setup, { title: "", target: null, texts: {}, dc });
  app.close();
}

function wireSetup(root, app) {
  if (app._pkhWired) return;
  app._pkhWired = true;
  root.addEventListener("click", ev => {
    const chip = ev.target.closest(".chip[data-skill]");
    if (chip) {
      const slug = chip.dataset.skill;
      setup.skills = setup.skills.includes(slug) ? setup.skills.filter(s => s !== slug) : [...setup.skills, slug];
      chip.classList.toggle("on", setup.skills.includes(slug));
      return;
    }
    const quick = ev.target.closest("button[data-dc]");
    if (quick) {
      setup.dc = Number(quick.dataset.dc);
      root.querySelector("[name=dc]").value = setup.dc;
      return;
    }
    if (ev.target.closest("button[data-act=start]")) start(root, app);
  });
  root.addEventListener("input", ev => {
    const el = ev.target;
    if (el.name === "title") setup.title = el.value;
    else if (el.name === "dc") setup.dc = Number(el.value) || null;
    else if (el.name === "target") setup.target = Number(el.value) || null;
    else if (el.dataset.text) setup.texts[el.dataset.text] = el.value;
  });
  root.addEventListener("change", ev => {
    const el = ev.target;
    if (el.name === "showDc") setup.showDc = el.checked;
    if (!el.dataset.id) return;
    const ids = new Set(setup.ids);
    if (el.checked) ids.add(el.dataset.id); else ids.delete(el.dataset.id);
    setup.ids = candidates().map(a => a.id).filter(id => ids.has(id));
    refreshDerived(root);
  });
}

/** API (game.pf2eKrHud.groupCheck): the GM's setup window. */
export function openGroupCheck() {
  if (!game.user.isGM) return null;
  setup ??= freshSetup();
  // People who left the party since last time drop off the list.
  const now = new Set(candidates().map(a => a.id));
  setup.ids = setup.ids.filter(id => now.has(id));
  if (!setup.ids.length) setup.ids = [...now];
  if (win?.rendered) {
    win.render();
    win.bringToFront?.();
    return win;
  }
  win = new SimpleWindow({ id: `${MODULE_ID}-group-check`, title: t("Group.Title"), width: 420, html: setupHtml, onRender: wireSetup, classes: ["pkh-fit"] });
  win.render({ force: true });
  return win;
}

/** At init: cards already in the chat log get their buttons when first drawn. */
export function initGroupCheckCards() {
  Hooks.on("renderChatMessageHTML", wireCard);
}

/** At ready: the active GM listens for rolls and 끝내기 from other screens. */
export function initGroupCheck() {
  game.socket?.on(SOCKET, onSocket);
}
