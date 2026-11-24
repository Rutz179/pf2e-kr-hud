/* ======================================================================== *
 * 지식 답하기 — the lines a Recall Knowledge answer gives (pure: no Foundry
 * globals; tested in node)
 *
 *  - Facts come from the creature's own data (creatureOf); the words from
 *    labels the caller passes in (PF2e's own localized type names), so a
 *    true and a false line read exactly alike.
 *  - PF2e outcomes: 대성공 more true facts · 성공 one true fact · 실패
 *    nothing · 실패 with Dubious Knowledge one true + one false of the same
 *    shape, in random order · 대실패 one false fact.
 *  - A false fact is never one the creature has, never repeats a line of the
 *    same answer and never contradicts one: lines share keys ("iwr:fire",
 *    "save:will", "ability:grab") and a false one takes no key in use.
 *  - close (가깝게): the false fact is the true one's neighbour (physical for
 *    physical, a reaction for a reaction, the save next to the right one);
 *    otherwise (보통) anything that fits the creature's traits.
 * ======================================================================== */

export const TOPICS = ["weak", "resist", "immune", "saveLow", "saveHigh", "ability", "strike", "move"];
export const MODES = ["criticalSuccess", "success", "failure", "dubious", "criticalFailure"];
export const OUTCOMES = ["criticalSuccess", "success", "failure", "criticalFailure"];
const SAVES = ["fortitude", "reflex", "will"];
const HANGUL = /[가-힣]/;
const EN_SUFFIX = /\(([^()]*[A-Za-z][^()]*)\)\s*$/;
const DUBIOUS_ID = "1Bt7uCW2WI4sM84P";

/* small helpers */

const uniq = list => [...new Set(list)];
const pickOne = (list, rng) => (list.length ? list[Math.min(list.length - 1, Math.floor(rng() * list.length))] : null);
const signed = n => (n >= 0 ? `+${n}` : String(n));
const norm = text => String(text ?? "").toLowerCase().replace(/[^a-z0-9가-힣]/g, "");

