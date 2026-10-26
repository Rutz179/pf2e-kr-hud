import { MAX_ROWS, MODULE_ID, PAGE_COUNT, boardViewportRect, displayName, esc, readDragData, setting, signed, summaryOf, t } from "./shared.mjs";
import {
  autoFillSlots, canEditSlots, entryFromDrop, executeSlot, findItem, isLocked, openEditorsDialog, openSlotPicker,
  readSlots, resolveSlot, setSlot, storageActor, strikeForEntry, strikeUnavailable, swapSlots, withIconOverride
} from "./slots.mjs";
import { SlotCard, registerSlotCardSettings } from "./slot-card.mjs";
import { reactionBudget, setReactionUsed } from "./reactions.mjs";
import { openSkills, skillsOpenFor } from "./skills.mjs";
import { activeConditions, debugEconomy, economyOf, itemActionCost, markNextUse, registerEconomyHooks, registerUseMarking, rollbackOne, setUsed, toggleBonus } from "./economy.mjs";

const BUFF_CONDITIONS = new Set(["quickened", "hidden", "invisible", "concealed", "undetected"]);
// Getters: the labels are read when drawn (game.i18n is not ready at import time).
const SAVE_LABELS = {
  get fortitude() { return t("Saves.fortitude"); },
  get reflex() { return t("Saves.reflex"); },
  get will() { return t("Saves.will"); }
};

/* ------------------------------------------------------------------------ *
 * Data helpers
 * ------------------------------------------------------------------------ */

function hpOf(actor) {
  const hp = actor?.system?.attributes?.hp ?? {};
  const max = Math.max(1, Number(hp.max) || 1);
  const value = Math.max(0, Number(hp.value) || 0);
  const temp = Math.max(0, Number(hp.temp) || 0);
  return { value, max, temp, pct: Math.min(100, (value / max) * 100), tempPct: Math.min(100, (temp / max) * 100) };
}

/* ---------------- effect durations ---------------- */

const UNITS = new Set(["rounds", "minutes", "hours", "days"]);
const EXPIRY = { "turn-start": "TurnStart", "turn-end": "TurnEnd", "round-end": "RoundEnd" };

/** Seconds → "7분 24초" / "1시간 5분" / "2일 3시간" (exact, for the hover card). */
function longTime(sec) {
  sec = Math.max(0, Math.round(sec));
  const d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  if (d) return `${t("Time.D", { n: d })}${h ? ` ${t("Time.H", { n: h })}` : ""}`;
  if (h) return `${t("Time.H", { n: h })}${m ? ` ${t("Time.M", { n: m })}` : ""}`;
  if (m) return `${t("Time.M", { n: m })}${s ? ` ${t("Time.S", { n: s })}` : ""}`;
  return t("Time.S", { n: s });
}

/** Seconds → a few characters for the circle: "3R" · "7분" · "2시간" · "3일". */
function shortTime(sec) {
  if (sec < 60) return `${Math.max(1, Math.ceil(sec / 6))}R`;
  if (sec < 3600) return t("Time.M", { n: Math.ceil(sec / 60) });
  if (sec < 86400) return t("Time.H", { n: Math.round(sec / 3600) });
  return t("Time.D", { n: Math.round(sec / 86400) });
}

/**
 * What an effect's clock says. PF2e gives remainingDuration = { expired, remaining (seconds) }
 * and totalDuration (seconds; Infinity for "until the encounter ends"/unlimited), no label.
 */
export function durationOf(item) {
  const sys = item?.system?.duration;
  if (!sys || item.type === "condition") return null;
  const unit = sys.unit;
  const sustained = !!sys.sustained;
  const expiry = EXPIRY[sys.expiry] ? t(`Effects.Expiry.${EXPIRY[sys.expiry]}`) : "";
  if (unit === "unlimited") return { finite: false, short: "", long: t("Effects.Unlimited"), sustained, expiry: "" };
  if (unit === "encounter") return { finite: false, short: t("Effects.EncounterShort"), long: t("Effects.Encounter"), sustained, expiry: "" };
  let remaining = Number(item.remainingDuration?.remaining);
  const total = Number(item.totalDuration);
  const expired = !!item.remainingDuration?.expired;
  if (!Number.isFinite(remaining)) {
    if (!Number.isFinite(total)) return { finite: false, short: "", long: t("Effects.Unlimited"), sustained, expiry };
    remaining = total;
  }
  const rounds = Math.ceil(remaining / 6);
  const fraction = Number.isFinite(total) && total > 0 ? Math.max(0, Math.min(1, remaining / total)) : 1;
  const totalText = sys.value > 0 && UNITS.has(unit) ? t(`Time.Unit.${unit}`, { n: sys.value }) : (Number.isFinite(total) ? longTime(total) : "");
  return {
    finite: true, expired, remaining, fraction, sustained, expiry,
    short: expired ? t("Effects.ExpiredShort") : shortTime(remaining),
    long: expired ? t("Effects.Expired")
      : remaining < 60 ? t("Effects.RoundsLeft", { rounds, time: longTime(remaining) })
      : `${t("Effects.TimeLeft", { time: longTime(remaining) })}${remaining <= 600 ? ` · ${t("Effects.AboutRounds", { rounds })}` : ""}`,
    total: totalText,
    ending: expired || remaining <= 6
  };
}

function effectsOf(actor) {
  const out = [];
  for (const c of activeConditions(actor)) {
    out.push({ kind: "condition", id: c.id, slug: c.slug, name: c.name, img: c.img, value: c.value ?? null, buff: BUFF_CONDITIONS.has(c.slug) });
  }
  for (const e of actor?.itemTypes?.effect ?? []) {
    out.push({ kind: "effect", id: e.id, slug: e.slug, name: e.name, img: e.img, value: e.badge?.value ?? null, buff: true, dur: durationOf(e) });
  }
  for (const a of actor?.itemTypes?.affliction ?? []) {
    out.push({ kind: "effect", id: a.id, slug: a.slug, name: a.name, img: a.img, value: a.badge?.value ?? a.stage ?? null, buff: false, dur: durationOf(a) });
  }
  return out;
}

const SPEED_LABELS = {
  land: "",
  get burrow() { return t("Hud.SpeedType.burrow"); },
  get climb() { return t("Hud.SpeedType.climb"); },
  get fly() { return t("Hud.SpeedType.fly"); },
  get swim() { return t("Hud.SpeedType.swim"); },
  get travel() { return t("Hud.SpeedType.travel"); }
};

/** All movement speeds: PF2e 7 (system.movement.speeds) or older (attributes.speed + otherSpeeds). */
function speedsOf(actor) {
  const out = [];
  const speeds = actor?.system?.movement?.speeds;
  if (speeds && typeof speeds === "object") {
    for (const [type, v] of Object.entries(speeds)) {
      const value = Number(v?.value ?? v?.total ?? v);
      if (value > 0) out.push({ type, value });
    }
  }
  if (!out.length) {
    const sp = actor?.system?.attributes?.speed;
    const land = Number(sp?.total ?? sp?.value);
    if (land > 0) out.push({ type: "land", value: land });
    for (const o of sp?.otherSpeeds ?? []) {
      const value = Number(o?.total ?? o?.value);
      if (value > 0) out.push({ type: o.type, value });
    }
  }
  out.sort((a, b) => (a.type === "land" ? -1 : b.type === "land" ? 1 : 0));
  return out;
}

function savesOf(actor) {
  const s = actor?.saves ?? {};
  const mod = key => s[key]?.mod ?? actor?.system?.saves?.[key]?.value ?? null;
  const spell = (actor?.itemTypes?.spellcastingEntry ?? [])
    .map(e => Number(e.statistic?.dc?.value ?? e.system?.spelldc?.dc))
    .filter(v => Number.isFinite(v) && v > 0);
  const ac = Number(actor?.armorClass?.value ?? actor?.system?.attributes?.ac?.value);
  const perception = actor?.perception?.mod ?? actor?.system?.perception?.mod ?? actor?.system?.attributes?.perception?.value ?? null;
  return {
    fortitude: mod("fortitude"), reflex: mod("reflex"), will: mod("will"),
    perception, ac: Number.isFinite(ac) ? ac : null,
    spellDC: spell.length ? Math.max(...spell) : null
  };
}

function keyLabel(rowOffset, col) {
  const action = `slot-${rowOffset + 1}-${(col + 1) % 10}`;
  const binding = game.keybindings.get(MODULE_ID, action)?.[0];
  if (!binding?.key) return "";
  const key = binding.key.replace(/^Digit/, "").replace(/^Key/, "").replace(/^Numpad/, "N");
  const mods = (binding.modifiers ?? []).map(m => ({ Shift: "⇧", Alt: "⌥", Control: "^" }[m] ?? m)).join("");
  return `${mods}${key}`;
}

