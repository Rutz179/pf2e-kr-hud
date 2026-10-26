import { MODULE_ID, SimpleWindow, esc, setting, t } from "./shared.mjs";
import { reactionBudget, setReactionUsed } from "./reactions.mjs";

/* ======================================================================== *
 * Contingency (Player Core, 7th rank)
 *
 * "You prepare a spell that will trigger later … choose a trigger … Once
 * contingency is cast, you can cause the companion spell to come into effect
 * as a reaction with that trigger. It affects only you." It lasts until the
 * next daily preparations; a new casting supersedes the old one.
 *
 *  - After Rest for the Night, a character who has Contingency gets a card
 *    (and, if online, the window) to set it up for the day: the rank, the
 *    companion spell (rank ≤ 4, +1 per rank above 7th; ≤ 3 actions), the
 *    trigger — built from what the reaction checker can see (targeted, an
 *    enemy coming close, damage taken, HP falling low, a condition …), joined
 *    with "or" — and whether to spend the slots now.
 *  - It becomes a reaction on the character ("컨틴전시: <spell>"). Tracked
 *    triggers prompt like any reaction; a trigger typed by hand is only shown
 *    as text — nothing watches for it — and the ready card has a button to
 *    set it off by hand.
 *  - Setting it off posts the companion spell (no slot: it was paid at
 *    preparation) and removes the reaction.
 * ======================================================================== */

export const CONTINGENCY = "contingency";
const DONE_SLUG = "pkh-contingency";
const QUICK = new Set(["1", "2", "3", "reaction", "free"]);
// The reaction checker can't react for someone who can't act: these conditions aren't offered.
const NO_REACT = new Set(["unconscious", "paralyzed", "petrified", "stunned", "dying", "restrained", "dead"]);

/** Trigger kinds offered here: [key, has a range, other parameter]. "custom" is text only. */
const KINDS = ["targeted", "approach", "move", "manipulate", "damaged", "hp-low", "condition", "save", "crit-fail", "ally-damaged", "custom"];
const RANGED = new Set(["approach", "move", "manipulate", "ally-damaged"]);

const ownersOf = actor => game.users.filter(u => !u.isGM && actor?.testUserPermission?.(u, "OWNER"));
const gmIds = () => game.users.filter(u => u.isGM).map(u => u.id);

export function contingencyItem(actor) {
  return (actor?.itemTypes?.action ?? []).find(i => i.flags?.[MODULE_ID]?.contingency) ?? null;
}

/** The character's Contingency spell and the entry it is cast from (not a ritual or an item entry). */
function contingencySpell(actor) {
  for (const spell of actor?.itemTypes?.spell ?? []) {
    const slug = spell.system?.slug ?? spell.slug;
    if (slug !== CONTINGENCY) continue;
    const entry = actor.items.get(spell.system?.location?.value);
    if (entry?.type === "spellcastingEntry" && !entry.isRitual && entry.system?.prepared?.value !== "items") return { spell, entry };
  }
  return null;
}

export function hasContingency(actor) {
  return !!contingencySpell(actor);
}

/** Slot ranks an entry has a usable (unexpended) prepared copy of this spell in. */
function preparedRanks(entry, spell) {
  const out = [];
  for (let r = 1; r <= 10; r++) {
    const list = entry.system?.slots?.[`slot${r}`]?.prepared ?? [];
    if (list.some(s => s?.id === spell.id && !s.expended)) out.push(r);
  }
  return out;
}

function slotRanks(entry, from, to) {
  const out = [];
  for (let r = from; r <= to; r++) if (Number(entry.system?.slots?.[`slot${r}`]?.max ?? 0) > 0) out.push(r);
  return out;
}

const maxRank = actor => Math.min(10, Math.ceil((Number(actor?.level) || 1) / 2));

/** Ranks Contingency can be cast at now (7th and up). */
function contingencyRanks(actor, c) {
  const top = maxRank(actor);
  if (top < 7) return [];
  const e = c.entry;
  if (e.isPrepared && !e.isFlexible) return preparedRanks(e, c.spell).filter(r => r >= 7);
  if (e.isInnate) return [Math.max(7, c.spell.baseRank ?? 7)];
  return slotRanks(e, 7, top);
}