export function slugify(text) {
  return String(text ?? "").toLowerCase().replace(/['’]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

/** "붙잡기(Grab)" → "Grab"; a name with no English part stays as it is. */
export function englishPart(name) {
  return EN_SUFFIX.exec(String(name ?? ""))?.[1]?.trim() ?? String(name ?? "").trim();
}

// Renamed in the remaster: the same ability under either name.
const ALIASES = { "attack-of-opportunity": "reactive-strike", "negative-healing": "void-healing" };
const canonical = slug => ALIASES[slug] ?? slug;

export function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

/* types, families, pools */

const PHYSICAL = ["bludgeoning", "piercing", "slashing"];
const ENERGY = ["acid", "cold", "electricity", "fire", "sonic", "force", "vitality", "void"];
const IWR_FAMILIES = [
  PHYSICAL,
  ENERGY,
  ["holy", "unholy"],
  ["cold-iron", "silver", "adamantine", "orichalcum"],
  ["air", "earth", "metal", "water", "wood"],
  ["mental", "poison", "spirit", "bleed", "precision"],
  ["physical", "energy", "magical", "non-magical", "spells", "area-damage", "splash-damage", "critical-hits", "all-damage"]
];
const IMMUNE_FAMILIES = [
  ["blinded", "confused", "controlled", "dazzled", "deafened", "doomed", "drained", "fascinated", "fatigued", "fleeing",
    "frightened", "grabbed", "immobilized", "paralyzed", "petrified", "prone", "restrained", "sickened", "slowed",
    "stunned", "unconscious", "off-guard", "clumsy", "enfeebled", "stupefied"],
  ["death-effects", "disease", "poison", "mental", "fear-effects", "emotion", "curse", "polymorph", "possession",
    "sleep", "illusion", "visual", "auditory", "olfactory", "inhaled", "scrying", "detection"],
  [...ENERGY, "energy", "spirit"],
  [...PHYSICAL, "physical", "bleed", "precision", "critical-hits", "nonlethal-attacks"]
];
// Having the key means having these too: claiming one of them would be true.
const IWR_COVERS = {
  physical: PHYSICAL, energy: ENERGY, "all-damage": [...PHYSICAL, ...ENERGY, "physical", "energy"],
  mental: ["emotion", "fear-effects"], unconscious: ["sleep"]
};

// Traits that share a pool.
const GROUP_OF = {
  demon: "fiend", devil: "fiend", daemon: "fiend", div: "fiend", qlippoth: "fiend", sahkil: "fiend", velstrac: "fiend",
  asura: "fiend", rakshasa: "fiend", angel: "celestial", archon: "celestial", azata: "celestial", agathion: "celestial",
  animal: "beast", fungus: "plant", amphibious: "aquatic"
};
function groupsOf(traits) {
  const g = new Set(traits);
  for (const tr of traits) if (GROUP_OF[tr]) g.add(GROUP_OF[tr]);
  return g;
}

const POOLS = {
  weak: {
    undead: ["vitality", "holy", "fire", "slashing", "bludgeoning", "silver"],
    fiend: ["holy", "cold-iron", "silver"],
    celestial: ["unholy"],
    fey: ["cold-iron"],
    construct: ["bludgeoning", "electricity", "acid", "adamantine"],
    plant: ["fire", "slashing"],
    ooze: ["cold", "electricity"],
    fire: ["cold", "water"],
    water: ["electricity"],
    cold: ["fire"],
    wood: ["fire", "metal"],
    beast: ["fire", "cold"],
    aquatic: ["electricity"],
    werecreature: ["silver"],
    incorporeal: ["force", "ghost-touch"],
    swarm: ["area-damage", "splash-damage"],
    troop: ["area-damage", "splash-damage"]
  },
  resist: {
    undead: ["cold", "piercing", "poison", "bludgeoning"],
    fiend: ["fire", "cold", "poison", "physical"],
    celestial: ["electricity", "fire", "cold"],
    fey: ["mental", "poison"],
    construct: ["physical", "fire", "cold", "slashing", "piercing"],
    plant: ["bludgeoning", "piercing", "electricity"],
    ooze: ["acid", "piercing", "slashing"],
    fire: ["fire"],
    cold: ["cold"],
    water: ["fire", "acid"],
    earth: ["physical", "piercing", "slashing"],
    metal: ["slashing", "electricity"],
    wood: ["piercing", "water"],
    air: ["electricity", "sonic"],
    beast: ["cold"],
    aquatic: ["cold"],
    swarm: PHYSICAL,
    incorporeal: ["all-damage"]
  },
  immune: {
    undead: ["death-effects", "disease", "poison", "paralyzed", "sleep", "unconscious", "bleed", "fatigued"],
    construct: ["bleed", "death-effects", "disease", "doomed", "drained", "fatigued", "nonlethal-attacks", "paralyzed",
      "poison", "sickened", "spirit", "unconscious", "mental"],
    ooze: ["critical-hits", "precision", "visual", "mental"],
    elemental: ["bleed", "paralyzed", "poison", "sleep"],
    plant: ["mental", "sleep", "visual"],
    fiend: ["fire", "poison", "fear-effects"],
    celestial: ["fear-effects", "disease"],
    swarm: ["grabbed", "prone", "restrained", "precision"],
    incorporeal: ["grabbed", "prone", "restrained", "disease", "poison", "precision", "bleed"],
    mindless: ["mental"],
    dragon: ["paralyzed", "sleep"],
    fire: ["fire"],
    cold: ["cold"]
  }
};
const GENERIC = {
  weak: [...PHYSICAL, "fire", "cold", "electricity", "acid", "sonic"],
  resist: [...PHYSICAL, "fire", "cold", "electricity", "acid", "sonic"],
  immune: ["poison", "disease", "sleep", "paralyzed", "mental", "fear-effects", "critical-hits", "precision", "bleed"]
};

/** A false IWR line players would believe for this creature (holy only hurts the unholy, and so on). */
function plausibleIwr(kind, type, g) {
  if (kind === "weak" && g.has(type)) return false;   // a fire creature isn't weak to fire
  switch (type) {
    case "vitality": return kind === "weak" && g.has("undead");
    case "void": return false;
    case "holy": return kind === "weak" ? g.has("unholy") || g.has("fiend") || g.has("undead") : g.has("holy") || g.has("celestial");
    case "unholy": return kind === "weak" ? g.has("holy") || g.has("celestial") : g.has("unholy") || g.has("fiend");
    case "ghost-touch": return g.has("incorporeal");
    case "force": return kind === "weak" && g.has("incorporeal");   // force IWR is rare enough to give a lie away
    case "all-damage": return kind !== "weak" && g.has("incorporeal");
    default: return true;
  }
}

/** Weakness/resistance value when there is no true one to copy (roughly the creature-building range). */
export function iwrScale(level) {
  return Math.max(3, Math.round((Number(level) || 0) * 0.8 + 3));
}

const SPEEDS = ["fly", "swim", "climb", "burrow"];
const VISION = ["darkvision", "greater-darkvision", "low-light-vision", "see-invisibility", "truesight", "infrared-vision"];
const MOVE_FAMILIES = {
  speed: SPEEDS,
  vision: ["darkvision", "low-light-vision", "greater-darkvision", "see-invisibility"],
  special: ["scent", "tremorsense", "wavesense", "lifesense", "thoughtsense", "motion-sense", "echolocation"]
};
const MOVE_COVERS = { "greater-darkvision": ["darkvision", "low-light-vision"], darkvision: ["low-light-vision"], truesight: ["see-invisibility"] };
const MOVE_POOL = {
  aquatic: ["swim", "wavesense"], dragon: ["fly", "darkvision", "scent"], fiend: ["fly", "darkvision"],
  celestial: ["fly", "darkvision"], undead: ["darkvision", "lifesense"], beast: ["scent", "low-light-vision", "climb", "swim"],
  ooze: ["motion-sense", "tremorsense", "climb"], plant: ["tremorsense", "lifesense"], construct: ["darkvision"],
  earth: ["burrow", "tremorsense"], air: ["fly"], water: ["swim"], fey: ["low-light-vision", "fly"],
  aberration: ["darkvision", "thoughtsense"], incorporeal: ["fly", "lifesense"]
};
const MOVE_GENERIC = ["darkvision", "low-light-vision", "scent", "climb", "swim", "fly", "tremorsense"];

// Natural attacks a creature might be "remembered" to have: slug → damage type, English name, names that mean it.
const NATURAL = {
  jaws: ["piercing", "Jaws", ["jaw", "bite", "fangs", "fang", "mandibles", "mandible", "beak"]],
  claw: ["slashing", "Claw", ["claws", "talon", "talons"]],
  tail: ["bludgeoning", "Tail", ["tails"]],
  horn: ["piercing", "Horn", ["horns", "gore", "antler", "antlers"]],
  tentacle: ["bludgeoning", "Tentacle", ["tentacles"]],
  talon: ["slashing", "Talon", ["talons", "claw", "claws"]],
  stinger: ["piercing", "Stinger", ["sting"]],
  wing: ["bludgeoning", "Wing", ["wings"]]
};
const NATURAL_GROUPS = ["beast", "dragon", "aberration", "animal"];
const STRIKE_ENERGY = ["acid", "cold", "electricity", "fire", "sonic"];
const STRIKE_ANY = [...PHYSICAL, "fire", "cold", "electricity", "acid", "poison"];

// Ability kinds, in the order they matter at the table.
const KIND_ORDER = ["reaction", "offensive", "defensive", "other"];
export function kindOf(actionType, category) {
  if (actionType === "reaction") return "reaction";
  return category === "offensive" || category === "defensive" ? category : "other";
}
// Glossary entries that only make sense for one sort of creature.
const ABILITY_DENY = new Set(["form-up", "troop-defenses", "troop-movement", "golem-antimagic", "swarm-mind", "at-will-spells", "constant-spells"]);
// When the glossary pack can't be read: PF2e's names, no gist (so the true line drops its gist too).
const FALLBACK_ABILITIES = [
  ["reactive-strike", "reaction", "Reactive Strike"], ["ferocity", "reaction", "Ferocity"], ["shield-block", "reaction", "Shield Block"],
  ["grab", "offensive", "Grab"], ["improved-grab", "offensive", "Improved Grab"], ["knockdown", "offensive", "Knockdown"],
  ["push", "offensive", "Push"], ["constrict", "offensive", "Constrict"], ["trample", "offensive", "Trample"],
  ["swallow-whole", "offensive", "Swallow Whole"], ["rend", "offensive", "Rend"],
  ["regeneration", "defensive", "Regeneration"], ["fast-healing", "defensive", "Fast Healing"]
].map(([key, kind, name]) => ({ key, kind, name, gist: "", local: null, localGist: null }));

/* descriptions → a short gist */

/** Inline references as plain words: @UUID[…]{Grabbed} → Grabbed, [[/act grapple]] → grapple, @Damage[2d6[fire]] → 2d6 fire. */
function plainText(src) {
  let out = "";
  let i = 0;
  while (i < src.length) {
    const ref = /^@(\w+)\[/.exec(src.slice(i, i + 40));
    const roll = src.startsWith("[[", i);
    if (!ref && !roll) { out += src[i++]; continue; }
    let j = i + (ref ? ref[0].length : 2);
    let depth = ref ? 1 : 2;
    while (j < src.length && depth > 0) {
      if (src[j] === "[") depth++;
      else if (src[j] === "]") depth--;
      j++;
    }
    if (depth > 0) { out += src[i++]; continue; }
    const body = ref ? src.slice(i + ref[0].length, j - 1) : src.slice(i + 2, j - 2);
    let label = null;
    if (src[j] === "{") {
      const close = src.indexOf("}", j);
      if (close > j) { label = src.slice(j + 1, close); j = close + 1; }
    }
    if (label === null) {
      if (!ref) label = body.replace(/^\/\w+\s*/, "").split(/[#|]/)[0].trim();
      else if (ref[1] === "UUID" || ref[1] === "Compendium") label = "";
      else label = body.split("|")[0].replace(/\[([^\]]*)\]/g, " $1").trim();
    }
    out += label;
    i = j;
  }
  return out;
}

const SKIP_LABEL = /^(frequency|requirements?|빈도|요구)/i;
const DROP_LABEL = /^(effect|효과)$/i;
const ENTITIES = { "&nbsp;": " ", "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'", "&#x27;": "'" };

/**
 * The first sentence of a description, short: tags gone, inline references as words, a "Trigger" label kept,
 * Frequency/Requirements paragraphs skipped. `localize` resolves PF2e's @Localize[…] (the glossary texts).
 */
export function gistOf(html, { localize = null, words = 12, chars = 90 } = {}) {
  let src = String(html ?? "");
  if (localize) src = src.replace(/@Localize\[([\w.-]+)\]/g, (_, key) => String(localize(key) ?? ""));
  src = plainText(src);
  const paras = src.split(/<\/p>|<hr\s*\/?>|<br\s*\/?>|\n/i).map(p => {
    let text = p.replace(/^(\s*<(p|div|span)\b[^>]*>)+\s*/i, "");
    const head = /^<(strong|b)>\s*([^<]{1,30}?)\s*<\/\1>\s*/i.exec(text);
    if (head) {
      if (SKIP_LABEL.test(head[2])) return "";
      text = (DROP_LABEL.test(head[2]) ? "" : `${head[2].replace(/:$/, "")}: `) + text.slice(head[0].length);
    }
    return text.replace(/<[^>]*>/g, " ").replace(/&[#\w]+;/g, e => ENTITIES[e] ?? " ").replace(/\s+/g, " ").trim();
  }).filter(p => p && !/^[:.]+$/.test(p));
  const first = paras[0] ?? "";
  let sentence = first.split(/(?<=[.!?。])\s/)[0] ?? "";
  let cut = false;
  const list = sentence.split(" ");
  if (list.length > words) { sentence = list.slice(0, words).join(" "); cut = true; }
  if (sentence.length > chars) { sentence = sentence.slice(0, chars).replace(/\s+\S*$/, ""); cut = true; }
  sentence = sentence.replace(/[\s.。:;,]+$/, "");
  return sentence && cut ? `${sentence}…` : sentence;
}

/* reading the creature */

function safe(fn, fallback = "") {
  try { const v = fn(); return typeof v === "string" ? v : fallback; } catch (_) { return fallback; }
}

/** Plain data from a PF2e actor (or a look-alike): everything the generator reads. */
export function creatureOf(actor, { localize = null, name = null } = {}) {
  if (!actor) return null;
  const sys = actor.system ?? {};
  const attrs = actor.attributes ?? sys.attributes ?? {};
  const items = type => actor.itemTypes?.[type] ?? [...(actor.items ?? [])].filter(i => i?.type === type);
  const num = v => (v === null || v === undefined || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));
  const iwr = list => [...(list ?? [])].filter(x => x?.type).map(x => ({
    type: x.type, value: num(x.value), label: safe(() => x.label), typeLabel: safe(() => x.typeLabel)
  }));
  const saves = {};
  for (const s of SAVES) saves[s] = num(actor.saves?.[s]?.mod ?? sys.saves?.[s]?.value);
  // PF2e 8.x: system.movement.speeds; older data: system.attributes.speed.otherSpeeds.
  const moves = sys.movement?.speeds;
  const speeds = moves && typeof moves === "object"
    ? Object.entries(moves).filter(([, v]) => v).map(([type, v]) => ({ type, value: num(v.value ?? v.total) ?? 0 }))
    : [...(attrs.speed?.otherSpeeds ?? [])].map(s => ({ type: s.type, value: num(s.value ?? s.total) ?? 0 }));
  const range = r => (num(r) > 0 ? num(r) : null);
  return {
    name: String(name ?? actor.name ?? ""),
    level: num(actor.level ?? sys.details?.level?.value) ?? 0,
    traits: [...(sys.traits?.value ?? [])],
    weaknesses: iwr(attrs.weaknesses), resistances: iwr(attrs.resistances), immunities: iwr(attrs.immunities),
    saves,
    land: num(moves?.land?.value ?? attrs.speed?.value) ?? 25,
    speeds,
    // A vague scent is everyone's (PF2e shows no label for it).
    senses: [...(sys.perception?.senses ?? [])].filter(s => s?.type && !(s.type === "scent" && s.acuity === "vague"))
      .map(s => ({ type: s.type, acuity: s.acuity ?? null, range: range(s.range) })),
    abilities: items("action").map(i => ({
      key: canonical(i.system?.slug || slugify(englishPart(i.name)) || norm(i.name)),
      name: String(i.name ?? ""),
      kind: kindOf(i.system?.actionType?.value, i.system?.category),
      gist: gistOf(i.system?.description?.value, { localize })
    })),
    strikes: items("melee").map(i => {
      const rolls = Object.values(i.system?.damageRolls ?? {});
      const main = rolls.filter(r => !r?.category);
      return {
        key: i.system?.slug || slugify(englishPart(i.name)) || norm(i.name),
        name: String(i.name ?? ""),
        types: uniq((main.length ? main : rolls).map(r => r?.damageType).filter(Boolean)),
        traits: [...(i.system?.traits?.value ?? [])]
      };
    })
  };
}

/** One bestiary-glossary index entry (+ its translated mirror entry) as an ability the false lines can name. */
export function glossaryEntry(entry, mirror = null, { localize = null } = {}) {
  const sys = entry?.system ?? {};
  const name = String(entry?.name ?? "");
  const english = entry?.originalName ?? englishPart(name);   // Babele keeps the English name here
  return {
    key: canonical(sys.slug || slugify(english) || norm(name)),
    kind: kindOf(sys.actionType?.value, sys.category),
    name,
    gist: gistOf(sys.description?.value, { localize }),
    local: mirror?.name ? String(mirror.name) : null,
    localGist: mirror ? gistOf(mirror.system?.description?.value, { localize }) || null : null
  };
}

/** The asker has the Dubious Knowledge feat (by slug, compendium source or its roll note). */
export function hasDubiousKnowledge(actor) {
  const items = actor?.itemTypes?.feat ?? [...(actor?.items ?? [])].filter(i => i?.type === "feat");
  return items.some(i => {
    const slug = i?.system?.slug || slugify(englishPart(i?.name));
    const source = String(i?._stats?.compendiumSource ?? i?.flags?.core?.sourceId ?? i?.sourceId ?? "");
    return slug === "dubious-knowledge" || source.endsWith(DUBIOUS_ID)
      || (i?.system?.rules ?? []).some(r => r?.text === "PF2E.SpecificRule.DubiousKnowledge.Note");
  });
}

/** A PF2e Recall Knowledge check message: { outcome, target: { token, actor } uuids, actorId }, else null. */
export function recallCheckOf(message) {
  const ctx = message?.flags?.pf2e?.context;
  if (!ctx || !["skill-check", "check"].includes(ctx.type)) return null;
  const options = ctx.options ?? [];
  const isRecall = ctx.action === "recall-knowledge"
    || options.some(o => o === "action:recall-knowledge" || (typeof o === "string" && o.startsWith("action:recall-knowledge:")));
  if (!isRecall) return null;
  const target = ctx.target ? { token: ctx.target.token ?? null, actor: ctx.target.actor ?? null } : null;
  return { outcome: OUTCOMES.includes(ctx.outcome) ? ctx.outcome : null, target, actorId: ctx.actor ?? null };
}

/** The window's mode for a PF2e outcome: a plain failure with Dubious Knowledge is its own mode. */
export function modeFor(outcome, dubious = false) {
  if (outcome === "failure" && dubious) return "dubious";
  return OUTCOMES.includes(outcome) ? outcome : "success";
}

/* the generator */

function context({ creature, mode = "success", close = true, glossary = null, L, rng = Math.random } = {}) {
  const c = creature ?? { name: "", level: 0, traits: [], weaknesses: [], resistances: [], immunities: [], saves: {}, speeds: [], senses: [], abilities: [], strikes: [] };
  return {
    c, mode, close: !!close, glossary, L, rng, g: groupsOf(c.traits ?? []),
    full: mode === "criticalSuccess",
    // With a false line beside it, a true one shows no more than its false twin can (no "except silver").
    short: mode === "dubious" || mode === "criticalFailure"
  };
}

const line = (topic, truth, keys, text, extra = {}) => ({ topic, truth, keys, text, ...extra });
const preferTraits = (rng, fit, any) => (fit.length && any.length ? (rng() < 0.7 ? fit : any) : fit.length ? fit : any);
const traitPool = (pools, g) => uniq([...g].flatMap(tr => pools[tr] ?? []));

/* weaknesses · resistances · immunities */

const HEAD = { weak: "Weak", resist: "Resist", immune: "Immune" };

function iwrOf(c, kind) {
  const list = kind === "weak" ? c.weaknesses : kind === "resist" ? c.resistances : c.immunities;
  const out = [...(list ?? [])];
  return kind === "immune" ? out : out.sort((a, b) => (b.value ?? 0) - (a.value ?? 0));
}

function iwrText(kind, ctx, items) {
  const one = x => {
    if (!ctx.short && x.label) return x.label;   // PF2e's own: value and exceptions
    const name = x.typeLabel || ctx.L.iwr(kind, x.type) || x.type;
    return kind === "immune" || x.value === null || x.value === undefined ? name : `${name} ${x.value}`;
  };
  return ctx.L.text(`Line.${HEAD[kind]}`, { list: items.map(one).join(", ") });
}

function iwrTrue(kind, ctx, pick = 0) {
  const list = iwrOf(ctx.c, kind);
  if (!list.length) return line(kind, true, [`${kind}:none`], ctx.L.text(`Line.${HEAD[kind]}None`), { none: true });
  const i = pick % list.length;
  const x = list[i];
  return line(kind, true, [`iwr:${x.type}`], iwrText(kind, ctx, [x]), { fact: { type: x.type, value: x.value }, pick: i, alts: list.length });
}

function iwrAll(kind, ctx) {
  const list = iwrOf(ctx.c, kind);
  if (!list.length) return [iwrTrue(kind, ctx)];
  return [line(kind, true, list.map(x => `iwr:${x.type}`), iwrText(kind, ctx, list))];
}

function ownedIwr(c) {
  const own = new Set([...c.weaknesses, ...c.resistances, ...c.immunities].map(x => x.type));
  for (const type of [...own]) for (const sub of IWR_COVERS[type] ?? []) own.add(sub);
  if (PHYSICAL.some(x => own.has(x))) own.add("physical");
  if (ENERGY.some(x => own.has(x))) own.add("energy");
  return own;
}

function iwrFalse(kind, ctx, basis, avoid) {
  const { c, g, rng, L } = ctx;
  const own = ownedIwr(c);
  const ok = type => !own.has(type) && !avoid.all.has(`iwr:${type}`) && plausibleIwr(kind, type, g) && !!L.iwr(kind, type);
  const base = basis?.fact?.type;
  const families = kind === "immune" ? IMMUNE_FAMILIES : IWR_FAMILIES;
  const fit = traitPool(POOLS[kind], g).filter(ok);
  let pool = ctx.close && base ? (families.find(f => f.includes(base)) ?? []).filter(ok) : [];
  // close with no neighbour left (holy for a devil): what fits its traits (cold iron, silver) comes next.
  if (!pool.length && ctx.close && base) pool = fit;
  if (!pool.length) pool = preferTraits(rng, fit, GENERIC[kind].filter(ok));
  const type = pickOne(pool, rng);
  if (!type) return null;
  const value = kind === "immune" ? null : basis?.fact?.value ?? iwrScale(c.level);
  return line(kind, false, [`iwr:${type}`], iwrText(kind, { ...ctx, short: true }, [{ type, value }]), { fact: { type, value }, basis });
}

/* saves */

function savesOf(c) {
  return SAVES.filter(s => Number.isFinite(c.saves?.[s])).map(s => ({ slug: s, mod: c.saves[s] }));
}
const extreme = (topic, list) => (topic === "saveLow" ? Math.min : Math.max)(...list.map(x => x.mod));
const SAVE_HEAD = { saveLow: "Line.SaveLow", saveHigh: "Line.SaveHigh" };

function saveTrue(topic, ctx, pick = 0) {
  const { L } = ctx;
  const list = savesOf(ctx.c);
  if (list.length < 2) return line(topic, true, ["save:none"], L.text("Line.SaveNone"), { none: true });
  const target = extreme(topic, list);
  const best = list.filter(x => x.mod === target);
  if (best.length === list.length) return line(topic, true, ["save:even"], L.text("Line.SaveEven"), { none: true });
  const i = pick % best.length;
  const x = best[i];
  const name = L.save(x.slug);
  return line(topic, true, [`save:${x.slug}`], L.text(SAVE_HEAD[topic], { save: ctx.full ? `${name} (${signed(x.mod)})` : name }),
    { fact: { slug: x.slug }, pick: i, alts: best.length });
}

/** close: the save next to the right one; otherwise the other extreme. All alike: any of them (none is the lowest). */
function saveFalse(topic, ctx, basis, avoid) {
  const list = savesOf(ctx.c);
  if (list.length < 2) return null;
  const target = extreme(topic, list);
  const even = list.every(x => x.mod === target);
  const wrongBy = keys => list.filter(x => (even || x.mod !== target) && !keys.has(`save:${x.slug}`));
  // Another false line may name the same save (lowest and highest both asked); a true one may not.
  let wrong = wrongBy(avoid.all);
  if (!wrong.length) wrong = wrongBy(avoid.truth);
  if (!wrong.length) return null;
  const dist = x => Math.abs(x.mod - target);
  const want = (ctx.close ? Math.min : Math.max)(...wrong.map(dist));
  const x = pickOne(wrong.filter(w => dist(w) === want), ctx.rng);
  return line(topic, false, [`save:${x.slug}`], ctx.L.text(SAVE_HEAD[topic], { save: ctx.L.save(x.slug) }), { fact: { slug: x.slug }, basis });
}

/* abilities */

/** Reactions, then offensive, then defensive; the rest (passive, interaction) last. */
function abilitiesOf(c) {
  return (c.abilities ?? []).filter(a => a?.name).sort((a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind));
}

function abilityText(fact, ctx, withGist = true) {
  return withGist && fact.gist
    ? ctx.L.text("Line.Ability", { name: fact.name, gist: fact.gist })
    : ctx.L.text("Line.AbilityBare", { name: fact.name });
}

function abilityTrue(ctx, pick = 0) {
  const list = abilitiesOf(ctx.c);
  if (!list.length) return line("ability", true, ["ability:none"], ctx.L.text("Line.AbilityNone"), { none: true });
  const i = pick % list.length;
  const a = list[i];
  const fact = { key: a.key, kind: a.kind, name: a.name, gist: a.gist };
  return line("ability", true, [`ability:${a.key}`], abilityText(fact, ctx), { fact, pick: i, alts: list.length });
}

function abilityAll(ctx) {
  const n = Math.min(2, abilitiesOf(ctx.c).length);
  return n ? Array.from({ length: n }, (_, i) => abilityTrue(ctx, i)) : [abilityTrue(ctx)];
}

function ownedAbilityKeys(c) {
  const keys = new Set();
  for (const a of c.abilities ?? []) {
    keys.add(a.key);
    keys.add(canonical(slugify(englishPart(a.name))));
    for (const n of [a.name, englishPart(a.name)]) if (norm(n)) keys.add(`n:${norm(n)}`);
  }
  return keys;
}

/** Names in the creature's own style: translated ("붙잡기(Grab)") when its abilities are, else PF2e's English. */
function useLocal(c) {
  const list = c.abilities ?? [];
  return !list.length || list.some(a => HANGUL.test(a.name));
}

function abilityFalse(ctx, basis, avoid) {
  const { c, rng } = ctx;
  const owned = ownedAbilityKeys(c);
  const has = e => owned.has(e.key) || [e.name, e.local, englishPart(e.name), englishPart(e.local)].some(n => norm(n) && owned.has(`n:${norm(n)}`));
  const source = ctx.glossary?.length ? ctx.glossary : FALLBACK_ABILITIES;
  const entries = source.filter(e => e?.key && e.kind !== "other" && !ABILITY_DENY.has(e.key) && !has(e) && !avoid.all.has(`ability:${e.key}`));
  const kind = basis?.fact?.kind;
  let pool = ctx.close && kind ? entries.filter(e => e.kind === kind) : [];
  if (!pool.length) pool = entries;
  const e = pickOne(pool, rng);
  if (!e) return null;
  const local = useLocal(c);
  const fact = { key: e.key, kind: e.kind, name: (local && e.local) || e.name, gist: (local && e.localGist) || e.gist };
  return line("ability", false, [`ability:${e.key}`], abilityText(fact, ctx), { fact, basis });
}

/** Same shape: if one of the pair has no gist, neither shows one (a lone gist gives the true one away). */
function abilityShape(pair, ctx) {
  const facts = pair.filter(l => l.fact);
  if (facts.length < 2) return;
  const both = facts.every(l => l.fact.gist);
  for (const l of facts) if (!l.edited) l.text = abilityText(l.fact, ctx, both);
}

/* strikes */

function strikesOf(c) {
  return (c.strikes ?? []).filter(s => s?.name && s.types?.length);
}
const strikeItem = (s, L) => `${s.name} (${s.types.map(type => L.damage(type)).join(", ")})`;

function strikeTrue(ctx, pick = 0) {
  const list = strikesOf(ctx.c);
  if (!list.length) return line("strike", true, ["strike:none"], ctx.L.text("Line.StrikeNone"), { none: true });
  const i = pick % list.length;
  const s = list[i];
  return line("strike", true, [`strike:${s.key}`], ctx.L.text("Line.Strike", { list: strikeItem(s, ctx.L) }), { fact: s, pick: i, alts: list.length });
}

function strikeAll(ctx) {
  const list = strikesOf(ctx.c).slice(0, 4);
  if (!list.length) return [strikeTrue(ctx)];
  return [line("strike", true, list.map(s => `strike:${s.key}`), ctx.L.text("Line.Strike", { list: list.map(s => strikeItem(s, ctx.L)).join(" · ") }))];
}

const singular = slug => String(slug ?? "").replace(/s$/, "");
function strikeKeys(list) {
  const keys = new Set();
  for (const s of list) for (const k of [s.key, slugify(englishPart(s.name))]) if (k) { keys.add(k); keys.add(singular(k)); }
  return keys;
}
const isNatural = keys => Object.entries(NATURAL).some(([slug, [, , alias]]) => keys.has(slug) || alias.some(a => keys.has(a)));

/** The natural attack's name in the style of the creature's own strikes. */
function naturalName(slug, mine, L) {
  const en = NATURAL[slug][1];
  if (mine.some(s => HANGUL.test(s.name) && EN_SUFFIX.test(s.name))) return `${L.natural(slug)}(${en})`;
  if (mine.length && !mine.some(s => HANGUL.test(s.name))) return en;
  return L.natural(slug);
}

function damageFamily(type) {
  if (PHYSICAL.includes(type)) return PHYSICAL;
  if (STRIKE_ENERGY.includes(type)) return STRIKE_ENERGY;
  return ["poison", "mental", "spirit"];
}

/** close: the same strike, another type of the same family. Otherwise also a natural attack it lacks. */
function strikeFalse(ctx, basis, avoid) {
  const { c, g, L, rng } = ctx;
  const mine = strikesOf(c);
  const options = [];
  const s = basis?.fact;
  if (s?.types?.length) {
    const first = s.types[0];
    const types = ctx.close ? damageFamily(first) : uniq([...damageFamily(first), ...STRIKE_ANY]);
    for (const type of types) {
      if (s.types.includes(type) || mine.some(m => m.key === s.key && m.types[0] === type)) continue;
      options.push({ key: `strike:${s.key}:${type}`, fact: { ...s, types: [type, ...s.types.slice(1)] } });
    }
  }
  const owned = strikeKeys(mine);
  if ((!ctx.close || !options.length) && (isNatural(owned) || NATURAL_GROUPS.some(x => g.has(x)))) {
    for (const [slug, [type, , alias]] of Object.entries(NATURAL)) {
      if (owned.has(slug) || alias.some(a => owned.has(a))) continue;
      options.push({ key: `strike:${slug}`, fact: { key: slug, name: naturalName(slug, mine, L), types: [type], traits: ["unarmed"] } });
    }
  }
  const o = pickOne(options.filter(x => !avoid.all.has(x.key)), rng);
  if (!o) return null;
  return line("strike", false, [o.key], L.text("Line.Strike", { list: strikeItem(o.fact, L) }), { fact: o.fact, basis });
}

/* speeds · senses */

function movesOf(c) {
  const speeds = (c.speeds ?? []).filter(s => s.type !== "land" && s.value > 0).map(s => ({ kind: "speed", type: s.type, value: s.value }));
  const senses = (c.senses ?? []).map(s => ({ kind: VISION.includes(s.type) ? "vision" : "special", type: s.type, acuity: s.acuity, range: s.range }));
  return [...speeds, ...senses.filter(s => s.kind === "special"), ...senses.filter(s => s.kind === "vision")];
}
const moveKey = type => (SPEEDS.includes(type) ? `move:${type}` : `sense:${type}`);
const moveItem = (f, L) => (f.kind === "speed" ? L.text("SpeedItem", { type: L.speed(f.type), value: f.value }) : L.sense(f));
const moveText = (f, L) => L.text(f.kind === "speed" ? "Line.Move" : "Line.Sense", { list: moveItem(f, L) });

function moveTrue(ctx, pick = 0) {
  const list = movesOf(ctx.c);
  if (!list.length) return line("move", true, ["move:none"], ctx.L.text("Line.MoveNone"), { none: true });
  const i = pick % list.length;
  const f = list[i];
  return line("move", true, [moveKey(f.type)], moveText(f, ctx.L), { fact: f, pick: i, alts: list.length });
}

function moveAll(ctx) {
  const list = movesOf(ctx.c);
  if (!list.length) return [moveTrue(ctx)];
  const speeds = list.filter(f => f.kind === "speed");
  const senses = list.filter(f => f.kind !== "speed");
  const out = [];
  if (speeds.length) out.push(line("move", true, speeds.map(f => moveKey(f.type)), ctx.L.text("Line.Move", { list: speeds.map(f => moveItem(f, ctx.L)).join(", ") })));
  if (senses.length) out.push(line("move", true, senses.map(f => moveKey(f.type)), ctx.L.text("Line.Sense", { list: senses.map(f => moveItem(f, ctx.L)).join(", ") })));
  return out;
}

function ownedMoves(c) {
  const own = new Set(movesOf(c).map(f => f.type));
  for (const type of [...own]) for (const sub of MOVE_COVERS[type] ?? []) own.add(sub);
  return own;
}

/** A false speed copies the true one's value; a false special sense its acuity and range. */
function moveFact(type, basis, c) {
  if (SPEEDS.includes(type)) return { kind: "speed", type, value: basis?.kind === "speed" ? basis.value : c.land || 25 };
  const kind = VISION.includes(type) ? "vision" : "special";
  if (kind === "special" && basis?.kind === "special") return { kind, type, acuity: basis.acuity, range: basis.range };
  return kind === "vision" ? { kind, type, acuity: "precise", range: null } : { kind, type, acuity: "imprecise", range: 30 };
}

function moveFalse(ctx, basis, avoid) {
  const { c, g, rng } = ctx;
  const own = ownedMoves(c);
  const ok = type => !own.has(type) && !avoid.all.has(moveKey(type));
  const b = basis?.fact;
  let pool = ctx.close && b ? MOVE_FAMILIES[b.kind].filter(ok) : [];
  if (!pool.length) pool = preferTraits(rng, traitPool(MOVE_POOL, g).filter(ok), MOVE_GENERIC.filter(ok));
  const type = pickOne(pool, rng);
  if (!type) return null;
  const fact = moveFact(type, b, c);
  return line("move", false, [moveKey(type)], moveText(fact, ctx.L), { fact, basis });
}

/* the topics */

const T = {
  weak: { one: (ctx, p) => iwrTrue("weak", ctx, p), all: ctx => iwrAll("weak", ctx), fake: (ctx, b, a) => iwrFalse("weak", ctx, b, a) },
  resist: { one: (ctx, p) => iwrTrue("resist", ctx, p), all: ctx => iwrAll("resist", ctx), fake: (ctx, b, a) => iwrFalse("resist", ctx, b, a) },
  immune: { one: (ctx, p) => iwrTrue("immune", ctx, p), all: ctx => iwrAll("immune", ctx), fake: (ctx, b, a) => iwrFalse("immune", ctx, b, a) },
  saveLow: { one: (ctx, p) => saveTrue("saveLow", ctx, p), all: ctx => [saveTrue("saveLow", ctx)], fake: (ctx, b, a) => saveFalse("saveLow", ctx, b, a) },
  saveHigh: { one: (ctx, p) => saveTrue("saveHigh", ctx, p), all: ctx => [saveTrue("saveHigh", ctx)], fake: (ctx, b, a) => saveFalse("saveHigh", ctx, b, a) },
  ability: { one: abilityTrue, all: abilityAll, fake: abilityFalse, shape: abilityShape },
  strike: { one: strikeTrue, all: strikeAll, fake: strikeFalse },
  move: { one: moveTrue, all: moveAll, fake: moveFalse }
};

/** Keys in use: every line's, and the hidden true facts behind 대실패 lines. `truth`: those of true facts only. */
function avoidOf(lines) {
  const all = new Set();
  const truth = new Set();
  for (const l of lines) {
    for (const k of l.keys ?? []) { all.add(k); if (l.truth) truth.add(k); }
    for (const k of l.basis?.keys ?? []) { all.add(k); truth.add(k); }
  }
  return { all, truth };
}

const order = l => (l.topic ? TOPICS.indexOf(l.topic) : -1);
const sortLines = lines => lines.map((l, i) => [l, i]).sort((a, b) => order(a[0]) - order(b[0]) || a[1] - b[1]).map(([l]) => l);

/** The lines with one more topic answered (in TOPICS order). A false line the new true fact contradicts is drawn again. */
export function addTopic(lines, topic, opts = {}) {
  const ctx = context(opts);
  if (!T[topic] || ctx.mode === "failure") return lines;
  let out = (lines ?? []).filter(l => l.topic && l.topic !== topic);
  // Lowest and highest asked of even saves give the same line: once is enough.
  const trues = (ctx.full ? T[topic].all(ctx) : [T[topic].one(ctx, 0)]).filter(l => !out.some(o => o.truth && o.text === l.text));
  if (!trues.length) return sortLines(out);
  const fresh = new Set(trues.flatMap(l => l.keys));
  out = out.map(l => {
    if (l.truth !== false || !l.keys.some(k => fresh.has(k))) return l;
    return T[l.topic].fake(ctx, l.basis, avoidOf([...out.filter(o => o !== l), ...trues])) ?? l;
  });
  let mine = trues;
  if (ctx.mode === "dubious" || ctx.mode === "criticalFailure") {
    const t = trues[0];
    const f = T[topic].fake(ctx, t, avoidOf([...out, t]));
    if (ctx.mode === "criticalFailure") mine = f ? [f] : [];   // the true one stays hidden, as f.basis
    else {
      mine = f ? (ctx.rng() < 0.5 ? [t, f] : [f, t]) : [t];
      T[topic].shape?.(mine, ctx);
    }
  }
  return sortLines([...out, ...mine]);
}

/**
 * The whole answer: { creature, mode, topics, close, glossary, L, rng } → lines
 * ({ topic, truth, keys, text, … }; truth is for the GM's window only, never for the card).
 */
export function buildAnswer(opts = {}) {
  const ctx = context(opts);
  if (ctx.mode === "failure") return [line(null, null, [], ctx.L.text("Line.Nothing"))];
  return TOPICS.filter(tp => (opts.topics ?? []).includes(tp)).reduce((lines, tp) => addTopic(lines, tp, opts), []);
}

/** Reroll one line. A false line: another false fact. A true line: the creature's next fact of that kind, and its false twin is drawn again to match. Lines are not changed in place. */
export function redrawLine(lines, index, opts = {}) {
  const ctx = context(opts);
  const cur = lines?.[index];
  if (!cur?.topic || !T[cur.topic]) return lines;
  const out = lines.map(l => (l.topic === cur.topic ? { ...l } : l));
  if (cur.truth === false) {
    const avoid = avoidOf(lines.filter((_, i) => i !== index));
    for (const k of cur.keys) avoid.all.add(k);
    const f = T[cur.topic].fake(ctx, cur.basis, avoid);
    if (!f) return lines;
    out[index] = f;
  } else {
    if (!(cur.alts > 1)) return lines;
    const used = new Set(lines.filter((l, i) => i !== index && l.truth && l.topic === cur.topic).map(l => l.pick));
    let pick = cur.pick ?? 0;
    for (let n = 0; n < cur.alts; n++) {
      pick = (pick + 1) % cur.alts;
      if (!used.has(pick)) break;
    }
    if (pick === cur.pick || used.has(pick)) return lines;
    out[index] = T[cur.topic].one(ctx, pick);
    const j = out.findIndex(l => l.topic === cur.topic && l.truth === false);
    if (j >= 0) out[j] = T[cur.topic].fake(ctx, out[index], avoidOf(out.filter((_, i) => i !== j))) ?? { ...out[j], basis: out[index] };
  }
  if (ctx.mode === "dubious") T[cur.topic].shape?.(out.filter(l => l.topic === cur.topic), ctx);
  return out;
}

/** The chat card: "<캐릭터>의 기억" and the lines as the GM left them. Only the words: nothing says which is true. */
export function cardHtml({ who = null, lines = [], L }) {
  const items = (lines ?? []).map(l => String(l?.text ?? "").trim()).filter(Boolean);
  const title = who ? L.text("Card.Title", { name: who }) : L.text("Card.Anon");
  return `<div class="pkh-rk-card"><header><i class="fa-solid fa-brain"></i> <strong>${escapeHtml(title)}</strong></header>`
    + `<ul>${items.map(x => `<li>${escapeHtml(x)}</li>`).join("")}</ul></div>`;
}
