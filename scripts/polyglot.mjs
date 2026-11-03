/* ======================================================================== *
 * Polyglot (mclemente/fvtt-module-polyglot) — compatibility
 *
 * Polyglot marks a typed line with the language it was spoken in
 * (flags.polyglot.language) and, in the chat log, shows it in that language's
 * script to whoever doesn't know it. The HUD shows the same lines elsewhere —
 * the portrait speech bubbles and the whisper panel — so they ask here how a
 * line looks to this user, with Polyglot's own rule and Polyglot's own
 * scrambling, and never show text the chat log hides.
 *
 * Nothing here runs without Polyglot: every helper returns "plain text".
 * ======================================================================== */

export function polyglotActive() {
  return !!game.modules?.get?.("polyglot")?.active && !!game.polyglot;
}

/** The language a line was spoken in ("" for none). Not getFlag: it throws when Polyglot is off. */
export function polyglotLanguage(message) {
  return String(message?.flags?.polyglot?.language ?? "");
}

/**
 * Whether this user can't read the line — the same test Polyglot uses when it
 * draws the message (renderChatMessageHTML): the GM reads everything unless
 * "runify for GM" is on; Tongues / Comprehend Languages / omniglot count.
 */
export function polyglotUnknown(message) {
  const lang = polyglotLanguage(message);
  if (!lang || !polyglotActive()) return false;
  const pg = game.polyglot;
  try {
    const isGM = !!game.user?.isGM;
    if (isGM && !pg.settings?.runifyGM) return false;
    if (message.polyglot_force) return false;                 // the GM clicked the globe: shown translated
    if (pg._isTruespeech?.(lang)) return false;
    if (pg.isLanguageKnown?.(lang)) return false;
    return game.user?.character || isGM ? !pg.isLanguageUnderstood?.(lang) : true;
  } catch (err) {
    console.warn("pf2e-kr-hud | Polyglot check failed", err);
    return false;
  }
}

/**
 * A line's plain text as this user may read it.
 * → { text, font }: font is Polyglot's CSS `font` value ("120% Thorass") when
 *   the text was turned into that language's script, "" otherwise.
 */
export function polyglotText(message, text) {
  if (!text || !polyglotUnknown(message)) return { text, font: "" };
  const lang = polyglotLanguage(message);
  try {
    return {
      text: game.polyglot.scrambleString(text, message.id, lang),
      font: String(game.polyglot._getFontStyle?.(lang) ?? "")
    };
  } catch (err) {
    console.warn("pf2e-kr-hud | Polyglot scramble failed", err);
    return { text: "…", font: "" };
  }
}

/** Fill an element with the text, in the language's script when it is one (a span, like Polyglot's own). */
export function fillPolyglot(el, { text, font }) {
  if (!el) return;
  if (!font) { el.textContent = text ?? ""; return; }
  const span = document.createElement("span");
  span.className = "pkh-polyglot";
  span.style.font = font;
  span.textContent = text ?? "";
  el.replaceChildren(span);
}

/* ------------------------------------------------------------------------ *
 * The GM's language list: Polyglot offers the GM every language the system
 * has. The GM ticks the ones the table uses; the others stay out of the
 * chat's language picker (only out of the picker — the GM still reads them).
 * ------------------------------------------------------------------------ */

const MID = "pf2e-kr-hud";
const hiddenLangs = () => { try { return new Set(game.settings.get(MID, "polyglotHidden") ?? []); } catch { return new Set(); } };

/** Every language Polyglot knows → [{ id, label, who: [PC names that know it] }]. */
function languageRows() {
  const pg = game.polyglot;
  const langs = pg?.provider?.languages ?? {};
  const pcs = game.actors.filter(a => a.hasPlayerOwner && a.type === "character");
  const knows = new Map(pcs.map(a => { try { return [a, pg.getUserLanguages([a])[0]]; } catch { return [a, new Set()]; } }));
  return Object.keys(langs).map(id => ({ id, label: langs[id]?.label || id, who: pcs.filter(a => knows.get(a)?.has(id)).map(a => a.name) }))
    .sort((a, b) => (b.who.length > 0) - (a.who.length > 0) || a.label.localeCompare(b.label, game.i18n.lang));
}

/** Take the hidden languages out of the picker after Polyglot fills it. */
function filterPicker() {
  const pg = game.polyglot, ts = pg?.tomSelect;
  if (!game.user.isGM || !ts) return;
  const hidden = hiddenLangs();
  if (!hidden.size) return;
  const current = ts.getValue?.();
  for (const id of Object.keys(ts.options ?? {})) if (hidden.has(id)) ts.removeOption(id, true);
  if (current && hidden.has(current)) {
    const fallback = Object.keys(ts.options ?? {}).includes(pg.defaultLanguage) ? pg.defaultLanguage : Object.keys(ts.options ?? {})[0];
    if (fallback) ts.addItem(fallback, true);
  }
}

