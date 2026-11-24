/*
 * The HUD outside PF2e (dnd5e, dragonbane, daggerheart, AGE, any other system).
 *
 * Same frame, CSS classes and hotkeys as the PF2e HUD (hud.mjs, which is not used here):
 *   conditions · name + HP (temp HP) + the system's resources · quick slots · defences and buttons.
 * All system data comes from systems.mjs. Quick slots use the same storage as PF2e (slots.mjs flags,
 * lock, editors) with three entry kinds: { type: "item", id … }, { type: "check", key, label },
 * { type: "macro", uuid }. The 목록 button opens a panel (the PF2e skills panel's look) with the
 * system's checks and item lists: click rolls or uses, drag puts it on a slot.
 */
import { MAX_ROWS, MODULE_ID, PAGE_COUNT, SLOTS_PER_ROW, SimpleWindow, boardViewportRect, displayName, esc, readDragData, setting, signed, t } from "./shared.mjs";
import { canEditSlots, findItem, isLocked, itemEntry, openEditorsDialog, readSlots, setSlot, storageActor, swapSlots, writeRows } from "./slots.mjs";
import { applyHp, canDamage, hudChecks, hudLists, hudView, isPcType, rollCheck, useItem } from "./systems.mjs";

/* ---------------- pure helpers (node tests) ---------------- */

/** HP numbers and bar widths; null when the system gave no HP. */
export function hpParts(health) {
  if (!health) return null;
  const max = Math.max(1, Number(health.max) || 1);
  const value = Math.max(0, Number(health.value) || 0);
  const temp = Math.max(0, Number(health.temp) || 0);
  return { value, max: Number(health.max) || 0, temp, pct: Math.min(100, value / max * 100), tempPct: Math.min(100, temp / max * 100) };
}

/** "3/4", or the value as it is (death saves "✓1 ✗2"). */
export function resourceText(r) {
  return Number.isFinite(Number(r?.max)) && r.max !== null && r.max !== undefined ? `${Number(r.value) || 0}/${Number(r.max) || 0}` : String(r?.value ?? "");
}

/** A check's number: a modifier gets a sign, a roll-under target (plain) does not. */
export function checkText(c) {
  return c?.plain ? String(c.mod ?? "") : signed(c?.mod);
}

/**
 * A slot entry from drag data: an item of this actor, a macro, a check from the list panel.
 * Returns { entry } or { warn: lang key }.
 */
export function entryFromData(actor, data, item = null) {
  if (!data) return { warn: "Slots.CantDrop" };
  if (data.type === "Macro" && data.uuid) return { entry: { type: "macro", uuid: data.uuid } };
  if (data.type === "pkh-check" && data.key) return { entry: { type: "check", key: String(data.key), label: String(data.label ?? data.key) } };
  if (data.type === "Item" && data.uuid) {
    const owner = item?.parent;
    if (!item || !owner || !(owner === actor || owner.id === actor?.id)) return { warn: "Slots.OwnItemsOnly" };
    return { entry: itemEntry(item) };
  }
  return { warn: "Slots.CantDrop" };
}

/** Empty cells of the first rows filled with these entries, skipping what is already on the bar. Returns { changed rows, added }. */
export function fillPlan(rows, entries, maxRows = MAX_ROWS) {
  const onBar = new Set(rows.flat().filter(Boolean).map(e => (e.type === "item" ? `i:${e.id}` : e.type === "check" ? `c:${e.key}` : `m:${e.uuid}`)));
  const queue = entries.filter(e => !onBar.has(e.type === "item" ? `i:${e.id}` : `c:${e.key}`));
  const changed = {};
  let added = 0;
  for (let r = 0; r < Math.min(maxRows, rows.length) && queue.length; r++) {
    for (let c = 0; c < SLOTS_PER_ROW && queue.length; c++) {
      if (rows[r][c]) continue;
      rows[r][c] = queue.shift();
      changed[r] = rows[r];
      added++;
    }
  }
  return { changed, added };
}

