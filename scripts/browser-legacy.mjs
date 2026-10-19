import { MODULE_ID, setting } from "./shared.mjs";

/* ======================================================================== *
 * PF2e compendium browser: optionally hide legacy (pre-remaster) entries.
 * The browser reads each pack's index through its PackLoader; we add the
 * "remaster" field to what it reads and drop entries marked legacy before
 * the browser sees them. Turn the setting off to see everything again.
 * ======================================================================== */

export function registerBrowserLegacySettings() {
  game.settings.register(MODULE_ID, "browserHideLegacy", {
    name: "컴펜디움 브라우저: 레거시 숨기기",
    hint: "PF2e 컴펜디움 브라우저(피트·주문·장비 …)에서 리마스터 이전(레거시) 항목을 빼고 보여 줍니다. 바꾼 뒤에는 브라우저를 다시 열거나 새로고침하세요.",
    scope: "world", config: true, type: Boolean, default: false,
    onChange: () => game.pf2e?.compendiumBrowser?.resetInitializedTabs?.()
  });
}

export function initBrowserLegacy() {
  const loader = game.pf2e?.compendiumBrowser?.packLoader;
  if (!loader?.loadPacks || loader.loadPacks.__pkh) return;
  const original = loader.loadPacks.bind(loader);
  const wrapped = async function* (documentType, packs, indexFields = []) {
    const hide = setting("browserHideLegacy", false) === true;
    const fields = hide ? [...new Set([...indexFields, "system.publication.remaster"])] : indexFields;
    for await (const result of original(documentType, packs, fields)) {
      if (hide && result?.index) {
        // PackLoader can return the shared compendium index. Never delete from it:
        // re-enabling legacy must also restore entries for the builder and sheets.
        const index = new result.index.constructor();
        for (const entry of result.index.values()) {
          if (entry?.system?.publication?.remaster !== false) index.set(entry._id, entry);
        }
        yield { ...result, index };
      } else yield result;
    }
  };
  wrapped.__pkh = true;
  loader.loadPacks = wrapped;
}
