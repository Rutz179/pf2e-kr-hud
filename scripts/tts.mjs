import { MODULE_ID, SimpleWindow, esc, setting, t } from "./shared.mjs";
import { polyglotUnknown } from "./polyglot.mjs";

/* ======================================================================== *
 * 채팅 읽어 주기 (TTS) — for a player who'd rather hear the table than read it.
 *
 * Each person turns it on for themselves (a client setting): the lines are
 * spoken on that computer only, by the browser's own speech (Web Speech API —
 * Windows' voices in the Foundry app; Edge adds its natural "Online" voices).
 * Nobody else hears it, nothing goes through Discord.
 *
 * Only what people say is read: typed lines and emotes. Rolls, PF2e cards, the
 * HUD's own cards, (( OOC )) and // notes are skipped; "@표정" keywords and
 * Foundry's code ("@UUID[…]{월장석}" → "월장석", "@Check[…]", "[[/r …]]") never
 * reach the voice; links are just "링크". A line in a language this player's
 * character doesn't know (Polyglot) is "알아들을 수 없는 말".
 * The speaker's name is said when the speaker changes (setting).
 * Falling behind (a fast scene): the next lines are read faster (setting).
 * Keys: stop · say the last line again · on/off.
 * ======================================================================== */

const synth = () => globalThis.speechSynthesis ?? null;
const queue = [];
let speaking = false;
let lastSpeaker = null;
let lastLine = null;

/* ---------------- what to say ---------------- */

const CARD_MARKUP = /<(section|header|table|button|form)\b|class="[^"]*\b(chat-card|dice-roll|card-content|item-card|pkh-save-request)\b|data-pf2-check/i;

