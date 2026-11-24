import { MODULE_ID, SimpleWindow, displayName, esc, isVideo, mirrorPackOf, t } from "./shared.mjs";
import { partyPcs } from "./xp.mjs";
import {
  MODES, TOPICS, addTopic, buildAnswer, cardHtml, creatureOf, englishPart, glossaryEntry, hasDubiousKnowledge,
  modeFor, recallCheckOf, redrawLine
} from "./recall-gen.mjs";

/*
 * 지식 답하기 (GM): answering a Recall Knowledge check
 * - A Recall Knowledge check card gets a 「지식 답하기」 button (GM only) opening the window with the check's target, outcome and asker; a plain failure by someone with Dubious Knowledge is 「실패·의심스러운 지식」.
 * - game.pf2eKrHud.recall() opens it for the selected token.
 * - The lines come from recall-gen.mjs; the GM edits them, re-draws one with 🎲 and sends them as one card (whisper to the asker's players + GMs, or public). ✔/✘ marks stay in this window; nothing is stored on the actor.
 */

const GLOSSARY = "pf2e.bestiary-ability-glossary-srd";
const FIXED_SENSES = new Set(["darkvision", "greater-darkvision", "low-light-vision", "see-invisibility", "truesight"]);

// Kept for the session: the GM's usual topics and 그럴듯함.
const prefs = { topics: ["weak"], close: true };
let state = null;
let win = null;
let glossary = null;
let glossaryLoad = null;

const gmIds = () => game.users.filter(u => u.isGM).map(u => u.id);
const ownersOf = actor => game.users.filter(u => !u.isGM && actor?.testUserPermission?.(u, "OWNER")).map(u => u.id);
const localize = key => game.i18n.localize(key);
const warn = key => ui.notifications.warn(`Rutz's HUD | ${t(key)}`);

function docOf(uuid) {
  try { return uuid ? fromUuidSync(uuid) : null; } catch (_) { return null; }
}

/* labels: PF2e's own words for every type */

function senseLabel({ type, acuity, range }) {
  const P = CONFIG.PF2E ?? {};
  const name = (P.senses?.[type] && localize(P.senses[type])) || type;
  const ac = acuity && P.senseAcuities?.[acuity] ? localize(P.senseAcuities[acuity]) : null;
  const r = Number(range) > 0 && Number.isFinite(Number(range)) ? Number(range) : null;
  // As PF2e's Sense#label: some senses never show acuity or range.
  const build = (a, n) => {
    if (a && n) return game.i18n.format("PF2E.Actor.Creature.Sense.WithAcuityAndRange", { sense: name, acuity: a, range: n });
    if (a) return game.i18n.format("PF2E.Actor.Creature.Sense.WithAcuity", { sense: name, acuity: a });
    if (n) return game.i18n.format("PF2E.Actor.Creature.Sense.WithRange", { sense: name, range: n });
    return name;
  };
  if (FIXED_SENSES.has(type)) return name;
  if (type === "echolocation" || type === "infrared-vision") return build(null, r);
  if (type === "lifesense") return build(acuity === "precise" ? null : ac, r);
  return build(ac, r);
}

function labels() {
  const P = CONFIG.PF2E ?? {};
  const maps = { weak: P.weaknessTypes, resist: P.resistanceTypes, immune: P.immunityTypes };
  return {
    text: (key, data) => t(`Recall.${key}`, data),
    iwr: (kind, type) => (maps[kind]?.[type] ? localize(maps[kind][type]) : ""),
    damage: type => (P.damageTypes?.[type] ? localize(P.damageTypes[type]) : type),
    save: slug => (P.saves?.[slug] ? localize(P.saves[slug]) : slug),
    speed: type => localize(`PF2E.Actor.Speed.Type.${type.charAt(0).toUpperCase()}${type.slice(1)}`),
    sense: senseLabel,
    natural: slug => t(`Recall.Natural.${slug}`)
  };
}

/* the ability glossary (false ability names) */

