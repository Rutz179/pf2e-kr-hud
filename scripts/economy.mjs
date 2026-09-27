import { MODULE_ID } from "./shared.mjs";

/*
 * Where the action pips and the MAP counter get their numbers from.
 *
 * 1) pf2e-auto-action-tracker is active → read its combatant log. It wraps
 *    PF2e's cast/use code, so it can tell a real spell cast from a card that
 *    was only posted to chat to ask about it. Exact.
 *
 * 2) Otherwise a deliberately conservative built-in counter reads chat since
 *    the start of the actor's turn and counts only unambiguous rolls:
 *      - Strike attack rolls ........................ 1 action, MAP +1
 *      - Spell attack rolls ......................... MAP +1 (cast not counted)
 *      - Skill/perception checks made by an action .. that action's cost
 *    Spell and feat cards are NOT counted, because posting one to chat is
 *    exactly how players ask "can I do this?" at the table.
 *
 * On top of either source the owner can nudge the count by hand (pip clicks,
 * rollback). Nudges are keyed to the current turn and vanish with it.
 */

const TRACKER = "pf2e-auto-action-tracker";

export function trackerActive() {
  return !!game.modules.get(TRACKER)?.active;
}

export function turnKey(combat = game.combat) {
  return combat?.started ? `${combat.id}.${combat.round}.${combat.turn}` : "free";
}

export function combatantFor(actor, combat = game.combat) {
  if (!combat?.started || !actor) return null;
  return combat.combatants.find(c => c.actor?.uuid === actor.uuid) ?? null;
}

function isActorsTurn(actor, combat = game.combat) {
  return !!combat?.started && combat.combatant?.actor?.uuid === actor?.uuid;
}

/* ---------------- tracker reading ---------------- */

function trackerCost(entry) {
  if (typeof entry?.cost === "number") return entry.cost;
  if (entry?.slug === "quickened-casting") return 0;
  if (entry?.slug === "force-barrage") {
    const missiles = (entry.linkedMessages ?? []).filter(m => m.type === "damage").length;
    if (!missiles) return 1;
    const per = 1 + Math.floor(((entry.rank || 1) - 1) / 2);
    return Math.ceil(missiles / per);
  }
  return Number(entry?.baseCost) || 0;
}

function fromTracker(combatant) {
  const log = combatant?.getFlag(TRACKER, "log") ?? [];
  // The tracker stores its own total (it knows dynamic costs like Force
  // Barrage and Quickened Casting); fall back to summing the log if absent.
  const spent = Number(combatant?.getFlag(TRACKER, "actionsSpent"));
  const used = Number.isFinite(spent) ? spent
    : log.filter(e => e?.type !== "reaction").reduce((sum, e) => sum + Math.max(0, trackerCost(e)), 0);
  const attacks = log.filter(e => e?.isMapRelevant === true && e?.type !== "reaction"
    && !(e.actionModifiers ?? []).includes("deferMAP")).length;
  const quickened = !!combatant?.getFlag(TRACKER, "isQuickenedSnapshot");
  return { used, attacks, quickened, source: "tracker" };
}

/* ---------------- built-in chat reading ---------------- */

function messageIsFrom(message, actor) {
  const sp = message.speaker ?? {};
  if (actor.isToken) return !!sp.token && sp.token === actor.token?.id;
  return sp.actor === actor.id;
}

function hasAttackTrait(ctx) {
  const traits = (ctx?.traits ?? []).map(t => t?.name ?? t);
  return traits.includes("attack") || (ctx?.options ?? []).includes("trait:attack");
}

