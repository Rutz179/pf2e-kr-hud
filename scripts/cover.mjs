/*
 * Cover (엄폐) in one click, from the HUD quickbar or the right-click Token HUD.
 *
 *  - Lesser cover (+1 AC): another creature is in the way. No action.
 *  - Cover (+2 AC, Reflex vs area effects, Stealth to hide): Take Cover behind a wall, rock, tree... 1 action.
 *  - Greater cover (+4): Take Cover while you already have cover. 1 action.
 *
 * It applies a plain PF2e effect with the matching circumstance bonuses (replacing any earlier one from here),
 * posts a short chat card (which the action pips count) and suggests a level from what is next to the token:
 * a wall or a raised block (Rutz Diorama) means cover is there to take.
 *
 * The effect lasts 2 rounds by default (until the start of your turn; a setting, 0 = until ended) and ends by
 * itself when the token moves, when its actor uses an action with the attack trait, or falls unconscious
 * (each a setting). Whoever made the move / roll removes it; the active GM removes expired ones.
 */
import { MODULE_ID, esc, t } from "./shared.mjs";
import { markNextUse } from "./economy.mjs";

const LEVELS = {
  lesser: { bonus: 1, cost: 0 },
  standard: { bonus: 2, cost: 1 },
  greater: { bonus: 4, cost: 1 }
};
const ICON = "icons/svg/shield.svg";
const setting = key => { try { return game.settings.get(MODULE_ID, key); } catch (_) { return undefined; } };

export function registerCoverSettings() {
  game.settings.register(MODULE_ID, "coverRounds", {
    name: "PKH.Settings.coverRounds.Name", hint: "PKH.Settings.coverRounds.Hint",
    scope: "world", config: true, type: Number, range: { min: 0, max: 10, step: 1 }, default: 2
  });
  game.settings.register(MODULE_ID, "coverEndOnMove", {
    name: "PKH.Settings.coverEndOnMove.Name", hint: "PKH.Settings.coverEndOnMove.Hint",
    scope: "world", config: true, type: Boolean, default: true
  });
  game.settings.register(MODULE_ID, "coverEndOnAttack", {
    name: "PKH.Settings.coverEndOnAttack.Name", hint: "PKH.Settings.coverEndOnAttack.Hint",
    scope: "world", config: true, type: Boolean, default: true
  });
}

/** The cover effect this module put on the actor, if any: { item, level }. */
export function currentCover(actor) {
  const item = actor?.itemTypes?.effect?.find(e => e.getFlag?.(MODULE_ID, "cover"));
  return item ? { item, level: item.getFlag(MODULE_ID, "cover") } : null;
}

function effectData(level) {
  const { bonus } = LEVELS[level];
  const label = t(`Cover.${level}`);
  const rules = [{ key: "FlatModifier", selector: "ac", type: "circumstance", value: bonus, label }];
  if (level !== "lesser") {
    rules.push(
      { key: "FlatModifier", selector: "reflex", type: "circumstance", value: bonus, label, predicate: ["area-effect"] },
      { key: "FlatModifier", selector: "stealth", type: "circumstance", value: bonus, label, predicate: [{ or: ["action:hide", "action:sneak", "avoid-detection"] }] }
    );
  }
  const rounds = Math.max(0, Math.round(Number(setting("coverRounds") ?? 2)));
  const ends = [
    rounds ? t("Cover.EndsRounds", { n: rounds }) : null,
    setting("coverEndOnMove") !== false ? t("Cover.EndsMove") : null,
    setting("coverEndOnAttack") !== false ? t("Cover.EndsAttack") : null,
    t("Cover.EndsManual")
  ].filter(Boolean).map(line => `<li>${esc(line)}</li>`).join("");
  return {
    type: "effect",
    name: `${t("Cover.EffectName")}: ${label}`,
    img: ICON,
    system: {
      slug: `pkh-cover-${level}`,
      description: { value: `<p>${esc(t(`Cover.${level}Desc`))}</p><ul>${ends}</ul>` },
      tokenIcon: { show: true },
      duration: rounds
        ? { value: rounds, unit: "rounds", expiry: "turn-start", sustained: false }
        : { value: -1, unit: "unlimited", expiry: null, sustained: false },
      rules
    },
    flags: { [MODULE_ID]: { cover: level } }
  };
}

/** Apply a cover level (or null to end it). Costs an action for Take Cover (standard / greater). */
export async function applyCover(actor, level, token = null) {
  if (!actor?.isOwner) return;
  const cur = currentCover(actor);
  const old = actor.itemTypes.effect.filter(e => e.getFlag?.(MODULE_ID, "cover")).map(e => e.id);
  if (old.length) await actor.deleteEmbeddedDocuments("Item", old);
  if (!level) {
    if (cur) await card(actor, token, t("Cover.EndCard"), 0);
    return;
  }
  await actor.createEmbeddedDocuments("Item", [effectData(level)]);
  const { bonus, cost } = LEVELS[level];
  await card(actor, token, t("Cover.Card", { level: t(`Cover.${level}`), bonus }), cost);
}

