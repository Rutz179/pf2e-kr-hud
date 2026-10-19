import { MODULE_ID } from "./shared.mjs";

/* ======================================================================== *
 * Settings, tidied
 *
 * Foundry's module settings list keeps only a few size settings and one
 * button per topic. Each button opens this window at its topic; the left-hand
 * tabs switch between topics without closing it. Fields are built from the
 * settings' own registration (name, hint, type, choices, range), so a setting
 * added later only needs its key listed in TABS.
 *
 * Players see the topics and the client settings they can change; world
 * settings are the GM's and stay out of their way. Anything registered with
 * `config: true` that no tab lists ends up under "기타", so nothing is lost.
 * ======================================================================== */

/** Stays in Foundry's own list: the size settings people reach for first. */
export const BASIC = ["hudScale", "portraitScale", "turnTrackerWidth", "chatFontSize", "chatSidebarWidth"];

export const TABS = [
  {
    id: "portraits", label: "파티 초상화", icon: "fa-solid fa-users",
    menus: [{ key: "portraitSlotsMenu", label: "PC 자리 지정 (초상화 관리)", icon: "fa-solid fa-users-gear" }],
    sections: [
      { title: "표시", keys: ["portraitsShown", "portraitsHideLocal", "portraitStyleDefault", "portraitStyle", "portraitIdleDim", "portraitImage"] },
      { title: "크기·위치", keys: ["portraitScale", "portraitBottomMargin"] },
      { title: "HP·말풍선", keys: ["portraitHpNumbers", "portraitChatBubbles", "portraitBubbleSeconds"] },
      { title: "접속자 목록", keys: ["playersListMode"] }
    ]
  },
  {
    id: "hud", label: "캐릭터 HUD", icon: "fa-solid fa-table-cells",
    sections: [
      { title: "표시", keys: ["hudEnabled", "hudScale", "hudRows", "hudEffectSize", "hudEffectDurations", "hudReactionPip"] },
      { title: "퀵슬롯 설명 카드", keys: ["hudSlotCard", "hudSlotCardDelay"] },
      { title: "동작", keys: ["hudSaveCard", "hudAutoInfused", "hudNpcAutoFill"] },
      { title: "Foundry·PF2e 기본 UI", keys: ["hudHideCoreHotbar", "hudHideEffectsPanel"] },
      { title: "반응(리액션) 알림", keys: ["reactionChecker", "reactionCombatOnly", "reactionPopup", "reactionPopupGM"] },
      { title: "지속 주문", keys: ["sustainChecker"] },
      { title: "피해 적용 (PF2e Toolbelt)", keys: ["bulkDamage"] }
    ]
  },
  {
    id: "turns", label: "턴 트래커", icon: "fa-solid fa-list-ol",
    sections: [
      { title: "표시", keys: ["turnTracker", "turnTrackerWidth", "turnTrackerAspect", "turnTrackerTop"] },
      { title: "전투원", keys: ["turnTrackerGroup", "turnTrackerDefeated"] }
    ]
  },
  {
    id: "chat", label: "채팅창", icon: "fa-solid fa-comments",
    sections: [
      { title: "시계·주사위", keys: ["chatDock", "clock12h"] },
      { title: "글꼴·크기", keys: ["chatBodyFont", "chatFontSize", "chatSidebarWidth", "chatHideEditorMenu", "chatFaceZoom"] },
      { title: "메시지", keys: ["chatGrouping", "chatGroupWindow", "whisperPolicy"] },
      { title: "긴 세션 (렉 줄이기)", keys: ["chatTrim", "chatTrimKeep", "chatJumpButton"] },
      { title: "입력 중 표시", keys: ["typingIndicator", "typingShowKeeper", "typingReserveHeight", "typingSelector"] }
    ]
  },
  {
    id: "tokens", label: "토큰 툴팁", icon: "fa-solid fa-heart-pulse",
    sections: [
      { title: "거리", keys: ["tokenTipDistance"] },
      { title: "체력 상태", keys: ["healthOnHover", "healthFullShow", "healthShowGM", "healthFull", "healthLevels", "healthZero"] }
    ]
  },
  {
    id: "gm", label: "GM 도구", icon: "fa-solid fa-hat-wizard", gm: true,
    sections: [
      { title: "시간·조명", keys: ["timeDarknessSync", "timeDarknessMax"] },
      { title: "GM 팔레트", keys: ["paletteSize", "paletteOpacity"] },
      { title: "컴펜디움 브라우저", keys: ["browserHideLegacy"] }
    ]
  },
  {
    id: "voice", label: "디스코드 음성", icon: "fa-brands fa-discord", gm: true,
    menus: [
      { key: "voiceSetupMenu", label: "설정 도우미 열기", icon: "fa-solid fa-wand-magic-sparkles" },
      { key: "voiceBridgeMenu", label: "디스코드 ↔ Foundry 사용자 연결", icon: "fa-brands fa-discord" }
    ],
    sections: [{ title: "연동", keys: ["voiceBridgeEnabled", "voiceBridgeUrl"] }]
  }
];

