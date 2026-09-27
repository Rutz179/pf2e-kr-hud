import { MAX_ROWS, MODULE_ID, PAGE_COUNT, boardViewportRect, displayName, esc, readDragData, setting, signed, summaryOf } from "./shared.mjs";
import {
  autoFillSlots, canEditSlots, entryFromDrop, executeSlot, findItem, isLocked, openEditorsDialog, openSlotPicker,
  readSlots, resolveSlot, setSlot, storageActor, strikeForEntry, strikeUnavailable, swapSlots, withIconOverride
} from "./slots.mjs";
import { activeConditions, debugEconomy, economyOf, itemActionCost, markNextUse, registerEconomyHooks, registerUseMarking, rollbackOne, setUsed, toggleBonus } from "./economy.mjs";

const BUFF_CONDITIONS = new Set(["quickened", "hidden", "invisible", "concealed", "undetected"]);
const SAVE_LABELS = { fortitude: "인내", reflex: "반사", will: "의지" };

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

function effectsOf(actor) {
  const out = [];
  for (const c of activeConditions(actor)) {
    out.push({ kind: "condition", id: c.id, slug: c.slug, name: c.name, img: c.img, value: c.value ?? null, buff: BUFF_CONDITIONS.has(c.slug) });
  }
  for (const e of actor?.itemTypes?.effect ?? []) {
    out.push({ kind: "effect", id: e.id, slug: e.slug, name: e.name, img: e.img, value: e.badge?.value ?? null, buff: true });
  }
  for (const a of actor?.itemTypes?.affliction ?? []) {
    out.push({ kind: "effect", id: a.id, slug: a.slug, name: a.name, img: a.img, value: a.badge?.value ?? a.stage ?? null, buff: false });
  }
  return out;
}

const SPEED_LABELS = { land: "", burrow: "굴착", climb: "등반", fly: "비행", swim: "수영", travel: "여행" };

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

