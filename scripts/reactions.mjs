import { MODULE_ID, SimpleWindow, esc, setting, t } from "./shared.mjs";
import { activeConditions } from "./economy.mjs";
import { canEditSlots } from "./slots.mjs";
import { contingencyConfig, fireContingency, hasContingency, openContingency } from "./contingency.mjs";
import {
  PRE_RULES, createApplyDamageWrapper, createDryRun, damageOptionList, finalDamageOptions, giveBack, guardianRollOptions,
  interceptable, liveTypes, lostByPath, originOptionsOf, patchMethod, preAmount, shieldFix, slugify
} from "./reaction-damage.mjs";

/*
 * Reaction checker.
 * - Detection runs on the active GM's client only, so each trigger fires once.
 * - The prompt is a chat card whispered to the actor's responders: a custom list per actor, else the players whose assigned character it is, plus every GM. NPCs only bother the GM.
 * - Use posts "X used Y" plus the Strike roll (or item card); decline posts a note, and the GM client closes the card.
 * - Reactions per round (1 + extras) are tracked and shown as "리액션 1/1".
 * - Triggers come from a built-in table and can be changed per reaction.
 * - PRE_RULES reactions (Shield Block, Intercept Attack, the champion's) are asked when the damage roll appears; the answer is a reservation folded into the real application (applyDamage wrapper). Damage already applied is fixed in place.
 */

// Getters: the labels are read when drawn (game.i18n is not ready at import time).
const TRIGGERS = {
  get move() { return t("Reactions.Trigger.move"); },
  get manipulate() { return t("Reactions.Trigger.manipulate"); },
  get targeted() { return t("Reactions.Trigger.targeted"); },
  get "crit-fail"() { return t("Reactions.Trigger.critFail"); },
  get damaged() { return t("Reactions.Trigger.damaged"); },
  get "ally-damaged"() { return t("Reactions.Trigger.allyDamaged"); },
  get save() { return t("Reactions.Trigger.save"); },
  get approach() { return t("Reactions.Trigger.approach"); },
  get "hp-low"() { return t("Reactions.Trigger.hpLow"); },
  get condition() { return t("Reactions.Trigger.condition"); }
};
// Triggers that need a parameter only Contingency sets (not offered in the per-reaction settings).
const PARAM_TRIGGERS = new Set(["hp-low", "condition"]);

const STRIKE = { strike: true };
const BUILTIN = {
  "reactive-strike": { triggers: ["move", "manipulate"], ...STRIKE },
  "attack-of-opportunity": { triggers: ["move", "manipulate"], ...STRIKE },
  "triple-opportunity": { triggers: ["move", "manipulate"], ...STRIKE },
  "stand-still": { triggers: ["move"], ...STRIKE },
  "no-escape": { triggers: ["move"] },
  "mage-hunter": { triggers: ["manipulate"], ...STRIKE },
  "implements-interruption": { triggers: ["manipulate"], ...STRIKE },
  "nimble-dodge": { triggers: ["targeted"] },
  "flashy-dodge": { triggers: ["targeted"] },
  "crane-flutter": { triggers: ["targeted"] },
  "reactive-shield": { triggers: ["targeted"] },
  "hit-the-dirt": { triggers: ["targeted"] },
  "hunters-defense": { triggers: ["targeted"] },
  "farabellus-flip": { triggers: ["targeted"] },
  "airy-step": { triggers: ["targeted"] },
  "opportune-riposte": { triggers: ["crit-fail"], ...STRIKE },
  "dueling-riposte": { triggers: ["crit-fail"], ...STRIKE },
  "twin-riposte": { triggers: ["crit-fail"], ...STRIKE },
  "reflexive-riposte": { triggers: ["crit-fail"], ...STRIKE },
  "shield-block": { triggers: ["damaged"], needShield: true, needPhysicalAttack: true },
  "quick-shield-block": { triggers: ["damaged"], needShield: true, needPhysicalAttack: true },
  "orc-ferocity": { triggers: ["damaged"] },
  "wounded-rage": { triggers: ["damaged"] },
  "fiery-retort": { triggers: ["damaged"] },
  "embrace-the-pain": { triggers: ["damaged"] },
  "sacrifice-armor": { triggers: ["damaged"] },
  "iron-command": { triggers: ["damaged"] },
  // ranges and amounts of these five + Intercept Attack: PRE_RULES (reaction-damage.mjs)
  "retributive-strike": { triggers: ["ally-damaged"], ...STRIKE },
  "glimpse-of-redemption": { triggers: ["ally-damaged"] },
  "liberating-step": { triggers: ["ally-damaged"] },
  "flash-of-grandeur": { triggers: ["ally-damaged"] },
  "intercept-attack": { triggers: ["ally-damaged"] },
  "selfish-shield": { triggers: ["damaged"] },
  "knights-retaliation": { triggers: ["ally-damaged"], range: 15, ...STRIKE },
  "charmed-life": { triggers: ["save"] }
};
// Asked early (when the damage roll appears): shield / redirect / resist.
for (const [slug, rule] of Object.entries(PRE_RULES)) BUILTIN[slug] = { ...BUILTIN[slug], ...rule, rule };
const NO_REACTING = ["unconscious", "paralyzed", "petrified", "stunned", "dying", "restrained"];

/* Who is asked, what counts, what is configured */

const baseOf = actor => (actor?.isToken ? game.actors.get(actor.id) ?? actor : actor);

export { reactionBudget };

export function respondersFor(actor) {
  const base = baseOf(actor);
  const custom = base?.getFlag(MODULE_ID, "reactionResponders");
  const players = Array.isArray(custom) && custom.length
    ? custom
    : game.users.filter(u => !u.isGM && u.character?.id === base?.id).map(u => u.id);
  return [...new Set([...players, ...game.users.filter(u => u.isGM).map(u => u.id)])];
}

function reactionItems(actor) {
  return (actor?.itemTypes?.action ?? []).concat(actor?.itemTypes?.feat ?? [])
    .filter(i => i.system?.actionType?.value === "reaction");
}

function configFor(actor, item) {
  const cont = contingencyConfig(item);
  if (cont) return cont;
  const custom = baseOf(actor)?.getFlag(MODULE_ID, "reactionConfig")?.[item.slug ?? item.id] ?? {};
  const builtin = BUILTIN[item.slug] ?? null;
  return {
    triggers: custom.triggers ?? builtin?.triggers ?? [],
    range: Number(custom.range) || builtin?.range || null,
    strike: custom.strike ?? builtin?.strike ?? false,
    needShield: builtin?.needShield ?? false,
    needPhysicalAttack: builtin?.needPhysicalAttack ?? false,
    pre: builtin?.pre ?? null,
    who: builtin?.who ?? null,
    rule: builtin?.rule ?? null,
    off: !!custom.off
  };
}

function reactionBudget(actor) {
  const base = baseOf(actor);
  const extra = Number(base?.getFlag(MODULE_ID, "extraReactions")) || 0;
  const max = 1 + extra;
  const use = actor?.getFlag(MODULE_ID, "reactionUse") ?? {};
  const key = game.combat?.started ? `${game.combat.id}` : "free";
  const used = use.key === key ? Number(use.used) || 0 : 0;
  return { max, used, left: Math.max(0, max - used), key };
}

/** HUD: set how many reactions this creature has used (click = use, right-click = give back). */
export async function setReactionUsed(actor, used) {
  const b = reactionBudget(actor);
  await actor.setFlag(MODULE_ID, "reactionUse", { key: b.key, used: Math.max(0, Math.min(b.max, used)) });
}

async function spendReaction(actor) {
  const b = reactionBudget(actor);
  await actor.setFlag(MODULE_ID, "reactionUse", { key: b.key, used: b.used + 1 });
}

/** An unspent reservation holds a reaction, so it cannot be promised twice. */
function canReact(actor, tokenUuid = null) {
  return !activeConditions(actor).some(c => NO_REACTING.includes(c.slug))
    && reactionBudget(actor).left - (tokenUuid ? heldCount(tokenUuid) : 0) > 0;
}

/* Geometry (PF2e 5/10 diagonals, edge to edge, any creature size) */

function rectOf(tokenDoc, pos = null) {
  const size = canvas.grid.size;
  const x = pos?.x ?? tokenDoc.x;
  const y = pos?.y ?? tokenDoc.y;
  return { x1: x, y1: y, x2: x + tokenDoc.width * size, y2: y + tokenDoc.height * size };
}

function distanceFt(a, b) {
  const size = canvas.grid.size;
  const dx = Math.max(0, Math.max(a.x1, b.x1) - Math.min(a.x2, b.x2)) / size;
  const dy = Math.max(0, Math.max(a.y1, b.y1) - Math.min(a.y2, b.y2)) / size;
  const hi = Math.round(Math.max(dx, dy));
  const lo = Math.round(Math.min(dx, dy));
  const unit = canvas.scene?.grid?.distance ?? 5;
  return (hi + Math.floor(lo / 2)) * unit + unit;
}

