/*
 * 높이차 (house rule, settings): an attack from higher up gets a circumstance bonus.
 *
 *  - Ranged (a ranged weapon or Strike, a spell attack that isn't touch): +1 for every `elevRangedStep` feet
 *    the attacker's token stands above the target's (default every 10 ft, at most `elevRangedMax`, +2).
 *    Shooting up from below: the same as a penalty, if `elevRangedUp` is on.
 *  - Melee: nothing yet (left to the GM's call).
 *
 * The bonus goes into the roll itself (PF2e's Check.roll, before the roll dialog), so it shows in the roll's
 * breakdown and the Shift-dialog can switch it off. Needs a targeted token; elevation is the tokens' own.
 */
import { MODULE_ID, t } from "./shared.mjs";

const setting = (key, fallback) => { try { return game.settings.get(MODULE_ID, key) ?? fallback; } catch (_) { return fallback; } };

export function registerElevationSettings() {
  game.settings.register(MODULE_ID, "elevRangedStep", {
    name: "PKH.Settings.elevRangedStep.Name", hint: "PKH.Settings.elevRangedStep.Hint",
    scope: "world", config: true, type: Number, default: 10,
    choices: { 0: "PKH.Settings.elevRangedStep.Choices.0", 5: "PKH.Settings.elevRangedStep.Choices.5", 10: "PKH.Settings.elevRangedStep.Choices.10", 20: "PKH.Settings.elevRangedStep.Choices.20" }
  });
  game.settings.register(MODULE_ID, "elevRangedMax", {
    name: "PKH.Settings.elevRangedMax.Name", scope: "world", config: true, type: Number, default: 2, range: { min: 1, max: 4, step: 1 }
  });
  game.settings.register(MODULE_ID, "elevRangedUp", {
    name: "PKH.Settings.elevRangedUp.Name", hint: "PKH.Settings.elevRangedUp.Hint", scope: "world", config: true, type: Boolean, default: false
  });
}

/** Is this attack a ranged one? (a ranged weapon or Strike; a spell attack unless it is touch) */
function isRangedAttack(context) {
  const opts = context.options instanceof Set ? context.options : new Set(context.options ?? []);
  const item = context.item ?? context.origin?.item ?? null;
  if (opts.has("item:ranged") || item?.isRanged === true) return true;
  if (opts.has("item:melee") || item?.isMelee === true) return false;
  if (item?.type === "spell") return !/touch/i.test(String(item.system?.range?.value ?? ""));
  return false;
}

const tokenDoc = tk => tk?.document ?? tk ?? null;

/** The bonus (or penalty) for this many feet above the target (negative: below). */
export function rangedElevationBonus(diff) {
  const step = Number(setting("elevRangedStep", 10)) || 0;
  if (!step || !Number.isFinite(diff) || diff === 0) return 0;
  const max = Math.max(1, Number(setting("elevRangedMax", 2)) || 2);
  const n = Math.min(max, Math.floor(Math.abs(diff) / step));
  if (diff > 0) return n;
  return setting("elevRangedUp", false) ? -n : 0;
}

/** Put the high-ground modifier into an attack roll's check (or nothing). */
export function addElevationModifier(check, context = {}) {
  if (context?.type !== "attack-roll" || !check?.push || !game.pf2e?.Modifier) return;
  if (!isRangedAttack(context)) return;
  const target = tokenDoc(context.target?.token);
  const actor = context.origin?.actor ?? context.actor ?? null;
  const origin = tokenDoc(context.origin?.token ?? context.token ?? actor?.getActiveTokens?.()[0] ?? null);
  if (!target || !origin || target === origin) return;
  const diff = (Number(origin.elevation) || 0) - (Number(target.elevation) || 0);
  const bonus = rangedElevationBonus(diff);
  if (!bonus) return;
  check.push(new game.pf2e.Modifier({
    slug: "pkh-elevation", type: "circumstance", modifier: bonus,
    label: t(bonus > 0 ? "Elev.High" : "Elev.Low", { ft: Math.abs(diff) })
  }));
}

/** Wrap PF2e's Check.roll once (the modifier goes in before the roll and its dialog). */
export function initElevation() {
  const C = game.pf2e?.Check;
  if (!C?.roll || C.roll.pkhElevation) return;
  const orig = C.roll;
  const wrapped = async function (check, context = {}, event = null, callback) {
    try { addElevationModifier(check, context ?? {}); } catch (err) { console.warn(`${MODULE_ID} | elevation`, err); }
    return orig.call(this, check, context, event, callback);
  };
  wrapped.pkhElevation = true;
  C.roll = wrapped;
}
