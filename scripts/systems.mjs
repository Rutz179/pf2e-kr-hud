/*
 * System adapters for the parts that work in any game system (portraits, token HP images, the HUD
 * outside PF2e), and the feature table: which parts of the module run in which system.
 * It is the only file that knows system data paths (the HUD adapters below).
 *
 * Built in: PF2e, D&D 5e, Call of Cthulhu 7e, 인세인 (insane-kr). Anything else reads the
 * prototype token's bar1/bar2. A system or module can add or override an adapter:
 *
 *   Hooks.once("rutzUI.ready", api => api.registerSystem("my-system", {
 *     bars: actor => [{ key, label, value, max, temp?, color? }],   // color: "hp" | "sanity" | "alt"
 *     badges: actor => [{ icon, text, tooltip?, tone?, alwaysText?, onClick?(event, actor) }],
 *     acceptsDrop: data => true,                 // which drags light the portraits up
 *     onPortraitDrop: async (actor, event) => true,
 *     refreshHooks: ["my-system.changed"]        // redraw the portraits when these fire
 *   }));
 */
import { t } from "./shared.mjs";

/*
 * Feature table (main.mjs registers / starts only what is on; the settings window leaves out the settings of what is off).
 * "*" every system, "!pf2e" every system but PF2e, [ids] these systems; "other" = any system not in KNOWN_SYSTEMS.
 */

export const KNOWN_SYSTEMS = ["pf2e", "dnd5e", "dragonbane", "daggerheart", "age-system"];
const PF2E = ["pf2e"];
export const FEATURES = {
  portraits: "*", toolkit: "*", chatFaces: "*", gmTools: "*", turnTracker: "*", chatTrim: "*", polyglot: "*",
  notesJournal: "*", chatEdit: "*", windowMin: "*", diagnostics: "*", tips: "*",
  // the HUD: PF2e's own renderer (hud.mjs) or the small one for other systems (sys-hud.mjs)
  pf2eHud: PF2E,
  systemHud: "!pf2e",
  // C: PF2e rules
  reactions: PF2E, contingency: PF2E, cover: PF2E, elevation: PF2E, sustain: PF2E, xp: PF2E, groupCheck: PF2E,
  recall: PF2E, skillsPage: PF2E, browserLegacy: PF2E, bulkDamage: PF2E, infusedHelper: PF2E, rollRequest: PF2E,
  flatChecks: PF2E, pf2eDefaults: PF2E,
  // B: GM damage / healing button on the HUD (needs the system's damage method; daggerheart: thresholds, left out)
  quickDamage: ["dnd5e", "dragonbane", "age-system", "other"]
};

/** Settings registered by a shared register function that only mean something while their feature is on. */
export const FEATURE_SETTINGS = {
  pf2eHud: ["hudReactionPip", "hudSaveCard", "hudAutoInfused", "hudSlotCard", "hudSlotCardDelay", "hudEffectDurations", "hudHideEffectsPanel"]
};

export function featureOn(id, systemId = globalThis.game?.system?.id) {
  const on = FEATURES[id];
  if (on === "*") return true;
  if (on === "!pf2e") return systemId !== "pf2e";
  if (!Array.isArray(on)) return false;
  return on.includes(systemId) || (on.includes("other") && !KNOWN_SYSTEMS.includes(systemId));
}

/** Setting keys the settings window must leave out in this system. */
export function hiddenSettings(systemId = globalThis.game?.system?.id) {
  const out = new Set();
  for (const [id, keys] of Object.entries(FEATURE_SETTINGS)) if (!featureOn(id, systemId)) keys.forEach(k => out.add(k));
  return out;
}

/** Runs a system call; a throw becomes the fallback (logged once per kind). */
const warned = new Set();
function safe(fn, fallback) {
  try {
    const out = fn();
    return out === undefined ? fallback : out;
  } catch (err) {
    const key = String(err?.message ?? err);
    if (!warned.has(key)) { warned.add(key); console.warn("Rutz UI | system adapter failed", err); }
    return fallback;
  }
}

const num = v => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

const resource = (value, max, extra = {}) => ({ value: num(value), max: Math.max(0, num(max)), ...extra });

