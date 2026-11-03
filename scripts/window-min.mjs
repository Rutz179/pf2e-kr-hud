import { MODULE_ID, setting, t } from "./shared.mjs";

/* ======================================================================== *
 * A minimize button on every window. Foundry's windows already fold up on a
 * double-click on the title bar; few people find that, so a button goes in
 * each window's title bar, beside the close button (Foundry's own windows,
 * this module's, other modules'). Its icon follows the window, however it
 * was folded. Windows that can't be minimized (most dialogs) get none.
 * The HUD's own floating panels (whisper, notes) and the GM palette have
 * their own buttons (side-panels.js, gm-tools.mjs).
 * ======================================================================== */

function addButton(app) {
  if (!setting("windowMinButton", true)) return;
  if (app.hasFrame === false || app.options?.window?.frame === false || app.options?.window?.minimizable === false) return;
  const header = app.window?.header ?? app.element?.querySelector?.(":scope > header.window-header");
  if (!header || header.querySelector(".pkh-min")) return;
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "header-control icon fa-solid fa-window-minimize pkh-min";
  btn.dataset.tooltip = t("Window.Minimize");
  btn.setAttribute("aria-label", t("Window.Minimize"));
  btn.addEventListener("pointerdown", ev => ev.stopPropagation());   // not a drag of the window
  btn.addEventListener("click", ev => {
    ev.preventDefault();
    ev.stopPropagation();
    return app.minimized ? app.maximize() : app.minimize();
  });
  const anchor = header.querySelector('[data-action="toggleControls"]') ?? header.querySelector('[data-action="close"]');
  if (anchor) anchor.before(btn);
  else header.append(btn);
}

export function registerWindowMinSettings() {
  game.settings.register(MODULE_ID, "windowMinButton", {
    name: "PKH.Settings.windowMinButton.Name", hint: "PKH.Settings.windowMinButton.Hint",
    scope: "client", config: true, type: Boolean, default: true,
    onChange: on => {
      if (on) for (const app of foundry.applications.instances.values()) if (app.rendered) addButton(app);
      else for (const b of document.querySelectorAll(".pkh-min")) b.remove();
    }
  });
}

export function initWindowMin() {
  // Every ApplicationV2 fires renderApplicationV2 (its class chain); the title bar is built once, so once is enough.
  Hooks.on("renderApplicationV2", app => { try { addButton(app); } catch (err) { console.warn(`${MODULE_ID} | minimize button`, err); } });
  for (const app of foundry.applications.instances?.values?.() ?? []) if (app.rendered) addButton(app);
}