const OTHER_TAB = { id: "other", label: "기타", icon: "fa-solid fa-ellipsis", sections: [{ title: "기타", keys: [] }] };

/** Menus that now open from inside the window instead of the main list. */
const capturedMenus = new Map();

const esc = value => foundry.utils.escapeHTML(String(value ?? ""));
const config = key => game.settings.settings.get(`${MODULE_ID}.${key}`);

function visibleTabs() {
  const tabs = [...TABS];
  if (OTHER_TAB.sections[0].keys.length) tabs.push(OTHER_TAB);
  return tabs.filter(tab => !tab.gm || game.user.isGM);
}

function editable(cfg) {
  return cfg && (cfg.scope !== "world" || game.user.isGM);
}

/** "턴 트래커: 초상화 너비" under the 턴 트래커 tab reads better as "초상화 너비". */
function shortName(name, context) {
  const i = name.indexOf(": ");
  if (i < 0) return name;
  const prefix = name.slice(0, i);
  return context.some(c => c && (c.includes(prefix) || prefix.includes(c))) ? name.slice(i + 2) : name;
}

function fieldHtml(key, context = []) {
  const cfg = config(key);
  if (!editable(cfg)) return "";
  const value = game.settings.get(MODULE_ID, key);
  const name = esc(shortName(String(cfg.name ?? key), context));
  const hint = cfg.hint ? `<p class="hint">${esc(cfg.hint)}</p>` : "";
  const world = cfg.scope === "world" ? `<span class="scope" data-tooltip="월드 설정 — 모두에게 적용">월드</span>` : "";
  let input;
  if (cfg.type === Boolean) {
    return `<div class="pkh-set-field check"><label><input type="checkbox" data-key="${key}" ${value ? "checked" : ""}><span>${name}</span>${world}</label>${hint}</div>`;
  }
  if (cfg.choices) {
    const options = Object.entries(cfg.choices).map(([k, label]) =>
      `<option value="${esc(k)}" ${String(value) === String(k) ? "selected" : ""}>${esc(game.i18n.localize(String(label)))}</option>`).join("");
    input = `<select data-key="${key}">${options}</select>`;
  } else if (cfg.type === Number && cfg.range) {
    const { min, max, step } = cfg.range;
    input = `<div class="range"><input type="range" data-key="${key}" min="${min}" max="${max}" step="${step ?? 1}" value="${value}"><output>${value}</output></div>`;
  } else if (cfg.type === Number) {
    input = `<input type="number" data-key="${key}" value="${value}">`;
  } else if (cfg.filePicker) {
    input = `<div class="pick"><input type="text" data-key="${key}" value="${esc(value)}"><button type="button" data-pick="${key}" data-type="${esc(cfg.filePicker)}"><i class="fa-solid fa-file-import"></i></button></div>`;
  } else {
    input = `<input type="text" data-key="${key}" value="${esc(value)}">`;
  }
  return `<div class="pkh-set-field"><label><span>${name}</span>${world}</label>${input}${hint}</div>`;
}

