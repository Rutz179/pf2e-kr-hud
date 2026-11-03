import { MODULE_ID, setting, t } from "./shared.mjs";

/* ======================================================================== *
 * Shared notes → one journal entry, kept up to date.
 *
 * The notes panel's entries are chat messages (side-panels.js). Here the
 * active GM's client copies them into a journal entry as they are written,
 * edited or deleted, so the party's notes read as one page instead of a new
 * "export" journal every time.
 *
 *   세션마다 하나 (default)  one journal per play session: a pause of more
 *                             than 8 hours between notes starts the next one
 *                             (a session that runs past midnight stays one)
 *   전체 하나                 one journal for the whole campaign
 *   모으지 않음               the old export button
 *
 * The journal keeps its own copy of every note (in its flags), so clearing
 * the chat log leaves it as it is; only a note deleted from the panel is
 * taken out. Notes written while no GM is on are added when one comes in.
 * The page is rewritten from that copy, so the GM's own writing goes on
 * another page of the same journal.
 * Notes are always created for everyone (side-panels.js); an older private
 * one is put out again by its author (publishOwnNotes).
 * ======================================================================== */

const NOTE_FLAG = "note";
const KEY = "notesJournal";            // flag on our journals: "all", or a session's day "2026-10-28"
const GAP = 8 * 3600 * 1000;
export const NOTE_DELETE = "pkhNoteDelete";   // option on a note deleted from the panel

export const notesMode = () => setting("notesJournal", "session");

function isKeeper() {
  const gm = game.users?.activeGM;
  if (gm) return gm.id === game.user.id;
  return !!game.user?.isGM;
}

