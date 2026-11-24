import { MODULE_ID, SimpleWindow, displayName, esc, setting, t } from "./shared.mjs";
import { combatantFor, itemActionCost, turnKey } from "./economy.mjs";

/*
 * 전투 경험치 (a dynamic-level house rule)
 * - Every PC earns fixed XP for what they do in a fight:
 *     기본 행동  Strike, spell attack, skill/Perception action, a real HUD use, a spell cast (at most 4 a turn)
 *     대성공    a critical success, or an enemy critically failing a save that PC forced
 *     지원      Aid, healing an ally, an effect on an ally (once a turn)
 *     막타      the last PC to roll damage at an enemy that drops to 0 HP
 * - A failed check gives no 기본 행동 (nor support for Aid).
 * - The cap (per PC x PCs) is only a reference line; what is left under it is shared equally at the end (경험치 기준 → 남은 캡 나누기).
 * - Scoring runs on the active GM's client and is written to the combat (flags.<module>.xp), so every screen can float "+5 XP".
 * - Each award is logged for the panel's 기록 tab.
 * - When the combat ends the award window opens with each PC's total; the GM confirms.
 */

const FLAG = "xp";
export const KINDS = ["base", "crit", "support", "kill"];
// PF2e marks a spell card that is really cast (not only posted) with this origin roll option
const CAST_OPTION = "origin:action:slug:cast-a-spell";
export const DEFAULT_RULES = { cap: 0, base: 5, crit: 5, support: 5, kill: 20, share: 1 };
const BASE_PER_TURN = 4;
const FALLBACK_CAP = 80;
const WRITE_DELAY = 400;
const LOG_MAX = 400;

const isActiveGM = () => !!game.users.activeGM?.isSelf;
const enabled = () => setting("xpTracker", false) === true;
const blankEntry = () => ({ base: 0, crit: 0, support: 0, kill: 0 });

/* pure helpers (tested in node) */

/** One PC's XP: the sum of { base, crit, support, kill } (a plain number counts as it is). */
export function sumEntry(entry) {
  if (typeof entry === "number") return Number.isFinite(entry) ? entry : 0;
  return KINDS.reduce((sum, k) => sum + (Number(entry?.[k]) || 0), 0);
}

/** { [actorId]: total XP } from the combat's xp data ({ cap, xp, kills }). */
export function totals(data) {
  const out = {};
  for (const [id, entry] of Object.entries(data?.xp ?? {})) out[id] = sumEntry(entry);
  return out;
}

/** The GM's −/+ on one PC: `delta` XP on 기본 행동; the PC's total never drops below 0. */
export function nudge(entry, delta) {
  const next = { ...blankEntry(), ...(entry ?? {}) };
  const change = Math.max(-sumEntry(next), Number(delta) || 0);
  next.base = (Number(next.base) || 0) + change;
  return next;
}

/** How many level-ups `give` more XP makes (PF2e keeps the XP past max until the player levels). */
export function levelUps(value, give, max) {
  if (!(give > 0) || !(max > 0)) return 0;
  return Math.floor(((Number(value) || 0) + give) / max);
}

/** XP needed to reach level `target` (0 if already there). */
export function xpToLevel({ level, value, max, target }) {
  return target > level ? Math.max(0, (target - level) * max - (Number(value) || 0)) : 0;
}

/** What is left under the cap (cap x PCs - what they earned), shared equally: { [id]: extra }. Whole XP; the remainder goes to those who earned least. Over the cap: nothing. */
export function shareLeft({ cap, ids, sums }) {
  const n = ids.length;
  const earned = ids.reduce((a, id) => a + (Number(sums?.[id]) || 0), 0);
  const left = Math.max(0, Math.round((Number(cap) || 0) * n - earned));
  const out = Object.fromEntries(ids.map(id => [id, 0]));
  if (!n || !left) return out;
  const per = Math.floor(left / n);
  let rest = left - per * n;
  for (const id of ids) out[id] = per;
  for (const id of [...ids].sort((a, b) => (Number(sums?.[a]) || 0) - (Number(sums?.[b]) || 0))) {
    if (rest <= 0) break;
    out[id] += 1;
    rest -= 1;
  }
  return out;
}

/** Action slug of a check, as economy.mjs reads it ("action:aid" → "aid"). */
function actionSlug(ctx) {
  return ctx.action ?? (ctx.options ?? []).find(o => typeof o === "string" && o.startsWith("action:"))?.split(":")[1] ?? null;
}

/**
 * What a chat message is worth, from its flags alone:
 * base      an action (attack, spell attack, skill/Perception action, HUD use, spell cast)
 * crit      that check came up a critical success
 * aid       support: Aid, a healing-trait use, a guardian's action or reaction, a champion's reaction
 * damage    a damage roll: { actor, token } uuids of its target (or null)
 * saveCrit  a critically failed save: { actor, token } of whoever forced it
 */
export function classifyMessage(message) {
  const out = classifyUse(message);
  // A healing-trait use, a guardian's action or reaction (Taunt, Intercept Attack) and a champion's reaction (it guards an ally) are support.
  if (out.base && !out.aid && (isHealing(message) || isGuarding(message))) out.aid = true;
  return out;
}

function itemOf(message) {
  try { return message?.item ?? null; } catch (_) { return null; }
}

/** A guardian-trait action/reaction, or a champion-trait reaction. */
function isGuarding(message) {
  const item = itemOf(message);
  const traits = item?.system?.traits?.value ?? [];
  if (traits.includes("guardian")) return true;
  return traits.includes("champion") && item?.system?.actionType?.value === "reaction";
}