/** The distance a reaction watches for this trigger (Contingency: per trigger). */
const rangeFor = (cfg, kind, fallback) => cfg.rangeFor?.[kind] ?? cfg.range ?? fallback;

function reachOf(actor) {
  try {
    const r = actor?.getReach?.({ action: "attack" });
    if (Number.isFinite(r)) return r;
  } catch (_) { }
  return 5;
}

function hostile(a, b) {
  if (!a || !b || a === b) return false;
  if (typeof a.isAllyOf === "function") return !a.isAllyOf(b);
  return true;
}

/*
 * Detection (active GM only)
 * Hidden, dead and defeated tokens set nothing off; a movement is read once it has stopped; the same reactor is asked about the same mover once per turn; one event gives the GM ONE card listing every reactor, and each player a small card of their own.
 */

const lastPos = new Map();
const moving = new Map();      // mover token id → { from, timer }
const asked = new Set();       // `${turn}|${reactor}|${trigger}|${key}`

function isActiveGM() {
  return !!game.users.activeGM?.isSelf;
}

function turnStamp() {
  const c = game.combat;
  return c?.started ? `${c.id}.${c.round}.${c.turn}` : `free.${Math.floor(Date.now() / 60000)}`;
}

/** Out of play: hidden, at 0 HP, or marked defeated. */
function outOfPlay(tokenDoc) {
  if (!tokenDoc) return true;
  if (tokenDoc.hidden) return true;
  const actor = tokenDoc.actor;
  if (!actor) return true;
  const hp = actor.hitPoints ?? actor.system?.attributes?.hp;
  if (hp && Number(hp.max) > 0 && Number(hp.value) <= 0 && !actor.hasPlayerOwner) return true;
  const combatant = game.combat?.combatants?.find(c => c.tokenId === tokenDoc.id);
  return !!combatant?.defeated;
}

function candidates(trigger, test) {
  const out = [];
  for (const tokenDoc of canvas.scene?.tokens ?? []) {
    const actor = tokenDoc.actor;
    if (!actor || outOfPlay(tokenDoc)) continue;
    const items = reactionItems(actor).filter(item => {
      const cfg = configFor(actor, item);
      if (cfg.off || !cfg.triggers.includes(trigger)) return false;
      if (cfg.needShield && !actor.attributes?.shield?.raised && !actor.system?.attributes?.shield?.raised) return false;
      return test(tokenDoc, cfg, item);
    });
    if (items.length && canReact(actor, tokenDoc.uuid)) out.push({ tokenDoc, actor, items });
  }
  return out;
}

const gmIds = () => game.users.filter(u => u.isGM).map(u => u.id);

/*
 * the cards
 * GM: one card per turn ("반응 기회 — 3라운드 · 고블린의 턴"); every event adds rows to it and it is re-posted at the bottom, the old copy removed. Players: a small card (and pop-up) per row of their own.
 */

const randomId = () => foundry.utils.randomID?.() ?? Math.random().toString(36).slice(2, 12);

function eventLine(row) {
  return `${esc(TRIGGERS[row.trigger] ?? "")}${row.detail ? `: <b>${esc(row.detail)}</b>` : ""}`;
}

function rowHtml(row, i, { gm }) {
  const who = row.players.length ? row.players.map(id => game.users.get(id)?.name).filter(Boolean).join(", ") : "NPC";
  const body = row.state === "pending"
    ? `<div class="choices">${row.items.map(it => `<button type="button" data-rx-use="${it.id}" data-row="${i}"><img src="${esc(it.img)}" alt=""> ${esc(it.name)}</button>`).join("")}
        <button type="button" data-rx-skip="1" data-row="${i}" class="skip">${t("Reactions.Skip")}</button></div>`
    : `<p class="done">${{
      used: t("Reactions.State.Used", { choice: esc(row.choice) }),
      reserved: t("Reactions.State.Reserved", { choice: esc(row.choice) }),
      skipped: t("Reactions.State.Skipped"),
      spent: t("Reactions.State.Spent"),
      expired: t("Reactions.State.Expired")
    }[row.state] ?? ""}${row.by ? ` <small>(${esc(row.by)})</small>` : ""}</p>`;
  return `<div class="rx-row ${row.state}" data-row="${i}">
    <div class="rx-who"><img src="${esc(row.img)}" alt=""><b>${esc(row.name)}</b>${gm ? `<small>${esc(who)}</small>` : ""}<span class="budget">${t("Reactions.Budget", { left: row.left, max: row.max })}</span></div>
    ${body}</div>`;
}

function groupHtml(flag) {
  const pending = flag.rows.filter(r => r.state === "pending").length;
  let html = "";
  let last = null;
  flag.rows.forEach((r, i) => {
    const ev = `${r.trigger}|${r.key}|${r.detail}`;
    if (ev !== last) { html += `<p class="rx-event">${eventLine(r)}</p>`; last = ev; }
    html += rowHtml(r, i, { gm: true });
  });
  return `<div class="pkh-reaction group">
    <header><i class="fa-solid fa-bolt"></i> ${t("Reactions.Opportunity")} <small>${esc(flag.title ?? "")}${pending ? ` · ${t("Reactions.Pending", { n: pending })}` : ""}</small></header>
    ${html}</div>`;
}

function playerHtml(row) {
  return `<div class="pkh-reaction">
    <header><i class="fa-solid fa-bolt"></i> <strong>${esc(row.name)}</strong> — ${t("Reactions.Opportunity")}</header>
    <p>${eventLine(row)}</p>
    ${rowHtml(row, 0, { gm: false })}</div>`;
}

function turnTitle() {
  const c = game.combat;
  if (!c?.started) return "";
  const name = c.combatant?.token?.name ?? c.combatant?.name ?? "";
  return `${t("Reactions.TurnTitle.Round", { round: c.round })}${name ? ` · ${t("Reactions.TurnTitle.Turn", { name })}` : ""}`;
}

/** The GM card of a turn (the newest copy). */
function boardFor(turn) {
  const list = game.messages.contents;
  for (let i = list.length - 1, n = 0; i >= 0 && n < 400; i--, n++) {
    const flag = list[i].flags?.[MODULE_ID]?.reactionGroup;
    if (flag?.turn === turn) return list[i];
  }
  return null;
}

/* Everything that edits the GM card goes through one queue, since events can arrive together. */
let queue = Promise.resolve();
function serial(fn) {
  queue = queue.then(fn).catch(err => console.warn(`${MODULE_ID} | reactions`, err));
  return queue;
}

/** Post the turn's GM card again at the bottom with these rows (and drop the old copy). */
async function postBoard(turn, rows, old) {
  const flag = { turn, title: old?.flags?.[MODULE_ID]?.reactionGroup?.title || turnTitle(), rows };
  const msg = await ChatMessage.create({
    speaker: { alias: t("Reactions.Opportunity") },
    whisper: gmIds(),
    content: groupHtml(flag),
    flags: { [MODULE_ID]: { reactionGroup: flag } }
  });
  if (old) await old.delete().catch(() => null);
  return msg;
}

/** Something can be reacted to. `key` identifies the event so the same reactor is never asked twice about it. */
function prompt(found, trigger, detail, { key = "", extra = null } = {}) {
  if (!setting("reactionChecker", true) || (setting("reactionCombatOnly", true) && !game.combat?.started)) return;
  const stamp = turnStamp();
  const fresh = found.filter(({ tokenDoc }) => {
    const k = `${stamp}|${tokenDoc.id}|${trigger}|${key}`;
    if (asked.has(k)) return false;
    asked.add(k);
    return true;
  });
  if (asked.size > 2000) asked.clear();
  if (!fresh.length) return;
  return serial(async () => {
    const rows = fresh.map(({ tokenDoc, actor, items }) => {
      const budget = reactionBudget(actor);
      return {
        id: randomId(), trigger, detail, key, extra,
        tokenUuid: tokenDoc.uuid, name: tokenDoc.name, img: tokenDoc.texture?.src ?? actor.img,
        items: items.map(i => ({ id: i.id, name: i.name, img: i.img, slug: i.slug ?? "" })),
        players: respondersFor(actor).filter(id => !game.users.get(id)?.isGM),
        left: budget.left, max: budget.max, state: "pending", choice: null, by: null, card: null
      };
    });
    for (const row of rows) {
      if (!row.players.length) continue;
      const token = fromUuidSync(row.tokenUuid);
      const card = await ChatMessage.create({
        speaker: ChatMessage.getSpeaker({ token }),
        whisper: row.players,
        content: playerHtml(row),
        flags: { [MODULE_ID]: { reaction: { turn: stamp, rowId: row.id, tokenUuid: row.tokenUuid, responders: row.players, state: "pending", row: { ...row, card: null } } } }
      });
      row.card = card.id;
    }
    // By default only rows nobody else is asked about (NPCs) go on the GM's card; setting "reactionGmCopy" adds the players' rows.
    const onBoard = setting("reactionGmCopy", false) ? rows : rows.filter(r => !r.players.length);
    const old = boardFor(stamp);
    if (!onBoard.length) return;
    const before = old ? foundry.utils.deepClone(old.flags[MODULE_ID].reactionGroup.rows ?? []) : [];
    await postBoard(stamp, [...before, ...onBoard], old);
  });
}