const isNote = message => !!message?.flags?.[MODULE_ID]?.[NOTE_FLAG];
const ours = () => (game.journal?.contents ?? []).filter(j => j.flags?.[MODULE_ID]?.[KEY]);
const pad = n => String(n).padStart(2, "0");
const dayKey = ts => { const d = new Date(ts); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const dayLabel = ts => new Date(ts).toLocaleDateString(game.i18n.lang, { year: "numeric", month: "long", day: "numeric", weekday: "short" });
const timeLabel = ts => new Date(ts).toLocaleTimeString(game.i18n.lang, { hour: "2-digit", minute: "2-digit" });
const esc = s => foundry.utils.escapeHTML(String(s ?? ""));

function plainText(message) {
  const div = document.createElement("div");
  div.innerHTML = String(message.content ?? "").replace(/<br\s*\/?>/gi, "\n");
  return (div.textContent ?? "").trim();
}

function entryOf(message) {
  const author = message.author ?? message.user;
  return { a: author?.name ?? "?", t: Number(message.timestamp) || Date.now(), x: plainText(message) };
}

/* ---------------- the page ---------------- */

function pageHtml(notes, single) {
  const list = Object.values(notes).filter(Boolean).sort((a, b) => a.t - b.t);
  const out = [`<p><em>${esc(t("Panels.Notes.PageIntro"))}</em></p>`];
  let day = null;
  for (const n of list) {
    if (single && dayKey(n.t) !== day) { day = dayKey(n.t); out.push(`<h3>${esc(dayLabel(n.t))}</h3>`); }
    out.push(`<p><strong>${esc(n.a)}</strong> <span style="opacity:.6">${esc(timeLabel(n.t))}</span><br>${esc(n.x).replace(/\n/g, "<br>")}</p>`);
  }
  return out.join("");
}

/* ---------------- keeping the journals ---------------- */

function recordOf(doc) {
  const f = doc.flags[MODULE_ID];
  return { doc, key: f[KEY], first: f.first ?? Infinity, last: f.last ?? -Infinity, notes: { ...(f.notes ?? {}) }, dirty: false };
}

async function notesFolder() {
  const found = game.folders?.find(f => f.type === "JournalEntry" && f.flags?.[MODULE_ID]?.notesFolder);
  if (found) return found.id;
  try {
    const made = await Folder.implementation.create({ name: t("Panels.Notes.Folder"), type: "JournalEntry", flags: { [MODULE_ID]: { notesFolder: true } } });
    return made?.id ?? null;
  } catch (err) { console.warn(`${MODULE_ID} | notes folder`, err); return null; }
}

async function write(records, single) {
  for (const r of records.filter(x => x.dirty)) {
    const live = Object.values(r.notes).filter(Boolean);
    const first = live.length ? Math.min(...live.map(n => n.t)) : r.first;
    const last = live.length ? Math.max(...live.map(n => n.t)) : r.last;
    const content = pageHtml(r.notes, single);
    if (!r.doc) {
      if (!live.length) continue;
      const name = single ? t("Panels.Notes.SingleName") : t("Panels.Notes.SessionName", { date: dayLabel(first) });
      r.doc = await JournalEntry.implementation.create({
        name, folder: single ? null : await notesFolder(),
        ownership: { default: CONST.DOCUMENT_OWNERSHIP_LEVELS.OBSERVER },
        flags: { [MODULE_ID]: { [KEY]: r.key, first, last, notes: r.notes } },
        pages: [{ name: t("Panels.Notes.Page"), type: "text", text: { content }, flags: { [MODULE_ID]: { notesPage: true } } }]
      });
      continue;
    }
    await r.doc.update({ [`flags.${MODULE_ID}`]: { notes: r.notes, first, last } });
    const page = r.doc.pages.find(p => p.flags?.[MODULE_ID]?.notesPage);
    if (page) await page.update({ "text.content": content });
    else await r.doc.createEmbeddedDocuments("JournalEntryPage", [{ name: t("Panels.Notes.Page"), type: "text", text: { content }, flags: { [MODULE_ID]: { notesPage: true } } }]);
  }
}

const same = (a, b) => !!a && !!b && a.a === b.a && a.t === b.t && a.x === b.x;

async function apply(ups, dels) {
  const mode = notesMode();
  if (mode === "off" || !isKeeper()) return;
  const single = mode === "single";
  let records;
  if (single) {
    const doc = ours().find(j => j.flags[MODULE_ID][KEY] === "all");
    records = [doc ? recordOf(doc) : { doc: null, key: "all", first: Infinity, last: -Infinity, notes: {}, dirty: false }];
  } else {
    records = ours().filter(j => j.flags[MODULE_ID][KEY] !== "all").map(recordOf);
  }
  for (const id of dels) for (const r of records) if (r.notes[id]) { r.notes[id] = null; r.dirty = true; }
  for (const { id, entry } of [...ups].sort((a, b) => a.entry.t - b.entry.t)) {
    let r = records.find(x => x.notes[id]);
    if (!r && single) r = records[0];
    if (!r) r = records.find(x => entry.t >= x.first - GAP && entry.t <= x.last + GAP);
    if (!r) {
      let key = dayKey(entry.t), n = 2;
      while (records.some(x => x.key === key)) key = `${dayKey(entry.t)} (${n++})`;
      r = { doc: null, key, first: entry.t, last: entry.t, notes: {}, dirty: false };
      records.push(r);
    }
    if (same(r.notes[id], entry)) continue;
    r.notes[id] = entry;
    r.first = Math.min(r.first, entry.t);
    r.last = Math.max(r.last, entry.t);
    r.dirty = true;
  }
  await write(records, single);
}

/* One write at a time; changes that come close together go in one write. */
const pending = { ups: new Map(), dels: new Set() };
let chain = Promise.resolve();
let timer = 0;
function schedule(ms = 400) {
  clearTimeout(timer);
  timer = setTimeout(() => {
    const ups = [...pending.ups.values()];
    const dels = [...pending.dels];
    pending.ups.clear(); pending.dels.clear();
    chain = chain.then(() => apply(ups, dels)).catch(err => console.warn(`${MODULE_ID} | notes journal`, err));
  }, ms);
}

function queueNote(message) {
  pending.dels.delete(message.id);
  pending.ups.set(message.id, { id: message.id, entry: entryOf(message) });
  schedule();
}

/** Every note still in the chat log goes in (the ones written while no GM was on, a mode just switched on). */
function syncAll() {
  if (notesMode() === "off" || !isKeeper()) return;
  for (const message of game.messages.contents) if (isNote(message)) queueNote(message);
}

/*
 * A note saved as a private message (before notes were made public on purpose,
 * the chat's "self" or "blind" mode could go with it) never reaches the GM.
 * Its author's computer puts it out again for everyone — the same text and
 * time — when the world loads and when a GM comes in, so the GM gets it live.
 */
const isPublic = message => !(message.whisper?.length) && !message.blind;
let publishing = false;
export async function publishOwnNotes() {
  if (publishing) return;
  publishing = true;
  try {
    const mine = game.messages.contents.filter(m => isNote(m) && m.isAuthor && !isPublic(m));
    for (const m of mine) {
      const data = { content: m.content, timestamp: m.timestamp, speaker: m.speaker, whisper: [], blind: false, flags: foundry.utils.deepClone(m.flags ?? {}) };
      try {
        await m.delete();
        await ChatMessage.implementation.create(data, { messageMode: "public" });
      } catch (err) {
        // Not allowed to delete it here: open it up instead (the GM gets it on the next load).
        try { await m.update({ whisper: [], blind: false }); } catch (_) { console.warn(`${MODULE_ID} | could not share a note`, err); }
      }
    }
  } finally { publishing = false; }
}

/** The notes journal to read: the latest session's, or the campaign's. */
export function currentNotesJournal() {
  const mode = notesMode();
  const list = ours().filter(j => (mode === "single") === (j.flags[MODULE_ID][KEY] === "all"));
  return list.sort((a, b) => (b.flags[MODULE_ID].last ?? 0) - (a.flags[MODULE_ID].last ?? 0))[0] ?? null;
}

export function openNotesJournal() {
  const journal = currentNotesJournal();
  if (journal?.testUserPermission?.(game.user, "OBSERVER") === false) return ui.notifications.warn(`PF2e-KR HUD | ${t("Panels.Notes.NoAccess")}`);
  if (journal) return journal.sheet?.render(true);
  if (isKeeper()) { syncAll(); setTimeout(() => currentNotesJournal()?.sheet?.render(true), 1200); return; }
  ui.notifications.info(`PF2e-KR HUD | ${t("Panels.Notes.NoJournalYet")}`);
}

export function registerNotesJournalSettings() {
  game.settings.register(MODULE_ID, "notesJournal", {
    name: "PKH.Settings.notesJournal.Name",
    hint: "PKH.Settings.notesJournal.Hint",
    scope: "world", config: true, type: String, default: "session",
    choices: {
      session: "PKH.Settings.notesJournal.Choices.session",
      single: "PKH.Settings.notesJournal.Choices.single",
      off: "PKH.Settings.notesJournal.Choices.off"
    },
    onChange: () => { syncAll(); Hooks.callAll("pkhNotesModeChanged"); }
  });
}

export function initNotesJournal() {
  Hooks.on("createChatMessage", message => { if (isNote(message) && isKeeper()) queueNote(message); });
  Hooks.on("updateChatMessage", (message, changes) => {
    if (isNote(message) && isKeeper() && ("content" in (changes ?? {}))) queueNote(message);
  });
  // Only a note deleted from the panel leaves the journal; clearing the chat log doesn't touch it.
  Hooks.on("deleteChatMessage", (message, options) => {
    if (!isNote(message) || !isKeeper() || !options?.[NOTE_DELETE]) return;
    pending.ups.delete(message.id);
    pending.dels.add(message.id);
    schedule();
  });
  setTimeout(syncAll, 1500);
  setTimeout(() => publishOwnNotes().catch(err => console.warn(`${MODULE_ID} | notes`, err)), 2000);
  Hooks.on("userConnected", (user, connected) => {
    if (connected && user?.isGM && user.id !== game.user.id) setTimeout(() => publishOwnNotes().catch(() => {}), 1500);
  });
}