async function openSheetTab(actor, tab) {
  const sheet = actor?.sheet;
  if (!sheet) return;
  await sheet.render(true);
  setTimeout(() => {
    try {
      if (typeof sheet.changeTab === "function") sheet.changeTab(tab, "primary");
      else if (sheet._tabs?.[0]?.activate) sheet._tabs[0].activate(tab);
      else sheet.activateTab?.(tab);
    } catch (_) { /* tab may not exist on this sheet type */ }
  }, 60);
}

/**
 * [사용] exactly like the sheet: PF2e's handler for that button isn't exposed,
 * so we press the real button in the actor sheet (opening it briefly if it was
 * closed). Falls back to posting the card if the sheet has no such button.
 */
async function useLikeSheet(actor, item, event) {
  const sheet = actor.sheet;
  const wasOpen = !!sheet?.rendered;
  if (!wasOpen) await sheet.render(true);
  for (let tries = 0; tries < 10; tries++) {
    const root = sheet.element?.[0] ?? sheet.element;
    const row = root?.querySelector?.(`[data-item-id="${item.id}"]`);
    const button = row?.querySelector?.('[data-action="use-action"], [data-action="use"], [data-action*="use-action"], button.use-action');
    if (button) {
      button.click();
      markNextUse(actor, itemActionCost(item));
      if (!wasOpen) setTimeout(() => sheet.close(), 400);
      return;
    }
    await new Promise(r => setTimeout(r, 80));
  }
  if (!wasOpen) sheet.close();
  markNextUse(actor, itemActionCost(item));
  await item.toMessage?.(event);
}

/*
 * Ways to cast a spell right now, the way the sheet would.
 * Each option: { label, rank, kind, slotId?, ok, reason? }; kind is cantrip,
 * focus-cantrip, focus, innate or slot (focus ones get their own colour).
 *  - cantrips: always
 *  - focus spells: one focus point
 *  - innate: its daily uses
 *  - prepared: every rank it is prepared at; off once all are expended
 *  - spontaneous / flexible: its rank, plus higher ranks for a signature spell
 * Rituals are never cast from a quickslot.
 */
function spellCastOptions(actor, spell) {
  const entry = spell?.spellcasting;
  if (!entry || typeof entry.cast !== "function" || spell.isRitual) return [];
  const base = Number(spell.rank ?? spell.baseRank ?? spell.system?.level?.value ?? 1) || 1;
  const slots = entry.system?.slots ?? {};
  const slotOf = r => slots[`slot${r}`] ?? {};

  // Focus cantrips (hexes, compositions …) are free, like any cantrip, but still focus magic.
  if (spell.isCantrip) return [{ label: t("Spell.Cantrip"), rank: base, kind: spell.isFocusSpell ? "focus-cantrip" : "cantrip", ok: true }];

  if (spell.isFocusSpell) {
    const focus = actor.system?.resources?.focus ?? {};
    const fp = Number(focus.value ?? 0);
    const max = Number(focus.max ?? 0);
    return [{ label: max ? `(${fp}/${max})` : `(${fp})`, rank: base, kind: "focus", ok: fp > 0, reason: fp > 0 ? "" : t("Spell.NoFocus") }];
  }

  if (entry.isInnate) {
    const uses = spell.system?.location?.uses;
    const left = uses && Number(uses.max) ? Number(uses.value) : null;
    return [{ label: left === null ? t("Spell.Innate") : t("Spell.InnateUses", { left, max: Number(uses.max) }), rank: base, kind: "innate", ok: left === null || left > 0, reason: t("Spell.NoUsesToday") }];
  }

  if (entry.isPrepared && !entry.isFlexible) {
    const options = [];
    for (let r = base; r <= 10; r++) {
      const prepared = slotOf(r).prepared;
      const list = Array.isArray(prepared) ? prepared : Object.values(prepared ?? {});
      const mine = list.map((p, slotId) => ({ ...p, slotId })).filter(p => p?.id === spell.id);
      if (!mine.length) continue;
      const free = mine.find(p => !p.expended);
      options.push({ label: t("Spell.Rank", { rank: r }), rank: r, kind: "slot", slotId: free?.slotId ?? mine[0].slotId, ok: !!free, reason: t("Spell.PreparedUsed") });
    }
    return options.length ? options : [{ label: t("Spell.NotPrepared"), rank: base, kind: "slot", ok: false, reason: t("Spell.NotPreparedToday") }];
  }

  // Spontaneous or flexible: spend a slot of the chosen rank.
  const signature = !!spell.system?.location?.signature;
  const options = [];
  for (let r = base; r <= 10; r++) {
    if (r > base && !signature) break;
    const slot = slotOf(r);
    const max = Number(slot.max) || 0;
    if (!max) continue;
    const value = Number(slot.value) || 0;
    options.push({ label: t("Spell.RankSlots", { rank: r, value, max }), rank: r, kind: "slot", ok: value > 0, reason: t("Spell.NoSlotsRank") });
  }
  return options.length ? options : [{ label: t("Spell.Rank", { rank: base }), rank: base, kind: "slot", ok: false, reason: t("Spell.NoSlots") }];
}

/** Cast through the spellcasting entry, so slots and focus points are spent like on the sheet. */
async function castSpell(actor, spell, option) {
  const entry = spell.spellcasting;
  if (!entry?.cast) return spell.toMessage?.();
  // The cast is counted toward the action pips by the wrapper in economy.mjs.
  return entry.cast(spell, { rank: option.rank, level: option.rank, slotId: option.slotId, consume: true, message: true });
}

/** Spell DC → a card with all three saves at that DC, for the GM to roll targets. */
async function postSpellDcRequest(actor, dc) {
  const checks = Object.keys(SAVE_LABELS).map(k => `@Check[${k}|dc:${dc}]`).join(" ");
  await ChatMessage.create({
    speaker: ChatMessage.getSpeaker({ actor }),
    content: `<div class="pkh-save-request">
      <header><i class="fa-solid fa-wand-sparkles"></i> <strong>${esc(displayName(actor.name))}</strong> — ${t("Hud.SpellDc")} <b>${dc}</b></header>
      <p>${t("Hud.SaveRequest")}</p>
      <div class="checks">${checks}</div>
    </div>`
  });
}

/** A save of mine → its DC (10 + modifier) as a card, e.g. 인내 +16 → 인내 DC 26. */
async function postSaveDc(actor, key, mod) {
  const dc = 10 + Number(mod);
  await ChatMessage.create({
    speaker: ChatMessage.getSpeaker({ actor }),
    content: `<div class="pkh-save-request">
      <header><i class="fa-solid fa-shield-halved"></i> <strong>${esc(displayName(actor.name))}</strong> — ${SAVE_LABELS[key]} DC <b>${dc}</b></header>
      <p>${t("Hud.SaveDcLine", { save: SAVE_LABELS[key], mod: signed(mod) })}</p>
      <div class="checks">@Check[${key}|dc:${dc}]</div>
    </div>`
  });
}

/* ------------------------------------------------------------------------ */

export class PartyHud {
  constructor() {
    this.root = null;
    this.inspectEl = null;
    this.cardEl = null;
    this.actor = null;
    this.inspectActor = null;
    this.popover = null;
    this.pages = new Map();
    this.lastUuid = null;
    this.eco = null;
    this._frame = 0;
  }

  mount() {
    if (this.root) return;
    const make = (id, label) => {
      const el = document.createElement("section");
      el.id = id;
      el.setAttribute("aria-label", label);
      document.body.appendChild(el);
      return el;
    };
    this.root = make("pkh-hud", t("Hud.Aria.Hud"));
    this.inspectEl = make("pkh-inspect", t("Hud.Aria.Inspect"));
    this.cardEl = make("pkh-effect-card", t("Hud.Aria.EffectCard"));
    this.cardEl.classList.add("hidden");
    this.mapEl = make("pkh-map-pop", t("Hud.Aria.MapPopup"));
    this.mapEl.classList.add("hidden");
    this.mapEl.addEventListener("click", ev => this._onMapChoice(ev));
    document.addEventListener("pointerdown", ev => {
      if (!this.mapEl.classList.contains("hidden") && !ev.target.closest("#pkh-map-pop, .pkh-slot.t-strike")) this._closeMap();
    });
    document.addEventListener("keydown", ev => { if (ev.key === "Escape") this._closeMap(); });

    const r = this.root;
    r.addEventListener("click", ev => this._onClick(ev));
    r.addEventListener("contextmenu", ev => this._onContext(ev));
    r.addEventListener("mousedown", ev => { if (ev.button === 1 && ev.target.closest(".pkh-slot")) ev.preventDefault(); });
    r.addEventListener("auxclick", ev => this._onAuxClick(ev));
    r.addEventListener("dragstart", ev => this._onDragStart(ev));
    r.addEventListener("dragover", ev => { if (ev.target.closest(".pkh-slot")) ev.preventDefault(); });
    r.addEventListener("drop", ev => this._onDrop(ev));
    r.addEventListener("wheel", ev => this._onWheel(ev), { passive: false });

    for (const host of [this.root, this.inspectEl]) {
      host.addEventListener("pointerover", ev => this._effectHover(ev, host));
      host.addEventListener("pointerout", ev => this._effectLeave(ev));
    }
    this.inspectEl.addEventListener("click", ev => {
      if (ev.target.closest("[data-act=close-inspect]")) this.inspect(null);
    });
    this.cardEl.addEventListener("pointerenter", () => clearTimeout(this._cardHide));
    this.cardEl.addEventListener("pointerleave", () => this._hideCard(150));
    this.cardEl.addEventListener("click", ev => this._onCardClick(ev));

    this.slotCard = new SlotCard(this);

    window.addEventListener("resize", () => this.position());
    this.scheduleRender();
  }