function builtinEntry(message) {
  // Marked by us as a real use: a spell cast from the sheet's 캐스트 button or
  // anything fired from a quickslot. (Cards merely posted to chat stay unmarked.)
  const used = message.flags?.[MODULE_ID]?.used;
  if (used) return { cost: Number(used.cost) || 0, map: false };
  // An action or feat that has an action cost, posted to chat (its card or [사용]), counts.
  const origin = message.flags?.pf2e?.origin;
  if (!message.flags?.pf2e?.context && ["action", "feat"].includes(origin?.type)) {
    const cost = itemActionCost(message.item);
    if (cost > 0) return { cost, map: false };
  }
  const ctx = message.flags?.pf2e?.context;
  if (!ctx || ctx.isReroll) return null;
  if (ctx.type === "attack-roll") return { cost: 1, map: true };
  if (ctx.type === "spell-attack-roll") return { cost: 0, map: true };
  if (["skill-check", "perception-check", "check"].includes(ctx.type)) {
    const slug = ctx.action ?? (ctx.options ?? []).find(o => o.startsWith("action:"))?.split(":")[1];
    if (!slug) return null;
    const raw = game.pf2e?.actions?.get?.(slug)?.cost;
    const cost = Number.isFinite(Number(raw)) ? Number(raw) : raw ? 0 : 1; // "free"/"reaction" → 0
    return { cost, map: hasAttackTrait(ctx) };
  }
  return null;
}

function fromChat(actor) {
  const combat = game.combat;
  const start = combat?.getFlag(MODULE_ID, "turnStart");
  if (!start || start.key !== turnKey(combat)) return { used: 0, attacks: 0, quickened: false, source: "chat" };

  let used = 0;
  let attacks = 0;
  const messages = game.messages.contents;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if ((m.timestamp ?? 0) < start.time) break;
    if (!messageIsFrom(m, actor)) continue;
    const entry = builtinEntry(m);
    if (!entry) continue;
    used += entry.cost;
    if (entry.map) attacks += 1;
  }
  return { used, attacks, quickened: false, source: "chat" };
}

/* ---------------- public ---------------- */

/**
 * Conditions granted "in memory" (Haste grants Quickened this way) never become
 * real items, so actor.itemTypes.condition misses them. actor.conditions has both.
 */
export function activeConditions(actor) {
  const all = actor?.conditions;
  const list = all?.active ?? (all ? [...all] : actor?.itemTypes?.condition ?? []);
  return list.filter(c => c && c.active !== false);
}

function conditionValue(actor, slug) {
  const c = activeConditions(actor).find(x => x.slug === slug);
  return c ? Number(c.value ?? 1) : 0;
}

/**
 * Everything the HUD needs for the pips and for MAP:
 *   { max, used, attacks, quickened, slowed, source, manual, inTurn }
 */
export function economyOf(actor) {
  const combat = game.combat;
  const inTurn = isActorsTurn(actor, combat);
  const combatant = combatantFor(actor, combat);

  let auto = { used: 0, attacks: 0, quickened: false, source: "manual" };
  if (combatant && trackerActive()) auto = fromTracker(combatant);
  else if (inTurn) auto = fromChat(actor);

  const stored = actor?.getFlag(MODULE_ID, "ap") ?? {};
  const current = stored.key === turnKey(combat);
  const manual = current ? Number(stored.delta) || 0 : 0;
  const bonusGranted = current && stored.bonus === true;

  const quickened = auto.quickened || conditionValue(actor, "quickened") > 0 || bonusGranted;
  // The tracker already books slowed/stunned as "system" drains in actionsSpent.
  const slowed = auto.source === "tracker" ? 0 : conditionValue(actor, "slowed") + conditionValue(actor, "stunned");

  return {
    max: 3 + (quickened ? 1 : 0),
    used: Math.max(0, auto.used + manual),
    attacks: auto.attacks,
    quickened,
    bonusGranted,
    slowed: Math.min(3, slowed),
    source: auto.source,
    manual,
    inTurn
  };
}

function storedAp(actor) {
  const stored = actor?.getFlag(MODULE_ID, "ap") ?? {};
  return stored.key === turnKey() ? { ...stored } : { key: turnKey(), delta: 0, bonus: false };
}

