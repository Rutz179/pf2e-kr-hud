import { MODULE_ID, esc, localizedDoc, setting, signed } from "./shared.mjs";
import { actorLores, rollLore } from "./lore.mjs";

/* ======================================================================== *
 * Skills page (like the old PF2e HUD's): every skill with its actions.
 *
 *  - Click a skill's name: a plain skill check.
 *  - Click an action: that action (PF2e's own action macro when there is one,
 *    otherwise the skill check with the action's roll options).
 *  - Chips: the action's variants (Create a Diversion, Perform …) or, for
 *    attack-trait actions, the 2nd/3rd attack with the multiple attack penalty.
 *  - Actions that need training are dimmed when untrained ("미훈련 숨기기"
 *    hides them). Hover an action for its full description.
 *  - Follow the Expert (exploration) toggles its effect at the top.
 * The action list follows the PF2e HUD module's table (MIT), names and texts
 * come from the compendium, so the translation module translates them.
 * ======================================================================== */

const A = id => `Compendium.pf2e.actionspf2e.Item.${id}`;
const SF = id => `Compendium.sf2e-anachronism.actions.Item.${id}`;
const FOLLOW_THE_EXPERT = A("tfa4Sh7wcxCEqL29");
const FOLLOW_THE_EXPERT_EFFECT = "Compendium.pf2e.other-effects.Item.VCSpuc3Tf3XWMkd3";
const CHIRURGEON = "Compendium.pf2e.classfeatures.Item.eNZnx4LISDNftbx2";
const UNTRAINED_IMPROVISATION = [
  "Compendium.pf2e.feats-srd.Item.KcbSxOPYC5CUqbZQ",
  "Compendium.pf2e.feats-srd.Item.73JyUrJnH3nOQJM5",
  "Compendium.pf2e.feats-srd.Item.jNrpvEqfncdGZPak",
  "Compendium.pf2e.feats-srd.Item.TOyqtUUnOkOLl1Pm"
];

const SHARED = {
  "recall-knowledge": { cost: 1, uuid: A("1OagaWtBpVXExToo") },
  "decipher-writing": { uuid: A("d9gbpiQjChYDYA2L"), trained: true },
  "identify-magic": { uuid: A("eReSHVEPCsdkSL4G"), trained: true },
  "learn-a-spell": { uuid: A("Q5iIYCFdqJFM31GW"), trained: true },
  "disable-device": { cost: 2, uuid: A("cYdz2grcOcRt4jk6"), trained: true },
  subsist: { uuid: A("49y9Ec4bDii8pcD3") }
};