/** The healing trait on the message's item, its check's traits, or its roll options. */
function isHealing(message) {
  let item = null;
  try { item = message?.item ?? null; } catch (_) { item = null; }
  if ((item?.system?.traits?.value ?? []).includes("healing")) return true;
  const ctx = message?.flags?.pf2e?.context;
  if ((ctx?.traits ?? []).some(x => (x?.name ?? x) === "healing")) return true;
  return (ctx?.options ?? []).some(o => typeof o === "string" && /(^|:)trait:healing$/.test(o));
}

function classifyUse(message) {
  const out = { base: false, crit: false, aid: false, damage: null, saveCrit: null };
  const flags = message?.flags ?? {};
  const pf2e = flags.pf2e ?? {};
  const ctx = pf2e.context ?? null;
  if (flags[MODULE_ID]?.used) out.base = true;
  // A sustained spell kept up from the HUD's sustain card (지속, one action).
  if (flags[MODULE_ID]?.sustainResult?.choice === "keep") out.base = true;
  // An action or feat used from the sheet: one with an action cost, as economy.mjs counts it, or a reaction. Free actions do not count.
  if (!ctx && ["action", "feat"].includes(pf2e.origin?.type)) {
    const item = itemOf(message);
    if (itemActionCost(item) > 0 || item?.system?.actionType?.value === "reaction") out.base = true;
  }
  // The spell card itself, not its rolls, and only a real cast: PF2e posts the same card to ask about a spell and adds this roll option only when it is cast (actualCast).
  if (pf2e.casting && pf2e.origin?.type === "spell" && (!ctx || ctx.type === "spell-cast")
    && (pf2e.origin.rollOptions ?? []).includes(CAST_OPTION)) out.base = true;
  if (!ctx) return out;
  if (ctx.type === "damage-roll") {
    out.damage = ctx.target ? { actor: ctx.target.actor ?? null, token: ctx.target.token ?? null } : null;
    return out;
  }
  if (ctx.type === "saving-throw") {
    const o = ctx.origin;
    if (ctx.outcome === "criticalFailure" && o) out.saveCrit = typeof o === "string" ? { actor: o, token: null } : { actor: o.actor ?? null, token: o.token ?? null };
    return out;
  }
  const failed = ctx.outcome === "failure" || ctx.outcome === "criticalFailure";
  let check = ctx.type === "attack-roll" || ctx.type === "spell-attack-roll";
  if (!check && ["skill-check", "perception-check", "check"].includes(ctx.type)) {
    const slug = actionSlug(ctx);
    check = !!slug;
    out.aid = slug === "aid" && !failed;
  }
  if (!check) return out;
  // A miss gives nothing. A succeeding reroll counts; a reroll with no outcome (no DC) is the same action again, so no second 기본 행동.
  if (!failed && !(ctx.isReroll && !ctx.outcome)) out.base = true;
  if (ctx.outcome === "criticalSuccess") out.crit = true;
  return out;
}

/* rules, participants */

export function rules() {
  const stored = setting("xpRules", null) ?? {};
  const out = { ...DEFAULT_RULES };
  for (const key of Object.keys(DEFAULT_RULES)) {
    const n = Number(stored[key]);
    if (Number.isFinite(n) && n >= 0) out[key] = n;
  }
  return out;
}

/** PCs in the fight: player-owned characters, one per actor. */
export function participantsOf(combat) {
  const seen = new Map();
  for (const c of combat?.combatants ?? []) {
    const a = c.actor;
    if (a?.type === "character" && a.hasPlayerOwner && !seen.has(a.id)) seen.set(a.id, a);
  }
  return [...seen.values()];
}

function isParticipant(combat, actor) {
  if (!actor || actor.type !== "character" || !actor.hasPlayerOwner) return false;
  return participantsOf(combat).some(a => a.id === actor.id);
}

/** The PC whose turn it is, if the one acting is a PC. */
function currentPc(combat) {
  const a = combat?.combatant?.actor;
  return isParticipant(combat, a) ? a : null;
}

/** An actor from { actor, token } uuids. The token first: it names the exact (unlinked) creature. */
function actorFrom(ref) {
  const get = uuid => {
    if (typeof uuid !== "string" || !uuid) return null;
    try { return fromUuidSync(uuid); } catch (_) { return null; }
  };
  if (!ref) return null;
  return get(ref.token)?.actor ?? get(ref.actor) ?? null;
}

function speakerOf(message) {
  try { return message.actor ?? ChatMessage.getSpeakerActor?.(message.speaker) ?? null; } catch (_) { return null; }
}

/** PF2e's encounter analysis ({ threat, award: { xp } … }); null without a party or outside PF2e. */
function metricsOf(combat) {
  try { return combat?.metrics ?? null; } catch (_) { return null; }
}

/** PF2e's XP per PC for this encounter's threat, or null. */
function pf2eXp(combat) {
  const xp = Number(metricsOf(combat)?.award?.xp);
  return Number.isFinite(xp) ? Math.max(0, Math.round(xp)) : null;
}

function defaultCap(combat) {
  const own = rules().cap;
  if (own > 0) return own;
  return pf2eXp(combat) || FALLBACK_CAP;
}

/* the combat's data (active GM writes) */

const live = new Map();     // combat id → newest copy on the active GM (writes are debounced)
const timers = new Map();   // combat id → pending write

const stored = combat => combat?.flags?.[MODULE_ID]?.[FLAG] ?? null;

/** What to show: the active GM's in-memory copy, else what the combat holds. */
function dataOf(combat) {
  return (combat && live.get(combat.id)) ?? stored(combat);
}