  /* ---------------- which actor is shown ---------------- */

  /**
   * The last owned token you selected stays on the bar after you deselect it,
   * so the HUD doesn't blink away every time you click empty canvas.
   */
  pickActor() {
    // Pinned: stays on this character while you select other tokens (e.g. to apply effects).
    const pinned = this._pinned();
    if (pinned?.isOwner) return pinned;
    const controlled = canvas?.tokens?.controlled ?? [];
    const current = controlled.length ? controlled[controlled.length - 1].actor : null;
    if (current?.isOwner) {
      this._remember(current);
      return current;
    }
    const last = this._lastActor();
    if (last?.isOwner) return last;
    const own = game.user.isGM ? null : game.user.character;
    return own?.isOwner ? own : null;
  }

  _pinned() {
    const uuid = setting("hudPinnedActor", "");
    if (!uuid) return null;
    try {
      const doc = fromUuidSync(uuid);
      return doc?.documentName === "Actor" ? doc : null;
    } catch (_) {
      return null;
    }
  }

  _remember(actor) {
    if (this.lastUuid === actor.uuid) return;
    this.lastUuid = actor.uuid;
    game.settings.set(MODULE_ID, "hudLastActor", actor.uuid)?.catch?.(() => {});
  }

  _lastActor() {
    const uuid = this.lastUuid ?? setting("hudLastActor", "");
    if (!uuid) return null;
    try {
      const doc = fromUuidSync(uuid);
      return doc?.documentName === "Actor" ? doc : null;
    } catch (_) {
      return null;
    }
  }

  inspect(actor) {
    // Players never inspect NPCs/monsters, whatever their permission.
    const allowed = actor && actor.testUserPermission(game.user, "OBSERVER") && (game.user.isGM || actor.type !== "npc");
    this.inspectActor = allowed ? actor : null;
    this.scheduleRender();
  }

  rows() {
    return Math.clamp(Number(setting("hudRows", 1)) || 1, 1, MAX_ROWS);
  }

  page(actor) {
    return this.pages.get(storageActor(actor)?.id) ?? 0;
  }

  setPage(actor, page) {
    const p = ((page % PAGE_COUNT) + PAGE_COUNT) % PAGE_COUNT;
    this.pages.set(storageActor(actor)?.id, p);
    this.scheduleRender();
  }

  /* ---------------- rendering ---------------- */

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
    document.body.classList.toggle("pkh-hide-effects", enabled && setting("hudHideEffectsPanel", true));

    this.root.classList.toggle("hidden", !actor);
    if (actor) {
      const editable = canEditSlots(actor);
      const locked = isLocked(actor);
      this.eco = economyOf(actor);
      this._maybeAutoFill(actor);
      this.root.classList.toggle("unlocked", editable && !locked);
      this.root.innerHTML = `
        <div class="pkh-inner">
          ${this._effectsHtml(actor)}
          <div class="pkh-hp-row">
            ${this._hpHtml(actor, true)}
            ${this._apHtml()}
          </div>
          ${this._slotsHtml(actor, editable, locked)}
          ${this._barHtml(actor)}
          ${this.popover ? this._popoverHtml(actor) : ""}
        </div>`;
    } else {
      this.root.innerHTML = "";
      this.popover = null;
    }