/** Pending player cards of a turn (newest first), optionally only one creature's. */
function playerCards(turn, tokenUuid = null) {
  const out = [];
  const list = game.messages.contents;
  for (let i = list.length - 1, n = 0; i >= 0 && n < 400; i--, n++) {
    const f = list[i].flags?.[MODULE_ID]?.reaction;
    if (f?.turn === turn && f.state === "pending" && (!tokenUuid || f.tokenUuid === tokenUuid)) out.push(list[i]);
  }
  return out;
}

function storedRow(card, patch) {
  const f = card?.flags?.[MODULE_ID]?.reaction ?? {};
  const base = f.row ?? { name: fromUuidSync(f.tokenUuid)?.name ?? "", img: "", items: [], players: f.responders ?? [], left: 0, max: 1, trigger: "", detail: "" };
  return { ...base, ...patch };
}

function onPreUpdateToken(doc, changes) {
  if ("x" in changes || "y" in changes) lastPos.set(doc.id, { x: doc.x, y: doc.y });
}

/** Read a movement once the token has come to rest (a drag, or a path of waypoints, is one move). */
function onUpdateToken(doc, changes) {
  if (!isActiveGM() || !("x" in changes || "y" in changes)) return;
  const from = lastPos.get(doc.id);
  lastPos.delete(doc.id);
  if (!from || !doc.actor) return;
  const pending = moving.get(doc.id) ?? { from };
  clearTimeout(pending.timer);
  pending.timer = setTimeout(() => {
    moving.delete(doc.id);
    if (outOfPlay(doc)) return;
    const start = rectOf(doc, pending.from);
    const found = candidates("move", (reactor, cfg) =>
      reactor.id !== doc.id && hostile(reactor.actor, doc.actor)
      && distanceFt(rectOf(reactor), start) <= rangeFor(cfg, "move", reachOf(reactor.actor)));
    if (found.length) prompt(found, "move", doc.name, { key: doc.id });
    // Coming close: an enemy that ends its move within range, having started outside it.
    const end = rectOf(doc);
    const near = candidates("approach", (reactor, cfg) => {
      if (reactor.id === doc.id || !hostile(reactor.actor, doc.actor)) return false;
      const r = rangeFor(cfg, "approach", reachOf(reactor.actor));
      const here = rectOf(reactor);
      return distanceFt(here, end) <= r && distanceFt(here, start) > r;
    });
    if (near.length) prompt(near, "approach", doc.name, { key: `${doc.id}.approach` });
  }, 700);
  moving.set(doc.id, pending);
}

function tokenFromUuidOrId(ref) {
  if (!ref) return null;
  try {
    const doc = ref.includes?.(".") ? fromUuidSync(ref) : canvas.scene?.tokens.get(ref);
    return doc?.documentName === "Token" ? doc : doc?.document ?? null;
  } catch (_) {
    return null;
  }
}

/* what the damage was (Shield Block) */

const PHYSICAL = new Set(["bludgeoning", "piercing", "slashing"]);

/** Shield Block applies only to damage from an attack (Strike or attack roll) that includes bludgeoning, piercing or slashing: never persistent damage, basic-save spells or energy alone. Finds the damage roll that the "damage taken" message came from. */
function damageSource(taken) {
  const origin = taken.flags?.pf2e?.origin?.uuid ?? null;
  const list = game.messages.contents;
  for (let i = list.length - 1, n = 0; i >= 0 && n < 60; i--, n++) {
    const m = list[i];
    if (m.id === taken.id) continue;
    const ctx = m.flags?.pf2e?.context;
    if (ctx?.type !== "damage-roll") continue;
    if (origin && m.flags?.pf2e?.origin?.uuid !== origin) continue;
    return m;
  }
  return null;
}

function physicalAttack(source) {
  if (!source || source.getFlag?.(MODULE_ID, "shieldRepost")) return false;
  const ctx = source.flags?.pf2e?.context ?? {};
  const isAttack = ctx.sourceType === "attack" || (ctx.options ?? []).includes("attack");
  if (!isAttack) return false;
  const roll = source.rolls?.[0];
  const instances = roll?.instances ?? [];
  if (instances.length) return instances.some(inst => PHYSICAL.has(inst.type) && !inst.persistent);
  const types = source.flags?.pf2e?.damageRoll?.types ?? {};
  return Object.entries(types).some(([type, cats]) => PHYSICAL.has(type) && Object.keys(cats ?? {}).some(c => c !== "persistent"));
}

function onChatMessage(message) {
  const result = message.getFlag?.(MODULE_ID, "reactionResult");
  if (result && isActiveGM()) return closeResult(result, message);
  if (!isActiveGM()) return;
  const pf2e = message.flags?.pf2e ?? {};
  const ctx = pf2e.context;
  const sourceToken = message.speaker?.token ? canvas.scene?.tokens.get(message.speaker.token) : null;
  if (sourceToken?.hidden) return;

  // Attacks: targeted / critical failure / ranged attack within reach
  if (ctx && ["attack-roll", "spell-attack-roll"].includes(ctx.type)) {
    const target = tokenFromUuidOrId(ctx.target?.token ?? ctx.target?.tokenId);
    if (target) {
      const onlyTarget = (tok) => tok.id === target.id;
      const targeted = candidates("targeted", onlyTarget);
      if (targeted.length) prompt(targeted, "targeted", sourceToken?.name ?? "", { key: message.id });
      if (ctx.outcome === "criticalFailure") {
        const riposte = candidates("crit-fail", onlyTarget);
        if (riposte.length) prompt(riposte, "crit-fail", sourceToken?.name ?? "", { key: message.id });
      }
    }
    const ranged = (ctx.domains ?? []).includes("ranged-attack-roll") || (ctx.options ?? []).includes("item:ranged") || ctx.type === "spell-attack-roll";
    if (ranged && sourceToken) nearbyEnemies("manipulate", sourceToken, message.id);
  }

  // Casting a spell (manipulate) within someone's reach
  if (!ctx && pf2e.casting && sourceToken) nearbyEnemies("manipulate", sourceToken, message.id);

  // Saving throws
  if (ctx?.type === "saving-throw" && sourceToken) {
    const own = candidates("save", tok => tok.id === sourceToken.id);
    if (own.length) prompt(own, "save", "", { key: message.id });
  }

  // A damage roll: Shield Block, Intercept Attack, the champion's reactions are asked now (a reservation)
  if (ctx?.type === "damage-roll" && !message.getFlag?.(MODULE_ID, "shieldRepost")) {
    preAsk(message).catch(err => console.warn(`${MODULE_ID} | reactions: early ask`, err));
  }

  // Damage actually applied (PF2e posts a "damage taken" message for the target)
  const applied = pf2e.appliedDamage;
  if (applied && !applied.isHealing && !applied.isReverted && sourceToken) {
    const source = damageSource(message);
    const physical = physicalAttack(source);
    // Asked about at the damage roll already this turn: not again (the other reactions still are).
    const early = (preAsked.get(sourceToken.uuid) ?? []).some(e => e.stamp === turnStamp());
    const notPre = cfg => !(early && cfg.pre);
    const self = candidates("damaged", (tok, cfg) => notPre(cfg) && tok.id === sourceToken.id && (!cfg.needPhysicalAttack || physical));
    if (self.length) {
      prompt(self, "damaged", source?.flags?.pf2e?.origin ? (fromUuidSync(source.flags.pf2e.origin.uuid)?.name ?? "") : "", {
        key: message.id,
        extra: { takenId: message.id, sourceId: source?.id ?? null }
      });
    }
    const allies = candidates("ally-damaged", (tok, cfg) =>
      notPre(cfg) && tok.id !== sourceToken.id && !hostile(tok.actor, sourceToken.actor)
      && distanceFt(rectOf(tok), rectOf(sourceToken)) <= rangeFor(cfg, "ally-damaged", 15));
    if (allies.length) prompt(allies, "ally-damaged", sourceToken.name, { key: message.id, extra: { takenId: message.id, sourceId: source?.id ?? null } });
  }
}

/* asked at the damage roll (before anything is applied) */

const preAsked = new Map();    // target token uuid → [{ sourceId, stamp }] (active GM)
const dry = createDryRun({ randomId });
const redirected = new WeakSet();  // guardian clones taking redirected damage; the wrapper leaves them alone

