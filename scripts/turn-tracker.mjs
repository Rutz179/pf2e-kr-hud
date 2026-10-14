import { MODULE_ID, boardViewportRect, esc, setting } from "./shared.mjs";

/* ======================================================================== *
 * Turn tracker — a light, Baldur's-Gate-3-style strip at the top of the screen
 *
 * Shows only what the table reads during a fight: whose turn it is, who comes
 * next, the round, and initiative. Portraits run in turn order starting from
 * the active combatant; a round marker sits where the order wraps around.
 *
 * Deliberately small:
 *  - no templates and no stat tooltips (HP, AC, effects are left to the HUD);
 *  - redraws only when the combat itself changes (turn, round, initiative,
 *    combatants, defeated/hidden), batched into one animation frame;
 *  - portrait nodes are reused between redraws, so images are not reloaded
 *    and the active portrait can animate;
 *  - nothing here depends on PF2e, so the file can move to a shared UI module
 *    as it is.
 *
 * Big fights: portraits never shrink to fit. Instead the strip
 *  - folds neighbouring copies of the same creature into one portrait (×n),
 *  - shows as many as fit on the board and a "+n" chip for the rest,
 *  - and opens into a scrollable row (mouse wheel) when the chip is clicked.
 *
 * If Carousel Combat Tracker (combat-tracker-dock) is active this strip stays
 * hidden, so the two never stack.
 * ======================================================================== */

const DISPOSITION = { "-2": "secret", "-1": "hostile", "0": "neutral", "1": "friendly" };
const VIDEO = /\.(webm|mp4|m4v|ogv)(\?|$)/i;
const ACTIVE_SCALE = 1.2;
const GAP = 6;
const DIVIDER_WIDTH = 22;
const MORE_WIDTH = 50;
/** A click on your own portrait right after the turn changed is almost always a double click. */
const END_TURN_GUARD_MS = 900;

/** Combatants in the order they act from now on, with a marker where the next round starts. */
export function turnSequence(turns, { started, turn, round, include }) {
  const list = Array.isArray(turns) ? turns : [];
  if (!list.length) return [];
  if (!started) return list.filter(include).map(c => ({ c }));

  const current = Math.clamp(Number(turn) || 0, 0, list.length - 1);
  const ahead = list.slice(current).filter(include).map(c => ({ c }));
  const after = list.slice(0, current).filter(include).map(c => ({ c }));
  // Everyone after the marker acts next round. No marker at either end: none
  // after the last combatant, and none in front when the one acting now is
  // hidden from this viewer (that would give the hidden turn away).
  const seq = [...ahead];
  if (ahead.length && after.length) seq.push({ divider: (Number(round) || 1) + 1 });
  seq.push(...after);
  return seq;
}

/**
 * Fold runs of the same creature (same actor, name and picture, same defeated
 * state) into one step with `members`. The one acting now and the one up next
 * always stand alone, so the table can still read the order at a glance.
 */
export function groupSequence(seq, { keyOf, keep = () => false }) {
  const out = [];
  for (const step of seq) {
    if (!step.c) { out.push(step); continue; }
    const key = keep(step.c) ? null : keyOf(step.c);
    const last = out[out.length - 1];
    if (key && last?.key === key) { last.members.push(step.c); continue; }
    out.push({ c: step.c, members: [step.c], key });
  }
  return out;
}

/**
 * Cut the sequence to what fits: `budget` pixels, each step costing `widthOf`.
 * The first step (the active combatant) always shows. Returns the visible
 * steps and the combatants left out, without a dangling round marker.
 */
export function windowSequence(steps, { budget, widthOf }) {
  const shown = [];
  let used = 0;
  let i = 0;
  for (; i < steps.length; i++) {
    const w = widthOf(steps[i]);
    if (shown.length && used + w > budget) break;
    shown.push(steps[i]);
    used += w;
  }
  while (shown.length > 1 && shown[shown.length - 1].divider) shown.pop();
  const rest = steps.slice(shown.length).filter(step => step.c);
  const hidden = rest.flatMap(step => step.members ?? [step.c]);
  return { shown, hidden, restSteps: rest };
}