/*
 * HUD adapters: the HUD's data outside PF2e, one per game system, plus a plain fallback. Nothing else in the module knows these data paths. Calls into a system are wrapped so they cannot throw (hudView / rollCheck / useItem / applyHp below).
 *
 * Adapter shape (all optional):
 *   hpPath                       update path that holds HP (change detection)
 *   health(actor)                { value, max, temp } — value = HP left (never "marks")
 *   resources(actor)             [{ key, label, value, max?, tip?, act? }]   act: a roll key
 *   defences(actor)              [{ key, label, value, tip? }]
 *   conditions(actor)            [{ id, name, img, off() }]  extra to the active effects
 *   skipEffect(effect)           true: an active effect the adapter already shows
 *   checks(actor)                [{ group, key, label, mod, plain? }]  group null: the HUD's own heading;
 *                                plain: a target number (roll-under), shown without a sign
 *   roll(actor, key, event)      roll one of the checks (or a resource's act)
 *   lists(actor)                 [{ key, label, items }]
 *   use(actor, item, event)      use an item the system's own way
 *   damage(actor, amount)        amount > 0 hurts, < 0 heals
 *   pcTypes                      actor types that are player characters
 */
const fin = v => v !== null && v !== undefined && v !== "" && Number.isFinite(Number(v));
const loc = key => game.i18n.localize(key);
const sortByName = list => [...list].sort((a, b) => String(a.name).localeCompare(String(b.name), game.i18n.lang));
const ofType = (actor, ...types) => sortByName((actor?.items ?? []).filter(i => types.includes(i.type)));
/** A group heading from the system's item type name: "TYPES.Item.weaponPl", else the singular. */
const typeLabel = type => (game.i18n.has?.(`TYPES.Item.${type}Pl`) ? loc(`TYPES.Item.${type}Pl`) : loc(`TYPES.Item.${type}`));
const group = (actor, key, types, label = typeLabel(types[0])) => ({ key, label, items: ofType(actor, ...types) });

/* D&D 5e */

const DND5E_SPELL_KEYS = actor => Object.keys(actor?.system?.spells ?? {});

export const dnd5e = {
  hpPath: "system.attributes.hp",
  pcTypes: ["character"],
  health(actor) {
    const hp = actor?.system?.attributes?.hp;
    return hp ? { value: num(hp.value), max: num(hp.max), temp: num(hp.temp) } : null;
  },
  resources(actor) {
    const s = actor?.system ?? {};
    const out = [];
    // Spell slots: system.spells.spell1...9 + pact, prepared { value, max, level }
    for (const key of DND5E_SPELL_KEYS(actor)) {
      const slot = s.spells[key];
      if (!(num(slot?.max) > 0)) continue;
      const pact = key === "pact";
      const level = pact ? num(slot.level) : Number(key.replace("spell", ""));
      out.push({
        key: `slot:${key}`, label: pact ? loc("DND5E.PactMagic") : String(level), value: num(slot.value), max: num(slot.max),
        tip: pact ? loc("DND5E.PactMagic") : loc(`DND5E.SpellLevel${level}`)
      });
    }
    // Hit dice: HitDice getters value / max (characters)
    const hd = s.attributes?.hd;
    if (hd && num(hd.max) > 0) out.push({ key: "hd", label: loc("DND5E.HitDice"), value: num(hd.value), max: num(hd.max) });
    // Death saves at 0 HP: system.attributes.death.{success,failure}
    const death = s.attributes?.death;
    if (death && actor.type === "character" && num(s.attributes?.hp?.value) <= 0) {
      out.push({ key: "death", label: loc("DND5E.DeathSave"), value: `✓${num(death.success)} ✗${num(death.failure)}`, act: "death" });
    }
    return out;
  },
  defences(actor) {
    const ac = actor?.system?.attributes?.ac?.value;
    return fin(ac) ? [{ key: "ac", label: loc("DND5E.AC"), value: num(ac), tip: loc("DND5E.ArmorClass") }] : [];
  },
  checks(actor) {
    const s = actor?.system ?? {};
    const abilities = globalThis.CONFIG?.DND5E?.abilities ?? {};
    const skills = globalThis.CONFIG?.DND5E?.skills ?? {};
    const out = [];
    for (const [k, cfg] of Object.entries(abilities)) {
      const a = s.abilities?.[k];
      if (!a) continue;
      out.push({ group: loc("DND5E.Abilities"), key: `check:${k}`, label: loc(cfg.label), mod: num(a.mod) });
      if (a.save && fin(a.save.value)) out.push({ group: loc("DND5E.SavingThrow"), key: `save:${k}`, label: loc(cfg.label), mod: num(a.save.value) });
    }
    for (const [k, cfg] of Object.entries(skills)) {
      const sk = s.skills?.[k];
      if (sk) out.push({ group: loc("DND5E.Skills"), key: `skill:${k}`, label: loc(cfg.label), mod: num(sk.total) });
    }
    return out;
  },
  // config.event drives the fast-forward keys.
  roll(actor, key, event) {
    const [kind, id] = String(key).split(":");
    if (kind === "skill") return actor.rollSkill({ skill: id, event });
    if (kind === "check") return actor.rollAbilityCheck({ ability: id, event });
    if (kind === "save") return actor.rollSavingThrow({ ability: id, event });
    if (kind === "death") return actor.rollDeathSave({ event });
    return null;
  },
  lists(actor) {
    const spells = (actor?.items ?? []).filter(i => i.type === "spell")
      .sort((a, b) => num(a.system?.level) - num(b.system?.level) || String(a.name).localeCompare(String(b.name), game.i18n.lang));
    return [
      group(actor, "weapons", ["weapon"]),
      { key: "spells", label: typeLabel("spell"), items: spells },
      // features with something to use: system.activities
      { key: "features", label: loc("DND5E.Features"), items: ofType(actor, "feat").filter(i => (i.system?.activities?.size ?? 0) > 0) },
      group(actor, "consumables", ["consumable"])
    ];
  },
  // Item5e#use: no activity → nothing, so the card is shown instead.
  use(actor, item, event) {
    if ((item.system?.activities?.size ?? 0) === 0 && typeof item.displayCard === "function") return item.displayCard();
    return item.use({ event });
  },
  // Actor5e#applyDamage(number): temp HP first, negative heals.
  damage(actor, amount) {
    return actor.applyDamage(amount);
  }
};