/** The plain words of a chat message's HTML, without Foundry's codes. */
export function spokenText(html) {
  const div = document.createElement("div");
  div.innerHTML = String(html ?? "");
  for (const el of div.querySelectorAll(".inline-roll, .dice-roll, .action-glyph, i[class*='fa-'], img")) el.remove();
  for (const br of div.querySelectorAll("br")) br.replaceWith(" ");
  for (const p of div.querySelectorAll("p, div, li")) p.append(" ");
  let text = div.textContent ?? "";
  text = text
    .replace(/@(UUID|Compendium|Embed)\[[^\]]*\]\{([^}]*)\}/g, "$2")       // a link with a label: the label
    .replace(/@(UUID|Compendium|Embed)\[([^\]]*)\]/g, (_, __, ref) => ref.split(".").pop())
    .replace(/@(Check|Damage|Template|Localize)\[[^\]]*\](\{([^}]*)\})?/g, "$3")
    .replace(/\[\[[^\]]*\]\](\{([^}]*)\})?/g, "$2")                        // [[/r 1d6]]: only a label
    .replace(/https?:\/\/\S+/g, ` ${t("Tts.Link")} `)
    .replace(/(^|\s)@ ?\S+/g, "$1")                                       // @표정 keywords, @mentions
    .replace(/[*_~`#>|]+/g, " ")
    .replace(/ /g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return text;
}

/** What this message should sound like here: { speaker, text } or null. */
export function lineOf(message) {
  if (!message || message.visible === false) return null;
  if (message.rolls?.length || message.isRoll) return null;
  if (message.getFlag?.(MODULE_ID, "note")) return null;
  const pf2e = message.flags?.pf2e ?? {};
  if (pf2e.origin || pf2e.context || pf2e.casting || pf2e.strike || pf2e.appliedDamage) return null;
  const html = String(message.content ?? "");
  if (CARD_MARKUP.test(html)) return null;
  const author = message.author ?? message.user;
  if (author?.id === game.user.id && !setting("ttsOwn", false)) return null;
  const whisper = message.whisper ?? [];
  if (whisper.length && !setting("ttsWhispers", true)) return null;
  const speaker = String(message.speaker?.alias || author?.name || "").trim();
  if (polyglotUnknown(message)) return { speaker, text: t("Tts.Unknown") };
  const text = spokenText(html);
  if (!text || /^\(\(|^\/\//.test(text)) return null;                    // (( OOC )) and // notes
  return { speaker, text };
}

/* ---------------- the voice ---------------- */

export function voices() {
  const all = synth()?.getVoices?.() ?? [];
  const lang = (game.i18n.lang || "ko").slice(0, 2);
  // This language's voices first, the natural ("Online") ones at the top.
  const score = v => (v.lang?.toLowerCase().startsWith(lang) ? 2 : 0) + (/natural|online|neural/i.test(v.name) ? 1 : 0);
  return [...all].sort((a, b) => score(b) - score(a) || a.name.localeCompare(b.name));
}

function voiceNow() {
  const want = setting("ttsVoice", "");
  const list = voices();
  return list.find(v => v.name === want) ?? list[0] ?? null;
}

/** Long lines in pieces (some browsers stop a long utterance after ~15 s). */
function pieces(text) {
  const out = [];
  let rest = text;
  while (rest.length > 180) {
    const cut = Math.max(rest.lastIndexOf(". ", 180), rest.lastIndexOf("? ", 180), rest.lastIndexOf("! ", 180), rest.lastIndexOf(", ", 180), rest.lastIndexOf(" ", 180));
    const at = cut > 60 ? cut + 1 : 180;
    out.push(rest.slice(0, at).trim());
    rest = rest.slice(at).trim();
  }
  if (rest) out.push(rest);
  return out;
}

function sayNext() {
  const s = synth();
  if (!s || !queue.length) { speaking = false; return; }
  speaking = true;
  const item = queue.shift();
  const u = new SpeechSynthesisUtterance(item.text);
  const v = voiceNow();
  if (v) { u.voice = v; u.lang = v.lang; } else u.lang = game.i18n.lang === "ko" ? "ko-KR" : "en-US";
  let rate = Number(setting("ttsRate", 1.4)) || 1.4;
  // Falling behind: faster, up to half again, while lines wait.
  if (setting("ttsCatchUp", true) && queue.length >= 2) rate *= Math.min(1.5, 1 + queue.length * 0.1);
  u.rate = Math.max(0.5, Math.min(4, rate));
  const vol = Number(setting("ttsVolume", 1));
  u.volume = Number.isFinite(vol) ? Math.max(0, Math.min(1, vol)) : 1;
  u.onend = u.onerror = () => sayNext();
  s.speak(u);
}

/** Put words in line to be spoken. */
export function say(text, { now = false } = {}) {
  if (!text || !synth()) return;
  if (now) { queue.length = 0; synth().cancel(); speaking = false; }
  for (const p of pieces(text)) queue.push({ text: p });
  // Way behind (a burst of lines): drop the oldest, keep the last few.
  while (queue.length > 12) queue.shift();
  if (!speaking) sayNext();
}

export function stop() {
  queue.length = 0;
  speaking = false;
  synth()?.cancel();
}

function speakLine(line) {
  const mode = setting("ttsSpeaker", "change");
  const name = line.speaker && (mode === "always" || (mode === "change" && line.speaker !== lastSpeaker)) ? `${line.speaker}, ` : "";
  lastSpeaker = line.speaker;
  lastLine = line;
  say(`${name}${line.text}`);
}

function onChat(message) {
  if (!setting("ttsEnabled", false)) return;
  const line = lineOf(message);
  if (line) speakLine(line);
}

/* ---------------- settings, window, keys ---------------- */

function openTtsWindow() {
  const list = voices();
  const cur = voiceNow()?.name ?? "";
  new SimpleWindow({
    id: "pkh-tts",
    title: t("Tts.Title"),
    width: 440,
    html: () => `<div class="pkh-tts">
      ${synth() ? "" : `<p class="pkh-pick-hint warn">${esc(t("Tts.NoSpeech"))}</p>`}
      <p class="pkh-pick-hint">${t("Tts.Hint")}</p>
      <label class="row"><input type="checkbox" name="on" ${setting("ttsEnabled", false) ? "checked" : ""}> <b>${esc(t("Tts.On"))}</b></label>
      <label class="f">${esc(t("Tts.Voice"))}</label>
      <select name="voice">${list.length ? list.map(v => `<option value="${esc(v.name)}" ${v.name === cur ? "selected" : ""}>${esc(v.name)} (${esc(v.lang)})</option>`).join("") : `<option value="">${esc(t("Tts.NoVoices"))}</option>`}</select>
      <p class="pkh-pick-hint">${t("Tts.VoiceHint")}</p>
      <label class="f">${esc(t("Tts.Rate"))} <output name="rateOut">${Number(setting("ttsRate", 1.4)).toFixed(1)}</output>×</label>
      <input type="range" name="rate" min="0.8" max="3" step="0.1" value="${Number(setting("ttsRate", 1.4))}">
      <div class="row"><input type="text" name="sample" value="${esc(t("Tts.Sample"))}"><button type="button" data-act="test"><i class="fa-solid fa-play"></i> ${esc(t("Tts.Test"))}</button><button type="button" data-act="stop"><i class="fa-solid fa-stop"></i></button></div>
      <p class="pkh-pick-hint">${t("Tts.Keys")}</p>
    </div>`,
    onRender: root => {
      const rate = root.querySelector("[name=rate]");
      rate?.addEventListener("input", () => { root.querySelector("[name=rateOut]").textContent = Number(rate.value).toFixed(1); });
      rate?.addEventListener("change", () => game.settings.set(MODULE_ID, "ttsRate", Number(rate.value)));
      root.querySelector("[name=voice]")?.addEventListener("change", ev => game.settings.set(MODULE_ID, "ttsVoice", ev.target.value));
      root.querySelector("[name=on]")?.addEventListener("change", ev => game.settings.set(MODULE_ID, "ttsEnabled", ev.target.checked));
      root.addEventListener("click", async ev => {
        const b = ev.target.closest("button[data-act]");
        if (!b) return;
        if (b.dataset.act === "stop") return stop();
        await game.settings.set(MODULE_ID, "ttsRate", Number(rate.value));
        say(root.querySelector("[name=sample]").value, { now: true });
      });
    }
  }).render({ force: true });
}

class TtsMenu extends foundry.applications.api.ApplicationV2 {
  render() { openTtsWindow(); return this; }
}

export function registerTtsSettings() {
  const s = (key, data) => game.settings.register(MODULE_ID, key, { scope: "client", config: true, name: `PKH.Settings.${key}.Name`, hint: `PKH.Settings.${key}.Hint`, ...data });
  s("ttsEnabled", { type: Boolean, default: false, onChange: on => { if (!on) stop(); } });
  s("ttsRate", { type: Number, default: 1.4, range: { min: 0.8, max: 3, step: 0.1 } });
  s("ttsVolume", { type: Number, default: 1, range: { min: 0, max: 1, step: 0.05 } });
  s("ttsSpeaker", { type: String, default: "change", choices: { change: "PKH.Settings.ttsSpeaker.Choices.change", always: "PKH.Settings.ttsSpeaker.Choices.always", never: "PKH.Settings.ttsSpeaker.Choices.never" } });
  s("ttsWhispers", { type: Boolean, default: true });
  s("ttsOwn", { type: Boolean, default: false });
  s("ttsCatchUp", { type: Boolean, default: true });
  game.settings.register(MODULE_ID, "ttsVoice", { scope: "client", config: false, type: String, default: "" });
  game.settings.registerMenu(MODULE_ID, "ttsMenu", {
    name: "PKH.Tts.Title", label: "PKH.Tts.Open", hint: "PKH.Tts.MenuHint", icon: "fa-solid fa-volume-high", type: TtsMenu, restricted: false
  });
  const key = (name, code, onDown) => game.keybindings.register(MODULE_ID, name, { name: `PKH.Keys.${name}`, editable: [{ key: code, modifiers: ["Alt"] }], onDown, precedence: CONST.KEYBINDING_PRECEDENCE?.NORMAL });
  key("ttsStop", "KeyS", () => { if (!setting("ttsEnabled", false)) return false; stop(); return true; });
  key("ttsRepeat", "KeyR", () => {
    if (!setting("ttsEnabled", false) || !lastLine) return false;
    say(`${lastLine.speaker ? `${lastLine.speaker}, ` : ""}${lastLine.text}`, { now: true });
    return true;
  });
  key("ttsToggle", "KeyT", () => {
    const on = !setting("ttsEnabled", false);
    game.settings.set(MODULE_ID, "ttsEnabled", on);
    ui.notifications.info(t(on ? "Tts.TurnedOn" : "Tts.TurnedOff"));
    return true;
  });
}

export function initTts() {
  // The voice list comes in a moment after the page loads.
  try { synth()?.getVoices?.(); if (synth()) synth().onvoiceschanged = () => foundry.applications.instances.get("pkh-tts")?.render(); } catch (_) { /* no speech here */ }
  Hooks.on("createChatMessage", onChat);
  game.pf2eKrHud = { ...(game.pf2eKrHud ?? {}), tts: { say, stop, open: openTtsWindow, lineOf } };
}
