/*
 * Chat enhancements: merges consecutive lines of one speaker, prints the player name under them,
 * adds 전체 / 귓속말 / 노트 tabs and a reserved strip above the input for typing indicators.
 * DOM decoration only: no ChatMessage document is modified.
 */

import { TABLE_EDITION, t } from "./shared.mjs";

const MODULE_ID = "pf2e-kr-hud";

const CHAT_ROOT_SELECTORS = [
  "#chat",
  "#chat-popout",
  "section.chat-sidebar",
  ".chat-sidebar",
  "section[data-tab='chat']"
];

const CHAT_LOG_SELECTORS = ["#chat-log", "ol.chat-log", ".chat-log"];

const CHAT_INPUT_SELECTORS = [
  "#chat-form",
  "form.chat-form",
  ".chat-form",
  "#chat-controls",
  ".chat-input"
];

const FALLBACK_SANS =
  '"Apple SD Gothic Neo", "Malgun Gothic", "Segoe UI", sans-serif';

const FALLBACK_SERIF = '"Nanum Myeongjo", "Batang", serif';

function googleFont(family) {
  return `https://fonts.googleapis.com/css2?family=${family}&display=swap`;
}

/* Free, commercially usable Korean fonts from public CDNs. 조선신명조 is not openly licensed, so the 명조 entries are open-licence substitutes. */
const FONT_PRESETS = {
  pretendard: {
    label: "PKH.Fonts.pretendard",
    href: "https://cdn.jsdelivr.net/gh/orioncactus/pretendard@v1.3.9/dist/web/static/pretendard-dynamic-subset.min.css",
    stack: `Pretendard, "Pretendard Variable", ${FALLBACK_SANS}`
  },
  plex: {
    label: "PKH.Fonts.plex",
    href: googleFont("IBM+Plex+Sans+KR:wght@300;400;500;600;700"),
    stack: `"IBM Plex Sans KR", ${FALLBACK_SANS}`
  },
  gowunDodum: {
    label: "PKH.Fonts.gowunDodum",
    href: googleFont("Gowun+Dodum"),
    stack: `"Gowun Dodum", ${FALLBACK_SANS}`
  },
  kopubBatang: {
    label: "PKH.Fonts.kopubBatang",
    href: "https://cdn.jsdelivr.net/npm/font-kopubworld@1.0/batang.min.css",
    stack: `"KoPubWorld Batang", ${FALLBACK_SERIF}`
  },
  ridiBatang: {
    label: "PKH.Fonts.ridiBatang",
    href: "https://unpkg.com/@kfonts/ridi-batang/index.css",
    stack: `RIDIBatang, "리디바탕", ${FALLBACK_SERIF}`
  },
  gowunBatang: {
    label: "PKH.Fonts.gowunBatang",
    href: googleFont("Gowun+Batang:wght@400;700"),
    stack: `"Gowun Batang", ${FALLBACK_SERIF}`
  },
  nanumMyeongjo: {
    label: "PKH.Fonts.nanumMyeongjo",
    href: googleFont("Nanum+Myeongjo:wght@400;700;800"),
    stack: `"Nanum Myeongjo", ${FALLBACK_SERIF}`
  },
  songMyung: {
    label: "PKH.Fonts.songMyung",
    href: googleFont("Song+Myung"),
    stack: `"Song Myung", ${FALLBACK_SERIF}`
  },
  hahmlet: {
    label: "PKH.Fonts.hahmlet",
    href: googleFont("Hahmlet:wght@300;400;500;700"),
    stack: `Hahmlet, ${FALLBACK_SERIF}`
  },
  system: {
    label: "PKH.Fonts.system",
    stack: FALLBACK_SANS
  }
};

const FONT_CHOICES = {
  inherit: "PKH.Fonts.inherit",
  ...Object.fromEntries(Object.entries(FONT_PRESETS).map(([key, value]) => [key, value.label]))
};

const DEFAULT_FONT_STACK = FONT_PRESETS.pretendard.stack;

const DEFAULT_TYPING_SELECTOR =
  '#chat-typing, #typing-indicator, .typing-indicator, .cgmp-typing, [class*="typing-notification"]';

let regroupTimer = null;
let installTimer = null;

/* small helpers */

function setting(key, fallback) {
  try {
    const value = game.settings.get(MODULE_ID, key);
    return value === undefined ? fallback : value;
  } catch (_) {
    return fallback;
  }
}

function queryFirst(root, selectors) {
  for (const selector of selectors) {
    const found = root.querySelector(selector);
    if (found) return found;
  }
  return null;
}

