import { MODULE_ID, TABLE_EDITION, t } from "./shared.mjs";
import { hiddenSettings } from "./systems.mjs";

/*
 * Settings window
 * Foundry's module settings list keeps a few size settings and ONE button, which opens this window; the left-hand tabs switch topics. Fields are built from the settings' own registration (name, hint, type, choices, range), so a new setting only needs its key listed in TABS.
 * Other menus of this module are taken out of Foundry's list and shown as buttons in their tab (GM-only stay GM-only); a menu or `config: true` setting no tab lists lands under "기타".
 * Players see only the topics and client settings they can change.
 */

/** Stays in Foundry's own list: the size settings people reach for first. */
export const BASIC = ["hudScale", "portraitScale", "turnTrackerWidth", "chatFontSize", "chatSidebarWidth"];

export const TABS = [
  {
    id: "portraits", label: "SettingsWindow.Tabs.Portraits", icon: "fa-solid fa-users",
    menus: [{ key: "portraitSlotsMenu", label: "SettingsWindow.Menus.PortraitSlots", icon: "fa-solid fa-users-gear" }],
    sections: [
      { title: "SettingsWindow.Sections.Display", keys: ["portraitsShown", "portraitsHideLocal", "portraitIdleDim", "portraitImage"] },
      { title: "SettingsWindow.Sections.SizePosition", keys: ["portraitScale", "portraitBottomMargin"] },
      { title: "SettingsWindow.Sections.HpBubbles", keys: ["portraitHpNumbers", "portraitChatBubbles", "portraitBubbleSeconds"] },
      { title: "SettingsWindow.Sections.PlayersList", keys: ["playersListMode"] }
    ]
  },
  {
    id: "hud", label: "SettingsWindow.Tabs.Hud", icon: "fa-solid fa-table-cells",
    sections: [
      { title: "SettingsWindow.Sections.Display", keys: ["hudEnabled", "hudScale", "hudRows", "hudEffectSize", "hudEffectsWidth", "hudEffectDurations", "hudReactionPip"] },
      { title: "SettingsWindow.Sections.SlotCard", keys: ["hudSlotCard", "hudSlotCardDelay"] },
      { title: "SettingsWindow.Sections.Behaviour", keys: ["hudSaveCard", "hudAutoInfused", "hudNpcAutoFill"] },
      { title: "SettingsWindow.Sections.CoreUi", keys: ["hudHideCoreHotbar", "hudHideEffectsPanel", ...(TABLE_EDITION ? [] : ["windowMinButton"])] },
      { title: "SettingsWindow.Sections.Reactions", keys: ["reactionChecker", "reactionCombatOnly", "reactionGmCopy", "reactionPopup", "reactionPopupGM", "reactionPreAsk", "contingencyPrompt"] },
      { title: "SettingsWindow.Sections.Sustain", keys: ["sustainChecker"] },
      { title: "SettingsWindow.Sections.BulkDamage", keys: ["bulkDamage"] },
      { title: "SettingsWindow.Sections.Cover", keys: ["coverRounds", "coverEndOnMove", "coverEndOnAttack"] },
      { title: "SettingsWindow.Sections.Elevation", keys: ["elevRangedStep", "elevRangedMax", "elevRangedUp"] }
    ],
    menus: [{ key: "reactionConfigMenu", label: "SettingsWindow.Menus.ReactionConfig", icon: "fa-solid fa-reply" }]
  },
  {
    id: "turns", label: "SettingsWindow.Tabs.Turns", icon: "fa-solid fa-list-ol",
    sections: [
      { title: "SettingsWindow.Sections.Display", keys: ["turnTracker", "turnMarker", "turnTrackerWidth", "turnTrackerAspect", "turnTrackerTop"] },
      { title: "SettingsWindow.Sections.Combatants", keys: ["turnTrackerGroup", "turnTrackerDefeated", "turnSkipDead"] },
      { title: "SettingsWindow.Sections.Xp", keys: ["xpTracker"] }
    ]
  },
  {
    id: "chat", label: "SettingsWindow.Tabs.Chat", icon: "fa-solid fa-comments",
    sections: [
      { title: "SettingsWindow.Sections.ClockDice", keys: ["chatDock", "clockCalendar", "clock12h"] },
      { title: "SettingsWindow.Sections.FontSize", keys: ["chatBodyFont", "chatFontSize", "chatSidebarWidth", "chatHideEditorMenu", "chatFaceZoom"] },
      { title: "SettingsWindow.Sections.Messages", keys: ["chatGrouping", "chatGroupWindow", "chatEdit", "whisperPolicy", "notesJournal", ...(TABLE_EDITION ? ["windowMinButton"] : [])] },
      { title: "SettingsWindow.Sections.LongSessions", keys: ["chatTrim", "chatTrimKeep", "chatJumpButton"] },
      { title: "SettingsWindow.Sections.Typing", keys: ["typingIndicator", "typingShowKeeper", "typingReserveHeight", "typingSelector"] }
    ],
    menus: [
      { key: "polyglotLangMenu", label: "SettingsWindow.Menus.PolyglotLangs", icon: "fa-solid fa-language" }
    ]
  },
  {
    id: "tokens", label: "SettingsWindow.Tabs.Tokens", icon: "fa-solid fa-heart-pulse",
    sections: [
      { title: "SettingsWindow.Sections.Distance", keys: ["tokenTipDistance"] },
      { title: "SettingsWindow.Sections.Health", keys: ["healthOnHover", "healthFullShow", "healthShowGM", "healthFull", "healthLevels", "healthZero"] }
    ]
  },
  {
    id: "gm", label: "SettingsWindow.Tabs.Gm", icon: "fa-solid fa-hat-wizard", gm: true,
    sections: [
      { title: "SettingsWindow.Sections.TimeLight", keys: ["timeDarknessSync", "timeDarknessMax"] },
      { title: "SettingsWindow.Sections.Palette", keys: ["paletteSize", "paletteOpacity"] },
      { title: "SettingsWindow.Sections.Browser", keys: ["browserHideLegacy"] }
    ]
  },
  {
    id: "voice", label: "SettingsWindow.Tabs.Voice", icon: "fa-brands fa-discord", gm: true,
    menus: [
      { key: "voiceSetupMenu", label: "SettingsWindow.Menus.VoiceSetup", icon: "fa-solid fa-wand-magic-sparkles" },
      { key: "voiceBridgeMenu", label: "SettingsWindow.Menus.VoiceBridge", icon: "fa-brands fa-discord" }
    ],
    sections: [{ title: "SettingsWindow.Sections.Link", keys: ["voiceBridgeEnabled", "voiceBridgeUrl"] }]
  }
];