/* Dragonbane */

const DOD_ATTRIBUTES = ["str", "con", "agl", "int", "wil", "cha"];

export const dragonbane = {
  hpPath: "system.hitPoints",
  pcTypes: ["character"],
  health(actor) {
    const hp = actor?.system?.hitPoints;
    return hp ? { value: num(hp.value), max: num(hp.max), temp: 0 } : null;
  },
  resources(actor) {
    const s = actor?.system ?? {};
    const out = [];
    if (s.willPoints && num(s.willPoints.max) > 0) out.push({ key: "wp", label: loc("DoD.secondaryAttributeTypes.willPoints"), value: num(s.willPoints.value), max: num(s.willPoints.max) });
    // deathRolls { successes, failures } (character). Shown only: the sheet's death roll is a CON test plus its own tally update, with no API to call.
    if (s.deathRolls && num(s.hitPoints?.value) <= 0) {
      out.push({ key: "death", label: loc("DoD.ui.character-sheet.deathRolls"), value: `✓${num(s.deathRolls.successes)} ✗${num(s.deathRolls.failures)}` });
    }
    return out;
  },
  // Armour: worn armour + helmet ratings, monsters system.armor; the system's own sum without damage type.
  defences(actor) {
    const s = actor?.system ?? {};
    let value = num(s.equippedArmor?.system?.rating) + num(s.equippedHelmet?.system?.rating);
    if (actor?.type === "monster") value += num(s.armor);
    const any = actor?.type === "monster" || s.equippedArmor || s.equippedHelmet;
    return any ? [{ key: "armor", label: loc("DoD.ui.character-sheet.armor"), value }] : [];
  },
  // Six attribute conditions system.conditions.<a>.value, labels DoD.conditions.<a>, pictures CONFIG.DoD.conditionEffects, turned off with updateCondition.
  conditions(actor) {
    const c = actor?.system?.conditions;
    if (!c) return [];
    const effects = globalThis.CONFIG?.DoD?.conditionEffects ?? {};
    return DOD_ATTRIBUTES.filter(a => c[a]?.value).map(a => ({
      id: `dod-${a}`, name: loc(`DoD.conditions.${a}`), img: effects[`system.conditions.${a}.value`]?.img ?? "icons/svg/aura.svg",
      off: () => actor.updateCondition(a, false)
    }));
  },
  // The system mirrors those conditions as status effects "dragonbane.condition.*".
  skipEffect: effect => [...(effect?.statuses ?? [])].some(s => String(s).startsWith("dragonbane.condition.")),
  checks(actor) {
    const s = actor?.system ?? {};
    const out = [];
    if (s.attributes) {
      for (const a of DOD_ATTRIBUTES) {
        if (s.attributes[a]) out.push({ group: null, key: `attr:${a}`, label: loc(`DoD.attributes.${a}`), mod: num(s.attributes[a].value), plain: true });
      }
    }
    // Skills are items (type skill, system.value), prepared into system.skills.
    for (const sk of sortByName(Array.isArray(s.skills) ? s.skills : [])) {
      out.push({ group: loc("DoD.ui.character-sheet.skills"), key: `skill:${sk.name}`, label: sk.name, mod: num(sk.system?.value), plain: true });
    }
    return out;
  },
  // rollAttribute(actor, attr); testSkill(name)
  roll(actor, key) {
    const i = String(key).indexOf(":");
    const kind = key.slice(0, i);
    const id = key.slice(i + 1);
    if (kind === "attr") return game.dragonbane?.rollAttribute?.(actor, id);
    if (kind === "skill") return actor.testSkill(id);
    return null;
  },
  lists(actor) {
    return [
      { key: "weapons", label: loc("DoD.ui.character-sheet.weapons"), items: ofType(actor, "weapon") },
      { key: "spells", label: loc("DoD.ui.character-sheet.spells"), items: ofType(actor, "spell") },
      { key: "abilities", label: loc("DoD.ui.character-sheet.abilities"), items: ofType(actor, "ability") },
      { key: "items", label: loc("DoD.ui.character-sheet.inventory"), items: ofType(actor, "item") }
    ];
  },
  use(actor, item) {
    if (item.type === "ability") return actor.useAbility(item);
    if (item.type === "skill") return actor.testSkill(item.name);
    // weapons / spells: game.dragonbane.useItem(name, type) rolls for the chat speaker, so only when that speaker is this actor; otherwise the item's chat card.
    if (["weapon", "spell"].includes(item.type) && typeof game.dragonbane?.useItem === "function") {
      const sp = ChatMessage.getSpeaker();
      const speaker = sp?.token ? game.actors.tokens?.[sp.token] : game.actors.get(sp?.actor);
      if (speaker && (speaker === actor || speaker.id === actor.id)) return game.dragonbane.useItem(item.name, item.type);
    }
    if (typeof item.toChatCard === "function") return item.toChatCard();
    return item.sheet?.render(true);
  },
  // DoDActor#applyDamage(n): HP clamp(value - n, 0, max), negative heals.
  damage(actor, amount) {
    return actor.applyDamage(amount);
  }
};