function carouselActive() {
  return !!game.modules.get("combat-tracker-dock")?.active;
}

function enabled() {
  return setting("turnTracker", true) !== false && !carouselActive();
}

const PLACEHOLDER = /mystery-man|(^|\/)icons\/svg\/|default-icons\//;

/**
 * The picture: an image set on the combatant itself, else the actor's
 * portrait, else the token art. (Combatant#img falls back to the token first,
 * which put ringed token art in the strip.) Placeholder icons and videos are
 * skipped. Wide pictures are cropped around their horizontal centre and from
 * the top (see .frame img in turn-tracker.css).
 */
export function portraitOf(c) {
  const usable = src => !!src && !VIDEO.test(src) && !PLACEHOLDER.test(src);
  const own = c._source?.img ?? null;
  const actorImg = c.actor?.img;
  const tokenImg = c.token?.texture?.src;
  return [own, actorImg, tokenImg].find(usable) ?? [actorImg, tokenImg].find(src => src && !VIDEO.test(src)) ?? "icons/svg/mystery-man.svg";
}

/**
 * alive — fighting (also: back above 0 HP after being knocked out)
 * down  — at 0 HP but not dead: dying / unconscious (shown half grey)
 * dead  — defeated or dead (hidden by default, or grey)
 */
export function lifeState(c) {
  const actor = c.actor;
  const hp = Number(actor?.system?.attributes?.hp?.value);
  const hasHp = Number.isFinite(hp);
  const has = slug => !!(actor?.hasCondition?.(slug) || actor?.statuses?.has?.(slug));
  if (has("dead")) return "dead";
  if (has("dying")) return "down";
  if (hasHp && hp > 0) return "alive";
  if (hasHp && hp <= 0) {
    const playerSide = !!(c.hasPlayerOwner ?? actor?.hasPlayerOwner);
    return (has("unconscious") || playerSide) && !c.isDefeated ? "down" : "dead";
  }
  return c.isDefeated ? "dead" : "alive";
}

/**
 * Initiative that puts `self` right after the one acting now — the table's
 * rule for someone healed back up. One decimal normally; two only when one
 * decimal would collide with the next combatant.
 */
export function initiativeAfter(turns, active, self) {
  const a = Number(active?.initiative);
  if (!Number.isFinite(a)) return null;
  const below = (turns ?? [])
    .filter(t => t !== active && t !== self && Number.isFinite(Number(t?.initiative)) && Number(t.initiative) < a)
    .map(t => Number(t.initiative));
  const next = below.length ? Math.max(...below) : null;
  let target = Math.round((a - 0.1) * 10) / 10;
  if (next !== null && target <= next) target = Math.round(((a + next) / 2) * 100) / 100;
  return target;
}

function nameOf(c) {
  if (game.user.isGM || c.isOwner) return c.name;
  // PF2e can hide NPC names from players; respect it where the system says so.
  const canSee = c.token?.playersCanSeeName;
  return canSee === false ? "???" : c.name;
}

function initiativeText(value) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return "";
  const n = Math.round(Number(value) * 100) / 100;
  return String(n);
}

/** Same creature, as far as the strip is concerned. */
function groupKey(c) {
  if (c.isOwner && !game.user.isGM) return null;            // your own characters never fold
  if (c.hasPlayerOwner) return null;                         // nor anyone's player characters
  const actor = c.actorId ?? c.actor?.id ?? "";
  return [actor, nameOf(c), portraitOf(c), lifeState(c), c.hidden ? "h" : "", c.token?.disposition ?? 0].join("|");
}

export class TurnTracker {
  constructor() {
    this.el = null;
    this.list = null;
    this.nodes = new Map();   // step id → <li>
    this.frame = 0;
    this.expanded = false;
    this.activeId = null;
    this.activeSince = 0;
    this.groupCursor = new Map();
  }

