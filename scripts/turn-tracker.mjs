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
 * If Carousel Combat Tracker (combat-tracker-dock) is active this strip stays
 * hidden, so the two never stack.
 * ======================================================================== */

const DISPOSITION = { "-2": "secret", "-1": "hostile", "0": "neutral", "1": "friendly" };
const VIDEO = /\.(webm|mp4|m4v|ogv)(\?|$)/i;

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

function carouselActive() {
  return !!game.modules.get("combat-tracker-dock")?.active;
}

function enabled() {
  return setting("turnTracker", true) !== false && !carouselActive();
}

function portraitOf(c) {
  const token = c.token;
  const img = c.img ?? token?.texture?.src ?? c.actor?.img;
  if (img && !VIDEO.test(img)) return img;
  return c.actor?.img && !VIDEO.test(c.actor.img) ? c.actor.img : "icons/svg/mystery-man.svg";
}

function nameOf(c) {
  if (game.user.isGM || c.isOwner) return c.name;
  // PF2e can hide NPC names from players; respect it where the system says so.
  const canSee = c.token?.playersCanSeeName;
  return canSee === false ? "???" : c.name;
}

function initiativeText(value) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return "";
  const n = Number(value);
  return Number.isInteger(n) ? String(n) : n.toFixed(1).replace(/\.0$/, "");
}

export class TurnTracker {
  constructor() {
    this.el = null;
    this.list = null;
    this.nodes = new Map();   // combatant id → <li>
    this.frame = 0;
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
    this.list = part("ol", "queue");
    this.rightEl = part("div", "side right");
    this.el.append(this.leftEl, this.roundEl, this.list, this.rightEl);
    this.el.addEventListener("click", ev => this._onClick(ev));
    this.el.addEventListener("contextmenu", ev => this._onContext(ev));
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

  render() {
    if (!this.el) return;
    const combat = this.combat;
    if (!enabled() || !combat || !combat.turns?.length) return this._hide();

    const hideDefeated = setting("turnTrackerDefeated", "grey") === "hide";
    const active = combat.started ? combat.combatant : null;
    const include = c => c.visible && !(hideDefeated && c.isDefeated && c !== active);
    const seq = turnSequence(combat.turns, { started: combat.started, turn: combat.turn, round: combat.round, include });
    if (!seq.length) return this._hide();

    this.el.style.setProperty("--pkh-turn-size", `${Number(setting("turnTrackerSize", 64)) || 64}px`);
    this.el.style.setProperty("--pkh-turn-top", `${Number(setting("turnTrackerTop", 10)) || 0}px`);
    this.el.classList.remove("hidden");
    this.el.classList.toggle("not-started", !combat.started);
    this._center();

    // Portraits: reuse nodes, so images stay loaded and the active one animates.
    const used = new Set();
    const fragment = document.createDocumentFragment();
    // Up next: the first one after the active combatant who will really act.
    const later = combat.started ? seq.slice(1).filter(step => step.c) : [];
    const nextUp = (later.find(step => !step.c.isDefeated) ?? later[0])?.c ?? null;
    seq.forEach(step => {
      if (step.divider) {
        const li = document.createElement("li");
        li.className = "divider";
        li.innerHTML = `<span>R${step.divider}</span>`;
        li.setAttribute("aria-label", `${step.divider}라운드 시작`);
        fragment.appendChild(li);
        return;
      }
      const c = step.c;
      used.add(c.id);
      const li = this.nodes.get(c.id) ?? this._createNode(c.id);
      this._updateNode(li, c, { active: c === active, upNext: c === nextUp });
      fragment.appendChild(li);
    });
    for (const [id, li] of this.nodes) {
      if (!used.has(id)) { li.remove(); this.nodes.delete(id); }
    }
    this.list.replaceChildren(fragment);

    this.roundEl.innerHTML = combat.started
      ? `<em>라운드</em><b>${combat.round}</b>`
      : `<em>전투</em><b class="small">준비</b>`;
    this._renderControls(combat);
  }

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
    frame.append(img);
    li._img = img;
    li._init = Object.assign(document.createElement("span"), { className: "init" });
    li._name = Object.assign(document.createElement("span"), { className: "name" });
    li.append(frame, li._init, li._name);
    this.nodes.set(id, li);
    return li;
  }

  _updateNode(li, c, { active, upNext }) {
    const img = li._img;
    const src = portraitOf(c);
    if (img.getAttribute("src") !== src) img.setAttribute("src", src);

    const name = nameOf(c);
    const init = initiativeText(c.initiative);
    const disposition = DISPOSITION[String(c.token?.disposition ?? 0)] ?? "neutral";
    li.className = ["turn", disposition,
      active ? "active" : "", upNext ? "next" : "",
      c.isDefeated ? "defeated" : "", c.hidden ? "hidden-combatant" : "",
      c.isOwner ? "mine" : "", init ? "" : "no-init"].filter(Boolean).join(" ");
    li.dataset.tooltip = `${esc(name)}${init ? ` · 우선권 ${init}` : ""}${c.isDefeated ? " · 쓰러짐" : ""}`;
    li.setAttribute("aria-label", li.dataset.tooltip.replace(/<[^>]+>/g, ""));

    const initEl = li._init;
    if (init) initEl.textContent = init;
    else initEl.innerHTML = c.isOwner ? `<i class="fa-solid fa-dice-d20" data-act="roll-one"></i>` : "–";
    li._name.textContent = active ? name : "";
  }