/** Set the displayed "used" count by adjusting this turn's manual nudge. */
export async function setUsed(actor, target) {
  const eco = economyOf(actor);
  const ap = storedAp(actor);
  ap.delta = eco.manual + (Math.max(0, target) - eco.used);
  await actor.setFlag(MODULE_ID, "ap", ap);
}

/** GM / owner: grant or take back the extra (4th) action for this turn. */
export async function toggleBonus(actor) {
  const ap = storedAp(actor);
  ap.bonus = !ap.bonus;
  await actor.setFlag(MODULE_ID, "ap", ap);
}

/** Console helper: why do the pips show what they show? */
export function debugEconomy(actor) {
  const combatant = combatantFor(actor);
  const info = {
    actor: actor?.name, tracker: trackerActive(), combatStarted: !!game.combat?.started,
    combatant: combatant?.name ?? null,
    trackerFlags: combatant?.flags?.[TRACKER] ?? null,
    turnStart: game.combat?.getFlag(MODULE_ID, "turnStart") ?? null,
    economy: economyOf(actor)
  };
  console.log(`${MODULE_ID} | economy`, info);
  return info;
}

export async function rollbackOne(actor) {
  const eco = economyOf(actor);
  if (eco.used <= 0) return;
  await setUsed(actor, eco.used - 1);
}

/** GM side: remember when each turn started so chat can be counted from there. */
export function registerEconomyHooks(onChange) {
  const stamp = async combat => {
    if (!game.users.activeGM?.isSelf || !combat?.started) return;
    await combat.setFlag(MODULE_ID, "turnStart", { key: turnKey(combat), time: Date.now() });
  };
  Hooks.on("combatStart", combat => stamp(combat));
  Hooks.on("updateCombat", (combat, changed) => {
    if ("turn" in changed || "round" in changed) stamp(combat);
    onChange();
  });
  Hooks.on("updateCombatant", onChange);
  Hooks.on("deleteCombat", onChange);
  Hooks.on("createChatMessage", onChange);
  Hooks.on("deleteChatMessage", onChange);
}

/* ------------------------------------------------------------------------ *
 * Marking real uses (used by the built-in counter when the tracker is off)
 * ------------------------------------------------------------------------ */

let pendingUse = null;

/** Action cost of a spell/action item: "1"/"2"/"3" → n, reaction/free → 0. */
export function itemActionCost(item) {
  if (!item) return 0;
  if (item.type === "spell") {
    const n = parseInt(String(item.system?.time?.value ?? ""), 10);
    return Number.isFinite(n) ? n : 0;
  }
  const type = item.system?.actionType?.value;
  if (type === "action") return Number(item.system?.actions?.value) || 1;
  return 0;
}

/** The next chat card this client creates for `actor` counts as a use costing `cost`. */
export function markNextUse(actor, cost) {
  pendingUse = { actor: actor?.id ?? null, token: actor?.token?.id ?? null, cost: Number(cost) || 0, at: Date.now() };
}

export function registerUseMarking() {
  Hooks.on("preCreateChatMessage", (message, data, options, userId) => {
    if (userId !== game.user.id || !pendingUse) return;
    if (Date.now() - pendingUse.at > 4000) {
      pendingUse = null;
      return;
    }
    const sp = message.speaker ?? {};
    const matches = pendingUse.token ? sp.token === pendingUse.token : sp.actor === pendingUse.actor;
    if (!matches) return;
    message.updateSource({ [`flags.${MODULE_ID}.used`]: { cost: pendingUse.cost } });
    pendingUse = null;
  });

  // The sheet's 캐스트 button goes through SpellcastingEntry#cast.
  const proto = CONFIG.PF2E?.Item?.documentClasses?.spellcastingEntry?.prototype;
  if (proto && typeof proto.cast === "function" && !proto.cast.pkhWrapped) {
    const original = proto.cast;
    proto.cast = function pkhMarkedCast(spell, ...args) {
      try { markNextUse(this.actor, itemActionCost(spell)); } catch (_) { /* never block a cast */ }
      return original.call(this, spell, ...args);
    };
    proto.cast.pkhWrapped = true;
  }
}