  mount() {
    if (this.el) return;
    this.el = document.createElement("section");
    this.el.id = "pkh-turns";
    this.el.className = "hidden";
    this.el.setAttribute("aria-label", "턴 순서");
    const part = (tag, cls) => Object.assign(document.createElement(tag), { className: cls });
    this.leftEl = part("div", "side left");
    this.roundEl = part("div", "round");
    this.prevEl = part("div", "step prev");
    this.list = part("ol", "queue");
    this.nextEl = part("div", "step next");
    this.rightEl = part("div", "side right");
    this.el.append(this.leftEl, this.roundEl, this.prevEl, this.list, this.nextEl, this.rightEl);
    this.el.addEventListener("click", ev => this._onClick(ev));
    this.el.addEventListener("contextmenu", ev => this._onContext(ev));
    // Expanded row: the wheel scrolls sideways.
    this.list.addEventListener("wheel", ev => {
      if (!this.expanded) return;
      const delta = Math.abs(ev.deltaY) > Math.abs(ev.deltaX) ? ev.deltaY : ev.deltaX;
      if (!delta) return;
      ev.preventDefault();
      this.list.scrollLeft += delta;
    }, { passive: false });
    document.body.appendChild(this.el);
    this.schedule();
  }

  schedule() {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.render();
    });
  }

  get combat() {
    return game.combats?.viewed ?? game.combat ?? null;
  }

  _hide() {
    this.el?.classList.add("hidden");
  }

  _sizes() {
    const width = Number(setting("turnTrackerWidth", 70)) || 70;
    const aspect = Number(setting("turnTrackerAspect", 1.5)) || 1.5;
    return { width, aspect };
  }

  render() {
    if (!this.el) return;
    const combat = this.combat;
    if (!enabled() || !combat || !combat.turns?.length) return this._hide();

    const hideDefeated = setting("turnTrackerDefeated", "hide") === "hide";
    const active = combat.started ? combat.combatant : null;
    const include = c => c.visible && !(hideDefeated && lifeState(c) === "dead" && c !== active);
    const seq = turnSequence(combat.turns, { started: combat.started, turn: combat.turn, round: combat.round, include });
    if (!seq.length) return this._hide();

    if ((active?.id ?? null) !== this.activeId) {
      this.activeId = active?.id ?? null;
      this.activeSince = performance.now();
    }

    const { width, aspect } = this._sizes();
    this.el.style.setProperty("--pkh-turn-w", `${width}px`);
    this.el.style.setProperty("--pkh-turn-aspect", String(aspect));
    this.el.style.setProperty("--pkh-turn-top", `${Number(setting("turnTrackerTop", 10)) || 0}px`);
    this.el.classList.remove("hidden");
    this.el.classList.toggle("not-started", !combat.started);

    // Controls first: their width decides how many portraits fit.
    this.roundEl.innerHTML = combat.started
      ? `<em>라운드</em><b>${combat.round}</b>`
      : `<em>전투</em><b class="small">준비</b>`;
    this._renderControls(combat);

    // Up next: the first one after the active combatant who will really act.
    const later = combat.started ? seq.slice(1).filter(step => step.c) : [];
    const nextUp = (later.find(step => lifeState(step.c) !== "dead") ?? later[0])?.c ?? null;
    const grouping = setting("turnTrackerGroup", true) !== false;
    const steps = grouping
      ? groupSequence(seq, { keyOf: groupKey, keep: c => c === active || c === nextUp })
      : seq.map(step => (step.c ? { c: step.c, members: [step.c] } : step));

    const unit = width + GAP;
    const widthOf = step => (step.divider ? DIVIDER_WIDTH + GAP : step.c === active ? width * ACTIVE_SCALE + GAP : unit);
    const budget = this.expanded ? Infinity : this._budget(width);
    let { shown: visible, hidden: left } = windowSequence(steps, { budget, widthOf });
    // The "+n" chip needs room of its own.
    if (left.length) ({ shown: visible, hidden: left } = windowSequence(steps, { budget: budget - MORE_WIDTH, widthOf }));

    const before = null;

    const used = new Set();
    const fragment = document.createDocumentFragment();
    for (const step of visible) {
      if (step.divider) {
        // One node for the round marker, kept between redraws so it slides too.
        const li = this.dividerEl ??= Object.assign(document.createElement("li"), { className: "divider" });
        li.dataset.id = "divider";
        li.innerHTML = `<span>R${step.divider}</span>`;
        li.setAttribute("aria-label", `${step.divider}라운드 시작`);
        fragment.appendChild(li);
        continue;
      }
      const id = step.members.length > 1 ? `g:${step.c.id}` : step.c.id;
      used.add(id);
      const li = this.nodes.get(id) ?? this._createNode(id);
      this._updateNode(li, step, { active: step.c === active, upNext: step.c === nextUp, combat });
      fragment.appendChild(li);
    }
    if (left.length || this.expanded) fragment.appendChild(this._moreChip(left));
    for (const [id, li] of this.nodes) {
      if (!used.has(id)) { li.remove(); this.nodes.delete(id); }
    }
    this.list.replaceChildren(fragment);
    if (before) this._flip(before);
    this.el.classList.toggle("expanded", this.expanded);
    if (this.expanded) this.list.style.maxWidth = `${Math.max(width * 3, this._budget(width))}px`;
    else this.list.style.maxWidth = "";
    this._center();
  }

  /** Pixels available to portraits: the visible board, less the controls around the queue. */
  _budget(width) {
    const board = boardViewportRect().width || window.innerWidth || 1200;
    const parts = [this.leftEl, this.rightEl, this.roundEl, this.prevEl, this.nextEl];
    const chrome = parts.reduce((sum, el) => sum + (Number(el?.offsetWidth) || 0), 0) + parts.length * 8;
    return Math.max(width * ACTIVE_SCALE + width * 2, board * 0.9 - chrome);
  }

  _moreChip(hidden) {
    const li = this.moreEl ??= document.createElement("li");
    li.className = "more";
    li.dataset.act = "more";
    li.dataset.id = "more";
    if (this.expanded) {
      li.innerHTML = `<span><i class="fa-solid fa-angles-left"></i></span>`;
      li.dataset.tooltip = "접기";
      li.setAttribute("aria-label", "접기");
      return li;
    }
    const names = hidden.slice(0, 12).map(c => esc(nameOf(c)));
    if (hidden.length > 12) names.push(`… 외 ${hidden.length - 12}`);
    li.innerHTML = `<span>+${hidden.length}</span>`;
    li.dataset.tooltip = `<b>뒤에 ${hidden.length}명</b><br>${names.join("<br>")}<br><em>클릭: 모두 펼치기 (휠로 넘기기)</em>`;
    li.setAttribute("aria-label", `뒤에 ${hidden.length}명 더 있음. 클릭하면 모두 펼칩니다.`);
    return li;
  }

  /* ---------------- smooth reordering (FLIP) ---------------- */

  _canAnimate() {
    if (!this.el || this.el.classList.contains("hidden")) return false;
    if (typeof this.list?.getBoundingClientRect !== "function" || typeof Element === "undefined" || !Element.prototype.animate) return false;
    try { return !globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches; } catch (_) { return true; }
  }

  /** Where every node sits now (left edge and width), keyed by its id. */
  _positions() {
    const map = new Map();
    for (const li of this.list.children) {
      const id = li.dataset?.id;
      if (!id) continue;
      const r = li.getBoundingClientRect();
      if (r.width) map.set(id, { left: r.left, top: r.top, width: r.width, height: r.height, node: li });
    }
    return map;
  }

  /** No animation on turn changes: the new order simply appears. */
  _flip() {}

  /** Centre on the visible board, not the window, so an open sidebar doesn't push it off-centre. */
  _center() {
    if (!this.el || this.el.classList.contains("hidden")) return;
    const r = boardViewportRect();
    this.el.style.left = `${Math.round(r.left + r.width / 2)}px`;
  }

  _createNode(id) {
    const li = document.createElement("li");
    li.className = "turn";
    li.dataset.id = id;
    const frame = Object.assign(document.createElement("div"), { className: "frame" });
    const img = document.createElement("img");
    img.alt = "";
    img.loading = "lazy";
    img.decoding = "async";
    li._init = Object.assign(document.createElement("span"), { className: "init" });
    li._count = Object.assign(document.createElement("span"), { className: "count" });
    li._end = Object.assign(document.createElement("span"), { className: "end-hint" });
    li._end.innerHTML = `<i class="fa-solid fa-forward-step"></i><b>턴 종료</b>`;
    frame.append(img, li._init, li._count, li._end);
    li._img = img;
    li._name = Object.assign(document.createElement("span"), { className: "name" });
    li.append(frame, li._name);
    this.nodes.set(id, li);
    return li;
  }

  /** Players end their own turn from their portrait. The GM keeps click-to-look and uses the arrows. */
  _canEnd(c, combat) {
    return !!(combat?.started && c && c === combat.combatant && c.isOwner && !game.user.isGM);
  }

  _updateNode(li, step, { active, upNext, combat }) {
    const c = step.c;
    const members = step.members ?? [c];
    const img = li._img;
    const src = portraitOf(c);
    if (img.getAttribute("src") !== src) img.setAttribute("src", src);

    const name = nameOf(c);
    const init = initiativeText(c.initiative);
    const disposition = DISPOSITION[String(c.token?.disposition ?? 0)] ?? "neutral";
    const canEnd = active && this._canEnd(c, combat);
    const life = lifeState(c);
    li.className = ["turn", disposition,
      active ? "active" : "", upNext ? "next" : "", members.length > 1 ? "group" : "",
      life === "dead" ? "defeated" : "", life === "down" ? "down" : "", c.hidden ? "hidden-combatant" : "",
      c.isOwner ? "mine" : "", canEnd ? "can-end" : "", init ? "" : "no-init"].filter(Boolean).join(" ");

    let tip;
    if (members.length > 1) {
      const lines = members.map(m => `${esc(nameOf(m))}${initiativeText(m.initiative) ? ` · ${initiativeText(m.initiative)}` : ""}`);
      tip = `<b>${esc(name)} ×${members.length}</b><br>${lines.join("<br>")}<br><em>클릭할 때마다 다음 개체로 이동</em>`;
    } else {
      tip = `${esc(name)}${init ? ` · 우선권 ${init}` : ""}${life === "dead" ? " · 쓰러짐" : life === "down" ? " · 의식 불명" : ""}`;
      if (canEnd) tip += `<br><em>클릭: 턴 종료 · Shift+클릭: 토큰 보기</em>`;
      if (game.user.isGM) tip += `<br><em>우클릭: 우선권 조정</em>`;
    }
    li.dataset.tooltip = tip;
    li.setAttribute("aria-label", tip.replace(/<br>/g, ", ").replace(/<[^>]+>/g, ""));

    const initEl = li._init;
    if (init) initEl.textContent = init;
    else initEl.innerHTML = c.isOwner ? `<i class="fa-solid fa-dice-d20" data-act="roll-one"></i>` : "–";
    li._count.textContent = members.length > 1 ? `×${members.length}` : "";
    li._name.textContent = active ? name : "";
    li._members = members.map(m => m.id);
  }

  _renderControls(combat) {
    const btn = (act, icon, tip) => `<button type="button" data-act="${act}" data-tooltip="${tip}" aria-label="${tip}"><i class="fa-solid ${icon}"></i></button>`;
    const gm = game.user.isGM;
    const mine = combat.started && combat.combatant?.isOwner;

    // Previous turn sits left of the portraits, next turn right of them.
    this.prevEl.innerHTML = gm && combat.started ? btn("prev", "fa-chevron-left", "이전 차례") : "";
    this.nextEl.innerHTML = combat.started && (gm || mine)
      ? btn(gm ? "next" : "end-turn", "fa-chevron-right", gm ? "다음 차례" : "내 차례 끝내기")
      : "";

    if (gm) {
      // Initiative is rolled before the fight; once it has started these only get in the way.
      this.leftEl.innerHTML = combat.started ? ""
        : btn("roll-all", "fa-users", "우선권 모두 굴리기 (창 없이 바로)") + btn("roll-npc", "fa-user-gear", "NPC 우선권만 굴리기 (창 없이 바로)") + btn("start", "fa-play", "전투 시작");
      this.rightEl.innerHTML = btn("end", "fa-flag-checkered", "전투 종료");
      return;
    }
    const unrolled = combat.combatants.some(c => c.isOwner && (c.initiative === null || c.initiative === undefined));
    this.leftEl.innerHTML = unrolled ? btn("roll-mine", "fa-dice-d20", "내 우선권 굴리기") : "";
    this.rightEl.innerHTML = "";
  }

  _endTurn(combat) {
    if (!this._canEnd(combat.combatant, combat)) return null;
    if (performance.now() - this.activeSince < END_TURN_GUARD_MS) return null;
    this.activeSince = performance.now();   // one click, one turn
    return combat.nextTurn();
  }

  async _onClick(ev) {
    const combat = this.combat;
    if (!combat) return;
    const act = ev.target.closest("[data-act]")?.dataset.act;
    const li = ev.target.closest("li.turn");
    const id = li?.dataset.id ?? "";
    const c = li ? combat.combatants.get(id.replace(/^g:/, "")) : null;

    switch (act) {
      case "roll-one": return c?.isOwner ? combat.rollInitiative([c.id]) : null;
      // No roll dialog: PF2e passes skipDialog on to each actor's initiative roll.
      case "roll-all": return game.user.isGM ? combat.rollAll({ skipDialog: true }) : null;
      case "roll-npc": return game.user.isGM ? combat.rollNPC({ skipDialog: true }) : null;
      case "roll-mine": {
        const ids = combat.combatants.filter(x => x.isOwner && (x.initiative === null || x.initiative === undefined)).map(x => x.id);
        return ids.length ? combat.rollInitiative(ids) : null;
      }
      case "start": return game.user.isGM ? combat.startCombat() : null;
      case "prev": return game.user.isGM ? combat.previousTurn() : null;
      case "next": return game.user.isGM ? combat.nextTurn() : null;
      case "end-turn": return this._endTurn(combat);
      case "end": return game.user.isGM ? combat.endCombat() : null;
      case "more": {
        this.expanded = !this.expanded;
        this.render();
        if (!this.expanded) this.list.scrollLeft = 0;
        return null;
      }
    }
    if (!c) return null;

    // Your own portrait on your own turn: end the turn (Shift+click just looks).
    if (li.classList.contains("active") && this._canEnd(c, combat) && !ev.shiftKey) return this._endTurn(combat);

    // A folded group: each click moves on to the next creature in it.
    let target = c;
    if (id.startsWith("g:") && li._members?.length) {
      const n = this.groupCursor.get(id) ?? 0;
      target = combat.combatants.get(li._members[n % li._members.length]) ?? c;
      this.groupCursor.set(id, n + 1);
    }

    // Otherwise: look at that token, and pick it up if it is yours.
    const token = target?.token?.object;
    if (!token || !token.visible) return null;
    canvas.animatePan?.({ x: token.center.x, y: token.center.y, duration: 250 });
    if (token.isOwner && !ev.shiftKey) token.control({ releaseOthers: true });
    return null;
  }

  /** GM: right-click opens the initiative editor for that combatant. */
  async _onContext(ev) {
    const li = ev.target.closest("li.turn");
    if (!li || !game.user.isGM) return;
    ev.preventDefault();
    const combat = this.combat;
    const c = combat?.combatants.get(String(li.dataset.id).replace(/^g:/, ""));
    if (c) openInitiativeEditor(combat, c, li);
  }
}

