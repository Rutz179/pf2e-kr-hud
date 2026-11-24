/*
 * Other Rutz modules, whichever edition is installed. A product is named by its short id; its packages are "<id>-plus"
 * (the paid module of a product whose free module keeps the short id), "<id>" itself, "<id>-lite" and "<id>-trial".
 * The same file ships in every Rutz module that talks to another one; it names no module itself.
 */
const PAID = "-plus";
const FREE = ["-lite", "-trial"];
const names = id => [id + PAID, id, ...FREE.map(s => id + s)];
const on = id => !!globalThis.game?.modules?.get?.(id)?.active;

/** The package id of the edition of `id` that is on in this world (the paid one first), or null. */
export const rutzId = id => names(id).find(on) ?? null;
export const rutzOn = id => rutzId(id) !== null;
/** That module's package entry (for .api), or null. */
export const rutzModule = id => { const i = rutzId(id); return i ? game.modules.get(i) : null; };

/** Another module's flags on a document: the edition that is on first, then whichever the document carries. */
export function rutzFlags(doc, id) {
  const f = doc?.flags;
  if (!f) return undefined;
  const i = rutzId(id);
  return (i ? f[i] : undefined) ?? names(id).map(n => f[n]).find(v => v !== undefined);
}
/** Flags written for another module under every name it may run as (the document outlives a change of edition). */
export const rutzBoth = (id, data) => ({
  [id]: data,
  [id + FREE[0]]: data,
  ...(globalThis.game?.modules?.get?.(id + PAID) ? { [id + PAID]: data } : {})
});

/** Another module's setting, or `fallback` (the module is off, or its edition has no such setting). */
export function rutzSetting(id, key, fallback) {
  const i = rutzId(id);
  if (!i) return fallback;
  try { return game.settings.get(i, key); } catch { return fallback; }
}
/** Is `settingKey` ("<package>.<key>", as an updateSetting hook gives it) that module's `key`, in any edition? */
export const rutzSettingKey = (settingKey, id, key) => names(id).some(i => settingKey === `${i}.${key}`);