/** The tokens a damage roll is for: PF2e's target, plus PF2e Toolbelt's target helper. */
function preTargets(message) {
  const refs = [message.flags?.pf2e?.context?.target?.token, ...(message.flags?.["pf2e-toolbelt"]?.targetHelper?.targets ?? [])];
  const out = new Map();
  for (const ref of refs) {
    const tok = typeof ref === "string" ? tokenFromUuidOrId(ref) : null;
    if (tok && tok.parent?.id === canvas.scene?.id) out.set(tok.uuid, tok);
  }
  return [...out.values()];
}

const hasFeat = (actor, slug) => (actor?.itemTypes?.feat ?? []).some(f => (f.slug || slugify(f.name)) === slug);
const levelOf = actor => Number(actor?.level ?? actor?.system?.details?.level?.value) || 0;

/** Who may hold up which early reaction for this target (cfg.pre set). */
function preFits(cfg, tok, target, info) {
  const range = rangeFor(cfg, cfg.who === "self" ? "damaged" : "ally-damaged", 15);
  if (cfg.who === "self") {
    if (tok.id !== target.id) return false;
    if (cfg.pre === "shield") return info.physical;
    if (!hostile(info.sourceActor, tok.actor)) return false;
    return !info.sourceToken || distanceFt(rectOf(tok), rectOf(info.sourceToken)) <= range;
  }
  if (tok.id === target.id || hostile(tok.actor, target.actor)) return false;
  if (distanceFt(rectOf(tok), rectOf(target)) > range) return false;
  if (cfg.pre === "redirect") return interceptable(info.types, { energy: hasFeat(tok.actor, "energy-interceptor") });
  if (cfg.pre === "resist") {
    if (!hostile(info.sourceActor, tok.actor)) return false;
    return !info.sourceToken || distanceFt(rectOf(tok), rectOf(info.sourceToken)) <= range;
  }
  return false;
}

async function preAsk(message) {
  if (!setting("reactionPreAsk", true) || !setting("reactionChecker", true)) return;
  if (setting("reactionCombatOnly", true) && !game.combat?.started) return;
  const targets = preTargets(message);
  if (!targets.length) return;
  const roll = message.rolls?.[0];
  const sourceToken = message.token ?? (message.speaker?.token ? canvas.scene?.tokens.get(message.speaker.token) : null);
  const info = {
    sourceActor: message.actor ?? sourceToken?.actor ?? null,
    sourceToken,
    physical: physicalAttack(message),
    types: liveTypes({ instances: roll?.instances ?? [], flagTypes: message.flags?.pf2e?.damageRoll?.types })
  };
  const from = sourceToken?.name ?? info.sourceActor?.name ?? "";
  for (const target of targets) {
    if (outOfPlay(target)) continue;
    const stamp = turnStamp();
    const list = (preAsked.get(target.uuid) ?? []).filter(e => e.stamp === stamp);
    list.push({ sourceId: message.id, stamp });
    preAsked.set(target.uuid, list);
    if (preAsked.size > 200) preAsked.delete(preAsked.keys().next().value);
    const would = await dryRunMessage(message, target);
    if (would === 0) continue;
    const detail = would === null
      ? t("Reactions.PreDetailRoll", { source: from, target: target.name, n: Number(roll?.total) || 0 })
      : t("Reactions.PreDetail", { source: from, target: target.name, n: would });
    const opts = { key: `pre.${message.id}.${target.id}`, extra: { pre: true, sourceId: message.id, targetUuid: target.uuid, would } };
    const self = candidates("damaged", (tok, cfg) => !!cfg.pre && preFits(cfg, tok, target, info));
    if (self.length) prompt(self, "damaged", detail, opts);
    const allies = candidates("ally-damaged", (tok, cfg) => !!cfg.pre && preFits(cfg, tok, target, info));
    if (allies.length) prompt(allies, "ally-damaged", detail, opts);
  }
}

/** The application PF2e's damage button makes for this token (applyDamageFromMessage, multiplier 1): the contextual clone and its roll options. No ephemeral effects. */
function messageApplication(message, tokenDoc) {
  const ctx = message.flags?.pf2e?.context ?? {};
  const actor = tokenDoc.actor;
  const sourceActor = message.actor ?? null;
  const alliance = actor.alliance && sourceActor ? (actor.alliance === sourceActor.alliance ? "ally" : "enemy") : null;
  const list = damageOptionList(ctx.options, { alliance, targetOptions: () => actor.getSelfRollOptions("target") });
  const origin = originOptionsOf(ctx.options);
  const item = message.item ?? null;
  const itemOptions = item?.isOfType?.("affliction", "condition", "effect") ? item.getRollOptions("item") : [];
  const clone = actor.getContextualClone(origin, []);
  const rollOptions = finalDamageOptions(list, itemOptions, origin, clone.getSelfRollOptions());
  return { clone, rollOptions, item, outcome: ctx.outcome ?? null, roll: message.rolls?.[0] ?? null };
}

/** HP this token would lose from this damage roll (null: can't tell). Changes nothing. */
async function dryRunMessage(message, tokenDoc) {
  try {
    if (!tokenDoc?.actor || !message.rolls?.[0]) return null;
    const { clone, rollOptions, item, outcome, roll } = messageApplication(message, tokenDoc);
    return await dry.run(clone, { damage: roll, token: tokenDoc, item, skipIWR: false, rollOptions, outcome });
  } catch (err) {
    console.warn(`${MODULE_ID} | reactions: dry run`, err);
    return null;
  }
}

function nearbyEnemies(trigger, sourceToken, key) {
  const found = candidates(trigger, (tok, cfg) =>
    tok.id !== sourceToken.id && hostile(tok.actor, sourceToken.actor)
    && distanceFt(rectOf(tok), rectOf(sourceToken)) <= rangeFor(cfg, trigger, reachOf(tok.actor)));
  if (found.length) prompt(found, trigger, sourceToken.name, { key });
}

/* HP falling low, a condition gained (Contingency) */

const lastHp = new Map();   // actor uuid → HP last seen (active GM)

function seedHp() {
  for (const tokenDoc of canvas?.scene?.tokens ?? []) {
    const hp = tokenDoc.actor?.system?.attributes?.hp;
    if (tokenDoc.actor && hp) lastHp.set(tokenDoc.actor.uuid, Number(hp.value) || 0);
  }
}

function onUpdateActorHp(actor, changes, options) {
  const value = foundry.utils.getProperty(changes, "system.attributes.hp.value");
  if (value === undefined || !actor) return;
  const now = Number(value) || 0;
  const before = lastHp.has(actor.uuid) ? lastHp.get(actor.uuid) : now + (Number(options?.damageTaken) || 0);
  lastHp.set(actor.uuid, now);
  if (!isActiveGM() || !(now < before)) return;
  const max = Number(actor.system?.attributes?.hp?.max) || 0;
  if (!max) return;
  for (const tokenDoc of actor.getActiveTokens?.(true, true) ?? []) {
    const found = candidates("hp-low", (tok, cfg) => {
      if (tok.id !== tokenDoc.id) return false;
      const line = max * (Number(cfg.hpPct) || 50) / 100;
      return before > line && now <= line;
    });
    if (found.length) prompt(found, "hp-low", `${now}/${max}`, { key: `${actor.uuid}.${now}` });
  }
}

function onConditionGained(item, _options, _userId) {
  if (!isActiveGM() || item?.type !== "condition" || !item.actor) return;
  const slug = item.system?.slug ?? item.slug;
  for (const tokenDoc of item.actor.getActiveTokens?.(true, true) ?? []) {
    const found = candidates("condition", (tok, cfg) => tok.id === tokenDoc.id && (cfg.conditions ?? []).includes(slug));
    if (found.length) prompt(found, "condition", item.name, { key: item.id });
  }
}

/* Answering (a player in their card, or the GM in the group card) */

/** Which turn, row and player card a button belongs to. */
function contextOf(message, rowIndex) {
  const single = message.getFlag(MODULE_ID, "reaction");
  if (single) return { turn: single.turn, rowId: single.rowId, cardId: message.id, tokenUuid: single.tokenUuid, responders: single.responders, extra: single.row?.extra ?? null };
  const group = message.getFlag(MODULE_ID, "reactionGroup");
  const row = group?.rows?.[rowIndex];
  if (!row) return null;
  return { turn: group.turn, rowId: row.id, cardId: row.card, tokenUuid: row.tokenUuid, responders: row.players, extra: row.extra ?? null };
}

