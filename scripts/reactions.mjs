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
  "shield-block": { triggers: ["damaged"], needShield: true },
  "quick-shield-block": { triggers: ["damaged"], needShield: true },
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
 * ------------------------------------------------------------------------ */

const lastPos = new Map();
const recent = new Map(); // de-dupe: actor+trigger within a few seconds

function isActiveGM() {
  return !!game.users.activeGM?.isSelf;
}

function candidates(trigger, test) {
  const out = [];
  for (const tokenDoc of canvas.scene?.tokens ?? []) {
    const actor = tokenDoc.actor;
    if (!actor || tokenDoc.hidden && !actor.hasPlayerOwner) continue;
    const items = reactionItems(actor).filter(item => {
      const cfg = configFor(actor, item);
      if (cfg.off || !cfg.triggers.includes(trigger)) return false;
      if (cfg.needShield && !actor.attributes?.shield?.raised && !actor.system?.attributes?.shield?.raised) return false;
      return test(tokenDoc, cfg);
    });
    if (items.length && canReact(actor)) out.push({ tokenDoc, actor, items });
  }
  return out;
}

async function prompt(found, trigger, detail) {
  if (!setting("reactionChecker", true) || (setting("reactionCombatOnly", true) && !game.combat?.started)) return;
  for (const { tokenDoc, actor, items } of found) {
    const key = `${tokenDoc.id}:${trigger}`;
    if (Date.now() - (recent.get(key) ?? 0) < 4000) continue;
    recent.set(key, Date.now());
    const budget = reactionBudget(actor);
    const responders = respondersFor(actor);
    const content = `<div class="pkh-reaction">
      <header><i class="fa-solid fa-bolt"></i> <strong>${esc(tokenDoc.name)}</strong> — 반응 기회</header>
      <p>${esc(TRIGGERS[trigger])}${detail ? `: <b>${esc(detail)}</b>` : ""}</p>
      <p class="budget">리액션 <b>${budget.left}/${budget.max}</b> 남음</p>
      <div class="choices">
        ${items.map(i => `<button type="button" data-rx-use="${i.id}"><img src="${esc(i.img)}" alt=""> ${esc(i.name)}</button>`).join("")}
        <button type="button" data-rx-skip="1" class="skip">반응 안 함</button>
      </div></div>`;
    await ChatMessage.create({
      speaker: ChatMessage.getSpeaker({ token: tokenDoc }),
      whisper: responders,
      content,
      flags: { [MODULE_ID]: { reaction: { tokenUuid: tokenDoc.uuid, responders, trigger, detail, state: "pending" } } }
    });
  }
}

function onPreUpdateToken(doc, changes) {
  if ("x" in changes || "y" in changes) lastPos.set(doc.id, { x: doc.x, y: doc.y });
}

