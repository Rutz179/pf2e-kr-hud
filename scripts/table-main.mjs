/*
 * Rutz's Discord Table — the entry point of the module Rutz Studio builds from this HUD
 * (rutz-studio/tools/discord-table.mjs). The full HUD never loads this file.
 *
 * The parts of the HUD that work in any system: party portraits (Discord voice glow, away sign,
 * chat bubbles, @faces), whisper and shared-notes panels, chat improvements, the toolkit tab.
 * System data comes through systems.mjs; other systems/modules plug in with the same API the old
 * Immersive UI Kit had ("rutzUI.init" / "rutzUI.ready" → registerSystem, registerTool).
 */
import { MODULE_ID } from "./shared.mjs";
import { initPortraits, registerPortraitSettings } from "./portraits.mjs";
import { initToolkit, openFaces, openPortraitManager, registerTool, registerToolkitSettings } from "./toolkit.mjs";
import { patchChatPortraits, registerChatFaceSettings } from "./chat-faces.mjs";
import { installCalmTooltips } from "./tips.mjs";
import { initChatTrim, registerChatTrimSettings } from "./chat-trim.mjs";
import { registerPolyglotSettings } from "./polyglot.mjs";
import { initNotesJournal, registerNotesJournalSettings } from "./notes-journal.mjs";
import { initChatEdit, registerChatEditSettings } from "./chat-edit.mjs";
import { initWindowMin, registerWindowMinSettings } from "./window-min.mjs";
import { openSettings, registerSettingsWindows } from "./settings-window.mjs";
import { badgesFor, barsFor, registerSystem } from "./systems.mjs";

const api = {
  registerSystem,
  registerTool,
  barsFor,
  badgesFor,
  refresh: () => game.pf2eKrStage?.overlay?.scheduleRender(),
  settings: tab => openSettings(tab),
  openPortraitManager: () => openPortraitManager(),
  openFaces: actor => openFaces(actor),
  get voice() { return game.pf2eKrVoiceBridge ?? null; },
  get stage() { return game.pf2eKrStage ?? null; }
};

Hooks.once("init", () => {
  registerPortraitSettings();
  registerToolkitSettings();
  registerChatFaceSettings();
  registerChatTrimSettings();
  registerPolyglotSettings();
  registerNotesJournalSettings();
  registerChatEditSettings();
  initChatEdit();            // render hooks now, so the lines drawn at start-up get their pen too
  registerWindowMinSettings();
  initWindowMin();
  game.keybindings.register(MODULE_ID, "toggle-portraits", {
    name: "PKH.Keys.TogglePortraits",
    editable: [],
    onDown: () => {
      game.settings.set(MODULE_ID, "portraitsHideLocal", !game.settings.get(MODULE_ID, "portraitsHideLocal"));
      return true;
    }
  });
  game.rutzUI = { ...(game.rutzUI ?? {}), api };
  Hooks.callAll("rutzUI.init", api);
});

Hooks.once("setup", () => {
  patchChatPortraits();
  registerSettingsWindows();
});

Hooks.once("ready", () => {
  installCalmTooltips();
  initPortraits();
  initToolkit();
  initChatTrim();
  initNotesJournal();
  const mod = game.modules.get(MODULE_ID);
  if (mod) mod.api = api;
  game.pf2eKrHud = { ...(game.pf2eKrHud ?? {}), settings: openSettings };
  Hooks.callAll("rutzUI.ready", api);
  console.log(`${MODULE_ID} | ready`);
});
