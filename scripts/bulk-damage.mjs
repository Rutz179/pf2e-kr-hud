import { MODULE_ID, esc, setting, t } from "./shared.mjs";

/* ======================================================================== *
 * PF2e Toolbelt's target helper: apply everyone's damage with one click.
 *
 * Toolbelt puts a row per target under a damage card (피해 · 절반 · 두 배 ·
 * 막기) and marks the right one from each target's basic save. With a
 * Fireball over eight creatures that is eight clicks. This adds one button
 * above the rows: "모두 적용", which presses, for every target not yet done,
 * the button its save calls for —
 *   critical failure ×2 · failure ×1 · success ×½ · critical success: nothing
 *   (no save on the card: ×1).
 * It presses Toolbelt's own buttons one after another, so everything Toolbelt
 * and PF2e do on a normal click (IWR, shield, "applied" marks) still happens.
 * GM only. Toolbelt itself is not changed.
 * ======================================================================== */

const DEGREES = ["criticalFailure", "failure", "success", "criticalSuccess"];
const MULT = { criticalFailure: 2, failure: 1, success: 0.5, criticalSuccess: 0 };
const LABEL = { 2: "×2", 1: "×1", 0.5: "×½", get "-1"() { return t("Bulk.Heal"); } };
const busy = new Set();

/**
 * Rows Toolbelt drew for this card, and what to press on each.
 * A target whose save is still to be rolled is left out (and named), so one
 * click never applies full damage to someone who might still save.
 */
function planFor(root) {
  const out = [];
  const waiting = new Set();
  for (const row of root.querySelectorAll(".pf2e-toolbelt-target-damage .damage-application[data-target-uuid]")) {
    if (row.classList.contains("applied")) continue;
    const targetRow = row.closest(".target-row") ?? row.parentElement;
    const name = targetRow?.querySelector(".target-header .name")?.textContent?.trim() || "?";
    if (targetRow?.querySelector('[data-action="roll-save"], .target-header .unknown')) { waiting.add(name); continue; }
    const buttons = [...row.querySelectorAll('[data-action="target-applyDamage"]')];
    const byMult = m => buttons.find(b => Number(b.dataset.multiplier) === m);
    const degree = DEGREES.find(d => row.classList.contains(d));
    let mult = degree ? MULT[degree] : 1;
    let btn = mult ? byMult(mult) ?? (mult === 1 ? buttons.find(b => !b.dataset.multiplier) : null) : null;
    // A healing roll only has the "heal" button (multiplier −1).
    if (!btn && !degree && byMult(-1)) { mult = -1; btn = byMult(-1); }
    if (!mult || !btn) continue;
    out.push({ row, btn, mult, name, uuid: row.dataset.targetUuid });
  }
  return { plan: out, waiting: [...waiting] };
}

function addButton(message, root) {
  if (!game.user.isGM || setting("bulkDamage", true) === false) return false;
  const wrapper = root.querySelector(".pf2e-toolbelt-target-damage");
  if (!wrapper) return false;
  wrapper.querySelector(".pkh-bulk")?.remove();
  const { plan, waiting } = planFor(root);
  const people = new Set(plan.map(p => p.uuid)).size;
  if (plan.length < 2 && !(plan.length && waiting.length)) return true;
  const box = document.createElement("div");
  box.className = "pkh-bulk";
  const summary = plan.map(p => `${p.name} ${LABEL[p.mult] ?? `×${p.mult}`}`).join(" · ")
    + (waiting.length ? `<br><small>${t("Bulk.WaitingSaves", { names: waiting.join(", ") })}</small>` : "");
  const healing = plan.every(p => p.mult < 0);
  box.innerHTML = `<button type="button" data-tooltip="${esc(summary)}"><i class="fa-solid fa-${healing ? "heart" : "bolt"}"></i> ${t(healing ? "Bulk.HealAll" : "Bulk.ApplyAll")} <small>(${t("Bulk.People", { n: people })}${waiting.length ? ` · ${t("Bulk.SavesPending", { n: waiting.length })}` : ""})</small></button>`;
  const btn = box.querySelector("button");
  btn.addEventListener("click", async ev => {
    ev.preventDefault();
    ev.stopPropagation();
    if (busy.has(message.id)) return;
    busy.add(message.id);
    btn.disabled = true;
    try {
      for (const [i, p] of plan.entries()) {
        btn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> ${t("Bulk.Applying", { i: i + 1, n: plan.length })}`;
        p.btn.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
        await new Promise(r => setTimeout(r, 350));
      }
      btn.innerHTML = `<i class="fa-solid fa-check"></i> ${t("Bulk.Applied")}`;
    } finally {
      busy.delete(message.id);
    }
  });
  wrapper.prepend(box);
  return true;
}

export function registerBulkDamageSettings() {
  game.settings.register(MODULE_ID, "bulkDamage", {
    name: "PKH.Settings.bulkDamage.Name",
    hint: "PKH.Settings.bulkDamage.Hint",
    scope: "world", config: true, type: Boolean, default: true
  });
}

export function initBulkDamage() {
  if (!game.modules.get("pf2e-toolbelt")?.active) return;
  // Toolbelt adds its rows after the card is drawn (and asynchronously), so look a few times.
  Hooks.on("renderChatMessageHTML", (message, html) => {
    const root = html instanceof HTMLElement ? html : html?.[0];
    if (!root || !game.user.isGM || !message.rolls?.length) return;
    let tries = 0;
    const look = () => {
      if (addButton(message, root) || ++tries > 6) return;
      setTimeout(look, 150 * tries);
    };
    setTimeout(look, 30);
  });
}