export class PkhSettingsWindow extends foundry.applications.api.ApplicationV2 {
  static DEFAULT_OPTIONS = {
    id: "pkh-settings",
    classes: ["pkh-window", "pkh-settings"],
    window: { title: "Rutz's PF2e HUD 설정", icon: "fa-solid fa-sliders", resizable: true },
    position: { width: 760, height: 640 }
  };

  /** Subclasses (one per menu button) only change the tab it opens at. */
  static TAB = "portraits";

  constructor(options = {}) {
    super(options);
    this.tab = this.constructor.TAB;
    this.changed = new Map();
  }

  /** One window: a second menu button just switches the open one to its topic. */
  render(...args) {
    const open = PkhSettingsWindow.current;
    if (open && open !== this && open.rendered) {
      open.tab = this.tab;
      open.render();
      open.bringToFront?.();
      return open;
    }
    PkhSettingsWindow.current = this;
    return super.render(...args);
  }

  _onClose(options) {
    super._onClose?.(options);
    if (PkhSettingsWindow.current === this) PkhSettingsWindow.current = null;
  }

  async _renderHTML() {
    const tabs = visibleTabs();
    if (!tabs.some(t => t.id === this.tab)) this.tab = tabs[0]?.id;
    const tab = tabs.find(t => t.id === this.tab);
    const nav = tabs.map(t => `<button type="button" class="${t.id === this.tab ? "active" : ""}" data-tab="${t.id}"><i class="${t.icon}"></i><span>${esc(t.label)}</span></button>`).join("");
    const menus = (tab?.menus ?? []).filter(m => capturedMenus.has(m.key) && (!capturedMenus.get(m.key).restricted || game.user.isGM))
      .map(m => `<button type="button" class="menu" data-menu="${m.key}"><i class="${m.icon}"></i> ${esc(m.label)}</button>`).join("");
    const sections = (tab?.sections ?? []).map(sec => {
      const fields = sec.keys.map(key => fieldHtml(key, [tab.label, sec.title])).join("");
      return fields ? `<section class="pkh-set-section"><h3>${esc(sec.title)}</h3>${fields}</section>` : "";
    }).join("");
    return `
      <div class="pkh-set">
        <nav class="pkh-set-tabs">${nav}</nav>
        <div class="pkh-set-body">
          ${menus ? `<div class="pkh-set-menus">${menus}</div>` : ""}
          ${sections || `<p class="hint">이 항목에서 바꿀 수 있는 설정이 없습니다.</p>`}
        </div>
      </div>
      <footer class="pkh-set-footer">
        <button type="button" data-act="defaults"><i class="fa-solid fa-rotate-left"></i> 이 항목 기본값으로</button>
        <span class="grow"></span>
        <button type="button" data-act="close">닫기</button>
        <button type="button" data-act="save" class="primary"><i class="fa-solid fa-floppy-disk"></i> 저장</button>
      </footer>`;
  }

  _replaceHTML(result, content) {
    content.innerHTML = result;
  }

  _onFirstRender(context, options) {
    super._onFirstRender?.(context, options);
    const root = this.element.querySelector(".window-content") ?? this.element;
    root.addEventListener("input", ev => this._onField(ev));
    root.addEventListener("change", ev => this._onField(ev));
    root.addEventListener("click", ev => this._onClick(ev));
  }

  _onRender(context, options) {
    super._onRender?.(context, options);
    // Keep unsaved edits when switching tabs.
    const root = this.element.querySelector(".window-content") ?? this.element;
    for (const [key, value] of this.changed) {
      const el = root.querySelector(`[data-key="${key}"]`);
      if (!el) continue;
      if (el.type === "checkbox") el.checked = !!value;
      else el.value = value;
      const out = el.parentElement?.querySelector("output");
      if (out) out.textContent = value;
    }
  }

  _readField(el) {
    const cfg = config(el.dataset.key);
    if (el.type === "checkbox") return el.checked;
    if (cfg?.type === Number) return Number(el.value);
    return el.value;
  }

