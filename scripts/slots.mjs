import { MODULE_ID, SLOTS_PER_ROW, TOTAL_ROWS, SimpleWindow, esc, localizeMaybe, setting, signed } from "./shared.mjs";
import { itemActionCost, markNextUse } from "./economy.mjs";

/* ------------------------------------------------------------------------ *
 * Storage
 *
 * Slots live in flags on the *base* actor, so every unlinked goblin token
 * shares the GM's favourites. Items are referenced by id (not uuid) and
 * resolved against whichever actor is displayed, which works for both the
 * world actor and its synthetic token actors.
 *
 *   flags.pf2e-kr-hud.slots   = { "0": [10 entries|null], ..., "11": [...] }
 *   flags.pf2e-kr-hud.locked  = true | false   (BG3-style lock, default true)
 *   flags.pf2e-kr-hud.editors = [userId, ...]  (extra users the GM allows)
 *
 * Entry shapes:
 *   { type: "macro",  uuid }
 *   { type: "item",   id, auto? }      auto = placed by the infused-item helper
 *   { type: "strike", slug }
 *   { type: "skill",  slug }           "perception" or a key of actor.skills
 *   { type: "action", slug }           a key of game.pf2e.actions
 * ------------------------------------------------------------------------ */

export function storageActor(actor) {
  if (!actor) return null;
  if (actor.isToken && !actor.token?.actorLink) return game.actors.get(actor.id) ?? actor;
  return actor;
}

export function readSlots(actor) {
  const stored = storageActor(actor)?.getFlag(MODULE_ID, "slots") ?? {};
  const rows = [];
  for (let r = 0; r < TOTAL_ROWS; r++) {
    const row = Array.isArray(stored[r]) ? stored[r] : [];
    rows.push(Array.from({ length: SLOTS_PER_ROW }, (_, c) => row[c] ?? null));
  }
  return rows;
}

export async function writeRows(actor, changedRows) {
  const target = storageActor(actor);
  if (!target) return;
  const update = {};
  for (const [r, row] of Object.entries(changedRows)) update[`flags.${MODULE_ID}.slots.${r}`] = row;
  await target.update(update);
}

export async function setSlot(actor, row, col, entry) {
  const rows = readSlots(actor);
  rows[row][col] = entry;
  await writeRows(actor, { [row]: rows[row] });
}

export async function swapSlots(actor, a, b) {
  const rows = readSlots(actor);
  const tmp = rows[a.row][a.col];
  rows[a.row][a.col] = rows[b.row][b.col];
  rows[b.row][b.col] = tmp;
  const changed = { [a.row]: rows[a.row] };
  changed[b.row] = rows[b.row];
  await writeRows(actor, changed);
}

export function isLocked(actor) {
  return storageActor(actor)?.getFlag(MODULE_ID, "locked") !== false;
}

/* ------------------------------------------------------------------------ *
 * Permissions
 *
 *  - Using a slot: anyone who owns the actor.
 *  - Rearranging / locking: the GM, the user whose *assigned character* this
 *    is, or a user the GM explicitly listed (summons, eidolons, companions).
 *    Other co-owners can use the bar but cannot change it.
 * ------------------------------------------------------------------------ */

export function canEditSlots(actor) {
  const base = storageActor(actor);
  if (!base?.isOwner) return false;
  if (game.user.isGM) return true;
  if (game.user.character?.id === base.id) return true;
  return (base.getFlag(MODULE_ID, "editors") ?? []).includes(game.user.id);
}

/* ------------------------------------------------------------------------ *
 * Resolution: entry -> what the slot shows
 * ------------------------------------------------------------------------ */

const TYPE_ICONS = {
  skill: "fa-solid fa-dice-d20",
  action: "fa-solid fa-hand-fist",
  strike: "fa-solid fa-khanda",
  macro: "fa-solid fa-terminal"
};

function systemActions() {
  const acts = game.pf2e?.actions;
  if (!acts || typeof acts.get !== "function") return null;
  return acts;
}

/** An item slot survives PF2e deleting and re-creating the item (new id). */
export function findItem(actor, entry) {
  const items = actor?.items;
  if (!items || !entry) return null;
  const byId = items.get(entry.id);
  if (byId) return byId;
  if (entry.sourceId) {
    const bySource = items.find(i => (i._stats?.compendiumSource ?? i.flags?.core?.sourceId) === entry.sourceId);
    if (bySource) return bySource;
  }
  if (entry.slug) return items.find(i => i.slug === entry.slug && i.type === (entry.itemType ?? i.type)) ?? null;
  return null;
}

