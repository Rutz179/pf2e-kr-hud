import { MODULE_ID, SimpleWindow, boardViewportRect, displayName, esc, facesOf, leftChromeWidth, lookAtToken, plainRefs, setting, t } from "./shared.mjs";
import { fillPolyglot, polyglotText } from "./polyglot.mjs";
import { adapterCallback, badgesFor, barsFor, onAdapterRefresh } from "./systems.mjs";
import { frameClass, frameOf, pictureHtml } from "./portrait-frame.mjs";

/*
 * Party portraits on six seats:
 *   pc1 ┐                    ┌ pc2      top row
 *   pc3 ┤    (canvas)        ├ pc4      middle of the band
 *   pc5 ┘                    └ pc6      bottom row (clear of the bottom UI)
 * PCs only; NPC portraits are left to Stage Theatre. Portraits take no clicks during play so they never block the canvas, except a player's own picture: clicking it marks them away (자리비움, a user flag everyone sees); speaking or a key press brings them back. In combat every picture takes a click that moves the view to that character's token with a local ping; the current turn is lit and ringed. The GM can switch on "배치 편집" to drag and wheel-resize them.
 */
export const PC_SLOTS = ["pc1", "pc2", "pc3", "pc4", "pc5", "pc6"];
const ROW_OF = { pc1: 0, pc2: 0, pc3: 1, pc4: 1, pc5: 2, pc6: 2 };
const RIGHT_SIDE = new Set(["pc2", "pc4", "pc6"]);

/** The combat on view, when it has started. */
function combatNow() {
  const c = game.combats?.viewed ?? game.combat;
  return c?.started ? c : null;
}

/** A character's token on this scene: its combatant's first, else any. */
function tokenOf(actor) {
  if (!actor || !canvas?.ready) return null;
  const cb = combatNow()?.combatants?.find(x => (x.actorId ?? x.actor?.id) === actor.id && x.sceneId === canvas.scene?.id);
  return cb?.token?.object ?? canvas.tokens?.placeables?.find(tk => tk.actor?.id === actor.id) ?? null;
}

/** The view to a character's token, pinged there (Ctrl+click, GM: everyone's view, at the GM's zoom). */
async function focusActor(actor, { everyone = false } = {}) {
  const tok = tokenOf(actor);
  if (!tok || (!tok.visible && !game.user.isGM)) return ui.notifications.info(t("Portraits.NoToken", { name: displayName(actor?.name ?? "?") }));
  return lookAtToken(tok, { everyone });
}

const SAFE_TOP = 64;
const SAFE_RIGHT = 16;
const ROW_GAP = 18;

/** The players in the Discord voice room (Foundry users, in the link manager's order, the room's team first), or null when unknown (voice off, bot in no room, bot too old) or the setting is off. */
export function voiceRoomUsers() {
  if (!setting("portraitsVoiceOnly", true)) return null;
  const present = setting("voicePresent", null);
  return Array.isArray(present?.users) ? present.users : null;
}

/** The per-seat pins that still point at a character. A pin whose character was deleted is ignored; nothing is written back. */
export function pinnedActors() {
  const stored = setting("portraitSlots", {}) ?? {};
  return PC_SLOTS.map(k => (stored[k] ? game.actors.get(stored[k]) ?? null : null));
}

/** The GM's own portrait: a world actor picked in the portrait manager (a user flag, not Foundry's assigned character, so the GM's rolls and macros are unaffected). Shown while that GM is logged in. */
export function gmPortraitActor(user) {
  if (!user?.isGM) return null;
  const id = user.getFlag?.(MODULE_ID, "portraitActor");
  return id ? game.actors.get(id) ?? null : null;
}

/** The actor on the GM's seat: the first logged-in GM who picked one. */
function gmSeatActor() {
  for (const u of game.users ?? []) {
    if (!u.isGM || !u.active) continue;
    const a = gmPortraitActor(u);
    if (a) return a;
  }
  return null;
}

/** The GM's portrait goes on the last free seat, never pushing a player out. */
function withGmSeat(seats) {
  const gm = gmSeatActor();
  if (!gm || seats.some(a => a?.id === gm.id)) return seats;
  const i = seats.lastIndexOf(null);
  if (i >= 0) seats[i] = gm;
  return seats;
}

export function stageActors() {
  return withGmSeat(playerSeats());
}

