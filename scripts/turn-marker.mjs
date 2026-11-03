/**
 * Rutz turn marker (2D canvas).
 * A blue spinning ring under the active combatant and a yellow ring turning the other way under the next one,
 * drawn just below the token art. Only during a started combat.
 *
 * Self-contained (Foundry + PIXI only): Rutz Diorama and Rutz's PF2e HUD carry the same file. The first copy
 * to start owns `globalThis.RutzTurnMarker`, later copies stay idle. Anything can pause it with
 * `Hooks.callAll("rutzTurnMarkerPause", key, true|false)` (the diorama does while it's open, since it
 * draws its own marker).
 */

const ANIM_SPIN = 1.1;     // rad/s, active ring
const ANIM_NEXT = -0.7;    // rad/s, next ring
const TURN = 0x4cb8ff;
const TURN_HI = 0xd8f0ff;
const NEXT = 0xffd040;
const NEXT_HI = 0xfff3b8;

/**
 * Current and next combatant on a scene: { current, next } token ids (players never learn hidden combatants).
 * `skip(combatant)` can pass over more combatants for "next" (e.g. ones a module skips automatically).
 */
export function combatTurns(sceneId, { skip: skipFn = null } = {}) {
  const c = game.combats?.viewed ?? game.combat;
  if (!c?.started) return null;
  const turns = c.turns ?? [];
  if (!turns.length) return null;
  const isGM = game.user.isGM;
  const sceneOf = (cb) => cb?.sceneId ?? cb?.token?.parent?.id ?? c.scene?.id ?? null;
  const shows = (cb) => cb?.tokenId && sceneOf(cb) === sceneId && (isGM || !cb.hidden);
  const cur = c.combatant;
  let skip = false;
  try { skip = !!(c.settings?.skipDefeated); } catch { /* setting missing */ }
  let next = null;
  const n = turns.length, i0 = Math.max(0, c.turn ?? 0);
  for (let k = 1; k <= n; k++) {
    const cb = turns[(i0 + k) % n];
    if (!cb || cb === cur) continue;
    if (skip && cb.isDefeated) continue;
    if (cb.hidden && !isGM) continue;
    try { if (skipFn?.(cb)) continue; } catch { /* keep it */ }
    next = cb;
    break;
  }
  return {
    current: shows(cur) ? cur.tokenId : null,
    next: shows(next) ? next.tokenId : null
  };
}

const isV7 = () => typeof globalThis.PIXI?.Graphics?.prototype?.lineStyle === "function";

function stroke(g, width, color, alpha) {
  if (isV7()) g.lineStyle({ width, color, alpha, cap: "round" });
  return () => { if (!isV7()) g.stroke({ width, color, alpha, cap: "round" }); };
}

function arc(g, r, a0, a1, width, color, alpha) {
  const done = stroke(g, width, color, alpha);
  g.moveTo(Math.cos(a0) * r, Math.sin(a0) * r);
  g.arc(0, 0, r, a0, a1);
  done();
}

function drawActive(g, R, size) {
  g.clear();
  // soft halo
  arc(g, R * 1.02, 0, Math.PI * 2, size * 0.16, TURN, 0.18);
  // three arcs with gaps
  for (let i = 0; i < 3; i++) {
    const a0 = (i * Math.PI * 2) / 3 + 0.16, a1 = ((i + 1) * Math.PI * 2) / 3 - 0.16;
    arc(g, R, a0, a1, size * 0.055, TURN, 0.95);
    arc(g, R, a0 + 0.05, a1 - 0.05, size * 0.018, TURN_HI, 0.9);
  }
  // little arrowheads at the gaps
  for (let i = 0; i < 3; i++) {
    const a = (i * Math.PI * 2) / 3;
    const done = stroke(g, size * 0.03, TURN, 0.95);
    const p = (r, da) => [Math.cos(a + da) * r, Math.sin(a + da) * r];
    const [x0, y0] = p(R * 1.12, -0.07), [x1, y1] = p(R * 1.03, 0), [x2, y2] = p(R * 1.12, 0.07);
    g.moveTo(x0, y0); g.lineTo(x1, y1); g.lineTo(x2, y2);
    done();
  }
}

function drawNext(g, R, size) {
  g.clear();
  arc(g, R * 1.02, 0, Math.PI * 2, size * 0.11, NEXT, 0.12);
  // three short arcs
  for (let i = 0; i < 3; i++) {
    const a0 = (i * Math.PI * 2) / 3 + 0.3, a1 = a0 + 1.2;
    arc(g, R, a0, a1, size * 0.045, NEXT, 0.95);
    arc(g, R, a0 + 0.06, a1 - 0.06, size * 0.014, NEXT_HI, 0.85);
  }
}