/* Daggerheart */

const DH_TRAITS = ["agility", "strength", "finesse", "instinct", "presence", "knowledge"];
// hitPoints and stress count marks (reverse: true), hope counts up
const marks = r => ({ marked: num(r?.value), max: num(r?.max) });

export const daggerheart = {
  hpPath: "system.resources.hitPoints",
  pcTypes: ["character"],
  // resources.hitPoints { value = marked, max }
  health(actor) {
    const hp = actor?.system?.resources?.hitPoints;
    if (!hp) return null;
    const { marked, max } = marks(hp);
    return { value: Math.max(0, max - marked), max, temp: 0 };
  },
  resources(actor) {
    const s = actor?.system ?? {};
    const out = [];
    const stress = s.resources?.stress;
    if (stress && num(stress.max) > 0) out.push({ key: "stress", label: loc("DAGGERHEART.GENERAL.stress"), value: num(stress.value), max: num(stress.max) });
    const hope = s.resources?.hope;
    if (hope && num(hope.max) > 0) out.push({ key: "hope", label: loc("DAGGERHEART.GENERAL.hope"), value: num(hope.value), max: num(hope.max) });
    const armor = s.armorScore;                                       // { value = marked, max }
    if (armor && num(armor.max) > 0) out.push({ key: "armor", label: loc("DAGGERHEART.GENERAL.armorSlots"), value: num(armor.value), max: num(armor.max) });
    return out;
  },
  defences(actor) {
    const s = actor?.system ?? {};
    const out = [];
    if (fin(s.evasion) && actor.type !== "adversary") out.push({ key: "evasion", label: loc("DAGGERHEART.GENERAL.evasion"), value: num(s.evasion) });
    if (fin(s.difficulty) && actor.type === "adversary") out.push({ key: "difficulty", label: loc("DAGGERHEART.GENERAL.difficulty"), value: num(s.difficulty) });
    const th = s.damageThresholds;
    if (th && (fin(th.major) || fin(th.severe))) {
      out.push({
        key: "thresholds", label: "", value: `${num(th.major)} / ${num(th.severe)}`,
        tip: `${loc("DAGGERHEART.GENERAL.DamageThresholds.majorThreshold")} / ${loc("DAGGERHEART.GENERAL.DamageThresholds.severeThreshold")}`
      });
    }
    return out;
  },
  // traits.<t>.value, labels DAGGERHEART.CONFIG.Traits.<t>.name
  checks(actor) {
    const traits = actor?.system?.traits;
    if (!traits) return [];
    return DH_TRAITS.filter(k => traits[k]).map(k => ({ group: null, key: `trait:${k}`, label: loc(`DAGGERHEART.CONFIG.Traits.${k}.name`), mod: num(traits[k].value) }));
  },
  // rollTrait(trait, options)
  roll(actor, key) {
    const [kind, id] = String(key).split(":");
    return kind === "trait" ? actor.rollTrait(id) : null;
  },
  lists(actor) {
    return [
      group(actor, "weapons", ["weapon"]),
      group(actor, "domain", ["domainCard"]),
      group(actor, "features", ["feature"]),
      group(actor, "consumables", ["consumable"])
    ];
  },
  // DHItem#use(event) runs the item's action (choice dialog when several); without actions it does nothing, so the card goes to chat.
  use(actor, item, event) {
    const actions = item.system?.actionsList;
    const count = actions?.size ?? actions?.length ?? 0;
    if (count > 0) return item.use(event);
    if (typeof item.toChat === "function") return item.toChat(item.uuid);
    return item.sheet?.render(true);
  },
  // Damage goes through thresholds, armour slots and the player's choices: left to the system.
  damage: null
};