/* ======================================================================== *
 * Initiative editor (right-click a portrait)
 *
 * Type a number (one decimal is fine — 18.5 goes between 19 and 18), nudge it
 * with ±1 / ±0.1, or put the combatant right after whoever is acting now:
 * the table's rule for a character healed back up from 0 HP. The current turn
 * stays with the same combatant when the order changes.
 * ======================================================================== */

const round1 = v => Math.round(Number(v) * 10) / 10;

export function openInitiativeEditor(combat, c, anchor) {
  document.getElementById("pkh-init-pop")?.remove();
  const pop = document.createElement("section");
  pop.id = "pkh-init-pop";
  const active = combat.started ? combat.combatant : null;
  const after = active && active !== c ? initiativeAfter(combat.turns, active, c) : null;
  const current = Number.isFinite(Number(c.initiative)) ? Number(c.initiative) : "";
  pop.innerHTML = `
    <header><img src="${esc(portraitOf(c))}" alt=""><strong>${esc(c.name)}</strong></header>
    <div class="row value">
      <button type="button" data-d="-1">−1</button><button type="button" data-d="-0.1">−0.1</button>
      <input type="number" step="0.1" value="${current}" aria-label="우선권">
      <button type="button" data-d="0.1">+0.1</button><button type="button" data-d="1">+1</button>
    </div>
    ${after !== null ? `<button type="button" class="wide" data-act="after" data-value="${after}" data-tooltip="${esc(active.name)}의 차례 바로 다음으로 (우선권 ${after})">
      <i class="fa-solid fa-arrow-turn-down"></i> 지금 차례(${esc(active.name)}) 바로 다음으로</button>` : ""}
    <div class="row">
      <button type="button" data-act="defeated">${lifeState(c) === "dead" ? "쓰러짐 해제" : "쓰러짐 표시"}</button>
      <button type="button" data-act="hidden">${c.hidden ? "플레이어에게 보이기" : "플레이어에게 숨기기"}</button>
    </div>
    <div class="row end"><button type="button" data-act="close">닫기</button><button type="button" class="primary" data-act="apply">적용</button></div>`;
  document.body.appendChild(pop);

  const box = anchor.getBoundingClientRect();
  pop.style.left = `${Math.round(Math.min(window.innerWidth - pop.offsetWidth - 8, Math.max(8, box.left + box.width / 2 - pop.offsetWidth / 2)))}px`;
  pop.style.top = `${Math.round(Math.min(window.innerHeight - pop.offsetHeight - 8, box.bottom + 8))}px`;
  const input = pop.querySelector("input");
  input.focus();
  input.select();

  const close = () => {
    pop.remove();
    document.removeEventListener("pointerdown", outside, true);
  };
  const outside = e => { if (!pop.contains(e.target)) close(); };
  setTimeout(() => document.addEventListener("pointerdown", outside, true), 0);

  const apply = async (value, exact = false) => {
    const v = exact ? Number(value) : round1(value);
    if (!Number.isFinite(v)) return ui.notifications.warn("우선권 숫자를 입력하세요.");
    close();
    await combat.setInitiative(c.id, v);
  };

  pop.addEventListener("keydown", e => {
    if (e.key === "Enter") { e.preventDefault(); apply(input.value); }
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(); }
  });
  pop.addEventListener("click", async e => {
    const nudge = e.target.closest("[data-d]")?.dataset.d;
    if (nudge) {
      input.value = round1((Number(input.value) || 0) + Number(nudge));
      return input.focus();
    }
    const act = e.target.closest("[data-act]")?.dataset.act;
    if (act === "apply") return apply(input.value);
    if (act === "after") return apply(e.target.closest("[data-act]").dataset.value, true);
    if (act === "close") return close();
    if (act === "hidden") { close(); return c.update({ hidden: !c.hidden }); }
    if (act === "defeated") {
      close();
      if (typeof ui.combat?._onToggleDefeatedStatus === "function") return ui.combat._onToggleDefeatedStatus(c);
      const defeated = !c.isDefeated;
      await c.update({ defeated });
      const status = CONFIG.specialStatusEffects?.DEFEATED;
      if (status) await c.actor?.toggleStatusEffect?.(status, { overlay: true, active: defeated });
    }
  });
}