const plainText = (html, limit = 220) => {
  const text = String(html ?? "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
};

/* ---------------- the list panel ---------------- */

class SystemLists {
  constructor(hud) {
    this.hud = hud;
    this.actor = null;
    this.pickFor = null;     // { row, col }: the next click fills this slot instead of rolling
    this.el = document.createElement("section");
    this.el.id = "pkh-skills";
    this.el.className = "hidden pkh-sys-lists";
    document.body.appendChild(this.el);
    this.el.addEventListener("click", ev => this._onClick(ev));
    this.el.addEventListener("contextmenu", ev => this._onContext(ev));
    this.el.addEventListener("dragstart", ev => this._onDragStart(ev));
    document.addEventListener("keydown", ev => {
      if (ev.key !== "Escape" || !this.open) return;
      if (ev.target instanceof HTMLElement && ev.target.closest?.(".application, input, textarea, select")) return;
      this.close();
    });
  }

  get open() { return !this.el.classList.contains("hidden"); }

  toggle(actor, pickFor = null) {
    if (this.open && this.actor === actor && !pickFor && !this.pickFor) return this.close();
    this.actor = actor;
    this.pickFor = pickFor;
    this.el.classList.remove("hidden");
    this.render();
  }

  close() {
    this.el.classList.add("hidden");
    this.pickFor = null;
    this.hud.scheduleRender();
  }

  render() {
    const actor = this.actor;
    if (!actor || !this.open) return;
    const checks = hudChecks(actor);
    const groups = new Map();
    for (const c of checks) {
      const g = c.group || t("SysHud.Checks");
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g).push(c);
    }
    const checkHtml = [...groups].map(([title, list]) => `<section class="pkh-sk"><h4>${esc(title)}</h4>
      ${list.map(c => `<h3 data-check="${esc(c.key)}" data-label="${esc(c.label)}" draggable="true"><span class="mod">${esc(checkText(c))}</span><span class="lbl">${esc(c.label)}</span></h3>`).join("")}</section>`).join("");
    const listHtml = hudLists(actor).map(l => `<section class="pkh-sk"><h4>${esc(l.label)}</h4>
      ${l.items.map(i => `<div class="pkh-sk-act" data-item="${esc(i.id)}" draggable="true">
        <button type="button" class="name" data-tooltip="${esc(plainText(i.system?.description?.value ?? i.system?.description ?? "", 160))}"><img src="${esc(i.img)}" alt="">${esc(i.name)}</button></div>`).join("")}</section>`).join("");
    const body = checkHtml + listHtml;
    this.el.innerHTML = `
      <header>
        <strong>${esc(displayName(actor.name))}</strong> <span class="sub">${esc(this.pickFor ? t("SysHud.PickFor") : t("SysHud.ListsHelp"))}</span>
        <button type="button" class="close" data-close="1" aria-label="${esc(t("Common.Close"))}"><i class="fa-solid fa-xmark"></i></button>
      </header>
      <div class="pkh-sk-cols">${body || `<p class="pkh-sk-loading">${esc(t("SysHud.Nothing"))}</p>`}</div>`;
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
    const check = ev.target.closest("[data-check]");
    const row = ev.target.closest("[data-item]");
    const item = row ? actor.items.get(row.dataset.item) : null;
    if (this.pickFor && (check || item)) {
      const { row: r, col: c } = this.pickFor;
      this.pickFor = null;
      const entry = check ? { type: "check", key: check.dataset.check, label: check.dataset.label } : itemEntry(item);
      await setSlot(actor, r, c, entry);
      return this.close();
    }
    if (check) return rollCheck(actor, check.dataset.check, ev);
    if (item) return useItem(actor, item, ev);
  }

  _onContext(ev) {
    const row = ev.target.closest("[data-item]");
    if (!row || !this.actor) return;
    ev.preventDefault();
    this.actor.items.get(row.dataset.item)?.sheet?.render(true);
  }

  _onDragStart(ev) {
    const check = ev.target.closest("[data-check]");
    const row = ev.target.closest("[data-item]");
    const item = row ? this.actor?.items.get(row.dataset.item) : null;
    const data = check ? { type: "pkh-check", key: check.dataset.check, label: check.dataset.label } : item ? { type: "Item", uuid: item.uuid } : null;
    if (data) ev.dataTransfer.setData("text/plain", JSON.stringify(data));
  }
}