    this._renderInspect();
    this.position();
    this.slotCard?.afterRender();
  }

  _renderInspect() {
    const el = this.inspectEl;
    const a = this.inspectActor;
    const show = !!a && a !== this.actor && !a.isOwner;
    el.classList.toggle("hidden", !show);
    if (!show) {
      el.innerHTML = "";
      return;
    }
    // Observers see the bar too, read-only: nothing on it can be used or moved.
    const bar = readSlots(a).flat().some(Boolean) ? this._slotsHtml(a, false, true) : "";
    el.innerHTML = `
      <header><span>${esc(displayName(a.name))}</span>
        <button type="button" data-act="close-inspect" aria-label="${esc(t("Common.Close"))}"><i class="fa-solid fa-xmark"></i></button>
      </header>
      ${this._effectsHtml(a)}
      ${this._hpHtml(a, false)}
      ${bar ? `<div class="pkh-readonly">${bar}</div>` : ""}`;
  }

  /** Slot size follows the visible canvas width; the user scale multiplies everything. */
  position() {
    const rect = boardViewportRect();
    const center = `${Math.round(rect.left + rect.width / 2)}px`;
    const scale = Number(setting("hudScale", 1)) || 1;
    const slot = Math.round(Math.min(64, Math.max(42, rect.width / 30)));
    const effect = Math.clamp(Number(setting("hudEffectSize", 42)) || 42, 20, 72);
    // Effects may run wider than the quick slots, up to the visible canvas (in the HUD's own, unscaled px);
    // past that they wrap, the new rows going on top. "bar": they wrap at the quick slots' width.
    const effectsMax = setting("hudEffectsWidth", "screen") === "bar" ? "100%" : `${Math.max(240, Math.floor((rect.width - 32) / scale))}px`;
    this.root?.style.setProperty("--pkh-effects-max", effectsMax);
    for (const el of [this.root, this.inspectEl]) {
      el?.style.setProperty("--pkh-effect-size", `${effect}px`);
      el?.style.setProperty("--pkh-center", center);
      el?.style.setProperty("--pkh-scale", String(scale));
      el?.style.setProperty("--pkh-slot", `${slot}px`);
    }
    const hudHeight = this.root && !this.root.classList.contains("hidden") ? this.root.offsetHeight * scale : 0;
    this.inspectEl?.style.setProperty("--pkh-hud-h", `${Math.round(hudHeight)}px`);
  }

  _effectsHtml(actor) {
    const list = effectsOf(actor);
    if (!list.length) return `<div class="pkh-effects empty"></div>`;
    const showDur = setting("hudEffectDurations", true) !== false;
    // The zone keeps the effects from widening the quick slots under them (see hud.css, v2.2).
    return `<div class="pkh-effects-zone"><div class="pkh-effects">${list.map(e => {
      const d = showDur ? e.dur : null;
      const ring = d?.finite ? ` style="--pkh-left:${(d.fraction * 360).toFixed(1)}deg"` : "";
      const cls = ["pkh-effect", e.buff ? "buff" : "debuff", d?.finite ? "timed" : "", d?.finite && d.fraction <= 0.25 ? "low" : "", d?.ending ? "ending" : "", d?.sustained ? "sustained" : ""].join(" ");
      return `
      <div class="${cls}" data-kind="${e.kind}" data-id="${e.id}" data-slug="${esc(e.slug)}"${ring}>
        <img src="${esc(e.img)}" alt="${esc(e.name)}">
        ${d?.short ? `<span class="dur">${esc(d.short)}</span>` : ""}
        ${e.value ? `<span class="val">${esc(e.value)}</span>` : ""}
      </div>`;
    }).join("")}</div></div>`;
  }

  _hpHtml(actor, full) {
    const hp = hpOf(actor);
    const numbers = full || setting("portraitHpNumbers", "owner") === "all";
    const color = hp.pct > 50 ? "var(--pkh-hp-high)" : hp.pct > 25 ? "var(--pkh-hp-mid)" : "var(--pkh-hp-low)";
    return `
      <div class="pkh-hp">
        <div class="pkh-hp-label">
          <span class="name">${esc(displayName(actor.name))}${full ? this._speedHtml(actor) : ""}</span>
          ${numbers ? `<span class="num">${hp.value} / ${hp.max}${hp.temp ? ` <b>+${hp.temp}</b>` : ""}</span>` : ""}
        </div>
        <div class="pkh-hp-bar">
          <div class="fill" style="width:${hp.pct}%;background:${color}"></div>
          ${hp.temp ? `<div class="temp" style="width:${hp.tempPct}%"></div>` : ""}
        </div>
      </div>`;
  }

  _apHtml() {
    const eco = this.eco;
    const source = t(`Hud.ApSource.${["tracker", "chat", "manual"].includes(eco.source) ? eco.source : "manual"}`);
    const pips = [0, 1, 2, 3].map(i => {
      const bonus = i === 3;
      const available = bonus ? eco.quickened : true;
      const used = i < eco.used;
      const lost = !bonus && i >= 3 - eco.slowed;
      const cls = ["pkh-pip", bonus ? "bonus" : "base", used ? "used" : "", !available ? "idle" : "", lost && !used ? "lost" : ""].join(" ");
      const tip = (bonus ? t(eco.quickened ? "Hud.Pip.Bonus" : "Hud.Pip.BonusNone") : `${t("Hud.Pip.Nth", { n: i + 1 })}${lost ? ` ${t("Hud.Pip.Lost")}` : ""}`)
        + `<br><small>${t("Hud.Pip.Help")}</small>`;
      return `<button type="button" class="${cls}" data-act="pip" data-index="${i}" data-tooltip="${tip}" aria-label="${tip}"></button>`;
    }).join("");
    const over = eco.used > eco.max;
    let rx = "";
    if (game.combat?.started && setting("hudReactionPip", true) !== false) {
      const b = reactionBudget(this.actor);
      rx = `<span class="pkh-rx-sep"></span>` + Array.from({ length: b.max }, (_, i) => {
        const used = i < b.used;
        const tip = `${t("Hud.Rx.Count", { left: b.left, max: b.max })}${used ? ` — ${t("Hud.Rx.Used")}` : ""}<br><small>${t("Hud.Rx.Help")}</small>`;
        return `<button type="button" class="pkh-pip reaction ${used ? "used" : ""}" data-act="rx-pip" data-tooltip="${tip}" aria-label="${tip}"><i class="fa-solid fa-reply"></i></button>`;
      }).join("");
    }
    return `
      <div class="pkh-ap ${over ? "over" : ""}" data-tooltip="${t("Hud.Ap.Count", { used: eco.used, max: eco.max })} · ${source}<br><small>${t("Hud.Ap.Note")}</small>">
        ${pips}${rx}
        <button type="button" class="pkh-rollback" data-act="rollback" ${eco.used ? "" : "disabled"}
                data-tooltip="${t("Hud.Ap.Undo")}<br><small>${t("Hud.Ap.UndoAll")}</small>" aria-label="${t("Hud.Ap.Undo")}"><i class="fa-solid fa-rotate-left"></i></button>
      </div>`;
  }

  _slotsHtml(actor, editable, locked) {
    const rows = this.rows();
    const page = this.page(actor);
    const data = readSlots(actor);
    const dragOk = editable && !locked;
    const attacks = this.eco?.attacks ?? 0;

    const rowHtml = Array.from({ length: rows }, (_, offset) => {
      const r = page * rows + offset;
      if (r >= data.length) return "";
      const cells = data[r].map((entry, c) => {
        const v = withIconOverride(resolveSlot(actor, entry, { attacks }));
        const key = keyLabel(offset, c);
        if (!v) {
          return `<div class="pkh-slot empty" data-row="${r}" data-col="${c}" ${dragOk ? `data-tooltip="${t("Hud.Slot.EmptyTip")}"` : ""}>
            <span class="key">${esc(key)}</span></div>`;
        }
        let tip = esc(v.label);
        if (entry.type === "strike" && v.map?.length) {
          tip += `<br>${v.map.join(" / ")}<br><small>${t("Hud.Slot.StrikeTip")}</small>`;
        }
        if (v.auto) tip += `<br><small>${t("Hud.Slot.Auto")}</small>`;
        const cls = ["pkh-slot", v.disabled ? "pkh-off" : "", v.broken ? "broken" : "", v.auto ? "auto" : "", v.active ? "active" : "",
          `t-${entry.type}`, entry.type === "strike" ? `map-${v.mapIndex ?? 0}` : ""].join(" ");
        const visual = v.img ? `<img src="${esc(v.img)}" alt="" draggable="false">` : `<i class="${esc(v.icon)}"></i>`;
        const label = !v.img ? `<span class="label">${esc(v.label)}</span>` : "";
        const tipAttr = SlotCard.enabled() ? "data-pkh-tip" : "data-tooltip";
        return `<div class="${cls}" data-row="${r}" data-col="${c}" draggable="${dragOk}" ${tipAttr}="${tip}">
          <span class="key">${esc(key)}</span>${visual}${label}
          ${v.broken ? `<i class="fa-solid fa-xmark broken-mark"></i>` : ""}
          ${v.badge !== null && v.badge !== undefined && v.badge !== "" ? `<span class="badge">${esc(v.badge)}</span>` : ""}
        </div>`;
      }).join("");
      return `<div class="pkh-row">${cells}</div>`;
    }).join("");

    const dots = Array.from({ length: PAGE_COUNT }, (_, p) =>
      `<button type="button" class="pkh-dot ${p === page ? "active" : ""}" data-act="page" data-page="${p}" aria-label="${t("Hud.Page", { n: p + 1 })}"></button>`).join("");

    return `
      <div class="pkh-slots rows-${rows}">
        <div class="pkh-slots-side">
          <button type="button" class="pkh-icon lock ${locked ? "" : "open"}" data-act="lock" ${editable ? "" : "disabled"}
                  data-tooltip="${t(editable ? (locked ? "Hud.Lock.Locked" : "Hud.Lock.Editing") : "Hud.Lock.NoPermission")}">
            <i class="fa-solid ${locked ? "fa-lock" : "fa-lock-open"}"></i></button>
          <button type="button" class="pkh-icon" data-act="rows" data-tooltip="${t("Hud.Rows", { n: rows })}">
            <span class="rows-glyph r${rows}"></span></button>
          ${game.user.isGM ? `<button type="button" class="pkh-icon" data-act="editors" data-tooltip="${t("Hud.Editors")}"><i class="fa-solid fa-user-gear"></i></button>` : ""}
          <button type="button" class="pkh-icon pin ${setting("hudPinnedActor", "") ? "open" : ""}" data-act="pin"
                  data-tooltip="${t(setting("hudPinnedActor", "") ? "Hud.Pin.On" : "Hud.Pin.Off")}">
            <i class="fa-solid fa-thumbtack"></i></button>
          ${game.user.isGM ? `<button type="button" class="pkh-icon" data-act="autofill" data-tooltip="${t("Hud.AutoFill")}<br><small>${t("Hud.AutoFillOrder")}</small>"><i class="fa-solid fa-wand-magic-sparkles"></i></button>` : ""}
        </div>
        <div class="pkh-grid">${rowHtml}</div>
        <div class="pkh-pages" data-tooltip="${t("Hud.PagesTip")}">${dots}</div>
      </div>`;
  }

  _barHtml(actor) {
    const s = savesOf(actor);
    const card = setting("hudSaveCard", true);
    const save = key => (s[key] === null || s[key] === undefined ? "" :
      `<button type="button" class="pkh-chip" data-act="save" data-save="${key}"
        data-tooltip="${t("Hud.SaveRoll", { save: SAVE_LABELS[key] })}${card ? `<br><small>${t("Hud.SaveCardTip", { save: SAVE_LABELS[key], dc: 10 + Number(s[key]) })}</small>` : ""}">
        <em>${SAVE_LABELS[key]}</em>${esc(signed(s[key]))}</button>`);
    const perception = s.perception === null || s.perception === undefined ? "" :
      `<button type="button" class="pkh-chip" data-act="perception" data-tooltip="${t("Hud.PerceptionRoll")}"><em>${t("Hud.Perception")}</em>${esc(signed(s.perception))}</button>`;
    const ac = s.ac === null ? "" : `<span class="pkh-chip static" data-tooltip="${t("Hud.AcTip")}"><em>AC</em>${s.ac}</span>`;
    const dc = s.spellDC ? `<button type="button" class="pkh-chip dc" data-act="dc" data-tooltip="${t("Hud.DcTip")}<br><small>${t("Hud.DcTipDetail", { dc: s.spellDC })}</small>">
        <em>${t("Hud.SpellDc")}</em>${s.spellDC}</button>` : "";
    return `
      <div class="pkh-bar">
        <div class="pkh-bar-left">
          <button type="button" class="pkh-mini ${this.popover === "inventory" ? "active" : ""}" data-act="pop" data-pop="inventory" data-tooltip="${t("Hud.Bar.Inventory")}">
            <i class="fa-solid fa-sack"></i></button>
          ${game.user.isGM ? `<button type="button" class="pkh-mini pkh-request-btn" data-act="roll-request" data-tooltip="${t("Hud.RollRequest")}" aria-label="${t("Hud.RollRequest")}"><i class="fa-solid fa-bullhorn"></i></button>` : ""}
        </div>
        <div class="pkh-saves">${ac}${save("fortitude")}${save("reflex")}${save("will")}${perception}</div>
        <div class="pkh-bar-right">
          ${actor.type === "character" ? `<button type="button" class="pkh-mini" data-act="faces" data-tooltip="${t("Hud.Bar.Faces")}">
            <i class="fa-solid fa-masks-theater"></i></button>` : ""}
          <button type="button" class="pkh-mini ${skillsOpenFor(actor) ? "active" : ""}" data-act="skills" data-tooltip="${t("Hud.Bar.Skills")}<br><small>${t("Hud.Bar.SkillsHelp")}</small>">
            <i class="fa-solid fa-list-check"></i></button>
          <button type="button" class="pkh-mini" data-act="sheet-actions" data-tooltip="${t("Hud.Bar.Sheet")}">
            <i class="fa-solid fa-person-running"></i></button>
          <button type="button" class="pkh-mini ${this.popover === "grimoire" ? "active" : ""}" data-act="pop" data-pop="grimoire" data-tooltip="${t("Hud.Bar.Grimoire")}">
            <i class="fa-solid fa-book-open"></i></button>
        </div>
      </div>`;
  }

  _popoverHtml(actor) {
    const itemCell = item => {
      const qty = Number(item.quantity ?? 1);
      return `<div class="pkh-inv-cell" draggable="true" data-item-id="${item.id}" data-tooltip="${esc(item.name)}<br><small>${t("Hud.Pop.ItemHelp")}</small>">
        <img src="${esc(item.img)}" alt="">${qty > 1 ? `<span class="badge">${qty}</span>` : ""}</div>`;
    };
    const listRow = item => `
      <div class="pkh-list-row" draggable="true" data-item-id="${item.id}" data-tooltip="${t("Hud.Pop.ItemHelp")}">
        <img src="${esc(item.img)}" alt=""><span>${esc(item.name)}</span></div>`;

    if (this.popover === "inventory") {
      const order = { consumable: 0, weapon: 1, shield: 2, armor: 3, equipment: 4, backpack: 5, treasure: 6 };
      const items = actor.items.filter(i => i.isOfType?.("physical"))
        .sort((a, b) => (order[a.type] ?? 9) - (order[b.type] ?? 9) || a.name.localeCompare(b.name, "ko"));
      return `<div class="pkh-pop inventory">
        <header>${t("Hud.Pop.Inventory")} <small>${t("Hud.Pop.InventoryHint")}</small></header>
        <div class="pkh-inv-grid">${items.map(itemCell).join("") || `<p>${t("Hud.Pop.NoItems")}</p>`}</div></div>`;
    }

    const spells = (actor.itemTypes?.spell ?? []).slice().sort((a, b) =>
      (a.isCantrip ? 0 : a.rank ?? 0) - (b.isCantrip ? 0 : b.rank ?? 0) || a.name.localeCompare(b.name, "ko"));
    const groups = new Map();
    for (const sp of spells) {
      const key = sp.isCantrip ? t("Hud.Pop.Cantrips") : sp.isFocusSpell ? t("Hud.Pop.Focus") : t("Spell.Rank", { rank: sp.rank ?? "?" });
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(sp);
    }
    const feats = (actor.itemTypes?.feat ?? []).slice().sort((a, b) => a.name.localeCompare(b.name, "ko"));
    const actions = (actor.itemTypes?.action ?? []).slice().sort((a, b) => a.name.localeCompare(b.name, "ko"));
    const spellHtml = [...groups].map(([k, list]) => `<h4>${esc(k)}</h4>${list.map(listRow).join("")}`).join("");
    return `<div class="pkh-pop grimoire">
      <header>${t("Hud.Pop.Grimoire")} <small>${t("Hud.Pop.GrimoireHint")}</small></header>
      <div class="pkh-grim-cols">
        <div>${spellHtml || `<p>${t("Hud.Pop.NoSpells")}</p>`}</div>
        <div><h4>${t("Hud.Pop.Actions")}</h4>${actions.map(listRow).join("") || "<p>—</p>"}<h4>${t("Hud.Pop.Feats")}</h4>${feats.map(listRow).join("")}</div>
      </div></div>`;
  }

  /* ---------------- effect hover card ---------------- */

  _effectHover(ev, host) {
    const node = ev.target.closest(".pkh-effect");
    if (!node) return;
    clearTimeout(this._cardHide);
    clearTimeout(this._cardShow);
    this._cardShow = setTimeout(() => this._showCard(node, host), 700);
  }

  _effectLeave(ev) {
    if (!ev.target.closest(".pkh-effect")) return;
    clearTimeout(this._cardShow);
    this._hideCard(200);
  }

  _hideCard(delay) {
    clearTimeout(this._cardHide);
    this._cardHide = setTimeout(() => this.cardEl?.classList.add("hidden"), delay);
  }

  _showCard(node, host) {
    const actor = host === this.inspectEl ? this.inspectActor : this.actor;
    const item = actor?.items.get(node.dataset.id) ?? activeConditions(actor).find(c => c.id === node.dataset.id);
    if (!item || !node.isConnected) return;
    const rawValue = item.value ?? item.badge?.value;
    // "부상 3" already carries its number — don't print "부상 3 3".
    const value = rawValue && !String(item.name ?? "").trim().endsWith(String(rawValue)) ? rawValue : null;
    const summary = summaryOf(item) || t("Common.NoDescription");
    const d = durationOf(item);
    const remaining = d ? [
      `<b>${esc(d.long)}</b>`,
      d.total ? t("Effects.Total", { total: esc(d.total) }) : "",
      d.expiry,
      d.sustained ? `<span class="sus">${t("Effects.NeedsSustain")}</span>` : ""
    ].filter(Boolean).join(" · ") : "";
    this.cardEl.dataset.actorUuid = actor.uuid;
    this.cardEl.dataset.itemId = item.id;
    this.cardEl.innerHTML = `
      <header>
        <img src="${esc(item.img)}" alt="">
        <strong>${esc(item.name)}${value ? ` ${esc(value)}` : ""}</strong>
        ${actor.isOwner && actor.items.get(item.id) ? `<button type="button" data-act="card-edit" data-tooltip="${t("Effects.Edit")}" aria-label="${t("Effects.Edit")}"><i class="fa-solid fa-pen"></i></button>` : ""}
        <button type="button" data-act="card-chat" data-tooltip="${t("Effects.ToChat")}" aria-label="${t("Effects.ToChat")}"><i class="fa-solid fa-comment"></i></button>
      </header>
      ${remaining ? `<div class="dur"><i class="fa-regular fa-hourglass-half"></i> ${remaining}</div>` : ""}
      <p>${esc(summary)}</p>
      ${actor.isOwner ? `<footer>${t(item.type === "condition" || item.badge?.type === "counter" ? "Effects.CounterHelp" : "Effects.RemoveHelp")} · ${t("Effects.RemoveAll")}</footer>` : ""}`;
    this.cardEl.classList.remove("hidden");
    const box = node.getBoundingClientRect();
    const card = this.cardEl.getBoundingClientRect();
    const left = Math.min(window.innerWidth - card.width - 8, Math.max(8, box.left + box.width / 2 - card.width / 2));
    this.cardEl.style.left = `${Math.round(left)}px`;
    this.cardEl.style.top = `${Math.round(Math.max(8, box.top - card.height - 8))}px`;
  }

  async _onCardClick(ev) {
    if (ev.target.closest("[data-act=card-edit]")) {
      const owner = fromUuidSync(this.cardEl.dataset.actorUuid);
      owner?.items.get(this.cardEl.dataset.itemId)?.sheet?.render(true);
      this.cardEl.classList.add("hidden");
      return;
    }
    if (!ev.target.closest("[data-act=card-chat]")) return;
    const actor = fromUuidSync(this.cardEl.dataset.actorUuid);
    await actor?.items.get(this.cardEl.dataset.itemId)?.toMessage?.();
    this.cardEl.classList.add("hidden");
  }

  /* ---------------- events ---------------- */

  _editGuard(actor) {
    if (!canEditSlots(actor)) {
      ui.notifications.warn(`PF2e-KR HUD | ${t("Hud.Notify.NoEdit")}`);
      return false;
    }
    if (isLocked(actor)) {
      ui.notifications.info(`PF2e-KR HUD | ${t("Hud.Notify.Locked")}`);
      return false;
    }
    return true;
  }

  _slotAt(node) {
    const row = Number(node.dataset.row);
    const col = Number(node.dataset.col);
    return { row, col, entry: readSlots(this.actor)[row]?.[col] ?? null };
  }

  /** Auto MAP = attacks already made this turn (tracker or chat), capped at the 3rd. */
  _autoMap() {
    return Math.min(2, this.eco?.attacks ?? 0);
  }

  async _onClick(ev) {
    const actor = this.actor;
    if (!actor) return;

    const effect = ev.target.closest(".pkh-effect");
    if (effect) {
      if (ev.shiftKey) return this._removeEffect(actor, effect);
      if (effect.dataset.kind === "condition") return actor.increaseCondition?.(effect.dataset.slug);
      // Effects with a counter badge (e.g. stacking spell effects) go up like conditions.
      const item = actor.items.get(effect.dataset.id);
      if (item?.badge?.type === "counter" && typeof item.increase === "function") return item.increase();
      return;
    }

    const cell = ev.target.closest(".pkh-inv-cell, .pkh-list-row");
    if (cell) {
      await actor.items.get(cell.dataset.itemId)?.toMessage?.(ev);
      return;
    }

    const slot = ev.target.closest(".pkh-slot");
    if (slot) {
      const { row, col, entry } = this._slotAt(slot);
      if (entry) {
        await this._activate(actor, entry, slot, ev);
      } else if (canEditSlots(actor) && !isLocked(actor)) {
        openSlotPicker(actor, row, col);
      }
      return;
    }

    const btn = ev.target.closest("[data-act]");
    switch (btn?.dataset.act) {
      case "pip":
        // Always the next action, left to right — not "the pip you hit".
        if (ev.shiftKey) return toggleBonus(actor);
        return setUsed(actor, this.eco.used + 1);
      case "rollback": return rollbackOne(actor);
      case "rx-pip": return setReactionUsed(actor, reactionBudget(actor).used + 1);
      case "page": return this.setPage(actor, Number(btn.dataset.page));
      case "rows": return game.settings.set(MODULE_ID, "hudRows", (this.rows() % MAX_ROWS) + 1);
      case "lock":
        if (canEditSlots(actor)) await storageActor(actor).setFlag(MODULE_ID, "locked", !isLocked(actor));
        return;
      case "editors": return openEditorsDialog(actor);
      case "pin": {
        const pinned = setting("hudPinnedActor", "");
        await game.settings.set(MODULE_ID, "hudPinnedActor", pinned ? "" : actor.uuid);
        return this.scheduleRender();
      }
      case "roll-request": return game.pf2eKrHud?.openRollRequest?.({ actor });
      case "autofill": {
        const added = await autoFillSlots(actor);
        return ui.notifications.info(`PF2e-KR HUD | ${t("Hud.Notify.AutoFilled", { n: added })}`);
      }
      case "sheet-actions": return openSheetTab(actor, "actions");
      case "skills": openSkills(actor); return this.scheduleRender();
      case "save": {
        const key = btn.dataset.save;
        await actor.saves?.[key]?.roll?.({ event: ev });
        const mod = savesOf(actor)[key];
        if (setting("hudSaveCard", true) && Number.isFinite(Number(mod))) await postSaveDc(actor, key, mod);
        return;
      }
      case "perception": return actor.perception?.roll?.({ event: ev });
      case "dc": {
        const dc = savesOf(actor).spellDC;
        if (dc) return postSpellDcRequest(actor, dc);
        return;
      }
      case "faces": return game.pf2eKrHud?.openFaces?.(actor);
      case "pop":
        this.popover = this.popover === btn.dataset.pop ? null : btn.dataset.pop;
        return this.scheduleRender();
    }
  }

  async _onContext(ev) {
    const actor = this.actor;
    if (!actor) return;
    ev.preventDefault();

    const effect = ev.target.closest(".pkh-effect");
    if (effect) {
      if (ev.shiftKey) return this._removeEffect(actor, effect);
      this.cardEl.classList.add("hidden");
      if (effect.dataset.kind === "condition") return actor.decreaseCondition?.(effect.dataset.slug);
      const item = actor.items.get(effect.dataset.id);
      // Counter effects count down (PF2e removes them at the bottom); plain effects are removed.
      if (item?.badge?.type === "counter" && typeof item.decrease === "function") return item.decrease();
      return this._removeEffect(actor, effect);
    }

    if (ev.target.closest(".pkh-rollback")) return setUsed(actor, 0);
    if (ev.target.closest(".pkh-pip.reaction")) return setReactionUsed(actor, reactionBudget(actor).used - 1);
    if (ev.target.closest(".pkh-pip")) return rollbackOne(actor);

    const cell = ev.target.closest(".pkh-inv-cell, .pkh-list-row");
    if (cell) return actor.items.get(cell.dataset.itemId)?.sheet?.render(true);

    const slot = ev.target.closest(".pkh-slot");
    if (!slot) return;
    const { row, col, entry } = this._slotAt(slot);

    // Editors always get the slot menu; the lock only guards drag & drop.
    if (canEditSlots(actor)) {
      if (entry) this._slotMenu(ev, actor, row, col, entry);
      else if (!isLocked(actor)) openSlotPicker(actor, row, col);
      return;
    }
    if (entry?.type === "item") findItem(actor, entry)?.sheet?.render(true);
  }

  /** Remove a condition or effect outright (Shift+click), whatever its value. */
  async _removeEffect(actor, node) {
    this.cardEl.classList.add("hidden");
    if (node.dataset.kind === "condition") {
      const done = await actor.decreaseCondition?.(node.dataset.slug, { forceRemove: true });
      if (done !== undefined) return;
    }
    await actor.items.get(node.dataset.id)?.delete();
  }

  async _onAuxClick(ev) {
    if (ev.button !== 1) return;
    const slot = ev.target.closest(".pkh-slot");
    if (!slot || !this.actor) return;
    ev.preventDefault();
    const { entry } = this._slotAt(slot);
    if (entry?.type === "strike") await executeSlot(this.actor, entry, ev, { mapIndex: 2 });
  }

  _onDragStart(ev) {
    const actor = this.actor;
    const cell = ev.target.closest(".pkh-inv-cell, .pkh-list-row");
    if (cell) {
      const item = actor?.items.get(cell.dataset.itemId);
      if (item) ev.dataTransfer.setData("text/plain", JSON.stringify({ type: "Item", uuid: item.uuid }));
      return;
    }
    const slot = ev.target.closest(".pkh-slot");
    if (!slot || !actor || !canEditSlots(actor) || isLocked(actor)) {
      ev.preventDefault();
      return;
    }
    ev.dataTransfer.setData("text/plain", JSON.stringify({
      type: "pkh-slot", actorId: storageActor(actor).id, row: Number(slot.dataset.row), col: Number(slot.dataset.col)
    }));
  }

  async _onDrop(ev) {
    const actor = this.actor;
    const slot = ev.target.closest(".pkh-slot");
    if (!actor || !slot) return;
    ev.preventDefault();
    ev.stopPropagation();
    if (!this._editGuard(actor)) return;

    const target = { row: Number(slot.dataset.row), col: Number(slot.dataset.col) };
    const data = readDragData(ev);
    if (data?.type === "pkh-slot") {
      if (data.actorId !== storageActor(actor).id) return;
      if (data.row === target.row && data.col === target.col) return;
      return swapSlots(actor, { row: data.row, col: data.col }, target);
    }
    const entry = entryFromDrop(actor, data);
    if (entry) await setSlot(actor, target.row, target.col, entry);
  }

  _onWheel(ev) {
    if (!this.actor || !ev.target.closest(".pkh-slots")) return;
    ev.preventDefault();
    ev.stopPropagation();
    this.setPage(this.actor, this.page(this.actor) + (ev.deltaY > 0 ? 1 : -1));
  }

  /* ---------------- edit mode: slot menu ---------------- */

  _slotMenu(ev, actor, row, col, entry) {
    this.menuEl ??= Object.assign(document.body.appendChild(document.createElement("section")), { id: "pkh-slot-menu" });
    const menu = this.menuEl;
    menu.innerHTML = `
      <button type="button" data-m="icon"><i class="fa-solid fa-image"></i> ${t("Hud.Menu.Icon")}</button>
      ${entry.icon ? `<button type="button" data-m="reset"><i class="fa-solid fa-rotate-left"></i> ${t("Hud.Menu.ResetIcon")}</button>` : ""}
      ${entry.type === "item" && findItem(actor, entry) ? `<button type="button" data-m="sheet"><i class="fa-solid fa-file-lines"></i> ${t("Hud.Menu.Details")}</button>` : ""}
      <button type="button" data-m="clear"><i class="fa-solid fa-trash"></i> ${t("Hud.Menu.Clear")}</button>`;
    menu.style.left = `${Math.min(window.innerWidth - 200, ev.clientX)}px`;
    menu.style.top = `${Math.max(8, ev.clientY - 110)}px`;
    menu.classList.remove("hidden");
    const close = () => {
      menu.classList.add("hidden");
      document.removeEventListener("pointerdown", outside, true);
    };
    const outside = e => { if (!menu.contains(e.target)) close(); };
    document.addEventListener("pointerdown", outside, true);
    menu.onclick = async e => {
      const act = e.target.closest("button[data-m]")?.dataset.m;
      if (!act) return;
      close();
      if (act === "clear") return setSlot(actor, row, col, null);
      if (act === "sheet") return findItem(actor, entry)?.sheet?.render(true);
      if (act === "reset") return setSlot(actor, row, col, { ...entry, icon: null });
      const FP = foundry.applications?.apps?.FilePicker?.implementation ?? globalThis.FilePicker;
      new FP({ type: "image", current: entry.icon ?? "", callback: path => setSlot(actor, row, col, { ...entry, icon: path }) }).render(true);
    };
  }

  /* ---------------- one path for clicks and hotkeys ---------------- */

  /**
   * Strikes (and weapon/bomb items) → the attack popup, with 1st/2nd/3rd attack
   * greyed when PF2e wouldn't allow it and the weapon's own actions (draw,
   * release, reload …) underneath. Actions with a [사용] button → use popup.
   * Anything else PF2e shows as unusable is refused — never a way around the sheet.
   */
  async _activate(actor, entry, node, ev = null) {
    const strike = strikeForEntry(actor, entry);
    if (strike) {
      if (!node) {
        if (strikeUnavailable(strike)) return ui.notifications.warn(`PF2e-KR HUD | ${t("Hud.Notify.CantStrike", { name: strike.label })}`);
        return executeSlot(actor, { type: "strike", slug: strike.slug }, null, { mapIndex: this._autoMap() });
      }
      return this._openMap(actor, strike, node);
    }
    const item = entry.type === "item" ? findItem(actor, entry) : null;
    if (item && ["action", "feat"].includes(item.type) && node) return this._openUse(actor, item, node);
    // Before the "unusable" check: a spell with no slots left can still be posted.
    if (item?.type === "spell" && node) return this._openSpell(actor, item, node);
    const view = resolveSlot(actor, entry, {});
    if (view?.disabled || view?.broken) {
      ui.notifications.warn(`PF2e-KR HUD | ${t("Hud.Notify.CantUse", { name: view.label })}`);
      return;
    }
    return executeSlot(actor, entry, ev, { mapIndex: this._autoMap() });
  }

  _auxButtons(strike) {
    const aux = (strike?.auxiliaryActions ?? []).filter(a => typeof a?.execute === "function");
    return {
      list: aux,
      html: aux.length ? `<div class="aux-row">${aux.map((a, i) => `
        <button type="button" data-aux="${i}" data-tooltip="${esc(a.fullLabel ?? a.label ?? "")}">
          ${a.glyph ? `<span class="glyph">${esc(a.glyph)}</span>` : ""}${esc(a.label ?? a.fullLabel ?? t("Hud.Map.Action"))}</button>`).join("")}</div>` : ""
    };
  }

  /** Attack popup: 1st/2nd/3rd attack on top (greyed if not possible), weapon actions below. */
  _openMap(actor, strike, slotNode) {
    const entry = { type: "strike", slug: strike.slug };
    const v = resolveSlot(actor, entry, { attacks: this.eco?.attacks ?? 0 });
    const off = strikeUnavailable(strike);
    const aux = this._auxButtons(strike);
    if (!v?.map?.length && !aux.list.length) return ui.notifications.warn(`PF2e-KR HUD | ${t("Hud.Notify.CantStrike", { name: strike.label })}`);
    this._mapTarget = { actor, entry };
    this._auxTarget = aux.list;
    this._useTarget = null;
    this._spellTarget = null;
    this.mapEl.innerHTML = `
      <header>${esc(v?.label ?? strike.label)}${off ? ` <small>— ${t("Hud.Map.Off")}</small>` : ""}</header>
      <div class="choices">${(v?.map ?? []).map((m, i) => `
        <button type="button" data-map="${i}" class="${i === v.mapIndex && !off ? "next" : ""}" ${off ? "disabled" : ""}
                data-tooltip="${i === 0 ? t("Hud.Map.First") : t("Hud.Map.Nth", { n: i + 1 })}">
          <em>${t("Hud.Map.Hit", { n: i + 1 })}</em><b>${esc(m)}</b></button>`).join("")}</div>
      ${aux.html}`;
    this._placePopup(slotNode);
  }

  /** Actions/feats: [사용] like the sheet's button, or just post the card. */
  _openUse(actor, item, slotNode) {
    this._mapTarget = null;
    this._auxTarget = null;
    this._useTarget = { actor, item };
    this._spellTarget = null;
    const cost = item.system?.actionType?.value;
    this.mapEl.innerHTML = `
      <header>${esc(item.name)}</header>
      <div class="aux-row">
        <button type="button" data-use="use" class="next"><b>${t("Hud.Use.Use")}</b></button>
        <button type="button" data-use="chat">${t("Hud.Use.Chat")}</button>
        <button type="button" data-use="sheet" data-tooltip="${t("Hud.Use.DetailsTip")}">${t("Hud.Use.Details")}</button>
      </div>
      ${cost === "passive" ? `<footer>${t("Hud.Use.Passive")}</footer>` : ""}`;
    this._placePopup(slotNode);
  }

  /** Spells: [시전] spends a slot or focus point; [채팅으로 보내기] only posts the card. */
  _openSpell(actor, spell, slotNode) {
    this._mapTarget = null;
    this._auxTarget = null;
    this._useTarget = null;
    const options = spellCastOptions(actor, spell);
    this._spellTarget = { actor, spell, options };
    const firstOk = options.findIndex(o => o.ok);
    const head = { "focus": t("Spell.CastFocus"), "focus-cantrip": t("Spell.CastFocus"), "cantrip": t("Spell.Cast"), "innate": t("Spell.Cast"), "slot": t("Spell.Cast") };
    const tip = {
      "focus": t("Spell.Tip.Focus"),
      "focus-cantrip": t("Spell.Tip.FocusCantrip"),
      "cantrip": t("Spell.Tip.Cantrip"),
      "innate": t("Spell.Tip.Innate"),
      "slot": t("Spell.Tip.Slot")
    };
    const cast = options.map((o, i) => `
      <button type="button" data-cast="${i}" class="cast-${o.kind ?? "slot"} ${i === firstOk ? "next" : ""}" ${o.ok ? "" : "disabled"}
              data-tooltip="${esc(o.ok ? tip[o.kind] ?? "" : o.reason ?? "")}">
        <em>${head[o.kind] ?? t("Spell.Cast")}</em><b class="small">${esc(o.label)}</b></button>`).join("");
    // Up to five ranks a row: a signature spell's 6th–10th ranks go on a second line.
    const cols = Math.min(5, Math.max(1, options.length));
    const entryName = spell.spellcasting?.name ?? "";
    this.mapEl.innerHTML = `
      <header>${esc(spell.name)}${entryName ? ` <small>— ${esc(entryName)}</small>` : ""}</header>
      ${cast ? `<div class="choices spell" style="--cols:${cols}">${cast}</div>` : ""}
      <div class="aux-row">
        <button type="button" data-spell="chat" class="${firstOk < 0 ? "next" : ""}" data-tooltip="${t("Spell.ChatTip")}">${t("Spell.ToChat")}</button>
        <button type="button" data-spell="sheet" data-tooltip="${t("Spell.DetailsTip")}">${t("Hud.Use.Details")}</button>
      </div>
      ${spell.isRitual ? `<footer>${t("Spell.Ritual")}</footer>` : ""}`;
    this._placePopup(slotNode);
  }

  _placePopup(node) {
    this.slotCard?.hide();
    this.mapEl.classList.remove("hidden");
    const box = node.getBoundingClientRect();
    const pop = this.mapEl.getBoundingClientRect();
    const left = Math.min(window.innerWidth - pop.width - 8, Math.max(8, box.left + box.width / 2 - pop.width / 2));
    this.mapEl.style.left = `${Math.round(left)}px`;
    this.mapEl.style.top = `${Math.round(Math.max(8, box.top - pop.height - 10))}px`;
    this.mapEl.querySelector("button.next:not([disabled]), button:not([disabled])")?.focus();
  }

  _speedHtml(actor) {
    const land = speedsOf(actor).find(v => v.type === "land") ?? speedsOf(actor)[0];
    return land ? ` <span class="speed" data-tooltip="${t("Hud.Speed", { n: land.value })}"><i class="fa-solid fa-shoe-prints"></i> ${land.value}</span>` : "";
  }

  _closeMap() {
    this.mapEl?.classList.add("hidden");
    this._mapTarget = null;
    this._spellTarget = null;
  }

  async _onMapChoice(ev) {
    const spellBtn = ev.target.closest("button[data-cast]:not([disabled]), button[data-spell]");
    if (spellBtn && this._spellTarget) {
      const { actor, spell, options } = this._spellTarget;
      this._closeMap();
      if (spellBtn.dataset.spell === "sheet") return spell.sheet?.render(true);
      if (spellBtn.dataset.spell === "chat") return spell.toMessage?.(ev);
      const option = options[Number(spellBtn.dataset.cast)];
      if (option?.ok) return castSpell(actor, spell, option);
      return;
    }
    const use = ev.target.closest("button[data-use]");
    if (use && this._useTarget) {
      const { actor, item } = this._useTarget;
      this._closeMap();
      if (use.dataset.use === "sheet") return item.sheet?.render(true);
      if (use.dataset.use === "chat") return item.toMessage?.(ev);
      return useLikeSheet(actor, item, ev);
    }
    const aux = ev.target.closest("button[data-aux]");
    if (aux && this._auxTarget) {
      const action = this._auxTarget[Number(aux.dataset.aux)];
      const actor = this._mapTarget?.actor ?? this.actor;
      this._closeMap();
      if (!action?.execute) return;
      await action.execute();
      // PF2e folds consecutive Interact messages into one card, so chat can't
      // count them; count here instead (the tracker module, if on, does its own).
      const cost = Number(action.actions ?? 1) || 0;
      const eco = economyOf(actor);
      if (cost > 0 && eco.source !== "tracker") await setUsed(actor, eco.used + cost);
      return;
    }
    const btn = ev.target.closest("button[data-map]:not([disabled])");
    if (!btn || !this._mapTarget) return;
    const { actor, entry } = this._mapTarget;
    this._closeMap();
    await executeSlot(actor, entry, ev, { mapIndex: Number(btn.dataset.map) });
  }


  /** GM: an NPC with an empty bar gets its attacks, actions and spells once. */
  _maybeAutoFill(actor) {
    if (!game.user.isGM || actor.type !== "npc" || !setting("hudNpcAutoFill", true)) return;
    this._autoFilled ??= new Set();
    const id = storageActor(actor)?.id;
    if (!id || this._autoFilled.has(id)) return;
    this._autoFilled.add(id);
    if (readSlots(actor).flat().some(Boolean)) return;
    autoFillSlots(actor);
  }

  /* ---------------- hotkeys ---------------- */

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
    if (entry) this._activate(actor, entry, node, null);
    // Consumed even when empty, so a hidden core-hotbar macro never fires "through" the HUD.
    return true;
  }
}