const MAP_AGILE = { agile: true };
const MAP_PLAIN = { agile: false };
const GROUPS = [
  ["perception", [{ key: "seek", cost: 1, uuid: A("BlAOM2X92SI6HMtJ") }, { key: "sense-motive", cost: 1, uuid: A("1xRFPTFtWtGJ9ELw") }]],
  ["acrobatics", [
    { key: "balance", cost: 1, uuid: A("M76ycLAqHoAgbcej") },
    { key: "tumble-through", cost: 1, uuid: A("21WIfSu7Xd7uKqV8") },
    { key: "maneuver-in-flight", cost: 1, uuid: A("Qf1ylAbdVi1rkc8M"), trained: true },
    { key: "squeeze", uuid: A("kMcV8e5EZUxa6evt"), trained: true }]],
  ["arcana", [{ key: "borrow-arcane-spell", uuid: A("OizxuPb44g3eHPFh"), trained: true }, "recall-knowledge", "decipher-writing", "identify-magic", "learn-a-spell"]],
  ["athletics", [
    { key: "climb", cost: 1, uuid: A("pprgrYQ1QnIDGZiy") },
    { key: "force-open", cost: 1, uuid: A("SjmKHgI7a5Z9JzBx"), map: MAP_PLAIN },
    { key: "grapple", cost: 1, uuid: A("PMbdMWc2QroouFGD"), map: MAP_AGILE },
    { key: "high-jump", cost: 2, uuid: A("2HJ4yuEFY1Cast4h") },
    { key: "long-jump", cost: 2, uuid: A("JUvAvruz7yRQXfz2") },
    { key: "reposition", cost: 1, uuid: A("lOE4yjUnETTdaf2T"), map: MAP_AGILE },
    { key: "shove", cost: 1, uuid: A("7blmbDrQFNfdT731"), map: MAP_AGILE },
    { key: "swim", cost: 1, uuid: A("c8TGiZ48ygoSPofx") },
    { key: "trip", cost: 1, uuid: A("ge56Lu1xXVFYUnLP"), map: MAP_AGILE },
    { key: "disarm", cost: 1, uuid: A("Dt6B1slsBy8ipJu9"), trained: true, map: MAP_AGILE }]],
  ["computers", [
    { key: "access-infosphere", uuid: SF("Yn4jLPVWVE1vtAaF") },
    { key: "operate-device", uuid: SF("wWtBcshahm11stMY") },
    { key: "hack", trained: true, uuid: SF("RF8xNJ8QsMwogerB") },
    "recall-knowledge", "decipher-writing", "disable-device"]],
  ["crafting", [
    { key: "repair", uuid: A("bT3skovyLUtP22ME") },
    { key: "craft", trained: true, uuid: A("rmwa3OyhTZ2i2AHl") },
    { key: "identify-alchemy", trained: true, uuid: A("Q4kdWVOf2ztIBFg1") },
    "recall-knowledge"]],
  ["deception", [
    { key: "create-a-diversion", cost: 1, uuid: A("GkmbTGfg8KcgynOA"), variants: ["distracting-words", "gesture", "trick"] },
    { key: "impersonate", uuid: A("AJstokjdG6iDjVjE") },
    { key: "lie", uuid: A("ewwCglB7XOPLUz72") },
    { key: "feint", cost: 1, trained: true, uuid: A("QNAVeNKtHA0EUw4X") }]],
  ["diplomacy", [
    { key: "bonMot", cost: 1, uuid: "Compendium.pf2e.feats-srd.Item.0GF2j54roPFIDmXf", hasOption: "feat:bon-mot" },
    { key: "gather-information", uuid: A("plBGdZhqq5JBl1D8") },
    { key: "make-an-impression", uuid: A("OX4fy22hQgUHDr0q") },
    { key: "request", cost: 1, uuid: A("DCb62iCBrJXy0Ik6") }]],
  ["intimidation", [{ key: "coerce", uuid: A("tHCqgwjtQtzNqVvd") }, { key: "demoralize", cost: 1, uuid: A("2u915NdUyQan6uKF") }]],
  ["medicine", [
    { key: "administer-first-aid", cost: 2, variants: ["stabilize", "stop-bleeding"], rollOptions: ["administer-first-aid"], uuid: A("MHLuKy4nQO2Z4Am1") },
    { key: "treat-disease", trained: true, uuid: A("TC7OcDa7JlWbqMaN") },
    { key: "treat-poison", cost: 1, trained: true, uuid: A("KjoCEEmPGTeFE4hh") },
    { key: "treatWounds", trained: true, uuid: A("1kGNdIIhuglAjIp9") },
    "recall-knowledge"]],
  ["nature", [
    { key: "command-an-animal", cost: 1, uuid: A("q9nbyIF0PEBqMtYe") },
    { key: "treatWounds", trained: true, label: "PF2E.Actions.TreatWounds.Label", uuid: "Compendium.pf2e.feats-srd.Item.WC4xLBGmBsdOdHWu", hasOption: "feat:natural-medicine" },
    "recall-knowledge", "identify-magic", "learn-a-spell"]],
  ["occultism", ["recall-knowledge", "decipher-writing", "identify-magic", "learn-a-spell"]],
  ["performance", [{ key: "perform", cost: 1, uuid: A("EEDElIyin4z60PXx"),
    variants: ["acting", "comedy", "dance", "oratory", "singing", "keyboards", "percussion", "strings", "winds"] }]],
  ["piloting", [
    "recall-knowledge",
    { key: "drive", trained: true, uuid: A("uS3qDAgOkZ7b8ERL"), variants: ["drive1", "drive2", "drive3"] },
    { key: "navigate", trained: true, uuid: SF("hsUKPqTdAvWwsqH2") },
    { key: "plot-course", trained: true, uuid: SF("LXqcXRayK58inaKoo") },
    { key: "run-over", cost: 3, trained: true, uuid: A("lID4rJHAVZB6tavf") },
    { key: "stop", cost: 1, trained: true, uuid: A("9gDMkIfDifh61yLz") },
    { key: "stunt", cost: 1, trained: true, uuid: SF("7KMyRISNqp7JTzMn"), variants: ["back-off", "evade", "flip-and-burn", "barrel-roll", "flyby", "drift", "turn-in-place"] },
    { key: "take-control", cost: 1, trained: true, uuid: A("yh9O9BQjwWrAIiuf") }]],
  ["religion", ["recall-knowledge", "decipher-writing", "identify-magic", "learn-a-spell"]],
  ["society", [{ key: "create-forgery", trained: true, uuid: A("ftG89SjTSa9DYDOD") }, "recall-knowledge", "subsist", "decipher-writing"]],
  ["stealth", [
    { key: "avoid-notice", uuid: A("IE2nThCmoyhQA0Jn") },
    { key: "conceal-an-object", cost: 1, uuid: A("qVNVSmsgpKFGk9hV") },
    { key: "hide", cost: 1, uuid: A("XMcnh4cSI32tljXa") },
    { key: "sneak", cost: 1, uuid: A("VMozDqMMuK5kpoX4") }]],
  ["survival", [
    { key: "sense-direction", uuid: A("fJImDBQfqfjKJOhk") }, "subsist",
    { key: "cover-tracks", trained: true, uuid: A("SB7cMECVtE06kByk") },
    { key: "track", trained: true, uuid: A("EA5vuSgJfiHH7plD") }]],
  ["thievery", [
    { key: "palm-an-object", cost: 1, uuid: A("ijZ0DDFpMkWqaShd") },
    { key: "steal", cost: 1, uuid: A("RDXXE7wMrSPCLv5k") }, "disable-device",
    { key: "pick-a-lock", cost: 2, trained: true, uuid: A("2EE4aF4SZpYf0R6H") }]]
];