/* ---------------- the HUD ---------------- */

export class SystemHud {
  constructor() {
    this.root = null;
    this.actor = null;
    this.pages = new Map();
    this.lastUuid = null;
    this._frame = 0;
    this._autoFilled = new Set();
  }

  mount() {
    if (this.root) return;
    this.root = document.createElement("section");
    this.root.id = "pkh-hud";
    this.root.setAttribute("aria-label", t("Hud.Aria.Hud"));
    document.body.appendChild(this.root);
    const r = this.root;
    r.addEventListener("click", ev => this._onClick(ev));
    r.addEventListener("contextmenu", ev => this._onContext(ev));
    r.addEventListener("dragstart", ev => this._onDragStart(ev));
    r.addEventListener("dragover", ev => { if (ev.target.closest(".pkh-slot")) ev.preventDefault(); });
    r.addEventListener("drop", ev => this._onDrop(ev));
    r.addEventListener("wheel", ev => this._onWheel(ev), { passive: false });
    this.lists = new SystemLists(this);
    window.addEventListener("resize", () => this.position());
    this.scheduleRender();
  }

  /* ---- which actor (same rules as the PF2e HUD) ---- */

  pickActor() {
    const pinned = this._fromSetting("hudPinnedActor");
    if (pinned?.isOwner) return pinned;
    const controlled = canvas?.tokens?.controlled ?? [];
    const current = controlled.length ? controlled[controlled.length - 1].actor : null;
    if (current?.isOwner) {
      this._remember(current);
      return current;
    }
    const last = this.lastUuid ? this._fromUuid(this.lastUuid) : this._fromSetting("hudLastActor");
    if (last?.isOwner) return last;
    const own = game.user.isGM ? null : game.user.character;
    return own?.isOwner ? own : null;
  }

  _fromUuid(uuid) {
    try {
      const doc = uuid ? fromUuidSync(uuid) : null;
      return doc?.documentName === "Actor" ? doc : null;
    } catch (_) {
      return null;
    }
  }

  _fromSetting(key) {
    return this._fromUuid(setting(key, ""));
  }

  _remember(actor) {
    if (this.lastUuid === actor.uuid) return;
    this.lastUuid = actor.uuid;
    game.settings.set(MODULE_ID, "hudLastActor", actor.uuid)?.catch?.(() => {});
  }

  rows() {
    return Math.clamp(Number(setting("hudRows", 1)) || 1, 1, MAX_ROWS);
  }

  page(actor) {
    return this.pages.get(storageActor(actor)?.id) ?? 0;
  }

  setPage(actor, page) {
    this.pages.set(storageActor(actor)?.id, ((page % PAGE_COUNT) + PAGE_COUNT) % PAGE_COUNT);
    this.scheduleRender();
  }

  /* ---- drawing ---- */

  scheduleRender() {
    cancelAnimationFrame(this._frame);
    this._frame = requestAnimationFrame(() => this.render());
  }

  render() {
    if (!this.root) return;
    const enabled = setting("hudEnabled", true);
    this.actor = enabled ? this.pickActor() : null;
    const actor = this.actor;
    document.body.classList.toggle("pkh-hide-hotbar", enabled && setting("hudHideCoreHotbar", true));
    this.root.classList.toggle("hidden", !actor);
    if (!actor) {
      this.root.innerHTML = "";
      this.lists?.open && this.lists.close();
      return;
    }
    const view = hudView(actor);
    this.view = view;
    const editable = canEditSlots(actor);
    const locked = isLocked(actor);
    this._maybeAutoFill(actor);
    this.root.classList.toggle("unlocked", editable && !locked);
    this.root.innerHTML = `
      <div class="pkh-inner">
        ${this._effectsHtml(view.conditions, actor)}
        <div class="pkh-hp-row">${this._hpHtml(actor, view)}${this._resourcesHtml(view.resources)}</div>
        ${this._slotsHtml(actor, editable, locked)}
        ${this._barHtml(actor, view)}
      </div>`;
    this.position();
    if (this.lists?.open) {
      if (this.lists.actor !== actor) this.lists.actor = actor;
      this.lists.render();
    }
  }