/* ------------------------------------------------------------------------ */

export function registerHudSettings() {
  const rerender = () => game.pf2eKrHud?.hud?.scheduleRender();
  registerSlotCardSettings();
  game.settings.register(MODULE_ID, "hudEnabled", {
    name: "PKH.Settings.hudEnabled.Name", hint: "PKH.Settings.hudEnabled.Hint",
    scope: "client", config: true, type: Boolean, default: true, onChange: rerender
  });
  game.settings.register(MODULE_ID, "hudScale", {
    name: "PKH.Settings.hudScale.Name", hint: "PKH.Settings.hudScale.Hint",
    scope: "client", config: true, type: Number, default: 1.1, range: { min: 0.7, max: 1.6, step: 0.05 }, onChange: rerender
  });
  game.settings.register(MODULE_ID, "hudEffectSize", {
    name: "PKH.Settings.hudEffectSize.Name", hint: "PKH.Settings.hudEffectSize.Hint",
    scope: "client", config: true, type: Number, default: 42, range: { min: 24, max: 64, step: 2 }, onChange: rerender
  });
  game.settings.register(MODULE_ID, "hudEffectsWidth", {
    name: "PKH.Settings.hudEffectsWidth.Name", hint: "PKH.Settings.hudEffectsWidth.Hint",
    scope: "client", config: true, type: String, default: "screen",
    choices: { screen: "PKH.Settings.hudEffectsWidth.Choices.screen", bar: "PKH.Settings.hudEffectsWidth.Choices.bar" },
    onChange: () => game.pf2eKrHud?.hud?.position?.()
  });
  game.settings.register(MODULE_ID, "hudEffectDurations", {
    name: "PKH.Settings.hudEffectDurations.Name",
    hint: "PKH.Settings.hudEffectDurations.Hint",
    scope: "client", config: true, type: Boolean, default: true, onChange: () => game.pf2eKrHud?.hud?.scheduleRender?.()
  });
  game.settings.register(MODULE_ID, "hudReactionPip", {
    name: "PKH.Settings.hudReactionPip.Name",
    hint: "PKH.Settings.hudReactionPip.Hint",
    scope: "client", config: true, type: Boolean, default: true
  });
  game.settings.register(MODULE_ID, "hudSaveCard", {
    name: "PKH.Settings.hudSaveCard.Name", hint: "PKH.Settings.hudSaveCard.Hint",
    scope: "client", config: true, type: Boolean, default: true
  });
  game.settings.register(MODULE_ID, "hudRows", {
    name: "PKH.Settings.hudRows.Name", scope: "client", config: true, type: Number, default: 1,
    choices: { 1: "PKH.Settings.hudRows.Choices.R1", 2: "PKH.Settings.hudRows.Choices.R2", 3: "PKH.Settings.hudRows.Choices.R3" }, onChange: rerender
  });
  game.settings.register(MODULE_ID, "hudHideCoreHotbar", {
    name: "PKH.Settings.hudHideCoreHotbar.Name", hint: "PKH.Settings.hudHideCoreHotbar.Hint",
    scope: "client", config: true, type: Boolean, default: true, onChange: rerender
  });
  game.settings.register(MODULE_ID, "hudHideEffectsPanel", {
    name: "PKH.Settings.hudHideEffectsPanel.Name", hint: "PKH.Settings.hudHideEffectsPanel.Hint",
    scope: "client", config: true, type: Boolean, default: true, onChange: rerender
  });
  game.settings.register(MODULE_ID, "hudAutoInfused", {
    name: "PKH.Settings.hudAutoInfused.Name", hint: "PKH.Settings.hudAutoInfused.Hint",
    scope: "client", config: true, type: Boolean, default: true
  });
  game.settings.register(MODULE_ID, "hudNpcAutoFill", {
    name: "PKH.Settings.hudNpcAutoFill.Name", hint: "PKH.Settings.hudNpcAutoFill.Hint",
    scope: "world", config: true, type: Boolean, default: true
  });
  game.settings.register(MODULE_ID, "hudLastActor", { scope: "client", config: false, type: String, default: "" });
  game.settings.register(MODULE_ID, "hudPinnedActor", { scope: "client", config: false, type: String, default: "", onChange: rerender });
}