/* AGE System */

const ageSetting = (key, fallback) => {
  try { return game.settings.get("age-system", key); } catch (_) { return fallback; }
};

export const ageSystem = {
  hpPath: "system.health",
  pcTypes: ["char"],                                                  // char is PCs and NPCs
  // health { value, max }
  health(actor) {
    const h = actor?.system?.health;
    return h ? { value: num(h.value), max: num(h.max), temp: 0 } : null;
  },
  resources(actor) {
    const s = actor?.system ?? {};
    const out = [];
    // Power points when the world uses them (setting usePowerPoints, default true); label by the power flavour (setting powerFlavor, default "power").
    if (ageSetting("usePowerPoints", true) && s.powerPoints && num(s.powerPoints.max) > 0) {
      const flavor = ageSetting("powerFlavor", "power");
      const key = `age-system.powerFlavor.${flavor}.points`;
      out.push({ key: "pp", label: loc(game.i18n.has?.(key) ? key : "age-system.powerFlavor.power.points"), value: num(s.powerPoints.value), max: num(s.powerPoints.max) });
    }
    // Conviction when used (setting useConviction, default false)
    if (ageSetting("useConviction", false) && s.conviction && num(s.conviction.max) > 0) {
      out.push({ key: "conviction", label: loc("age-system.conviction"), value: num(s.conviction.value), max: num(s.conviction.max) });
    }
    return out;
  },
  // defense.total, armor.toughness.total, armor.impact / ballistic
  defences(actor) {
    const s = actor?.system ?? {};
    const out = [];
    if (fin(s.defense?.total)) out.push({ key: "defense", label: loc("age-system.defense"), value: num(s.defense.total) });
    if (fin(s.armor?.toughness?.total)) out.push({ key: "toughness", label: loc("age-system.toughness"), value: num(s.armor.toughness.total) });
    if (s.armor && (num(s.armor.impact) || num(s.armor.ballistic))) {
      out.push({ key: "armor", label: loc("age-system.armor"), value: num(s.armor.ballistic) ? `${num(s.armor.impact)} / ${num(s.armor.ballistic)}` : num(s.armor.impact) });
    }
    return out;
  },
  // CONFIG.ageSystem.abilities (the world's ability set); label age-system.<abl>
  checks(actor) {
    const abl = actor?.system?.abilities;
    if (!abl) return [];
    const keys = Object.keys(globalThis.CONFIG?.ageSystem?.abilities ?? {});
    return keys.filter(k => abl[k]).map(k => ({ group: null, key: `abl:${k}`, label: loc(`age-system.${k}`), mod: num(abl[k].total) }));
  },
  // game.ageSystem.roll = Dice.ageRollCheck({ event, actor, abl, rollType }); event must be an object (it reads event.ctrlKey / altKey).
  roll(actor, key, event) {
    const [kind, id] = String(key).split(":");
    if (kind !== "abl") return null;
    const ev = event ?? new MouseEvent("click");
    return game.ageSystem?.roll?.({ event: ev, actor, abl: id, rollType: globalThis.CONFIG?.ageSystem?.ROLL_TYPE?.ABILITY ?? "ability" });
  },
  lists(actor) {
    return [
      group(actor, "weapons", ["weapon"]),
      group(actor, "powers", ["power"]),
      group(actor, "focus", ["focus"]),
      group(actor, "talents", ["talent"]),
      group(actor, "equipment", ["equipment"])
    ];
  },
  // ageSystemItem#roll(event): weapons, powers, focuses; talents and equipment: the item card.
  use(actor, item, event) {
    const ev = event ?? new MouseEvent("click");
    if (["weapon", "power", "focus"].includes(item.type) && typeof item.roll === "function") return item.roll(ev);
    if (typeof item.showItem === "function") return item.showItem();
    return item.sheet?.render(true);
  },
  // applyHPchange(newHP) with isNewHP (default true) writes the new value, as the system's own damage card does. (isNewHP false adds damage instead of subtracting.)
  damage(actor, amount) {
    const h = this.health(actor);
    if (!h) return null;
    const next = Math.max(0, Math.min(h.max, h.value - Number(amount)));
    return actor.applyHPchange(next);
  }
};