  position() {
    const rect = boardViewportRect();
    const scale = Number(setting("hudScale", 1)) || 1;
    const slot = Math.round(Math.min(64, Math.max(42, rect.width / 30)));
    const effect = Math.clamp(Number(setting("hudEffectSize", 42)) || 42, 20, 72);
    const effectsMax = setting("hudEffectsWidth", "screen") === "bar" ? "100%" : `${Math.max(240, Math.floor((rect.width - 32) / scale))}px`;
    const el = this.root;
    if (!el) return;
    el.style.setProperty("--pkh-effects-max", effectsMax);
    el.style.setProperty("--pkh-effect-size", `${effect}px`);
    el.style.setProperty("--pkh-center", `${Math.round(rect.left + rect.width / 2)}px`);
    el.style.setProperty("--pkh-scale", String(scale));
    el.style.setProperty("--pkh-slot", `${slot}px`);
    if (this.lists?.open) this.lists.position();
  }

  _effectsHtml(list, actor) {
    if (!list.length) return `<div class="pkh-effects empty"></div>`;
    const help = actor.isOwner ? `<br><small>${esc(t("SysHud.RemoveTip"))}</small>` : "";
    return `<div class="pkh-effects-zone"><div class="pkh-effects">${list.map(e => {
      const desc = plainText(e.desc, 200);
      return `<div class="pkh-effect debuff" data-effect="${esc(e.id)}" data-tooltip="${esc(e.name)}${desc ? `<br><small>${esc(desc)}</small>` : ""}${help}">
        <img src="${esc(e.img)}" alt="${esc(e.name)}"></div>`;
    }).join("")}</div></div>`;
  }

  _hpHtml(actor, view) {
    const hp = hpParts(view.health);
    const name = `<span class="name">${esc(displayName(actor.name))}</span>`;
    if (!hp) return `<div class="pkh-hp"><div class="pkh-hp-label">${name}</div></div>`;
    const color = hp.pct > 50 ? "var(--pkh-hp-high)" : hp.pct > 25 ? "var(--pkh-hp-mid)" : "var(--pkh-hp-low)";
    return `
      <div class="pkh-hp">
        <div class="pkh-hp-label">${name}<span class="num">${hp.value} / ${hp.max}${hp.temp ? ` <b>+${hp.temp}</b>` : ""}</span></div>
        <div class="pkh-hp-bar">
          <div class="fill" style="width:${hp.pct}%;background:${color}"></div>
          ${hp.temp ? `<div class="temp" style="width:${hp.tempPct}%"></div>` : ""}
        </div>
      </div>`;
  }

  _resourcesHtml(list) {
    if (!list.length) return "";
    return `<div class="pkh-saves pkh-res">${list.map(r => {
      const label = r.label ? `<em>${esc(r.label)}</em>` : "";
      const tip = r.tip ? ` data-tooltip="${esc(r.tip)}"` : "";
      return r.act
        ? `<button type="button" class="pkh-chip" data-act="res" data-key="${esc(r.act)}"${tip}>${label}${esc(resourceText(r))}</button>`
        : `<span class="pkh-chip static"${tip}>${label}${esc(resourceText(r))}</span>`;
    }).join("")}</div>`;
  }

  _keyLabel(rowOffset, col) {
    const binding = game.keybindings.get(MODULE_ID, `slot-${rowOffset + 1}-${(col + 1) % 10}`)?.[0];
    if (!binding?.key) return "";
    const key = binding.key.replace(/^Digit/, "").replace(/^Key/, "").replace(/^Numpad/, "N");
    const mods = (binding.modifiers ?? []).map(m => ({ Shift: "⇧", Alt: "⌥", Control: "^" }[m] ?? m)).join("");
    return `${mods}${key}`;
  }