async function card(actor, token, text, cost) {
  const glyph = cost ? `<span class="action-glyph">${cost}</span> ` : "";
  if (cost) markNextUse(actor, cost);
  try {
    await ChatMessage.create({
      speaker: ChatMessage.getSpeaker({ actor, token: token?.document ?? token ?? undefined }),
      content: `<div class="pkh-cover-card"><img src="${ICON}" alt=""><p>${glyph}${esc(text)}</p></div>`
    });
  } catch (err) {
    console.warn(`${MODULE_ID} | cover card`, err);
  }
}

/* ---------------- ending by itself ---------------- */

const ending = new Set();

/** Remove this module's cover effect from the actor (no action, no card); `why` picks the notice, if any. */
async function endCover(actor, why = null) {
  if (!actor?.isOwner || ending.has(actor.uuid)) return;
  const ids = actor.itemTypes?.effect?.filter(e => e.getFlag?.(MODULE_ID, "cover")).map(e => e.id) ?? [];
  if (!ids.length) return;
  ending.add(actor.uuid);
  try {
    await actor.deleteEmbeddedDocuments("Item", ids.filter(id => actor.items.has(id)));
    if (why) ui.notifications.info(t(`Cover.Ended${why}`, { name: actor.name }));
  } catch (err) {
    console.warn(`${MODULE_ID} | ending cover`, err);
  } finally {
    ending.delete(actor.uuid);
  }
}

const traitNames = list => (Array.isArray(list) ? list : []).map(x => (typeof x === "string" ? x : x?.name ?? x?.value)).filter(Boolean);

/** Did this chat message come from using an action with the attack trait (Strike, spell attack, Grapple, Trip...)? */
function isAttackUse(message) {
  const ctx = message.flags?.pf2e?.context ?? null;
  const type = ctx?.type ?? null;
  if (type === "attack-roll" || type === "spell-attack-roll") return true;
  if (type === "skill-check" || type === "check") {
    return traitNames(ctx.traits).includes("attack") || (ctx.options ?? []).includes("trait:attack");
  }
  // an action or spell posted from the sheet or the HUD
  if (!type || type === "spell-cast" || type === "action") {
    const item = message.item;
    if (item && ["action", "feat", "spell"].includes(item.type)) return traitNames(item.system?.traits?.value).includes("attack");
  }
  return false;
}

function speakerActor(message) {
  try { return message.actor ?? ChatMessage.getSpeakerActor(message.speaker); } catch (_) { return null; }
}

/** Active GM: drop cover effects whose rounds have run out (PF2e only greys them out unless set to remove). */
function sweepExpired() {
  if (!game.users.activeGM?.isSelf) return;
  const actors = new Set();
  for (const c of game.combat?.combatants ?? []) if (c.actor) actors.add(c.actor);
  for (const tk of canvas?.tokens?.placeables ?? []) if (tk.actor) actors.add(tk.actor);
  for (const actor of actors) {
    const expired = actor.itemTypes?.effect?.filter(e => e.getFlag?.(MODULE_ID, "cover") && (e.remainingDuration?.expired ?? e.isExpired));
    if (expired?.length) {
      actor.deleteEmbeddedDocuments("Item", expired.map(e => e.id).filter(id => actor.items.has(id))).catch(() => {});
    }
  }
}

function initCoverEnding() {
  Hooks.on("updateToken", (doc, changes, _options, userId) => {
    if (userId !== game.user.id || setting("coverEndOnMove") === false) return;
    if (!("x" in changes) && !("y" in changes)) return;
    const actor = doc.actor;
    if (currentCover(actor)) endCover(actor, "Move");
  });
  Hooks.on("createChatMessage", (message, _options, userId) => {
    if (userId !== game.user.id || setting("coverEndOnAttack") === false) return;
    const actor = speakerActor(message);
    if (!actor || !currentCover(actor) || !isAttackUse(message)) return;
    endCover(actor, "Attack");
  });
  Hooks.on("createItem", (item, _options, userId) => {
    if (userId !== game.user.id || item.type !== "condition" || item.slug !== "unconscious") return;
    if (currentCover(item.actor)) endCover(item.actor, "Unconscious");
  });
  let queued = null;
  const later = () => { clearTimeout(queued); queued = setTimeout(sweepExpired, 120); };
  Hooks.on("updateCombat", later);
  Hooks.on("updateWorldTime", later);
}

/* ---------------- what's next to the token ---------------- */

/** Is something you can duck behind right next to the token: a wall, or a raised block in Rutz Diorama? */
function obstacleNear(token) {
  if (!token || !canvas?.ready) return false;
  try {
    const dio = game.modules.get("rutz-diorama")?.api;
    if (typeof dio?.obstacleNear === "function" && dio.obstacleNear(token.document?.id ?? token.id)) return true;
  } catch (_) { /* no diorama */ }
  const backend = CONFIG.Canvas?.polygonBackends?.move;
  if (typeof backend?.testCollision !== "function") return false;
  const c = token.center, size = canvas.dimensions.size;
  const reach = (Math.max(token.document.width, token.document.height) / 2 + 0.75) * size;
  for (let k = 0; k < 8; k++) {
    const a = (k * Math.PI) / 4;
    const dest = { x: c.x + Math.cos(a) * reach, y: c.y + Math.sin(a) * reach };
    try {
      if (backend.testCollision(c, dest, { type: "move", mode: "any" })) return true;
    } catch (_) { return false; }
  }
  return false;
}

