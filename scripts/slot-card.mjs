import { MODULE_ID, esc, localizeMaybe, setting, signed } from "./shared.mjs";
import { findItem, resolveSlot, strikeForEntry } from "./slots.mjs";

/* ======================================================================== *
 * Quickslot hover card
 *
 * Rest the pointer on a quickslot for a moment (0.5–1.5 s, a client setting)
 * and a card shows what it is — cost, traits, rank or level, and the item's
 * own description — so nobody has to open the sheet mid-turn.
 *
 * The card never takes the pointer (it sits above the slot and ignores mouse
 * events), so it can't flicker or swallow the next click. It closes on leave,
 * on any press, on scroll and whenever the HUD redraws.
 *
 * Long descriptions: press the pin key (T by default, rebindable in Configure
 * Controls) while the card is up — or while it is about to appear — and it
 * stays put, takes the mouse, and scrolls. Links and inline rolls in it work.
 * It closes with the key again, Esc, its × button, or a click elsewhere.
 * The mouse wheel and middle click are already taken on the bar (page switch,
 * third attack), which is why pinning uses a key.
 * ======================================================================== */

export const PIN_ACTION = "pin-slot-card";

/** "KeyT" → "T", for the hint line. */
function pinKeyLabel() {
  const binding = game.keybindings?.get?.(MODULE_ID, PIN_ACTION)?.[0];
  if (!binding?.key) return "";
  const key = String(binding.key).replace(/^Key/, "").replace(/^Digit/, "");
  const mods = (binding.modifiers ?? []).map(m => String(m).replace("Control", "Ctrl"));
  return [...mods, key].join("+");
}

const TRAIT_DICTIONARIES = [
  "actionTraits", "spellTraits", "featTraits", "weaponTraits", "consumableTraits",
  "equipmentTraits", "armorTraits", "creatureTraits", "magicTraditions"
];

function traitLabel(slug) {
  for (const dict of TRAIT_DICTIONARIES) {
    const key = CONFIG.PF2E?.[dict]?.[slug];
    if (key) return game.i18n.localize(key);
  }
  return slug;
}

/** PF2e's action glyph font (loaded by the system): 1 2 3, R reaction, F free. */
function glyph(char, title) {
  return `<span class="action-glyph" data-tooltip="${esc(title)}">${char}</span>`;
}

export function costHtml(item) {
  if (!item) return "";
  if (item.type === "spell") {
    const t = String(item.system?.time?.value ?? "").trim();
    if (/^[123]$/.test(t)) return glyph(t, `${t}행동`);
    if (/^[123] to [123]$/.test(t)) return glyph(t[0], `${t[0]}~${t.at(-1)}행동`) + "–" + glyph(t.at(-1), "");
    if (t === "reaction") return glyph("R", "반응");
    if (t === "free") return glyph("F", "자유 행동");
    return t ? `<span class="cost-text">${esc(t)}</span>` : "";
  }
  const type = item.system?.actionType?.value;
  const n = Number(item.system?.actions?.value) || 1;
  if (type === "action") return glyph(String(Math.min(3, n)), `${n}행동`);
  if (type === "reaction") return glyph("R", "반응");
  if (type === "free") return glyph("F", "자유 행동");
  return "";
}

function rankText(item) {
  if (!item) return "";
  if (item.type === "spell") {
    if (item.isCantrip) return `캔트립 ${item.rank ?? ""}`.trim();
    if (item.isFocusSpell) return `포커스 ${item.rank ?? ""}`.trim();
    if (item.isRitual) return `의식 ${item.rank ?? ""}`.trim();
    return `주문 ${item.rank ?? ""}랭크`;
  }
  const level = item.level ?? item.system?.level?.value;
  return Number.isFinite(Number(level)) && item.type !== "action" ? `레벨 ${level}` : "";
}

function traitsHtml(item) {
  const traits = item?.system?.traits;
  const list = Array.isArray(traits?.value) ? traits.value : [];
  const rarity = traits?.rarity && traits.rarity !== "common" ? `<span class="trait rarity ${esc(traits.rarity)}">${esc(game.i18n.localize(CONFIG.PF2E?.rarityTraits?.[traits.rarity] ?? traits.rarity))}</span>` : "";
  if (!list.length && !rarity) return "";
  return `<div class="traits">${rarity}${list.map(t => `<span class="trait">${esc(traitLabel(t))}</span>`).join("")}</div>`;
}