  /** What a slot shows: { img | icon, label, badge }, or null for an entry whose item is gone. */
  _slotView(actor, entry) {
    if (entry.type === "item") {
      const item = findItem(actor, entry);
      if (!item) return { icon: "fa-solid fa-question", label: entry.name ?? "?", broken: true };
      const q = Number(item.system?.quantity);
      return { img: entry.icon || item.img, label: item.name, badge: Number.isFinite(q) && q > 1 ? q : "" };
    }
    if (entry.type === "check") return { icon: "fa-solid fa-dice-d20", label: entry.label ?? entry.key, img: entry.icon || null };
    if (entry.type === "macro") {
      let macro = null;
      try { macro = fromUuidSync(entry.uuid); } catch (_) { macro = null; }
      return macro ? { img: entry.icon || macro.img, label: macro.name } : { icon: "fa-solid fa-terminal", label: "?", broken: true };
    }
    return { icon: "fa-solid fa-question", label: "?", broken: true };
  }

  _slotsHtml(actor, editable, locked) {
    const rows = this.rows();
    const page = this.page(actor);
    const data = readSlots(actor);
    const dragOk = editable && !locked;
    const rowHtml = Array.from({ length: rows }, (_, offset) => {
      const r = page * rows + offset;
      if (r >= data.length) return "";
      return `<div class="pkh-row">${data[r].map((entry, c) => {
        const key = this._keyLabel(offset, c);
        if (!entry) {
          return `<div class="pkh-slot empty" data-row="${r}" data-col="${c}" ${dragOk ? `data-tooltip="${esc(t("SysHud.EmptyTip"))}"` : ""}><span class="key">${esc(key)}</span></div>`;
        }
        const v = this._slotView(actor, entry);
        const visual = v.img ? `<img src="${esc(v.img)}" alt="" draggable="false">` : `<i class="${esc(v.icon)}"></i>`;
        const label = !v.img ? `<span class="label">${esc(v.label)}</span>` : "";
        return `<div class="pkh-slot t-${esc(entry.type)} ${v.broken ? "broken" : ""}" data-row="${r}" data-col="${c}" draggable="${dragOk}" data-tooltip="${esc(v.label)}">
          <span class="key">${esc(key)}</span>${visual}${label}
          ${v.broken ? `<i class="fa-solid fa-xmark broken-mark"></i>` : ""}
          ${v.badge ? `<span class="badge">${esc(v.badge)}</span>` : ""}</div>`;
      }).join("")}</div>`;
    }).join("");
    const dots = Array.from({ length: PAGE_COUNT }, (_, p) =>
      `<button type="button" class="pkh-dot ${p === page ? "active" : ""}" data-act="page" data-page="${p}" aria-label="${t("Hud.Page", { n: p + 1 })}"></button>`).join("");
    const pinned = setting("hudPinnedActor", "");
    return `
      <div class="pkh-slots rows-${rows}">
        <div class="pkh-slots-side">
          <button type="button" class="pkh-icon lock ${locked ? "" : "open"}" data-act="lock" ${editable ? "" : "disabled"}
                  data-tooltip="${t(editable ? (locked ? "Hud.Lock.Locked" : "Hud.Lock.Editing") : "Hud.Lock.NoPermission")}">
            <i class="fa-solid ${locked ? "fa-lock" : "fa-lock-open"}"></i></button>
          <button type="button" class="pkh-icon" data-act="rows" data-tooltip="${t("Hud.Rows", { n: rows })}"><span class="rows-glyph r${rows}"></span></button>
          ${game.user.isGM ? `<button type="button" class="pkh-icon" data-act="editors" data-tooltip="${t("Hud.Editors")}"><i class="fa-solid fa-user-gear"></i></button>` : ""}
          <button type="button" class="pkh-icon pin ${pinned ? "open" : ""}" data-act="pin" data-tooltip="${t(pinned ? "Hud.Pin.On" : "Hud.Pin.Off")}"><i class="fa-solid fa-thumbtack"></i></button>
          ${game.user.isGM ? `<button type="button" class="pkh-icon" data-act="autofill" data-tooltip="${t("Hud.AutoFill")}"><i class="fa-solid fa-wand-magic-sparkles"></i></button>` : ""}
        </div>
        <div class="pkh-grid">${rowHtml}</div>
        <div class="pkh-pages" data-tooltip="${t("Hud.PagesTip")}">${dots}</div>
      </div>`;
  }