export function itemEntry(item, extra = {}) {
  return {
    type: "item", id: item.id, slug: item.slug ?? null, name: item.name, img: item.img, itemType: item.type,
    sourceId: item._stats?.compendiumSource ?? item.flags?.core?.sourceId ?? null, ...extra
  };
}

function findStrike(actor, slug) {
  return (actor?.system?.actions ?? []).find(s => s?.slug === slug) ?? null;
}

function findStatistic(actor, slug) {
  if (slug === "perception") return actor?.perception ?? null;
  return actor?.skills?.[slug] ?? null;
}

function focusPoints(actor) {
  return Number(actor?.system?.resources?.focus?.value ?? 0);
}

/**
 * "+8", "+3", "−2" for the three attack variants of a strike. Computed from
 * the strike total and the agile trait rather than parsed from the variant
 * labels, whose wording differs between PF2e versions and languages.
 */
export function strikeMapValues(strike) {
  const base = Number(strike?.totalModifier);
  if (!Number.isFinite(base)) return [];
  const traits = strike?.item?.system?.traits?.value ?? [];
  const agile = traits.includes("agile");
  const count = Math.min(3, strike?.variants?.length ?? 3);
  return [0, agile ? 4 : 5, agile ? 8 : 10].slice(0, count).map(pen => signed(base - pen).replace("-", "−"));
}

export function resolveSlot(actor, entry, opts = {}) {
  if (!entry) return null;
  const view = { entry, label: "", img: null, icon: null, badge: null, disabled: false, broken: false, auto: !!entry.auto };

  switch (entry.type) {
    case "macro": {
      const macro = entry.uuid ? fromUuidSync(entry.uuid) : null;
      if (!macro) return { ...view, broken: true, label: "삭제된 매크로", icon: TYPE_ICONS.macro };
      return { ...view, label: macro.name, img: macro.img, icon: macro.img ? null : TYPE_ICONS.macro };
    }
    case "item": {
      const item = findItem(actor, entry);
      if (!item) {
        // Used up (PF2e deletes empty consumables) or not prepared today:
        // keep the slot greyed so it lights up again when the item returns.
        if (entry.slug || entry.name) {
          return { ...view, disabled: true, label: entry.name ?? entry.slug, img: entry.img ?? null,
            icon: entry.img ? null : "fa-solid fa-flask", badge: 0 };
        }
        return { ...view, broken: true, label: "없는 아이템" };
      }
      view.label = item.name;
      view.img = item.img;
      const backing = (actor.system?.actions ?? []).find(st => st?.item?.id === item.id);
      if (backing && strikeUnavailable(backing)) view.disabled = true;
      if (item.type === "consumable") {
        const qty = Number(item.quantity ?? item.system?.quantity ?? 1);
        const uses = item.uses ?? item.system?.uses;
        const usesLeft = uses && Number(uses.max) > 1 ? Number(uses.value) : null;
        view.badge = usesLeft ?? (qty > 1 || qty === 0 ? qty : null);
        view.disabled = qty <= 0 || usesLeft === 0;
      } else if (item.type === "spell") {
        if (item.isFocusSpell && !item.isCantrip && focusPoints(actor) <= 0) view.disabled = true;
        view.badge = item.isCantrip ? null : (item.rank ?? null);
      } else if (item.isOfType?.("physical")) {
        const carry = item.system?.equipped?.carryType;
        if (carry === "dropped") view.disabled = true;
      }
      return view;
    }
    case "strike": {
      const strike = findStrike(actor, entry.slug);
      if (!strike) return { ...view, broken: true, label: entry.slug, icon: TYPE_ICONS.strike };
      view.label = strike.label ?? strike.item?.name ?? entry.slug;
      view.img = strike.item?.img ?? strike.imageUrl ?? null;
      view.icon = view.img ? null : TYPE_ICONS.strike;
      view.disabled = strikeUnavailable(strike);
      // Variant labels already carry the right MAP (agile −4/−8 included).
      view.map = strikeMapValues(strike);
      const next = Math.min(Number(opts.attacks) || 0, view.map.length - 1);
      view.mapIndex = Math.max(0, next);
      if (view.map.length) view.badge = view.map[view.mapIndex];
      return view;
    }
    case "skill": {
      const stat = findStatistic(actor, entry.slug);
      if (!stat) return { ...view, broken: true, label: entry.slug, icon: TYPE_ICONS.skill };
      return { ...view, label: stat.label ?? entry.slug, icon: TYPE_ICONS.skill, badge: signed(stat.mod) };
    }
    case "action": {
      const action = systemActions()?.get(entry.slug);
      if (!action) return { ...view, broken: true, label: entry.slug, icon: TYPE_ICONS.action };
      return { ...view, label: localizeMaybe(action.name) || entry.slug, img: action.img ?? null, icon: action.img ? null : TYPE_ICONS.action };
    }
    case "effect": {
      const source = entry.uuid ? fromUuidSync(entry.uuid) : null;
      if (!source) return { ...view, broken: true, label: entry.name ?? "효과", icon: "fa-solid fa-sparkles" };
      const has = actor?.itemTypes?.effect?.some(e => effectMatches(e, entry.uuid, source.slug ?? source.system?.slug));
      return { ...view, label: source.name, img: source.img, active: !!has };
    }
    default:
      return { ...view, broken: true, label: "?" };
  }
}