async function useReaction(message, rowIndex, itemId, event) {
  const ctx = contextOf(message, rowIndex);
  const token = ctx?.tokenUuid ? fromUuidSync(ctx.tokenUuid) : null;
  const actor = token?.actor;
  const item = actor?.items.get(itemId);
  if (!item) return;
  const cfg = configFor(actor, item);
  const base = { ...ctx, choice: item.name, slug: item.slug ?? "", by: game.user.name };
  // Asked at the damage roll: a reservation, folded into the damage when it is applied.
  if (ctx.extra?.pre && cfg.pre) {
    const reserve = {
      kind: cfg.pre, sourceId: ctx.extra.sourceId ?? null, targetUuid: ctx.extra.targetUuid ?? null, reactorUuid: token.uuid,
      amount: cfg.pre === "resist" ? preAmount(cfg.rule, levelOf(actor)) : null, state: "open", spent: false
    };
    // Retributive Strike: the Strike is made now, so the reaction is spent now.
    if (cfg.strike) {
      try { await spendReaction(actor); reserve.spent = true; } catch (_) { }
    }
    await ChatMessage.create({
      speaker: ChatMessage.getSpeaker({ token }),
      content: `<div class="pkh-reaction used reserve"><i class="fa-solid fa-hourglass-half"></i> ${t("Reactions.Reserve.Msg", { token: esc(token.name), reaction: esc(item.name) })}</div>`,
      flags: { [MODULE_ID]: { reactionResult: { ...base, reserve } } }
    });
    if (cfg.strike) return rollReactionStrike(actor, event);
    if (cfg.pre === "shield") return;
    return item.toMessage?.(event);
  }
  // Spend first: the GM's client reads the count when it closes the other rows.
  try { await spendReaction(actor); } catch (_) { }
  // An early-kind reaction after the damage is in: the GM's client fixes it in place.
  const fix = cfg.pre && ctx.extra?.takenId ? { kind: cfg.pre, amount: cfg.pre === "resist" ? preAmount(cfg.rule, levelOf(actor)) : null } : null;
  await ChatMessage.create({
    speaker: ChatMessage.getSpeaker({ token }),
    content: `<div class="pkh-reaction used"><i class="fa-solid fa-bolt"></i> ${t("Reactions.UsedMsg", { token: esc(token.name), reaction: esc(item.name) })}</div>`,
    flags: { [MODULE_ID]: { reactionResult: { ...base, ...(fix ? { fix } : {}) } } }
  });
  if (item.flags?.[MODULE_ID]?.contingency) return fireContingency(actor, item, { spent: true, event });
  if (cfg.pre === "shield") return;
  if (cfg.strike) return rollReactionStrike(actor, event);
  return item.toMessage?.(event);
}

/** The Strike the reaction makes: one melee strike → roll it; several → choose. */
async function rollReactionStrike(actor, event) {
  const strikes = (actor.system?.actions ?? []).filter(s => s?.ready !== false && s?.variants?.length
    && !(s.item?.isRanged ?? (s.item?.system?.range ?? 0) > 0));
  if (!strikes.length) return ui.notifications.warn(`Rutz's HUD | ${t("Reactions.NoMelee")}`);
  if (strikes.length === 1) return strikes[0].variants[0].roll({ event });
  const choice = await foundry.applications.api.DialogV2.wait({
    window: { title: t("Reactions.StrikeTitle") },
    content: `<p>${t("Reactions.StrikeQuestion")}</p>`,
    buttons: strikes.map((s, i) => ({ action: String(i), label: s.label, default: i === 0 })),
    rejectClose: false
  }).catch(() => null);
  if (choice !== null && choice !== undefined && strikes[Number(choice)]) return strikes[Number(choice)].variants[0].roll({ event });
}

async function declineReaction(message, rowIndex) {
  const ctx = contextOf(message, rowIndex);
  const token = ctx?.tokenUuid ? fromUuidSync(ctx.tokenUuid) : null;
  await ChatMessage.create({
    speaker: ChatMessage.getSpeaker({ token }),
    whisper: [...new Set([...(ctx?.responders ?? []), ...gmIds()])],
    content: `<div class="pkh-reaction skipped"><i class="fa-regular fa-circle-xmark"></i> ${t("Reactions.Declined", { name: esc(token?.name ?? "") })}</div>`,
    flags: { [MODULE_ID]: { reactionResult: { ...ctx, choice: null, by: game.user.name } } }
  });
}

const OPEN_ROW = new Set(["pending", "reserved"]);

async function closePlayerCard(cardId, row) {
  const card = cardId ? game.messages.get(cardId) : null;
  const flag = card?.getFlag(MODULE_ID, "reaction");
  if (!card || !OPEN_ROW.has(flag?.state)) return;
  await card.update({ content: playerHtml(row), [`flags.${MODULE_ID}.reaction.state`]: row.state });
}

// A reservation nobody's damage used is dropped after this long (out of combat no turn change closes it).
const RESERVE_TTL = 10 * 60 * 1000;
const freshReserve = msg => Date.now() - (Number(msg?.timestamp) || 0) <= RESERVE_TTL;

/** Reactions this creature has promised (reservations not used up yet, reaction not yet spent). */
function heldCount(tokenUuid) {
  let n = 0;
  const list = game.messages?.contents ?? [];
  for (let i = list.length - 1, k = 0; i >= 0 && k < 200; i--, k++) {
    const res = list[i].flags?.[MODULE_ID]?.reactionResult?.reserve;
    if (res?.state === "open" && !res.spent && res.reactorUuid === tokenUuid && freshReserve(list[i])) n++;
  }
  return n;
}

const leftFor = (tokenUuid, actor) => (actor ? Math.max(0, reactionBudget(actor).left - heldCount(tokenUuid)) : 0);

/** GM: close the answered row (GM card and player card), and the creature's other open rows when it has no reaction left. A reservation counts as used here and is spent when used. */
function closeResult(result, message = null) {
  return serial(async () => {
    const { turn, rowId, choice } = result;
    const reserving = !!(choice && result.reserve?.state === "open");
    const state = !choice ? "skipped" : reserving ? "reserved" : "used";
    const board = turn ? boardFor(turn) : null;
    const gflag = board?.getFlag(MODULE_ID, "reactionGroup");
    const rows = foundry.utils.deepClone(gflag?.rows ?? []);
    const row = rows.find(r => r.id === rowId);
    // Answered twice (two clicks): the second reservation must not hold or spend anything.
    const lapse = () => (reserving && message ? finishReservationNow(message.id, "lapsed") : null);
    if (!row) {
      const card = result.cardId ? game.messages.get(result.cardId) : null;
      if (reserving && card && card.getFlag(MODULE_ID, "reaction")?.state !== "pending") return lapse();
      await closePlayerCard(result.cardId, storedRow(card, { state, choice: choice ?? null, by: result.by ?? null }));
      // Out of reactions: this creature's other open cards this turn close too.
      const actor = choice ? fromUuidSync(result.tokenUuid)?.actor : null;
      if (actor && leftFor(result.tokenUuid, actor) <= 0) {
        for (const other of playerCards(turn, result.tokenUuid)) {
          if (other.id !== result.cardId) await closePlayerCard(other.id, storedRow(other, { state: "spent", left: 0 }));
        }
      }
    } else {
      if (row.state !== "pending") return lapse();
      Object.assign(row, { state, choice: choice ?? null, by: result.by ?? null });
      const touched = [row];
      if (choice) {
        const actor = fromUuidSync(row.tokenUuid)?.actor;
        const left = leftFor(row.tokenUuid, actor);
        for (const other of rows) {
          if (other === row || other.tokenUuid !== row.tokenUuid || other.state !== "pending") continue;
          other.left = left;
          if (left <= 0) { other.state = "spent"; touched.push(other); }
        }
      }
      await board.update({ content: groupHtml({ ...gflag, rows }), [`flags.${MODULE_ID}.reactionGroup.rows`]: rows });
      for (const r of touched) await closePlayerCard(r.card, r);
    }
    if (reserving && message) await settleLate(message, result);
    else if (choice && result.fix && result.extra?.takenId) {
      await inPlaceFix({
        taken: game.messages.get(result.extra.takenId), kind: result.fix.kind, amount: result.fix.amount,
        reactorUuid: result.tokenUuid, sourceId: result.extra.sourceId ?? null, reaction: choice
      });
    }
  });
}

/** Set a row (GM card and player card) that is still open or reserved. */
async function setRowState(result, patch) {
  const board = result.turn ? boardFor(result.turn) : null;
  const gflag = board?.getFlag(MODULE_ID, "reactionGroup");
  const rows = foundry.utils.deepClone(gflag?.rows ?? []);
  const row = rows.find(r => r.id === result.rowId);
  if (row && OPEN_ROW.has(row.state)) {
    Object.assign(row, patch);
    await board.update({ content: groupHtml({ ...gflag, rows }), [`flags.${MODULE_ID}.reactionGroup.rows`]: rows });
    await closePlayerCard(row.card, row);
    return;
  }
  const card = result.cardId ? game.messages.get(result.cardId) : null;
  if (card) await closePlayerCard(card.id, storedRow(card, patch));
}

const NOTE = {
  shield: () => "",
  resist: info => t("Reactions.Reserve.Resist", { n: info?.amount ?? 0 }),
  redirect: info => t("Reactions.Reserve.Redirect", { name: info?.guardian ?? "" })
};

/**
 * GM: a reservation is over. outcome "used": the reaction is spent (unless it was already);
 * "expired" (no damage) / "lapsed" (the turn passed): the reaction stays.
 */