export function initHud() {
  const hud = new PartyHud();
  game.pf2eKrHud = { ...(game.pf2eKrHud ?? {}), hud, debugEconomy: actor => debugEconomy(actor ?? hud.actor) };
  hud.mount();

  const rerender = () => hud.scheduleRender();
  const touches = actor => actor && (actor === hud.actor || actor === hud.inspectActor
    || storageActor(actor)?.id === storageActor(hud.actor)?.id || actor.id === hud.inspectActor?.id);

  Hooks.on("controlToken", rerender);
  Hooks.on("canvasReady", rerender);
  Hooks.on("updateUser", rerender);
  Hooks.on("updateActor", actor => { if (touches(actor)) rerender(); });
  Hooks.on("updateToken", token => { if (touches(token.actor)) rerender(); });
  for (const hook of ["createItem", "updateItem", "deleteItem"]) {
    Hooks.on(hook, item => { if (touches(item.parent)) rerender(); });
  }
  Hooks.on("targetToken", (user, token, targeted) => {
    if (user.id !== game.user.id) return;
    const actor = token?.actor;
    if (targeted && actor && !actor.isOwner) hud.inspect(actor);
    else if (!targeted && actor === hud.inspectActor) hud.inspect(null);
  });
  Hooks.on("collapseSidebar", () => setTimeout(() => hud.position(), 250));
  // Effect clocks move with game time and with the combat turn.
  Hooks.on("updateWorldTime", rerender);
  registerEconomyHooks(rerender);
  registerUseMarking();
}
