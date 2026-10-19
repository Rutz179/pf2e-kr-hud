import { MAX_ROWS, MODULE_ID, SLOTS_PER_ROW } from "./shared.mjs";
import { initPortraits, registerPortraitSettings } from "./portraits.mjs";
import { initToolkit, registerToolkitSettings } from "./toolkit.mjs";
import { initGmTools, registerGmToolSettings } from "./gm-tools.mjs";
import { initReactions, registerReactionSettings } from "./reactions.mjs";
import { initHud, registerHudSettings } from "./hud.mjs";
import { registerInfusedHelper } from "./slots.mjs";
import { initTurnTracker, registerTurnTrackerSettings } from "./turn-tracker.mjs";
import { PIN_ACTION } from "./slot-card.mjs";
import { openSettings, registerSettingsWindows } from "./settings-window.mjs";
import { patchChatPortraits, registerChatFaceSettings } from "./chat-faces.mjs";
import { installCalmTooltips } from "./tips.mjs";
<<<<<<< HEAD
import { initChatTrim, registerChatTrimSettings } from "./chat-trim.mjs";
import { initBulkDamage, registerBulkDamageSettings } from "./bulk-damage.mjs";
import { initSustain, registerSustainSettings } from "./sustain.mjs";
import { initSkills, registerSkillsSettings } from "./skills.mjs";
import { initBrowserLegacy, registerBrowserLegacySettings } from "./browser-legacy.mjs";
=======
>>>>>>> 1829203ca48bc59f1555971316cd1e6e313fff8e

/*
 * Hotkeys
 *
 * Row 1 = 1…0, row 2 = Shift+1…0, row 3 = Alt+1…0 (rebindable in Configure
 * Controls). They run at PRIORITY precedence. With "기본 매크로 바 끄기" on
 * (default) the digits always belong to this HUD; with it off they fall
 * through to Foundry's macro bar whenever no HUD is showing.
 */
function registerKeybindings() {
  const MOD = foundry.helpers?.interaction?.KeyboardManager?.MODIFIER_KEYS
    ?? globalThis.KeyboardManager?.MODIFIER_KEYS
    ?? { SHIFT: "Shift", ALT: "Alt" };
  const rowMods = [[], [MOD.SHIFT], [MOD.ALT]];
  const rowNames = ["1줄", "2줄", "3줄"];

  for (let row = 0; row < MAX_ROWS; row++) {
    for (let col = 0; col < SLOTS_PER_ROW; col++) {
      const digit = (col + 1) % 10;
      game.keybindings.register(MODULE_ID, `slot-${row + 1}-${digit}`, {
        name: `퀵슬롯 ${rowNames[row]} ${digit}번`,
        editable: [{ key: `Digit${digit}`, modifiers: rowMods[row] }],
        precedence: CONST.KEYBINDING_PRECEDENCE.PRIORITY,
        onDown: () => game.pf2eKrHud?.hud?.executeHotkey(row, col) ?? false
      });
    }
  }

  game.keybindings.register(MODULE_ID, "page-next", {
    name: "퀵슬롯 다음 페이지",
    editable: [{ key: "BracketRight" }],
    onDown: () => {
      const hud = game.pf2eKrHud?.hud;
      if (!hud?.actor) return false;
      hud.setPage(hud.actor, hud.page(hud.actor) + 1);
      return true;
    }
  });
  game.keybindings.register(MODULE_ID, "page-prev", {
    name: "퀵슬롯 이전 페이지",
    editable: [{ key: "BracketLeft" }],
    onDown: () => {
      const hud = game.pf2eKrHud?.hud;
      if (!hud?.actor) return false;
      hud.setPage(hud.actor, hud.page(hud.actor) - 1);
      return true;
    }
  });
  // Only takes the key while a quickslot card is up (or about to be), so T stays free otherwise.
  game.keybindings.register(MODULE_ID, PIN_ACTION, {
    name: "퀵슬롯 설명 카드 고정 / 닫기",
    hint: "설명 카드가 떠 있을 때 누르면 카드가 고정되어 마우스로 스크롤하거나 링크를 누를 수 있습니다. 다시 누르거나 Esc로 닫습니다.",
    editable: [{ key: "KeyT" }],
    onDown: () => game.pf2eKrHud?.hud?.slotCard?.togglePin() ?? false
  });
  game.keybindings.register(MODULE_ID, "toggle-portraits", {
    name: "내 화면에서 파티 초상화 숨기기/보이기",
    editable: [],
    onDown: () => {
      game.settings.set(MODULE_ID, "portraitsHideLocal", !game.settings.get(MODULE_ID, "portraitsHideLocal"));
      return true;
    }
  });
}