/** Spell DC → a card with all three saves at that DC, for the GM to roll targets. */
async function postSpellDcRequest(actor, dc) {
  const checks = Object.keys(SAVE_LABELS).map(k => `@Check[${k}|dc:${dc}]`).join(" ");
  await ChatMessage.create({
    speaker: ChatMessage.getSpeaker({ actor }),
    content: `<div class="pkh-save-request">
      <header><i class="fa-solid fa-wand-sparkles"></i> <strong>${esc(displayName(actor.name))}</strong> — 주문 DC <b>${dc}</b></header>
      <p>내성 굴림 요구</p>
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
      <p>${SAVE_LABELS[key]} 내성 DC (10 ${signed(mod)})</p>
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
    this.root = make("pkh-hud", "캐릭터 HUD");
    this.inspectEl = make("pkh-inspect", "관찰 중인 캐릭터");
    this.cardEl = make("pkh-effect-card", "효과 설명");
    this.cardEl.classList.add("hidden");
    this.mapEl = make("pkh-map-pop", "공격 선택");
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
        <button type="button" data-act="close-inspect" aria-label="닫기"><i class="fa-solid fa-xmark"></i></button>
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
    return `<div class="pkh-effects">${list.map(e => `
      <div class="pkh-effect ${e.buff ? "buff" : "debuff"}" data-kind="${e.kind}" data-id="${e.id}" data-slug="${esc(e.slug)}">
        <img src="${esc(e.img)}" alt="${esc(e.name)}">
        ${e.value ? `<span class="val">${esc(e.value)}</span>` : ""}
      </div>`).join("")}</div>`;
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
    const source = { tracker: "액션 트래커와 연동", chat: "채팅의 굴림으로 자동 계산", manual: "수동" }[eco.source] ?? "수동";
    const pips = [0, 1, 2, 3].map(i => {
      const bonus = i === 3;
      const available = bonus ? eco.quickened : true;
      const used = i < eco.used;
      const lost = !bonus && i >= 3 - eco.slowed;
      const cls = ["pkh-pip", bonus ? "bonus" : "base", used ? "used" : "", !available ? "idle" : "", lost && !used ? "lost" : ""].join(" ");
      const tip = (bonus ? (eco.quickened ? "추가 행동 (신속 등)" : "추가 행동 — 지금은 없음") : `${i + 1}번째 행동${lost ? " (감속/기절)" : ""}`)
        + "<br><small>클릭 행동 사용 · 우클릭 되돌리기 · Shift+클릭 추가 행동 부여/회수</small>";
      return `<button type="button" class="${cls}" data-act="pip" data-index="${i}" data-tooltip="${tip}" aria-label="${tip}"></button>`;
    }).join("");
    const over = eco.used > eco.max;
    return `
      <div class="pkh-ap ${over ? "over" : ""}" data-tooltip="행동 ${eco.used} / ${eco.max} · ${source}<br><small>참조용 — 행동을 막지 않습니다</small>">
        ${pips}
        <button type="button" class="pkh-rollback" data-act="rollback" ${eco.used ? "" : "disabled"}
                data-tooltip="행동 하나 되돌리기<br><small>우클릭: 이번 턴 전부 되돌리기</small>" aria-label="행동 하나 되돌리기"><i class="fa-solid fa-rotate-left"></i></button>
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
          return `<div class="pkh-slot empty" data-row="${r}" data-col="${c}" ${dragOk ? `data-tooltip="클릭: 기술·액션 추가<br>또는 시트에서 끌어다 놓기"` : ""}>
            <span class="key">${esc(key)}</span></div>`;
        }
        let tip = esc(v.label);
        if (entry.type === "strike" && v.map?.length) {
          tip += `<br>${v.map.join(" / ")}<br><small>클릭하면 몇 번째 공격인지 고르는 창이 열립니다</small>`;
        }
        if (v.auto) tip += "<br><small>자동 배치됨 (주입 아이템)</small>";
        const cls = ["pkh-slot", v.disabled ? "pkh-off" : "", v.broken ? "broken" : "", v.auto ? "auto" : "", v.active ? "active" : "",
          `t-${entry.type}`, entry.type === "strike" ? `map-${v.mapIndex ?? 0}` : ""].join(" ");
        const visual = v.img ? `<img src="${esc(v.img)}" alt="" draggable="false">` : `<i class="${esc(v.icon)}"></i>`;
        const label = !v.img ? `<span class="label">${esc(v.label)}</span>` : "";
        return `<div class="${cls}" data-row="${r}" data-col="${c}" draggable="${dragOk}" data-tooltip="${tip}">
          <span class="key">${esc(key)}</span>${visual}${label}
          ${v.broken ? `<i class="fa-solid fa-xmark broken-mark"></i>` : ""}
          ${v.badge !== null && v.badge !== undefined && v.badge !== "" ? `<span class="badge">${esc(v.badge)}</span>` : ""}
        </div>`;
      }).join("");
      return `<div class="pkh-row">${cells}</div>`;
    }).join("");

    const dots = Array.from({ length: PAGE_COUNT }, (_, p) =>
      `<button type="button" class="pkh-dot ${p === page ? "active" : ""}" data-act="page" data-page="${p}" aria-label="${p + 1}페이지"></button>`).join("");

    return `
      <div class="pkh-slots rows-${rows}">
        <div class="pkh-slots-side">
          <button type="button" class="pkh-icon lock ${locked ? "" : "open"}" data-act="lock" ${editable ? "" : "disabled"}
                  data-tooltip="${editable ? (locked ? "잠김 — 눌러서 배치 편집" : "편집 중 — 눌러서 잠그기") : "배치를 바꿀 권한이 없습니다"}">
            <i class="fa-solid ${locked ? "fa-lock" : "fa-lock-open"}"></i></button>
          <button type="button" class="pkh-icon" data-act="rows" data-tooltip="줄 수: ${rows}줄 (눌러서 변경)">
            <span class="rows-glyph r${rows}"></span></button>
          ${game.user.isGM ? `<button type="button" class="pkh-icon" data-act="editors" data-tooltip="편집 권한 (GM)"><i class="fa-solid fa-user-gear"></i></button>` : ""}
          <button type="button" class="pkh-icon pin ${setting("hudPinnedActor", "") ? "open" : ""}" data-act="pin"
                  data-tooltip="${setting("hudPinnedActor", "") ? "고정됨 — 다른 토큰을 골라도 이 캐릭터 유지 (눌러서 해제)" : "이 캐릭터 고정 (다른 토큰을 골라도 유지)"}">
            <i class="fa-solid fa-thumbtack"></i></button>
          ${game.user.isGM ? `<button type="button" class="pkh-icon" data-act="autofill" data-tooltip="빈칸 자동 채우기<br><small>공격 → 액션 → 주문 순</small>"><i class="fa-solid fa-wand-magic-sparkles"></i></button>` : ""}
        </div>
        <div class="pkh-grid">${rowHtml}</div>
        <div class="pkh-pages" data-tooltip="휠로 페이지 넘기기">${dots}</div>
      </div>`;
  }

  _barHtml(actor) {
    const s = savesOf(actor);
    const card = setting("hudSaveCard", true);
    const save = key => (s[key] === null || s[key] === undefined ? "" :
      `<button type="button" class="pkh-chip" data-act="save" data-save="${key}"
        data-tooltip="${SAVE_LABELS[key]} 내성 굴림${card ? `<br><small>채팅에 ${SAVE_LABELS[key]} DC ${10 + Number(s[key])} 카드도 함께 올립니다</small>` : ""}">
        <em>${SAVE_LABELS[key]}</em>${esc(signed(s[key]))}</button>`);
    const perception = s.perception === null || s.perception === undefined ? "" :
      `<button type="button" class="pkh-chip" data-act="perception" data-tooltip="지각 굴림"><em>지각</em>${esc(signed(s.perception))}</button>`;
    const ac = s.ac === null ? "" : `<span class="pkh-chip static" data-tooltip="방어도"><em>AC</em>${s.ac}</span>`;
    const dc = s.spellDC ? `<button type="button" class="pkh-chip dc" data-act="dc" data-tooltip="채팅에 내성 굴림 요구 카드 올리기<br><small>인내·반사·의지 DC ${s.spellDC} 버튼 포함</small>">
        <em>주문 DC</em>${s.spellDC}</button>` : "";
    return `
      <div class="pkh-bar">
        <button type="button" class="pkh-mini ${this.popover === "inventory" ? "active" : ""}" data-act="pop" data-pop="inventory" data-tooltip="인벤토리 훑어보기">
          <i class="fa-solid fa-sack"></i></button>
        <div class="pkh-saves">${ac}${save("fortitude")}${save("reflex")}${save("will")}${perception}</div>
        <div class="pkh-bar-right">
          ${actor.type === "character" ? `<button type="button" class="pkh-mini" data-act="faces" data-tooltip="초상화 표정 (@키워드로 바꾸기)">
            <i class="fa-solid fa-masks-theater"></i></button>` : ""}
          <button type="button" class="pkh-mini" data-act="sheet-actions" data-tooltip="캐릭터 시트 — 액션 탭">
            <i class="fa-solid fa-person-running"></i></button>
          <button type="button" class="pkh-mini ${this.popover === "grimoire" ? "active" : ""}" data-act="pop" data-pop="grimoire" data-tooltip="주문 · 피트 훑어보기">
            <i class="fa-solid fa-book-open"></i></button>
        </div>
      </div>`;
  }

  _popoverHtml(actor) {
    const itemCell = item => {
      const qty = Number(item.quantity ?? 1);
      return `<div class="pkh-inv-cell" draggable="true" data-item-id="${item.id}" data-tooltip="${esc(item.name)}<br><small>클릭: 채팅에 올리기 · 우클릭: 시트</small>">
        <img src="${esc(item.img)}" alt="">${qty > 1 ? `<span class="badge">${qty}</span>` : ""}</div>`;
    };
    const listRow = item => `
      <div class="pkh-list-row" draggable="true" data-item-id="${item.id}" data-tooltip="클릭: 채팅에 올리기 · 우클릭: 시트">
        <img src="${esc(item.img)}" alt=""><span>${esc(item.name)}</span></div>`;

    if (this.popover === "inventory") {
      const order = { consumable: 0, weapon: 1, shield: 2, armor: 3, equipment: 4, backpack: 5, treasure: 6 };
      const items = actor.items.filter(i => i.isOfType?.("physical"))
        .sort((a, b) => (order[a.type] ?? 9) - (order[b.type] ?? 9) || a.name.localeCompare(b.name, "ko"));
      return `<div class="pkh-pop inventory">
        <header>인벤토리 <small>끌어서 퀵슬롯에 올릴 수 있어요</small></header>
        <div class="pkh-inv-grid">${items.map(itemCell).join("") || "<p>소지품 없음</p>"}</div></div>`;
    }

    const spells = (actor.itemTypes?.spell ?? []).slice().sort((a, b) =>
      (a.isCantrip ? 0 : a.rank ?? 0) - (b.isCantrip ? 0 : b.rank ?? 0) || a.name.localeCompare(b.name, "ko"));
    const groups = new Map();
    for (const sp of spells) {
      const key = sp.isCantrip ? "소마법" : sp.isFocusSpell ? "집중 주문" : `${sp.rank ?? "?"}랭크`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(sp);
    }
    const feats = (actor.itemTypes?.feat ?? []).slice().sort((a, b) => a.name.localeCompare(b.name, "ko"));
    const actions = (actor.itemTypes?.action ?? []).slice().sort((a, b) => a.name.localeCompare(b.name, "ko"));
    const spellHtml = [...groups].map(([k, list]) => `<h4>${esc(k)}</h4>${list.map(listRow).join("")}`).join("");
    return `<div class="pkh-pop grimoire">
      <header>주문 · 피트 <small>“아 맞다, 이것도 있었지” 용도 — 클릭하면 채팅에 올라갑니다</small></header>
      <div class="pkh-grim-cols">
        <div>${spellHtml || "<p>주문 없음</p>"}</div>
        <div><h4>액션</h4>${actions.map(listRow).join("") || "<p>—</p>"}<h4>피트 · 특성</h4>${feats.map(listRow).join("")}</div>
      </div></div>`;
  }

  /* ---------------- effect hover card ---------------- */

  _effectHover(ev, host) {
    const node = ev.target.closest(".pkh-effect");
    if (!node) return;
    clearTimeout(this._cardHide);
    clearTimeout(this._cardShow);
    this._cardShow = setTimeout(() => this._showCard(node, host), 350);
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
    const summary = summaryOf(item) || "설명이 없습니다.";
    const remaining = item.remainingDuration?.label ?? "";
    this.cardEl.dataset.actorUuid = actor.uuid;
    this.cardEl.dataset.itemId = item.id;
    this.cardEl.innerHTML = `
      <header>
        <img src="${esc(item.img)}" alt="">
        <strong>${esc(item.name)}${value ? ` ${esc(value)}` : ""}</strong>
        ${actor.isOwner && actor.items.get(item.id) ? `<button type="button" data-act="card-edit" data-tooltip="효과 편집" aria-label="효과 편집"><i class="fa-solid fa-pen"></i></button>` : ""}
        <button type="button" data-act="card-chat" data-tooltip="채팅에 보내기" aria-label="채팅에 보내기"><i class="fa-solid fa-comment"></i></button>
      </header>
      ${remaining ? `<div class="dur"><i class="fa-regular fa-hourglass-half"></i> ${esc(remaining)}</div>` : ""}
      <p>${esc(summary)}</p>
      ${actor.isOwner ? `<footer>${item.type === "condition" || item.badge?.type === "counter" ? "좌클릭 +1 · 우클릭 −1" : "우클릭 제거"} · Shift+클릭 모두 제거</footer>` : ""}`;
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
      ui.notifications.warn("PF2e-KR HUD | 이 캐릭터의 퀵슬롯 배치를 바꿀 권한이 없습니다.");
      return false;
    }
    if (isLocked(actor)) {
      ui.notifications.info("PF2e-KR HUD | 퀵슬롯이 잠겨 있습니다. 왼쪽 자물쇠를 눌러 푼 뒤 편집하세요.");
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
      case "autofill": {
        const added = await autoFillSlots(actor);
        return ui.notifications.info(`PF2e-KR HUD | ${added}개를 빈칸에 채웠습니다.`);
      }
      case "sheet-actions": return openSheetTab(actor, "actions");
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
      <button type="button" data-m="icon"><i class="fa-solid fa-image"></i> 아이콘 바꾸기 (이 슬롯만)</button>
      ${entry.icon ? `<button type="button" data-m="reset"><i class="fa-solid fa-rotate-left"></i> 원래 아이콘</button>` : ""}
      ${entry.type === "item" && findItem(actor, entry) ? `<button type="button" data-m="sheet"><i class="fa-solid fa-file-lines"></i> 시트 열기</button>` : ""}
      <button type="button" data-m="clear"><i class="fa-solid fa-trash"></i> 슬롯 비우기</button>`;
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
        if (strikeUnavailable(strike)) return ui.notifications.warn(`PF2e-KR HUD | ${strike.label}: 지금은 공격할 수 없습니다.`);
        return executeSlot(actor, { type: "strike", slug: strike.slug }, null, { mapIndex: this._autoMap() });
      }
      return this._openMap(actor, strike, node);
    }
    const item = entry.type === "item" ? findItem(actor, entry) : null;
    if (item && ["action", "feat"].includes(item.type) && node) return this._openUse(actor, item, node);
    const view = resolveSlot(actor, entry, {});
    if (view?.disabled || view?.broken) {
      ui.notifications.warn(`PF2e-KR HUD | ${view.label}: 지금은 사용할 수 없습니다.`);
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
          ${a.glyph ? `<span class="glyph">${esc(a.glyph)}</span>` : ""}${esc(a.label ?? a.fullLabel ?? "행동")}</button>`).join("")}</div>` : ""
    };
  }

  /** Attack popup: 1st/2nd/3rd attack on top (greyed if not possible), weapon actions below. */
  _openMap(actor, strike, slotNode) {
    const entry = { type: "strike", slug: strike.slug };
    const v = resolveSlot(actor, entry, { attacks: this.eco?.attacks ?? 0 });
    const off = strikeUnavailable(strike);
    const aux = this._auxButtons(strike);
    if (!v?.map?.length && !aux.list.length) return ui.notifications.warn(`PF2e-KR HUD | ${strike.label}: 지금은 공격할 수 없습니다.`);
    this._mapTarget = { actor, entry };
    this._auxTarget = aux.list;
    this._useTarget = null;
    this.mapEl.innerHTML = `
      <header>${esc(v?.label ?? strike.label)}${off ? ` <small>— 지금은 공격 불가</small>` : ""}</header>
      <div class="choices">${(v?.map ?? []).map((m, i) => `
        <button type="button" data-map="${i}" class="${i === v.mapIndex && !off ? "next" : ""}" ${off ? "disabled" : ""}
                data-tooltip="${i === 0 ? "첫 공격" : `${i + 1}번째 공격 (다중 공격 페널티)`}">
          <em>${i + 1}타</em><b>${esc(m)}</b></button>`).join("")}</div>
      ${aux.html}`;
    this._placePopup(slotNode);
  }

  /** Actions/feats: [사용] like the sheet's button, or just post the card. */
  _openUse(actor, item, slotNode) {
    this._mapTarget = null;
    this._auxTarget = null;
    this._useTarget = { actor, item };
    const cost = item.system?.actionType?.value;
    this.mapEl.innerHTML = `
      <header>${esc(item.name)}</header>
      <div class="aux-row">
        <button type="button" data-use="use" class="next"><b>사용</b></button>
        <button type="button" data-use="chat">채팅에 올리기</button>
        <button type="button" data-use="sheet">시트</button>
      </div>
      ${cost === "passive" ? `<footer>지속 효과 — 사용할 행동이 없습니다</footer>` : ""}`;
    this._placePopup(slotNode);
  }

  _placePopup(node) {
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
    return land ? ` <span class="speed" data-tooltip="이동 속도 ${land.value}피트"><i class="fa-solid fa-shoe-prints"></i> ${land.value}</span>` : "";
  }

  _closeMap() {
    this.mapEl?.classList.add("hidden");
    this._mapTarget = null;
  }

  async _onMapChoice(ev) {
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
  game.settings.register(MODULE_ID, "hudEnabled", {
    name: "캐릭터 HUD 표시", hint: "마지막으로 선택한 내 토큰의 퀵슬롯 HUD를 화면 아래에 계속 띄웁니다.",
    scope: "client", config: true, type: Boolean, default: true, onChange: rerender
  });
  game.settings.register(MODULE_ID, "hudScale", {
    name: "HUD 크기", hint: "HUD 전체 배율입니다. 칸 크기는 화면 너비에 맞춰 자동으로 정해지고, 여기에 이 배율이 곱해집니다.",
    scope: "client", config: true, type: Number, default: 1.1, range: { min: 0.7, max: 1.6, step: 0.05 }, onChange: rerender
  });
  game.settings.register(MODULE_ID, "hudEffectSize", {
    name: "상태·효과 아이콘 크기 (px)", hint: "HP 막대 위에 뜨는 동그란 상태·효과 아이콘의 지름입니다.",
    scope: "client", config: true, type: Number, default: 42, range: { min: 24, max: 64, step: 2 }, onChange: rerender
  });
  game.settings.register(MODULE_ID, "hudSaveCard", {
    name: "내성 굴림 시 DC 카드도 올리기", hint: "HUD에서 인내·반사·의지를 누르면 굴림과 함께 '인내 DC 26'(10+수정치) 카드를 채팅에 올립니다.",
    scope: "client", config: true, type: Boolean, default: true
  });
  game.settings.register(MODULE_ID, "hudRows", {
    name: "퀵슬롯 줄 수", scope: "client", config: true, type: Number, default: 1,
    choices: { 1: "1줄", 2: "2줄", 3: "3줄" }, onChange: rerender
  });
  game.settings.register(MODULE_ID, "hudHideCoreHotbar", {
    name: "Foundry 기본 매크로 바 끄기", hint: "모듈의 퀵슬롯만 사용합니다. 숫자키도 모듈 퀵슬롯에만 반응합니다.",
    scope: "client", config: true, type: Boolean, default: true, onChange: rerender
  });
  game.settings.register(MODULE_ID, "hudHideEffectsPanel", {
    name: "PF2e 기본 효과 패널 숨기기", hint: "오른쪽 위에 세로로 늘어서는 PF2e 효과 아이콘을 숨깁니다. 효과는 HUD의 HP 막대 위에 표시됩니다.",
    scope: "client", config: true, type: Boolean, default: true, onChange: rerender
  });
  game.settings.register(MODULE_ID, "hudAutoInfused", {
    name: "주입(Infused) 아이템 자동 배치", hint: "연금술사 등이 만든 주입 아이템을 퀵슬롯 빈칸에 자동으로 올리고, 사라지면 자동으로 치웁니다.",
    scope: "client", config: true, type: Boolean, default: true
  });
  game.settings.register(MODULE_ID, "hudNpcAutoFill", {
    name: "NPC 퀵슬롯 자동 채우기", hint: "GM이 퀵슬롯이 비어 있는 NPC를 처음 선택하면 공격 → 액션 → 주문 순으로 자동으로 채웁니다.",
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
  registerEconomyHooks(rerender);
  registerUseMarking();
}