function playerSeats() {
  // only the people in the Discord voice room, each with their assigned character
  const room = voiceRoomUsers();
  if (room) {
    const seen = new Set();
    const list = [];
    for (const id of room) {
      const user = game.users.get(id);
      const actor = user && !user.isGM ? user.character : null;
      if (!actor || seen.has(actor.id)) continue;
      seen.add(actor.id);
      list.push(actor);
    }
    return PC_SLOTS.map((_, i) => list[i] ?? null);
  }
  const pinned = pinnedActors();
  if (pinned.some(Boolean)) return [...pinned];
  const seen = new Set();
  const auto = [];
  for (const user of game.users) {
    const actor = user.isGM ? null : user.character;
    if (!actor || seen.has(actor.id)) continue;
    seen.add(actor.id);
    auto.push(actor);
  }
  return PC_SLOTS.map((_, i) => auto[i] ?? null);
}

/** Current expression chosen with "@키워드" in chat (see toolkit.mjs). */
const currentFace = new Map();

function faceImage(actor) {
  const key = currentFace.get(actor.id);
  if (!key) return null;
  // The HUD's own expressions first, then the Cinematic Stage's (shared.mjs facesOf).
  const face = facesOf(actor).find(f => f.key === key);
  return face?.img ?? null;
}

export function portraitSrc(actor) {
  const face = faceImage(actor);
  if (face) return face;
  // a picture of its own for the party portrait (the sheet keeps actor.img)
  const own = actor.getFlag?.(MODULE_ID, "portraitImg");
  if (typeof own === "string" && own.trim()) return own.trim();
  return sheetPortraitSrc(actor);
}

/** Without a party-portrait picture of its own: the sheet's picture, or the token's (the setting). */
export function sheetPortraitSrc(actor) {
  if (setting("portraitImage", "actor") === "token") {
    return actor.prototypeToken?.texture?.src || actor.img || "icons/svg/mystery-man.svg";
  }
  return actor.img || actor.prototypeToken?.texture?.src || "icons/svg/mystery-man.svg";
}

/** One bar under the name (PF2e: HP; other systems: whatever their adapter shows, e.g. HP + SAN). */
function barHtml(bar, showNumbers, many) {
  const max = Math.max(1, Number(bar.max) || 1);
  const value = Math.max(0, Number(bar.value) || 0);
  const temp = Math.max(0, Number(bar.temp) || 0);
  const pct = Math.min(100, (value / max) * 100);
  const tempPct = Math.min(100, (temp / max) * 100);
  const tone = bar.color === "sanity" || bar.color === "alt" ? bar.color : "";
  const fill = tone ? `var(--pkh-bar-${tone})` : hpColor(pct);
  const label = many && bar.label ? `<em>${esc(bar.label)}</em>` : "";
  return `
          <div class="pkh-portrait-hp${tone ? ` ${tone}` : ""}">
            <div class="fill" style="width:${pct}%;background:${fill}"></div>
            ${temp ? `<div class="temp" style="width:${tempPct}%"></div>` : ""}
            ${showNumbers ? `<span class="num">${label}${value}/${max}</span>` : ""}
          </div>`;
}

/** Badges a system adapter puts under the name (인세인: 광기·핸드아웃…); clickable ones keep their handler. */
const badgeHandlers = new Map();
function badgesHtml(actor, showNumbers) {
  const badges = badgesFor(actor);
  badgeHandlers.set(actor.id, badges);
  if (!badges.length) return "";
  return `<div class="pkh-portrait-badges">${badges.map((b, i) => {
    const click = typeof b.onClick === "function";
    const text = showNumbers || b.tone || b.alwaysText ? ` ${esc(b.text ?? "")}` : "";
    return `<span class="badge ${esc(b.tone ?? "")}${click ? " clickable" : ""}" data-badge="${i}" data-tooltip="${esc(b.tooltip ?? "")}"${click ? ` role="button" tabindex="0"` : ""}><i class="${esc(b.icon ?? "fa-solid fa-circle")}"></i>${text}</span>`;
  }).join("")}</div>`;
}

function hpColor(pct) {
  if (pct > 50) return "var(--pkh-hp-high)";
  if (pct > 25) return "var(--pkh-hp-mid)";
  return "var(--pkh-hp-low)";
}

function storedLayout() {
  return foundry.utils.deepClone(setting("portraitLayout", {}) ?? {});
}