export function registerTurnTrackerSettings() {
  const redraw = () => game.pf2eKrHud?.turns?.schedule();
  game.settings.register(MODULE_ID, "turnTracker", {
    name: "턴 트래커 (화면 위)",
    hint: "전투 중 화면 위쪽에 차례 순서·라운드·우선권만 보여주는 가벼운 트래커입니다. Carousel Combat Tracker가 켜져 있으면 표시하지 않습니다.",
    scope: "client", config: true, type: Boolean, default: true, onChange: redraw
  });
  game.settings.register(MODULE_ID, "turnTrackerDefeated", {
    name: "턴 트래커: 쓰러진 전투원",
    hint: "죽거나 패배한 전투원을 숨길지 회색으로 남길지 정합니다. 그 전투원의 차례인 동안은 숨기지 않습니다. HP 0이지만 죽지 않은(빈사·의식 불명) 전투원은 언제나 절반만 회색으로 보이고, HP를 회복하면 원래대로 돌아옵니다.",
    scope: "world", config: true, type: String, default: "hide",
    choices: { hide: "숨기기", grey: "회색으로 표시" }, onChange: redraw
  });
  game.settings.register(MODULE_ID, "turnTrackerWidth", {
    name: "턴 트래커: 초상화 너비 (px)",
    hint: "현재 차례인 초상화는 이보다 1.2배 크게 보입니다. 초상화는 전투원이 많아도 줄어들지 않고, 넘치는 인원은 '+n'으로 묶입니다.",
    scope: "client", config: true, type: Number, default: 70, range: { min: 40, max: 150, step: 2 }, onChange: redraw
  });
  game.settings.register(MODULE_ID, "turnTrackerAspect", {
    name: "턴 트래커: 초상화 비율",
    scope: "client", config: true, type: Number, default: 1.5,
    choices: { 1: "정사각형 (1:1)", 1.25: "약간 긴 (4:5)", 1.5: "초상화 (2:3)", 2: "길쭉한 (1:2)" }, onChange: redraw
  });
  game.settings.register(MODULE_ID, "turnTrackerGroup", {
    name: "턴 트래커: 같은 적 묶기",
    hint: "차례가 연달아 붙은 같은 종류의 적(같은 이름·그림)을 초상화 하나로 묶고 ×n으로 표시합니다. 지금 차례와 다음 차례는 묶지 않습니다.",
    scope: "client", config: true, type: Boolean, default: true, onChange: redraw
  });
  game.settings.register(MODULE_ID, "turnTrackerTop", {
    name: "턴 트래커: 화면 위에서 띄울 거리 (px)",
    hint: "장면 탐색 막대 등과 겹치면 늘리세요.",
    scope: "client", config: true, type: Number, default: 10, range: { min: 0, max: 200, step: 2 }, onChange: redraw
  });
}

