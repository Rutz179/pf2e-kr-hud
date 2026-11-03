import { MODULE_ID, setting, t } from "./shared.mjs";

/* ======================================================================== *
 * Long sessions: keep the chat light, and a "jump to the newest" button.
 *
 * Every chat card stays in the page until you reload, and a 4–6 hour session
 * with long fights piles up hundreds of heavy PF2e cards. That slows every
 * new message, and late in a session it shows up as lag, effects or music not
 * loading, or a roll that never appears for one player until they reload.
 *
 * Here (same idea as the Less Chat module, written from scratch for the HUD):
 *  - Only the newest N cards stay in the page (setting, 80 by default). Older
 *    ones are taken out of the page — the messages themselves are untouched —
 *    and only while you are reading the bottom of the chat, so nothing jumps
 *    under you while you scroll back.
 *  - Scroll up and they come back, a batch at a time, in order: Foundry's own
 *    "load older messages" is asked for them first, then continues as usual.
 *  - A small ↓ button appears in the corner of the chat while you are scrolled
 *    up; it takes you straight to the newest message.
 * ======================================================================== */

const pruned = new WeakMap();      // chat app → [message ids taken out, oldest first]
let pruneTimer = 0;
let lessChat = false;              // Less Chat does the same job: then only the ↓ button is ours

function chatParts(app = ui.chat) {
  const root = app?.element?.[0] ?? app?.element;
  const log = root?.querySelector?.(".chat-log");
  if (!log) return null;
  let scroller = log.closest(".chat-scroll") ?? null;
  if (!scroller) {
    for (let el = log; el && el !== root; el = el.parentElement) {
      const oy = getComputedStyle(el).overflowY;
      if (oy === "auto" || oy === "scroll") { scroller = el; break; }
    }
  }
  return { root, log, scroller: scroller ?? log };
}

function fromBottom(scroller) {
  return scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
}

/** Take the oldest cards out of the page, keeping the newest `keep`. */
function prune(app = ui.chat) {
  if (lessChat || setting("chatTrim", true) === false) return;
  const parts = chatParts(app);
  if (!parts) return;
  const keep = Math.max(20, Number(setting("chatTrimKeep", 80)) || 80);
  const items = parts.log.querySelectorAll(":scope > li.message, :scope > .chat-message");
  if (items.length <= keep + 10) return;          // a little slack: no work on every message
  if (fromBottom(parts.scroller) > 60) { schedulePrune(app, 3000); return; }
  const list = pruned.get(app) ?? [];
  for (const li of [...items].slice(0, items.length - keep)) {
    const id = li.dataset.messageId;
    const message = id ? game.messages.get(id) : null;
    if (message) message.logged = false;
    if (id) list.push(id);
    li.remove();
  }
  pruned.set(app, list);
}

function schedulePrune(app = ui.chat, ms = 600) {
  clearTimeout(pruneTimer);
  pruneTimer = setTimeout(() => prune(app), ms);
}

/** Put the most recently removed cards back on top, keeping the view where it is. */
const restoring = new WeakSet();
async function restore(app, size) {
  const list = pruned.get(app);
  const parts = chatParts(app);
  if (!list?.length || !parts) return false;
  if (restoring.has(app)) return true;
  restoring.add(app);
  try { return await restoreNow(app, list, parts, size); } finally { restoring.delete(app); }
}

async function restoreNow(app, list, parts, size) {
  const ids = list.splice(-Math.max(1, size || 20));
  const before = parts.scroller.scrollHeight;
  const top = parts.scroller.scrollTop;
  const els = [];
  for (const id of ids) {
    const message = game.messages.get(id);
    if (!message || message.visible === false) continue;
    if (parts.log.querySelector(`[data-message-id="${id}"]`)) continue;   // came back on its own (updated)
    try {
      const html = await (app.constructor?.renderMessage?.(message) ?? message.renderHTML?.() ?? message.getHTML?.());
      const el = html instanceof HTMLElement ? html : html?.[0];
      if (!el) continue;
      message.logged = true;
      els.push(el);
    } catch (err) { console.warn(`${MODULE_ID} | chat restore`, err); }
  }
  parts.log.prepend(...els);
  parts.scroller.scrollTop = top + (parts.scroller.scrollHeight - before);
  return true;
}

/**
 * A message that is out of the page gets updated (Toolbelt marks damage applied,
 * a reaction card closes …). Foundry would not find its card and would add it at
 * the bottom of the chat, out of order. Leave it out instead — it is drawn fresh,
 * with the new data, when it comes back. An older message that just became
 * visible to this user (it was a whisper) joins the taken-out list in order.
 */