  _barHtml(actor, view) {
    const defences = view.defences.map(d => `<span class="pkh-chip static"${d.tip ? ` data-tooltip="${esc(d.tip)}"` : ""}>${d.label ? `<em>${esc(d.label)}</em>` : ""}${esc(d.value)}</span>`).join("");
    const gm = game.user.isGM;
    return `
      <div class="pkh-bar">
        <div class="pkh-bar-left">
          ${gm && canDamage() ? `<button type="button" class="pkh-mini" data-act="damage" data-tooltip="${esc(t("SysHud.Damage.Title"))}" aria-label="${esc(t("SysHud.Damage.Title"))}"><i class="fa-solid fa-heart-crack"></i></button>` : ""}
        </div>
        ${defences ? `<div class="pkh-saves">${defences}</div>` : ""}
        <div class="pkh-bar-right">
          ${game.pkhPanels ? `<button type="button" class="pkh-mini pkh-notes-btn ${game.pkhPanels.isOpen?.("notes") ? "active" : ""}" data-act="notes" data-tooltip="${t("Toolkit.Notes")}" aria-label="${t("Toolkit.Notes")}"><i class="fa-solid fa-book"></i></button>` : ""}
          ${isPcType(actor) ? `<button type="button" class="pkh-mini" data-act="faces" data-tooltip="${t("Hud.Bar.Faces")}"><i class="fa-solid fa-masks-theater"></i></button>` : ""}
          <button type="button" class="pkh-mini ${this.lists?.open ? "active" : ""}" data-act="lists" data-tooltip="${esc(t("SysHud.Lists"))}<br><small>${esc(t("SysHud.ListsHelp"))}</small>"><i class="fa-solid fa-list-check"></i></button>
        </div>
      </div>`;
  }

  /* ---- events ---- */

  _slotAt(node) {
    const row = Number(node.dataset.row);
    const col = Number(node.dataset.col);
    return { row, col, entry: readSlots(this.actor)[row]?.[col] ?? null };
  }

  async _onClick(ev) {
    const actor = this.actor;
    if (!actor) return;
    const slot = ev.target.closest(".pkh-slot");
    if (slot) {
      const { row, col, entry } = this._slotAt(slot);
      if (entry) return this.execute(actor, entry, ev);
      if (canEditSlots(actor) && !isLocked(actor)) this.lists.toggle(actor, { row, col });
      return;
    }
    const btn = ev.target.closest("[data-act]");
    switch (btn?.dataset.act) {
      case "page": return this.setPage(actor, Number(btn.dataset.page));
      case "rows": return game.settings.set(MODULE_ID, "hudRows", (this.rows() % MAX_ROWS) + 1);
      case "lock":
        if (canEditSlots(actor)) await storageActor(actor).setFlag(MODULE_ID, "locked", !isLocked(actor));
        return;
      case "editors": return openEditorsDialog(actor);
      case "pin": {
        await game.settings.set(MODULE_ID, "hudPinnedActor", setting("hudPinnedActor", "") ? "" : actor.uuid);
        return this.scheduleRender();
      }
      case "autofill": {
        const added = await this.autoFill(actor);
        return ui.notifications.info(`Rutz's HUD | ${t("Hud.Notify.AutoFilled", { n: added })}`);
      }
      case "res": return rollCheck(actor, btn.dataset.key, ev);
      case "lists": this.lists.toggle(actor); return this.scheduleRender();
      case "faces": return game.pf2eKrHud?.openFaces?.(actor);
      case "notes": return game.pkhPanels?.notes?.();
      case "damage": return openDamage(actor);
    }
  }