/** Spells that can go with it: ≤ cap rank, ≤ 3 actions, castable from their entry today. */
function companions(actor, cap, contingencyId) {
  const out = [];
  for (const spell of actor?.itemTypes?.spell ?? []) {
    if (spell.id === contingencyId || spell.isRitual) continue;
    const entry = actor.items.get(spell.system?.location?.value);
    if (entry?.type !== "spellcastingEntry" || entry.isRitual || entry.system?.prepared?.value === "items") continue;
    if (!QUICK.has(String(spell.system?.time?.value ?? ""))) continue;
    const base = Number(spell.baseRank ?? spell.system?.level?.value ?? 1) || 1;
    let ranks;
    if (spell.isCantrip || spell.isFocusSpell) ranks = [spell.rank];
    else if (base > cap) continue;
    else if (entry.isPrepared && !entry.isFlexible) ranks = preparedRanks(entry, spell).filter(r => r >= base && r <= cap);
    else if (entry.isInnate) ranks = [base];
    else ranks = slotRanks(entry, base, cap);
    if (!ranks.length || (!(spell.isCantrip || spell.isFocusSpell) && Math.min(...ranks) > cap)) continue;
    out.push({ spell, entry, ranks });
  }
  return out.sort((a, b) => a.entry.name.localeCompare(b.entry.name, game.i18n.lang) || a.spell.baseRank - b.spell.baseRank || a.spell.name.localeCompare(b.spell.name, game.i18n.lang));
}

/* ---------------- the trigger, in words ---------------- */

function conditionLabel(slug) {
  const c = CONFIG.PF2E?.conditionTypes?.[slug];
  return c ? game.i18n.localize(typeof c === "string" ? c : c.label ?? c.name ?? slug) : slug;
}

export function ruleText(rule) {
  switch (rule.kind) {
    case "custom": return String(rule.text ?? "").trim() || t("Contingency.Kind.custom");
    case "hp-low": return t("Contingency.Say.hp-low", { pct: rule.pct ?? 50 });
    case "condition": return t("Contingency.Say.condition", { condition: conditionLabel(rule.condition) });
    default: return RANGED.has(rule.kind) ? t(`Contingency.Say.${rule.kind}`, { range: rule.range || 5 }) : t(`Contingency.Say.${rule.kind}`);
  }
}

export function triggerText(rules) {
  return rules.map(ruleText).join(t("Contingency.Or"));
}

/* ---------------- reaction-checker side ---------------- */

/** What the reaction checker reads for the contingency reaction (configFor in reactions.mjs). */
export function contingencyConfig(item) {
  const c = item?.flags?.[MODULE_ID]?.contingency;
  if (!c) return null;
  const rules = (c.rules ?? []).filter(r => r.kind !== "custom");
  const rangeFor = {};
  for (const r of rules) if (RANGED.has(r.kind)) rangeFor[r.kind] = Math.max(rangeFor[r.kind] ?? 0, Number(r.range) || 5);
  return {
    triggers: [...new Set(rules.map(r => r.kind))],
    rules, rangeFor, range: null,
    hpPct: Math.max(0, ...rules.filter(r => r.kind === "hp-low").map(r => Number(r.pct) || 50)) || null,
    conditions: rules.filter(r => r.kind === "condition").map(r => r.condition).filter(Boolean),
    strike: false, needShield: false, needPhysicalAttack: false, off: false
  };
}

/** Set the contingency off: the companion spell's card (no slot — paid when it was prepared), then it's gone. */
export async function fireContingency(actor, item = contingencyItem(actor), { spent = false, event = null } = {}) {
  const c = item?.flags?.[MODULE_ID]?.contingency;
  if (!actor || !c) return;
  if (!spent && game.combat?.started) {
    const b = reactionBudget(actor);
    await setReactionUsed(actor, b.used + 1).catch(() => null);
  }
  const token = actor.getActiveTokens?.(false, true)?.[0] ?? null;
  await ChatMessage.create({
    speaker: ChatMessage.getSpeaker({ actor, token }),
    content: `<div class="pkh-cont-card fired"><header><i class="fa-solid fa-bolt"></i> ${t("Contingency.Fired", { name: esc(actor.name), spell: esc(c.spellName) })}</header>
      <p><small>${esc(triggerText(c.rules ?? []))}</small></p></div>`
  });
  const spell = actor.items.get(c.spellId);
  if (spell) await spell.toMessage(event, { data: { castRank: c.castRank } }).catch(err => console.warn(`${MODULE_ID} | contingency spell`, err));
  await item.delete().catch(() => null);
}