/*
 * One-time world defaults for PF2e (GM only). Done once, so a GM who turns
 * something back on keeps it on.
 *  - "인카운터 중 조건 보기" (pf2e.statusEffectShowCombatMessage): the per-turn
 *    "현재 상태" chat card. The HUD shows conditions already.
 */
async function applyPf2eDefaultsOnce() {
  if (!game.user.isGM || game.settings.get(MODULE_ID, "pf2eDefaultsApplied")) return;
  try {
    if (game.settings.settings.has("pf2e.statusEffectShowCombatMessage")) {
      await game.settings.set("pf2e", "statusEffectShowCombatMessage", false);
    }
  } catch (err) {
    console.warn(`${MODULE_ID} | could not change PF2e defaults`, err);
  }
  await game.settings.set(MODULE_ID, "pf2eDefaultsApplied", true);
}

Hooks.once("init", () => {
  game.settings.register(MODULE_ID, "pf2eDefaultsApplied", { scope: "world", config: false, type: Boolean, default: false });
  registerPortraitSettings();
  registerHudSettings();
  registerKeybindings();
  registerToolkitSettings();
  registerChatFaceSettings();
  registerGmToolSettings();
  registerReactionSettings();
  registerTurnTrackerSettings();
  registerChatTrimSettings();
  registerBulkDamageSettings();
  registerSustainSettings();
  registerSkillsSettings();
  registerBrowserLegacySettings();
});

/*
 * Raw "@UUID[…]" left in a chat message (some drops and macros post text that
 * never went through the enricher) is enriched when the message is drawn, so
 * the chat shows the item's name as a link instead of the code.
 */
const RAW_REF = /@(UUID|Compendium|Check|Damage|Template)\[|\[\[\//;
async function enrichLeftovers(message, html) {
  const root = html instanceof HTMLElement ? html : html?.[0];
  const content = root?.querySelector?.(".message-content");
  if (!content || !RAW_REF.test(content.textContent ?? "")) return;
  const Editor = foundry.applications?.ux?.TextEditor?.implementation ?? globalThis.TextEditor;
  try {
    content.innerHTML = await Editor.enrichHTML(content.innerHTML, { relativeTo: message, rollData: message.getRollData?.() ?? {} });
  } catch (err) {
    console.warn(`${MODULE_ID} | could not enrich chat message`, err);
  }
}
Hooks.on("renderChatMessageHTML", enrichLeftovers);

// Every module file has registered its settings by now; group them into windows.
Hooks.once("setup", () => {
  patchChatPortraits();
  registerSettingsWindows();
});

Hooks.once("ready", () => {
  if (game.system.id !== "pf2e") {
    console.warn(`${MODULE_ID} | PF2e 시스템이 아니므로 비활성화합니다.`);
    return;
  }
  installCalmTooltips();
  applyPf2eDefaultsOnce();
  initPortraits();
  initHud();
  initToolkit();
  initGmTools();
  initReactions();
  initTurnTracker();
  initChatTrim();
  initBulkDamage();
  initSustain();
  initSkills();
  initBrowserLegacy();
  registerInfusedHelper();
  game.pf2eKrHud = { ...(game.pf2eKrHud ?? {}), settings: openSettings };
  console.log(`${MODULE_ID} | ready`);
});
