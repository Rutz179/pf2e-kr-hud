/*
 * The Rutz modules' settings hub: one button in the Rutz toolbar group that lists the settings windows of every Rutz
 * module that is on, so a GM need not go through Configure Settings. It shows exactly the buttons those modules put in
 * Foundry's settings list (game.settings.registerMenu) and opens the same windows.
 * The same file is in every Rutz module (byte-identical), so it has no lang file of its own.
 */
const TOOL = "rutzSettings";
const WINDOW = "rutz-settings-hub";
const UPDATES = "https://www.patreon.com/Rutz179";

const TEXT = {
  title: ["Rutz module settings", "Rutz 모듈 설정"],
  none: ["No settings to show.", "보여 줄 설정이 없습니다."],
  updates: ["Check for updates", "최신 업데이트 확인"]
};
const tx = key => TEXT[key][game.i18n?.lang === "ko" ? 1 : 0];
const esc = v => String(v ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const loc = v => (typeof v === "string" && v ? game.i18n.localize(v) : "");

/** Is this an active package of Rutz's? Told by its authors, so a new module needs no list here. */
function isRutz(id) {
  const mod = game.modules?.get?.(id);
  return !!mod?.active && [...(mod.authors ?? [])].some(a => /rutz/i.test(String(a?.name ?? "")));
}

/** What the hub lists: [{ id, title, menus: [{ key, name, hint, icon }] }], one entry per module, by title. */
export function hubEntries({ menus = game.settings?.menus, gm = !!game.user?.isGM } = {}) {
  const by = new Map();
  for (const [key, menu] of menus?.entries?.() ?? []) {
    const id = menu?.namespace ?? String(key).split(".")[0];
    if (!menu?.type || (menu.restricted && !gm) || !isRutz(id)) continue;
    if (!by.has(id)) by.set(id, { id, title: String(game.modules.get(id).title ?? id), menus: [] });
    by.get(id).menus.push({ key, name: loc(menu.name) || loc(menu.label), hint: loc(menu.hint), icon: menu.icon || "fa-solid fa-sliders" });
  }
  return [...by.values()].sort((a, b) => a.title.localeCompare(b.title));
}

/** The "check for updates" link, for the hub and for a module's own GM window or help. */
export function updatesLink() {
  return `<a class="rutz-updates" href="${UPDATES}" target="_blank" rel="noopener"><i class="fa-solid fa-arrow-up-right-from-square"></i> ${esc(tx("updates"))}</a>`;
}

/** The window's content. */
export function hubHtml(entries = hubEntries()) {
  const style = `<style>
.rutz-hub { display: flex; flex-direction: column; gap: 10px; padding: 10px 12px; max-height: 76vh; overflow-y: auto; }
.rutz-hub h4 { margin: 0 0 4px; padding: 0 0 3px; border: none; border-bottom: 1px solid rgba(214, 168, 66, 0.45); font-size: 0.9rem; }
.rutz-hub .btns { display: flex; flex-wrap: wrap; gap: 6px; }
.rutz-hub .btns button { flex: 0 1 auto; width: auto; min-height: 30px; padding: 2px 10px; white-space: nowrap; }
.rutz-hub footer { margin-top: 2px; padding-top: 6px; border-top: 1px solid rgba(128, 128, 128, 0.35); font-size: 0.8rem; text-align: right; }
</style>`;
  const body = entries.length
    ? entries.map(e => `<section data-module="${esc(e.id)}"><h4>${esc(e.title)}</h4><div class="btns">${e.menus.map(m =>
      `<button type="button" data-menu="${esc(m.key)}"${m.hint ? ` data-tooltip="${esc(m.hint)}"` : ""}><i class="${esc(m.icon)}"></i> ${esc(m.name)}</button>`).join("")}</div></section>`).join("")
    : `<p class="hint">${esc(tx("none"))}</p>`;
  return `${style}<div class="rutz-hub">${body}<footer>${updatesLink()}</footer></div>`;
}

/** Open the window behind a button of Foundry's settings list, as Foundry does. */
export function openMenu(key) {
  const menu = game.settings?.menus?.get?.(key);
  if (!menu?.type || (menu.restricted && !game.user?.isGM)) return null;
  try {
    const app = new menu.type();
    app.render(true);
    return app;
  } catch (err) {
    console.error(`Rutz settings hub | ${key}`, err);
    return null;
  }
}

/** Open the hub (the one already open comes to the front). */
export function openSettingsHub() {
  const AppV2 = foundry.applications.api.ApplicationV2;
  const open = foundry.applications.instances?.get?.(WINDOW);
  if (open) { open.render(true); open.bringToFront?.(); return open; }
  class RutzSettingsHub extends AppV2 {
    static DEFAULT_OPTIONS = { id: WINDOW, window: { title: tx("title"), icon: "fa-solid fa-gears", resizable: true }, position: { width: 460, height: "auto" } };
    async _renderHTML() { return hubHtml(); }
    _replaceHTML(result, content) { content.innerHTML = result; }
    _onFirstRender() {
      this.element.querySelector(".window-content").addEventListener("click", ev => {
        const button = ev.target.closest("button[data-menu]");
        if (button) openMenu(button.dataset.menu);
      });
    }
  }
  const app = new RutzSettingsHub();
  app.render(true);
  return app;
}

/** The toolbar button, or null when this user has nothing to open. */
export function settingsHubTool(order = 90) {
  if (!hubEntries().length) return null;
  const run = (game.release?.generation ?? 13) >= 13 ? { onChange: () => openSettingsHub() } : { onClick: () => openSettingsHub() };
  return { name: TOOL, title: tx("title"), icon: "fa-solid fa-gears", order, button: true, visible: true, ...run };
}
