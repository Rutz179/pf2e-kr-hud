export const MODULE_ID = "pf2e-kr-hud";

/** Ten slots per row; four pages; up to three rows visible at once (BG3-style). */
export const SLOTS_PER_ROW = 10;
export const PAGE_COUNT = 4;
export const MAX_ROWS = 3;
export const TOTAL_ROWS = PAGE_COUNT * MAX_ROWS; // 12 stored rows = 120 slots

export function setting(key, fallback = null) {
  try {
    return game.settings.get(MODULE_ID, key);
  } catch (_) {
    return fallback;
  }
}

export function esc(value) {
  return foundry.utils.escapeHTML(String(value ?? ""));
}

export function localizeMaybe(value) {
  if (!value) return "";
  const text = String(value);
  return game.i18n.has?.(text) ? game.i18n.localize(text) : text;
}

/** "Amiri (Level 7)" → "Amiri": the level is noise on the HUD and portraits. */
export function displayName(name) {
  return String(name ?? "").replace(/\s*[(（]\s*(?:level|lv\.?|레벨)\s*\d+\s*[)）]\s*$/i, "").trim() || String(name ?? "");
}

export function signed(n) {
  const v = Number(n) || 0;
  return v >= 0 ? `+${v}` : String(v);
}

/**
 * The Foundry canvas area actually visible to the user: the #board minus the
 * right-hand sidebar when it overlaps. Same approach as the CoC7 toolkit stage.
 */
export function boardViewportRect() {
  const board = document.getElementById("board");
  const base = board?.getBoundingClientRect?.();
  const left = Math.max(0, base?.left ?? 0);
  const top = Math.max(0, base?.top ?? 0);
  let right = Math.min(window.innerWidth, base?.right ?? window.innerWidth);
  const bottom = Math.min(window.innerHeight, base?.bottom ?? window.innerHeight);

  const sidebar = document.getElementById("sidebar");
  if (sidebar && sidebar.offsetParent !== null) {
    const side = sidebar.getBoundingClientRect();
    if (side.left > left && side.left < right && side.bottom > top && side.top < bottom) {
      right = Math.min(right, side.left - 6);
    }
  }
  return { left, top, right, bottom, width: Math.max(0, right - left), height: Math.max(0, bottom - top) };
}

/** Width taken by Foundry's left-hand control columns (v13/v14 and older ids). */
export function leftChromeWidth(rect) {
  const selectors = ["#scene-controls", "#controls", "#scene-controls-layers", "#scene-controls-tools", "#ui-left-column-1", "#players"];
  let rightmost = 0;
  for (const selector of selectors) {
    const el = document.querySelector(selector);
    if (!el || el.offsetParent === null) continue;
    const box = el.getBoundingClientRect();
    if (!box.width || box.right <= rect.left) continue;
    rightmost = Math.max(rightmost, box.right - rect.left);
  }
  return rightmost;
}

/** Short plain-text summary of a PF2e item description (for hover cards). */
export function summaryOf(item, limit = 260) {
  let raw = String(item?.system?.description?.value ?? "");
  raw = raw
    .replace(/@\w+\[[^\]]*\]\{([^}]*)\}/g, "$1")                         // @UUID[..]{Label}
    .replace(/@\w+\[([^\]|]*)[^\]]*\]/g, (_, a) => a.split(".").pop())    // @UUID[..Name]
    .replace(/\[\[[^\]]*\]\](?:\{([^}]*)\})?/g, (_, label) => label ?? ""); // [[/r ..]]{..}
  const div = document.createElement("div");
  div.innerHTML = raw;
  const text = (div.textContent ?? "").replace(/\s+/g, " ").trim();
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

/** Parse Foundry-style drag data from a drop event. */
export function readDragData(event) {
  try {
    const raw = event.dataTransfer?.getData("text/plain");
    return raw ? JSON.parse(raw) : null;
  } catch (_) {
    return null;
  }
}

/**
 * Minimal ApplicationV2 window with hand-written HTML. Used for the small
 * pickers and config dialogs so we don't depend on Handlebars templates.
 */
export class SimpleWindow extends foundry.applications.api.ApplicationV2 {
  constructor({ id, title, width = 420, html, onRender } = {}) {
    super({
      id: id ?? `${MODULE_ID}-${foundry.utils.randomID()}`,
      window: { title, resizable: true },
      position: { width, height: "auto" },
      classes: ["pkh-window"]
    });
    this._html = html;
    this._onRenderCb = onRender;
  }

  async _renderHTML() {
    return typeof this._html === "function" ? this._html() : this._html;
  }

  _replaceHTML(result, content) {
    content.innerHTML = result;
  }

  _onRender(context, options) {
    super._onRender?.(context, options);
    this._onRenderCb?.(this.element.querySelector(".window-content") ?? this.element, this);
  }
}