function onUpdateToken(doc, changes) {
  if (!isActiveGM() || !("x" in changes || "y" in changes)) return;
  const from = lastPos.get(doc.id);
  lastPos.delete(doc.id);
  if (!from || !doc.actor) return;
  const start = rectOf(doc, from);
  const found = candidates("move", (reactor, cfg) =>
    reactor.id !== doc.id && hostile(reactor.actor, doc.actor)
    && distanceFt(rectOf(reactor), start) <= (cfg.range ?? reachOf(reactor.actor)));
  if (found.length) prompt(found, "move", doc.name);
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

function onChatMessage(message) {
  const result = message.getFlag?.(MODULE_ID, "reactionResult");
  if (result && isActiveGM()) return closeCard(result);
  if (!isActiveGM()) return;
  const pf2e = message.flags?.pf2e ?? {};
  const ctx = pf2e.context;
  const sourceToken = message.speaker?.token ? canvas.scene?.tokens.get(message.speaker.token) : null;

  // Attacks: targeted / critical failure / ranged attack within reach
  if (ctx && ["attack-roll", "spell-attack-roll"].includes(ctx.type)) {
    const target = tokenFromUuidOrId(ctx.target?.token ?? ctx.target?.tokenId);
    if (target) {
      const onlyTarget = (tok) => tok.id === target.id;
      const targeted = candidates("targeted", onlyTarget);
      if (targeted.length) prompt(targeted, "targeted", sourceToken?.name ?? "");
      if (ctx.outcome === "criticalFailure") {
        const riposte = candidates("crit-fail", onlyTarget);
        if (riposte.length) prompt(riposte, "crit-fail", sourceToken?.name ?? "");
      }
    }
    const ranged = (ctx.domains ?? []).includes("ranged-attack-roll") || (ctx.options ?? []).includes("item:ranged") || ctx.type === "spell-attack-roll";
    if (ranged && sourceToken) nearbyEnemies("manipulate", sourceToken);
  }

  // Casting a spell (manipulate) within someone's reach
  if (!ctx && pf2e.casting && sourceToken) nearbyEnemies("manipulate", sourceToken);

  // Saving throws
  if (ctx?.type === "saving-throw" && sourceToken) {
    const own = candidates("save", tok => tok.id === sourceToken.id);
    if (own.length) prompt(own, "save", "");
  }

  // Damage actually applied (PF2e posts an "applied damage" message for the target)
  const applied = pf2e.appliedDamage;
  if (applied && !applied.isHealing && sourceToken) {
    const self = candidates("damaged", tok => tok.id === sourceToken.id);
    if (self.length) prompt(self, "damaged", "");
    const allies = candidates("ally-damaged", (tok, cfg) =>
      tok.id !== sourceToken.id && !hostile(tok.actor, sourceToken.actor)
      && distanceFt(rectOf(tok), rectOf(sourceToken)) <= (cfg.range ?? 15));
    if (allies.length) prompt(allies, "ally-damaged", sourceToken.name);
  }
}

function nearbyEnemies(trigger, sourceToken) {
  const found = candidates(trigger, (tok, cfg) =>
    tok.id !== sourceToken.id && hostile(tok.actor, sourceToken.actor)
    && distanceFt(rectOf(tok), rectOf(sourceToken)) <= (cfg.range ?? reachOf(tok.actor)));
  if (found.length) prompt(found, trigger, sourceToken.name);
}

/* ------------------------------------------------------------------------ *
 * Using / declining (any responder), closing the card (GM)
 * ------------------------------------------------------------------------ */

async function useReaction(message, itemId, event) {
  const flag = message.getFlag(MODULE_ID, "reaction");
  const token = flag?.tokenUuid ? fromUuidSync(flag.tokenUuid) : null;
  const actor = token?.actor;
  const item = actor?.items.get(itemId);
  if (!item) return;
  const cfg = configFor(actor, item);
  await ChatMessage.create({
    speaker: ChatMessage.getSpeaker({ token }),
    content: `<div class="pkh-reaction used"><i class="fa-solid fa-bolt"></i> <b>${esc(token.name)}</b>이(가) 반응 <b>${esc(item.name)}</b>을(를) 사용했습니다.</div>`,
    flags: { [MODULE_ID]: { reactionResult: { cardId: message.id, choice: item.name } } }
  });
  try { await spendReaction(actor); } catch (_) { /* responder without ownership: the GM's count still resets each turn */ }
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

async function declineReaction(message) {
  const flag = message.getFlag(MODULE_ID, "reaction");
  const token = flag?.tokenUuid ? fromUuidSync(flag.tokenUuid) : null;
  await ChatMessage.create({
    speaker: ChatMessage.getSpeaker({ token }),
    whisper: flag?.responders ?? game.users.filter(u => u.isGM).map(u => u.id),
    content: `<div class="pkh-reaction skipped"><i class="fa-regular fa-circle-xmark"></i> ${esc(token?.name ?? "")}: 반응하지 않음</div>`,
    flags: { [MODULE_ID]: { reactionResult: { cardId: message.id, choice: null } } }
  });
}

/** GM: turn the prompt into a closed record so nobody answers twice. */
async function closeCard({ cardId, choice }) {
  const card = game.messages.get(cardId);
  const flag = card?.getFlag(MODULE_ID, "reaction");
  if (!card || flag?.state !== "pending") return;
  const tail = choice ? `<p class="done">✔ <b>${esc(choice)}</b> 사용</p>` : `<p class="done">✖ 반응하지 않음</p>`;
  await card.update({
    content: card.content.replace(/<div class="choices">[\s\S]*?<\/div><\/div>$/, `${tail}</div>`),
    [`flags.${MODULE_ID}.reaction.state`]: choice ? "used" : "skipped"
  });
}

function wireCard(message, html) {
  const root = html instanceof HTMLElement ? html : html?.[0];
  const flag = message.getFlag?.(MODULE_ID, "reaction");
  if (!root || !flag) return;
  const mine = flag.responders?.includes(game.user.id);
  for (const btn of root.querySelectorAll("[data-rx-use], [data-rx-skip]")) {
    if (!mine || flag.state !== "pending") { btn.disabled = true; continue; }
    btn.addEventListener("click", ev => {
      root.querySelectorAll("[data-rx-use], [data-rx-skip]").forEach(b => (b.disabled = true));
      if (btn.dataset.rxSkip) return declineReaction(message);
      return useReaction(message, btn.dataset.rxUse, ev);
    });
  }
}

/** Optional pop-up for the responder, mirroring the card's buttons. */
function popup(message) {
  const flag = message.getFlag?.(MODULE_ID, "reaction");
  if (!flag || flag.state !== "pending" || !flag.responders?.includes(game.user.id) || !setting("reactionPopup", true)) return;
  if (game.user.isGM && !setting("reactionPopupGM", false)) return;
  const el = document.createElement("section");
  el.className = "pkh-reaction-pop";
  el.innerHTML = message.content;
  document.body.appendChild(el);
  wireCard(message, el);
  el.addEventListener("click", ev => { if (ev.target.closest("button")) setTimeout(() => el.remove(), 200); });
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
  Hooks.on("updateCombat", (combat, changed) => {
    if (!isActiveGM() || !("turn" in changed || "round" in changed)) return;
    const actor = combat.combatant?.actor;
    if (actor?.getFlag(MODULE_ID, "reactionUse")) actor.unsetFlag(MODULE_ID, "reactionUse");
  });
  game.pf2eKrHud = { ...(game.pf2eKrHud ?? {}), openReactionConfig };
}
