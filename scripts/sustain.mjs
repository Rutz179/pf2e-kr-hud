import { MODULE_ID, esc, setting, t } from "./shared.mjs";
import { economyOf, setUsed } from "./economy.mjs";

/* ======================================================================== *
 * Sustain checker (replaces pf2e-sustain-reminder, kept simple)
 *
 *  - Casting a spell whose duration says "sustained" puts a small effect on
 *    the caster: "지속: <주문>".
 *  - At the start of the caster's turn, a whispered card (the player(s) of
 *    that character + GM) asks, per sustained spell: 지속 (1 행동) or 끝내기.
 *      지속 → one action is marked used on the HUD's action pips;
 *      끝내기 → the reminder effect goes, and so do the effects that spell
 *               put on anyone (found by their origin), i.e. the spell ends.
 *  - Detection and clean-up run on the active GM's client, so each happens
 *    once and nothing needs a player to own someone else's token.
 * ======================================================================== */

const FLAG = "sustain";
const isActiveGM = () => !!game.users.activeGM?.isSelf;
const gmIds = () => game.users.filter(u => u.isGM).map(u => u.id);

function playersOf(actor) {
  const base = actor?.isToken ? game.actors.get(actor.id) ?? actor : actor;
  const custom = base?.getFlag?.(MODULE_ID, "reactionResponders");
  if (Array.isArray(custom) && custom.length) return custom;
  const assigned = game.users.filter(u => !u.isGM && u.character?.id === base?.id).map(u => u.id);
  if (assigned.length) return assigned;
  return game.users.filter(u => !u.isGM && base?.testUserPermission?.(u, "OWNER")).map(u => u.id);
}

/** "1 minute" / "10 minutes" / "1분" / "1시간" → { value, unit } (else unlimited). */
function parseDuration(text) {
  const t = String(text ?? "").toLowerCase();
  const m = /(\d+)\s*(round|minute|hour|day|라운드|분|시간|일)/.exec(t);
  if (!m) return { value: -1, unit: "unlimited" };
  const unit = { round: "rounds", "라운드": "rounds", minute: "minutes", "분": "minutes", hour: "hours", "시간": "hours", day: "days", "일": "days" }[m[2]];
  return { value: Number(m[1]), unit };
}

function sustainEffects(actor) {
  return (actor?.itemTypes?.effect ?? []).filter(e => e.getFlag(MODULE_ID, FLAG));
}

/* ---------------- a sustained spell is cast ---------------- */

async function onCast(message) {
  if (!isActiveGM() || setting("sustainChecker", true) === false) return;
  const pf2e = message.flags?.pf2e ?? {};
  if (pf2e.origin?.type !== "spell" || !pf2e.casting) return;
  if (pf2e.context && pf2e.context.type !== "spell-cast") return;   // the spell card itself, not its rolls
  if (message.rolls?.length) return;
  const actor = message.actor;
  let spell = message.item ?? null;
  if (!spell && pf2e.origin?.uuid) { try { spell = fromUuidSync(pf2e.origin.uuid); } catch (_) { /* gone */ } }
  if (!actor || !spell?.system?.duration?.sustained) return;
  const slug = `pkh-sustain-${spell.slug ?? spell.id}`;
  if (actor.itemTypes.effect.some(e => e.slug === slug || e.system?.slug === slug)) return;
  const duration = parseDuration(spell.system.duration.value);
  await actor.createEmbeddedDocuments("Item", [{
    type: "effect",
    name: t("Sustain.EffectName", { spell: spell.name }),
    img: spell.img,
    system: {
      slug,
      tokenIcon: { show: true },
      duration: { ...duration, sustained: true, expiry: duration.unit === "unlimited" ? null : "turn-end" },
      description: { value: `<p>${t("Sustain.EffectDesc", { spell: esc(spell.name) })}</p>${spell.system.description?.value ?? ""}` },
      level: { value: spell.rank ?? spell.level ?? 1 },
      unidentified: false
    },
    flags: { [MODULE_ID]: { [FLAG]: { spellUuid: spell.uuid, spellName: spell.name } } }
  }]);
}

/* ---------------- turn start: ask ---------------- */

async function onTurn(combat, changed) {
  if (!isActiveGM() || setting("sustainChecker", true) === false) return;
  if (!("turn" in changed || "round" in changed) || !combat.started) return;
  const combatant = combat.combatant;
  const actor = combatant?.actor;
  const list = sustainEffects(actor);
  if (!list.length) return;
  const token = combatant.token;
  const rows = list.map(e => ({ effectId: e.id, name: e.getFlag(MODULE_ID, FLAG)?.spellName ?? e.name.replace(/^(?:지속|Sustain):\s*/, ""), img: e.img, state: "pending" }));
  await ChatMessage.create({
    speaker: ChatMessage.getSpeaker({ token, actor }),
    whisper: [...new Set([...playersOf(actor), ...gmIds()])],
    content: cardHtml(actor, rows),
    flags: { [MODULE_ID]: { sustainCard: { actorUuid: actor.uuid, rows, turn: `${combat.id}.${combat.round}.${combat.turn}` } } }
  });
}