// Diagnostics: for everyone (each computer has its own report); the GM also sees the players'.
TABS.push({
  id: "diag", label: "SettingsWindow.Tabs.Diag", icon: "fa-solid fa-stethoscope",
  menus: [{ key: "diagMenu", label: "SettingsWindow.Menus.Diag", icon: "fa-solid fa-stethoscope" }],
  sections: [{ title: "SettingsWindow.Sections.Diag", keys: ["diagWatch", "diagGuard", "chatRescue"] }]
});

const OTHER_TAB = { id: "other", label: "SettingsWindow.Tabs.Other", icon: "fa-solid fa-ellipsis", sections: [{ title: "SettingsWindow.Sections.Other", keys: [] }], menus: [] };

/** The one button left in Foundry's settings list. */
export const MENU_KEY = "settings";

/** Menus that open from inside the window instead of the main list. */
const capturedMenus = new Map();

const esc = value => foundry.utils.escapeHTML(String(value ?? ""));
// Settings of a feature that is off in this game system (systems.mjs FEATURE_SETTINGS) are left out.
let hiddenKeys = null;
const hidden = key => (hiddenKeys ??= hiddenSettings()).has(key);
const config = key => (hidden(key) ? undefined : game.settings.settings.get(`${MODULE_ID}.${key}`));

/** Tab labels, section titles and menu labels are lang keys (under PKH), read when drawn. */
const label = key => t(key);

/** A tab with nothing registered (the Discord Table has no HUD or turn settings) stays out. */
const hasContent = tab => (tab.sections ?? []).some(s => s.keys.some(k => config(k)))
  || (tab.menus ?? []).some(m => capturedMenus.has(m.key) || game.settings.menus.has(`${MODULE_ID}.${m.key}`));