const GLYPH = { 1: "1", 2: "2", 3: "3", reaction: "r", free: "f" };
const glyph = cost => (GLYPH[cost] ? `<span class="action-glyph">${GLYPH[cost]}</span>` : "");

/* ---------------- the table, resolved once (names and texts from the compendium) ---------------- */

let groups = null;
let preparing = null;

function sfUuid(uuid) {
  return game.system.id === "sf2e" ? uuid.replace("pf2e.actionspf2e", "sf2e.actions").replace("sf2e-anachronism", "sf2e") : uuid;
}

async function prepare() {
  if (groups) return groups;
  preparing ??= (async () => {
    const out = [];
    for (const [statistic, list] of GROUPS) {
      if (statistic !== "perception" && !(statistic in (CONFIG.PF2E?.skills ?? {}))) continue;
      const actions = [];
      for (const raw of list) {
        const data = typeof raw === "string" ? { key: raw, ...SHARED[raw] } : raw;
        let item = null;
        try { item = await localizedDoc(sfUuid(data.uuid)); } catch (_) { item = null; }
        if (!item) continue;
        actions.push({ ...data, statistic, item, label: data.label ? game.i18n.localize(data.label) : item.name });
      }
      actions.sort((a, b) => a.label.localeCompare(b.label, game.i18n.lang));
      out.push({ statistic, actions });
    }
    groups = out;
    return out;
  })();
  return preparing;
}