/* ---------------- daily preparations ---------------- */

/** Rest for the Night: yesterday's contingency ends; ask about today's. */
async function onRest(actor) {
  if (!actor?.isOfType?.("character", "npc")) return;
  const old = contingencyItem(actor);
  if (old && actor.isOwner) await old.delete().catch(() => null);
  if (!setting("contingencyPrompt", true) || !hasContingency(actor)) return;
  if (maxRank(actor) < 7) return;
  const owners = ownersOf(actor).map(u => u.id);
  await ChatMessage.create({
    speaker: ChatMessage.getSpeaker({ actor }),
    whisper: owners.length ? owners : gmIds(),
    content: `<div class="pkh-cont-card"><header><i class="fa-solid fa-hourglass-half"></i> ${t("Contingency.Title")}</header>
      <p>${t("Contingency.Ask", { name: esc(actor.name) })}</p>
      <button type="button" data-cont-setup="${esc(actor.uuid)}"><i class="fa-solid fa-wand-magic-sparkles"></i> ${t("Contingency.Setup")}</button></div>`,
    flags: { [MODULE_ID]: { contingencyPrompt: { actorUuid: actor.uuid, owners } } }
  });
}

/** Open the window by itself for the player it's for (the GM only when no player owns the character). */
function autoOpen(message) {
  const p = message.flags?.[MODULE_ID]?.contingencyPrompt;
  if (!p || Date.now() - (message.timestamp ?? 0) > 60000) return;
  const mine = p.owners?.length ? p.owners.includes(game.user.id) : game.user.isGM;
  if (!mine) return;
  const actor = fromUuidSync(p.actorUuid);
  if (actor?.isOwner) openContingency(actor);
}

function wire(message, html) {
  const root = html instanceof HTMLElement ? html : html?.[0];
  if (!root) return;
  for (const btn of root.querySelectorAll("[data-cont-setup], [data-cont-fire]")) {
    const actor = fromUuidSync(btn.dataset.contSetup ?? btn.dataset.contFire);
    if (!actor?.isOwner) { btn.disabled = true; continue; }
    if (btn.dataset.contFire && !contingencyItem(actor)) { btn.disabled = true; continue; }
    btn.addEventListener("click", ev => {
      ev.preventDefault();
      if (btn.dataset.contSetup) return openContingency(actor);
      btn.disabled = true;
      return fireContingency(actor, contingencyItem(actor), { event: ev });
    });
  }
}

/* ---------------- the window ---------------- */

