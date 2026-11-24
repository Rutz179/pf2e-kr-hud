/*
 * Reactions that change damage (Shield Block, Intercept Attack, the champion's reactions):
 * the parts that need no Foundry at import time, so node tests can load them.
 *
 *  - which reactions are asked when the damage ROLL appears (PRE_RULES),
 *  - what kind of damage a roll holds (physical / energy),
 *  - the give-back split when the damage is already in,
 *  - which reservation wins, the guardian's roll options,
 *  - the dry run ("what would this token lose?") and the applyDamage wrapper, both with
 *    everything Foundry-shaped passed in (reactions.mjs wires them up).
 */

/*
 * Rule numbers (Player Core / Player Core 2 / Battlecry!):
 *   - Intercept Attack: an ally within 10 ft would take physical damage; the guardian takes it instead, with the guardian's own immunities, weaknesses and resistances.
 *   - Retributive Strike, Glimpse of Redemption, Liberating Step, Flash of Grandeur: an enemy damages an ally, both in the champion's aura (15 ft): the ally gains resistance to all damage against the triggering damage = 2 + the champion's level.
 *   - Selfish Shield: an enemy in the aura damages the champion: resistance = 2 + half level (rounded down).
 */
const CHAMPION_ALLY = { pre: "resist", who: "ally", range: 15, amount: level => 2 + level };
export const PRE_RULES = {
  "shield-block": { pre: "shield", who: "self" },
  "quick-shield-block": { pre: "shield", who: "self" },
  "intercept-attack": { pre: "redirect", who: "ally", range: 10 },
  "retributive-strike": CHAMPION_ALLY,
  "glimpse-of-redemption": CHAMPION_ALLY,
  "liberating-step": CHAMPION_ALLY,
  "flash-of-grandeur": CHAMPION_ALLY,
  "selfish-shield": { pre: "resist", who: "self", range: 15, amount: level => 2 + Math.floor(level / 2) }
};

/** Resistance a `resist` reaction gives at this level (0 when the rule has none). */
export function preAmount(rule, level) {
  const n = Number(level) || 0;
  return typeof rule?.amount === "function" ? Math.max(0, rule.amount(n)) : 0;
}

export const PHYSICAL = new Set(["bludgeoning", "piercing", "slashing"]);
export const ENERGY_INTERCEPT = new Set(["acid", "cold", "electricity", "fire", "sonic"]);

/** Non-persistent damage types of a roll ({ type, persistent } instances, or PF2e's flag `damageRoll.types`). */
export function liveTypes({ instances = [], flagTypes = null } = {}) {
  if (instances.length) return instances.filter(i => !i?.persistent).map(i => i.type);
  return Object.entries(flagTypes ?? {})
    .filter(([, cats]) => Object.keys(cats ?? {}).some(c => c !== "persistent"))
    .map(([type]) => type);
}

/** Does this roll hold damage Intercept Attack can take (physical; energy too with Energy Interceptor)? */
export function interceptable(types, { energy = false } = {}) {
  return types.some(type => PHYSICAL.has(type) || (energy && ENERGY_INTERCEPT.has(type)));
}

