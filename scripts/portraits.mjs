import { MODULE_ID, SimpleWindow, boardViewportRect, displayName, esc, leftChromeWidth, setting } from "./shared.mjs";

/*
 * Same seats as the CoC7 toolkit stage:
 *
 *   pc1 ┐                    ┌ pc2      top row
 *   pc3 ┤    (canvas)        ├ pc4      middle of the band
 *   pc5 ┘                    └ pc6      bottom row (kept clear of the bottom UI)
 *
 * PCs only; NPC portraits are left to Stage Theatre.
 * Portraits never take clicks during play (they must not block the canvas).
 * The GM can switch on "배치 편집" to drag them around and wheel-resize them.
 */
export const PC_SLOTS = ["pc1", "pc2", "pc3", "pc4", "pc5", "pc6"];
const ROW_OF = { pc1: 0, pc2: 0, pc3: 1, pc4: 1, pc5: 2, pc6: 2 };
const RIGHT_SIDE = new Set(["pc2", "pc4", "pc6"]);

const SAFE_TOP = 64;
const SAFE_RIGHT = 16;
const ROW_GAP = 18;

export function stageActors() {
  const stored = setting("portraitSlots", {}) ?? {};
  const explicit = PC_SLOTS.map(k => stored[k] || "");
  if (explicit.some(Boolean)) return explicit.map(id => (id ? game.actors.get(id) ?? null : null));
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
  const face = (actor.getFlag(MODULE_ID, "faces") ?? []).find(f => f?.key === key && f?.img);
  return face?.img ?? null;
}

function portraitSrc(actor) {
  const face = faceImage(actor);
  if (face) return face;
  if (setting("portraitImage", "actor") === "token") {
    return actor.prototypeToken?.texture?.src || actor.img || "icons/svg/mystery-man.svg";
  }
  return actor.img || actor.prototypeToken?.texture?.src || "icons/svg/mystery-man.svg";
}

