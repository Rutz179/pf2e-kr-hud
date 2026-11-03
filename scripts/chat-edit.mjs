import { MODULE_ID, setting, t } from "./shared.mjs";

/* ======================================================================== *
 * Editing a chat message that was already sent (like the "Anduril's Chat
 * Edit" idea, written from scratch for the HUD).
 *
 * Your own typed lines — talk, emotes, OOC, whispers — can be corrected in
 * place: right-click → "메시지 수정", or the small pen that shows on hover.
 * Enter saves (Shift+Enter for a new line), Esc cancels. The line then
 * carries "(수정됨)", with the time of the change on hover. The GM can fix
 * anyone's typed line. Rolls, item and action cards, and shared notes are
 * left alone (cards have their own data; notes are edited in their panel).
 * Polyglot's language stays as it was: only the text changes.
 * ======================================================================== */

const EDITED = "edited";

const asElement = li => (li instanceof HTMLElement ? li : li?.[0] ?? null);
const messageOf = li => game.messages.get(asElement(li)?.dataset?.messageId ?? "");

/** Lines someone typed: no rolls, no cards, no notes. */
function typedLine(message) {
  if (!message || message.isRoll || message.rolls?.length) return false;
  const flags = message.flags ?? {};
  if (flags[MODULE_ID]?.note) return false;
  const pf2e = flags.pf2e ?? {};
  if (pf2e.context || pf2e.origin || pf2e.casting || pf2e.strike || pf2e.appliedDamage) return false;
  const html = String(message.content ?? "");
  return !/<(div|section|article|table|img|video|button|form|input|header|footer|h[1-6]|ul|ol)\b|data-(uuid|action|pf2|roll)|class="[^"]*(inline-roll|chat-card|card-content)/i.test(html);
}

export function canEdit(message) {
  if (setting("chatEdit", true) === false) return false;
  if (!(message?.isAuthor || game.user.isGM)) return false;
  return typedLine(message);
}

/* What the box shows: the line with its breaks; what is saved: the same shape the line had. */
function toText(content) {
  return String(content ?? "")
    .replace(/^\s*<p>/i, "").replace(/<\/p>\s*$/i, "")
    .replace(/<\/p>\s*<p>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n");
}
function toContent(text, original) {
  const body = text.replace(/\r/g, "").replace(/\n/g, "<br>");
  return /^\s*<p>[\s\S]*<\/p>\s*$/i.test(String(original ?? "")) ? `<p>${body}</p>` : body;
}

function startEdit(message, li) {
  const el = asElement(li);
  const box = el?.querySelector(".message-content");
  if (!box || el.classList.contains("pkh-editing")) return;
  el.classList.add("pkh-editing");
  const kept = [...box.childNodes];
  const area = document.createElement("textarea");
  area.className = "pkh-chat-edit";
  area.value = toText(message.content);
  area.rows = Math.min(8, Math.max(2, area.value.split("\n").length + 1));
  const bar = document.createElement("div");
  bar.className = "pkh-chat-edit-bar";
  bar.innerHTML = `<span>${foundry.utils.escapeHTML(t("ChatEdit.Hint"))}</span>
    <button type="button" data-edit="cancel">${foundry.utils.escapeHTML(t("Common.Cancel"))}</button>
    <button type="button" data-edit="save" class="go">${foundry.utils.escapeHTML(t("Common.Save"))}</button>`;
  box.replaceChildren(area, bar);
  area.focus();
  area.setSelectionRange(area.value.length, area.value.length);

  const close = () => { el.classList.remove("pkh-editing"); box.replaceChildren(...kept); };
  const save = async () => {
    const text = area.value.trim();
    if (!text) return close();
    const content = toContent(text, message.content);
    if (content === message.content) return close();
    area.disabled = true;
    try {
      // The card is drawn again from the new text; nothing else to put back.
      await message.update({ content, [`flags.${MODULE_ID}.${EDITED}`]: Date.now() });
    } catch (err) {
      console.error(`${MODULE_ID} | chat edit`, err);
      ui.notifications.error(`PF2e-KR HUD | ${t("ChatEdit.Failed")}`);
      close();
    }
  };
  area.addEventListener("keydown", ev => {
    ev.stopPropagation();
    if (ev.isComposing) return;                              // Korean input: Enter ends the syllable first
    if (ev.key === "Escape") { ev.preventDefault(); close(); }
    else if (ev.key === "Enter" && !ev.shiftKey) { ev.preventDefault(); save(); }
  });
  bar.addEventListener("click", ev => {
    const b = ev.target.closest("[data-edit]");
    if (!b) return;
    ev.preventDefault();
    if (b.dataset.edit === "save") save(); else close();
  });
}

/* ---------------- drawing: the label and the pen ---------------- */

function decorate(message, html) {
  const el = asElement(html);
  if (!el) return;
  const at = message.flags?.[MODULE_ID]?.[EDITED];
  if (at) {
    // After the other render hooks (Polyglot fills the content in its own).
    setTimeout(() => {
      const box = el.querySelector(".message-content");
      if (!box || box.querySelector(".pkh-edited")) return;
      const tag = document.createElement("span");
      tag.className = "pkh-edited";
      tag.textContent = t("ChatEdit.Edited");
      tag.dataset.tooltip = t("ChatEdit.EditedAt", { time: new Date(at).toLocaleString(game.i18n.lang) });
      (box.querySelector(":scope > p:last-child") ?? box).append(" ", tag);
    }, 0);
  }
  if (!message.isAuthor || !canEdit(message)) return;
  el.classList.add("pkh-can-edit");
  const pen = document.createElement("button");
  pen.type = "button";
  pen.className = "pkh-edit-btn";
  pen.dataset.tooltip = t("ChatEdit.Edit");
  pen.setAttribute("aria-label", t("ChatEdit.Edit"));
  pen.innerHTML = `<i class="fa-solid fa-pen"></i>`;
  pen.addEventListener("click", ev => { ev.preventDefault(); ev.stopPropagation(); startEdit(message, el); });
  el.append(pen);
}

function contextOption() {
  return {
    name: "PKH.ChatEdit.Edit",
    icon: '<i class="fa-solid fa-pen"></i>',
    condition: li => canEdit(messageOf(li)),
    callback: li => { const m = messageOf(li); if (m) startEdit(m, li); }
  };
}

export function registerChatEditSettings() {
  game.settings.register(MODULE_ID, "chatEdit", {
    name: "PKH.Settings.chatEdit.Name", hint: "PKH.Settings.chatEdit.Hint",
    scope: "world", config: true, type: Boolean, default: true
  });
}

export function initChatEdit() {
  Hooks.on("renderChatMessageHTML", decorate);
  // v13: getChatMessageContextOptions (the old name still fires, with a warning, so only one of them)
  if ((game.release?.generation ?? 13) >= 13) Hooks.on("getChatMessageContextOptions", (_app, options) => { options.push(contextOption()); });
  else Hooks.on("getChatLogEntryContext", (_html, options) => { options.push(contextOption()); });
}