/** The copy to change: made from the flag (or fresh) the first time. */
function working(combat) {
  let data = live.get(combat.id);
  if (!data) {
    const flag = stored(combat);
    data = flag ? foundry.utils.deepClone(flag) : { cap: defaultCap(combat), xp: {}, kills: [], log: [] };
    data.xp ??= {};
    data.kills ??= [];
    data.log ??= [];
    live.set(combat.id, data);
  }
  return data;
}

/** Write after a short pause, so a burst of events becomes one update and none is lost. */
function save(combat) {
  clearTimeout(timers.get(combat.id));
  timers.set(combat.id, setTimeout(() => {
    timers.delete(combat.id);
    const data = live.get(combat.id);
    if (!data || !game.combats?.get(combat.id)) return;
    combat.setFlag(MODULE_ID, FLAG, foundry.utils.deepClone(data))
      .catch(err => console.warn(`${MODULE_ID} | xp: could not save`, err));
  }, WRITE_DELAY));
  refreshPanel();
}

/** One line of the 기록 tab: round, PC, kind, why, XP. */
function logLine(combat, data, actorId, kind, why, xp) {
  const name = participantsOf(combat).find(a => a.id === actorId)?.name ?? game.actors.get(actorId)?.name ?? "?";
  data.log.push({ r: Number(combat.round) || 0, id: actorId, name, kind, why: String(why ?? "").slice(0, 80), xp });
  if (data.log.length > LOG_MAX) data.log.splice(0, data.log.length - LOG_MAX);
}

function grant(combat, actorId, kind, why = "") {
  const amount = rules()[kind];
  if (!amount) return;
  const data = working(combat);
  const entry = data.xp[actorId] ??= blankEntry();
  entry[kind] = (Number(entry[kind]) || 0) + amount;
  logLine(combat, data, actorId, kind, why, amount);
  save(combat);
}

