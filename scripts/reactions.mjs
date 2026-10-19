import { MODULE_ID, SimpleWindow, esc, setting } from "./shared.mjs";
import { activeConditions } from "./economy.mjs";
import { canEditSlots } from "./slots.mjs";

/*
 * Reaction checker (replaces pf2e-reaction + socketlib).
 *
 *  - Detection runs on the active GM's client only, so each trigger fires once.
 *  - The prompt is a chat card whispered to the actor's RESPONDERS only:
 *      custom list (per actor)  →  else players whose *assigned character* it is
 *      →  plus every GM. NPCs therefore only bother the GM.
 *  - Use: public message "X used Y" + the Strike roll (or the item card).
 *    Decline: a note to GM/responders. The GM client then closes the card.
 *  - Reactions per round (1 + extras) are tracked and shown as "리액션 1/1".
 *  - Triggers come from a built-in table and can be changed per reaction.
 */

const TRIGGERS = {
  move: "간격 안의 적이 이동",
  manipulate: "간격 안의 적이 원거리 공격·조작 행동·주문",
  targeted: "내가 공격 대상이 됨",
  "crit-fail": "나를 향한 적의 공격이 대실패",
  damaged: "내가 피해를 받음",
  "ally-damaged": "범위 안 아군이 피해를 받음",
  save: "내가 내성 굴림을 함"
};

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
  "retributive-strike": { triggers: ["ally-damaged"], range: 15, ...STRIKE },
  "glimpse-of-redemption": { triggers: ["ally-damaged"], range: 15 },
  "liberating-step": { triggers: ["ally-damaged"], range: 15 },
  "intercept-attack": { triggers: ["ally-damaged"], range: 10 },
  "selfish-shield": { triggers: ["ally-damaged"], range: 15 },
  "knights-retaliation": { triggers: ["ally-damaged"], range: 15, ...STRIKE },
  "charmed-life": { triggers: ["save"] }
};
const NO_REACTING = ["unconscious", "paralyzed", "petrified", "stunned", "dying", "restrained"];

/* ------------------------------------------------------------------------ *
 * Who is asked, what counts, what is configured
 * ------------------------------------------------------------------------ */

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
  const custom = baseOf(actor)?.getFlag(MODULE_ID, "reactionConfig")?.[item.slug ?? item.id] ?? {};
  const builtin = BUILTIN[item.slug] ?? null;
  return {
    triggers: custom.triggers ?? builtin?.triggers ?? [],
    range: Number(custom.range) || builtin?.range || null,
    strike: custom.strike ?? builtin?.strike ?? false,
    needShield: builtin?.needShield ?? false,
    needPhysicalAttack: builtin?.needPhysicalAttack ?? false,
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

function canReact(actor) {
  return !activeConditions(actor).some(c => NO_REACTING.includes(c.slug)) && reactionBudget(actor).left > 0;
}

/* ------------------------------------------------------------------------ *
 * Geometry (PF2e 5/10 diagonals, edge to edge, any creature size)
 * ------------------------------------------------------------------------ */

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
  return (hi + Math.floor(lo / 2)) * unit + unit; // adjacent squares = one unit apart
}

function reachOf(actor) {
  try {
    const r = actor?.getReach?.({ action: "attack" });
    if (Number.isFinite(r)) return r;
  } catch (_) { /* older PF2e */ }
  return 5;
}

function hostile(a, b) {
  if (!a || !b || a === b) return false;
  if (typeof a.isAllyOf === "function") return !a.isAllyOf(b);
  return true;
}

/* ------------------------------------------------------------------------ *
 * Detection (active GM only)
 *
 * Less noise:
 *  - hidden tokens (not yet revealed, or dead and hidden) never set anything
 *    off, and dead or defeated creatures neither;
 *  - a token's movement is read once it has stopped (one drag = one check);
 *  - the same reactor is asked about the same mover once per turn;
 *  - everything one event sets off goes to the GM as ONE card listing every
 *    reactor; each player still gets a small card of their own.
 * ------------------------------------------------------------------------ */

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
    if (items.length && canReact(actor)) out.push({ tokenDoc, actor, items });
  }
  return out;
}

