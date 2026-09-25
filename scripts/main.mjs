import { MAX_ROWS, MODULE_ID, SLOTS_PER_ROW } from "./shared.mjs";
import { initPortraits, registerPortraitSettings } from "./portraits.mjs";
import { initToolkit, registerToolkitSettings } from "./toolkit.mjs";
import { initHud, registerHudSettings } from "./hud.mjs";
import { registerInfusedHelper } from "./slots.mjs";

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
});

Hooks.once("ready", () => {
  if (game.system.id !== "pf2e") {
    console.warn(`${MODULE_ID} | PF2e 시스템이 아니므로 비활성화합니다.`);
    return;
  }
  applyPf2eDefaultsOnce();
  initPortraits();
  initHud();
  initToolkit();
  registerInfusedHelper();
  console.log(`${MODULE_ID} | ready`);
});