function visibleTabs() {
  const tabs = [...TABS];
  if (OTHER_TAB.sections[0].keys.length || OTHER_TAB.menus.length) tabs.push(OTHER_TAB);
  return tabs.filter(tab => (!tab.gm || game.user.isGM) && hasContent(tab));
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
  // The three health texts are never typed boxes while the editor is drawn: it holds them as hidden fields.
  if (HEALTH_KEYS.includes(key) && healthEditorShown()) return key === "healthLevels" ? healthEditorHtml(cfg) : "";
  const value = game.settings.get(MODULE_ID, key);
  const name = esc(shortName(game.i18n.localize(String(cfg.name ?? key)), context));
  const hint = cfg.hint ? `<p class="hint">${esc(game.i18n.localize(String(cfg.hint)))}</p>` : "";
  const world = cfg.scope === "world" ? `<span class="scope" data-tooltip="${esc(t("SettingsWindow.WorldTip"))}">${esc(t("SettingsWindow.World"))}</span>` : "";
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

/*
 * Health levels: a bar instead of the typed "75:가벼운 부상|50:부상|..."
 * healthFull, healthLevels ("pct:name|...", high to low) and healthZero stay plain strings, read by gm-tools.mjs healthLevels(). The editor writes them into three hidden fields with data-key, so the window's Save / defaults / tab-switch handling covers them like any field.
 * While the stored default (Korean) is kept, each user sees the labels in their own language (gm-tools.mjs healthText); the editor writes the stored default back, not the translated text, while its content equals the translated default.
 * A band covers its % up to the one above it; the lowest also covers everything down to 0.
 */

const HEALTH_KEYS = ["healthFull", "healthLevels", "healthZero"];
const HEALTH_LANG = { healthFull: "Health.Full", healthLevels: "Health.DefaultLevels", healthZero: "Health.Zero" };

/** "|" and ":" would break the stored format. */
export const cleanHealthName = value => String(value ?? "").replace(/[|:]/g, "");

/** Whole numbers 1–99, high to low, each used once. Bands that cannot fit are dropped. */
export function normalizeBands(bands) {
  const sorted = (bands ?? []).map(b => ({ pct: Math.min(99, Math.max(1, Math.round(Number(b.pct)))), name: String(b.name ?? "") }))
    .filter(b => Number.isFinite(b.pct)).sort((a, b) => b.pct - a.pct);
  const out = [];
  for (const b of sorted) {
    const pct = Math.min(b.pct, (out.at(-1)?.pct ?? 100) - 1);
    if (pct >= 1) out.push({ ...b, pct });
  }
  return out;
}

/** "75:가벼운 부상|50:부상" → [{ pct: 75, name: "가벼운 부상" }, …], read the way healthLevels() reads it. */
export function parseBands(text) {
  return normalizeBands(String(text ?? "").split("|").map(p => p.split(":"))
    .map(([pct, name]) => ({ pct: Number(pct), name: cleanHealthName(name).trim() }))
    .filter(b => Number.isFinite(b.pct) && b.name));
}

/** Back to the stored format. A band without a name is left out (healthLevels() would skip it too). */
export function serializeBands(bands) {
  return normalizeBands(bands).map(b => ({ ...b, name: cleanHealthName(b.name).trim() })).filter(b => b.name)
    .map(b => `${b.pct}:${b.name}`).join("|");
}

/** What the editor shows for a stored value: the user's language while the stored default is kept. */
export function healthShown(value, storedDefault, translated) {
  const text = String(value ?? "");
  return !text || text === storedDefault ? translated : text;
}

/** What to store: the stored default while the text still equals the translated default. */
export function healthStored(key, text, storedDefault, translated) {
  const same = key === "healthLevels"
    ? serializeBands(parseBands(text)) === serializeBands(parseBands(translated))
    : String(text).trim() === String(translated).trim();
  return same ? storedDefault : text;
}

/** A divider dragged to `pct`: a whole number, never onto or past a neighbour. */
export function clampDrag(bands, index, pct) {
  const hi = Math.min(99, (bands[index - 1]?.pct ?? 100) - 1);
  const lo = Math.max(1, (bands[index + 1]?.pct ?? 0) + 1);
  const n = Math.round(Number(pct));
  return Math.min(hi, Math.max(lo, Number.isFinite(n) ? n : bands[index].pct));
}

/** A % typed into a row: 1–99; if another band has it, the nearest free number. Returns the new list and the band's place in it. */
export function setBandPct(bands, index, value) {
  let want = Math.min(99, Math.max(1, Math.round(Number(value))));
  if (!Number.isFinite(want)) want = bands[index].pct;
  const taken = new Set(bands.filter((_, i) => i !== index).map(b => b.pct));
  let pct = want;
  for (let d = 1; taken.has(pct) && d < 99; d++) {
    if (want + d <= 99 && !taken.has(want + d)) { pct = want + d; break; }
    if (want - d >= 1 && !taken.has(want - d)) { pct = want - d; break; }
  }
  if (taken.has(pct)) pct = bands[index].pct;
  const moved = { ...bands[index], pct };
  const next = bands.map((b, i) => (i === index ? moved : b)).sort((a, b) => b.pct - a.pct);
  return { bands: next, index: next.indexOf(moved) };
}

/** A new band in the middle of the widest gap (100 … bands … 0); null when no whole number is free. */
export function addBand(bands, name) {
  const edges = [100, ...bands.map(b => b.pct), 0];
  let best = null;
  for (let i = 0; i < edges.length - 1; i++) {
    const pct = Math.min(99, Math.max(1, Math.round((edges[i] + edges[i + 1]) / 2)));
    if (pct >= edges[i] || pct <= edges[i + 1]) continue;
    const width = edges[i] - edges[i + 1];
    if (!best || width > best.width) best = { width, pct };
  }
  if (!best) return null;
  const band = { pct: best.pct, name };
  const next = [...bands, band].sort((a, b) => b.pct - a.pct);
  return { bands: next, index: next.indexOf(band) };
}

/** At least one band stays. */
export function removeBand(bands, index) {
  return bands.length > 1 ? bands.filter((_, i) => i !== index) : bands;
}

/** The bar: each band from the one above it (or 100%) down to its own % (the lowest one to 0), 100% on the left. */
export function bandSegments(bands) {
  return bands.map((b, i) => {
    const top = i ? bands[i - 1].pct : 100;
    const floor = i === bands.length - 1 ? 0 : b.pct;
    // hue as healthColour() in gm-tools.mjs: from the middle of the band (its own % as floor)
    const hue = Math.round(Math.min(100, Math.max(0, (top + b.pct) / 2)) * 1.2);
    return { index: i, name: b.name, pct: b.pct, left: 100 - top, width: top - floor, hue };
  });
}

/** The editor replaces the levels box whenever this user may change the levels; the 100% / 0% rows come with their own settings. */
const healthEditorShown = () => editable(config("healthLevels"));
const healthKeysHere = () => HEALTH_KEYS.filter(k => editable(config(k)));

function healthEditorHtml(cfg) {
  const hidden = healthKeysHere().map(k => `<input type="hidden" data-key="${k}" value="${esc(game.settings.get(MODULE_ID, k))}">`).join("");
  const world = `<span class="scope" data-tooltip="${esc(t("SettingsWindow.WorldTip"))}">${esc(t("SettingsWindow.World"))}</span>`;
  const hint = cfg.hint ? `<p class="hint">${esc(game.i18n.localize(String(cfg.hint)))}</p>` : "";
  return `<div class="pkh-set-field pkh-hl">
    <label><span>${esc(game.i18n.localize(String(cfg.name)))}</span>${world}</label>${hidden}
    <div class="pkh-hl-bar"></div>
    <div class="pkh-hl-scale"></div>
    <div class="pkh-hl-rows"></div>
    <div class="pkh-hl-actions">
      <button type="button" data-hl="add"><i class="fa-solid fa-plus"></i> ${esc(t("SettingsWindow.HealthEditor.Add"))}</button>
      <button type="button" data-hl="reset"><i class="fa-solid fa-rotate-left"></i> ${esc(t("SettingsWindow.HealthEditor.Reset"))}</button>
    </div>${hint}
  </div>`;
}

/** Wires the editor drawn by healthEditorHtml (if this tab has it). */
function mountHealthEditor(root) {
  const box = root?.querySelector?.(".pkh-hl");
  if (!box) return;
  const field = key => box.querySelector(`input[data-key="${key}"]`);
  const translated = key => t(HEALTH_LANG[key]);
  const shown = key => (field(key) ? healthShown(field(key).value, config(key)?.default, translated(key)) : "");
  const defaults = () => ({ full: translated("healthFull"), zero: translated("healthZero"), bands: parseBands(translated("healthLevels")) });
  const state = { full: shown("healthFull"), zero: shown("healthZero"), bands: parseBands(shown("healthLevels")) };
  if (!state.bands.length) state.bands = defaults().bands;
  const bar = box.querySelector(".pkh-hl-bar");
  const scale = box.querySelector(".pkh-hl-scale");
  const rows = box.querySelector(".pkh-hl-rows");
  const dragTip = esc(t("SettingsWindow.HealthEditor.Drag"));

  const drawBar = () => {
    const segs = bandSegments(state.bands);
    // a band too narrow for its name keeps it in the tooltip only
    bar.innerHTML = segs.map(s => `<div class="seg" style="left:${s.left}%;width:${s.width}%;--h:${s.hue}" data-tooltip="${esc(s.name)}">${s.width >= 6 ? `<span>${esc(s.name)}</span>` : ""}</div>`).join("")
      + segs.map(s => `<div class="cut" data-cut="${s.index}" style="left:${100 - s.pct}%" role="slider" tabindex="0" aria-valuemin="1" aria-valuemax="99" aria-valuenow="${s.pct}" aria-label="${esc(s.name)}" data-tooltip="${dragTip}"></div>`).join("");
    let last = 100;   // numbers under the dividers, skipped where they would overlap
    const ticks = segs.filter(s => s.pct >= 5 && s.pct <= 95 && last - s.pct >= 5 && (last = s.pct));
    scale.innerHTML = `<span class="end" style="left:0">100%</span>`
      + ticks.map(s => `<span style="left:${100 - s.pct}%">${s.pct}</span>`).join("")
      + `<span class="end" style="left:100%">0%</span>`;
  };
  const drawRows = () => {
    const segs = bandSegments(state.bands);
    const remove = esc(t("SettingsWindow.HealthEditor.Remove"));
    const one = state.bands.length <= 1 ? "disabled" : "";
    rows.innerHTML = (field("healthFull") ? `<div class="row fixed"><span class="sw full"></span><span class="pct">100%</span><input type="text" data-hl="full" value="${esc(state.full)}"></div>` : "")
      + state.bands.map((b, i) => `<div class="row" data-i="${i}"><span class="sw" style="--h:${segs[i].hue}"></span>
        <span class="pct"><input type="number" data-hl="pct" min="1" max="99" step="1" value="${b.pct}"><span>%</span></span>
        <input type="text" data-hl="name" value="${esc(b.name)}" placeholder="${esc(t("SettingsWindow.HealthEditor.NewBand"))}">
        <button type="button" data-hl="remove" data-tooltip="${remove}" aria-label="${remove}" ${one}><i class="fa-solid fa-xmark"></i></button></div>`).join("")
      + (field("healthZero") ? `<div class="row fixed"><span class="sw zero"></span><span class="pct">0%</span><input type="text" data-hl="zero" value="${esc(state.zero)}"></div>` : "");
    box.querySelector('[data-hl="add"]').disabled = !addBand(state.bands, "");
  };
  const drawAll = () => { drawBar(); drawRows(); };
  // Into the hidden fields; their "change" reaches the window's _onField like any other field.
  const commit = () => {
    const text = { healthFull: state.full, healthLevels: serializeBands(state.bands), healthZero: state.zero };
    for (const key of HEALTH_KEYS) {
      const el = field(key);
      if (!el) continue;
      const value = healthStored(key, text[key], config(key)?.default, translated(key));
      if (el.value === value) continue;
      el.value = value;
      el.dispatchEvent(new Event("change", { bubbles: true }));
    }
  };
  const rowIndex = el => Number(el.closest(".row[data-i]")?.dataset.i);

  box.addEventListener("input", ev => {
    const el = ev.target;
    const kind = el.dataset?.hl;
    if (!["full", "zero", "name"].includes(kind)) return;
    const clean = cleanHealthName(el.value);
    if (clean !== el.value) {
      const at = Math.max(0, (el.selectionStart ?? clean.length) - (el.value.length - clean.length));
      el.value = clean;
      el.setSelectionRange?.(at, at);
    }
    if (kind === "name") { state.bands[rowIndex(el)].name = clean; drawBar(); }
    else state[kind] = clean;
    commit();
  });
  box.addEventListener("change", ev => {
    const el = ev.target;
    if (el.dataset?.hl !== "pct") return;
    state.bands = setBandPct(state.bands, rowIndex(el), el.value).bands;
    drawAll();
    commit();
  });
  box.addEventListener("click", ev => {
    const act = ev.target.closest("button[data-hl]")?.dataset.hl;
    if (act === "add") {
      const added = addBand(state.bands, t("SettingsWindow.HealthEditor.NewBand"));
      if (!added) return;
      state.bands = added.bands;
      drawAll();
      commit();
      const input = rows.querySelector(`.row[data-i="${added.index}"] [data-hl="name"]`);
      input?.focus();
      input?.select?.();
    } else if (act === "remove") {
      state.bands = removeBand(state.bands, rowIndex(ev.target));
      drawAll();
      commit();
    } else if (act === "reset") {
      Object.assign(state, defaults());
      drawAll();
      commit();
    }
  });

  // Dividers: drag with the pointer (captured by the bar, which is never redrawn), or arrow keys.
  let dragging = null;
  const moveCut = (index, pct) => {
    const value = clampDrag(state.bands, index, pct);
    if (value === state.bands[index].pct) return;
    state.bands[index].pct = value;
    drawBar();
    const input = rows.querySelector(`.row[data-i="${index}"] [data-hl="pct"]`);
    if (input) input.value = value;
    commit();
  };
  bar.addEventListener("pointerdown", ev => {
    const cut = ev.target.closest("[data-cut]");
    if (!cut || ev.button !== 0) return;
    ev.preventDefault();
    dragging = Number(cut.dataset.cut);
    bar.classList.add("dragging");
    bar.setPointerCapture?.(ev.pointerId);
  });
  bar.addEventListener("pointermove", ev => {
    if (dragging === null) return;
    const rect = bar.getBoundingClientRect();
    if (rect.width) moveCut(dragging, 100 - (ev.clientX - rect.left) / rect.width * 100);
  });
  const stop = ev => {
    if (dragging === null) return;
    dragging = null;
    bar.classList.remove("dragging");
    if (bar.hasPointerCapture?.(ev.pointerId)) bar.releasePointerCapture(ev.pointerId);
  };
  bar.addEventListener("pointerup", stop);
  bar.addEventListener("pointercancel", stop);
  bar.addEventListener("keydown", ev => {
    const cut = ev.target.closest("[data-cut]");
    const step = { ArrowLeft: 1, ArrowUp: 1, ArrowRight: -1, ArrowDown: -1 }[ev.key];
    if (!cut || !step) return;
    ev.preventDefault();
    const index = Number(cut.dataset.cut);
    moveCut(index, state.bands[index].pct + step);
    bar.querySelector(`[data-cut="${index}"]`)?.focus();
  });

  drawAll();
}

export class PkhSettingsWindow extends foundry.applications.api.ApplicationV2 {
  static DEFAULT_OPTIONS = {
    id: "pkh-settings",
    classes: ["pkh-window", "pkh-settings"],
    window: { title: "PKH.SettingsWindow.Title", icon: "fa-solid fa-sliders", resizable: true },
    position: { width: 760, height: 640 }
  };

  /** The tab it opens at; none: the first one this user sees. */
  static TAB = null;

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
    captureMenus();
    const tabs = visibleTabs();
    if (!tabs.some(t => t.id === this.tab)) this.tab = tabs[0]?.id;
    const tab = tabs.find(t => t.id === this.tab);
    const nav = tabs.map(t => `<button type="button" class="${t.id === this.tab ? "active" : ""}" data-tab="${t.id}"><i class="${t.icon}"></i><span>${esc(label(t.label))}</span></button>`).join("");
    const menus = menusOf(tab)
      .map(m => `<button type="button" class="menu" data-menu="${m.key}"><i class="${m.icon}"></i> ${esc(menuLabel(m))}</button>`).join("");
    const sections = (tab?.sections ?? []).map(sec => {
      const fields = sec.keys.map(key => fieldHtml(key, [label(tab.label), label(sec.title)])).join("");
      return fields ? `<section class="pkh-set-section"><h3>${esc(label(sec.title))}</h3>${fields}</section>` : "";
    }).join("");
    return `
      <div class="pkh-set">
        <nav class="pkh-set-tabs">${nav}</nav>
        <div class="pkh-set-body">
          ${menus ? `<div class="pkh-set-menus">${menus}</div>` : ""}
          ${sections || `<p class="hint">${esc(t("SettingsWindow.Empty"))}</p>`}
        </div>
      </div>
      <footer class="pkh-set-footer">
        <button type="button" data-act="defaults"><i class="fa-solid fa-rotate-left"></i> ${esc(t("SettingsWindow.Defaults"))}</button>
        <span class="grow"></span>
        <button type="button" data-act="close">${esc(t("Common.Close"))}</button>
        <button type="button" data-act="save" class="primary"><i class="fa-solid fa-floppy-disk"></i> ${esc(t("Common.Save"))}</button>
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
    // The health-levels editor reads its three hidden fields, so it starts after the edits are put back.
    mountHealthEditor(root);
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
    ui.notifications.info(t("SettingsWindow.Saved"));
    this.close();
    const SC = foundry.applications?.settings?.SettingsConfig ?? globalThis.SettingsConfig;
    if (reload && typeof SC?.reloadConfirm === "function") SC.reloadConfirm({ world });
  }
}

/** A tab's menu buttons this user may open: captured, and GM-only ones for the GM only. */
export function menusOf(tab) {
  return (tab?.menus ?? []).filter(m => capturedMenus.has(m.key) && (!capturedMenus.get(m.key).restricted || game.user.isGM));
}

/** A tab names its own label; a menu it does not know (under "기타") uses the menu's own. */
function menuLabel(m) {
  if (m.label) return label(m.label);
  const entry = capturedMenus.get(m.key);
  return game.i18n.localize(String(entry?.label ?? entry?.name ?? m.key));
}

/**
 * Take every menu of this module except our own button out of Foundry's list, keep it here,
 * and give one that no tab names a button under "기타". Safe to run more than once.
 */
export function captureMenus() {
  const named = new Set([...TABS, OTHER_TAB].flatMap(t => (t.menus ?? []).map(m => m.key)));
  for (const [id, entry] of [...game.settings.menus]) {
    if (!id.startsWith(`${MODULE_ID}.`)) continue;
    const key = id.slice(MODULE_ID.length + 1);
    if (key === MENU_KEY) continue;
    capturedMenus.set(key, entry);
    game.settings.menus.delete(id);
    if (!named.has(key)) OTHER_TAB.menus.push({ key, icon: entry.icon ?? "fa-solid fa-gear" });
  }
}

/**
 * Call once every setting is registered ("setup" hook): hides the grouped settings from Foundry's list, moves the module's other menus into their tabs and adds the one button that opens the window.
 * Every entry file registers its settings and menus in "init", which runs for all of them before "setup", so load order does not matter. The window captures again on each open, for a menu registered later.
 */
export function registerSettingsWindows() {
  const listed = new Set(TABS.flatMap(t => t.sections.flatMap(s => s.keys)));
  for (const [id, cfg] of game.settings.settings) {
    if (!id.startsWith(`${MODULE_ID}.`) || cfg.config === false) continue;
    const key = id.slice(MODULE_ID.length + 1);
    if (BASIC.includes(key) && !hidden(key)) continue;
    if (!listed.has(key) && !hidden(key)) OTHER_TAB.sections[0].keys.push(key);
    cfg.config = false;
  }

  captureMenus();

  game.settings.registerMenu(MODULE_ID, MENU_KEY, {
    name: "PKH.SettingsWindow.Title",
    label: "PKH.SettingsWindow.Open",
    hint: "PKH.SettingsWindow.Hint",
    icon: "fa-solid fa-sliders",
    type: PkhSettingsWindow,
    restricted: false
  });
}

/** For macros: game.pf2eKrHud.settings("turns") */
export function openSettings(tab = null) {
  const app = new PkhSettingsWindow();
  app.tab = tab;
  return app.render(true);
}
PkhSettingsWindow.current = null;