const gmIds = () => game.users.filter(u => u.isGM).map(u => u.id);

/* ---------------- the cards ---------------- *
 * GM: ONE card per turn ("반응 기회 — 3라운드 · 고블린의 턴"). Every event in
 * that turn adds its rows to it; the card is posted again at the bottom so the
 * newest is always in view, and the old copy goes. Players: a small card (and
 * pop-up) per row of their own.
 */

const randomId = () => foundry.utils.randomID?.() ?? Math.random().toString(36).slice(2, 12);

function eventLine(row) {
  return `${esc(TRIGGERS[row.trigger] ?? "")}${row.detail ? `: <b>${esc(row.detail)}</b>` : ""}`;
}

function rowHtml(row, i, { gm }) {
  const who = row.players.length ? row.players.map(id => game.users.get(id)?.name).filter(Boolean).join(", ") : "NPC";
  const body = row.state === "pending"
    ? `<div class="choices">${row.items.map(it => `<button type="button" data-rx-use="${it.id}" data-row="${i}"><img src="${esc(it.img)}" alt=""> ${esc(it.name)}</button>`).join("")}
        <button type="button" data-rx-skip="1" data-row="${i}" class="skip">반응 안 함</button></div>`
    : `<p class="done">${{
      used: `✔ <b>${esc(row.choice)}</b> 사용`,
      skipped: "✖ 반응하지 않음",
      spent: "— 남은 리액션 없음",
      expired: "— 턴이 지나감"
    }[row.state] ?? ""}${row.by ? ` <small>(${esc(row.by)})</small>` : ""}</p>`;
  return `<div class="rx-row ${row.state}" data-row="${i}">
    <div class="rx-who"><img src="${esc(row.img)}" alt=""><b>${esc(row.name)}</b>${gm ? `<small>${esc(who)}</small>` : ""}<span class="budget">리액션 ${row.left}/${row.max}</span></div>
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
    <header><i class="fa-solid fa-bolt"></i> 반응 기회 <small>${esc(flag.title ?? "")}${pending ? ` · 대기 ${pending}` : ""}</small></header>
    ${html}</div>`;
}

function playerHtml(row) {
  return `<div class="pkh-reaction">
    <header><i class="fa-solid fa-bolt"></i> <strong>${esc(row.name)}</strong> — 반응 기회</header>
    <p>${eventLine(row)}</p>
    ${rowHtml(row, 0, { gm: false })}</div>`;
}

function turnTitle() {
  const c = game.combat;
  if (!c?.started) return "";
  const name = c.combatant?.token?.name ?? c.combatant?.name ?? "";
  return `${c.round}라운드${name ? ` · ${name}의 턴` : ""}`;
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

/* Everything that edits the GM card goes through one queue: events can arrive together. */
let queue = Promise.resolve();
function serial(fn) {
  queue = queue.then(fn).catch(err => console.warn(`${MODULE_ID} | reactions`, err));
  return queue;
}

/** Post the turn's GM card again at the bottom with these rows (and drop the old copy). */
async function postBoard(turn, rows, old) {
  const flag = { turn, title: old?.flags?.[MODULE_ID]?.reactionGroup?.title || turnTitle(), rows };
  const msg = await ChatMessage.create({
    speaker: { alias: "반응 기회" },
    whisper: gmIds(),
    content: groupHtml(flag),
    flags: { [MODULE_ID]: { reactionGroup: flag } }
  });
  if (old) await old.delete().catch(() => null);
  return msg;
}

/**
 * Something can be reacted to. `key` identifies the event so the same reactor
 * is never asked twice about it.
 */
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
        flags: { [MODULE_ID]: { reaction: { turn: stamp, rowId: row.id, tokenUuid: row.tokenUuid, responders: row.players, state: "pending" } } }
      });
      row.card = card.id;
    }
    const old = boardFor(stamp);
    const before = old ? foundry.utils.deepClone(old.flags[MODULE_ID].reactionGroup.rows ?? []) : [];
    await postBoard(stamp, [...before, ...rows], old);
  });
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
    if (outOfPlay(doc)) return;                  // hidden or dead: sets nothing off
    const start = rectOf(doc, pending.from);
    const found = candidates("move", (reactor, cfg) =>
      reactor.id !== doc.id && hostile(reactor.actor, doc.actor)
      && distanceFt(rectOf(reactor), start) <= (cfg.range ?? reachOf(reactor.actor)));
    if (found.length) prompt(found, "move", doc.name, { key: doc.id });
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