/* ---------------- rolling ---------------- */

function mapValue(map, agile) {
  return map === 1 ? (agile ? -4 : -5) : map === 2 ? (agile ? -8 : -10) : 0;
}

function variantLabel(key, slug) {
  const name = game.pf2e?.actions?.get?.(key)?.variants?.get?.(slug)?.name;
  return name ? game.i18n.localize(name) : slug;
}

async function rollAction(actor, entry, event, { variant = null, map = 0 } = {}) {
  const coll = game.pf2e?.actions;
  const action = coll?.get?.(entry.key) ?? coll?.[entry.key];
  const options = {
    event, actors: [actor],
    variant: variant ?? undefined,
    rollOptions: (entry.rollOptions ?? []).map(x => `action:${x}`),
    modifiers: []
  };
  if (variant) options.rollOptions.push(...options.rollOptions.map(x => `${x}:${variant}`));
  if (map) options.modifiers.push(new game.pf2e.Modifier({ label: "PF2E.MultipleAttackPenalty", modifier: mapValue(map, entry.map?.agile) }));
  try {
    if (!action) return await actor.getStatistic?.(entry.statistic)?.roll(options);
    if (typeof action.use === "function") return await action.use({ ...options, statistic: entry.statistic });
    if (typeof action === "function") return await action({ ...options, skill: entry.statistic });
  } catch (err) {
    console.warn(`${MODULE_ID} | skill action ${entry.key}`, err);
    ui.notifications.warn(`PF2e-KR HUD | ${entry.label}: 굴리지 못했습니다 (${err.message ?? err})`);
  }
}

/* ---------------- what the actor has ---------------- */

function sourceOf(item) {
  return item?._stats?.compendiumSource ?? item?.flags?.core?.sourceId ?? item?.sourceId ?? null;
}
function hasSource(actor, uuids, type) {
  const set = new Set(Array.isArray(uuids) ? uuids : [uuids]);
  return (type ? actor.itemTypes?.[type] ?? [] : actor.items).some(i => set.has(sourceOf(i)));
}
function rankLabel(rank) {
  return game.i18n.localize(`PF2E.ProficiencyLevel${rank ?? 0}`);
}
function skillLabel(statistic, stat) {
  if (statistic === "perception") return game.i18n.localize("PF2E.PerceptionLabel");
  const cfg = CONFIG.PF2E.skills?.[statistic];
  return game.i18n.localize(typeof cfg === "string" ? cfg : cfg?.label ?? stat?.label ?? statistic);
}

/* ---------------- the window ---------------- */

class SkillsPage {
  constructor() {
    this.el = null;
    this.card = null;
    this.actor = null;
    this.descCache = new Map();
    this.loreSelection = new Map();
  }

  get open() { return !!this.el && !this.el.classList.contains("hidden"); }

  mount() {
    this.el = document.createElement("section");
    this.el.id = "pkh-skills";
    this.el.className = "hidden";
    document.body.appendChild(this.el);
    this.card = document.createElement("div");
    this.card.id = "pkh-skill-card";
    this.card.className = "hidden";
    document.body.appendChild(this.card);
    this.el.addEventListener("click", ev => this._onClick(ev));
    this.el.addEventListener("pointerover", ev => this._hover(ev));
    this.el.addEventListener("pointerout", ev => { if (ev.target.closest("[data-desc]")) this._unhover(); });
    this.el.addEventListener("change", ev => {
      if (ev.target.name === "hideUntrained") game.settings.set(MODULE_ID, "hudSkillsHideUntrained", ev.target.checked).then(() => this.render());
      if (ev.target.name === "lorePick") this.loreSelection.set(this.actor?.uuid, ev.target.value);
    });
    // Esc closes it only when nothing else (a roll dialog) has the keyboard.
    document.addEventListener("keydown", ev => {
      if (ev.key !== "Escape" || !this.open) return;
      if (ev.target instanceof HTMLElement && ev.target.closest?.(".application, .app, dialog, input, textarea, select")) return;
      if (document.querySelector("dialog[open], .application.dialog")) return;
      this.close();
    });
    const rerender = doc => { if (this.open && (doc === this.actor || doc?.parent === this.actor || doc?.actor === this.actor)) this.scheduleRender(); };
    Hooks.on("updateActor", rerender);
    for (const h of ["createItem", "updateItem", "deleteItem"]) Hooks.on(h, rerender);
  }