/** Plain-text excerpt of a chat message, or "" when it isn't dialogue. */
function chatToSpeech(message, limit = 160) {
  if (message.rolls?.length || message.flags?.pf2e?.context || message.flags?.pf2e?.origin) return "";
  const div = document.createElement("div");
  div.innerHTML = String(message.content ?? "");
  if (div.querySelector(".dice-roll, .chat-card, table, .pkh-save-request")) return "";
  const text = plainRefs(div.textContent ?? "").replace(/\s+/g, " ").trim();
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

export class PortraitStage {
  constructor() {
    this.element = null;
    this.speakingSlots = new Set();   // Discord / A/V voice
    this.chatSlots = new Map();       // slotKey -> timeout id
    this.editing = false;
    this._frame = 0;
    this._onResize = () => this.layout();
  }

  mount() {
    if (this.element) return;
    const el = document.createElement("section");
    el.id = "pkh-portraits";
    el.setAttribute("aria-label", t("Portraits.Aria"));
    document.body.appendChild(el);
    this.element = el;

    el.addEventListener("pointerdown", ev => this._dragStart(ev));
    el.addEventListener("wheel", ev => this._wheelResize(ev), { passive: false });
    el.addEventListener("dblclick", ev => this._onDblClick(ev));
    el.addEventListener("click", ev => {
      if (this._onBadgeClick(ev)) return;
      if (this.editing || ev.button !== 0) return;
      // in combat: to that character
      const card = ev.target.closest(".pkh-portrait");
      if (card && !card.classList.contains("gm") && combatNow() && ev.target.closest(".pkh-portrait-frame")) return void focusActor(game.actors.get(card.dataset.actorId), { everyone: ev.ctrlKey || ev.metaKey });
      if (!ev.target.closest(".pkh-portrait.mine .pkh-portrait-frame")) return;
      setAway(game.user, !isAway(game.user));
    });
    this._bindDrops(el);

    window.addEventListener("resize", this._onResize);
    if (globalThis.ResizeObserver) {
      this._observer = new ResizeObserver(this._onResize);
      for (const id of ["board", "sidebar"]) {
        const node = document.getElementById(id);
        if (node) this._observer.observe(node);
      }
    }
    this.render();
  }

  visible() {
    return setting("portraitsShown", true) && !setting("portraitsHideLocal", false) && !!canvas?.scene;
  }

  scheduleRender() {
    cancelAnimationFrame(this._frame);
    this._frame = requestAnimationFrame(() => this.render());
  }

  render() {
    const el = this.element;
    if (!el) return;
    const show = this.visible() || this.editing;
    el.classList.toggle("hidden", !show);
    el.classList.add("bare");
    el.classList.toggle("editing", this.editing);
    el.classList.toggle("idle-dim", setting("portraitIdleDim", true));
    if (!show) return;

    const numbers = setting("portraitHpNumbers", "owner");
    const actors = stageActors();
    const gmId = gmSeatActor()?.id ?? null;
    const mine = game.user.isGM ? null : slotKeyForUser(game.user.id);
    this.actorsBySlot = Object.fromEntries(PC_SLOTS.map((k, i) => [k, actors[i]]));

    el.innerHTML = PC_SLOTS.map((key, i) => {
      const actor = actors[i];
      if (!actor) return "";
      // the GM's seat: the face and name only
      const gm = actor.id === gmId && !actor.hasPlayerOwner;
      const bars = gm ? [] : barsFor(actor);
      const down = bars.length > 0 && (Number(bars[0].value) || 0) <= 0;
      const showNumbers = numbers === "all" || (numbers === "owner" && actor.isOwner);
      const framing = frameOf(actor.getFlag?.(MODULE_ID, "portraitFrame"));
      return `
        <div class="pkh-portrait ${key} ${down ? "down" : ""} ${key === mine ? "mine" : ""}${gm ? " gm" : ""}" data-slot="${key}" data-actor-id="${actor.id}">
          <div class="pkh-portrait-frame${frameClass(framing)}"${key === mine ? ` data-tooltip="${esc(t("Portraits.AwayTip"))}"` : ""}>${pictureHtml(portraitSrc(actor), framing)}</div>
          <div class="pkh-away" hidden><i class="fa-solid fa-moon"></i> ${esc(t("Portraits.Away"))}</div>
          <div class="pkh-portrait-name"><span>${esc(displayName(actor.name))}</span></div>${bars.map(b => barHtml(b, showNumbers, bars.length > 1)).join("")}
          ${gm ? "" : badgesHtml(actor, showNumbers)}
          <div class="pkh-bubble" hidden></div>
          ${this.editing ? `<div class="pkh-edit-tag">${key.toUpperCase()} · ${t("Portraits.EditTag")}</div>` : ""}
        </div>`;
    }).join("");

    this.applyVoiceHighlight();
    this.layout();
  }

  /**
   * Voice or chat → lit; everyone else stays in the idle (dimmed) look. Away players: the sign.
   * In combat: whose turn it is (lit and ringed), and every picture clickable (to the token).
   */
  applyVoiceHighlight() {
    const el = this.element;
    if (!el) return false;
    const away = awaySlots();
    const fight = combatNow();
    const turn = fight?.combatant?.actorId ?? fight?.combatant?.actor?.id ?? null;
    el.classList.toggle("in-combat", !!fight);
    for (const node of el.querySelectorAll(".pkh-portrait")) {
      const key = node.dataset.slot;
      node.classList.toggle("turn", !!turn && node.dataset.actorId === turn);
      const frame = node.querySelector(".pkh-portrait-frame");
      const tip = fight && !node.classList.contains("gm") ? t("Portraits.FocusTip") : node.classList.contains("mine") ? t("Portraits.AwayTip") : "";
      if (frame && (frame.dataset.tooltip ?? "") !== tip) { if (tip) frame.dataset.tooltip = tip; else delete frame.dataset.tooltip; }
      node.classList.toggle("speaking", this.speakingSlots.has(key) || this.chatSlots.has(key));
      node.classList.toggle("away", away.has(key));
      const sign = node.querySelector(".pkh-away");
      if (sign) sign.hidden = !away.has(key);
    }
    return true;
  }

  highlightFromChat(slotKey, ms, text, font = "") {
    const node = this.element?.querySelector(`.pkh-portrait[data-slot="${slotKey}"]`);
    clearTimeout(this.chatSlots.get(slotKey));
    this.chatSlots.set(slotKey, setTimeout(() => {
      this.chatSlots.delete(slotKey);
      const bubble = this.element?.querySelector(`.pkh-portrait[data-slot="${slotKey}"] .pkh-bubble`);
      if (bubble) bubble.hidden = true;
      this.applyVoiceHighlight();
    }, ms));
    const bubble = node?.querySelector(".pkh-bubble");
    if (bubble) {
      // A line in a language this user doesn't know (Polyglot) shows in that language's script, as in the chat log.
      fillPolyglot(bubble, { text: text ?? "", font: font ?? "" });
      bubble.hidden = !text;
    }
    this.applyVoiceHighlight();
  }

  layout() {
    const el = this.element;
    if (!el || el.classList.contains("hidden")) return;
    const rect = boardViewportRect();
    Object.assign(el.style, {
      left: `${Math.round(rect.left)}px`,
      top: `${Math.round(rect.top)}px`,
      width: `${Math.round(rect.width)}px`,
      height: `${Math.round(rect.height)}px`
    });

    const safeLeft = Math.max(72, Math.round(leftChromeWidth(rect) + 20));
    const safeBottom = Math.max(40, Number(setting("portraitBottomMargin", 150)) || 150);
    const band = Math.max(200, rect.height - SAFE_TOP - safeBottom);
    const scale = Number(setting("portraitScale", 1)) || 1;
    const wanted = Math.round(Math.min(190, Math.max(120, rect.width * 0.1)) * scale);
    const custom = storedLayout();

    const autoNodes = [...el.querySelectorAll(".pkh-portrait")].filter(n => !custom[n.dataset.slot]);
    const occupiedRows = new Set(autoNodes.map(n => ROW_OF[n.dataset.slot]));
    const rows = occupiedRows.size ? Math.max(...occupiedRows) + 1 : 1;

    // Name + HP bar height as actually rendered (follows the font-size setting),
    // so tall full-body art from the card below never covers the text above.
    const sample = autoNodes[0] ?? el.querySelector(".pkh-portrait");
    let label = 40;
    if (sample) {
      sample.style.setProperty("--pkh-card-w", `${wanted}px`);
      const frame = sample.querySelector(".pkh-portrait-frame");
      label = Math.max(24, sample.offsetHeight - (frame?.offsetHeight ?? wanted));
    }
    const maxCard = (band - (rows - 1) * ROW_GAP) / rows - label;
    const width = Math.max(64, Math.min(wanted, Math.floor(maxCard)));
    const cardH = width + label;
    const rowTop = [SAFE_TOP, SAFE_TOP + Math.max(0, (band - cardH) / 2), SAFE_TOP + Math.max(0, band - cardH)];

    for (const node of el.querySelectorAll(".pkh-portrait")) {
      const key = node.dataset.slot;
      const pos = custom[key];
      node.classList.remove("left", "right");
      if (pos) {
        const w = Math.clamp(Number(pos.w) || width, 64, 360);
        node.style.setProperty("--pkh-card-w", `${w}px`);
        node.style.left = `${(Number(pos.x) / 100) * rect.width}px`;
        node.style.top = `${(Number(pos.y) / 100) * rect.height}px`;
        node.style.right = "";
        node.classList.add(Number(pos.x) > 50 ? "right" : "left");
        continue;
      }
      node.style.setProperty("--pkh-card-w", `${width}px`);
      node.style.top = `${Math.round(rowTop[ROW_OF[key]])}px`;
      if (RIGHT_SIDE.has(key)) {
        node.style.left = "";
        node.style.right = `${SAFE_RIGHT}px`;
        node.classList.add("right");
      } else {
        node.style.right = "";
        node.style.left = `${safeLeft}px`;
        node.classList.add("left");
      }
    }
  }

  /* GM layout editing */

  toggleEditing(force) {
    if (!game.user.isGM) return;
    this.editing = force ?? !this.editing;
    ui.notifications.info(t(this.editing ? "Portraits.Editing" : "Portraits.Locked"));
    this.render();
  }

  async resetLayout() {
    await game.settings.set(MODULE_ID, "portraitLayout", {});
    ui.notifications.info(t("Portraits.Reset"));
  }

  _dragStart(ev) {
    if (!this.editing || ev.button !== 0) return;
    const node = ev.target.closest(".pkh-portrait");
    if (!node) return;
    ev.preventDefault();
    const rect = this.element.getBoundingClientRect();
    const box = node.getBoundingClientRect();
    const offX = ev.clientX - box.left;
    const offY = ev.clientY - box.top;
    node.setPointerCapture(ev.pointerId);
    node.classList.add("dragging");

    const move = e => {
      node.style.right = "";
      node.style.left = `${Math.clamp(e.clientX - rect.left - offX, 0, rect.width - box.width)}px`;
      node.style.top = `${Math.clamp(e.clientY - rect.top - offY, 0, rect.height - box.height)}px`;
    };
    const up = async () => {
      node.removeEventListener("pointermove", move);
      node.removeEventListener("pointerup", up);
      node.classList.remove("dragging");
      const layout = storedLayout();
      layout[node.dataset.slot] = {
        x: (parseFloat(node.style.left) / rect.width) * 100,
        y: (parseFloat(node.style.top) / rect.height) * 100,
        w: Math.round(node.getBoundingClientRect().width - (this.element.classList.contains("bare") ? 0 : 10))
      };
      await game.settings.set(MODULE_ID, "portraitLayout", layout);
    };
    node.addEventListener("pointermove", move);
    node.addEventListener("pointerup", up);
  }

  async _wheelResize(ev) {
    if (!this.editing) return;
    const node = ev.target.closest(".pkh-portrait");
    if (!node) return;
    ev.preventDefault();
    ev.stopPropagation();
    const rect = this.element.getBoundingClientRect();
    const box = node.getBoundingClientRect();
    const layout = storedLayout();
    const current = layout[node.dataset.slot] ?? {
      x: ((box.left - rect.left) / rect.width) * 100,
      y: ((box.top - rect.top) / rect.height) * 100,
      w: parseFloat(getComputedStyle(node).getPropertyValue("--pkh-card-w")) || 150
    };
    current.w = Math.clamp((Number(current.w) || 150) + (ev.deltaY < 0 ? 8 : -8), 64, 360);
    layout[node.dataset.slot] = current;
    await game.settings.set(MODULE_ID, "portraitLayout", layout);
  }

  _onDblClick(ev) {
    if (!this.editing) return;
    const node = ev.target.closest(".pkh-portrait");
    const actor = node && game.actors.get(node.dataset.actorId);
    actor?.sheet?.render(true);
  }

  slotKeyForActor(actorId) {
    return PC_SLOTS.find(k => this.actorsBySlot?.[k]?.id === actorId) ?? null;
  }

  /* badges and drops (system adapters) */

  _onBadgeClick(ev) {
    const badge = ev.target.closest(".badge.clickable");
    if (!badge) return false;
    const actor = game.actors.get(badge.closest(".pkh-portrait")?.dataset.actorId);
    const b = actor && badgeHandlers.get(actor.id)?.[Number(badge.dataset.badge)];
    if (typeof b?.onClick !== "function") return false;
    ev.preventDefault();
    ev.stopPropagation();
    try { b.onClick(ev, actor); } catch (err) { console.error(`${MODULE_ID} | badge click`, err); }
    return true;
  }

  /** While something the adapter wants is dragged, portraits take drops (인세인: hand a card over). */
  _bindDrops(el) {
    const off = () => {
      el.classList.remove("drop-active");
      el.querySelectorAll(".drop-over").forEach(n => n.classList.remove("drop-over"));
      clearTimeout(this._dropTimer);
    };
    document.addEventListener("dragstart", ev => {
      if (!adapterCallback("onPortraitDrop")) return;
      const accepts = adapterCallback("acceptsDrop");
      if (accepts) {
        let data = null;
        try { data = JSON.parse(ev.dataTransfer?.getData("text/plain") || "null"); } catch (_) { data = null; }
        if (!accepts(data, ev)) return;
      }
      el.classList.add("drop-active");
      clearTimeout(this._dropTimer);
      this._dropTimer = setTimeout(off, 20000);
      // A re-rendered drag source never sends dragend: the next pointer move after the drag switches it off.
      setTimeout(() => document.addEventListener("pointermove", off, { once: true, capture: true }), 50);
    }, false);
    document.addEventListener("dragend", off, true);
    document.addEventListener("drop", () => setTimeout(off, 0), true);
    el.addEventListener("dragover", ev => {
      const node = ev.target.closest(".pkh-portrait:not(.gm)");
      if (!node || !el.classList.contains("drop-active")) return;
      ev.preventDefault();
      el.querySelectorAll(".drop-over").forEach(n => n !== node && n.classList.remove("drop-over"));
      node.classList.add("drop-over");
    });
    el.addEventListener("dragleave", ev => {
      const node = ev.target.closest(".pkh-portrait");
      if (node && !node.contains(ev.relatedTarget)) node.classList.remove("drop-over");
    });
    el.addEventListener("drop", async ev => {
      const node = ev.target.closest(".pkh-portrait:not(.gm)");
      const fn = adapterCallback("onPortraitDrop");
      if (!node || !fn) return;
      ev.preventDefault();
      ev.stopPropagation();
      const actor = game.actors.get(node.dataset.actorId);
      off();
      if (!actor) return;
      try { await fn(actor, ev); } catch (err) { console.error(`${MODULE_ID} | portrait drop`, err); }
    });
  }
}

/* Speaking API used by voice-bridge.js */

const SPEAKING_STALE_MS = 5000;
const SPEAKING_END_HOLD_MS = 450;
const speakingTimers = new Map();
const speakingUsers = new Set();

function slotKeyForUser(userId) {
  const user = game.users.get(userId);
  if (!user || !game.pf2eKrStage?.overlay) return null;
  const actors = stageActors();
  const own = user.isGM ? gmPortraitActor(user)?.id : user.character?.id;
  for (let i = 0; i < PC_SLOTS.length; i++) {
    if (actors[i] && own && own === actors[i].id) return PC_SLOTS[i];
  }
  for (let i = 0; i < PC_SLOTS.length; i++) {
    if (actors[i] && !user.isGM && actors[i].testUserPermission(user, "OWNER")) return PC_SLOTS[i];
  }
  return null;
}

function releaseSpeakingSlot(slotKey) {
  speakingTimers.delete(slotKey);
  const overlay = game.pf2eKrStage?.overlay;
  if (!overlay?.speakingSlots.delete(slotKey)) return;
  overlay.applyVoiceHighlight();
}

function setSpeakingSlot(slotKey, speaking) {
  const overlay = game.pf2eKrStage?.overlay;
  if (!overlay || !slotKey) return;
  clearTimeout(speakingTimers.get(slotKey));
  if (!speaking) {
    speakingTimers.set(slotKey, setTimeout(() => releaseSpeakingSlot(slotKey), SPEAKING_END_HOLD_MS));
    return;
  }
  speakingTimers.set(slotKey, setTimeout(() => releaseSpeakingSlot(slotKey), SPEAKING_STALE_MS));
  if (overlay.speakingSlots.has(slotKey)) return;
  overlay.speakingSlots.add(slotKey);
  overlay.applyVoiceHighlight();
}

/* 자리비움 */

const isAway = user => !!user?.getFlag?.(MODULE_ID, "away");

/** Mark a user away or back (their own client, or the GM's). */
function setAway(user, on) {
  if (!user || isAway(user) === !!on) return;
  if (user !== game.user && !game.user.isGM) return;
  user.update({ [`flags.${MODULE_ID}.away`]: !!on }).catch(() => null);
}

/** The seats of the players who are away. */
function awaySlots() {
  const out = new Set();
  for (const u of game.users ?? []) if (!u.isGM && isAway(u)) { const k = slotKeyForUser(u.id); if (k) out.add(k); }
  return out;
}

/** An away player made a sound: back (written by them, or by the active GM if theirs doesn't hear it). */
function backOnVoice(userId) {
  const user = game.users.get(userId);
  if (!isAway(user)) return;
  if (user.isSelf || user === game.user || game.users.activeGM?.isSelf || game.users.activeGM?.id === game.user.id) setAway(user, false);
}

function setSpeaking(userId, speaking) {
  if (speaking) backOnVoice(userId);
  if (speaking) speakingUsers.add(userId);
  else speakingUsers.delete(userId);
  const slotKey = slotKeyForUser(userId);
  if (slotKey) setSpeakingSlot(slotKey, speaking);
}

function clearSpeaking() {
  for (const timer of speakingTimers.values()) clearTimeout(timer);
  speakingTimers.clear();
  speakingUsers.clear();
  const overlay = game.pf2eKrStage?.overlay;
  if (!overlay?.speakingSlots.size) return;
  overlay.speakingSlots.clear();
  overlay.applyVoiceHighlight();
}

/* Chat → highlight (+ speech bubble for plain dialogue) */

export function setFace(actorId, key) {
  if (!actorId) return;
  if (!key || key === "기본" || key === "default") currentFace.delete(actorId);   // "기본" = the default-face keyword (data)
  else currentFace.set(actorId, key);
  game.pf2eKrStage?.overlay?.scheduleRender();
}

function onChatMessage(message) {
  const face = message.getFlag?.(MODULE_ID, "face");
  if (face?.actor) setFace(face.actor, face.key);
  const overlay = game.pf2eKrStage?.overlay;
  if (!overlay || !overlay.visible() || !message.visible) return;

  let actorId = message.speaker?.actor ?? null;
  if (!actorId) actorId = (message.author?.isGM ? gmPortraitActor(message.author)?.id : message.author?.character?.id) ?? null;
  const slotKey = actorId ? overlay.slotKeyForActor(actorId) : null;
  if (!slotKey) return;

  const seconds = Math.max(2, Number(setting("portraitBubbleSeconds", 7)) || 7);
  const speech = polyglotText(message, setting("portraitChatBubbles", true) ? chatToSpeech(message) : "");
  overlay.highlightFromChat(slotKey, speech.text ? seconds * 1000 : 3000, speech.text, speech.font);
}

class PortraitSlotsMenu extends foundry.applications.api.ApplicationV2 {
  render() {
    game.pf2eKrHud?.openPortraitManager?.();
    return this;
  }
}

export function registerPortraitSettings() {
  const rerender = () => game.pf2eKrStage?.overlay?.scheduleRender();
  const relayout = () => game.pf2eKrStage?.overlay?.layout();

  game.settings.registerMenu(MODULE_ID, "portraitSlotsMenu", {
    name: "PKH.Settings.portraitSlotsMenu.Name", label: "PKH.Settings.portraitSlotsMenu.Label",
    hint: "PKH.Settings.portraitSlotsMenu.Hint",
    icon: "fa-solid fa-users", type: PortraitSlotsMenu, restricted: true
  });
  game.settings.register(MODULE_ID, "portraitSlots", { scope: "world", config: false, type: Object, default: {}, onChange: rerender });
  // with Discord voice: only the players in the bot's voice room get a portrait
  game.settings.register(MODULE_ID, "portraitsVoiceOnly", { scope: "world", config: false, type: Boolean, default: true, onChange: rerender });
  game.settings.register(MODULE_ID, "portraitLayout", { scope: "world", config: false, type: Object, default: {}, onChange: relayout });

  game.settings.register(MODULE_ID, "portraitsShown", {
    name: "PKH.Settings.portraitsShown.Name", hint: "PKH.Settings.portraitsShown.Hint",
    scope: "world", config: true, type: Boolean, default: true, onChange: rerender
  });
  game.settings.register(MODULE_ID, "portraitsHideLocal", {
    name: "PKH.Settings.portraitsHideLocal.Name", hint: "PKH.Settings.portraitsHideLocal.Hint",
    scope: "client", config: true, type: Boolean, default: false, onChange: rerender
  });
  game.settings.register(MODULE_ID, "portraitIdleDim", {
    name: "PKH.Settings.portraitIdleDim.Name", hint: "PKH.Settings.portraitIdleDim.Hint",
    scope: "client", config: true, type: Boolean, default: true, onChange: rerender
  });
  game.settings.register(MODULE_ID, "portraitScale", {
    name: "PKH.Settings.portraitScale.Name", hint: "PKH.Settings.portraitScale.Hint",
    scope: "client", config: true, type: Number, default: 1, range: { min: 0.6, max: 1.6, step: 0.05 }, onChange: relayout
  });
  game.settings.register(MODULE_ID, "portraitBottomMargin", {
    name: "PKH.Settings.portraitBottomMargin.Name", hint: "PKH.Settings.portraitBottomMargin.Hint",
    scope: "client", config: true, type: Number, default: 150, range: { min: 40, max: 400, step: 10 }, onChange: relayout
  });
  game.settings.register(MODULE_ID, "portraitImage", {
    name: "PKH.Settings.portraitImage.Name", hint: "PKH.Settings.portraitImage.Hint",
    scope: "world", config: true, type: String, default: "actor",
    choices: { actor: "PKH.Settings.portraitImage.Choices.actor", token: "PKH.Settings.portraitImage.Choices.token" }, onChange: rerender
  });
  game.settings.register(MODULE_ID, "portraitHpNumbers", {
    name: "PKH.Settings.portraitHpNumbers.Name", hint: "PKH.Settings.portraitHpNumbers.Hint",
    scope: "world", config: true, type: String, default: "owner",
    choices: { owner: "PKH.Settings.portraitHpNumbers.Choices.owner", all: "PKH.Settings.portraitHpNumbers.Choices.all", none: "PKH.Settings.portraitHpNumbers.Choices.none" }, onChange: rerender
  });
  game.settings.register(MODULE_ID, "portraitChatBubbles", {
    name: "PKH.Settings.portraitChatBubbles.Name", hint: "PKH.Settings.portraitChatBubbles.Hint",
    scope: "world", config: true, type: Boolean, default: true
  });
  game.settings.register(MODULE_ID, "portraitBubbleSeconds", {
    name: "PKH.Settings.portraitBubbleSeconds.Name", scope: "world", config: true, type: Number, default: 7, range: { min: 2, max: 20, step: 1 }
  });
}

export function initPortraits() {
  const overlay = new PortraitStage();
  game.pf2eKrStage = {
    overlay, setSpeaking, setSpeakingSlot, slotKeyForUser, clearSpeaking, speakingUsers,
    toggleLayoutEditing: () => overlay.toggleEditing(),
    resetLayout: () => overlay.resetLayout()
  };
  overlay.mount();

  const rerender = () => overlay.scheduleRender();
  onAdapterRefresh(rerender);
  Hooks.on("canvasReady", rerender);
  Hooks.on("updateActor", actor => { if (overlay.slotKeyForActor(actor.id)) rerender(); });
  Hooks.on("updateUser", rerender);
  Hooks.on("userConnected", rerender);
  Hooks.on("collapseSidebar", () => setTimeout(() => overlay.layout(), 250));
  // whose turn it is, and combat starting or ending (pictures clickable then)
  const turnLight = () => overlay.applyVoiceHighlight();
  for (const hook of ["combatStart", "combatTurnChange", "updateCombat", "deleteCombat", "createCombat"]) Hooks.on(hook, turnLight);
  Hooks.on("rtcUserSpeaking", (userId, speaking) => setSpeaking(userId, speaking));
  // 자리비움: a key pressed on this computer brings its player back; coming back into the game does too.
  document.addEventListener("keydown", () => { if (isAway(game.user)) setAway(game.user, false); }, true);
  Hooks.once("ready", () => { if (isAway(game.user)) setAway(game.user, false); });
  if (game.ready && isAway(game.user)) setAway(game.user, false);
  Hooks.on("createChatMessage", onChatMessage);
}