/* ---------------- what the damage was (Shield Block) ---------------- */

const PHYSICAL = new Set(["bludgeoning", "piercing", "slashing"]);

/**
 * Shield Block (Player Core): "Trigger: While you have your shield raised,
 * you would take damage from a physical attack." So only damage from an
 * attack (a Strike or another attack roll) that includes bludgeoning,
 * piercing or slashing damage — never persistent damage, never a basic save
 * spell, never energy damage alone.
 * Finds the damage roll that the "damage taken" message came from.
 */
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
  if (result && isActiveGM()) return closeResult(result);
  if (!isActiveGM()) return;
  const pf2e = message.flags?.pf2e ?? {};
  const ctx = pf2e.context;
  const sourceToken = message.speaker?.token ? canvas.scene?.tokens.get(message.speaker.token) : null;
  if (sourceToken?.hidden) return;                 // a hidden token's actions set nothing off

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

  // Damage actually applied (PF2e posts a "damage taken" message for the target)
  const applied = pf2e.appliedDamage;
  if (applied && !applied.isHealing && !applied.isReverted && sourceToken) {
    const source = damageSource(message);
    const physical = physicalAttack(source);
    const self = candidates("damaged", (tok, cfg) => tok.id === sourceToken.id && (!cfg.needPhysicalAttack || physical));
    if (self.length) {
      prompt(self, "damaged", source?.flags?.pf2e?.origin ? (fromUuidSync(source.flags.pf2e.origin.uuid)?.name ?? "") : "", {
        key: message.id,
        extra: { takenId: message.id, sourceId: source?.id ?? null }
      });
    }
    const allies = candidates("ally-damaged", (tok, cfg) =>
      tok.id !== sourceToken.id && !hostile(tok.actor, sourceToken.actor)
      && distanceFt(rectOf(tok), rectOf(sourceToken)) <= (cfg.range ?? 15));
    if (allies.length) prompt(allies, "ally-damaged", sourceToken.name, { key: message.id });
  }
}

function nearbyEnemies(trigger, sourceToken, key) {
  const found = candidates(trigger, (tok, cfg) =>
    tok.id !== sourceToken.id && hostile(tok.actor, sourceToken.actor)
    && distanceFt(rectOf(tok), rectOf(sourceToken)) <= (cfg.range ?? reachOf(tok.actor)));
  if (found.length) prompt(found, trigger, sourceToken.name, { key });
}

/* ------------------------------------------------------------------------ *
 * Answering (a player in their card, or the GM in the group card)
 * ------------------------------------------------------------------------ */

const SHIELD_BLOCKS = new Set(["shield-block", "quick-shield-block"]);

/** Which turn, row and player card a button belongs to. */
function contextOf(message, rowIndex) {
  const single = message.getFlag(MODULE_ID, "reaction");
  if (single) return { turn: single.turn, rowId: single.rowId, cardId: message.id, tokenUuid: single.tokenUuid, responders: single.responders };
  const group = message.getFlag(MODULE_ID, "reactionGroup");
  const row = group?.rows?.[rowIndex];
  if (!row) return null;
  return { turn: group.turn, rowId: row.id, cardId: row.card, tokenUuid: row.tokenUuid, responders: row.players };
}