  toggle(actor) {
    if (this.open && this.actor === actor) return this.close();
    this.actor = actor;
    this.el.classList.remove("hidden");
    this.render();
  }

  close() {
    this.el?.classList.add("hidden");
    this.card?.classList.add("hidden");
    game.pf2eKrHud?.hud?.scheduleRender?.();
  }

  scheduleRender() {
    clearTimeout(this._t);
    this._t = setTimeout(() => this.render(), 80);
  }

  async render() {
    const actor = this.actor;
    if (!actor || !this.el) return;
    if (!groups) this.el.innerHTML = `<div class="pkh-sk-loading"><i class="fa-solid fa-spinner fa-spin"></i> 기술 목록 불러오는 중…</div>`;
    const list = await prepare();
    const hide = setting("hudSkillsHideUntrained", false) === true;
    const isPC = actor.type === "character";
    const improv = isPC && hasSource(actor, UNTRAINED_IMPROVISATION, "feat");
    const options = actor.rollOptions?.all ?? {};

    const sections = list.map(({ statistic, actions }) => {
      const stat = actor.getStatistic?.(statistic) ?? (statistic === "perception" ? actor.perception : actor.skills?.[statistic]);
      if (!stat && !isPC) return "";
      const rank = Number(stat?.rank ?? 0);
      const proficient = !isPC || improv || !!stat?.proficient || rank > 0
        || (statistic === "medicine" && hasSource(actor, CHIRURGEON, "feat"));
      const rows = actions.map(a => {
        if (a.hasOption && !(a.hasOption in options)) return "";
        const dim = a.trained && !proficient;
        if (dim && hide) return "";
        const chips = a.map
          ? [0, 1, 2].map(m => `<button type="button" class="chip" data-map="${m}" data-tooltip="${m ? `${esc(game.i18n.localize("PF2E.MultipleAttackPenalty"))} ${mapValue(m, a.map.agile)} (${m + 1}번째 공격)` : "첫 공격 (페널티 없음)"}">${m ? `${m + 1}회 ${String(mapValue(m, a.map.agile)).replace("-", "−")}` : "보통"}</button>`).join("")
          : (a.variants ?? []).map(v => `<button type="button" class="chip" data-variant="${esc(v)}">${esc(variantLabel(a.key, v))}</button>`).join("");
        return `<div class="pkh-sk-act ${dim ? "dim" : ""}" data-stat="${statistic}" data-key="${esc(a.key)}" data-desc="${esc(a.uuid)}">
          <button type="button" class="name" data-use="1">${esc(a.label)} ${glyph(a.cost)}</button>
          ${chips ? `<div class="chips">${chips}</div>` : ""}</div>`;
      }).join("");
      return `<section class="pkh-sk">
        <h3 data-roll="${statistic}" data-tooltip="${esc(skillLabel(statistic, stat))} 판정 굴림">
          <span class="mod">${esc(signed(stat?.mod ?? 0))}</span><span class="lbl">${esc(skillLabel(statistic, stat))}</span>
          ${isPC ? `<span class="rank r${rank}">${esc(rankLabel(rank))}</span>` : ""}</h3>
        ${rows}</section>`;
    }).join("");

    const loreOptions = actorLores(actor);
    const selectedLore = this.loreSelection.get(actor.uuid);
    const lores = loreOptions.length ? `<div class="pkh-lore-picker"><select name="lorePick" aria-label="캐릭터의 지식">
      ${loreOptions.map(lore => `<option value="${esc(lore.slug)}" ${lore.slug === selectedLore ? "selected" : ""}>${esc(lore.label)} (${lore.mod === null ? "?" : esc(signed(lore.mod))})</option>`).join("")}</select>
      <button type="button" data-roll-lore="1"><i class="fa-solid fa-dice-d20"></i> 굴리기</button></div>` : "";

    const follow = this.followDoc ?? fromUuidSync(FOLLOW_THE_EXPERT, { strict: false });
    if (!this.followDoc) localizedDoc(FOLLOW_THE_EXPERT).then(d => { if (d) { this.followDoc = d; this.scheduleRender(); } });
    const following = hasSource(actor, FOLLOW_THE_EXPERT_EFFECT, "effect");
    this.el.innerHTML = `
      <header>
        <strong>${esc(actor.name)}</strong> <span class="sub">기술</span>
        <label class="hide"><input type="checkbox" name="hideUntrained" ${hide ? "checked" : ""}> 미훈련 행동 숨기기</label>
        ${follow ? `<button type="button" class="follow ${following ? "on" : ""}" data-follow="1" data-desc="${FOLLOW_THE_EXPERT}"
            data-tooltip="${following ? "켜짐 — 눌러서 끄기" : "탐험 활동: 눌러서 효과 켜기"}"><i class="fa-solid fa-person-walking-arrow-right"></i> ${esc(follow.name)}</button>` : ""}
        <button type="button" class="close" data-close="1" aria-label="닫기"><i class="fa-solid fa-xmark"></i></button>
      </header>
      <div class="pkh-sk-cols">${sections}${lores ? `<section class="pkh-sk lores"><h4>${esc(game.i18n.localize("PF2E.LoreSkillsHeader") === "PF2E.LoreSkillsHeader" ? "지식 기술" : game.i18n.localize("PF2E.LoreSkillsHeader"))}</h4>${lores}</section>` : ""}</div>`;
    this.position();
  }