/** PF2e's bestiary ability glossary, read once, with the translated mirror's names where a mirror pack exists. */
function loadGlossary() {
  if (glossary) return Promise.resolve(glossary);
  glossaryLoad ??= (async () => {
    const pack = game.packs.get(GLOSSARY);
    if (!pack) return [];
    try {
      const index = await pack.getIndex({ fields: ["system.slug", "system.actionType.value", "system.category", "system.description.value"] });
      const mirror = mirrorPackOf(GLOSSARY);
      let mirrored = null;
      try { mirrored = mirror ? await mirror.getIndex({ fields: ["system.description.value"] }) : null; } catch (_) { mirrored = null; }
      // A mirror with other ids: its "붙잡기(Grab)" is the entry named "Grab".
      const byEnglish = new Map([...(mirrored ?? [])].map(m => [englishPart(m.name).toLowerCase(), m]));
      return [...index].map(e => glossaryEntry(e, mirrored?.get?.(e._id) ?? byEnglish.get(String(e.name).toLowerCase()) ?? null, { localize }));
    } catch (err) {
      console.warn(`${MODULE_ID} | could not read the ability glossary`, err);
      return [];
    }
  })().then(list => (glossary = list));
  return glossaryLoad;
}

/* whom it is about, who asks */

function controlledToken() {
  const list = globalThis.canvas?.tokens?.controlled ?? [];
  return list.find(tk => tk.actor && tk.actor.type !== "character") ?? list[0] ?? null;
}

/** The check's target (its token first, so an unlinked NPC is that token's own actor), else the selected token. */
function resolveTarget({ actor = null, token = null, target = null } = {}) {
  let tok = token?.document ?? token ?? null;
  let act = actor ?? null;
  if (!tok && !act && target) {
    tok = docOf(target.token);
    act = tok?.actor ?? docOf(target.actor);
  }
  if (!tok && !act) {
    const sel = controlledToken();
    tok = sel?.document ?? null;
    act = sel?.actor ?? null;
  }
  return { token: tok, actor: act ?? tok?.actor ?? null };
}

function setTarget({ token, actor }) {
  state.name = displayName(token?.name ?? actor?.name ?? "");
  const src = token?.texture?.src;
  state.img = src && !isVideo(src) ? src : actor?.img ?? "icons/svg/mystery-man.svg";
  state.creature = actor ? creatureOf(actor, { localize, name: state.name }) : null;
}

function speakerActor(message) {
  try { return ChatMessage.getSpeakerActor?.(message.speaker) ?? message.actor ?? null; } catch (_) { return null; }
}

/** Who may have asked: the party's player characters, whether or not anyone is online. partyPcs() (xp.mjs) keeps only characters owned by a non-GM user, which is empty for a GM testing with unassigned PCs. Party members are PF2e's `party.members`, the active party `game.actors.party`. */
export function askerPcs() {
  const chars = list => [...new Map(list.filter(a => a?.type === "character").map(a => [a.id, a])).values()];
  const party = chars(game.actors.party?.members ?? []);
  if (party.length) return party;
  const owned = partyPcs();
  return owned.length ? owned : chars([...game.actors]);
}

function askerChoices() {
  const list = askerPcs();
  const cur = game.actors.get(state.askerId);
  return cur && !list.some(a => a.id === cur.id) ? [cur, ...list] : list;
}

function selectedPc() {
  const ids = new Set(askerPcs().map(a => a.id));
  return (globalThis.canvas?.tokens?.controlled ?? []).map(tk => tk.actor).find(a => a && ids.has(a.id)) ?? null;
}

const asker = () => game.actors.get(state?.askerId ?? "") ?? null;

/* the lines */

function genOpts() {
  return { creature: state.creature, mode: state.mode, topics: state.topics, close: state.close, glossary, L: labels() };
}

function regenerate() {
  state.lines = state.creature || state.mode === "failure" ? buildAnswer(genOpts()) : [];
}

function rerender() {
  if (win?.rendered) win.render();
}

function setMode(mode) {
  if (!MODES.includes(mode)) return;
  state.mode = mode;
  regenerate();
  rerender();
}

function toggleTopic(topic) {
  const on = state.topics.includes(topic);
  state.topics = on ? state.topics.filter(x => x !== topic) : TOPICS.filter(x => x === topic || state.topics.includes(x));
  prefs.topics = [...state.topics];
  // Only that topic changes: the other lines keep their draws and edits.
  if (state.creature && state.mode !== "failure") state.lines = on ? state.lines.filter(l => l.topic !== topic) : addTopic(state.lines, topic, genOpts());
  rerender();
}