export class TurnMarker2D {
  constructor({ owner = "unknown", enabled = () => true, skip = null } = {}) {
    this.owner = owner;
    this.enabled = enabled;
    this.skip = skip;
    this.paused = new Set();
    this.markers = { current: null, next: null };
    this.ids = { current: null, next: null };
    this._tick = this._tick.bind(this);
    this._refresh = () => this.refresh();
    this._hooks = [];
    this._started = false;
  }

  /** Starts unless another copy already runs. Returns true when this copy owns the marker. */
  start() {
    if (this._started) return true;
    const other = globalThis.RutzTurnMarker;
    if (other && other !== this && other._started) return false;
    globalThis.RutzTurnMarker = this;
    this._started = true;
    const on = (name, fn) => this._hooks.push([name, Hooks.on(name, fn)]);
    for (const h of ["combatStart", "combatTurn", "combatRound", "updateCombat", "deleteCombat", "createCombat",
      "createCombatant", "updateCombatant", "deleteCombatant", "updateToken", "deleteToken"]) on(h, this._refresh);
    on("canvasReady", () => { this._destroyMarkers(); this.refresh(); });
    on("canvasTearDown", () => this._destroyMarkers());
    on("rutzTurnMarkerPause", (key, v) => { v ? this.paused.add(key) : this.paused.delete(key); this.refresh(); });
    this.refresh();
    return true;
  }

  stop() {
    for (const [name, id] of this._hooks) Hooks.off(name, id);
    this._hooks = [];
    this._destroyMarkers();
    this._started = false;
    if (globalThis.RutzTurnMarker === this) delete globalThis.RutzTurnMarker;
  }

  refresh() {
    if (!this._started) return;
    const live = canvas?.ready && this.enabled() && !this.paused.size;
    const turns = live ? combatTurns(canvas.scene?.id, { skip: this.skip }) : null;
    this.ids.current = turns?.current ?? null;
    this.ids.next = turns?.next && turns.next !== turns.current ? turns.next : null;
    const any = this.ids.current || this.ids.next;
    const ticker = canvas?.app?.ticker;
    if (any && ticker && !this._ticking) { ticker.add(this._tick); this._ticking = true; }
    if (!any) {
      if (this._ticking) { ticker?.remove(this._tick); this._ticking = false; }
      for (const m of Object.values(this.markers)) if (m) m.visible = false;
    }
    if (any) this._tick();
  }

  _marker(kind) {
    let m = this.markers[kind];
    if (m && !m.destroyed) return m;
    const parent = canvas.primary ?? canvas.tokens;
    if (typeof parent?.addChild !== "function" || !globalThis.PIXI?.Graphics) return null;
    m = new PIXI.Container();
    m.eventMode = "none";
    m.g = m.addChild(new PIXI.Graphics());
    // sorted with the token art: same elevation, just under the tokens' sort layer
    const layers = foundry?.canvas?.groups?.PrimaryCanvasGroup?.SORT_LAYERS ?? globalThis.PrimaryCanvasGroup?.SORT_LAYERS;
    m.sortLayer = (layers?.TOKENS ?? 700) - 1;
    m.sort = -1e6;
    m.elevation = 0;
    m.kind = kind;
    m.drawnFor = null;
    parent.addChild(m);
    this.markers[kind] = m;
    return m;
  }

  _destroyMarkers() {
    if (this._ticking) { canvas?.app?.ticker?.remove(this._tick); this._ticking = false; }
    for (const k of Object.keys(this.markers)) {
      const m = this.markers[k];
      if (m && !m.destroyed) { m.parent?.removeChild(m); m.destroy({ children: true }); }
      this.markers[k] = null;
    }
  }

  _tick() {
    const ticker = canvas?.app?.ticker;
    const dt = Math.min(0.1, (ticker?.deltaMS ?? 16) / 1000);
    const now = performance.now() / 1000;
    let sortDirty = false;
    for (const kind of ["current", "next"]) {
      const id = this.ids[kind];
      const t = id ? canvas.tokens?.get(id) : null;
      if (!t || !t.visible || t.document.hidden && !game.user.isGM) {
        if (this.markers[kind]) this.markers[kind].visible = false;
        continue;
      }
      const m = this._marker(kind);
      if (!m) continue;
      const size = canvas.dimensions.size;
      const R = (Math.max(t.w, t.h) / 2) * 0.92;
      const key = `${Math.round(R)}`;
      if (m.drawnFor !== key) {
        (kind === "current" ? drawActive : drawNext)(m.g, R, size);
        m.drawnFor = key;
      }
      m.visible = true;
      m.position.set(t.x + t.w / 2, t.y + t.h / 2);
      m.rotation += dt * (kind === "current" ? ANIM_SPIN : ANIM_NEXT);
      m.alpha = kind === "current" ? 0.82 + 0.18 * Math.sin(now * 3) : 0.78 + 0.22 * Math.sin(now * 2.4);
      const elev = t.document.elevation ?? 0;
      if (m.elevation !== elev) { m.elevation = elev; sortDirty = true; }
    }
    if (sortDirty && canvas.primary) canvas.primary.sortDirty = true;
  }
}