function shouldSkipUpdate(app, message) {
  const list = pruned.get(app);
  if (!list?.length || !message?.id) return false;
  const parts = chatParts(app);
  if (!parts || parts.log.querySelector(`[data-message-id="${message.id}"]`)) return false;
  if (list.includes(message.id)) return true;
  const oldestId = parts.log.querySelector(":scope > li.message, :scope > .chat-message")?.dataset.messageId;
  const ids = game.messages.contents.map(m => m.id);
  const at = ids.indexOf(message.id);
  if (!oldestId || at < 0 || at > ids.indexOf(oldestId)) return false;
  list.push(message.id);
  list.sort((a, b) => ids.indexOf(a) - ids.indexOf(b));
  message.logged = false;
  return true;
}

/* ---------------- the ↓ button ---------------- */

let jumpEl = null;

function placeJump() {
  if (!jumpEl) return;
  const parts = chatParts();
  const on = setting("chatJumpButton", true) !== false && !!parts && parts.root.offsetParent !== null
    && fromBottom(parts.scroller) > 240;
  jumpEl.classList.toggle("hidden", !on);
  if (!on) return;
  const r = parts.scroller.getBoundingClientRect();
  jumpEl.style.left = `${Math.round(r.right - 44)}px`;
  jumpEl.style.top = `${Math.round(r.bottom - 44)}px`;
}

function jump() {
  const parts = chatParts();
  if (!parts) return;
  if (typeof ui.chat?.scrollBottom === "function") ui.chat.scrollBottom({ waitImages: false });
  parts.scroller.scrollTo({ top: parts.scroller.scrollHeight, behavior: "smooth" });
  setTimeout(() => { placeJump(); schedulePrune(); }, 400);
}

/* ---------------- wiring ---------------- */

export function registerChatTrimSettings() {
  const s = (key, data) => game.settings.register(MODULE_ID, key, { scope: "client", config: true, ...data });
  s("chatTrim", { name: "PKH.Settings.chatTrim.Name", hint: "PKH.Settings.chatTrim.Hint", type: Boolean, default: true });
  s("chatTrimKeep", { name: "PKH.Settings.chatTrimKeep.Name", type: Number, default: 80, range: { min: 30, max: 300, step: 10 } });
  s("chatJumpButton", { name: "PKH.Settings.chatJumpButton.Name", hint: "PKH.Settings.chatJumpButton.Hint", type: Boolean, default: true });
}

export function initChatTrim() {
  const ChatLog = foundry.applications?.sidebar?.tabs?.ChatLog;
  const proto = ChatLog?.prototype;
  if (proto?.renderBatch && !proto.renderBatch.__pkhTrim) {
    const original = proto.renderBatch;
    const wrapped = async function (size, ...rest) {
      if (await restore(this, size)) return;
      return original.call(this, size, ...rest);
    };
    wrapped.__pkhTrim = true;
    proto.renderBatch = wrapped;
  }
  if (proto?.updateMessage && !proto.updateMessage.__pkhTrim) {
    const original = proto.updateMessage;
    const wrapped = function (message, ...rest) {
      if (shouldSkipUpdate(this, message)) return;
      return original.call(this, message, ...rest);
    };
    wrapped.__pkhTrim = true;
    proto.updateMessage = wrapped;
  }
  if (game.modules.get("less-chat")?.active) {
    console.warn(`${MODULE_ID} | Less Chat is active as well; the HUD's chat trimming steps aside.`);
    lessChat = true;
  }

  Hooks.on("createChatMessage", () => schedulePrune());
  Hooks.on("renderChatLog", () => setTimeout(placeJump, 100));

  jumpEl = document.createElement("button");
  jumpEl.type = "button";
  jumpEl.id = "pkh-chat-jump";
  jumpEl.className = "hidden";
  jumpEl.dataset.tooltip = t("Chat.JumpLatest");
  jumpEl.setAttribute("aria-label", t("Chat.JumpLatest"));
  jumpEl.innerHTML = `<i class="fa-solid fa-arrow-down"></i>`;
  jumpEl.addEventListener("click", jump);
  document.body.appendChild(jumpEl);
  document.addEventListener("scroll", ev => {
    if (ev.target instanceof HTMLElement && ev.target.closest?.("#chat, .chat-popout, #sidebar")) placeJump();
  }, true);
  window.addEventListener("resize", placeJump);
  Hooks.on("collapseSidebar", () => setTimeout(placeJump, 300));
  Hooks.on("changeSidebarTab", () => setTimeout(placeJump, 60));
  setTimeout(() => prune(), 3000);
}

export { prune as pruneChat };