function pickSelected() {
  const sel = controlledToken();
  if (!sel) return warn("Recall.Notify.NoTarget");
  setTarget({ token: sel.document, actor: sel.actor });
  regenerate();
  rerender();
}

async function send(whisper) {
  const who = asker();
  if (whisper && !who) return warn("Recall.Notify.NeedAsker");
  const lines = state.lines.filter(l => String(l.text ?? "").trim());
  if (!lines.length) return warn("Recall.Notify.NoLines");
  const data = {
    content: cardHtml({ who: who ? displayName(who.name) : null, lines, L: labels() }),
    speaker: who ? ChatMessage.getSpeaker({ actor: who }) : { alias: t("Recall.Title") }
  };
  if (whisper) data.whisper = [...new Set([...ownersOf(who), ...gmIds()])];
  await ChatMessage.create(data);
  win?.close();
}

/* the window */

function windowHtml() {
  const s = state;
  const who = asker();
  const dubious = hasDubiousKnowledge(who);
  const head = s.creature
    ? `<img src="${esc(s.img)}" alt=""><b>${esc(s.name)}</b><span class="lv">Lv ${Number(s.creature.level) || 0}</span>`
    : `<span class="hint">${esc(t("Recall.NoTarget"))}</span>`;
  const people = askerChoices().map(a => `<option value="${a.id}"${a.id === s.askerId ? " selected" : ""}>${esc(displayName(a.name))}</option>`).join("");
  const modes = MODES.map(m => `<button type="button" data-mode="${m}" class="${m === s.mode ? "on" : ""}">${esc(t(`Recall.Mode.${m}`))}</button>`).join("");
  const mixed = s.mode === "dubious" || s.mode === "criticalFailure";
  const close = mixed ? `<div class="row" data-tooltip="${esc(t("Recall.PlausibleTip"))}"><span>${esc(t("Recall.Plausible"))}</span>
      <div class="pkh-rk-seg"><button type="button" data-close="1" class="${s.close ? "on" : ""}">${esc(t("Recall.Near"))}</button><button type="button" data-close="0" class="${s.close ? "" : "on"}">${esc(t("Recall.Any"))}</button></div></div>` : "";
  const chips = s.mode === "failure" ? "" : `<div class="pkh-gc-chips">${TOPICS.map(tp =>
    `<button type="button" class="chip${s.topics.includes(tp) ? " on" : ""}" data-topic="${tp}">${esc(t(`Recall.Topic.${tp}`))}</button>`).join("")}</div>`;
  const mark = l => (l.truth === true ? `<i class="mark fa-solid fa-check" data-tooltip="${esc(t("Recall.True"))}"></i>`
    : l.truth === false ? `<i class="mark fa-solid fa-xmark" data-tooltip="${esc(t("Recall.False"))}"></i>` : `<i class="mark"></i>`);
  const redraw = (l, i) => (l.truth === false || l.alts > 1
    ? `<button type="button" data-redraw="${i}" data-tooltip="${esc(t("Recall.Redraw"))}" aria-label="${esc(t("Recall.Redraw"))}"><i class="fa-solid fa-dice"></i></button>`
    : `<span class="pad"></span>`);
  const lines = s.lines.length
    ? `<ol class="pkh-rk-lines">${s.lines.map((l, i) => `<li class="${l.truth === true ? "is-true" : l.truth === false ? "is-false" : ""}">${mark(l)}
        <input type="text" data-line="${i}" maxlength="300" value="${esc(l.text)}">${redraw(l, i)}</li>`).join("")}</ol>`
    : `<p class="empty">${esc(t(s.creature ? "Recall.NoLines" : "Recall.NoTarget"))}</p>`;
  return `<div class="pkh-rk">
    <div class="pkh-rk-head">${head}
      <button type="button" data-act="pick" data-tooltip="${esc(t("Recall.UseSelected"))}" aria-label="${esc(t("Recall.UseSelected"))}"><i class="fa-solid fa-crosshairs"></i></button></div>
    <label class="row">${esc(t("Recall.Asker"))}
      <select name="asker"><option value="">—</option>${people}</select>
      ${dubious ? `<i class="fa-solid fa-circle-question dubious" data-tooltip="${esc(t("Recall.HasDubious"))}"></i>` : ""}</label>
    <div class="pkh-rk-seg">${modes}</div>
    ${close}
    ${chips}
    ${lines}
    <div class="pkh-seat-buttons">
      <button type="button" data-act="whisper" class="primary"${who ? "" : " disabled"}><i class="fa-solid fa-user-secret"></i> ${esc(t("Recall.Whisper"))}</button>
      <button type="button" data-act="public"><i class="fa-solid fa-comment"></i> ${esc(t("Recall.Public"))}</button>
      <button type="button" data-act="close">${esc(t("Common.Close"))}</button>
    </div>
  </div>`;
}