/** The strike behind a slot: a strike slot, or an item slot for a weapon/bomb. */
export function strikeForEntry(actor, entry) {
  if (!entry) return null;
  if (entry.type === "strike") return findStrike(actor, entry.slug);
  if (entry.type === "item") {
    const item = findItem(actor, entry);
    return item ? (actor.system?.actions ?? []).find(s => s?.item?.id === item.id) ?? null : null;
  }
  return null;
}

/** PF2e greys a strike when the weapon isn't held or a thrown consumable is used up. */
export function strikeUnavailable(strike) {
  if (!strike) return true;
  if (strike.ready === false || strike.canStrike === false) return true;
  const item = strike.item;
  if (!item) return false;
  // Not in hand: PF2e only offers "뽑기" for it on the sheet.
  if (item.isOfType?.("weapon") && item.isEquipped === false) return true;
  // Bombs are weapons with a quantity; at 0 the sheet greys the attack buttons.
  const qty = item.quantity ?? item.system?.quantity;
  if (qty !== undefined && qty !== null && Number(qty) <= 0) return true;
  return false;
}

function effectMatches(effect, uuid, slug) {
  const src = effect._stats?.compendiumSource ?? effect.flags?.core?.sourceId;
  return src === uuid || effect.uuid === uuid || (!!slug && effect.slug === slug);
}

/** Apply a slot's custom icon over whatever the slot resolved to. */
export function withIconOverride(view) {
  if (view && view.entry?.icon) {
    view.img = view.entry.icon;
    view.icon = null;
  }
  return view;
}

/* ------------------------------------------------------------------------ *
 * Execution
 *
 * Deliberately conservative: nothing here spends resources on a plain press,
 * because accidental keypresses are common at the table. Consumables post
 * their card (which has PF2e's own Consume button); Shift+click consumes.
 * ------------------------------------------------------------------------ */

function activeToken(actor) {
  return actor?.token?.object ?? actor?.getActiveTokens?.()[0] ?? null;
}