async function useReaction(message, rowIndex, itemId, event) {
  const ctx = contextOf(message, rowIndex);
  const token = ctx?.tokenUuid ? fromUuidSync(ctx.tokenUuid) : null;
  const actor = token?.actor;
  const item = actor?.items.get(itemId);
  if (!item) return;
  const cfg = configFor(actor, item);
  // Spend first: the GM's client reads the count when it closes the other rows.
  try { await spendReaction(actor); } catch (_) { /* responder without ownership: the GM's count still resets each turn */ }
  await ChatMessage.create({
    speaker: ChatMessage.getSpeaker({ token }),
    content: `<div class="pkh-reaction used"><i class="fa-solid fa-bolt"></i> <b>${esc(token.name)}</b>이(가) 반응 <b>${esc(item.name)}</b>을(를) 사용했습니다.</div>`,
    flags: { [MODULE_ID]: { reactionResult: { ...ctx, choice: item.name, slug: item.slug ?? "", by: game.user.name } } }
  });
  if (SHIELD_BLOCKS.has(item.slug)) return;        // the GM's client takes the damage back and re-posts it
  if (cfg.strike) return rollReactionStrike(actor, event);
  return item.toMessage?.(event);
}

/** The Strike the reaction makes: one melee strike → roll it; several → choose. */
async function rollReactionStrike(actor, event) {
  const strikes = (actor.system?.actions ?? []).filter(s => s?.ready !== false && s?.variants?.length
    && !(s.item?.isRanged ?? (s.item?.system?.range ?? 0) > 0));
  if (!strikes.length) return ui.notifications.warn("PF2e-KR HUD | 반응으로 휘두를 근접 무기가 없습니다.");
  if (strikes.length === 1) return strikes[0].variants[0].roll({ event });
  const choice = await foundry.applications.api.DialogV2.wait({
    window: { title: "반응 공격 — 무기 선택" },
    content: "<p>어떤 무기로 공격할까요?</p>",
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
    content: `<div class="pkh-reaction skipped"><i class="fa-regular fa-circle-xmark"></i> ${esc(token?.name ?? "")}: 반응하지 않음</div>`,
    flags: { [MODULE_ID]: { reactionResult: { ...ctx, choice: null, by: game.user.name } } }
  });
}

async function closePlayerCard(cardId, row) {
  const card = cardId ? game.messages.get(cardId) : null;
  const flag = card?.getFlag(MODULE_ID, "reaction");
  if (!card || flag?.state !== "pending") return;
  await card.update({ content: playerHtml(row), [`flags.${MODULE_ID}.reaction.state`]: row.state });
}

/**
 * GM: close the answered row (in the GM card and the player's card), and the
 * same creature's other open rows when it has no reaction left.
 */
function closeResult(result) {
  return serial(async () => {
    const { turn, rowId, choice } = result;
    const board = turn ? boardFor(turn) : null;
    const gflag = board?.getFlag(MODULE_ID, "reactionGroup");
    const rows = foundry.utils.deepClone(gflag?.rows ?? []);
    const row = rows.find(r => r.id === rowId);
    if (!row) {
      await closePlayerCard(result.cardId, { name: fromUuidSync(result.tokenUuid)?.name ?? "", img: "", items: [], players: [], left: 0, max: 1, trigger: "", detail: "", state: choice ? "used" : "skipped", choice, by: result.by });
      return;
    }
    if (row.state !== "pending") return;
    Object.assign(row, { state: choice ? "used" : "skipped", choice: choice ?? null, by: result.by ?? null });
    const touched = [row];
    if (choice) {
      const actor = fromUuidSync(row.tokenUuid)?.actor;
      const left = actor ? reactionBudget(actor).left : 0;
      for (const other of rows) {
        if (other === row || other.tokenUuid !== row.tokenUuid || other.state !== "pending") continue;
        other.left = left;
        if (left <= 0) { other.state = "spent"; touched.push(other); }
      }
    }
    await board.update({ content: groupHtml({ ...gflag, rows }), [`flags.${MODULE_ID}.reactionGroup.rows`]: rows });
    for (const r of touched) await closePlayerCard(r.card, r);
    if (choice && SHIELD_BLOCKS.has(result.slug) && row.extra?.takenId) await shieldBlockRedo(row.extra, row.tokenUuid);
  });
}