function wire(root, app) {
  if (app._pkhWired) return;
  app._pkhWired = true;
  root.addEventListener("click", ev => {
    const el = ev.target.closest("button");
    if (!el || !root.contains(el) || el.disabled) return;
    if (el.dataset.mode) return setMode(el.dataset.mode);
    if (el.dataset.close) {
      state.close = prefs.close = el.dataset.close === "1";
      regenerate();
      return rerender();
    }
    if (el.dataset.topic) return toggleTopic(el.dataset.topic);
    if (el.dataset.redraw !== undefined) {
      state.lines = redrawLine(state.lines, Number(el.dataset.redraw), genOpts());
      return rerender();
    }
    if (el.dataset.act === "pick") return pickSelected();
    if (el.dataset.act === "whisper") return send(true);
    if (el.dataset.act === "public") return send(false);
    if (el.dataset.act === "close") return app.close();
  });
  root.addEventListener("input", ev => {
    const i = ev.target.dataset?.line;
    const l = i === undefined ? null : state.lines[Number(i)];
    if (!l) return;
    l.text = ev.target.value;
    l.edited = true;
  });
  root.addEventListener("change", ev => {
    if (ev.target.name !== "asker") return;
    state.askerId = ev.target.value;
    // A failure follows the asker's feat: with Dubious Knowledge it is a true + false pair.
    if (state.mode === "failure" || state.mode === "dubious") return setMode(modeFor("failure", hasDubiousKnowledge(asker())));
    rerender();
  });
}

/**
 * API (game.pf2eKrHud.recall): the GM's window. With no options it is about the selected token and the outcome is
 * picked by hand; { message } fills everything from a Recall Knowledge check card.
 */
export async function openRecall({ message = null, actor = null, token = null, asker: who = null, outcome = null } = {}) {
  if (!game.user.isGM) return null;
  const info = message ? recallCheckOf(message) : null;
  // Not from a card: a selected party character is the asker.
  const person = who ?? (message ? speakerActor(message) : selectedPc());
  // A macro may ask for the window's own "dubious" mode; PF2e outcomes follow the asker's feat.
  const mode = outcome === "dubious" ? outcome : modeFor(outcome ?? info?.outcome ?? null, hasDubiousKnowledge(person));
  state = { askerId: person?.id ?? "", mode, topics: [...prefs.topics], close: prefs.close, lines: [] };
  setTarget(resolveTarget({ actor, token, target: info?.target }));
  await loadGlossary();
  regenerate();
  if (win?.rendered) {
    win.render();
    win.bringToFront?.();
    return win;
  }
  win = new SimpleWindow({ id: `${MODULE_ID}-recall`, title: t("Recall.Title"), width: 460, html: windowHtml, onRender: wire, classes: ["pkh-fit"] });
  win.render({ force: true });
  return win;
}

/* the button on the check card */

function wireCheckCard(message, html) {
  if (!game.user.isGM || !recallCheckOf(message)) return;
  const root = html instanceof HTMLElement ? html : html?.[0];
  const host = root?.querySelector?.(".message-content");
  if (!host || host.querySelector(".pkh-rk-open")) return;
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "pkh-rk-open";
  btn.innerHTML = `<i class="fa-solid fa-brain"></i> ${esc(t("Recall.Title"))}`;
  btn.addEventListener("click", ev => {
    ev.preventDefault();
    ev.stopPropagation();
    openRecall({ message });
  });
  host.append(btn);
}

/** At init: check cards already in the log get the button when first drawn. */
export function initRecallCards() {
  Hooks.on("renderChatMessageHTML", wireCheckCard);
}