/* Any other system: the token bar attributes the system registered (system.json primaryTokenAttribute / secondaryTokenAttribute), else the prototype token's bars. */

const attrPath = (actor, which) => {
  const sys = which === 1 ? game.system?.primaryTokenAttribute : game.system?.secondaryTokenAttribute;
  return sys || actor?.prototypeToken?.[`bar${which}`]?.attribute || null;
};
const attrOf = (actor, path) => {
  if (!path) return null;
  const data = foundry.utils.getProperty(actor?.system ?? {}, path);
  return data && typeof data === "object" && "value" in data && fin(data.max) ? data : null;
};

export const generic = {
  get hpPath() { const p = attrPath(null, 1); return p ? `system.${p}` : null; },
  pcTypes: ["character"],
  health(actor) {
    const hp = attrOf(actor, attrPath(actor, 1));
    return hp ? { value: num(hp.value), max: num(hp.max), temp: num(hp.temp) } : null;
  },
  resources(actor) {
    const path = attrPath(actor, 2);
    const r = attrOf(actor, path);
    return r ? [{ key: path, label: "", value: num(r.value), max: num(r.max) }] : [];
  },
  // Plain update of the primary attribute; temp first when the attribute has one.
  damage(actor, amount) {
    const path = attrPath(actor, 1);
    const hp = attrOf(actor, path);
    if (!hp) return null;
    let n = Number(amount);
    const update = {};
    if (n > 0 && fin(hp.temp) && num(hp.temp) > 0) {
      const used = Math.min(num(hp.temp), n);
      update[`system.${path}.temp`] = num(hp.temp) - used;
      n -= used;
    }
    update[`system.${path}.value`] = Math.max(0, Math.min(num(hp.max), num(hp.value) - n));
    return actor.update(update);
  }
};

export const ADAPTERS = { dnd5e, dragonbane, daggerheart, "age-system": ageSystem };