  _onField(ev) {
    const el = ev.target.closest("[data-key]");
    if (!el) return;
    this.changed.set(el.dataset.key, this._readField(el));
    const out = el.parentElement?.querySelector("output");
    if (out) out.textContent = el.value;
  }

  async _onClick(ev) {
    const tab = ev.target.closest("[data-tab]")?.dataset.tab;
    if (tab) {
      this.tab = tab;
      return this.render();
    }
    const menu = ev.target.closest("[data-menu]")?.dataset.menu;
    if (menu) {
      const entry = capturedMenus.get(menu);
      if (entry?.type) new entry.type().render(true);
      return;
    }
    const pick = ev.target.closest("[data-pick]");
    if (pick) {
      const input = pick.parentElement.querySelector("input");
      const FP = foundry.applications?.apps?.FilePicker?.implementation ?? globalThis.FilePicker;
      return new FP({ type: pick.dataset.type || "any", current: input.value, callback: path => {
        input.value = path;
        input.dispatchEvent(new Event("change", { bubbles: true }));
      } }).render(true);
    }
    const act = ev.target.closest("[data-act]")?.dataset.act;
    if (act === "close") return this.close();
    if (act === "defaults") return this._defaults();
    if (act === "save") return this._save();
  }

  _defaults() {
    const tab = visibleTabs().find(t => t.id === this.tab);
    for (const key of (tab?.sections ?? []).flatMap(s => s.keys)) {
      const cfg = config(key);
      if (editable(cfg)) this.changed.set(key, cfg.default);
    }
    this.render();
  }

  async _save() {
    let reload = false;
    let world = false;
    for (const [key, value] of this.changed) {
      const cfg = config(key);
      if (!editable(cfg)) continue;
      if (game.settings.get(MODULE_ID, key) === value) continue;
      await game.settings.set(MODULE_ID, key, value);
      if (cfg.requiresReload) { reload = true; world ||= cfg.scope === "world"; }
    }
    this.changed.clear();
    ui.notifications.info("설정을 저장했습니다.");
    this.close();
    const SC = foundry.applications?.settings?.SettingsConfig ?? globalThis.SettingsConfig;
    if (reload && typeof SC?.reloadConfirm === "function") SC.reloadConfirm({ world });
  }
}

/**
 * Call once every setting is registered (the "setup" hook): hide the grouped
 * settings from Foundry's list, add one button per topic, and move the old
 * stand-alone menus into their topics.
 */
export function registerSettingsWindows() {
  const listed = new Set(TABS.flatMap(t => t.sections.flatMap(s => s.keys)));
  for (const [id, cfg] of game.settings.settings) {
    if (!id.startsWith(`${MODULE_ID}.`) || cfg.config === false) continue;
    const key = id.slice(MODULE_ID.length + 1);
    if (BASIC.includes(key)) continue;
    if (!listed.has(key)) OTHER_TAB.sections[0].keys.push(key);
    cfg.config = false;
  }

  for (const tab of TABS) {
    for (const m of tab.menus ?? []) {
      const id = `${MODULE_ID}.${m.key}`;
      const entry = game.settings.menus.get(id);
      if (!entry) continue;
      capturedMenus.set(m.key, entry);
      game.settings.menus.delete(id);
    }
  }

  const all = OTHER_TAB.sections[0].keys.length ? [...TABS, OTHER_TAB] : TABS;
  for (const tab of all) {
    const Opener = class extends PkhSettingsWindow { static TAB = tab.id; };
    game.settings.registerMenu(MODULE_ID, `settings-${tab.id}`, {
      name: `${tab.label} 설정`,
      label: `${tab.label} 상세 설정`,
      icon: tab.icon,
      type: Opener,
      restricted: !!tab.gm
    });
  }
}

/** For macros: game.pf2eKrHud.settings("turns") */
export function openSettings(tab = "portraits") {
  const app = new PkhSettingsWindow();
  app.tab = tab;
  return app.render(true);
}
PkhSettingsWindow.current = null;