function wrapPolyglot() {
  const pg = game.polyglot;
  if (!pg || pg._pkhWrapped || typeof pg.updateUserLanguages !== "function") return;
  const original = pg.updateUserLanguages;
  pg.updateUserLanguages = function (...args) {
    const out = original.apply(this, args);
    try { filterPicker(); } catch (err) { console.warn(`${MID} | Polyglot language filter`, err); }
    return out;
  };
  pg._pkhWrapped = true;
  pg.updateUserLanguages();
}

export function openPolyglotLanguages() {
  if (!game.user.isGM || !polyglotActive()) return;
  const hidden = hiddenLangs();
  const rows = languageRows();
  const esc = s => foundry.utils.escapeHTML(String(s ?? ""));
  const L = k => game.i18n.localize(`PKH.Polyglot.${k}`);
  const html = `<div class="pkh-pg-langs"><p class="hint">${L("Hint")}</p>
    <div class="row"><button type="button" data-pg="pcs">${L("OnlyPcs")}</button><button type="button" data-pg="all">${L("ShowAll")}</button></div>
    <div class="list">${rows.map(r => `<label><input type="checkbox" data-lang="${esc(r.id)}" ${hidden.has(r.id) ? "" : "checked"}> <b>${esc(r.label)}</b>${r.who.length ? ` <small>${esc(r.who.join(", "))}</small>` : ""}</label>`).join("")}</div>
    <footer><button type="button" class="go" data-pg="save"><i class="fa-solid fa-check"></i> ${L("Save")}</button></footer></div>`;
  const win = new SimpleWindowLite(html, root => {
    const boxes = () => [...root.querySelectorAll("[data-lang]")];
    root.querySelector('[data-pg="pcs"]').onclick = () => { for (const b of boxes()) b.checked = rows.find(r => r.id === b.dataset.lang)?.who.length > 0 || b.dataset.lang === game.polyglot.defaultLanguage; };
    root.querySelector('[data-pg="all"]').onclick = () => { for (const b of boxes()) b.checked = true; };
    root.querySelector('[data-pg="save"]').onclick = async () => {
      await game.settings.set(MID, "polyglotHidden", boxes().filter(b => !b.checked).map(b => b.dataset.lang));
      win.close();
    };
  });
  win.render(true);
}

class SimpleWindowLite extends foundry.applications.api.ApplicationV2 {
  constructor(html, onRender) {
    super({ id: "pkh-polyglot-langs", window: { title: "PKH.Polyglot.Title", icon: "fa-solid fa-language", resizable: true }, position: { width: 380, height: 560 }, classes: ["pkh-window"] });
    this._html = html; this._cb = onRender;
  }
  async _renderHTML() { return this._html; }
  _replaceHTML(result, content) { content.innerHTML = result; this._cb(content); }
}

class PolyglotLangMenu extends foundry.applications.api.ApplicationV2 {
  render() { openPolyglotLanguages(); return this; }
}

/** A small button beside Polyglot's picker (GM): opens the list. */
function addPickerButton() {
  if (!game.user.isGM) return;
  for (const box of document.querySelectorAll(".polyglot-lang-select")) {
    if (box.querySelector(".pkh-pg-btn")) continue;
    const b = document.createElement("button");
    b.type = "button"; b.className = "pkh-pg-btn"; b.innerHTML = `<i class="fa-solid fa-language"></i>`;
    b.dataset.tooltip = game.i18n.localize("PKH.Polyglot.Title");
    b.addEventListener("click", ev => { ev.preventDefault(); ev.stopPropagation(); openPolyglotLanguages(); });
    box.append(b);
  }
}

export function registerPolyglotSettings() {
  if (!game.modules.get("polyglot")?.active) return;
  game.settings.register(MID, "polyglotHidden", {
    scope: "world", config: false, type: Array, default: [],
    onChange: () => game.polyglot?.updateUserLanguages?.()
  });
  game.settings.registerMenu(MID, "polyglotLangMenu", {
    name: "PKH.Polyglot.Title", label: "PKH.Polyglot.Open", hint: "PKH.Polyglot.Hint",
    icon: "fa-solid fa-language", type: PolyglotLangMenu, restricted: true
  });
  Hooks.once("polyglot.ready", () => setTimeout(wrapPolyglot, 0));
  Hooks.once("ready", () => setTimeout(() => { wrapPolyglot(); addPickerButton(); }, 500));
  Hooks.on("renderChatInput", () => setTimeout(addPickerButton, 50));
}