export function openContingency(actor) {
  actor ??= canvas?.tokens?.controlled?.[0]?.actor ?? game.pf2eKrHud?.hud?.actor;
  const c = contingencySpell(actor);
  if (!c) return ui.notifications.warn(`PF2e-KR HUD | ${t("Contingency.None")}`);
  const id = `${MODULE_ID}-contingency-${actor.id}`;
  const open = foundry.applications.instances.get(id);
  if (open) return open.bringToFront?.() ?? open;

  const avail = contingencyRanks(actor, c);
  const top = maxRank(actor);
  const state = {
    rank: avail[0] ?? 7,
    spendCont: avail.length > 0,
    rules: [{ kind: "targeted" }],
    spell: null,
    castRank: null,
    spendSpell: true
  };
  const cap = () => Math.min(7, 4 + Math.max(0, state.rank - 7));
  const rankChoices = () => (state.spendCont && avail.length ? avail : Array.from({ length: Math.max(0, top - 6) }, (_, i) => 7 + i));
  const list = () => companions(actor, cap(), c.spell.id);
  const current = () => list().find(x => x.spell.id === state.spell) ?? null;

  const conditions = () => Object.keys(CONFIG.PF2E?.conditionTypes ?? {}).filter(s => !NO_REACT.has(s))
    .map(s => [s, conditionLabel(s)]).sort((a, b) => a[1].localeCompare(b[1], game.i18n.lang));

  const ruleHtml = (rule, i) => {
    const kinds = KINDS.map(k => `<option value="${k}" ${rule.kind === k ? "selected" : ""}>${t(`Contingency.Kind.${k}`)}</option>`).join("");
    let param = "";
    if (RANGED.has(rule.kind)) param = `<label>${t("Contingency.Within")} <input type="number" data-f="range" data-i="${i}" min="5" step="5" value="${rule.range ?? (rule.kind === "ally-damaged" ? 15 : 5)}" style="width:56px"> ${t("Contingency.Feet")}</label>`;
    else if (rule.kind === "hp-low") param = `<label><input type="number" data-f="pct" data-i="${i}" min="1" max="99" value="${rule.pct ?? 50}" style="width:52px"> %</label>`;
    else if (rule.kind === "condition") param = `<select data-f="condition" data-i="${i}">${conditions().map(([s, l]) => `<option value="${s}" ${rule.condition === s ? "selected" : ""}>${esc(l)}</option>`).join("")}</select>`;
    else if (rule.kind === "custom") param = `<input type="text" data-f="text" data-i="${i}" value="${esc(rule.text ?? "")}" placeholder="${esc(t("Contingency.CustomPlaceholder"))}" style="flex:1">`;
    const note = rule.kind === "custom" ? `<small class="untracked">${t("Contingency.Untracked")}</small>` : "";
    return `<div class="pkh-cont-rule"><span class="kw">${t(i ? "Contingency.KwOr" : "Contingency.KwIf")}</span>
      <select data-f="kind" data-i="${i}">${kinds}</select>${param}
      ${state.rules.length > 1 ? `<button type="button" data-act="del" data-i="${i}" aria-label="${t("Contingency.Remove")}"><i class="fa-solid fa-xmark"></i></button>` : ""}${note}</div>`;
  };

  const spellHtml = () => {
    const opts = list();
    if (state.spell && !opts.some(x => x.spell.id === state.spell)) state.spell = null;
    if (!state.spell && opts[0]) state.spell = opts[0].spell.id;
    const cur = current();
    if (cur && !cur.ranks.includes(state.castRank)) state.castRank = cur.ranks.at(-1) ?? null;
    const groups = new Map();
    for (const x of opts) {
      if (!groups.has(x.entry.id)) groups.set(x.entry.id, { name: x.entry.name, items: [] });
      groups.get(x.entry.id).items.push(x);
    }
    const sel = [...groups.values()].map(g => `<optgroup label="${esc(g.name)}">${g.items.map(x =>
      `<option value="${x.spell.id}" ${x.spell.id === state.spell ? "selected" : ""}>${esc(x.spell.name)}${x.spell.isCantrip ? ` (${t("Contingency.Cantrip")})` : ` (${x.spell.baseRank})`}</option>`).join("")}</optgroup>`).join("");
    const free = cur && (cur.spell.isCantrip || (cur.spell.isFocusSpell && !(cur.spell.system?.cast?.focusPoints > 0)));
    return opts.length
      ? `<select name="spell">${sel}</select>
        ${cur && !cur.spell.isCantrip && !cur.spell.isFocusSpell ? `<select name="castRank">${cur.ranks.map(r => `<option value="${r}" ${r === state.castRank ? "selected" : ""}>${t("Contingency.RankN", { n: r })}</option>`).join("")}</select>` : ""}
        ${free ? "" : `<label><input type="checkbox" name="spendSpell" ${state.spendSpell ? "checked" : ""}> ${t(cur?.spell.isFocusSpell ? "Contingency.SpendFocus" : "Contingency.SpendSlot")}</label>`}`
      : `<p class="hint">${t("Contingency.NoCompanion", { cap: cap() })}</p>`;
  };

  const previewHtml = () => {
    const cur = current();
    return `<p class="pkh-cont-preview"><i class="fa-solid fa-code-branch"></i> ${esc(triggerText(state.rules))} → <b>${esc(cur?.spell.name ?? "?")}</b>${cur && state.castRank && !cur.spell.isCantrip ? ` (${t("Contingency.RankN", { n: state.castRank })})` : ""} ${t("Contingency.OnSelf")}</p>`;
  };

  const html = () => `<div class="pkh-cont">
    <p class="lead">${t("Contingency.Lead", { name: esc(actor.name) })}</p>
    <section><h4>1. ${t("Contingency.Step1")}</h4>
      <div class="row"><select name="rank">${rankChoices().map(r => `<option value="${r}" ${r === state.rank ? "selected" : ""}>${t("Contingency.RankN", { n: r })}</option>`).join("")}</select>
        <label><input type="checkbox" name="spendCont" ${state.spendCont ? "checked" : ""} ${avail.length ? "" : "disabled"}> ${t("Contingency.SpendSlot")} <small>(${esc(c.entry.name)})</small></label></div>
      <p class="hint">${avail.length ? t("Contingency.CapHint", { cap: cap() }) : t("Contingency.NoSlot")}</p></section>
    <section><h4>2. ${t("Contingency.Step2")}</h4>
      <div class="pkh-cont-rules">${state.rules.map(ruleHtml).join("")}</div>
      <button type="button" data-act="add"><i class="fa-solid fa-plus"></i> ${t("Contingency.AddOr")}</button>
      <p class="hint">${t("Contingency.RuleHint")}</p></section>
    <section><h4>3. ${t("Contingency.Step3")}</h4><div class="row spell">${spellHtml()}</div></section>
    ${previewHtml()}
    <footer><button type="button" data-act="skip">${t("Contingency.Skip")}</button>
      <button type="button" data-act="go" class="primary"><i class="fa-solid fa-hourglass-half"></i> ${t("Contingency.Go")}</button></footer>
  </div>`;

  const win = new SimpleWindow({
    id, title: t("Contingency.WindowTitle", { name: actor.name }), width: 560, html,
    onRender: (root, app) => {
      const redraw = () => { root.innerHTML = html(); };
      root.addEventListener("change", ev => {
        const el = ev.target;
        const i = Number(el.dataset.i);
        if (el.name === "rank") state.rank = Number(el.value);
        else if (el.name === "spendCont") state.spendCont = el.checked;
        else if (el.name === "spell") { state.spell = el.value; state.castRank = null; }
        else if (el.name === "castRank") state.castRank = Number(el.value);
        else if (el.name === "spendSpell") state.spendSpell = el.checked;
        else if (el.dataset.f === "kind") state.rules[i] = { kind: el.value, range: el.value === "ally-damaged" ? 15 : 5, pct: 50, condition: el.value === "condition" ? conditions()[0]?.[0] : undefined };
        else if (el.dataset.f === "range") state.rules[i].range = Math.max(5, Number(el.value) || 5);
        else if (el.dataset.f === "pct") state.rules[i].pct = Math.min(99, Math.max(1, Number(el.value) || 50));
        else if (el.dataset.f === "condition") state.rules[i].condition = el.value;
        else if (el.dataset.f === "text") state.rules[i].text = el.value;
        else return;
        if (el.dataset.f === "condition" || el.dataset.f === "text" || el.dataset.f === "range" || el.dataset.f === "pct") {
          root.querySelector(".pkh-cont-preview").outerHTML = previewHtml();
          return;
        }
        redraw();
      });
      root.addEventListener("input", ev => {
        if (ev.target.dataset.f !== "text") return;
        state.rules[Number(ev.target.dataset.i)].text = ev.target.value;
        root.querySelector(".pkh-cont-preview").outerHTML = previewHtml();
      });
      root.addEventListener("click", async ev => {
        const btn = ev.target.closest("button[data-act]");
        if (!btn) return;
        const act = btn.dataset.act;
        if (act === "add") { state.rules.push({ kind: "approach", range: 5 }); return redraw(); }
        if (act === "del") { state.rules.splice(Number(btn.dataset.i), 1); return redraw(); }
        if (act === "skip") return app.close();
        if (act !== "go") return;
        for (const r of state.rules) if (r.kind === "condition" && !r.condition) r.condition = conditions()[0]?.[0] ?? "frightened";
        btn.disabled = true;
        try {
          if (await castContingency(actor, c, state, current())) app.close();
        } finally { btn.disabled = false; }
      });
    }
  });
  return win.render({ force: true });
}