/** What a chat message was, in a few words: its item, else its action, else its flavor text. */
function whatOf(message) {
  let item = null;
  try { item = message.item ?? null; } catch (_) { item = null; }
  if (item?.name) return item.name;
  if (message.flags?.[MODULE_ID]?.sustainResult) return t("Xp.Why.Sustain");
  const ctx = message.flags?.pf2e?.context;
  const slug = ctx ? actionSlug(ctx) : null;
  if (slug) {
    const action = game.pf2e?.actions?.get?.(slug);
    const name = action?.name ? game.i18n.localize(action.name) : "";
    if (name) return name;
  }
  const flavor = String(message.flavor ?? "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
  return flavor.slice(0, 40) || t("Xp.Why.Action");
}

/** Per-turn limits: `${turn}|${kind}|${actor}` → times awarded. */
const perTurn = new Map();
function underLimit(kind, actorId, limit) {
  const key = `${turnKey()}|${kind}|${actorId}`;
  const n = perTurn.get(key) ?? 0;
  if (n >= limit) return false;
  perTurn.set(key, n + 1);
  return true;
}

function support(combat, actorId, why) {
  if (underLimit("support", actorId, 1)) grant(combat, actorId, "support", why);
}

/** The combat being scored right now (active GM, setting on, fight started), else null. */
function tracking() {
  const combat = game.combat;
  return isActiveGM() && enabled() && combat?.started ? combat : null;
}

/* scoring */

const lastHit = new Map();  // enemy actor uuid → id of the PC who last rolled damage at it
const lastHp = new Map();   // actor uuid → HP last seen (GM clients)

function onMessage(message) {
  const combat = tracking();
  if (!combat) return;
  const info = classifyMessage(message);
  const speaker = speakerOf(message);
  if (isParticipant(combat, speaker)) {
    const what = info.base || info.crit || info.aid ? whatOf(message) : "";
    if (info.base && underLimit("base", speaker.id, BASE_PER_TURN)) grant(combat, speaker.id, "base", what);
    if (info.crit) grant(combat, speaker.id, "crit", what);
    if (info.aid) support(combat, speaker.id, what);
    const target = info.damage ? actorFrom(info.damage) : null;
    if (target && !target.hasPlayerOwner) lastHit.set(target.uuid, speaker.id);
    return;
  }
  // An enemy critically failing a save: the PC who forced it.
  if (info.saveCrit && speaker && !speaker.hasPlayerOwner) {
    const by = actorFrom(info.saveCrit);
    if (isParticipant(combat, by)) grant(combat, by.id, "crit", t("Xp.Why.SaveCrit", { name: speaker.name }));
  }
}

function seedHp(combat) {
  for (const c of combat?.combatants ?? []) {
    const a = c.actor;
    const hp = a?.system?.attributes?.hp;
    if (a && hp && !lastHp.has(a.uuid)) lastHp.set(a.uuid, Number(hp.value) || 0);
  }
}

/** HP up on a PC → the healer (whose turn it is) supported; an enemy to 0 → 막타. */
function onUpdateActor(actor, changes, options) {
  if (!game.user.isGM || !actor) return;
  const value = foundry.utils.getProperty(changes, "system.attributes.hp.value");
  if (value === undefined) return;
  const now = Number(value) || 0;
  const before = lastHp.has(actor.uuid) ? lastHp.get(actor.uuid) : now + (Number(options?.damageTaken) || 0);
  lastHp.set(actor.uuid, now);
  const combat = tracking();
  if (!combat || now === before) return;
  if (now > before) {
    if (!isParticipant(combat, actor)) return;
    const healer = currentPc(combat);
    if (healer && healer.id !== actor.id) support(combat, healer.id, t("Xp.Why.Heal", { name: actor.name }));
    return;
  }
  if (before > 0 && now <= 0) killed(combat, actor);
}

function killed(combat, actor) {
  const c = combatantFor(actor, combat);
  const friendly = CONST.TOKEN_DISPOSITIONS?.FRIENDLY ?? 1;
  if (!c || actor.hasPlayerOwner || c.token?.disposition === friendly) return;
  const data = working(combat);
  if (data.kills.includes(actor.uuid)) return;
  const id = lastHit.get(actor.uuid) ?? currentPc(combat)?.id;
  if (!id || !participantsOf(combat).some(a => a.id === id)) return;
  data.kills.push(actor.uuid);
  grant(combat, id, "kill", t("Xp.Why.Kill", { name: c.token?.name ?? actor.name }));
}

/** An effect put on a PC by another PC (its origin), else by the PC whose turn it is. */
function onCreateItem(item) {
  const combat = tracking();
  if (!combat || item?.type !== "effect") return;
  if (Object.keys(item.flags?.[MODULE_ID] ?? {}).length) return;
  const target = item.parent;
  if (!isParticipant(combat, target)) return;
  const from = actorFrom({ actor: item.system?.context?.origin?.actor });
  if (from && !isParticipant(combat, from)) return;
  const source = from ?? currentPc(combat);
  if (source && source.id !== target.id) support(combat, source.id, t("Xp.Why.Effect", { effect: item.name, name: target.name }));
}

/* "+5 XP" on every screen */

const shown = new Map();   // combat id → totals last seen on this screen

function floatGains(combat) {
  const now = totals(stored(combat));
  const before = shown.get(combat.id);
  shown.set(combat.id, now);
  if (!before || combat !== game.combat) return;
  for (const [id, total] of Object.entries(now)) {
    const diff = total - (before[id] ?? 0);
    if (diff) floatXp(combat, id, diff);
  }
}

/** Best effort: a big "+5 XP" over the PC's token, and over its standee when Rutz's Tactics View is open (not on the party portraits, where a number reads like HP). */
function floatXp(combat, actorId, diff) {
  const text = `${diff > 0 ? "+" : "−"}${Math.abs(diff)} XP`;
  const tokenDoc = combat.combatants.find(c => c.actor?.id === actorId && c.token)?.token ?? null;
  try {
    const token = tokenDoc?.object;
    const A = CONST.TEXT_ANCHOR_POINTS ?? {};
    if (canvas?.ready && token?.visible && canvas.interface?.createScrollingText) {
      canvas.interface.createScrollingText(token.center, text, {
        anchor: A.TOP, direction: A.TOP, distance: Math.max(60, (token.h ?? 100) * 0.9), duration: 2600,
        fontSize: 34, fontWeight: "900", fill: diff > 0 ? 0xffd166 : 0xc8c8c8, stroke: 0x2a1600, strokeThickness: 7, jitter: 0.1
      });
    }
  } catch (_) { }
  try {
    // Rutz's Tactics View: its own floating text over the standee
    const view = game.modules.get("rutz-diorama")?.active ? game.modules.get("rutz-diorama").api?.view : null;
    if (view?.floatText && tokenDoc?.id && tokenDoc.parent?.id === canvas?.scene?.id) {
      view.floatText(tokenDoc.id, text, diff > 0 ? "#ffd166" : "#c8c8c8", null, { cls: `pkh-xp-standee${diff < 0 ? " minus" : ""}` });
    }
  } catch (_) { }
}

/* the GM's panel */

let panel = null;
let rulesOpen = false;
let panelTab = "now";       // "now" (현황) | "log" (기록)
let logWho = "";            // 기록: one PC's lines only ("" = everyone)
let refreshTimer = 0;

function threatLabel(threat) {
  const key = `PKH.Xp.Threat.${threat}`;
  return game.i18n.has?.(key) ? game.i18n.localize(key) : String(threat);
}

function rowHtml(actor, entry, edit, step) {
  const e = { ...blankEntry(), ...(entry ?? {}) };
  const tip = KINDS.map(k => `${t(`Xp.Kind.${k}`)} ${Number(e[k]) || 0}`).join("<br>");
  const dis = edit ? "" : "disabled";
  return `<li class="pkh-xp-row">
    <span class="name" data-tooltip="${esc(displayName(actor.name))}">${esc(displayName(actor.name))}</span>
    <b class="sum" data-tooltip="${esc(tip)}">${sumEntry(e)} XP</b>
    <button type="button" data-act="minus" data-id="${actor.id}" data-tooltip="${esc(t("Xp.Minus", { n: step }))}" ${dis}>−</button>
    <button type="button" data-act="plus" data-id="${actor.id}" data-tooltip="${esc(t("Xp.Plus", { n: step }))}" ${dis}>+</button>
  </li>`;
}

function panelHtml() {
  const combat = game.combat;
  if (!combat?.started) {
    return `<div class="pkh-xp">
      <p class="pkh-xp-empty">${esc(t("Xp.NoCombat"))}</p>
      <div class="pkh-seat-buttons"><button type="button" data-act="award" class="primary"><i class="fa-solid fa-star"></i> ${esc(t("Xp.AwardTitle"))}</button></div>
    </div>`;
  }
  const data = dataOf(combat) ?? { cap: defaultCap(combat), xp: {} };
  const pcs = participantsOf(combat);
  const sums = totals(data);
  const cap = Number(data.cap) || 0;
  const total = cap * pcs.length;
  const granted = pcs.reduce((sum, a) => sum + (sums[a.id] ?? 0), 0);
  const over = granted - total;
  const pct = total > 0 ? Math.min(100, Math.max(0, granted / total * 100)) : granted > 0 ? 100 : 0;
  const edit = isActiveGM();
  const r = rules();
  const step = r.base || 1;
  const pf2e = pf2eXp(combat);
  const threat = metricsOf(combat)?.threat ? threatLabel(metricsOf(combat).threat) : "";
  const ruleKeys = [...KINDS, "cap"];
  const log = data.log ?? [];
  const tabs = `<nav class="pkh-xp-tabs">
      <button type="button" data-tab="now" class="${panelTab === "now" ? "active" : ""}">${esc(t("Xp.Tab.Now"))}</button>
      <button type="button" data-tab="log" class="${panelTab === "log" ? "active" : ""}">${esc(t("Xp.Tab.Log"))} <small>${log.length}</small></button>
    </nav>`;
  if (panelTab === "log") return `<div class="pkh-xp">${tabs}${logHtml(log, pcs)}</div>`;
  return `<div class="pkh-xp">${tabs}
    <div class="pkh-xp-cap">
      <label>${esc(t("Xp.CapPer"))} <input type="number" data-f="cap" min="0" step="5" value="${cap}" ${edit ? "" : "disabled"}></label>
      <span>× ${esc(t("Xp.People", { n: pcs.length }))} = <b>${total}</b></span>
      <button type="button" data-act="pf2e" data-tooltip="${esc(pf2e === null ? t("Xp.NoPf2e") : t("Xp.Pf2eTip", { n: pf2e }))}" ${edit && pf2e !== null ? "" : "disabled"}>PF2e</button>
      ${threat ? `<small class="threat">${esc(t("Xp.ThreatLine", { threat }))}</small>` : ""}
    </div>
    <div class="pkh-xp-meter${over > 0 ? " over" : ""}">
      <div class="bar"><i style="width:${pct.toFixed(1)}%"></i></div>
      <span>${esc(t("Xp.Granted", { n: granted, total }))}${over > 0 ? ` <em>${esc(t("Xp.Over", { n: over }))}</em>` : ""}</span>
    </div>
    ${r.share && over < 0 && pcs.length ? `<p class="pkh-xp-share">${esc(t("Xp.ShareLine", { left: -over, n: pcs.length }))}</p>` : ""}
    ${pcs.length ? `<ul class="pkh-xp-list">${pcs.map(a => rowHtml(a, data.xp?.[a.id], edit, step)).join("")}</ul>` : `<p class="pkh-xp-empty">${esc(t("Xp.NoPcs"))}</p>`}
    <details class="pkh-xp-rules" ${rulesOpen ? "open" : ""}>
      <summary>${esc(t("Xp.Rules"))}</summary>
      <div class="grid">${ruleKeys.map(k => `<label${k === "cap" ? ` data-tooltip="${esc(t("Xp.DefaultCapTip"))}"` : ""}><span>${esc(k === "cap" ? t("Xp.DefaultCap") : t(`Xp.Kind.${k}`))}</span>
        <input type="number" min="0" step="1" data-rule="${k}" value="${r[k]}"></label>`).join("")}</div>
      <label class="pkh-xp-sharebox" data-tooltip="${esc(t("Xp.ShareTip"))}"><input type="checkbox" data-rule-bool="share" ${r.share ? "checked" : ""}> ${esc(t("Xp.Share"))}</label>
    </details>
  </div>`;
}

/** 기록 tab: newest first, a round header when the round changes; one PC's lines with the filter. */
function logHtml(log, pcs) {
  const lines = log.filter(l => !logWho || l.id === logWho).slice().reverse();
  const pick = `<select data-f="who"><option value="">${esc(t("Xp.LogAll"))}</option>${pcs.map(a => `<option value="${a.id}" ${a.id === logWho ? "selected" : ""}>${esc(displayName(a.name))}</option>`).join("")}</select>`;
  if (!lines.length) return `<div class="pkh-xp-logbar">${pick}</div><p class="pkh-xp-empty">${esc(t("Xp.LogEmpty"))}</p>`;
  let round = null;
  const rows = lines.map(l => {
    const head = l.r !== round ? `<li class="round">${esc(t("Xp.Round", { n: l.r }))}</li>` : "";
    round = l.r;
    const kind = l.kind === "gm" ? t("Xp.Why.Gm") : t(`Xp.Kind.${l.kind}`);
    return `${head}<li class="pkh-xp-log k-${esc(l.kind)}">
      <span class="who" data-tooltip="${esc(displayName(l.name))}">${esc(displayName(l.name))}</span>
      <span class="why"><em>${esc(kind)}</em>${l.why && l.kind !== "gm" ? ` · ${esc(l.why)}` : ""}</span>
      <b>${l.xp > 0 ? "+" : "−"}${Math.abs(l.xp)}</b></li>`;
  }).join("");
  const sum = lines.reduce((n, l) => n + (Number(l.xp) || 0), 0);
  return `<div class="pkh-xp-logbar">${pick}<span>${esc(t("Xp.LogSum", { n: sum }))}</span></div><ul class="pkh-xp-loglist">${rows}</ul>`;
}

/** Redraw (batched), keeping the scroll; held back while the GM is typing in one of its boxes. */
function refreshPanel() {
  if (!panel?.rendered) return;
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => {
    const root = panel?.element?.querySelector(".window-content");
    if (!panel?.rendered || !root) return;
    const focused = document.activeElement;
    if (focused && root.contains(focused) && focused.matches("input")) { panel._pkhStale = true; return; }
    panel._pkhTop = root.querySelector(".pkh-xp-list, .pkh-xp-loglist")?.scrollTop ?? root.scrollTop;   // the list scrolls (panels.css)
    panel.render();
  }, 60);
}