export async function executeSlot(actor, entry, event = null, opts = {}) {
  if (!actor || !entry) return false;
  try {
    switch (entry.type) {
      case "macro": {
        const macro = entry.uuid ? await fromUuid(entry.uuid) : null;
        if (!macro) return false;
        await macro.execute({ actor, token: activeToken(actor) });
        return true;
      }
      case "item": {
        const item = findItem(actor, entry);
        if (!item) {
          ui.notifications.info(`PF2e-KR HUD | ${entry.name ?? "아이템"}: 지금 가지고 있지 않습니다.`);
          return false;
        }
        if (item.type === "consumable" && event?.shiftKey && typeof item.consume === "function") {
          await item.consume();
          return true;
        }
        if (item.type === "weapon") {
          const strike = (actor.system?.actions ?? []).find(s => s?.item?.id === item.id);
          if (strike?.variants?.[0]) {
            await strike.variants[0].roll({ event });
            return true;
          }
        }
        // A quickslot press is a use: spells and actions count toward the pips.
        // (The 주문·피트 popover posts cards without counting.)
        if (item.type === "spell" || item.type === "action" || item.type === "feat") markNextUse(actor, itemActionCost(item));
        await item.toMessage?.(event);
        return true;
      }
      case "effect": {
        const source = entry.uuid ? await fromUuid(entry.uuid) : null;
        if (!source) return false;
        const slug = source.slug ?? source.system?.slug;
        const selected = (canvas?.tokens?.controlled ?? []).map(t => t.actor).filter(a => a?.isOwner);
        const targets = selected.length ? selected : [actor];
        for (const target of targets) {
          const existing = target.itemTypes?.effect?.find(e => effectMatches(e, entry.uuid, slug));
          if (existing) await existing.delete();
          else {
            const data = source.toObject();
            delete data._id;
            data._stats = { ...(data._stats ?? {}), compendiumSource: source.uuid };
            await target.createEmbeddedDocuments("Item", [data]);
          }
        }
        return true;
      }
      case "strike": {
        const strike = findStrike(actor, entry.slug);
        if (!strike?.variants?.length) return false;
        if (strikeUnavailable(strike)) {
          ui.notifications.warn(`PF2e-KR HUD | ${strike.label}: 지금은 공격할 수 없습니다 (들고 있지 않거나 남은 수량이 없음).`);
          return false;
        }
        // The caller decides which attack this is (auto MAP, right/middle click).
        const index = Math.clamp(Number(opts.mapIndex) || 0, 0, strike.variants.length - 1);
        await strike.variants[index].roll({ event });
        return true;
      }
      case "skill": {
        const stat = findStatistic(actor, entry.slug);
        if (!stat?.roll) return false;
        await stat.roll({ event });
        return true;
      }
      case "action": {
        const acts = systemActions();
        const action = acts?.get(entry.slug);
        if (action?.use) {
          await action.use({ actors: [actor], event });
          return true;
        }
        // Older PF2e builds exposed actions as camelCase functions.
        const legacy = acts?.[entry.slug.replace(/-([a-z])/g, (_, c) => c.toUpperCase())];
        if (typeof legacy === "function") {
          await legacy({ actors: [actor], event });
          return true;
        }
        return false;
      }
    }
  } catch (err) {
    console.error(`${MODULE_ID} | slot execution failed`, entry, err);
    ui.notifications.warn(`PF2e-KR HUD | 실행 중 오류가 발생했습니다: ${err.message ?? err}`);
  }
  return false;
}

/* ------------------------------------------------------------------------ *
 * Drops onto a slot
 * ------------------------------------------------------------------------ */

export function entryFromDrop(actor, data) {
  if (!data) return null;
  if (data.type === "Macro" && data.uuid) return { type: "macro", uuid: data.uuid };

  if (data.type === "Item" && data.uuid) {
    const dropped = fromUuidSync(data.uuid);
    // Effects: toggled on the selected tokens, so they may come from any compendium.
    if (dropped?.type === "effect") {
      const uuid = dropped.parent ? (dropped._stats?.compendiumSource ?? dropped.flags?.core?.sourceId ?? dropped.uuid) : dropped.uuid;
      return { type: "effect", uuid, name: dropped.name };
    }
  }
  if (data.type === "Item" && data.uuid) {
    const item = fromUuidSync(data.uuid);
    const owner = item?.parent;
    const sameActor = owner && (owner === actor || owner.id === actor.id);
    if (!sameActor) {
      ui.notifications.warn("PF2e-KR HUD | 이 캐릭터가 가진 아이템만 슬롯에 올릴 수 있습니다.");
      return null;
    }
    const strike = (actor.system?.actions ?? []).find(s => s?.item?.id === item.id);
    if (strike?.slug) return { type: "strike", slug: strike.slug };
    return itemEntry(item);
  }

  // PF2e sheets drag strikes as { type: "Action", index }.
  if (data.type === "Action" && Number.isInteger(Number(data.index))) {
    const strike = actor.system?.actions?.[Number(data.index)];
    if (strike?.slug) return { type: "strike", slug: strike.slug };
  }

  const skillSlug = data.skill ?? data.slug ?? data.statistic;
  if ((data.type === "Skill" || data.type === "Statistic") && skillSlug && findStatistic(actor, skillSlug)) {
    return { type: "skill", slug: skillSlug };
  }

  ui.notifications.warn("PF2e-KR HUD | 이 항목은 슬롯에 올릴 수 없습니다. 빈 슬롯을 우클릭해 목록에서 골라 보세요.");
  return null;
}

/* ------------------------------------------------------------------------ *
 * Picker: skills, system actions and strikes that have no drag source
 * ------------------------------------------------------------------------ */

const COMMON_ACTIONS = [
  "grapple", "demoralize", "tumble-through", "recall-knowledge", "trip", "shove",
  "disarm", "feint", "seek", "hide", "sneak", "escape", "create-a-diversion",
  "treat-wounds", "battle-medicine", "aid", "raise-a-shield", "take-cover"
];