/** A name or slug as PF2e slugs it ("Energy Interceptor" → "energy-interceptor"). */
export function slugify(text) {
  return String(text ?? "").toLowerCase().replace(/['’]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

/* damage already applied: what to give back */

const HP = "system.attributes.hp.value";
const SP = "system.attributes.hp.sp.value";
const TEMP = "system.attributes.hp.temp";

/** How much each pool lost, from PF2e's `appliedDamage.updates` ([{ path, value }], value = how much it went down). */
export function lostByPath(updates = []) {
  const out = { hp: 0, sp: 0, temp: 0 };
  for (const u of updates ?? []) {
    const v = Math.max(0, Number(u?.value) || 0);
    if (u?.path === HP) out.hp += v;
    else if (u?.path === SP) out.sp += v;
    else if (u?.path === TEMP) out.temp += v;
  }
  return out;
}

/**
 * Give back `amount` of what was lost. PF2e takes temp HP first, then stamina, then HP,
 * so the damage that would not have been taken is the last part: HP first, then stamina, then temp HP.
 */
export function giveBack(lost, amount) {
  let left = Math.max(0, Math.floor(Number(amount) || 0));
  const take = n => { const v = Math.min(left, Math.max(0, n || 0)); left -= v; return v; };
  const hp = take(lost?.hp);
  const sp = take(lost?.sp);
  const temp = take(lost?.temp);
  return { hp, sp, temp, total: hp + sp + temp };
}

/** Shield Block after the fact: the shield takes `hardness` off the damage, and the rest (up to its HP) itself. */
export function shieldFix({ loss, hardness, shieldHp }) {
  const total = Math.max(0, Number(loss) || 0);
  const absorb = Math.min(Math.max(0, Number(hardness) || 0), total);
  const shieldDamage = Math.min(Math.max(0, Number(shieldHp) || 0), total - absorb);
  return { absorb, shieldDamage };
}

/* reservations */

/**
 * Which reservations are folded in: a redirect beats everything (the target takes nothing);
 * else the highest resistance and a shield; everything else expires unused.
 */
export function pickReservations(list = []) {
  const redirect = list.find(r => r.kind === "redirect") ?? null;
  if (redirect) return { redirect, resist: null, shield: null, rest: list.filter(r => r !== redirect) };
  const resists = list.filter(r => r.kind === "resist");
  const resist = resists.reduce((best, r) => (!best || (Number(r.amount) || 0) > (Number(best.amount) || 0) ? r : best), null);
  const shield = list.find(r => r.kind === "shield") ?? null;
  return { redirect: null, resist, shield, rest: list.filter(r => r !== resist && r !== shield) };
}

/* roll options (as PF2e's applyDamageFromMessage builds them) */

/** The attacker's `self:` options as `origin:` ones. */
export const originOptionsOf = options => [...(options ?? [])].filter(o => o.startsWith("self:")).map(o => o.replace(/^self\b/, "origin"));

/**
 * The roll options of PF2e's applyDamageFromMessage for one token:
 *   l = context options (+ origin:ally|enemy, + the target's `target:` options when none are there)
 *   final = l without self:/target: entries + item options (afflictions, conditions, effects) + origin options + the clone's self options
 */
export function damageOptionList(contextOptions, { alliance = null, targetOptions = () => [] } = {}) {
  const l = [...(contextOptions ?? [])];
  if (alliance) l.push(`origin:${alliance}`);
  if (!l.some(o => o.startsWith("target"))) l.push(...targetOptions());
  return l;
}

export function finalDamageOptions(list, itemOptions, originOptions, cloneSelf) {
  return new Set([
    ...list.filter(o => !/^(?:self|target)(?::|$)/.test(o)),
    ...(itemOptions ?? []),
    ...(originOptions ?? []),
    ...(cloneSelf ?? [])
  ]);
}

/** The guardian takes the hit: the target's roll options minus its own `self:` ones, plus the guardian's. */
export function guardianRollOptions(rollOptions, guardianSelf = []) {
  return new Set([...(rollOptions ?? [])].filter(o => !o.startsWith("self:")).concat(guardianSelf ?? []));
}

/* the dry run */

/**
 * PF2e's own applyDamage on a throwaway clone with its writes stubbed. What PF2e would write, and why none of it happens here:
 *  - damage dice from synthetics: only for healing, and damage <= 0 never gets this far;
 *  - the held shield's update: only when shieldBlockRequest is on (always off here);
 *  - this.update(...): stubbed on the clone, returns nothing, so the "defeated" branch (toggleDefeated, disintegrate effect) is skipped;
 *  - persistent damage conditions: createEmbeddedDocuments stubbed;
 *  - the "damage taken" message: carries the marker roll option and is cancelled in preCreateChatMessage.
 * Ephemeral effects are not applied: callers pass none.
 */
export function createDryRun({ randomId = () => Math.random().toString(36).slice(2, 12) } = {}) {
  const live = new Set();
  const isMarked = options => [...(options ?? [])].some(o => live.has(o));
  async function run(clone, args = {}) {
    const damage = args.damage;
    if (typeof damage === "number" ? damage <= 0 : !(Number(damage?.total) > 0)) return 0;
    let captured = 0;
    clone.update = async (_data, opts) => { captured = Number(opts?.damageTaken) || 0; };
    clone.createEmbeddedDocuments = async () => [];
    clone.updateEmbeddedDocuments = async () => [];
    clone.deleteEmbeddedDocuments = async () => [];
    const marker = `pkh-dry:${randomId()}`;
    live.add(marker);
    try {
      await clone.applyDamage({
        ...args,
        rollOptions: new Set([...(args.rollOptions ?? []), marker]),
        shieldBlockRequest: false,
        breakdown: [],
        notes: []
      });
      return captured;
    } catch (_) {
      return null;
    } finally {
      live.delete(marker);
    }
  }
  /** preCreateChatMessage: false (cancel) for a dry run's "damage taken" message, nothing else. */
  const cancel = data => {
    const options = data?.flags?.pf2e?.context?.options;
    return Array.isArray(options) && isMarked(options) ? false : undefined;
  };
  return { run, isMarked, cancel, live };
}

/* the applyDamage wrapper */

/**
 * Folds open reservations into one real application. `wrapped(args)` is PF2e's applyDamage.
 * deps: { isDryRun(args), isRedirected(actor), findOpen(tokenUuid) → [{ id, kind, amount, reactorUuid, spent }],
 *         claim(ids), unclaim(ids), dryRun(actor, args) → number | null, shieldUsable(actor),
 *         addResistance(actor, args, amount) → undo fn, redirect(actor, args, reservation) → true when done,
 *         report([{ id, outcome: "used" | "expired", kind, amount }]), log(err) }
 * Never breaks damage: an error in this code before PF2e's was called → PF2e's, unchanged, once.
 */
export function createApplyDamageWrapper(d) {
  return async function pkhApplyDamage(wrapped, args = {}) {
    let invoked = false;
    let claimed = [];
    const call = a => { invoked = true; return wrapped(a); };
    const report = list => { try { d.report(list); } catch (err) { d.log?.(err); } };
    try {
      const dmg = args?.damage;
      if (!args || d.isDryRun(args) || args.final || args.skipIWR || d.isRedirected(this)
        || (typeof dmg === "number" && dmg <= 0)) return await call(args);
      const tokenUuid = args.token?.uuid;
      const open = tokenUuid ? d.findOpen(tokenUuid) ?? [] : [];
      if (!open.length) return await call(args);
      claimed = open.map(r => r.id);
      d.claim(claimed);
      const would = await d.dryRun(this, args);
      if (would === 0) {
        const out = await call(args);
        report(open.map(r => ({ id: r.id, kind: r.kind, outcome: "expired" })));
        return out;
      }
      const pick = pickReservations(open);
      const results = [];
      const expire = list => list.forEach(r => results.push({ id: r.id, kind: r.kind, outcome: "expired" }));
      if (pick.redirect) {
        if (await d.redirect(this, args, pick.redirect)) {
          results.push({ id: pick.redirect.id, kind: "redirect", outcome: "used" });
          expire(pick.rest);
          report(results);
          return this;
        }
        // The guardian can't take it: the others are no better off, they expire too.
        expire(open);
        const out = await call(args);
        report(results);
        return out;
      }
      const next = { ...args };
      let undo = null;
      if (pick.resist) {
        undo = d.addResistance(this, next, Number(pick.resist.amount) || 0);
        results.push({ id: pick.resist.id, kind: "resist", amount: Number(pick.resist.amount) || 0, outcome: "used" });
      }
      if (pick.shield) {
        if (d.shieldUsable(this)) {
          next.shieldBlockRequest = true;
          results.push({ id: pick.shield.id, kind: "shield", outcome: "used" });
        } else expire([pick.shield]);
      }
      expire(pick.rest);
      let out;
      try {
        out = await call(next);
      } finally {
        try { undo?.(); } catch (err) { d.log?.(err); }
      }
      report(results);
      return out;
    } catch (err) {
      if (invoked) {
        if (claimed.length) d.unclaim?.(claimed);
        throw err;
      }
      d.log?.(err);
      if (claimed.length) d.unclaim?.(claimed);
      return wrapped(args);
    }
  };
}

/** Direct patch (no libWrapper): `wrapper(wrapped, args)` around proto[name], installed once. */
export function patchMethod(proto, name, wrapper, tag = "pkhReactions") {
  if (!proto || typeof proto[name] !== "function") return false;
  if (Object.hasOwn(proto, name) && proto[name][tag]) return false;
  const orig = proto[name];
  const patched = function (args) { return wrapper.call(this, a => orig.call(this, a), args); };
  patched[tag] = true;
  proto[name] = patched;
  return true;
}