  async _onContext(ev) {
    const actor = this.actor;
    if (!actor) return;
    const effect = ev.target.closest(".pkh-effect");
    if (effect) {
      ev.preventDefault();
      if (!actor.isOwner) return;
      const e = (this.view?.conditions ?? []).find(x => x.id === effect.dataset.effect);
      try { await e?.off?.(); } catch (err) { console.warn(`${MODULE_ID} | could not remove effect`, err); }
      return;
    }
    const slot = ev.target.closest(".pkh-slot");
    if (!slot) return;
    ev.preventDefault();
    const { row, col, entry } = this._slotAt(slot);
    if (!entry) return;
    // Editors: right-click empties the slot; everyone else: the item's sheet.
    if (canEditSlots(actor) && !isLocked(actor)) return setSlot(actor, row, col, null);
    if (entry.type === "item") findItem(actor, entry)?.sheet?.render(true);
  }

  _onDragStart(ev) {
    const actor = this.actor;
    const slot = ev.target.closest(".pkh-slot");
    if (!slot || !actor || !canEditSlots(actor) || isLocked(actor)) {
      ev.preventDefault();
      return;
    }
    ev.dataTransfer.setData("text/plain", JSON.stringify({ type: "pkh-slot", actorId: storageActor(actor).id, row: Number(slot.dataset.row), col: Number(slot.dataset.col) }));
  }

  async _onDrop(ev) {
    const actor = this.actor;
    const slot = ev.target.closest(".pkh-slot");
    if (!actor || !slot) return;
    ev.preventDefault();
    ev.stopPropagation();
    if (!canEditSlots(actor)) return ui.notifications.warn(`Rutz's HUD | ${t("Hud.Notify.NoEdit")}`);
    if (isLocked(actor)) return ui.notifications.info(`Rutz's HUD | ${t("Hud.Notify.Locked")}`);
    const target = { row: Number(slot.dataset.row), col: Number(slot.dataset.col) };
    const data = readDragData(ev);
    if (data?.type === "pkh-slot") {
      if (data.actorId !== storageActor(actor).id || (data.row === target.row && data.col === target.col)) return;
      return swapSlots(actor, { row: data.row, col: data.col }, target);
    }
    let item = null;
    if (data?.type === "Item" && data.uuid) {
      try { item = fromUuidSync(data.uuid); } catch (_) { item = null; }
    }
    const { entry, warn } = entryFromData(actor, data, item);
    if (warn) return ui.notifications.warn(`Rutz's HUD | ${t(warn)}`);
    await setSlot(actor, target.row, target.col, entry);
  }

  _onWheel(ev) {
    if (!this.actor || !ev.target.closest(".pkh-slots")) return;
    ev.preventDefault();
    ev.stopPropagation();
    this.setPage(this.actor, this.page(this.actor) + (ev.deltaY > 0 ? 1 : -1));
  }

  /** One path for clicks and hotkeys. */
  async execute(actor, entry, event = null) {
    if (entry.type === "check") return rollCheck(actor, entry.key, event);
    if (entry.type === "macro") {
      let macro = null;
      try { macro = await fromUuid(entry.uuid); } catch (_) { macro = null; }
      return macro?.execute?.();
    }
    if (entry.type === "item") {
      const item = findItem(actor, entry);
      if (!item) return ui.notifications.warn(`Rutz's HUD | ${t("Hud.Notify.CantUse", { name: entry.name ?? "?" })}`);
      return useItem(actor, item, event);
    }
    return null;
  }

  executeHotkey(rowOffset, col) {
    const actor = this.actor;
    const hideCore = setting("hudHideCoreHotbar", true);
    if (!actor || this.root?.classList.contains("hidden")) return hideCore;
    const rows = this.rows();
    if (rowOffset >= rows) return hideCore;
    const r = this.page(actor) * rows + rowOffset;
    const entry = readSlots(actor)[r]?.[col];
    const node = this.root.querySelector(`.pkh-slot[data-row="${r}"][data-col="${col}"]`);
    if (node) {
      node.classList.add("pressed");
      setTimeout(() => node.classList.remove("pressed"), 140);
    }
    if (entry) this.execute(actor, entry, null);
    return true;
  }

