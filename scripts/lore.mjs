import { esc, t } from "./shared.mjs";

/** Match PF2e LorePF2e.slug; prefer the document's slug whenever it exists. */
export function loreSlug(value) {
  const raw = game.pf2e?.system?.sluggify?.(String(value ?? ""))
    ?? String(value ?? "").normalize("NFC").trim().toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-|-$/g, "");
  return !raw ? "" : /\blore\b/.test(raw) ? raw : `${raw}-lore`;
}

export function actorLores(actor) {
  const result = new Map();
  const traces = actor?.system?.skills ?? {};
  for (const item of actor?.itemTypes?.lore ?? []) {
    const linked = Object.entries(traces).find(([, data]) => data.itemId === item.id)?.[0];
    const slug = linked ?? item.slug ?? loreSlug(item.system?.slug || item.name);
    const stat = actor.getStatistic?.(slug) ?? actor.skills?.[slug];
    result.set(slug, { slug, label: item.name, itemId: item.id, stat,
      mod: stat?.mod ?? stat?.check?.mod ?? null, rank: stat?.rank ?? item.system?.proficient?.value ?? 0 });
  }
  // Rule elements and NPCs may expose Lore without an embedded Lore item.
  for (const [slug, stat] of Object.entries(actor?.skills ?? {})) {
    if (result.has(slug) || !(stat.lore || traces[slug]?.lore)) continue;
    result.set(slug, { slug, label: stat.label ?? traces[slug]?.label ?? slug, stat,
      mod: stat.mod ?? stat.check?.mod ?? null, rank: stat.rank ?? 0 });
  }
  return [...result.values()].sort((a, b) => a.label.localeCompare(b.label, game.i18n.lang));
}

/** All player characters, including assigned characters and the active party. */
export function partyLores() {
  const actors = new Map();
  const add = actor => { if (actor?.type === "character") actors.set(actor.uuid ?? actor.id, actor); };
  for (const actor of game.actors ?? []) if (actor.hasPlayerOwner) add(actor);
  for (const user of game.users ?? []) if (!user.isGM) add(user.character);
  for (const actor of game.actors?.party?.members ?? []) add(actor);
  const lores = new Map();
  for (const actor of actors.values()) for (const lore of actorLores(actor)) {
    const option = lores.get(lore.slug) ?? { slug: lore.slug, label: lore.label, lore: true, actors: [] };
    option.actors.push(actor.name);
    lores.set(lore.slug, option);
  }
  return [...lores.values()].sort((a, b) => a.label.localeCompare(b.label, game.i18n.lang));
}

/** Escape both HTML and inline-reference delimiters in user-supplied labels. */
export function checkLabel(value) {
  return esc(value).replace(/[\[\]{}]/g, c => `&#${c.charCodeAt(0)};`);
}

export function loreCheckLink(slug, label, { dc = null, secret = false } = {}) {
  if (!slug || !/^[\p{L}\p{N}-]+$/u.test(slug)) throw new Error(t("Lore.BadName"));
  const params = [slug];
  if (Number.isFinite(dc) && dc > 0) params.push(`dc:${Math.trunc(dc)}`);
  if (secret) params.push("traits:secret");
  return `@Check[${params.join("|")}]{${checkLabel(label)}}`;
}

export async function rollLore(actor, slug, event) {
  if (!actor?.isOwner && !game.user.isGM) return;
  const lore = actorLores(actor).find(l => l.slug === slug);
  if (!lore?.stat?.roll) return ui.notifications.warn(`PF2e-KR HUD | ${t("Lore.NoCheck")}`);
  try { return await lore.stat.roll({ event }); }
  catch (error) { console.error(error); ui.notifications.error(`PF2e-KR HUD | ${t("Lore.RollFailed")}`); }
}