function suggested(actor, token) {
  const cur = currentCover(actor)?.level;
  if (cur === "standard" || cur === "greater") return "greater";
  return obstacleNear(token) ? "standard" : "lesser";
}

/* ---------------- the little menu ---------------- */

let menu = null;
function closeMenu() {
  menu?.remove();
  menu = null;
  document.removeEventListener("pointerdown", outside, true);
  document.removeEventListener("keydown", onKey, true);
}
function outside(ev) { if (menu && !menu.contains(ev.target)) closeMenu(); }
function onKey(ev) { if (ev.key === "Escape") { ev.stopPropagation(); closeMenu(); } }

/** Open the cover chooser next to `anchor` (an element) for this actor / token. */
export function openCoverMenu(actor, token, anchor) {
  if (!actor?.isOwner) return;
  if (menu) { closeMenu(); return; }
  token ??= actor.getActiveTokens?.()[0] ?? null;
  const cur = currentCover(actor)?.level ?? null;
  const pick = suggested(actor, token);
  menu = document.body.appendChild(document.createElement("div"));
  menu.id = "pkh-cover-menu";
  menu.setAttribute("role", "menu");
  const row = level => {
    const { bonus, cost } = LEVELS[level];
    const cls = [level === cur ? "current" : "", level === pick ? "suggested" : ""].join(" ");
    return `<button type="button" role="menuitem" class="${cls}" data-level="${level}">
      <span class="lv">${esc(t(`Cover.${level}`))} <b>+${bonus}</b>${cost ? ` <span class="cost">${t("Cover.OneAction")}</span>` : ` <span class="cost free">${t("Cover.NoAction")}</span>`}</span>
      <small>${esc(t(`Cover.${level}When`))}</small></button>`;
  };
  menu.innerHTML = `<header>${esc(t("Cover.Title"))}${pick ? `<small>${esc(t("Cover.Suggest", { level: t(`Cover.${pick}`) }))}</small>` : ""}</header>
    ${["lesser", "standard", "greater"].map(row).join("")}
    ${cur ? `<button type="button" role="menuitem" class="end" data-level="">${esc(t("Cover.End"))}</button>` : ""}`;
  menu.addEventListener("click", async ev => {
    const b = ev.target.closest("button[data-level]");
    if (!b) return;
    closeMenu();
    await applyCover(actor, b.dataset.level || null, token);
  });
  // place it next to the anchor, kept on screen
  const r = anchor?.getBoundingClientRect?.() ?? { left: innerWidth / 2, top: innerHeight / 2, right: innerWidth / 2, bottom: innerHeight / 2, width: 0 };
  const m = menu.getBoundingClientRect();
  let x = r.left + r.width / 2 - m.width / 2, y = r.top - m.height - 8;
  if (y < 8) y = r.bottom + 8;
  x = Math.max(8, Math.min(innerWidth - m.width - 8, x));
  y = Math.max(8, Math.min(innerHeight - m.height - 8, y));
  menu.style.left = `${Math.round(x)}px`;
  menu.style.top = `${Math.round(y)}px`;
  menu.querySelector("button.suggested, button")?.focus();
  setTimeout(() => {
    document.addEventListener("pointerdown", outside, true);
    document.addEventListener("keydown", onKey, true);
  }, 0);
}

/** The same button in Foundry's right-click Token HUD (2D canvas and Rutz Diorama). */
export function initCover() {
  initCoverEnding();
  Hooks.on("renderTokenHUD", (hud, html) => {
    const token = hud?.object;
    const actor = token?.actor;
    if (!actor?.isOwner || !["character", "npc", "familiar"].includes(actor.type)) return;
    const root = html instanceof HTMLElement ? html : html?.[0] ?? hud.element;
    const col = root?.querySelector?.(".col.right") ?? root?.querySelector?.(".right");
    if (!col || col.querySelector(".pkh-cover-btn")) return;
    const cur = currentCover(actor)?.level;
    const b = document.createElement("button");
    b.type = "button";
    b.className = `control-icon pkh-cover-btn ${cur ? "active" : ""}`;
    b.dataset.tooltip = cur ? `${t("Cover.Title")}: ${t(`Cover.${cur}`)}` : t("Cover.Title");
    b.setAttribute("aria-label", t("Cover.Title"));
    b.innerHTML = `<i class="fa-solid fa-shield-halved"></i>`;
    b.addEventListener("click", ev => { ev.preventDefault(); ev.stopPropagation(); openCoverMenu(actor, token, b); });
    col.appendChild(b);
  });
}