/** Range, targets, area, duration, defense — only what the spell has. */
function spellFactsHtml(item) {
  if (item?.type !== "spell") return "";
  const sys = item.system ?? {};
  const facts = [];
  const add = (label, value) => { if (value) facts.push(`<span><em>${label}</em> ${esc(value)}</span>`); };
  add("사거리", sys.range?.value);
  add("대상", sys.target?.value);
  if (sys.area?.value) add("범위", `${sys.area.value}피트 ${sys.area.type ?? ""}`.trim());
  add("지속", sys.duration?.value);
  const save = sys.defense?.save;
  if (save?.statistic) add("방어", `${save.basic ? "기본 " : ""}${game.i18n.localize(CONFIG.PF2E?.saves?.[save.statistic] ?? save.statistic)}`);
  return facts.length ? `<div class="facts">${facts.join("")}</div>` : "";
}

const enrichedCache = new Map();

async function enrichedDescription(doc) {
  const raw = doc?.system?.description?.value ?? (typeof doc?.description === "string" ? doc.description : "");
  if (!raw) return "";
  const key = `${doc.uuid ?? doc.id ?? doc.slug}:${doc._stats?.modifiedTime ?? ""}`;
  if (enrichedCache.has(key)) return enrichedCache.get(key);

  const Editor = foundry.applications?.ux?.TextEditor?.implementation ?? globalThis.TextEditor;
  let html = localizeMaybe(raw);
  try {
    html = await Editor.enrichHTML(html, {
      async: true,
      rollData: doc.getRollData?.() ?? {},
      relativeTo: doc,
      secrets: !!doc.isOwner
    });
  } catch (err) {
    console.warn(`${MODULE_ID} | slot card: could not enrich`, err);
  }
  if (enrichedCache.size > 200) enrichedCache.clear();
  enrichedCache.set(key, html);
  return html;
}

export class SlotCard {
  constructor(hud) {
    this.hud = hud;
    this.el = document.createElement("section");
    this.el.id = "pkh-slot-card";
    this.el.className = "hidden";
    this.el.setAttribute("aria-hidden", "true");
    document.body.appendChild(this.el);
    this.anchor = null;
    this.timer = null;
    this.token = 0;
    this.pinned = false;

    const root = hud.root;
    root.addEventListener("pointerover", ev => this._over(ev));
    root.addEventListener("pointerout", ev => this._out(ev));
    for (const type of ["pointerdown", "wheel", "dragstart"]) {
      document.addEventListener(type, ev => this._onOutside(ev), { capture: true, passive: true });
    }
    // Esc closes a pinned card first, before Foundry's own Esc handling sees it.
    document.addEventListener("keydown", ev => {
      if (ev.key !== "Escape" || !this.pinned) return;
      ev.stopPropagation();
      ev.preventDefault();
      this.hide();
    }, { capture: true });
    this.el.addEventListener("click", ev => {
      if (ev.target.closest("[data-act=unpin]")) this.hide();
    });
  }

  get visible() {
    return !this.el.classList.contains("hidden");
  }

  /** A press, a wheel turn or a drag: closes a passing card; a pinned one only for presses elsewhere. */
  _onOutside(ev) {
    if (!this.pinned) return this.hide();
    if (this.el.contains(ev.target)) return;
    if (ev.type === "pointerdown") this.hide();
  }

  /** The pin key. True when it did something, so the key is free otherwise. */
  togglePin() {
    if (this.pinned) { this.hide(); return true; }
    if (this.visible) { this._pin(); return true; }
    if (this.timer && this.anchor?.isConnected) {
      const slot = this.anchor;
      clearTimeout(this.timer);
      this.show(slot).then(() => { if (this.visible) this._pin(); });
      return true;
    }
    return false;
  }