async function finishReservationNow(id, outcome, info = {}) {
  const msg = game.messages.get(id);
  const result = msg?.getFlag(MODULE_ID, "reactionResult");
  const res = result?.reserve;
  if (!res || res.state !== "open") return;
  const token = fromUuidSync(res.reactorUuid);
  const actor = token?.actor;
  const names = { token: esc(token?.name ?? ""), reaction: esc(result.choice ?? "") };
  let content;
  if (outcome === "used") {
    if (!res.spent && actor) { try { await spendReaction(actor); } catch (err) { console.warn(`${MODULE_ID} | reactions: spend`, err); } }
    const note = NOTE[res.kind]?.({ amount: res.amount, guardian: token?.name, ...info }) ?? "";
    content = `<div class="pkh-reaction used"><i class="fa-solid fa-bolt"></i> ${t("Reactions.UsedMsg", names)}${note ? ` <small>(${esc(note)})</small>` : ""}</div>`;
  } else {
    content = `<div class="pkh-reaction skipped"><i class="fa-regular fa-circle-xmark"></i> ${t(outcome === "lapsed" ? "Reactions.Reserve.Lapsed" : "Reactions.Reserve.Unused", names)}</div>`;
  }
  await msg.update({
    content,
    [`flags.${MODULE_ID}.reactionResult.reserve.state`]: outcome === "used" ? "done" : "expired",
    [`flags.${MODULE_ID}.reactionResult.reserve.spent`]: outcome === "used" || !!res.spent
  });
  const left = actor ? leftFor(res.reactorUuid, actor) : 0;
  await setRowState(result, { state: outcome === "used" ? "used" : "expired", choice: result.choice ?? null, by: result.by ?? null, left });
}

/** GM: what other screens report from the applyDamage wrapper. */
function onReserveReport(results = []) {
  return serial(async () => {
    for (const r of results ?? []) if (r?.id) await finishReservationNow(r.id, r.outcome === "used" ? "used" : "expired", r);
  });
}

/* the damage was already in: fix it in place */

const messageIndex = msg => (msg ? game.messages.contents.indexOf(msg) : -1);

/** The "damage taken" message for this target from this damage roll, posted before `before` (the reservation); later damage went through the wrapper instead. */
function appliedBefore(sourceId, targetUuid, before) {
  const list = game.messages.contents;
  const end = messageIndex(before);
  const start = sourceId ? list.findIndex(m => m.id === sourceId) : -1;
  if (end < 0 || start < 0) return null;
  const target = tokenFromUuidOrId(targetUuid);
  const origin = list[start].flags?.pf2e?.origin?.uuid ?? null;
  for (let i = end - 1; i > start; i--) {
    const m = list[i];
    const applied = m.flags?.pf2e?.appliedDamage;
    if (!applied || applied.isHealing || applied.isReverted || m.speaker?.token !== target?.id) continue;
    // The nearest damage roll before it, from the same origin, must be this one.
    let src = null;
    for (let j = i - 1; j >= start; j--) {
      const c = list[j];
      if (c.flags?.pf2e?.context?.type !== "damage-roll") continue;
      if (origin && c.flags?.pf2e?.origin?.uuid !== origin) continue;
      src = c;
      break;
    }
    if (!src || src.id === sourceId) return m;
  }
  return null;
}

/** GM: a reservation answered after the damage went in: fix it now instead. */
async function settleLate(message, result) {
  const res = result.reserve;
  const taken = appliedBefore(res.sourceId, res.targetUuid, message);
  if (!taken) return;
  const ok = await inPlaceFix({ taken, kind: res.kind, amount: res.amount, reactorUuid: res.reactorUuid, sourceId: res.sourceId, reaction: result.choice });
  await finishReservationNow(message.id, ok ? "used" : "lapsed");
}

async function restoreHp(actor, give) {
  const hp = actor.system?.attributes?.hp ?? {};
  const updates = {};
  if (give.hp) updates["system.attributes.hp.value"] = Math.min(Number(hp.max) || Infinity, (Number(hp.value) || 0) + give.hp);
  if (give.sp) updates["system.attributes.hp.sp.value"] = Math.min(Number(hp.sp?.max) || Infinity, (Number(hp.sp?.value) || 0) + give.sp);
  if (give.temp) updates["system.attributes.hp.temp"] = (Number(hp.temp) || 0) + give.temp;
  if (Object.keys(updates).length) await actor.update(updates);
}

/** The guardian takes `damage` (a DamageRoll or a number) with its own IWR; the wrapper leaves it alone. */
async function guardianApply(guardianToken, { damage, item = null, rollOptions = [], origin = [], outcome = null, ...rest }) {
  const clone = guardianToken.actor.getContextualClone(origin, []);
  redirected.add(clone);
  return clone.applyDamage({
    ...rest, damage, item, outcome, token: guardianToken,
    rollOptions: guardianRollOptions(rollOptions, clone.getSelfRollOptions()),
    skipIWR: false, shieldBlockRequest: false
  });
}

/** GM, damage already applied (`appliedDamage` on the "damage taken" message): no revert. shield: hardness given back, the shield takes the rest; resist: `amount` given back; redirect: all given back, the guardian takes the damage roll. One public line says what was done. The caller spends the reaction. True when something was done. */
async function inPlaceFix({ taken, kind, amount = 0, reactorUuid, sourceId = null, reaction = "" }) {
  const applied = taken?.flags?.pf2e?.appliedDamage;
  const reactor = tokenFromUuidOrId(reactorUuid);
  const say = async (html, ok = true) => {
    await ChatMessage.create({
      speaker: ChatMessage.getSpeaker({ token: reactor }),
      content: `<div class="pkh-reaction ${ok ? "used" : "skipped"}"><i class="fa-solid fa-bolt"></i> ${html}</div>`
    });
    return ok;
  };
  const label = esc(reaction);
  if (!applied || applied.isHealing || applied.isReverted) return say(t("Reactions.Fix.Nothing", { reaction: label }), false);
  const actor = fromUuidSync(applied.uuid) ?? tokenFromUuidOrId(taken.speaker?.token)?.actor;
  if (!actor) return false;
  const lost = lostByPath(applied.updates);
  const loss = lost.hp + lost.sp + lost.temp;
  if (loss <= 0) return say(t("Reactions.Fix.Nothing", { reaction: label }), false);
  const parts = [];
  try {
    if (kind === "shield") {
      const s = actor.attributes?.shield ?? actor.system?.attributes?.shield;
      if (!s?.itemId || !s.raised || s.broken || s.destroyed) return say(t("Reactions.Fix.NoShield", { reaction: label }), false);
      const { absorb, shieldDamage } = shieldFix({ loss, hardness: s.hardness, shieldHp: s.hp?.value });
      const give = giveBack(lost, absorb);
      await restoreHp(actor, give);
      parts.push(t("Reactions.Fix.Back", { reaction: label, n: give.total }));
      const item = actor.items?.get(s.itemId);
      if (item && shieldDamage > 0) {
        const now = Number(item._source?.system?.hp?.value ?? item.system?.hp?.value) || 0;
        await item.update({ "system.hp.value": Math.max(0, now - shieldDamage) });
        parts.push(t("Reactions.Fix.Shield", { n: shieldDamage }));
      }
    } else if (kind === "resist") {
      const give = giveBack(lost, Math.min(Number(amount) || 0, loss));
      await restoreHp(actor, give);
      parts.push(t("Reactions.Fix.Back", { reaction: label, n: give.total }));
    } else if (kind === "redirect") {
      if (!reactor?.actor) return false;
      const give = giveBack(lost, loss);
      await restoreHp(actor, give);
      parts.push(t("Reactions.Fix.Back", { reaction: label, n: give.total }));
      const source = (sourceId ? game.messages.get(sourceId) : null) ?? damageSource(taken);
      if (source?.rolls?.[0]) {
        const { rollOptions, item, outcome, roll } = messageApplication(source, reactor);
        await guardianApply(reactor, { damage: roll, item, rollOptions, origin: originOptionsOf(source.flags?.pf2e?.context?.options), outcome });
      } else {
        await guardianApply(reactor, { damage: loss });
      }
      parts.push(t("Reactions.Fix.Moved", { name: esc(reactor.name) }));
    } else return false;
  } catch (err) {
    console.warn(`${MODULE_ID} | reactions: in-place fix`, err);
    ui.notifications.warn(`Rutz's HUD | ${t("Reactions.Fix.Failed")}`);
    return false;
  }
  const hp = Number(actor.system?.attributes?.hp?.value);
  const dying = activeConditions(actor).some(c => c.slug === "dying");
  if (dying || (Number.isFinite(hp) && hp <= 0)) parts.push(t("Reactions.Fix.Dying"));
  return say(parts.join(", "));
}