async function setRule(key, raw) {
  if (!game.user.isGM || !(key in DEFAULT_RULES)) return;
  await game.settings.set(MODULE_ID, "xpRules", { ...rules(), [key]: Math.max(0, Math.round(Number(raw) || 0)) });
}

function wirePanel(root, app) {
  const list = root.querySelector?.(".pkh-xp-list, .pkh-xp-loglist");
  if (list) list.scrollTop = app._pkhTop ?? 0;
  else root.scrollTop = app._pkhTop ?? 0;
  if (app._pkhWired) return;          // the content element stays; listen once
  app._pkhWired = true;
  root.addEventListener("click", ev => {
    const tab = ev.target.closest("button[data-tab]");
    if (tab) { panelTab = tab.dataset.tab; app._pkhTop = 0; return void app.render(); }
    const btn = ev.target.closest("button[data-act]");
    if (!btn) return;
    const act = btn.dataset.act;
    if (act === "award") return void openAward();
    const combat = game.combat;
    if (!combat?.started || !isActiveGM()) return;
    if (act === "pf2e") {
      const xp = pf2eXp(combat);
      if (xp !== null) { working(combat).cap = xp; save(combat); }
      return;
    }
    if (act === "plus" || act === "minus") {
      const step = rules().base || 1;
      const data = working(combat);
      const id = btn.dataset.id;
      const before = sumEntry(data.xp[id]);
      data.xp[id] = nudge(data.xp[id], act === "plus" ? step : -step);
      const change = sumEntry(data.xp[id]) - before;
      if (change) logLine(combat, data, id, "gm", t("Xp.Why.Gm"), change);
      save(combat);
    }
  });
  root.addEventListener("change", ev => {
    const el = ev.target;
    if (el.dataset.rule) return void setRule(el.dataset.rule, el.value);
    if (el.dataset.ruleBool) return void setRule(el.dataset.ruleBool, el.checked ? 1 : 0);
    if (el.dataset.f === "who") { logWho = el.value; return void app.render(); }
    if (el.dataset.f !== "cap") return;
    const combat = game.combat;
    if (!combat?.started || !isActiveGM()) return;
    working(combat).cap = Math.max(0, Math.round(Number(el.value) || 0));
    save(combat);
  });
  // Enter in a box: done typing (the change and the held-back redraw follow).
  root.addEventListener("keydown", ev => { if (ev.key === "Enter" && ev.target.matches?.("input")) { ev.preventDefault(); ev.target.blur(); } });
  root.addEventListener("focusout", () => {
    if (!app._pkhStale) return;
    app._pkhStale = false;
    setTimeout(refreshPanel, 0);
  });
  // "toggle" does not bubble: listen in the capture phase.
  root.addEventListener("toggle", ev => { if (ev.target.classList?.contains("pkh-xp-rules")) rulesOpen = ev.target.open; }, true);
}

