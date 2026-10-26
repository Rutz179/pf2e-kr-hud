import { MODULE_ID, setting, t } from "./shared.mjs";

/* ======================================================================== *
 * 진단 — what goes wrong on this computer, and which package it came from.
 *
 * Imported first by main.mjs, so it is in place before Foundry draws the
 * canvas and before other modules set themselves up:
 *
 *  - WebGL: every 3D canvas any package opens (Foundry's map, Dice So Nice,
 *    effect players …), by package. A browser keeps about 16; past that it
 *    drops the oldest — usually Foundry's own map, which then draws tokens and
 *    effects as black squares until a reload. When the map's canvas is lost the
 *    player is told at once (with a reload button) and the GM hears of it.
 *  - Errors: uncaught errors, failed promises and Foundry's hook errors, by
 *    package (from the file the error came from).
 *  - Missing files: everything the browser asked the server for that wasn't
 *    there (404) — sounds, ring frames, images — by module or folder, with the
 *    usual reasons spotted (letter case on a Linux server, "%" in a file name,
 *    a module that isn't installed).
 *  - Stuck roll cards: a roll whose chat card is still hidden after a while
 *    (Dice So Nice hides it until its dice land; if its animation fails, the
 *    card stays hidden until a reload) is brought out.
 *
 * The 진단 window (HUD settings → 진단, or game.pf2eKrHud.diagnostics())
 * shows it with suggestions and buttons; the GM can ask every player for
 * their report. Nothing is saved: it covers this session (since the reload).
 * ======================================================================== */

const SOCKET = `module.${MODULE_ID}`;

export const diag = {
  started: Date.now(),
  contexts: [],            // { n, type, src, at, lost, restored, ref: WeakRef<canvas> }
  errors: new Map(),       // package id → { src, count, samples: Map(text → count), last }
  missing: new Map(),      // path → { url, status, count, group }
  rescued: 0,
  released: 0,             // abandoned WebGL canvases let go (to spare the map)
  mapLost: false,
  clocks: new Map(),       // userId → { name, skew (ms: arrival here − the author's timestamp), n }
  reports: new Map()       // (GM) userId → report
};

/* ---------------- where something came from ---------------- */

const SELF = /\/modules\/pf2e-kr-hud\/scripts\/diagnostics\.mjs/;