/** "attributes.hp" style paths in an actor's system data (the token bars). */
function barFromAttribute(actor, attribute, label) {
  if (!attribute) return null;
  const data = foundry.utils.getProperty(actor.system ?? {}, attribute);
  if (!data || typeof data !== "object" || !("value" in data) || !Number.isFinite(Number(data.max))) return null;
  return resource(data.value, data.max, { key: attribute, label, temp: num(data.temp) });
}

const hpBar = actor => {
  const hp = actor.system?.attributes?.hp;
  return hp ? [resource(hp.value, hp.max, { key: "hp", label: t("Systems.Hp"), temp: num(hp.temp), color: "hp" })] : [];
};

/** HP and the first resource with a maximum, from the HUD adapter (portrait bars). */
const adapterBars = data => actor => {
  const out = [];
  const h = safe(() => data.health(actor), null);
  if (h) out.push(resource(h.value, h.max, { key: "hp", label: t("Systems.Hp"), temp: num(h.temp), color: "hp" }));
  const r = (safe(() => data.resources(actor), []) ?? []).find(x => Number.isFinite(Number(x?.max)) && Number(x.max) > 0);
  if (r) out.push(resource(r.value, r.max, { key: r.key, label: r.label, color: "alt" }));
  return out;
};

const BUILTIN = {
  pf2e: { bars: hpBar, hpPath: "system.attributes.hp" },
  dnd5e: { bars: hpBar, hpPath: "system.attributes.hp" },
  dragonbane: { bars: adapterBars(ADAPTERS.dragonbane), hpPath: ADAPTERS.dragonbane.hpPath },
  daggerheart: { bars: adapterBars(ADAPTERS.daggerheart), hpPath: ADAPTERS.daggerheart.hpPath },
  "age-system": { bars: adapterBars(ADAPTERS["age-system"]), hpPath: ADAPTERS["age-system"].hpPath },
  CoC7: {
    hpPath: "system.attribs.hp",
    bars: actor => {
      const a = actor.system?.attribs ?? {};
      const out = [];
      if (a.hp) out.push(resource(a.hp.value, a.hp.max, { key: "hp", label: t("Systems.Hp"), color: "hp" }));
      if (a.san) out.push(resource(a.san.value, a.san.max || 99, { key: "san", label: t("Systems.San"), color: "sanity" }));
      return out;
    }
  },
  "insane-kr": {
    hpPath: "system.health",
    bars: actor => {
      const s = actor.system ?? {};
      return [
        resource(s.health?.value, s.health?.max, { key: "health", label: t("Systems.Health"), color: "hp" }),
        resource(s.sanity?.value, s.sanity?.max, { key: "sanity", label: t("Systems.Sanity"), color: "sanity" })
      ];
    }
  }
};

const registry = new Map();
const refreshListeners = new Set();

export function registerSystem(systemId, adapter = {}) {
  registry.set(systemId, { ...(registry.get(systemId) ?? {}), ...adapter });
  for (const hook of adapter.refreshHooks ?? []) Hooks.on(hook, actor => refreshListeners.forEach(fn => fn(actor)));
  refreshListeners.forEach(fn => fn(null));
}

/** Called when a system announces a change the portraits should show. */
export function onAdapterRefresh(fn) {
  refreshListeners.add(fn);
}

function adapter() {
  const id = game.system?.id;
  return { ...(BUILTIN[id] ?? {}), ...(registry.get(id) ?? {}) };
}

/** Bars for an actor: the adapter's, else the prototype token's bar1/bar2. */
export function barsFor(actor) {
  if (!actor) return [];
  try {
    const custom = adapter().bars?.(actor);
    if (Array.isArray(custom) && custom.length) return custom.filter(b => b && Number.isFinite(b.max));
  } catch (err) {
    console.warn("Rutz UI | bar adapter failed", err);
  }
  const token = actor.prototypeToken ?? {};
  return [barFromAttribute(actor, token.bar1?.attribute, ""), barFromAttribute(actor, token.bar2?.attribute, "")]
    .filter(Boolean).map((b, i) => ({ ...b, color: i === 0 ? "hp" : "alt" }));
}

