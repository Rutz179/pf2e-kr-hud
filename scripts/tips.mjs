/* ======================================================================== *
 * Calm tooltips for Rutz modules
 *
 * Foundry shows a tooltip after a short wait, but once one is up the next
 * one appears the instant the mouse touches another button — so sweeping the
 * mouse down a popup covered the very button you were heading for. For the
 * elements of Rutz's modules (ids/classes starting pkh- / rcs- / rcc- / rpb-), a
 * tooltip now appears only after the mouse has rested on it (0.8 s), never
 * while just passing over. Foundry's own and other modules' tooltips are not
 * touched. Installed once, whichever Rutz module loads first.
 * ======================================================================== */

const OURS = '[id^="pkh-"], [class^="pkh-"], [class*=" pkh-"], [id^="pf2e-kr-hud"], [id^="rcs-"], [class^="rcs-"], [class*=" rcs-"], [id^="rcc-"], [class^="rcc-"], [class*=" rcc-"], [id^="rpb-"], [class^="rpb-"], [class*=" rpb-"]';
export const TIP_DELAY_MS = 800;

let pending = null;
let shown = null;
let timer = 0;

function restore(el) {
  if (!el || el.dataset.rtip === undefined) return;
  if (!el.dataset.tooltip) el.dataset.tooltip = el.dataset.rtip;
  delete el.dataset.rtip;
}

function cancel() {
  clearTimeout(timer);
  restore(pending);
  pending = null;
}

/** Show `el`'s tooltip once the mouse has rested on it (used after a tooltip is filled in late). */
export function showTipLater(el, ms = TIP_DELAY_MS) {
  if (!el?.dataset?.tooltip) return;
  if (pending !== el) {
    cancel();
    el.dataset.rtip = el.dataset.tooltip;
    el.removeAttribute("data-tooltip");
    pending = el;
  }
  clearTimeout(timer);
  timer = setTimeout(() => {
    if (pending !== el) return;
    restore(el);
    pending = null;
    if (el.isConnected && el.matches(":hover")) {
      game.tooltip?.activate?.(el);
      shown = el;
    }
  }, ms);
}

export function installCalmTooltips() {
  if (globalThis.__rutzCalmTips) return;
  globalThis.__rutzCalmTips = true;
  // Window capture runs before Foundry's own listeners: we take the tooltip
  // off the element for a moment, so Foundry has nothing to show right away.
  window.addEventListener("pointerover", ev => {
    const el = ev.target?.closest?.("[data-tooltip]");
    if (!el || el === pending || el === shown || !el.closest(OURS)) return;
    if (shown && shown !== el) { game.tooltip?.deactivate?.(); shown = null; }
    showTipLater(el, Number(el.dataset.rutzTipDelay) || TIP_DELAY_MS);
  }, true);
  window.addEventListener("pointerout", ev => {
    const to = ev.relatedTarget;
    if (pending && !pending.contains(to)) cancel();
    if (shown && !shown.contains(to)) { if (!shown.contains(ev.target) && ev.target !== shown) return; game.tooltip?.deactivate?.(); shown = null; }
  }, true);
  window.addEventListener("pointerdown", () => cancel(), true);
}