/** GM: a new turn — what nobody answered in the last one is closed. */
function expireTurn(turn) {
  return serial(async () => {
    const board = turn ? boardFor(turn) : null;
    const gflag = board?.getFlag(MODULE_ID, "reactionGroup");
    if (gflag?.rows?.some(r => r.state === "pending")) {
      const rows = foundry.utils.deepClone(gflag.rows);
      const touched = [];
      for (const r of rows) if (r.state === "pending") { r.state = "expired"; touched.push(r); }
      await board.update({ content: groupHtml({ ...gflag, rows }), [`flags.${MODULE_ID}.reactionGroup.rows`]: rows });
      for (const r of touched) await closePlayerCard(r.card, r);
    }
    // Players' cards that never went on the GM card.
    if (turn) for (const card of playerCards(turn)) await closePlayerCard(card.id, storedRow(card, { state: "expired" }));
    // Reservations nobody's damage used: closed, the reaction stays.
    if (turn) {
      const list = game.messages.contents;
      const open = [];
      for (let i = list.length - 1, n = 0; i >= 0 && n < 400; i--, n++) {
        const r = list[i].flags?.[MODULE_ID]?.reactionResult;
        if (r?.turn === turn && r.reserve?.state === "open") open.push(list[i].id);
      }
      for (const id of open) await finishReservationNow(id, "lapsed");
    }
  });
}

/* applyDamage (every client): reservations folded into the real application */

const consumed = new Set();        // reservation message ids this client has folded in (until the GM marks them)

function openReservations(tokenUuid) {
  const out = [];
  const list = game.messages?.contents ?? [];
  for (let i = list.length - 1, n = 0; i >= 0 && n < 80; i--, n++) {
    const res = list[i].flags?.[MODULE_ID]?.reactionResult?.reserve;
    if (res?.state === "open" && res.targetUuid === tokenUuid && !consumed.has(list[i].id) && freshReserve(list[i])) {
      out.push({ id: list[i].id, kind: res.kind, amount: res.amount, reactorUuid: res.reactorUuid, spent: !!res.spent });
    }
  }
  return out;
}

/** PF2e's Resistance class (not exported): taken from a prepared actor, else from an in-memory NPC. */
let ResistanceClass;
function resistanceClass() {
  if (ResistanceClass !== undefined) return ResistanceClass;
  const valid = r => (r && typeof r === "object" && r.constructor !== Object && "value" in r ? r.constructor : null);
  try {
    for (const a of [...(game.actors ?? []), ...(canvas?.scene?.tokens ?? []).map(t => t.actor)]) {
      const c = valid(a?.attributes?.resistances?.[0]);
      if (c) return (ResistanceClass = c);
    }
    const tmp = new CONFIG.Actor.documentClass({ name: "pkh", type: "npc", system: { attributes: { resistances: [{ type: "all-damage", value: 1 }] } } });
    ResistanceClass = valid(tmp.attributes?.resistances?.[0]);
  } catch (err) {
    console.warn(`${MODULE_ID} | reactions: no Resistance class`, err);
    ResistanceClass = null;
  }
  return ResistanceClass;
}

function addResistance(actor, args, amount) {
  if (!(amount > 0)) return null;
  const R = game.pf2e?.settings?.iwr === false ? null : resistanceClass();
  const list = actor.attributes?.resistances;
  if (R && Array.isArray(list)) {
    const r = new R({ type: "all-damage", value: amount });
    list.push(r);
    return () => { const i = list.indexOf(r); if (i >= 0) list.splice(i, 1); };
  }
  // No Resistance to hand (or IWR off): take it off the damage itself.
  if (typeof args.damage === "number") args.damage = Math.max(0, args.damage - amount);
  else if (typeof args.damage?.alter === "function") args.damage = args.damage.alter(1, -amount);
  return null;
}

function shieldUsable(actor) {
  const s = actor.attributes?.shield;
  return !!(s?.itemId && s.raised && !s.broken && !s.destroyed);
}

const canModify = actor => (typeof actor?.canUserModify === "function" ? actor.canUserModify(game.user, "update") : !!actor?.isOwner);

/** The guardian takes it: here when this screen may change the guardian, else on the GM's. */
async function redirectTo(_actor, args, res) {
  const gTok = tokenFromUuidOrId(res.reactorUuid);
  if (!gTok?.actor) return false;
  const rollOptions = [...(args.rollOptions ?? [])];
  const origin = rollOptions.filter(o => o.startsWith("origin:"));
  if (canModify(gTok.actor)) {
    await guardianApply(gTok, { ...args, rollOptions, origin });
    return true;
  }
  if (!game.users.activeGM) return false;
  game.socket.emit(SOCKET, {
    action: "reactionRedirect", guardianUuid: gTok.uuid, rollOptions, origin, outcome: args.outcome ?? null,
    itemUuid: args.item?.uuid ?? null,
    damage: typeof args.damage === "number" ? args.damage : args.damage?.toJSON?.() ?? null
  });
  return true;
}

async function onRedirectRequest(p) {
  const gTok = tokenFromUuidOrId(p.guardianUuid);
  if (!gTok?.actor || p.damage === null || p.damage === undefined) return;
  const damage = typeof p.damage === "number" ? p.damage : (foundry.dice?.Roll ?? Roll).fromData(p.damage);
  const item = p.itemUuid ? fromUuidSync(p.itemUuid) : null;
  await guardianApply(gTok, { damage, item, rollOptions: p.rollOptions ?? [], origin: p.origin ?? [], outcome: p.outcome ?? null });
}

function reportReservations(results) {
  if (!results?.length) return;
  if (isActiveGM()) onReserveReport(results);
  else game.socket?.emit(SOCKET, { action: "reactionReserve", results });
}

const SOCKET = `module.${MODULE_ID}`;

function onSocket(payload) {
  if (!isActiveGM()) return;
  if (payload?.action === "reactionReserve") onReserveReport(payload.results);
  else if (payload?.action === "reactionRedirect") onRedirectRequest(payload).catch(err => console.warn(`${MODULE_ID} | reactions: redirect`, err));
}

const damageWrapper = createApplyDamageWrapper({
  isDryRun: args => dry.isMarked(args.rollOptions),
  isRedirected: actor => redirected.has(actor),
  findOpen: openReservations,
  claim: ids => ids.forEach(id => consumed.add(id)),
  unclaim: ids => ids.forEach(id => consumed.delete(id)),
  dryRun: (actor, args) => dry.run(actor.clone({}, { keepId: true }), args),
  shieldUsable,
  addResistance,
  redirect: redirectTo,
  report: reportReservations,
  log: err => console.warn(`${MODULE_ID} | reactions: applyDamage`, err)
});

let wrapperInstalled = false;
function installDamageWrapper() {
  if (wrapperInstalled) return;
  wrapperInstalled = true;
  const classes = CONFIG.PF2E?.Actor?.documentClasses ?? {};
  for (const type of ["character", "npc", "familiar"]) {
    const proto = classes[type]?.prototype;
    if (typeof proto?.applyDamage !== "function") continue;
    if (globalThis.libWrapper) {
      try {
        libWrapper.register(MODULE_ID, `CONFIG.PF2E.Actor.documentClasses.${type}.prototype.applyDamage`, function (wrapped, args) {
          return damageWrapper.call(this, wrapped, args);
        }, "MIXED");
        continue;
      } catch (err) { console.warn(`${MODULE_ID} | libWrapper applyDamage (${type})`, err); }
    }
    patchMethod(proto, "applyDamage", damageWrapper);
  }
}

/** The dry run's "damage taken" message is never created. */
export function initReactionDryRun() {
  Hooks.on("preCreateChatMessage", doc => dry.cancel(doc));
}

function wireCard(message, html) {
  const root = html instanceof HTMLElement ? html : html?.[0];
  const single = message.getFlag?.(MODULE_ID, "reaction");
  const group = message.getFlag?.(MODULE_ID, "reactionGroup");
  if (!root || (!single && !group)) return;
  const allowed = single ? (single.responders?.includes(game.user.id) || game.user.isGM) && single.state === "pending" : game.user.isGM;
  for (const btn of root.querySelectorAll("[data-rx-use], [data-rx-skip]")) {
    const rowIndex = Number(btn.dataset.row) || 0;
    const rowState = group ? group.rows?.[rowIndex]?.state : single?.state;
    if (!allowed || rowState !== "pending") { btn.disabled = true; continue; }
    btn.addEventListener("click", ev => {
      root.querySelectorAll(`[data-rx-use][data-row="${rowIndex}"], [data-rx-skip][data-row="${rowIndex}"]`).forEach(b => (b.disabled = true));
      if (btn.dataset.rxSkip) return declineReaction(message, rowIndex);
      return useReaction(message, rowIndex, btn.dataset.rxUse, ev);
    });
  }
}