/** The package a stack trace points at: the first frame that isn't this file. */
export function sourceOf(stack) {
  for (const line of String(stack ?? "").split("\n")) {
    if (SELF.test(line)) continue;
    const m = /\/(modules|systems)\/([^/?#:\s]+)\//.exec(line);
    if (m) {
      let id = m[2];
      try { id = decodeURIComponent(id); } catch (_) { /* as is */ }
      return { kind: m[1] === "modules" ? "module" : "system", id };
    }
    if (/\/foundry\.mjs|\/scripts\/[a-z-]+\.mjs|\/common\//.test(line)) return { kind: "core", id: "foundry" };
  }
  return { kind: "unknown", id: "?" };
}

export function packageName(src) {
  if (!src || src.kind === "unknown") return t("Diag.Unknown");
  if (src.kind === "core") return "Foundry VTT";
  const pkg = src.kind === "system" ? (game.system?.id === src.id ? game.system : null) : game.modules?.get(src.id);
  const title = pkg?.title ?? src.id;
  const version = pkg?.version ?? "";
  return version ? `${title} (${version})` : title;
}

/** A module whose manifest was not checked against this Foundry generation. */
export function unverified(id) {
  const mod = game.modules?.get(id);
  const verified = String(mod?.compatibility?.verified ?? "");
  const gen = Number(game.release?.generation ?? 0);
  const major = Number.parseInt(verified, 10);
  return !!mod && Number.isFinite(major) && gen > 0 && major < gen;
}

/* ---------------- WebGL ---------------- */

const seen = new WeakSet();
let warnedMany = false;

function wrapGetContext(proto) {
  const original = proto?.getContext;
  if (!original || original.__pkhDiag) return;
  const wrapped = function (type, ...rest) {
    const ctx = original.call(this, type, ...rest);
    try {
      if (ctx && /webgl/i.test(String(type)) && !seen.has(this)) {
        seen.add(this);
        const entry = { n: diag.contexts.length + 1, type: String(type), src: sourceOf(new Error().stack), at: Date.now(), lost: 0, restored: 0, released: 0,
          wasConnected: !!this.isConnected, detachedSince: 0, ref: new WeakRef(this) };
        diag.contexts.push(entry);
        this.addEventListener?.("webglcontextlost", () => onContextLost(entry, this));
        this.addEventListener?.("webglcontextrestored", () => { entry.restored = Date.now(); });
        if (aliveContexts() >= 12 && !warnedMany) { warnedMany = true; setTimeout(() => warnMany(), 0); }
        if (aliveContexts() >= 6) setTimeout(() => guard(), 0);
      }
    } catch (_) { /* never in the way of the caller */ }
    return ctx;
  };
  wrapped.__pkhDiag = true;
  proto.getContext = wrapped;
}

wrapGetContext(globalThis.HTMLCanvasElement?.prototype);
wrapGetContext(globalThis.OffscreenCanvas?.prototype);

/** Canvases still holding a context (a released one — lost on purpose or collected — no longer counts). */
export function aliveContexts() {
  return diag.contexts.filter(c => !c.lost && c.ref.deref()).length;
}

/*
 * Guard: a module that makes a new 3D canvas again and again and drops the old one from the page
 * (taken out, not just hidden) leaves its context alive until the browser collects it — and those
 * count toward the limit, so the browser ends up dropping the oldest context: the map. A canvas
 * that was in the page, has been out of it for a while and belongs to a module (never Foundry's)
 * is let go here. Canvases that were never in the page are left alone (some draw off-screen).
 */
const DETACHED_MS = 8000;

function guard() {
  if (setting("diagGuard", true) === false) return 0;
  const now = Date.now();
  let n = 0;
  for (const c of diag.contexts) {
    if (c.lost || c.released || c.src.kind === "core") continue;
    const el = c.ref.deref();
    if (!el || !(el instanceof HTMLCanvasElement)) continue;
    if (el.isConnected) { c.wasConnected = true; c.detachedSince = 0; continue; }
    if (!c.wasConnected) continue;
    c.detachedSince ||= now;
    if (now - c.detachedSince < DETACHED_MS) continue;
    try {
      const gl = el.getContext(c.type);
      const ext = gl?.getExtension?.("WEBGL_lose_context");
      if (!ext) continue;
      c.released = now;
      ext.loseContext();
      c.lost ||= now;
      diag.released++;
      n++;
    } catch (_) { /* leave it */ }
  }
  if (n) console.info(`${MODULE_ID} | ${t("Diag.Released", { n })}`);
  return n;
}

// Keep an eye on which canvases are in the page; tidy up once there are a few.
setInterval(() => {
  try {
    for (const c of diag.contexts) {
      const el = c.lost ? null : c.ref.deref();
      if (el?.isConnected) { c.wasConnected = true; c.detachedSince = 0; }
    }
    if (aliveContexts() >= 6) guard();
  } catch (_) { /* never mind */ }
}, 4000);

function isMapCanvas(el) {
  try { return !!el && el === globalThis.canvas?.app?.view; } catch (_) { return false; }
}

function onContextLost(entry, el) {
  entry.lost = Date.now();
  // Only the map itself (Foundry's own test canvases at start-up are let go on purpose).
  if (!isMapCanvas(el)) return;
  diag.mapLost = true;
  if (!game.ready || setting("diagWatch", true) === false) return;
  sendReport("lost", true);
  const go = () => window.location.reload();
  foundry.applications.api.DialogV2.confirm({
    window: { title: t("Diag.LostTitle") },
    content: `<p>${t("Diag.LostBody", { n: diag.contexts.length })}</p><p class="hint">${t("Diag.LostHint")}</p>`,
    yes: { label: t("Diag.Reload"), icon: "fa-solid fa-rotate-right" },
    no: { label: t("Diag.Later") },
    rejectClose: false
  }).then(yes => { if (yes) go(); }).catch(() => {});
}

function warnMany() {
  if (!game.ready || setting("diagWatch", true) === false) return;
  ui.notifications?.warn(t("Diag.ManyContexts", { n: aliveContexts(), top: topContexts(2) }));
}

/** "Dice So Nice 5, Foundry VTT 2" — who opened the most. */
export function topContexts(limit = 3) {
  const by = new Map();
  for (const c of diag.contexts) by.set(c.src.id, (by.get(c.src.id) ?? 0) + 1);
  return [...by].sort((a, b) => b[1] - a[1]).slice(0, limit)
    .map(([id, n]) => `${packageName(diag.contexts.find(c => c.src.id === id)?.src)} ${n}`).join(", ");
}

/* ---------------- errors ---------------- */

function record(stack, text, fallbackStack = "") {
  try {
    let src = sourceOf(stack);
    if (src.kind === "unknown" && fallbackStack) src = sourceOf(fallbackStack);
    const key = `${src.kind}:${src.id}`;
    const e = diag.errors.get(key) ?? { src, count: 0, samples: new Map(), last: 0 };
    e.count++;
    e.last = Date.now();
    const line = String(text ?? "").split("\n")[0].slice(0, 240);
    if (e.samples.has(line) || e.samples.size < 6) e.samples.set(line, (e.samples.get(line) ?? 0) + 1);
    diag.errors.set(key, e);
  } catch (_) { /* never throw from here */ }
}

window.addEventListener("error", ev => {
  // A file that failed to load in the page (img, audio, video, link) comes here too — see missing files.
  const el = ev.target;
  if (el && el !== window && el instanceof Element) {
    const url = el.currentSrc || el.src || el.href;
    if (url) noteMissing(url, 0);
    return;
  }
  record(ev.error?.stack ?? `at ${ev.filename ?? ""}`, ev.message ?? String(ev.error ?? ""));
}, true);

window.addEventListener("unhandledrejection", ev => {
  const r = ev.reason;
  record(r?.stack ?? "", r?.message ?? String(r ?? ""));
});

Hooks.on("error", (location, error) => {
  record(error?.stack ?? "", `${location ?? ""}: ${error?.message ?? error ?? ""}`);
});

/* ---------------- missing files ---------------- */

function pathOf(url) {
  try {
    const u = new URL(url, window.location.href);
    if (u.origin !== window.location.origin) return null;
    return u.pathname;
  } catch (_) { return null; }
}

function decodePath(path) {
  try { return decodeURIComponent(path); } catch (_) { return path; }
}

function groupOf(path) {
  const p = decodePath(path).replace(/^\/+/, "");
  const m = /^(modules|systems|worlds)\/([^/]+)\//.exec(p);
  if (m) return `${m[1]}/${m[2]}`;
  return p.split("/")[0] || "/";
}

function noteMissing(url, status) {
  const path = pathOf(url);
  if (!path) return;
  const m = diag.missing.get(path) ?? { url, status, count: 0, group: groupOf(path) };
  m.count++;
  if (status) m.status = status;
  diag.missing.set(path, m);
}

try {
  performance.setResourceTimingBufferSize?.(4000);
  const po = new PerformanceObserver(list => {
    for (const e of list.getEntries()) {
      const s = Number(e.responseStatus ?? 0);
      if (s === 404 || s === 403 || s === 410 || s >= 500) noteMissing(e.name, s);
    }
  });
  po.observe({ type: "resource", buffered: true });
} catch (_) { /* older browser: element errors only */ }

/* ---------------- stuck roll cards ---------------- */

function chatLog() {
  const root = ui.chat?.element;
  const el = root instanceof HTMLElement ? root : root?.[0];
  return el?.querySelector?.(".chat-log") ?? document.querySelector("#chat .chat-log");
}

function isHidden(el) {
  return el.hidden || el.classList.contains("dsn-hide") || getComputedStyle(el).display === "none";
}

/** The first message after this one that is in the log (to put a missing card back in its place). */
function nextShown(message, log) {
  const list = game.messages.contents;
  for (let i = list.indexOf(message) + 1; i < list.length; i++) {
    if (log.querySelector(`[data-message-id="${list[i].id}"]`)) return list[i].id;
  }
  return undefined;
}

async function checkCard(message, tries) {
  if (!game.messages.get(message.id) || !message.visible) return;
  const log = chatLog();
  if (!log) return;
  const el = log.querySelector(`[data-message-id="${message.id}"]`);
  if (el && !isHidden(el)) return;
  // Dice So Nice still throwing dice: give it more time (up to about 40 s).
  if (tries < 6 && game.dice3d?.box?.rolling) { setTimeout(() => checkCard(message, tries + 1), 5000); return; }
  try {
    message._dice3danimating = false;
    if (el) {
      el.classList.remove("dsn-hide");
      el.hidden = false;
      if (el.style.display === "none") el.style.display = "";
      if (getComputedStyle(el).display === "none") await ui.chat.updateMessage(message);
    } else {
      await ui.chat.postOne(message, { before: nextShown(message, log), notify: false });
    }
    diag.rescued++;
    console.warn(`${MODULE_ID} | ${t("Diag.Rescued")}`, message.id);
    sendReport("rescue");
  } catch (err) {
    record(err?.stack ?? "", `chat card: ${err?.message ?? err}`);
  }
}

/* ---------------- chat: whose clock is off ---------------- */

// A message's time is stamped by its author's computer. Arriving here, the difference to this clock is
// the network delay plus how far apart the two clocks are; well over a second means a clock is off.
Hooks.on("createChatMessage", message => {
  const author = message.author ?? message.user;
  if (!author || !Number(message.timestamp)) return;
  const skew = Date.now() - Number(message.timestamp);
  const c = diag.clocks.get(author.id) ?? { name: author.name, skew, n: 0 };
  c.skew = c.n ? Math.round((c.skew * c.n + skew) / (c.n + 1)) : skew;
  c.n++;
  diag.clocks.set(author.id, c);
});

/** The last cards of the chat log, as the screen shows them, with what looks wrong about them. */
export function chatAudit(limit = 30) {
  const log = chatLog();
  const items = log ? [...log.querySelectorAll(":scope > .chat-message[data-message-id], :scope > li.message[data-message-id]")].slice(-limit) : [];
  const order = new Map(game.messages.contents.map((m, i) => [m.id, i]));
  const rows = [];
  let prev = null;
  for (const el of items) {
    const m = game.messages.get(el.dataset.messageId);
    if (!m) continue;
    const author = m.author ?? m.user;
    const row = {
      id: m.id, time: Number(m.timestamp) || 0, user: author?.name ?? "?", userId: author?.id ?? "", alias: m.speaker?.alias ?? "",
      actor: m.speaker?.actor ?? null, token: m.speaker?.token ?? null, style: m.style ?? null, typed: el.classList.contains("pkh-chat-message"),
      grouped: el.classList.contains("pkh-grouped"), hidden: el.classList.contains("pkh-note-message") || getComputedStyle(el).display === "none",
      index: order.get(m.id) ?? -1, text: (el.querySelector(".message-content")?.textContent ?? "").trim().slice(0, 40), issues: []
    };
    if (row.grouped) {
      const above = rows.findLast?.(r => !r.hidden) ?? [...rows].reverse().find(r => !r.hidden);
      if (above && (above.userId !== row.userId || above.alias !== row.alias)) row.issues.push("mixed");
    }
    if (prev && row.index >= 0 && prev.index > row.index) row.issues.push("order");
    if (prev && row.time && prev.time && row.time + 1000 < prev.time) row.issues.push("time");
    rows.push(row);
    prev = row;
  }
  const clocks = [...diag.clocks.values()].filter(c => c.n >= 2 && Math.abs(c.skew) > 3000);
  return { rows, version: globalThis.pkhChatGrouping ?? null, clocks };
}

Hooks.on("createChatMessage", message => {
  if (setting("chatRescue", true) === false) return;
  if (!(message.rolls?.length || message.isRoll) || !message.visible) return;
  setTimeout(() => checkCard(message, 0), 9000);
});

/* ---------------- this computer ---------------- */

const PERF = () => CONST.CANVAS_PERFORMANCE_MODES ?? { LOW: 0, MED: 1, HIGH: 2, MAX: 3 };

export function performanceMode() {
  try { return Number(game.settings.get("core", "performanceMode")); } catch (_) { return null; }
}

export function perfLabel(mode) {
  const name = Object.entries(PERF()).find(([, v]) => v === mode)?.[0];
  return name ? t(`Diag.Perf.${name}`) : "?";
}

export function gpuName() {
  try {
    const gl = globalThis.canvas?.app?.renderer?.gl;
    const ext = gl?.getExtension?.("WEBGL_debug_renderer_info");
    return ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : "";
  } catch (_) { return ""; }
}

export function mapLostNow() {
  try { return !!globalThis.canvas?.app?.renderer?.gl?.isContextLost?.() || diag.mapLost; } catch (_) { return diag.mapLost; }
}

/** Dice So Nice: does this user show roll cards at once, without waiting for the dice? */
export function dsnImmediate() {
  if (!game.modules.get("dice-so-nice")?.active) return null;
  const s = game.user.getFlag?.("dice-so-nice", "settings");
  return s ? !!s.immediatelyDisplayChatMessages : false;
}

export async function setDsnImmediate() {
  const s = foundry.utils.deepClone(game.user.getFlag("dice-so-nice", "settings") ?? {});
  s.immediatelyDisplayChatMessages = true;
  await game.user.setFlag("dice-so-nice", "settings", s);
}

/* ---------------- reports (players → GM) ---------------- */

export function summary() {
  const by = {};
  for (const c of diag.contexts) by[c.src.id] = (by[c.src.id] ?? 0) + 1;
  return {
    userId: game.user.id, user: game.user.name, at: Date.now(), since: diag.started,
    contexts: diag.contexts.length, alive: aliveContexts(), contextsBy: by, mapLost: mapLostNow(),
    errors: [...diag.errors.values()].sort((a, b) => b.count - a.count).slice(0, 8)
      .map(e => ({ src: e.src, count: e.count, sample: [...e.samples.keys()][0] ?? "" })),
    missing: diag.missing.size, missingGroups: [...new Set([...diag.missing.values()].map(m => m.group))].slice(0, 8),
    rescued: diag.rescued, released: diag.released, perf: performanceMode(), dsn: dsnImmediate(), gpu: gpuName(),
    chat: globalThis.pkhChatGrouping ?? null, hud: game.modules.get(MODULE_ID)?.version ?? ""
  };
}

let lastSent = 0;
function sendReport(why = "", urgent = false) {
  if (game.user.isGM || !game.ready) return;
  if (why !== "ask" && !urgent && Date.now() - lastSent < 30000) return;
  lastSent = Date.now();
  game.socket?.emit(SOCKET, { action: "diag-report", why, report: summary() });
}

export function askReports() {
  if (!game.user.isGM) return;
  game.socket?.emit(SOCKET, { action: "diag-ask" });
}

export function initDiagnostics() {
  game.socket?.on(SOCKET, payload => {
    if (payload?.action === "diag-ask" && !game.user.isGM) sendReport("ask");
    if (payload?.action === "diag-report" && game.user.isGM && payload.report?.userId) {
      diag.reports.set(payload.report.userId, payload.report);
      if (payload.why === "lost" && setting("diagWatch", true) !== false) ui.notifications?.warn(t("Diag.PlayerLost", { user: payload.report.user }));
      Hooks.callAll("pkhDiagnosticsReport", payload.report);
    }
  });
}