  position() {
    const hud = document.getElementById("pkh-hud");
    const board = document.getElementById("board")?.getBoundingClientRect?.();
    const left = board ? board.left : 0;
    const width = board ? board.width : window.innerWidth;
    const bottomGap = hud && !hud.classList.contains("hidden") ? window.innerHeight - hud.getBoundingClientRect().top + 8 : 12;
    this.el.style.left = `${Math.round(left + width / 2)}px`;
    this.el.style.bottom = `${Math.round(bottomGap)}px`;
    this.el.style.maxWidth = `${Math.round(Math.min(1260, width - 40))}px`;
    this.el.style.maxHeight = `${Math.round(Math.max(240, window.innerHeight - bottomGap - 80))}px`;
  }

  async _onClick(ev) {
    const actor = this.actor;
    if (!actor) return;
    if (ev.target.closest("[data-close]")) return this.close();
    if (ev.target.closest("[data-roll-lore]")) {
      const slug = this.el.querySelector("[name=lorePick]")?.value;
      return rollLore(actor, slug, ev);
    }
    const roll = ev.target.closest("[data-roll]");
    if (roll) return actor.getStatistic?.(roll.dataset.roll)?.roll({ event: ev });
    if (ev.target.closest("[data-follow]")) return toggleFollow(actor);
    const row = ev.target.closest(".pkh-sk-act");
    if (!row) return;
    const entry = groups?.find(g => g.statistic === row.dataset.stat)?.actions.find(a => a.key === row.dataset.key);
    if (!entry) return;
    const chip = ev.target.closest(".chip");
    if (chip) return rollAction(actor, entry, ev, { variant: chip.dataset.variant ?? null, map: Number(chip.dataset.map) || 0 });
    if (ev.target.closest("[data-use]")) return rollAction(actor, entry, ev);
  }