  _pin() {
    this.pinned = true;
    this.el.classList.add("pinned");
    this.el.removeAttribute("aria-hidden");
    this.el.setAttribute("role", "dialog");
    if (!this.el.querySelector("[data-act=unpin]")) {
      this.el.querySelector("header")?.insertAdjacentHTML("beforeend",
        `<button type="button" class="unpin" data-act="unpin" data-tooltip="닫기 (Esc)" aria-label="닫기"><i class="fa-solid fa-xmark"></i></button>`);
    }
    const hint = this.el.querySelector(".hint-pin");
    if (hint) hint.innerHTML = `<i class="fa-solid fa-thumbtack"></i> 고정됨 · 휠로 스크롤 · Esc로 닫기`;
    // Taller now that the description scrolls: keep it on screen.
    const card = this.el.getBoundingClientRect();
    if (card.bottom > window.innerHeight - 8) this.el.style.top = `${Math.max(8, Math.round(window.innerHeight - card.height - 8))}px`;
    if (card.top < 8) this.el.style.top = "8px";
  }

  static enabled() {
    return setting("hudSlotCard", true) !== false;
  }

  static delayMs() {
    const seconds = Number(setting("hudSlotCardDelay", 0.8));
    return Math.round(Math.clamp(Number.isFinite(seconds) ? seconds : 0.8, 0.5, 1.5) * 1000);
  }

  _over(ev) {
    if (!SlotCard.enabled() || this.pinned) return;
    const slot = ev.target.closest(".pkh-slot:not(.empty)");
    if (!slot || slot === this.anchor) return;
    this.hide();
    this.anchor = slot;
    this.timer = setTimeout(() => this.show(slot), SlotCard.delayMs());
  }

  _out(ev) {
    if (this.pinned) return;
    const slot = ev.target.closest(".pkh-slot");
    if (!slot || slot.contains(ev.relatedTarget)) return;
    this.hide();
  }

  /** The HUD redrew: follow the card (or its pending timer) to the new node, or close it. */
  afterRender() {
    if (this.pinned) return;
    const pending = !!this.timer;
    const showing = !this.el.classList.contains("hidden");
    if (!pending && !showing) return;
    const ref = pending ? this.anchor?.dataset : this.el.dataset;
    const node = ref?.row === undefined ? null
      : this.hud.root.querySelector(`.pkh-slot[data-row="${ref.row}"][data-col="${ref.col}"]:not(.empty)`);
    if (!node || !node.matches(":hover")) return this.hide();
    this.anchor = node;
    if (pending) {
      clearTimeout(this.timer);
      this.timer = setTimeout(() => this.show(node), SlotCard.delayMs());
    }
  }

  hide() {
    clearTimeout(this.timer);
    this.timer = null;
    this.anchor = null;
    this.token++;
    this.pinned = false;
    this.el.classList.add("hidden");
    this.el.classList.remove("pinned");
    this.el.setAttribute("aria-hidden", "true");
    this.el.removeAttribute("role");
  }

  async show(slot) {
    this.timer = null;
    const actor = this.hud.actor;
    if (!actor || !slot.isConnected || this.hud.mapEl && !this.hud.mapEl.classList.contains("hidden")) return;
    const row = Number(slot.dataset.row);
    const col = Number(slot.dataset.col);
    const entry = this.hud._slotAt(slot).entry;
    if (!entry) return;

    const mine = ++this.token;
    const html = await this._content(actor, entry);
    // Something else happened while the description was being prepared.
    if (mine !== this.token || !slot.isConnected || !html) return;

    const key = pinKeyLabel();
    this.el.innerHTML = html.replace(/<\/footer>\s*$/, key ? ` · <span class="hint-pin"><kbd>${esc(key)}</kbd> 고정</span></footer>` : "</footer>");
    this.el.classList.remove("hidden");
    const box = slot.getBoundingClientRect();
    const card = this.el.getBoundingClientRect();
    const left = Math.min(window.innerWidth - card.width - 8, Math.max(8, box.left + box.width / 2 - card.width / 2));
    const top = box.top - card.height - 10 >= 8 ? box.top - card.height - 10 : Math.min(window.innerHeight - card.height - 8, box.bottom + 10);
    this.el.style.left = `${Math.round(left)}px`;
    this.el.style.top = `${Math.round(top)}px`;
    this.el.dataset.row = row;
    this.el.dataset.col = col;
  }