function listActions() {
  const acts = systemActions();
  if (!acts?.entries) return [];
  const out = [];
  for (const [slug, action] of acts.entries()) {
    if (!action || typeof action.use !== "function") continue;
    out.push({ slug, name: localizeMaybe(action.name) || slug, common: COMMON_ACTIONS.indexOf(slug) });
  }
  const common = out.filter(a => a.common >= 0).sort((a, b) => a.common - b.common);
  const rest = out.filter(a => a.common < 0).sort((a, b) => a.name.localeCompare(b.name, "ko"));
  return [...common, ...rest];
}

function listSkills(actor) {
  const out = [];
  if (actor.perception) out.push({ slug: "perception", name: actor.perception.label ?? "지각", mod: actor.perception.mod });
  for (const [slug, stat] of Object.entries(actor.skills ?? {})) {
    out.push({ slug, name: stat.label ?? slug, mod: stat.mod });
  }
  return out;
}

export function openSlotPicker(actor, row, col) {
  const skills = listSkills(actor);
  const actions = listActions();
  const strikes = (actor.system?.actions ?? []).filter(s => s?.slug);

  const section = (title, rows) => rows.length ? `
    <h3 class="pkh-pick-title">${esc(title)}</h3>
    <div class="pkh-pick-grid">${rows.join("")}</div>` : "";

  const html = `
    <div class="pkh-picker">
      <input type="search" class="pkh-pick-filter" placeholder="이름으로 찾기…" autocomplete="off">
      ${section("공격", strikes.map(s => `
        <button type="button" class="pkh-pick" data-type="strike" data-slug="${esc(s.slug)}">
          <i class="${TYPE_ICONS.strike}"></i><span>${esc(s.label)}</span></button>`))}
      ${section("기술 굴림", skills.map(s => `
        <button type="button" class="pkh-pick" data-type="skill" data-slug="${esc(s.slug)}">
          <i class="${TYPE_ICONS.skill}"></i><span>${esc(s.name)}</span><em>${esc(signed(s.mod))}</em></button>`))}
      ${section("액션 (자주 쓰는 순)", actions.map(a => `
        <button type="button" class="pkh-pick ${a.common >= 0 ? "common" : ""}" data-type="action" data-slug="${esc(a.slug)}">
          <i class="${TYPE_ICONS.action}"></i><span>${esc(a.name)}</span></button>`))}
      <p class="pkh-pick-hint">아이템·주문·피트·매크로는 시트나 매크로 목록에서 슬롯으로 끌어다 놓으면 됩니다.</p>
    </div>`;

  new SimpleWindow({
    title: `슬롯에 추가 — ${actor.name}`,
    width: 520,
    html,
    onRender: (root, app) => {
      const filter = root.querySelector(".pkh-pick-filter");
      filter?.addEventListener("input", () => {
        const q = filter.value.trim().toLowerCase();
        for (const btn of root.querySelectorAll(".pkh-pick")) {
          btn.hidden = q && !btn.textContent.toLowerCase().includes(q);
        }
      });
      root.addEventListener("click", async ev => {
        const btn = ev.target.closest(".pkh-pick");
        if (!btn) return;
        await setSlot(actor, row, col, { type: btn.dataset.type, slug: btn.dataset.slug });
        app.close();
      });
      filter?.focus();
    }
  }).render({ force: true });
}

/* ------------------------------------------------------------------------ *
 * GM: which extra users may rearrange this actor's bar
 * ------------------------------------------------------------------------ */

export function openEditorsDialog(actor) {
  const base = storageActor(actor);
  const current = new Set(base.getFlag(MODULE_ID, "editors") ?? []);
  const owners = game.users.filter(u => !u.isGM && base.testUserPermission(u, "OWNER"));
  const rows = owners.map(u => {
    const assigned = u.character?.id === base.id;
    return `<label class="pkh-editor-row">
      <input type="checkbox" name="${u.id}" ${assigned || current.has(u.id) ? "checked" : ""} ${assigned ? "disabled" : ""}>
      <span>${esc(u.name)}</span>${assigned ? `<em>할당된 캐릭터 — 항상 가능</em>` : ""}
    </label>`;
  }).join("") || `<p>이 액터를 소유한 플레이어가 없습니다.</p>`;

  new SimpleWindow({
    title: `퀵슬롯 편집 권한 — ${base.name}`,
    width: 380,
    html: `<div class="pkh-editors">
      <p class="pkh-pick-hint">소유 권한이 있어도 여기 체크된 사람(과 GM)만 슬롯 배치를 바꿀 수 있습니다. 사용은 소유자 모두 가능합니다.</p>
      ${rows}
      <button type="button" class="pkh-save"><i class="fa-solid fa-check"></i> 저장</button>
    </div>`,
    onRender: (root, app) => {
      root.querySelector(".pkh-save")?.addEventListener("click", async () => {
        const ids = [...root.querySelectorAll("input[type=checkbox]:not([disabled])")].filter(i => i.checked).map(i => i.name);
        await base.setFlag(MODULE_ID, "editors", ids);
        app.close();
      });
    }
  }).render({ force: true });
}