  _hover(ev) {
    const node = ev.target.closest("[data-desc]");
    if (!node) return;
    clearTimeout(this._hideT);
    clearTimeout(this._showT);
    this._showT = setTimeout(() => this._showDesc(node), 650);
  }

  _unhover() {
    clearTimeout(this._showT);
    clearTimeout(this._hideT);
    this._hideT = setTimeout(() => this.card.classList.add("hidden"), 150);
  }

  async _showDesc(node) {
    if (!node.isConnected) return;
    const uuid = node.dataset.desc;
    let html = this.descCache.get(uuid);
    if (html === undefined) {
      const item = await localizedDoc(sfUuid(uuid)).catch(() => null);
      const Editor = foundry.applications?.ux?.TextEditor?.implementation ?? globalThis.TextEditor;
      const raw = item?.system?.description?.value ?? "";
      html = raw ? await Editor.enrichHTML(raw, { relativeTo: item, rollData: this.actor?.getRollData?.() ?? {} }).catch(() => raw) : "";
      html = `<header><img src="${esc(item?.img ?? "")}" alt=""><strong>${esc(item?.name ?? "")}</strong></header>${traitsHtml(item)}<div class="desc">${html || "<p>설명이 없습니다.</p>"}</div>`;
      this.descCache.set(uuid, html);
    }
    if (!node.isConnected || !this.open) return;
    this.card.innerHTML = html;
    this.card.classList.remove("hidden");
    const box = node.getBoundingClientRect();
    const card = this.card.getBoundingClientRect();
    const right = box.right + 10 + card.width < window.innerWidth;
    const left = right ? box.right + 10 : Math.max(8, box.left - card.width - 10);
    this.card.style.left = `${Math.round(left)}px`;
    this.card.style.top = `${Math.round(Math.min(window.innerHeight - card.height - 8, Math.max(8, box.top - 20)))}px`;
  }
}

function traitsHtml(item) {
  const traits = item?.system?.traits?.value ?? [];
  if (!traits.length) return "";
  const label = t => game.i18n.localize(CONFIG.PF2E?.actionTraits?.[t] ?? CONFIG.PF2E?.featTraits?.[t] ?? t);
  return `<div class="traits">${traits.map(t => `<span>${esc(label(t))}</span>`).join("")}</div>`;
}

async function toggleFollow(actor) {
  const existing = (actor.itemTypes?.effect ?? []).find(i => sourceOf(i) === FOLLOW_THE_EXPERT_EFFECT);
  if (existing) return existing.delete();
  const item = await fromUuid(FOLLOW_THE_EXPERT_EFFECT).catch(() => null);
  if (!item) return ui.notifications.warn("PF2e-KR HUD | '전문가 따르기' 효과를 찾지 못했습니다.");
  const source = item.toObject();
  source._stats = { ...(source._stats ?? {}), compendiumSource: FOLLOW_THE_EXPERT_EFFECT };
  await actor.createEmbeddedDocuments("Item", [source]);
}

/* ---------------- wiring ---------------- */

let page = null;

export function registerSkillsSettings() {
  game.settings.register(MODULE_ID, "hudSkillsHideUntrained", { scope: "client", config: false, type: Boolean, default: false });
}

export function openSkills(actor) {
  if (!actor) return;
  if (!page) { page = new SkillsPage(); page.mount(); }
  page.toggle(actor);
}

export function skillsOpenFor(actor) {
  return !!page?.open && page.actor === actor;
}

export function initSkills() {
  // Resolve the table in the background once the world is ready (the first open is instant then).
  setTimeout(() => prepare().catch(() => null), 4000);
  Hooks.on("controlToken", () => { if (page?.open) { const a = game.pf2eKrHud?.hud?.actor; if (a && a !== page.actor) { page.actor = a; page.render(); } } });
  window.addEventListener("resize", () => page?.open && page.position());
}