export function initTurnTracker() {
  const tracker = new TurnTracker();
  tracker.mount();
  game.pf2eKrHud = { ...(game.pf2eKrHud ?? {}), turns: tracker };

  const redraw = () => tracker.schedule();
  for (const hook of ["createCombat", "updateCombat", "deleteCombat", "combatStart", "combatTurn", "combatRound",
    "createCombatant", "updateCombatant", "deleteCombatant", "canvasReady"]) {
    Hooks.on(hook, redraw);
  }
  // The number of portraits that fit depends on the board width.
  let resizeTimer = 0;
  const refit = () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(redraw, 120); };
  Hooks.on("collapseSidebar", () => setTimeout(redraw, 250));
  window.addEventListener("resize", refit);

  // HP and conditions decide alive / down / dead.
  const inCombat = actor => !!actor && !!tracker.combat?.combatants.some(c => c.actor === actor || c.actorId === actor.id);
  Hooks.on("updateActor", (actor, changes) => {
    if (foundry.utils.hasProperty(changes, "system.attributes.hp") || "img" in changes) { if (inCombat(actor)) redraw(); }
  });
  for (const hook of ["createItem", "deleteItem", "createActiveEffect", "deleteActiveEffect"]) {
    Hooks.on(hook, doc => { if (inCombat(doc.parent)) redraw(); });
  }

  // Token changes matter only for what the strip shows: image, name, visibility, side.
  Hooks.on("updateToken", (token, changes) => {
    if (!tracker.combat?.combatants.some(c => c.tokenId === token.id)) return;
    if (["texture", "name", "hidden", "disposition", "displayName"].some(k => k in changes)) redraw();
  });
  if (carouselActive()) console.log(`${MODULE_ID} | Carousel Combat Tracker is active; the built-in turn tracker stays hidden.`);
}