/** Optional pop-up: players for their own card; the GM (setting) for the turn's card. */
function popup(message) {
  const single = message.getFlag?.(MODULE_ID, "reaction");
  const group = message.getFlag?.(MODULE_ID, "reactionGroup");
  if (!setting("reactionPopup", true)) return;
  if (single && (single.state !== "pending" || !single.responders?.includes(game.user.id))) return;
  if (group && (!game.user.isGM || !setting("reactionPopupGM", false) || !group.rows?.some(r => r.state === "pending"))) return;
  if (!single && !group) return;
  // The GM card is re-posted for every new event: one pop-up for it, not a pile.
  if (group) document.querySelectorAll(".pkh-reaction-pop.gm").forEach(e => e.remove());
  document.querySelectorAll(`.pkh-reaction-pop[data-message="${message.id}"]`).forEach(e => e.remove());
  const el = document.createElement("section");
  el.className = `pkh-reaction-pop${group ? " gm" : ""}`;
  el.dataset.message = message.id;
  el.innerHTML = message.content;
  document.body.appendChild(el);
  wireCard(message, el);
  el.addEventListener("click", ev => { if (ev.target.closest("button") && single) setTimeout(() => el.remove(), 200); });
  setTimeout(() => el.remove(), 30000);
}

/* Per-actor settings (responders, extra reactions, triggers per reaction) */

export function openReactionConfig(actor) {
  actor ??= canvas?.tokens?.controlled?.[0]?.actor ?? game.pf2eKrHud?.hud?.actor;
  if (!actor) return ui.notifications.warn(`Rutz's HUD | ${t("Notify.SelectToken")}`);
  if (!canEditSlots(actor)) return ui.notifications.warn(`Rutz's HUD | ${t("Reactions.NoPermission")}`);
  const base = baseOf(actor);
  const items = reactionItems(actor).filter(i => !i.flags?.[MODULE_ID]?.contingency);
  const responders = base.getFlag(MODULE_ID, "reactionResponders") ?? [];
  const users = game.users.filter(u => !u.isGM);
  const row = item => {
    const cfg = configFor(actor, item);
    const auto = BUILTIN[item.slug] ? ` (${t("Reactions.Config.Auto")})` : "";
    return `<div class="pkh-rx-row" data-key="${esc(item.slug ?? item.id)}">
      <img src="${esc(item.img)}" alt=""><b>${esc(item.name)}</b><small>${auto}</small>
      <label><input type="checkbox" name="off" ${cfg.off ? "" : "checked"}> ${t("Reactions.Config.Notify")}</label>
      <select name="trigger" multiple size="3">${Object.entries(TRIGGERS).filter(([k]) => !PARAM_TRIGGERS.has(k)).map(([k, l]) =>
        `<option value="${k}" ${cfg.triggers.includes(k) ? "selected" : ""}>${l}</option>`).join("")}</select>
      <label>${t("Reactions.Config.Range")} <input type="number" name="range" value="${cfg.range ?? ""}" placeholder="${t("Reactions.Config.Reach")}" style="width:56px">${t("Reactions.Config.Feet")}</label>
      <label><input type="checkbox" name="strike" ${cfg.strike ? "checked" : ""}> ${t("Reactions.Config.Strike")}</label>
    </div>`;
  };
  new SimpleWindow({
    title: t("Reactions.Config.Title", { name: actor.name }), width: 640, classes: ["pkh-fit"],
    html: `<div class="pkh-rx-config"><div class="pkh-rx-body">
      <h3>${t("Reactions.Config.Who")}</h3>
      <p class="pkh-pick-hint">${t("Reactions.Config.WhoHint")}</p>
      <div class="users">${users.map(u => `<label><input type="checkbox" value="${u.id}" ${responders.includes(u.id) ? "checked" : ""}> ${esc(u.name)}</label>`).join("")}</div>
      <p>${t("Reactions.Config.Extra")} <input type="number" name="extra" min="0" max="5" value="${Number(base.getFlag(MODULE_ID, "extraReactions")) || 0}" style="width:50px"> ${t("Reactions.Config.ExtraSuffix")}</p>
      ${hasContingency(actor) ? `<p><button type="button" data-act="contingency"><i class="fa-solid fa-hourglass-half"></i> ${t("Reactions.Config.Contingency")}</button></p>` : ""}
      <h3>${t("Reactions.Config.PerReaction")}</h3>
      <p class="pkh-pick-hint">${t("Reactions.Config.PerHint")}</p>
      ${items.map(row).join("") || `<p>${t("Reactions.Config.None")}</p>`}
      </div>
      <div class="pkh-seat-buttons"><button type="button" data-act="save" class="primary"><i class="fa-solid fa-check"></i> ${t("Common.Save")}</button></div>
    </div>`,
    onRender: (root, app) => (root.querySelector("[data-act=contingency]")?.addEventListener("click", () => openContingency(actor)), root.querySelector("[data-act=save]"))?.addEventListener("click", async () => {
      const config = {};
      for (const r of root.querySelectorAll(".pkh-rx-row")) {
        config[r.dataset.key] = {
          off: !r.querySelector("[name=off]").checked,
          triggers: [...r.querySelector("[name=trigger]").selectedOptions].map(o => o.value),
          range: Number(r.querySelector("[name=range]").value) || null,
          strike: r.querySelector("[name=strike]").checked
        };
      }
      await base.update({
        [`flags.${MODULE_ID}.reactionConfig`]: config,
        [`flags.${MODULE_ID}.reactionResponders`]: [...root.querySelectorAll(".users input:checked")].map(i => i.value),
        [`flags.${MODULE_ID}.extraReactions`]: Number(root.querySelector("[name=extra]").value) || 0
      });
      ui.notifications.info(`Rutz's HUD | ${t("Reactions.Config.Saved")}`);
      app.close();
    })
  }).render({ force: true });
}

/** Settings-window entry: opens the per-character reaction settings (selected token, else the HUD's character). */
class ReactionConfigMenu extends foundry.applications.api.ApplicationV2 {
  render() {
    openReactionConfig();
    return this;
  }
}

export function registerReactionSettings() {
  const s = (key, data) => game.settings.register(MODULE_ID, key, data);
  game.settings.registerMenu(MODULE_ID, "reactionConfigMenu", {
    name: "PKH.Settings.reactionConfigMenu.Name", label: "PKH.Settings.reactionConfigMenu.Label",
    hint: "PKH.Settings.reactionConfigMenu.Hint",
    icon: "fa-solid fa-reply", type: ReactionConfigMenu, restricted: false
  });
  s("reactionChecker", { name: "PKH.Settings.reactionChecker.Name", hint: "PKH.Settings.reactionChecker.Hint", scope: "world", config: true, type: Boolean, default: true });
  s("reactionCombatOnly", { name: "PKH.Settings.reactionCombatOnly.Name", scope: "world", config: true, type: Boolean, default: true });
  s("reactionPopup", { name: "PKH.Settings.reactionPopup.Name", hint: "PKH.Settings.reactionPopup.Hint", scope: "client", config: true, type: Boolean, default: true });
  s("reactionGmCopy", { name: "PKH.Settings.reactionGmCopy.Name", hint: "PKH.Settings.reactionGmCopy.Hint", scope: "world", config: true, type: Boolean, default: false });
  s("reactionPopupGM", { name: "PKH.Settings.reactionPopupGM.Name", hint: "PKH.Settings.reactionPopupGM.Hint", scope: "client", config: true, type: Boolean, default: false });
  s("reactionPreAsk", { name: "PKH.Settings.reactionPreAsk.Name", hint: "PKH.Settings.reactionPreAsk.Hint", scope: "world", config: true, type: Boolean, default: true });
}

export function initReactions() {
  Hooks.on("preUpdateToken", onPreUpdateToken);
  Hooks.on("updateToken", onUpdateToken);
  Hooks.on("createChatMessage", message => { onChatMessage(message); popup(message); });
  Hooks.on("renderChatMessageHTML", wireCard);
  Hooks.on("updateActor", onUpdateActorHp);
  Hooks.on("createItem", onConditionGained);
  Hooks.on("canvasReady", seedHp);
  if (canvas?.ready) seedHp();
  game.socket?.on(SOCKET, onSocket);
  try { installDamageWrapper(); } catch (err) { console.warn(`${MODULE_ID} | reactions: applyDamage wrapper`, err); }
  // A creature's reactions come back at the start of its turn. Open questions stay answerable through the next turn, then close.
  const recent = game.combat?.started ? [turnStamp()] : [];
  Hooks.on("updateCombat", (combat, changed) => {
    if (!isActiveGM() || !("turn" in changed || "round" in changed)) return;
    if (recent.at(-1) !== turnStamp()) recent.push(turnStamp());
    while (recent.length > 2) expireTurn(recent.shift());
    const actor = combat.combatant?.actor;
    if (actor?.getFlag(MODULE_ID, "reactionUse")) actor.unsetFlag(MODULE_ID, "reactionUse");
  });
  game.pf2eKrHud = { ...(game.pf2eKrHud ?? {}), openReactionConfig };
}