/* ------------------------------------------------------------------------ *
 * Alchemist helper: infused items go onto the bar automatically and come off
 * again when they expire (daily preparations, Quick Alchemy end of turn).
 * Batched, because Advanced Alchemy creates many items at once.
 * ------------------------------------------------------------------------ */

function isInfused(item) {
  const traits = item?.system?.traits?.value ?? [];
  return item?.isOfType?.("physical") && traits.includes("infused");
}

const pendingAdds = new Map();

function flushAdds(actorId) {
  const ids = pendingAdds.get(actorId);
  pendingAdds.delete(actorId);
  const actor = game.actors.get(actorId) ?? ids?.actor;
  if (!actor || !ids?.size) return;

  const rows = readSlots(actor);
  const entries = rows.flat().filter(e => e?.type === "item");
  const changed = {};
  for (const id of ids) {
    const item = actor.items.get(id);
    if (!item) continue;
    // Already on the bar (same id, or a greyed slot for the same kind of item)?
    if (entries.some(e => e.id === id || (e.slug && e.slug === item.slug))) continue;
    let placed = false;
    for (let r = 0; r < rows.length && !placed; r++) {
      const c = rows[r].findIndex(e => !e);
      if (c === -1) continue;
      rows[r][c] = itemEntry(item, { auto: true });
      changed[r] = rows[r];
      placed = true;
    }
    if (!placed) break;
  }
  if (Object.keys(changed).length) writeRows(actor, changed);
}

export function registerInfusedHelper() {
  Hooks.on("createItem", (item, _options, userId) => {
    if (userId !== game.user.id || !setting("hudAutoInfused", true)) return;
    const actor = item.parent;
    if (!actor?.isOwner || actor.type !== "character" || !isInfused(item)) return;
    const key = storageActor(actor).id;
    const set = pendingAdds.get(key) ?? Object.assign(new Set(), { actor: storageActor(actor) });
    set.add(item.id);
    pendingAdds.set(key, set);
    clearTimeout(set.timer);
    set.timer = setTimeout(() => flushAdds(key), 300);
  });

  // No deleteItem clean-up: an emptied or expired item keeps its slot, greyed.
}

/* ------------------------------------------------------------------------ *
 * Auto-fill (mainly NPCs): strikes → actions/reactions → spells by rank,
 * into empty slots only. Nothing already on the bar is moved.
 * ------------------------------------------------------------------------ */

export async function autoFillSlots(actor) {
  const rows = readSlots(actor);
  const keyOf = e => (e.type === "strike" ? `s:${e.slug}` : e.type === "item" ? `i:${e.id}` : `${e.type}:${e.slug ?? e.uuid}`);
  const existing = new Set(rows.flat().filter(Boolean).map(keyOf));
  const candidates = [];
  for (const strike of actor.system?.actions ?? []) {
    if (strike?.slug) candidates.push({ type: "strike", slug: strike.slug });
  }
  for (const action of actor.itemTypes?.action ?? []) {
    if (action.system?.actionType?.value === "passive") continue;
    candidates.push(itemEntry(action));
  }
  const spells = (actor.itemTypes?.spell ?? []).slice()
    .sort((a, b) => (a.isCantrip ? 0 : a.rank ?? 0) - (b.isCantrip ? 0 : b.rank ?? 0));
  for (const spell of spells) candidates.push(itemEntry(spell));

  const changed = {};
  let added = 0;
  let r = 0;
  let c = 0;
  for (const entry of candidates) {
    if (existing.has(keyOf(entry))) continue;
    while (r < rows.length && rows[r][c]) {
      if (++c >= SLOTS_PER_ROW) { c = 0; r++; }
    }
    if (r >= rows.length) break;
    rows[r][c] = entry;
    changed[r] = rows[r];
    existing.add(keyOf(entry));
    added++;
  }
  if (added) await writeRows(actor, changed);
  return added;
}