function cardHtml(actor, rows) {
  return `<div class="pkh-sustain">
    <header><i class="fa-solid fa-hourglass-half"></i> <b>${esc(actor?.name ?? "")}</b> — ${t("Sustain.CardTitle")}</header>
    ${rows.map((r, i) => `<div class="sus-row ${r.state}" data-i="${i}">
      <img src="${esc(r.img)}" alt=""><b>${esc(r.name)}</b>
      ${r.state === "pending"
        ? `<span class="btns"><button type="button" data-sus="keep" data-i="${i}"><i class="fa-solid fa-rotate"></i> ${t("Sustain.Keep")} <small>${t("Sustain.OneAction")}</small></button>
           <button type="button" data-sus="end" data-i="${i}" class="end"><i class="fa-solid fa-xmark"></i> ${t("Sustain.End")}</button></span>`
        : `<span class="done">${t(r.state === "kept" ? "Sustain.Kept" : "Sustain.Ended")}${r.by ? ` <small>(${esc(r.by)})</small>` : ""}</span>`}
    </div>`).join("")}
  </div>`;
}

/* ---------------- answering ---------------- */

async function answer(message, index, choice) {
  const flag = message.getFlag(MODULE_ID, "sustainCard");
  const row = flag?.rows?.[index];
  if (!row || row.state !== "pending") return;
  const actor = fromUuidSync(flag.actorUuid);
  if (choice === "keep" && actor?.isOwner) {
    try {
      const eco = economyOf(actor);
      if (eco.inTurn) await setUsed(actor, eco.used + 1);
    } catch (err) { console.warn(`${MODULE_ID} | sustain: action`, err); }
  }
  await ChatMessage.create({
    speaker: ChatMessage.getSpeaker({ actor }),
    whisper: [...new Set([...playersOf(actor), ...gmIds()])],
    content: `<div class="pkh-sustain note">${choice === "keep" ? `<i class="fa-solid fa-rotate"></i> ${t("Sustain.NoteKept", { spell: esc(row.name) })}` : `<i class="fa-solid fa-xmark"></i> ${t("Sustain.NoteEnded", { spell: esc(row.name) })}`}</div>`,
    flags: { [MODULE_ID]: { sustainResult: { cardId: message.id, index, choice, by: game.user.name } } }
  });
}

/** GM: close the row, and when a spell ends remove its effects everywhere. */
async function onResult({ cardId, index, choice, by }) {
  const card = game.messages.get(cardId);
  const flag = card?.getFlag(MODULE_ID, "sustainCard");
  const row = flag?.rows?.[index];
  if (!card || !row || row.state !== "pending") return;
  const rows = foundry.utils.deepClone(flag.rows);
  Object.assign(rows[index], { state: choice === "keep" ? "kept" : "ended", by });
  const actor = fromUuidSync(flag.actorUuid);
  await card.update({ content: cardHtml(actor, rows), [`flags.${MODULE_ID}.sustainCard.rows`]: rows });
  if (choice !== "end") return;
  const effect = actor?.items.get(row.effectId);
  const spellUuid = effect?.getFlag(MODULE_ID, FLAG)?.spellUuid;
  if (effect) await effect.delete();
  if (!spellUuid) return;
  // Effects the spell put on anyone in the scene (by their recorded origin).
  for (const tokenDoc of canvas.scene?.tokens ?? []) {
    const a = tokenDoc.actor;
    const ids = (a?.itemTypes?.effect ?? []).filter(e => e.system?.context?.origin?.item === spellUuid || e.flags?.pf2e?.origin?.uuid === spellUuid).map(e => e.id);
    if (ids.length) await a.deleteEmbeddedDocuments("Item", ids);
  }
}

function wire(message, html) {
  const root = html instanceof HTMLElement ? html : html?.[0];
  const flag = message.getFlag?.(MODULE_ID, "sustainCard");
  if (!root || !flag) return;
  const actor = fromUuidSync(flag.actorUuid);
  const allowed = game.user.isGM || playersOf(actor).includes(game.user.id) || actor?.isOwner;
  for (const btn of root.querySelectorAll("[data-sus]")) {
    if (!allowed || flag.rows?.[Number(btn.dataset.i)]?.state !== "pending") { btn.disabled = true; continue; }
    btn.addEventListener("click", () => {
      root.querySelectorAll(`[data-sus][data-i="${btn.dataset.i}"]`).forEach(b => (b.disabled = true));
      answer(message, Number(btn.dataset.i), btn.dataset.sus);
    });
  }
}

export function registerSustainSettings() {
  game.settings.register(MODULE_ID, "sustainChecker", {
    name: "PKH.Settings.sustainChecker.Name",
    hint: "PKH.Settings.sustainChecker.Hint",
    scope: "world", config: true, type: Boolean, default: true
  });
}

export function initSustain() {
  Hooks.on("createChatMessage", message => {
    const result = message.getFlag?.(MODULE_ID, "sustainResult");
    if (result) { if (isActiveGM()) onResult(result); return; }
    onCast(message);
  });
  Hooks.on("updateCombat", onTurn);
  Hooks.on("renderChatMessageHTML", wire);
}