/** GM: a new turn — what nobody answered in the last one is closed. */
function expireTurn(turn) {
  return serial(async () => {
    const board = turn ? boardFor(turn) : null;
    const gflag = board?.getFlag(MODULE_ID, "reactionGroup");
    if (!gflag?.rows?.some(r => r.state === "pending")) return;
    const rows = foundry.utils.deepClone(gflag.rows);
    const touched = [];
    for (const r of rows) if (r.state === "pending") { r.state = "expired"; touched.push(r); }
    await board.update({ content: groupHtml({ ...gflag, rows }), [`flags.${MODULE_ID}.reactionGroup.rows`]: rows });
    for (const r of touched) await closePlayerCard(r.card, r);
  });
}

/**
 * Shield Block chosen after the damage was already applied: take that damage
 * back (as PF2e's own "revert" does) and post the damage card again, for this
 * target only, so the GM can re-apply it with the shield toggle on.
 */
async function shieldBlockRedo({ takenId, sourceId }, tokenUuid) {
  const taken = game.messages.get(takenId);
  const applied = taken?.flags?.pf2e?.appliedDamage;
  const token = fromUuidSync(tokenUuid);
  if (applied && !applied.isReverted) {
    const actor = fromUuidSync(applied.uuid) ?? token?.actor;
    try {
      await actor?.undoDamage?.(applied);
      await taken.update({ "flags.pf2e.appliedDamage.isReverted": true });
    } catch (err) { console.warn(`${MODULE_ID} | shield block: revert`, err); }
  }
  const source = sourceId ? game.messages.get(sourceId) : null;
  if (!source) {
    ui.notifications.info(`${token?.name ?? ""}: 피해를 되돌렸습니다. 원래 피해 카드에서 방패를 켜고 다시 적용하세요.`);
    return;
  }
  const data = source.toObject();
  delete data._id;
  data.timestamp = Date.now();
  data.whisper = gmIds();
  data.flavor = `<div class="pkh-sb-note"><i class="fa-solid fa-shield-halved"></i> <b>${esc(token?.name ?? "")}</b> 방패 막기 — 피해를 되돌렸습니다. 방패(막기) 버튼을 켜고 다시 적용하세요.</div>${data.flavor ?? ""}`;
  foundry.utils.setProperty(data, `flags.${MODULE_ID}.shieldRepost`, true);
  const th = data.flags?.["pf2e-toolbelt"]?.targetHelper;
  if (th) {
    th.targets = tokenUuid ? [tokenUuid] : [];
    th.splashTargets = [];
    th.applied = {};
  }
  await ChatMessage.create(data);
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

/* ------------------------------------------------------------------------ *
 * Per-actor settings (responders, extra reactions, triggers per reaction)
 * ------------------------------------------------------------------------ */

export function openReactionConfig(actor) {
  actor ??= canvas?.tokens?.controlled?.[0]?.actor ?? game.pf2eKrHud?.hud?.actor;
  if (!actor) return ui.notifications.warn("PF2e-KR HUD | 먼저 토큰을 선택하세요.");
  if (!canEditSlots(actor)) return ui.notifications.warn("PF2e-KR HUD | 이 캐릭터의 반응 설정을 바꿀 권한이 없습니다.");
  const base = baseOf(actor);
  const items = reactionItems(actor);
  const responders = base.getFlag(MODULE_ID, "reactionResponders") ?? [];
  const users = game.users.filter(u => !u.isGM);
  const row = item => {
    const cfg = configFor(actor, item);
    const auto = BUILTIN[item.slug] ? " (자동 인식)" : "";
    return `<div class="pkh-rx-row" data-key="${esc(item.slug ?? item.id)}">
      <img src="${esc(item.img)}" alt=""><b>${esc(item.name)}</b><small>${auto}</small>
      <label><input type="checkbox" name="off" ${cfg.off ? "" : "checked"}> 알림</label>
      <select name="trigger" multiple size="3">${Object.entries(TRIGGERS).map(([k, l]) =>
        `<option value="${k}" ${cfg.triggers.includes(k) ? "selected" : ""}>${l}</option>`).join("")}</select>
      <label>범위 <input type="number" name="range" value="${cfg.range ?? ""}" placeholder="간격" style="width:56px">피트</label>
      <label><input type="checkbox" name="strike" ${cfg.strike ? "checked" : ""}> 사용하면 공격 굴림</label>
    </div>`;
  };
  new SimpleWindow({
    title: `반응 설정 — ${actor.name}`, width: 640,
    html: `<div class="pkh-rx-config">
      <h3>누구에게 물어볼까요?</h3>
      <p class="pkh-pick-hint">아무도 고르지 않으면 이 캐릭터를 <b>할당받은 플레이어</b>와 GM에게만 묻습니다 (소유권만 있는 사람에게는 안 감).</p>
      <div class="users">${users.map(u => `<label><input type="checkbox" value="${u.id}" ${responders.includes(u.id) ? "checked" : ""}> ${esc(u.name)}</label>`).join("")}</div>
      <p>라운드당 추가 리액션 <input type="number" name="extra" min="0" max="5" value="${Number(base.getFlag(MODULE_ID, "extraReactions")) || 0}" style="width:50px"> 개 (전투 반사신경 등)</p>
      <h3>반응별 조건</h3>
      <p class="pkh-pick-hint">자동 인식된 반응은 기본 조건이 채워져 있습니다. 트리거는 Ctrl+클릭으로 여러 개 고를 수 있습니다.</p>
      ${items.map(row).join("") || "<p>이 캐릭터에게는 반응(리액션) 능력이 없습니다.</p>"}
      <div class="pkh-seat-buttons"><button type="button" data-act="save" class="primary"><i class="fa-solid fa-check"></i> 저장</button></div>
    </div>`,
    onRender: (root, app) => root.querySelector("[data-act=save]")?.addEventListener("click", async () => {
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
      ui.notifications.info("PF2e-KR HUD | 반응 설정을 저장했습니다.");
      app.close();
    })
  }).render({ force: true });
}

/* ------------------------------------------------------------------------ */

export function registerReactionSettings() {
  const s = (key, data) => game.settings.register(MODULE_ID, key, data);
  s("reactionChecker", { name: "반응(리액션) 알림", hint: "적의 이동·공격·피해 등으로 반응을 쓸 수 있을 때, 그 캐릭터를 맡은 플레이어와 GM에게만 채팅 카드로 알립니다. (pf2e-reaction·socketlib 불필요)", scope: "world", config: true, type: Boolean, default: true });
  s("reactionCombatOnly", { name: "반응 알림은 전투 중에만", scope: "world", config: true, type: Boolean, default: true });
  s("reactionPopup", { name: "반응 알림 팝업", hint: "채팅 카드와 함께 화면 위쪽에 작은 선택 창을 띄웁니다 (30초 뒤 사라짐).", scope: "client", config: true, type: Boolean, default: true });
  s("reactionPopupGM", { name: "GM에게도 반응 팝업", hint: "끄면 GM은 채팅 카드로만 받습니다 (NPC 반응이 많을 때 편함).", scope: "client", config: true, type: Boolean, default: false });
}

export function initReactions() {
  Hooks.on("preUpdateToken", onPreUpdateToken);
  Hooks.on("updateToken", onUpdateToken);
  Hooks.on("createChatMessage", message => { onChatMessage(message); popup(message); });
  Hooks.on("renderChatMessageHTML", wireCard);
  // A creature's reactions come back at the start of its turn.
  // Open questions stay answerable through the next turn too (the GM may click on quickly), then close.
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