function openPanel() {
  if (!game.user.isGM) return null;
  if (panel?.rendered) {
    refreshPanel();
    panel.bringToFront?.();
    return panel;
  }
  panel = new SimpleWindow({ id: `${MODULE_ID}-xp`, title: t("Xp.Title"), width: 360, html: panelHtml, onRender: wirePanel, classes: ["pkh-fit"] });
  panel.render({ force: true });
  return panel;
}

/* the award window */

let award = null;
let awardRows = [];
let awardNote = "";
let awardButtons = [];      // other modules' buttons (hook "pf2eKrHud.awardButtons"), collected when the window is built

/** Buttons other modules add to the award window: Hooks.on("pf2eKrHud.awardButtons", (buttons, { combat }) => buttons.push({ id, icon, label, tooltip?, onClick })). `combat`: the Combat that just ended, or null when opened by hand. Bad entries are dropped. */
export function collectAwardButtons(combat = null) {
  const extra = [];
  try { Hooks.callAll("pf2eKrHud.awardButtons", extra, { combat }); }
  catch (err) { console.warn(`${MODULE_ID} | xp: awardButtons`, err); }
  return extra.filter(b => b && typeof b.onClick === "function" && String(b.label ?? "").trim());
}

/** The row of other modules' buttons: nothing when there are none. */
export function awardButtonsHtml(buttons) {
  if (!buttons?.length || !game.user.isGM) return "";
  const one = (b, i) => {
    const tip = b.tooltip ? ` data-tooltip="${esc(b.tooltip)}"` : "";
    const icon = b.icon ? `<i class="${esc(b.icon)}"></i> ` : "";
    return `<button type="button" data-extra="${i}" data-extra-id="${esc(b.id ?? "")}"${tip}>${icon}${esc(b.label)}</button>`;
  };
  return `<div class="pkh-xp-extra">${buttons.map(one).join("")}</div>`;
}

/** A button from another module: its error stays its own, and the award window stays open. */
export function runAwardButton(button) {
  try {
    const out = button?.onClick?.();
    if (out && typeof out.catch === "function") out.catch(err => console.warn(`${MODULE_ID} | xp: award button "${button.id}"`, err));
  } catch (err) { console.warn(`${MODULE_ID} | xp: award button "${button?.id}"`, err); }
}

function xpOf(actor) {
  const xp = actor?.system?.details?.xp ?? {};
  return {
    level: Number(actor?.system?.details?.level?.value) || 0,
    value: Number(xp.value) || 0,
    max: Number(xp.max) || 1000
  };
}

/** Outside a fight: the party's PCs (PF2e party actor), else every player-owned character. Also 파티 굴림's default list. */
export function partyPcs() {
  const isPc = a => a?.type === "character" && a.hasPlayerOwner;
  const unique = list => [...new Map(list.map(a => [a.id, a])).values()];
  const members = (game.actors.party?.members ?? []).filter(isPc);
  return unique(members.length ? members : game.actors.filter(isPc));
}

function previewOf(row) {
  const actor = game.actors.get(row.id);
  const { value, max } = xpOf(actor);
  const n = levelUps(value, row.give, max);
  if (!n) return "";
  return n > 1 ? t("Xp.LevelUpN", { n }) : t("Xp.LevelUp");
}