  _renderControls(combat) {
    const left = this.leftEl;
    const right = this.rightEl;
    const btn = (act, icon, tip) => `<button type="button" data-act="${act}" data-tooltip="${tip}" aria-label="${tip}"><i class="fa-solid ${icon}"></i></button>`;

    if (game.user.isGM) {
      left.innerHTML = btn("roll-all", "fa-users", "우선권 모두 굴리기") + btn("roll-npc", "fa-user-gear", "NPC 우선권만 굴리기")
        + (combat.started ? "" : btn("start", "fa-play", "전투 시작"));
      right.innerHTML = (combat.started ? btn("prev", "fa-chevron-left", "이전 차례") + btn("next", "fa-chevron-right", "다음 차례") : "")
        + btn("end", "fa-flag-checkered", "전투 종료");
      return;
    }

    const unrolled = combat.combatants.some(c => c.isOwner && (c.initiative === null || c.initiative === undefined));
    left.innerHTML = unrolled ? btn("roll-mine", "fa-dice-d20", "내 우선권 굴리기") : "";
    right.innerHTML = combat.started && combat.combatant?.isOwner ? `<button type="button" data-act="end-turn" class="wide" data-tooltip="내 차례 끝내기" aria-label="내 차례 끝내기"><i class="fa-solid fa-forward-step"></i> 턴 종료</button>` : "";
  }

  async _onClick(ev) {
    const combat = this.combat;
    if (!combat) return;
    const act = ev.target.closest("[data-act]")?.dataset.act;
    const li = ev.target.closest("li.turn");
    const c = li ? combat.combatants.get(li.dataset.id) : null;

    switch (act) {
      case "roll-one": return c?.isOwner ? combat.rollInitiative([c.id]) : null;
      case "roll-all": return game.user.isGM ? combat.rollAll() : null;
      case "roll-npc": return game.user.isGM ? combat.rollNPC() : null;
      case "roll-mine": {
        const ids = combat.combatants.filter(x => x.isOwner && (x.initiative === null || x.initiative === undefined)).map(x => x.id);
        return ids.length ? combat.rollInitiative(ids) : null;
      }
      case "start": return game.user.isGM ? combat.startCombat() : null;
      case "prev": return game.user.isGM ? combat.previousTurn() : null;
      case "next": return game.user.isGM ? combat.nextTurn() : null;
      case "end-turn": return combat.combatant?.isOwner ? combat.nextTurn() : null;
      case "end": return game.user.isGM ? combat.endCombat() : null;
    }

    // Plain click on a portrait: look at that token, and pick it up if it is yours.
    const token = c?.token?.object;
    if (!token || !token.visible) return;
    canvas.animatePan?.({ x: token.center.x, y: token.center.y, duration: 250 });
    if (token.isOwner && !ev.shiftKey) token.control({ releaseOthers: true });
  }

  /** GM: right-click toggles defeated, Shift+right-click toggles hidden. */
  async _onContext(ev) {
    const li = ev.target.closest("li.turn");
    if (!li || !game.user.isGM) return;
    ev.preventDefault();
    const c = this.combat?.combatants.get(li.dataset.id);
    if (!c) return;
    if (ev.shiftKey) return c.update({ hidden: !c.hidden });
    if (typeof ui.combat?._onToggleDefeatedStatus === "function") return ui.combat._onToggleDefeatedStatus(c);
    const defeated = !c.isDefeated;
    await c.update({ defeated });
    const status = CONFIG.specialStatusEffects?.DEFEATED;
    if (status) await c.actor?.toggleStatusEffect?.(status, { overlay: true, active: defeated });
  }
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
    hint: "쓰러지거나 패배한 전투원을 회색으로 남길지, 트래커에서 숨길지 정합니다. 그 전투원의 차례인 동안은 숨기지 않습니다.",
    scope: "world", config: true, type: String, default: "grey",
    choices: { grey: "회색으로 표시", hide: "숨기기" }, onChange: redraw
  });
  game.settings.register(MODULE_ID, "turnTrackerSize", {
    name: "턴 트래커: 초상화 크기 (px)",
    scope: "client", config: true, type: Number, default: 64, range: { min: 40, max: 110, step: 2 }, onChange: redraw
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
  Hooks.on("collapseSidebar", () => setTimeout(() => tracker._center(), 250));
  window.addEventListener("resize", () => tracker._center());

  // Token changes matter only for what the strip shows: image, name, visibility, side.
  Hooks.on("updateToken", (token, changes) => {
    if (!tracker.combat?.combatants.some(c => c.tokenId === token.id)) return;
    if (["texture", "name", "hidden", "disposition", "displayName"].some(k => k in changes)) redraw();
  });
  if (carouselActive()) console.log(`${MODULE_ID} | Carousel Combat Tracker is active; the built-in turn tracker stays hidden.`);
}