/** Every rendered chat surface (sidebar tab, popped-out chat). Only the innermost match is kept: an ancestor and its descendant would build two stacked tab bars. */
function chatRoots() {
  const found = new Set();
  for (const selector of CHAT_ROOT_SELECTORS) {
    document.querySelectorAll(selector).forEach(el => found.add(el));
  }

  const candidates = [...found].filter(isValidChatRoot);

  return candidates.filter(
    root => !candidates.some(other => other !== root && root.contains(other))
  );
}

/* A chat root must hold a message list and live inside the persistent interface or a popped-out window; detached fragments and notification popovers are rejected. */
function isValidChatRoot(root) {
  if (!(root instanceof HTMLElement) || !root.isConnected) return false;
  if (!queryFirst(root, CHAT_LOG_SELECTORS)) return false;
  if (root.closest("#chat-notifications, .chat-notifications, #tooltip")) return false;

  return !!root.closest("#interface, #sidebar, #chat-popout, .application, .app")
    || root.parentElement === document.body;
}

/** Removes injected elements that are no longer inside a valid chat root (Foundry re-renders leave orphans). */
function cleanupOrphans() {
  const roots = new Set(chatRoots());

  for (const node of document.querySelectorAll(".pkh-typing-reserve")) {
    const owner = [...roots].find(root => root.contains(node));
    if (!owner) node.remove();
  }
}

/** Whether a user id belongs to a keeper. */
function isGmUser(userId) {
  return !!game.users.get(userId)?.isGM;
}

/* message classification */