function awardHtml() {
  const lowest = Math.min(...awardRows.map(r => xpOf(game.actors.get(r.id)).level));
  const level = Math.min(20, (Number.isFinite(lowest) ? lowest : 0) + 1);
  const fill = (act, html) => `<div class="pkh-xp-fill">${html}<button type="button" data-act="${act}" data-tooltip="${esc(t("Xp.Fill"))}"><i class="fa-solid fa-arrow-down"></i></button></div>`;
  const rows = awardRows.map(r => {
    const actor = game.actors.get(r.id);
    const { level: lv, value, max } = xpOf(actor);
    return `<tr data-id="${r.id}" class="${r.include ? "" : "off"}">
      <td><input type="checkbox" data-f="include" ${r.include ? "checked" : ""}></td>
      <td class="name" data-tooltip="${esc(displayName(actor?.name ?? "?"))}">${esc(displayName(actor?.name ?? "?"))}</td>
      <td class="num">${lv}</td>
      <td class="num">${value} / ${max}</td>
      <td><input type="number" data-f="give" min="0" step="10" value="${r.give || ""}" placeholder="0"></td>
      <td class="up">${esc(previewOf(r))}</td>
    </tr>`;
  }).join("");
  return `<div class="pkh-xp pkh-xp-award">
    ${awardNote ? `<p class="pkh-xp-share">${esc(awardNote)}</p>` : ""}
    <div class="pkh-xp-fills">
      ${fill("all", t("Xp.FillAll", { n: `<input type="number" name="all" min="0" step="10" placeholder="0">` }))}
      ${fill("level", t("Xp.FillLevel", { n: `<input type="number" name="level" min="1" max="20" value="${level}">` }))}
    </div>
    <div class="pkh-xp-rows"><table class="pkh-xp-table">
      <thead><tr><th></th><th>${esc(t("Xp.Col.Name"))}</th><th>${esc(t("Xp.Col.Level"))}</th><th>XP</th><th>${esc(t("Xp.Give"))}</th><th></th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>
    ${awardButtonsHtml(awardButtons)}<div class="pkh-seat-buttons">
      <button type="button" data-act="cancel">${esc(t("Common.Cancel"))}</button>
      <button type="button" data-act="give" class="primary"><i class="fa-solid fa-star"></i> ${esc(t("Xp.Give"))}</button>
    </div>
  </div>`;
}

/** Put the rows' numbers back into their boxes (after a fill), without a redraw. */
function showRows(root) {
  for (const r of awardRows) {
    const tr = root.querySelector(`tr[data-id="${r.id}"]`);
    if (!tr) continue;
    tr.querySelector("[data-f=give]").value = r.give || "";
    tr.querySelector(".up").textContent = previewOf(r);
  }
}

function fillRows(root, how) {
  if (how === "all") {
    const n = Math.max(0, Math.round(Number(root.querySelector("[name=all]")?.value) || 0));
    for (const r of awardRows) if (r.include) r.give = n;
  } else {
    const target = Math.round(Number(root.querySelector("[name=level]")?.value) || 0);
    for (const r of awardRows) if (r.include) r.give = xpToLevel({ ...xpOf(game.actors.get(r.id)), target });
  }
  showRows(root);
}

function wireAward(root, app) {
  if (app._pkhWired) return;
  app._pkhWired = true;
  const rowOf = el => awardRows.find(r => r.id === el.closest("tr[data-id]")?.dataset.id);
  root.addEventListener("input", ev => {
    const el = ev.target;
    const r = el.dataset.f === "give" ? rowOf(el) : null;
    if (!r) return;
    r.give = Math.max(0, Math.round(Number(el.value) || 0));
    el.closest("tr").querySelector(".up").textContent = previewOf(r);
  });
  root.addEventListener("change", ev => {
    const el = ev.target;
    if (el.dataset.f === "include") {
      const r = rowOf(el);
      if (r) r.include = el.checked;
      el.closest("tr")?.classList.toggle("off", !el.checked);
      return;
    }
    if (el.name === "all" || el.name === "level") fillRows(root, el.name);
  });
  root.addEventListener("click", async ev => {
    const extra = ev.target.closest("button[data-extra]");
    if (extra) return runAwardButton(awardButtons[Number(extra.dataset.extra)]);
    const btn = ev.target.closest("button[data-act]");
    const act = btn?.dataset.act;
    if (act === "all" || act === "level") return fillRows(root, act);
    if (act === "cancel") return app.close();
    if (act !== "give") return;
    btn.disabled = true;
    try { if (await giveXp(awardRows)) app.close(); } finally { btn.disabled = false; }
  });
}

/** Add the XP to each ticked PC, then one public chat card listing who got what. */
async function giveXp(rows) {
  const lines = [];
  for (const r of rows) {
    const actor = game.actors.get(r.id);
    if (!r.include || !(r.give > 0) || !actor) continue;
    const { value, max } = xpOf(actor);
    const next = value + r.give;
    try {
      await actor.update({ "system.details.xp.value": next });
      lines.push({ name: displayName(actor.name), give: r.give, up: next >= max });
    } catch (err) { console.warn(`${MODULE_ID} | xp: ${actor.name}`, err); }
  }
  if (!lines.length) {
    ui.notifications.warn(`Rutz's HUD | ${t("Xp.NothingToGive")}`);
    return false;
  }
  const body = lines.map(l => `<tr><td>${esc(l.name)}</td><td class="n">+${l.give} XP</td><td class="up">${l.up ? esc(t("Xp.CanLevel")) : ""}</td></tr>`).join("");
  await ChatMessage.create({ speaker: { alias: t("Xp.AwardTitle") }, content: `<div class="pkh-xp-chat"><table><tbody>${body}</tbody></table></div>` });
  ui.notifications.info(`Rutz's HUD | ${t("Xp.Given", { n: lines.length })}`);
  return true;
}