  async _content(actor, entry) {
    const view = resolveSlot(actor, entry, { attacks: this.hud.eco?.attacks ?? 0 });
    const head = (img, name, extra = "") => `
      <header>
        ${img ? `<img src="${esc(img)}" alt="">` : ""}
        <strong>${esc(name)}</strong>${extra}
      </header>`;

    const strike = strikeForEntry(actor, entry);
    if (strike) {
      const item = strike.item;
      const map = view?.map?.length ? `<div class="facts"><span><em>공격</em> ${view.map.map(esc).join(" / ")}</span></div>` : "";
      return `${head(item?.img ?? view?.img, strike.label ?? item?.name ?? "")}
        ${traitsHtml(item)}${map}
        ${await this._body(item)}
        <footer>클릭: 몇 번째 공격인지 고르기 · 가운데 클릭: 3번째 공격</footer>`;
    }

    if (entry.type === "item") {
      const item = findItem(actor, entry);
      if (!item) return head(entry.img, view?.label ?? "아이템") + `<p class="muted">지금 가지고 있지 않습니다.</p>`;
      const meta = [rankText(item), item.type === "consumable" && view?.badge !== null && view?.badge !== undefined ? `남은 ${view.badge}` : ""]
        .filter(Boolean).map(esc).join(" · ");
      const hint = item.type === "spell" ? "클릭: 시전 / 채팅으로 보내기"
        : ["action", "feat"].includes(item.type) ? "클릭: 사용 / 채팅에 올리기"
        : item.type === "consumable" ? "클릭: 카드 올리기 · Shift+클릭: 사용" : "클릭: 채팅에 올리기";
      return `${head(item.img, item.name, `<span class="cost">${costHtml(item)}</span>`)}
        ${meta ? `<div class="meta">${meta}</div>` : ""}
        ${traitsHtml(item)}${spellFactsHtml(item)}
        ${await this._body(item)}
        <footer>${hint}</footer>`;
    }

    if (entry.type === "action") {
      const action = game.pf2e?.actions?.get?.(entry.slug);
      const description = action?.description ? localizeMaybe(action.description) : "";
      let body = "";
      if (description) {
        const Editor = foundry.applications?.ux?.TextEditor?.implementation ?? globalThis.TextEditor;
        try { body = await Editor.enrichHTML(description, { async: true }); } catch { body = esc(description); }
      }
      return `${head(action?.img ?? view?.img, view?.label ?? entry.slug)}
        ${body ? `<div class="desc">${body}</div>` : ""}<footer>클릭: 사용</footer>`;
    }

    if (entry.type === "skill") {
      return `${head(null, view?.label ?? entry.slug, view?.badge ? `<span class="cost">${esc(view.badge)}</span>` : "")}
        <footer>클릭: 굴리기</footer>`;
    }

    if (entry.type === "effect") {
      const source = entry.uuid ? fromUuidSync(entry.uuid) : null;
      return `${head(source?.img, source?.name ?? view?.label ?? "효과")}
        ${await this._body(source)}<footer>클릭: 선택한 토큰에 켜기 / 끄기</footer>`;
    }

    if (entry.type === "macro") {
      return `${head(view?.img, view?.label ?? "매크로")}<footer>매크로 · 클릭: 실행</footer>`;
    }
    return "";
  }

  async _body(doc) {
    const html = await enrichedDescription(doc);
    return html ? `<div class="desc">${html}</div>` : "";
  }
}

export function registerSlotCardSettings() {
  game.settings.register(MODULE_ID, "hudSlotCard", {
    name: "퀵슬롯 설명 카드",
    hint: "퀵슬롯에 마우스를 잠시 올려두면 그 능력의 비용·특성·설명을 카드로 보여줍니다. 시트를 열지 않아도 됩니다.",
    scope: "client", config: true, type: Boolean, default: true,
    onChange: () => game.pf2eKrHud?.hud?.scheduleRender()
  });
  game.settings.register(MODULE_ID, "hudSlotCardDelay", {
    name: "퀵슬롯 설명 카드: 뜨기까지 (초)",
    hint: "마우스를 올리고 이만큼 지나야 카드가 뜹니다. 짧을수록 빨리 뜨지만 지나가며 스칠 때도 뜹니다.",
    scope: "client", config: true, type: Number, default: 0.8, range: { min: 0.5, max: 1.5, step: 0.1 }
  });
}