  /** The first page's empty slots get the system's usable items (attacks, spells, features …), not plain gear. */
  async autoFill(actor) {
    const entries = hudLists(actor).filter(l => !["items", "equipment"].includes(l.key)).flatMap(l => l.items).map(i => itemEntry(i));
    const { changed, added } = fillPlan(readSlots(actor), entries, this.rows());
    if (added) await writeRows(actor, changed);
    return added;
  }

  /** GM: a creature nobody plays, with an empty bar, gets its usable items once. */
  _maybeAutoFill(actor) {
    if (!game.user.isGM || actor.hasPlayerOwner || !setting("hudNpcAutoFill", true)) return;
    const id = storageActor(actor)?.id;
    if (!id || this._autoFilled.has(id)) return;
    this._autoFilled.add(id);
    if (readSlots(actor).flat().some(Boolean)) return;
    this.autoFill(actor);
  }
}

/* ---------------- GM: damage / healing for the selected tokens ---------------- */

function openDamage(fallbackActor) {
  if (!game.user.isGM || !canDamage()) return;
  const actors = () => {
    const picked = [...new Set((canvas?.tokens?.controlled ?? []).map(tk => tk.actor).filter(Boolean))];
    return picked.length ? picked : fallbackActor ? [fallbackActor] : [];
  };
  const names = () => actors().map(a => displayName(a.name)).join(", ");
  new SimpleWindow({
    title: t("SysHud.Damage.Title"),
    width: 320,
    html: () => `<div class="pkh-sys-damage">
      <p class="hint">${esc(t("SysHud.Damage.Targets", { names: names() || "—" }))}</p>
      <input type="number" name="amount" min="0" step="1" value="" placeholder="${esc(t("SysHud.Damage.Amount"))}" autofocus>
      <div class="row">
        <button type="button" data-k="1"><i class="fa-solid fa-heart-crack"></i> ${esc(t("SysHud.Damage.Apply"))}</button>
        <button type="button" data-k="-1"><i class="fa-solid fa-heart"></i> ${esc(t("SysHud.Damage.Heal"))}</button>
      </div></div>`,
    onRender: (root, app) => {
      root.addEventListener("click", async ev => {
        const k = Number(ev.target.closest("[data-k]")?.dataset.k);
        if (!k) return;
        const n = Math.abs(Math.round(Number(root.querySelector("[name=amount]")?.value)));
        if (!n) return;
        for (const a of actors()) await applyHp(a, k * n);
        app.close();
      });
    }
  }).render({ force: true });
}

/* ---------------- start ---------------- */

export function initSystemHud() {
  const hud = new SystemHud();
  game.pf2eKrHud = { ...(game.pf2eKrHud ?? {}), hud };
  hud.mount();
  const rerender = () => hud.scheduleRender();
  const touches = actor => actor && hud.actor && (actor === hud.actor || storageActor(actor)?.id === storageActor(hud.actor)?.id);
  Hooks.on("controlToken", rerender);
  Hooks.on("canvasReady", rerender);
  Hooks.on("updateUser", rerender);
  Hooks.on("pkhPanelToggle", (key, open) => {
    if (key === "notes") for (const b of document.querySelectorAll('#pkh-hud [data-act="notes"]')) b.classList.toggle("active", open);
  });
  Hooks.on("updateActor", actor => { if (touches(actor)) rerender(); });
  Hooks.on("updateToken", token => { if (touches(token.actor)) rerender(); });
  for (const hook of ["createItem", "updateItem", "deleteItem", "createActiveEffect", "updateActiveEffect", "deleteActiveEffect"]) {
    // An effect may sit on an item of the actor (transferred effects): its parent's parent is the actor.
    Hooks.on(hook, doc => { if (touches(doc.parent) || touches(doc.parent?.parent)) rerender(); });
  }
  Hooks.on("collapseSidebar", () => setTimeout(() => hud.position(), 250));
  return hud;
}