/** The award window. `actors`: who is listed (default: the party); `give`: { actorId: XP } to fill in; `combat`: the Combat that just ended (null when opened by hand), passed to other modules' buttons. */
export function openAward({ actors = null, give = {}, note = "", combat = null } = {}) {
  if (!game.user.isGM) return null;
  const list = [...new Map((actors ?? partyPcs()).map(a => [a.id, game.actors.get(a.id) ?? a])).values()].filter(Boolean);
  if (!list.length) {
    ui.notifications.warn(`Rutz's HUD | ${t("Xp.NoActors")}`);
    return null;
  }
  awardRows = list.map(a => ({ id: a.id, include: true, give: Math.max(0, Math.round(Number(give?.[a.id]) || 0)) }));
  awardNote = note;
  awardButtons = collectAwardButtons(combat);
  if (award?.rendered) {
    award.render();
    award.bringToFront?.();
    return award;
  }
  award = new SimpleWindow({ id: `${MODULE_ID}-xp-award`, title: t("Xp.AwardTitle"), width: 460, html: awardHtml, onRender: wireAward, classes: ["pkh-fit"] });
  award.render({ force: true });
  return award;
}

/** API (game.pf2eKrHud.xp): the panel during a scored fight, else the award window. Also game.pf2eKrHud.xp.willAward(combat). */
export function openXp() {
  if (!game.user.isGM) return null;
  return game.combat?.started && enabled() ? openPanel() : openAward();
}
openXp.willAward = willAward;

/* combat start / end */

function onUpdateCombat(combat, changed) {
  if (foundry.utils.hasProperty(changed, `flags.${MODULE_ID}.${FLAG}`)) floatGains(combat);
  if ("turn" in changed || "round" in changed) perTurn.clear();
  refreshPanel();
  if (!isActiveGM() || !enabled() || !combat.started || combat !== game.combat) return;
  seedHp(combat);
  // The fight has just started (or the setting was turned on mid-fight): set it up and open the panel.
  if (!stored(combat) && !live.has(combat.id)) {
    working(combat);
    save(combat);
    openPanel();
  }
}

/** Does ending this combat open the award window here? `data`: its scoring (live copy or flag). */
function awards(combat, data) {
  if (!isActiveGM() || !enabled()) return false;
  return participantsOf(combat).length > 0 && (!!data || combat?.round > 0);
}

const decided = new Map();  // combat id → what onDeleteCombat decided (it drops the live copy; keep the answer)

/** API (game.pf2eKrHud.xp.willAward): true when deleting this combat opens (or has just opened) the award window on this client, whether asked before or after this module's own deleteCombat handler. */
export function willAward(combat) {
  if (!combat) return false;
  if (decided.has(combat.id)) return decided.get(combat.id);
  return awards(combat, live.get(combat.id) ?? stored(combat));
}

function onDeleteCombat(combat) {
  clearTimeout(timers.get(combat.id));
  timers.delete(combat.id);
  const data = live.get(combat.id) ?? stored(combat);
  const yes = awards(combat, data);
  decided.set(combat.id, yes);
  if (decided.size > 20) decided.delete(decided.keys().next().value);
  live.delete(combat.id);
  shown.delete(combat.id);
  lastHit.clear();
  if (panel?.rendered) panel.close();
  if (!yes) return;
  const pcs = participantsOf(combat);
  const sums = totals(data);
  // What is left under the cap, shared equally (경험치 기준 → 남은 캡 나누기).
  const ids = pcs.map(a => a.id);
  const extra = rules().share ? shareLeft({ cap: data?.cap ?? 0, ids, sums }) : {};
  const left = Object.values(extra).reduce((a, n) => a + n, 0);
  const note = left ? t("Xp.ShareNote", { left, per: Math.floor(left / ids.length) }) : "";
  openAward({ actors: pcs, give: Object.fromEntries(ids.map(id => [id, (sums[id] ?? 0) + (extra[id] ?? 0)])), note, combat });
}

export function registerXpSettings() {
  game.settings.register(MODULE_ID, "xpTracker", {
    name: "PKH.Settings.xpTracker.Name",
    hint: "PKH.Settings.xpTracker.Hint",
    scope: "world", config: true, type: Boolean, default: false,
    onChange: () => game.pf2eKrHud?.turns?.schedule?.()     // the turn tracker's XP button
  });
  // Edited in the panel (경험치 기준), not in the settings window. cap 0 = PF2e's XP for the encounter.
  game.settings.register(MODULE_ID, "xpRules", {
    scope: "world", config: false, type: Object, default: { ...DEFAULT_RULES },
    onChange: () => refreshPanel()
  });
}

export function initXp() {
  for (const combat of game.combats ?? []) shown.set(combat.id, totals(stored(combat)));
  if (game.user.isGM) seedHp(game.combat);
  Hooks.on("createCombat", combat => shown.set(combat.id, {}));
  Hooks.on("updateCombat", onUpdateCombat);
  Hooks.on("deleteCombat", onDeleteCombat);
  Hooks.on("createCombatant", combatant => { if (game.user.isGM) seedHp(combatant.combat); refreshPanel(); });
  Hooks.on("deleteCombatant", () => refreshPanel());
  Hooks.on("createChatMessage", onMessage);
  Hooks.on("updateActor", onUpdateActor);
  Hooks.on("createItem", onCreateItem);
}
