/*
 * System adapters for the parts that work in any game system (portraits, token HP images).
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

const num = v => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

const resource = (value, max, extra = {}) => ({ value: num(value), max: Math.max(0, num(max)), ...extra });

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

const BUILTIN = {
  pf2e: { bars: hpBar, hpPath: "system.attributes.hp" },
  dnd5e: { bars: hpBar, hpPath: "system.attributes.hp" },
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