function hpOf(actor) {
  const hp = actor?.system?.attributes?.hp ?? {};
  const max = Math.max(1, Number(hp.max) || 1);
  const value = Math.max(0, Number(hp.value) || 0);
  const temp = Math.max(0, Number(hp.temp) || 0);
  return { value, max, temp, pct: Math.min(100, (value / max) * 100), tempPct: Math.min(100, (temp / max) * 100) };
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
  const text = (div.textContent ?? "").replace(/\s+/g, " ").trim();
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
    el.setAttribute("aria-label", "파티 초상화");
    document.body.appendChild(el);
    this.element = el;

    el.addEventListener("pointerdown", ev => this._dragStart(ev));
    el.addEventListener("wheel", ev => this._wheelResize(ev), { passive: false });
    el.addEventListener("dblclick", ev => this._onDblClick(ev));

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
    el.classList.toggle("bare", (setting("portraitStyle", "") || setting("portraitStyleDefault", "bare")) === "bare");
    el.classList.toggle("editing", this.editing);
    el.classList.toggle("idle-dim", setting("portraitIdleDim", true));
    if (!show) return;

    const numbers = setting("portraitHpNumbers", "owner");
    const actors = stageActors();
    this.actorsBySlot = Object.fromEntries(PC_SLOTS.map((k, i) => [k, actors[i]]));

    el.innerHTML = PC_SLOTS.map((key, i) => {
      const actor = actors[i];
      if (!actor) return "";
      const hp = hpOf(actor);
      const showNumbers = numbers === "all" || (numbers === "owner" && actor.isOwner);
      return `
        <div class="pkh-portrait ${key} ${hp.value <= 0 ? "down" : ""}" data-slot="${key}" data-actor-id="${actor.id}">
          <div class="pkh-portrait-frame"><img src="${esc(portraitSrc(actor))}" alt="" draggable="false"></div>
          <div class="pkh-portrait-name"><span>${esc(displayName(actor.name))}</span></div>
          <div class="pkh-portrait-hp">
            <div class="fill" style="width:${hp.pct}%;background:${hpColor(hp.pct)}"></div>
            ${hp.temp ? `<div class="temp" style="width:${hp.tempPct}%"></div>` : ""}
            ${showNumbers ? `<span class="num">${hp.value}/${hp.max}</span>` : ""}
          </div>
          <div class="pkh-bubble" hidden></div>
          ${this.editing ? `<div class="pkh-edit-tag">${key.toUpperCase()} · 끌어서 이동 · 휠로 크기</div>` : ""}
        </div>`;
    }).join("");

    this.applyVoiceHighlight();
    this.layout();
  }

  /** Voice or chat → lit; everyone else stays in the idle (dimmed) look. */
  applyVoiceHighlight() {
    const el = this.element;
    if (!el) return false;
    for (const node of el.querySelectorAll(".pkh-portrait")) {
      const key = node.dataset.slot;
      node.classList.toggle("speaking", this.speakingSlots.has(key) || this.chatSlots.has(key));
    }
    return true;
  }

  highlightFromChat(slotKey, ms, text) {
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
      bubble.textContent = text ?? "";
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

  /* ---------------- GM layout editing ---------------- */

  toggleEditing(force) {
    if (!game.user.isGM) return;
    this.editing = force ?? !this.editing;
    ui.notifications.info(this.editing
      ? "PF2e-KR HUD | 초상화 배치 편집: 끌어서 옮기고, 휠로 크기를 바꾸세요. 같은 버튼으로 잠급니다."
      : "PF2e-KR HUD | 초상화 배치를 잠갔습니다.");
    this.render();
  }

  async resetLayout() {
    await game.settings.set(MODULE_ID, "portraitLayout", {});
    ui.notifications.info("PF2e-KR HUD | 초상화 배치를 기본 자리로 되돌렸습니다.");
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
}

/* ------------------------------------------------------------------------ *
 * Speaking API used by voice-bridge.js (same contract as the CoC7 toolkit)
 * ------------------------------------------------------------------------ */

const SPEAKING_STALE_MS = 5000;
const SPEAKING_END_HOLD_MS = 450;
const speakingTimers = new Map();
const speakingUsers = new Set();

function slotKeyForUser(userId) {
  const user = game.users.get(userId);
  if (!user || !game.pf2eKrStage?.overlay) return null;
  const actors = stageActors();
  for (let i = 0; i < PC_SLOTS.length; i++) {
    if (actors[i] && user.character?.id === actors[i].id) return PC_SLOTS[i];
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

function setSpeaking(userId, speaking) {
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

/* ------------------------------------------------------------------------ *
 * Chat → highlight (+ speech bubble for plain dialogue), like the CoC stage
 * ------------------------------------------------------------------------ */

export function setFace(actorId, key) {
  if (!actorId) return;
  if (!key || key === "기본") currentFace.delete(actorId);
  else currentFace.set(actorId, key);
  game.pf2eKrStage?.overlay?.scheduleRender();
}

function onChatMessage(message) {
  const face = message.getFlag?.(MODULE_ID, "face");
  if (face?.actor) setFace(face.actor, face.key);
  const overlay = game.pf2eKrStage?.overlay;
  if (!overlay || !overlay.visible() || !message.visible) return;

  let actorId = message.speaker?.actor ?? null;
  if (!actorId) actorId = message.author?.character?.id ?? null;
  const slotKey = actorId ? overlay.slotKeyForActor(actorId) : null;
  if (!slotKey) return;

  const seconds = Math.max(2, Number(setting("portraitBubbleSeconds", 7)) || 7);
  const text = setting("portraitChatBubbles", true) ? chatToSpeech(message) : "";
  overlay.highlightFromChat(slotKey, text ? seconds * 1000 : 3000, text);
}

class PortraitSlotsMenu extends foundry.applications.api.ApplicationV2 {
  render() {
    game.pf2eKrHud?.openPortraitManager?.();
    return this;
  }
}

/* ------------------------------------------------------------------------ */

export function registerPortraitSettings() {
  const rerender = () => game.pf2eKrStage?.overlay?.scheduleRender();
  const relayout = () => game.pf2eKrStage?.overlay?.layout();

  game.settings.registerMenu(MODULE_ID, "portraitSlotsMenu", {
    name: "초상화 관리", label: "초상화 관리 열기",
    hint: "PC 1~6 자리에 캐릭터를 지정합니다. 비워 두면 플레이어의 할당된 캐릭터가 자동으로 들어갑니다.",
    icon: "fa-solid fa-users", type: PortraitSlotsMenu, restricted: true
  });
  game.settings.register(MODULE_ID, "portraitSlots", { scope: "world", config: false, type: Object, default: {}, onChange: rerender });
  game.settings.register(MODULE_ID, "portraitLayout", { scope: "world", config: false, type: Object, default: {}, onChange: relayout });

  game.settings.register(MODULE_ID, "portraitsShown", {
    name: "파티 초상화 표시 (모두)", hint: "GM이 켜면 모든 참가자 화면에 파티 초상화가 뜹니다.",
    scope: "world", config: true, type: Boolean, default: true, onChange: rerender
  });
  game.settings.register(MODULE_ID, "portraitsHideLocal", {
    name: "내 화면에서만 초상화 숨기기", hint: "GM이 켜 두었더라도 이 컴퓨터에서는 숨깁니다.",
    scope: "client", config: true, type: Boolean, default: false, onChange: rerender
  });
  game.settings.register(MODULE_ID, "portraitStyleDefault", {
    name: "초상화 모양 (월드 기본값)",
    hint: "GM이 정하는 모두의 기본 모양입니다. 플레이어는 아래 '초상화 모양 (내 화면)'에서 따로 바꿀 수 있습니다.",
    scope: "world", config: true, type: String, default: "bare",
    choices: { bare: "이미지만 (배경 없음)", card: "카드 (반투명 판)" }, onChange: rerender
  });
  game.settings.register(MODULE_ID, "portraitStyle", {
    name: "초상화 모양 (내 화면)",
    hint: "'카드'는 반투명 판 위에 초상화를 올립니다. '이미지만'은 판과 테두리를 없애 캐릭터 그림만 보입니다. 권장 그림: 정사각형 512×512 px (최소 256×256, 화면이 4K면 768×768). 카드: 얼굴이 위쪽 1/3에 오게 — 위아래가 잘릴 수 있습니다. 이미지만: 배경이 투명한 PNG/WebP, 인물의 허리나 발끝이 아래 가장자리에 닿게. 세로로 긴 전신 그림(예: 400×800)은 작게 보이니 정사각형으로 여백을 맞춰 주세요.",
    scope: "client", config: true, type: String, default: "",
    choices: { "": "GM 기본값 따르기", bare: "이미지만 (배경 없음)", card: "카드 (반투명 판)" }, onChange: rerender
  });
  game.settings.register(MODULE_ID, "portraitIdleDim", {
    name: "대기 중 초상화 흐리게", hint: "말하거나 채팅하지 않는 동안 초상화를 회색으로 살짝 눌러 둡니다.",
    scope: "client", config: true, type: Boolean, default: true, onChange: rerender
  });
  game.settings.register(MODULE_ID, "portraitScale", {
    name: "초상화 크기", hint: "최대 크기입니다. 화면이 낮으면 겹치지 않도록 자동으로 줄어듭니다.",
    scope: "client", config: true, type: Number, default: 1, range: { min: 0.6, max: 1.6, step: 0.05 }, onChange: relayout
  });
  game.settings.register(MODULE_ID, "portraitBottomMargin", {
    name: "초상화 아래 여백 (px)", hint: "맨 아래 줄(PC 5·6)을 화면 아래에서 얼마나 띄울지 정합니다. 접속 프로그램이나 하단 UI에 가리면 늘리세요.",
    scope: "client", config: true, type: Number, default: 150, range: { min: 40, max: 400, step: 10 }, onChange: relayout
  });
  game.settings.register(MODULE_ID, "portraitImage", {
    name: "초상화 그림 출처", hint: "토큰 그림(다이나믹 토큰 링 포함)은 원형 틀 때문에 초상화에서 작아 보일 수 있습니다. 가능하면 액터 초상화에 정사각형 512×512 그림을 넣으세요.",
    scope: "world", config: true, type: String, default: "actor",
    choices: { actor: "액터 초상화 (actor.img)", token: "토큰 그림" }, onChange: rerender
  });
  game.settings.register(MODULE_ID, "portraitHpNumbers", {
    name: "초상화 HP 숫자", hint: "HP 막대는 항상 보입니다. 숫자를 누구에게 보여줄지 정합니다.",
    scope: "world", config: true, type: String, default: "owner",
    choices: { owner: "소유자와 GM만", all: "모두", none: "아무에게도 안 보임" }, onChange: rerender
  });
  game.settings.register(MODULE_ID, "portraitChatBubbles", {
    name: "채팅 말풍선", hint: "캐릭터가 채팅하면 초상화를 밝히고 옆에 말풍선을 띄웁니다. (굴림·카드는 말풍선 없이 잠깐 밝히기만)",
    scope: "world", config: true, type: Boolean, default: true
  });
  game.settings.register(MODULE_ID, "portraitBubbleSeconds", {
    name: "말풍선 표시 시간 (초)", scope: "world", config: true, type: Number, default: 7, range: { min: 2, max: 20, step: 1 }
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
  Hooks.on("canvasReady", rerender);
  Hooks.on("updateActor", actor => { if (overlay.slotKeyForActor(actor.id)) rerender(); });
  Hooks.on("updateUser", rerender);
  Hooks.on("collapseSidebar", () => setTimeout(() => overlay.layout(), 250));
  Hooks.on("rtcUserSpeaking", (userId, speaking) => setSpeaking(userId, speaking));
  Hooks.on("createChatMessage", onChatMessage);
}