/** Pay what was chosen, put the reaction on the character, tell the owners. */
async function castContingency(actor, c, state, pick) {
  if (!pick) { ui.notifications.warn(`PF2e-KR HUD | ${t("Contingency.PickSpell")}`); return false; }
  const rules = state.rules.map(r => ({ ...r })).filter(r => r.kind !== "custom" || String(r.text ?? "").trim());
  if (!rules.length) { ui.notifications.warn(`PF2e-KR HUD | ${t("Contingency.PickTrigger")}`); return false; }
  const castRank = pick.spell.isCantrip || pick.spell.isFocusSpell ? pick.spell.rank : (state.castRank ?? pick.ranks.at(-1));
  const notes = [];
  if (state.spendCont) {
    try { if (!(await c.entry.consume(c.spell, state.rank))) notes.push(t("Contingency.NotSpent", { what: c.spell.name })); }
    catch (_) { notes.push(t("Contingency.NotSpent", { what: c.spell.name })); }
  }
  const free = pick.spell.isCantrip || (pick.spell.isFocusSpell && !(pick.spell.system?.cast?.focusPoints > 0));
  if (state.spendSpell && !free) {
    try { if (!(await pick.entry.consume(pick.spell, castRank))) notes.push(t("Contingency.NotSpent", { what: pick.spell.name })); }
    catch (_) { notes.push(t("Contingency.NotSpent", { what: pick.spell.name })); }
  }
  const old = contingencyItem(actor);
  if (old) await old.delete().catch(() => null);
  const when = esc(triggerText(rules));
  const tracked = rules.some(r => r.kind !== "custom");
  const [item] = await actor.createEmbeddedDocuments("Item", [{
    type: "action", name: t("Contingency.ItemName", { spell: pick.spell.name }), img: c.spell.img,
    system: {
      slug: DONE_SLUG, actionType: { value: "reaction" }, actions: { value: null }, category: "defensive",
      traits: { value: ["concentrate"], rarity: "common" },
      description: { value: `<p><strong>${t("Contingency.Trigger")}</strong> ${when}</p>
        <p>@UUID[${pick.spell.uuid}]{${esc(pick.spell.name)}}${pick.spell.isCantrip ? "" : ` — ${t("Contingency.RankN", { n: castRank })}`} ${t("Contingency.OnSelf")}</p>
        <hr><p><em>${t("Contingency.ItemFoot", { rank: state.rank })}</em></p>` }
    },
    flags: { [MODULE_ID]: { contingency: { rules, spellId: pick.spell.id, spellName: pick.spell.name, castRank, rank: state.rank, at: game.time.worldTime } } }
  }]);
  const owners = ownersOf(actor).map(u => u.id);
  await ChatMessage.create({
    speaker: ChatMessage.getSpeaker({ actor }),
    whisper: [...new Set([...owners, ...gmIds()])],
    content: `<div class="pkh-cont-card ready"><header><i class="fa-solid fa-hourglass-half"></i> ${t("Contingency.Ready", { name: esc(actor.name) })}</header>
      <p><b>${t("Contingency.Trigger")}</b> ${when}${tracked ? "" : ` <small>(${t("Contingency.Untracked")})</small>`}</p>
      <p><b>${esc(pick.spell.name)}</b>${pick.spell.isCantrip ? "" : ` · ${t("Contingency.RankN", { n: castRank })}`} ${t("Contingency.OnSelf")}</p>
      ${notes.length ? `<p class="warn">${notes.map(esc).join("<br>")}</p>` : ""}
      <button type="button" data-cont-fire="${esc(actor.uuid)}"><i class="fa-solid fa-bolt"></i> ${t("Contingency.FireNow")}</button></div>`
  });
  if (!item) return false;
  ui.notifications.info(`PF2e-KR HUD | ${t("Contingency.Done", { name: actor.name })}`);
  return true;
}

/* ------------------------------------------------------------------------ */

export function registerContingencySettings() {
  game.settings.register(MODULE_ID, "contingencyPrompt", {
    name: "PKH.Settings.contingencyPrompt.Name", hint: "PKH.Settings.contingencyPrompt.Hint",
    scope: "world", config: true, type: Boolean, default: true
  });
}

export function initContingency() {
  Hooks.on("pf2e.restForTheNight", actor => { onRest(actor).catch(err => console.warn(`${MODULE_ID} | contingency`, err)); });
  Hooks.on("createChatMessage", autoOpen);
  Hooks.on("renderChatMessageHTML", wire);
  game.pf2eKrHud = { ...(game.pf2eKrHud ?? {}), openContingency, fireContingency };
}