export function badgesFor(actor) {
  try {
    return adapter().badges?.(actor) ?? [];
  } catch (_) {
    return [];
  }
}

/** Optional adapter callback (onPortraitDrop, acceptsDrop), or null. */
export function adapterCallback(name) {
  const fn = adapter()[name];
  return typeof fn === "function" ? fn : null;
}

/** First bar as 0–100, or null. */
export function healthPercent(actor) {
  const bar = barsFor(actor)[0];
  if (!bar || !bar.max) return null;
  return Math.max(0, bar.value) / bar.max * 100;
}

/** Does this actor/token update touch what the first bar shows? */
export function healthChanged(changes) {
  if (!changes) return false;
  const path = adapter().hpPath;
  if (path) return foundry.utils.hasProperty(changes, path);
  return foundry.utils.hasProperty(changes, "system");
}

/* The HUD outside PF2e (sys-hud.mjs reads everything through these). */

/** This world's HUD adapter: a known system's, else the plain one. */
export function hudAdapter(systemId = game.system?.id) {
  return ADAPTERS[systemId] ?? generic;
}

/** HP for the turn tracker and the token health label. PF2e: the system's own hp object; elsewhere { value (left), max } from the adapter, or null. */
export function healthOf(actor) {
  if (game.system?.id === "pf2e") return actor?.system?.attributes?.hp;
  return safe(() => hudAdapter().health?.(actor), null);
}

/** Player character? PF2e: type "character"; AGE: "char". */
export function isPcType(actor) {
  if (game.system?.id === "pf2e") return actor?.type === "character";
  return (hudAdapter().pcTypes ?? ["character"]).includes(actor?.type);
}

/** Active effects worth a HUD icon: temporary ones and status conditions, as the systems' sheets show them. allApplicableEffects / isTemporary / isSuppressed are core; dnd5e calls them on super. */
export function activeEffectsOf(actor, skip = null) {
  const all = safe(() => [...(actor?.allApplicableEffects?.() ?? actor?.effects ?? [])], []);
  return all.filter(e => e && !e.disabled && !e.isSuppressed && (e.isTemporary || (e.statuses?.size ?? 0) > 0) && !safe(() => skip?.(e), false))
    .map(e => ({ id: e.id, name: e.name, img: e.img ?? e.icon ?? "icons/svg/aura.svg", desc: e.description ?? "", off: () => e.delete() }));
}

/** Everything the HUD bar shows; every part falls back to empty on its own. */
export function hudView(actor) {
  const a = hudAdapter();
  const health = safe(() => a.health?.(actor), null);
  const resources = safe(() => a.resources?.(actor), []) ?? [];
  const defences = safe(() => a.defences?.(actor), []) ?? [];
  const conditions = [...(safe(() => a.conditions?.(actor), []) ?? []), ...activeEffectsOf(actor, a.skipEffect)];
  return { health, resources, defences, conditions };
}

export function hudChecks(actor) {
  return safe(() => hudAdapter().checks?.(actor), []) ?? [];
}

/** Lists with something in them. */
export function hudLists(actor) {
  return (safe(() => hudAdapter().lists?.(actor), []) ?? []).filter(l => l?.items?.length);
}

async function guarded(fn) {
  try {
    return await fn();
  } catch (err) {
    console.warn("Rutz UI | system call failed", err);
    ui.notifications?.warn?.(t("SysHud.Failed"));
    return null;
  }
}

export function rollCheck(actor, key, event = null) {
  const a = hudAdapter();
  if (typeof a.roll !== "function") return null;
  return guarded(() => a.roll(actor, key, event));
}

/** Use an item the system's way; a system without an adapter opens the sheet. */
export function useItem(actor, item, event = null) {
  const a = hudAdapter();
  if (typeof a.use !== "function") return item?.sheet?.render(true) ?? null;
  return guarded(() => a.use(actor, item, event));
}

export function canDamage() {
  return featureOn("quickDamage") && typeof hudAdapter().damage === "function";
}

/** amount > 0: damage, < 0: healing, through the system's own method. */
export function applyHp(actor, amount) {
  const a = hudAdapter();
  if (!canDamage() || !actor || !Number.isFinite(Number(amount)) || !Number(amount)) return null;
  return guarded(() => a.damage(actor, Number(amount)));
}