/** Tags a rendered message with the data the grouping and tab filters need. Idempotent. */
/** Only lines a person typed are merged; PF2e cards and rolls stay as PF2e draws them, and the header is never rearranged. */
const CARD_MARKUP = /<(section|header|table|button|form)\b|class="[^"]*\b(chat-card|dice-roll|card-content|item-card)\b|data-pf2-check|@Check\[/i;

function isPlainDoc(message) {
  if (!message || message.rolls?.length || message.isRoll) return false;
  if (message.getFlag?.(MODULE_ID, "note")) return false;
  const pf2e = message.flags?.pf2e ?? {};
  if (pf2e.origin || pf2e.context || pf2e.casting || pf2e.strike || pf2e.appliedDamage) return false;
  return !CARD_MARKUP.test(String(message.content ?? ""));
}

function whisperKey(message) {
  return [...(message.whisper ?? [])].sort().join(",");
}

/** Same speaker, typed, close in time: one speech bubble. */
function sameRun(previous, message) {
  if (!previous || !isPlainDoc(previous) || !isPlainDoc(message)) return false;
  const a = previous.author ?? previous.user;
  const b = message.author ?? message.user;
  if (!a || a.id !== b?.id) return false;
  if ((previous.speaker?.alias ?? "") !== (message.speaker?.alias ?? "")) return false;
  // Same character and token, same kind of line (in/out of character).
  if ((previous.speaker?.actor ?? null) !== (message.speaker?.actor ?? null)) return false;
  if ((previous.speaker?.token ?? null) !== (message.speaker?.token ?? null)) return false;
  if ((previous.style ?? null) !== (message.style ?? null)) return false;
  if (whisperKey(previous) !== whisperKey(message)) return false;
  // A line in another language (Polyglot) starts its own bubble.
  if ((previous.flags?.polyglot?.language ?? "") !== (message.flags?.polyglot?.language ?? "")) return false;
  const windowMs = (Number(setting("chatGroupWindow", 5)) || 5) * 60000;
  return Math.abs((message.timestamp ?? 0) - (previous.timestamp ?? 0)) <= windowMs;
}

/* A line merges into the card shown right above it, not the previous message in Foundry's list: rerolls, secret rolls, whispers and the trim make the two differ. */
const MESSAGE_ITEM = ":scope > .chat-message[data-message-id], :scope > li.message[data-message-id]";

/** Grouping code version running on this client (shown in the 진단 window). */
export const CHAT_GROUPING = "screen-2.2.3";
globalThis.pkhChatGrouping = CHAT_GROUPING;

function isMessageItem(el) {
  return el instanceof HTMLElement && el.matches(".chat-message[data-message-id], li.message[data-message-id]");
}

/** The card shown right above this one in its log (shared notes are skipped). */
function shownAbove(element) {
  for (let el = element?.previousElementSibling; el; el = el.previousElementSibling) {
    if (!isMessageItem(el)) continue;
    if (el.classList.contains("pkh-note-message")) continue;
    return el;
  }
  return null;
}

function messageOf(element) {
  const id = element?.dataset?.messageId;
  return id ? game.messages.get(id) ?? null : null;
}

/** Group every card of one log by what is above it. Classes only: nothing moves or resizes. */
function groupLog(log, enabled = setting("chatGrouping", true)) {
  const items = [...log.querySelectorAll(MESSAGE_ITEM)];
  for (const el of items) { el.classList.remove("pkh-grouped", "pkh-group-start", "pkh-run-continues"); delete el.dataset.pkhAbove; }
  for (const el of items) {
    if (!el.classList.contains("pkh-chat-message")) continue;
    const above = shownAbove(el);
    if (enabled && above?.classList.contains("pkh-chat-message") && sameRun(messageOf(above), messageOf(el))) {
      el.classList.add("pkh-grouped");
      el.dataset.pkhAbove = above.dataset.messageId;      // shown in the 진단 window
      above.classList.add("pkh-run-continues");
    } else {
      el.classList.add("pkh-group-start");
    }
  }
}

function chatLogs() {
  const logs = new Set();
  for (const selector of CHAT_LOG_SELECTORS) document.querySelectorAll(selector).forEach(el => logs.add(el));
  return [...logs].filter(log => ![...logs].some(other => other !== log && log.contains(other)));
}

/* Each log is watched: an added or removed card is grouped in the observer callback, after insertion and before paint. */
/* Cards stay in the order the messages reached the server. A card that finished drawing late lands out of order and is moved to its place before paint. */
function messageOrder() {
  const order = new Map();
  game.messages.contents.forEach((m, i) => order.set(m.id, i));
  return order;
}
const orderOf = (order, el) => order.get(el?.dataset?.messageId);

function placeInOrder(el, order) {
  const at = orderOf(order, el);
  if (at === undefined || !el.parentElement) return false;
  // too low: something later sits above it
  let target = null;
  for (let sib = el.previousElementSibling; sib; sib = sib.previousElementSibling) {
    if (!isMessageItem(sib)) continue;
    const o = orderOf(order, sib);
    if (o === undefined) continue;
    if (o > at) target = sib; else break;
  }
  if (target) { target.before(el); return true; }
  // too high: something earlier sits below it
  for (let sib = el.nextElementSibling; sib; sib = sib.nextElementSibling) {
    if (!isMessageItem(sib)) continue;
    const o = orderOf(order, sib);
    if (o === undefined) continue;
    if (o < at) target = sib; else break;
  }
  if (target) { target.after(el); return true; }
  return false;
}

const watchedLogs = new WeakSet();
const logObserver = new MutationObserver(records => {
  const touched = new Set();
  const added = [];
  for (const record of records) {
    if (record.type !== "childList") continue;
    for (const n of record.addedNodes) if (isMessageItem(n)) added.push(n);
    if ([...record.addedNodes, ...record.removedNodes].some(isMessageItem)) touched.add(record.target);
  }
  if (!touched.size) return;
  if (added.length) {
    const order = messageOrder();
    for (const el of added) if (el.isConnected) placeInOrder(el, order);
  }
  const enabled = setting("chatGrouping", true);
  for (const log of touched) if (log.isConnected) groupLog(log, enabled);
  measureChatGapSoon();
});

/* The author's client stamps the server time (game.time.serverTime) instead of Date.now(), so a computer with a skewed clock cannot order its lines before or after earlier ones. */
Hooks.on("preCreateChatMessage", (message, data, options, userId) => {
  if (userId !== game.user.id || (data && "timestamp" in data)) return;
  const server = Number(game.time?.serverTime);
  if (!Number.isFinite(server) || server <= 0) return;
  const now = Date.now();
  if (Math.abs(server - now) < 400) return;
  if (Math.abs(Number(message.timestamp) - now) > 5000) return;
  message.updateSource({ timestamp: Math.round(server) });
});

function watchLogs() {
  for (const log of chatLogs()) {
    if (watchedLogs.has(log)) continue;
    watchedLogs.add(log);
    logObserver.observe(log, { childList: true });
    groupLog(log);
  }
}

let gapTimer = 0;
function measureChatGapSoon() {
  clearTimeout(gapTimer);
  gapTimer = setTimeout(measureChatGap, 60);
}

function decorateMessage(element, message) {
  if (!element || !message) return;
  if (message.getFlag?.(MODULE_ID, "note")) element.classList.add("pkh-note-message");

  const author = message.author ?? message.user;
  element.dataset.ckAuthor = author?.id ?? "";
  element.dataset.ckAlias = message.speaker?.alias || author?.name || "";
  element.dataset.ckTime = String(message.timestamp ?? 0);
  element.dataset.ckWhisper = whisperKey(message);

  if (!isPlainDoc(message)) {
    element.classList.remove("pkh-chat-message", "pkh-grouped", "pkh-group-start", "pkh-run-continues");
    return;
  }
  // Only marked here: the card is not in the page yet. The log's observer groups it on insertion.
  element.classList.add("pkh-chat-message");
  element.classList.remove("pkh-grouped", "pkh-run-continues");
  element.classList.add("pkh-group-start");
}

/** Distance between two chat cards, so a merged line can close the gap. */
function measureChatGap() {
  const items = document.querySelectorAll("#chat .chat-message, .chat-log .chat-message");
  for (let i = items.length - 1; i > 0; i--) {
    const a = items[i - 1].getBoundingClientRect();
    const b = items[i].getBoundingClientRect();
    if (a.height && b.height && !items[i].classList.contains("pkh-grouped")) {
      const gap = Math.max(0, Math.round(b.top - a.bottom));
      document.documentElement.style.setProperty("--pkh-chat-gap", `${gap}px`);
      return;
    }
  }
}

/* grouping */

function regroup() {
  watchLogs();
  const enabled = setting("chatGrouping", true);
  for (const log of chatLogs()) groupLog(log, enabled);
  measureChatGap();
}

function scheduleRegroup() {
  clearTimeout(regroupTimer);
  regroupTimer = setTimeout(regroup, 40);
}

/* typing reserve */

function relocateTypingIndicators(root) {
  const reserve = root.querySelector(".pkh-typing-reserve");
  if (!reserve) return;

  const selector = setting("typingSelector", DEFAULT_TYPING_SELECTOR);
  if (!selector) return;

  let candidates;
  try {
    candidates = root.querySelectorAll(selector);
  } catch (err) {
    console.warn(`${MODULE_ID} | Invalid typing indicator selector`, selector, err);
    return;
  }

  /* Only small, leaf-like notices are moved; moving a structural element would tear the sidebar apart. */
  const FORBIDDEN = [
    ".chat-log", "#chat-log", "ol.chat-log",
    "form", "#chat-form", ".chat-form", "#chat-controls", ".chat-input",
    ".pkh-typing-reserve",
    "#chat-notifications", ".chat-notifications",
    ".window-content", ".window-header", ".application", ".app"
  ].join(",");

  for (const node of candidates) {
    if (node.closest(".pkh-typing-reserve")) continue;
    if (node.matches(FORBIDDEN)) continue;
    if (node.querySelector(FORBIDDEN)) continue;
    if (node.contains(reserve)) continue;

    reserve.append(node);
  }
}

/* installation */

function installChatUi() {
  cleanupOrphans();

  for (const root of chatRoots()) {
    const log = queryFirst(root, CHAT_LOG_SELECTORS);
    if (!log) continue;

    root.classList.add("pkh-chat-root");

    /* A fixed-height strip directly above the input. Third-party typing indicators live inside it so they cannot displace the message list. */
    if (!root.querySelector(".pkh-typing-reserve")) {
      const reserve = document.createElement("div");
      reserve.classList.add("pkh-typing-reserve");

      const form = queryFirst(root, CHAT_INPUT_SELECTORS);
      if (form?.parentElement) form.parentElement.insertBefore(reserve, form);
      else log.parentElement.append(reserve);
    }

    relocateTypingIndicators(root);
  }

  renderTyping();
}

function scheduleInstall() {
  clearTimeout(installTimer);
  installTimer = setTimeout(() => {
    installChatUi();
    scheduleRegroup();
  }, 120);
}

/* style variables */

function applySidebarWidth() {
  const width = Number(setting("chatSidebarWidth", 0)) || 0;
  document.body.classList.toggle("pkh-fixed-sidebar", width > 0);
  if (width > 0) document.documentElement.style.setProperty("--pkh-sidebar-width", `${width}px`);
  else document.documentElement.style.removeProperty("--pkh-sidebar-width");
}

/** Hides the input's formatting toolbar; the box gives back the toolbar's height (measured once per input while it is shown). */
function fitChatInput() {
  const hide = setting("chatHideEditorMenu", true) !== false;
  const inputs = [...document.querySelectorAll("#chat-message")];
  if (!hide) {
    document.body.classList.remove("pkh-no-chat-menu");
    for (const pm of inputs) {
      if (!pm.dataset.pkhFit) continue;
      for (const k of ["height", "minHeight", "flexBasis"]) pm.style[k] = "";
      delete pm.dataset.pkhFit;
    }
    return;
  }
  const todo = inputs.filter(pm => !pm.dataset.pkhFit && pm.querySelector(".menu-container, menu.editor-menu"));
  if (todo.length) {
    document.body.classList.remove("pkh-no-chat-menu");
    const sizes = todo.map(pm => [pm, pm.getBoundingClientRect().height, pm.querySelector(".menu-container, menu.editor-menu").getBoundingClientRect().height]);
    for (const [pm, full, menu] of sizes) {
      if (!(full > 0) || !(menu > 0)) continue;
      pm.dataset.pkhFit = "1";
      pm.style.height = `${Math.max(36, Math.round(full - menu))}px`;
      pm.style.minHeight = "0";
      pm.style.flexBasis = "auto";
    }
  }
  document.body.classList.add("pkh-no-chat-menu");
}

function applyStyleVariables() {
  applySidebarWidth();
  fitChatInput();
  let style = document.getElementById("pkh-chat-style");
  if (!style) {
    style = document.createElement("style");
    style.id = "pkh-chat-style";
    document.head.append(style);
  }
  const key = setting("chatBodyFont", "inherit");
  const preset = key !== "inherit" ? FONT_PRESETS[key] : null;
  if (preset) loadWebFonts([preset]);
  const size = Number(setting("chatFontSize", 0)) || 0;
  const reserve = Number(setting("typingReserveHeight", 26)) || 0;
  document.body.classList.toggle("pkh-chat-font", !!preset);
  document.body.classList.toggle("pkh-chat-size", size > 0);
  style.textContent = `
    :root {
      ${preset ? `--pkh-chat-font: ${preset.stack};` : ""}
      ${size > 0 ? `--pkh-chat-font-size: ${size}px;` : ""}
      --pkh-typing-reserve: ${reserve}px;
    }
  `;
}

/** Injects the stylesheets for the chosen presets, each fetched once; without internet the local stack is used. */
function loadWebFonts(presets) {
  const wanted = new Set(presets.map(preset => preset?.href).filter(Boolean));

  for (const link of document.querySelectorAll("link[data-pkh-font]")) {
    if (wanted.has(link.href)) wanted.delete(link.href);
    else link.remove();
  }

  for (const href of wanted) {
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = href;
    link.crossOrigin = "anonymous";
    link.dataset.pkhFont = "1";
    link.addEventListener("error", () => {
      console.warn(`${MODULE_ID} | Could not load web font`, href);
    });
    document.head.append(link);
  }
}

/* hooks */

Hooks.once("init", () => {
  const rerender = () => {
    applyStyleVariables();
    scheduleInstall();
  };

  game.settings.register(MODULE_ID, "chatGrouping", {
    name: "PKH.Settings.chatGrouping.Name",
    hint: "PKH.Settings.chatGrouping.Hint",
    scope: "client",
    config: true,
    type: Boolean,
    default: true,
    onChange: scheduleRegroup
  });

  game.settings.register(MODULE_ID, "chatGroupWindow", {
    name: "PKH.Settings.chatGroupWindow.Name",
    hint: "PKH.Settings.chatGroupWindow.Hint",
    scope: "client",
    config: true,
    type: Number,
    range: { min: 1, max: 30, step: 1 },
    default: 5,
    onChange: scheduleRegroup
  });

  game.settings.register(MODULE_ID, "chatShowUser", {
    name: "PKH.Settings.chatShowUser.Name",
    hint: "PKH.Settings.chatShowUser.Hint",
    scope: "client",
    config: false,
    type: Boolean,
    default: false,
    onChange: () => ui.chat?.render()
  });

  game.settings.register(MODULE_ID, "chatAvatars", {
    name: "PKH.Settings.chatAvatars.Name",
    hint: "PKH.Settings.chatAvatars.Hint",
    scope: "client",
    config: false,
    type: Boolean,
    default: false,
    onChange: () => ui.chat?.render()
  });

  game.settings.register(MODULE_ID, "chatCardTheme", {
    name: "PKH.Settings.chatCardTheme.Name",
    hint: "PKH.Settings.chatCardTheme.Hint",
    scope: "client",
    config: false,
    type: String,
    choices: {
      light: "PKH.Settings.chatCardTheme.Choices.light",
      dark: "PKH.Settings.chatCardTheme.Choices.dark"
    },
    default: "light",
    onChange: applyStyleVariables
  });

  game.settings.register(MODULE_ID, "chatHeadingFont", {
    name: "PKH.Settings.chatHeadingFont.Name",
    hint: "PKH.Settings.chatHeadingFont.Hint",
    scope: "client",
    config: false,
    type: String,
    choices: FONT_CHOICES,
    default: "ridiBatang",
    onChange: applyStyleVariables
  });

  game.settings.register(MODULE_ID, "chatBodyFont", {
    name: "PKH.Settings.chatBodyFont.Name",
    hint: "PKH.Settings.chatBodyFont.Hint",
    scope: "client",
    config: true,
    type: String,
    choices: FONT_CHOICES,
    default: "inherit",
    onChange: applyStyleVariables
  });

  game.settings.register(MODULE_ID, "chatFontFamily", {
    name: "PKH.Settings.chatFontFamily.Name",
    hint: "PKH.Settings.chatFontFamily.Hint",
    scope: "client",
    config: false,
    type: String,
    default: "",
    onChange: applyStyleVariables
  });

  game.settings.register(MODULE_ID, "chatFontSize", {
    name: "PKH.Settings.chatFontSize.Name",
    hint: "PKH.Settings.chatFontSize.Hint",
    scope: "client",
    config: true,
    type: Number,
    range: { min: 0, max: 24, step: 1 },
    default: 0,
    onChange: applyStyleVariables
  });

  game.settings.register(MODULE_ID, "chatSidebarWidth", {
    name: "PKH.Settings.chatSidebarWidth.Name",
    hint: "PKH.Settings.chatSidebarWidth.Hint",
    scope: "client",
    config: true,
    type: Number,
    default: 0,
    range: { min: 0, max: 600, step: 10 },
    onChange: applySidebarWidth
  });

  game.settings.register(MODULE_ID, "chatHideEditorMenu", {
    name: "PKH.Settings.chatHideEditorMenu.Name",
    hint: "PKH.Settings.chatHideEditorMenu.Hint",
    scope: "client",
    config: true,
    type: Boolean,
    default: true,
    onChange: applyStyleVariables
  });

  game.settings.register(MODULE_ID, "typingIndicator", {
    name: "PKH.Settings.typingIndicator.Name",
    hint: "PKH.Settings.typingIndicator.Hint",
    scope: "world",
    config: true,
    type: Boolean,
    default: true,
    onChange: () => {
      for (const timer of typingUsers.values()) clearTimeout(timer);
      typingUsers.clear();
      renderTyping();
    }
  });

  game.settings.register(MODULE_ID, "typingShowKeeper", {
    name: "PKH.Settings.typingShowKeeper.Name",
    hint: "PKH.Settings.typingShowKeeper.Hint",
    scope: "world",
    config: true,
    type: Boolean,
    default: true
  });

  game.settings.register(MODULE_ID, "typingReserveHeight", {
    name: "PKH.Settings.typingReserveHeight.Name",
    hint: "PKH.Settings.typingReserveHeight.Hint",
    scope: "client",
    config: true,
    type: Number,
    range: { min: 0, max: 60, step: 2 },
    default: 26,
    onChange: applyStyleVariables
  });

  game.settings.register(MODULE_ID, "typingSelector", {
    name: "PKH.Settings.typingSelector.Name",
    hint: "PKH.Settings.typingSelector.Hint",
    scope: "client",
    config: true,
    type: String,
    default: DEFAULT_TYPING_SELECTOR,
    onChange: scheduleInstall
  });
});

Hooks.once("ready", () => {
  /* Escape hatch: `game.pkhChat.reset()` strips every injected element; `disable()` also turns the tabs off for good. */
  game.pkhChat = {
    reset() {
      document.querySelectorAll(".pkh-typing-reserve").forEach(node => node.remove());

      document.querySelectorAll(".pkh-chat-root").forEach(root => {
        root.classList.remove("pkh-chat-root");
        delete root.dataset.pkhTab;
      });

      ui.chat?.render();
    },
    async safeMode() {
      await game.settings.set(MODULE_ID, "typingReserveHeight", 0);
      await game.settings.set(MODULE_ID, "typingSelector", "");
      this.reset();
      ui.notifications.warn(`Rutz's HUD | ${t("Chat.SafeMode")}`);
    }
  };

  applyStyleVariables();
  installChatUi();
  scheduleRegroup();

  /* Foundry and other modules re-render the sidebar at unpredictable times, so a debounced observer is used. Mutations inside the message list and the typing strip are ignored. */
  const observer = new MutationObserver(records => {
    const relevant = records.some(record => {
      const target = record.target;
      if (!(target instanceof HTMLElement)) return true;
      return !target.closest(".chat-log, #chat-log, .pkh-typing-reserve");
    });

    if (relevant) scheduleInstall();
  });

  const target = document.getElementById("interface") ?? document.body;
  observer.observe(target, { childList: true, subtree: true });
});

// v13+ delivers an HTMLElement; v12 delivers jQuery.
Hooks.on("renderChatMessageHTML", (message, element) => {
  decorateMessage(element instanceof HTMLElement ? element : element?.[0], message);
});

/* The old hook name is only registered on cores that still need it (v13 renamed it to renderChatMessageHTML). */
if (Number(game.release?.generation ?? 13) < 13) {
  Hooks.on("renderChatMessage", (message, html) => {
    const element = html instanceof HTMLElement ? html : html?.[0];
    decorateMessage(element, message);
    scheduleRegroup();
  });
}

Hooks.on("renderChatLog", () => { watchLogs(); scheduleInstall(); });
for (const hook of ["renderChatLog", "renderChatInput", "changeSidebarTab", "collapseSidebar"]) Hooks.on(hook, () => setTimeout(fitChatInput, 60));
Hooks.once("ready", () => { setTimeout(fitChatInput, 300); setInterval(fitChatInput, 2000); });
Hooks.on("renderChatInput", () => scheduleInstall());
Hooks.on("collapseSidebar", () => scheduleInstall());
Hooks.on("changeSidebarTab", () => scheduleInstall());
Hooks.on("deleteChatMessage", () => scheduleRegroup());
Hooks.on("updateChatMessage", () => scheduleRegroup());

/*
 * "…님이 입력 중입니다"
 * While someone types in the chat box their client announces it over the module socket; others show the names in the reserved strip.
 * - Announcements are throttled (every 2 s); a name expires 3.5 s after its last announcement, or at once on clear, send or blur.
 * - Whispers are never announced.
 * - The keeper's typing is hidden unless a setting shows it.
 * - Only the chat box counts.
 */

const TYPING_SOCKET = `module.${MODULE_ID}`;
const TYPING_SEND_EVERY_MS = 2000;
const TYPING_EXPIRES_MS = 3500;

const typingUsers = new Map();
let amTyping = false;
let lastTypingSent = 0;

/** "A님이", "A, B님이", "여러 명이" (pure, testable). */
function typingText(names) {
  if (!names.length) return "";
  if (names.length > 3) return t("Chat.TypingMany");
  return t(names.length > 1 ? "Chat.TypingSome" : "Chat.TypingOne", { names: names.join(", ") });
}

/* The line lives inside the chat input form, which Foundry moves between the sidebar and the floating spot, so the line travels with it. It keeps its height when empty so the chat log never moves. */
const TYPING_FORM_SELECTOR = "#chat-form, .chat-form";

function typingLines() {
  const lines = [];
  for (const form of document.querySelectorAll(TYPING_FORM_SELECTOR)) {
    if (form.parentElement?.closest(TYPING_FORM_SELECTOR)) continue;

    let line = form.querySelector(":scope > .pkh-typing-line");
    if (!line) {
      line = document.createElement("div");
      line.className = "pkh-typing-line";
      form.prepend(line);
    }
    lines.push(line);
  }
  return lines;
}

function renderTyping() {
  // Your own name first, then the others in the order they started.
  const ids = [...typingUsers.keys()].sort((a, b) => (a === game.user.id ? -1 : b === game.user.id ? 1 : 0));
  const names = ids
    .map(id => (id === "__coc7ko_test__" ? t("Chat.TestName") : game.users.get(id)?.name))
    .filter(Boolean);
  const text = typingText(names);
  const html = text ? `<span class="dots"><i></i><i></i><i></i></span><span>${foundry.utils.escapeHTML(text)}</span>` : "";

  document.querySelectorAll(".pkh-typing-float").forEach(node => node.remove());

  document.body.classList.toggle("pkh-typing-builtin", typingEnabled());

  /* With the dice bar on, the line rides on top of it, so it is never hidden inside the chat layout. */
  const dock = document.querySelector("#pkh-dice .pkh-dock-typing");
  document.body.classList.toggle("pkh-typing-in-dock", !!dock && typingEnabled());
  if (dock) {
    dock.classList.toggle("active", !!text);
    if (dock.innerHTML !== html) dock.innerHTML = html;
  }

  for (const line of typingLines()) {
    line.classList.toggle("active", !!text);
    if (line.innerHTML !== html) line.innerHTML = html;
  }
}

/** Your own "입력 중" shows locally (it never goes over the socket). */
function markSelfTyping(typing) {
  if (!typingEnabled()) return;
  const id = game.user.id;
  clearTimeout(typingUsers.get(id));
  if (typing) {
    typingUsers.set(id, setTimeout(() => {
      typingUsers.delete(id);
      renderTyping();
    }, TYPING_EXPIRES_MS));
  } else {
    typingUsers.delete(id);
  }
  renderTyping();
}

/** CGMP's own typing notice is on: stay out of its way. */
function cgmpTypingActive() {
  if (!game.modules.get("CautiousGamemastersPack")?.active) return false;
  try {
    return !!game.settings.get("CautiousGamemastersPack", "notifyTyping");
  } catch (_) {
    return false;
  }
}

function typingEnabled() {
  return !!setting("typingIndicator", true) && !cgmpTypingActive();
}

function sendTyping(typing) {
  if (!typingEnabled()) return;
  if (game.user.isGM && !setting("typingShowKeeper", true)) return;
  game.socket.emit(TYPING_SOCKET, { action: "typing", userId: game.user.id, typing });
}

function stopTyping() {
  if (typingUsers.has(game.user.id)) markSelfTyping(false);
  if (!amTyping) return;
  amTyping = false;
  sendTyping(false);
}

/** The chat input under an event target, or null for any other editor. `#chat-message` is the v13/v14 chat box; the broader check is a fallback. */
function chatField(target) {
  const direct = target?.closest?.("#chat-message");
  if (direct) return direct;

  const field = target?.closest?.("textarea, [contenteditable='true'], [contenteditable='']");
  if (!field) return null;
  if (!field.closest([...CHAT_ROOT_SELECTORS, "#chat-notifications", TYPING_FORM_SELECTOR].join(","))) return null;
  if (field.closest(".pkh-side-panel")) return null;
  return field;
}

function fieldText(field) {
  if (typeof field.value === "string") return field.value.trim();
  // A rich editor host also contains its toolbar; read the editable part only.
  const editable = field.matches?.("[contenteditable]") ? field : field.querySelector?.("[contenteditable]");
  return String((editable ?? field).innerText ?? (editable ?? field).textContent ?? "").trim();
}

function onChatInput(event) {
  const field = chatField(event.target);
  if (!field) return;

  const text = fieldText(field);

  // Nothing typed any more, or a whisper: say nothing (and retract).
  if (!text || /^\/(w|whisper)\b/i.test(text)) return stopTyping();

  const now = Date.now();
  if (!amTyping || now - lastTypingSent > TYPING_SEND_EVERY_MS) {
    amTyping = true;
    lastTypingSent = now;
    sendTyping(true);
    markSelfTyping(true);
  }
}

function onChatBlur(event) {
  if (chatField(event.target)) stopTyping();
}

function receiveTyping(payload) {
  if (payload?.action !== "typing") return;
  if (!payload.userId || payload.userId === game.user.id) return;
  if (!typingEnabled()) return;

  clearTimeout(typingUsers.get(payload.userId));

  if (payload.typing) {
    typingUsers.set(payload.userId, setTimeout(() => {
      typingUsers.delete(payload.userId);
      renderTyping();
    }, TYPING_EXPIRES_MS));
  } else {
    typingUsers.delete(payload.userId);
  }

  renderTyping();
}

Hooks.once("ready", () => {
  /* Console helpers: game.pkhTyping.test() shows a sample line for 4 s; status() shows what this client knows. */
  game.pkhTyping = {
    test() {
      const id = "__coc7ko_test__";
      clearTimeout(typingUsers.get(id));
      typingUsers.set(id, setTimeout(() => { typingUsers.delete(id); renderTyping(); }, 4000));
      renderTyping();
      return t("Chat.TestResult");
    },
    status() {
      return {
        enabled: typingEnabled(),
        keeperShown: !!setting("typingShowKeeper", true),
        chatForms: typingLines().length,
        chatBoxFound: !!document.querySelector("#chat-message"),
        deferringToCGMP: cgmpTypingActive(),
        typingNow: [...typingUsers.keys()],
        socketDeclared: !!game.modules.get(MODULE_ID)?.socket
      };
    }
  };

  game.socket.on(TYPING_SOCKET, receiveTyping);
  document.addEventListener("input", onChatInput, true);
  document.addEventListener("keyup", onChatInput, true);
  document.addEventListener("focusout", onChatBlur, true);
});

Hooks.on("renderChatLog", () => setTimeout(renderTyping, 50));

// The chat input moves when the sidebar collapses or expands.
Hooks.on("collapseSidebar", () => setTimeout(renderTyping, 50));
Hooks.on("changeSidebarTab", () => setTimeout(renderTyping, 50));

// Sending a message ends "typing" at once, for the sender and for everyone.
Hooks.on("createChatMessage", message => {
  const authorId = message.author?.id ?? message.user?.id;
  if (authorId === game.user.id) stopTyping();

  if (typingUsers.has(authorId)) {
    clearTimeout(typingUsers.get(authorId));
    typingUsers.delete(authorId);
    renderTyping();
  }
});

/*
 * start-up check
 * This file loads on its own, so it can tell when the HUD's main script did not start (usually a partial update) and show the GM why.
 */
Hooks.once("ready", () => setTimeout(async () => {
  if (TABLE_EDITION || game.pf2eKrHud?.settings || game.system?.id !== "pf2e") return;
  let why = "";
  // Never loaded at all: asking again gives the same error, with the file it needs.
  if (!game.pf2eKrHud?.diagnostics) {
    try { await import("./main.mjs"); } catch (err) { why = String(err?.message ?? err); }
  }
  console.error(`pf2e-kr-hud | the HUD did not start${why ? `: ${why}` : ""}`);
  if (!game.user?.isGM) return;
  const ko = game.i18n?.lang === "ko";
  const head = ko
    ? "Rutz's HUD가 켜지지 않았습니다. 모듈 파일이 서로 맞지 않습니다 — 업데이트 파일 일부가 빠졌을 수 있으니, 받은 파일을 모두 덮어써 주세요."
    : "Rutz's HUD did not start: its files don't match — an update may have been applied only in part. Copy in all the files you received.";
  ui.notifications.error(`${head}${why ? ` (${why})` : ""}`, { permanent: true });
}, 1500));
