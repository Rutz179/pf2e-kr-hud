import { MAX_FACES, MODULE_ID, SimpleWindow, TABLE_EDITION, displayName, esc, facesOf, hudFaces, isVideo, setting, stageFaces, t } from "./shared.mjs";
import { gmPortraitActor, pinnedActors, portraitSrc, setFace, sheetPortraitSrc, voiceRoomUsers } from "./portraits.mjs";
import { FRAME_DEFAULT, ZOOM_MAX, ZOOM_MIN, bindFrameEditor, fitPreview, frameOf, isPlain } from "./portrait-frame.mjs";
import { canEditSlots } from "./slots.mjs";
import { featureOn, healthChanged, healthPercent } from "./systems.mjs";
import { rutzSetting } from "./rutz-editions.mjs";
import { settingsHubTool } from "./rutz-settings-hub.mjs";

// The token HUD palette lists every preset in a 3-column grid beside the token: 12 keeps it on screen.
export const MAX_TOKEN_IMAGES = 12;

// The "@기본" keyword is data (typed in chat, matched in portraits.mjs too): it stays as is.
const DEFAULT_FACE = "기본";

/* "러츠 툴킷": one scene-control tab for everything this module adds */

/** Buttons other modules or systems add to the tab (api.registerTool). */
const extraTools = [];
export function registerTool(tool) {
  if (!tool?.name) return;
  const i = extraTools.findIndex(x => x.name === tool.name);
  if (i >= 0) extraTools.splice(i, 1, tool);
  else extraTools.push(tool);
}

function registerToolkitTab() {
  Hooks.on("getSceneControlButtons", controls => {
    const tools = {};
    let order = 0;
    const add = (name, title, icon, onChange, visible = true, extra = {}) => {
      tools[name] = { name, title, icon, order: order++, button: true, visible, onChange, ...extra };
    };
    // A plain (non-button) tool is the group's resting tool, so opening the tab
    // never fires one of the buttons by itself.
    tools.pkhHome = { name: "pkhHome", title: t("Toolkit.Home"), icon: "fa-solid fa-arrow-pointer", order: order++, onChange: () => {} };
    add("pkhPortraits", t("Toolkit.Portraits"), "fa-solid fa-users-rectangle", () => openPortraitManager(), game.user.isGM);
    add("pkhFaces", t("Toolkit.Faces"), "fa-solid fa-masks-theater", () => openFaces(), !game.user.isGM);
    // PF2e-only tools show when their part of the HUD runs (not in the Discord Table). Roll requests are on the HUD bar; reaction settings and the voice link are in the settings window.
    add("pkhPalette", t("Toolkit.Palette"), "fa-solid fa-table-cells", () => game.pkhPalette?.toggle?.(), game.user.isGM && !TABLE_EDITION);
    add("pkhGroupCheck", t("Toolkit.GroupCheck"), "fa-solid fa-people-group", () => game.pf2eKrHud?.groupCheck?.(), game.user.isGM && !TABLE_EDITION && featureOn("groupCheck"));
    add("pkhRecall", t("Recall.Title"), "fa-solid fa-brain", () => game.pf2eKrHud?.recall?.(), game.user.isGM && !TABLE_EDITION && featureOn("recall"));
    for (const tool of extraTools) add(tool.name, tool.title ?? tool.name, tool.icon ?? "fa-solid fa-star", tool.onChange ?? (() => {}), tool.visible ?? true);
    // one button for the settings windows of every Rutz module that is on (the same tool the other modules add)
    const hub = settingsHubTool(90);
    if (hub) tools[hub.name] = hub;

    // Another Rutz module may already have put its buttons in here; keep them.
    controls.rutzToolkit = {
      name: "rutzToolkit",
      title: t("Toolkit.Title"),
      icon: "fa-solid fa-toolbox",
      order: controls.rutzToolkit?.order ?? Object.keys(controls).length,
      visible: true,
      activeTool: "pkhHome",
      tools: { ...(controls.rutzToolkit?.tools ?? {}), ...tools }
    };
    addTokenTools(controls);
  });
}

/** 공유 노트 and 귓속말 go under Foundry's token controls so they show without opening a tab, in the shape PF2e uses for its clock button: `controls.tokens.tools.worldClock = { ..., button: true, onChange }` with `order: Object.keys(controls.tokens.tools).length`. */
export function addTokenTools(controls) {
  const group = controls?.tokens?.tools ? controls.tokens : controls?.rutzToolkit;   // no token group: keep them in the tab
  if (!group) return;
  group.tools ??= {};
  const add = (name, title, icon, onChange) => {
    group.tools[name] = { name, title, icon, order: Object.keys(group.tools).length, button: true, visible: true, onChange };
  };
  add("pkhNotes", t("Toolkit.Notes"), "fa-solid fa-book", () => game.pkhPanels?.notes?.());
  add("pkhWhisper", t("Toolkit.Whisper"), "fa-solid fa-user-secret", () => game.pkhPanels?.whisper?.());
}

/* Unified portrait manager (GM) */

export function openPortraitManager() {
  if (!game.user.isGM) return openFaces();
  // Each player's portrait is their assigned character: picked here by its picture. With Discord voice, only the
  // players in the bot's voice room get one (in the link manager's order, the room's team first).
  const players = () => game.users.filter(u => !u.isGM);
  const isPc = a => a.type === "character" || a.hasPlayerOwner;
  const allPcs = () => game.actors.filter(isPc).sort((a, b) => a.name.localeCompare(b.name, "ko"));
  const pic = a => a.img || a.prototypeToken?.texture?.src || "icons/svg/mystery-man.svg";
  const tile = (user, a, on = user.character?.id === a.id) => `<button type="button" class="pkh-pm-char ${on ? "on" : ""}" data-user="${user.id}" data-actor="${a.id}" data-tooltip="${esc(displayName(a.name))}">
      ${isVideo(pic(a)) ? `<video src="${esc(pic(a))}" muted></video>` : `<img src="${esc(pic(a))}" alt="" loading="lazy">`}<span>${esc(displayName(a.name))}</span></button>`;

  const html = () => {
    const room = voiceRoomUsers();
    const bridge = game.pf2eKrVoiceBridge?.room ?? null;
    const voiceOn = !!setting("voiceBridgeEnabled", false);
    const voiceOnly = !!setting("portraitsVoiceOnly", true);
    let line;
    if (!voiceOn) line = t("Portraits.Manager.RoomNoVoice");
    else if (!voiceOnly) line = t("Portraits.Manager.RoomAll");
    else if (room) line = t("Portraits.Manager.RoomOn", { room: esc(bridge?.channelName ?? "Discord"), n: room.filter(id => !game.users.get(id)?.isGM).length });
    else if (bridge?.joined && !bridge.reportsMembers) line = t("Portraits.Manager.RoomOld");
    else line = t("Portraits.Manager.RoomOff");
    const here = new Set(room ?? []);
    const pcs = allPcs();
    const order = players().sort((a, b) => (here.has(b.id) - here.has(a.id)) || a.name.localeCompare(b.name, "ko"));
    const rows = order.map(user => {
      const own = pcs.filter(a => a.testUserPermission(user, "OWNER") || user.character?.id === a.id);
      const rest = pcs.filter(a => !own.includes(a));
      const cur = user.character;
      return `<div class="pkh-pm-user ${here.has(user.id) ? "here" : ""}" data-user="${user.id}">
        <div class="pkh-pm-who"><span class="dot" data-tooltip="${esc(t(here.has(user.id) ? "Portraits.Manager.InRoom" : "Portraits.Manager.NotInRoom"))}"></span><b>${esc(user.name)}</b>
          <span class="grow"></span>
          ${cur ? `<button type="button" class="pkh-pm-small" data-act="faces" data-actor="${cur.id}" data-tooltip="${esc(t("Portraits.Manager.FacesTip"))}"><i class="fa-solid fa-masks-theater"></i></button>` : ""}
          ${rest.length ? `<button type="button" class="pkh-pm-small" data-act="more" data-tooltip="${esc(t("Portraits.Manager.MoreChars"))}"><i class="fa-solid fa-plus"></i></button>` : ""}</div>
        <div class="pkh-pm-chars">${own.length ? own.map(a => tile(user, a)).join("") : `<span class="pkh-pm-none">${t("Portraits.Manager.NoChars")}</span>`}</div>
        <div class="pkh-pm-chars pkh-pm-rest" hidden>${rest.map(a => tile(user, a)).join("")}</div>
      </div>`;
    }).join("");
    // the GM's own face: a world actor nobody plays (a character of the GM's), or any actor dropped on the row
    const gmPicks = game.actors.filter(a => a.type === "character" && !a.hasPlayerOwner).sort((a, b) => a.name.localeCompare(b.name, "ko"));
    const gmRows = game.users.filter(u => u.isGM).map(user => {
      const cur = gmPortraitActor(user);
      const rest = gmPicks.filter(a => a.id !== cur?.id);
      return `<div class="pkh-pm-user gm ${user.active ? "here" : ""}" data-user="${user.id}">
        <div class="pkh-pm-who"><span class="dot"></span><b>${esc(user.name)}</b>
          <span class="grow"></span>
          ${cur ? `<button type="button" class="pkh-pm-small" data-act="faces" data-actor="${cur.id}" data-tooltip="${esc(t("Portraits.Manager.FacesTip"))}"><i class="fa-solid fa-masks-theater"></i></button>
          <button type="button" class="pkh-pm-small" data-act="gm-off" data-tooltip="${esc(t("Portraits.Manager.GmOff"))}"><i class="fa-solid fa-xmark"></i></button>` : ""}
          ${rest.length ? `<button type="button" class="pkh-pm-small" data-act="more" data-tooltip="${esc(t("Portraits.Manager.MoreChars"))}"><i class="fa-solid fa-plus"></i></button>` : ""}</div>
        <div class="pkh-pm-chars">${cur ? tile(user, cur, true) : `<span class="pkh-pm-none">${t("Portraits.Manager.GmNone")}</span>`}</div>
        <div class="pkh-pm-chars pkh-pm-rest" hidden>${rest.map(a => tile(user, a, false)).join("")}</div>
      </div>`;
    }).join("");
    const old = pinnedActors().some(Boolean);   // pins to deleted characters don't count
    const editing = !!game.pf2eKrStage?.overlay?.editing;
    return `<div class="pkh-manager pkh-pm">
      <label class="pkh-check"><input type="checkbox" name="shown" ${setting("portraitsShown", true) ? "checked" : ""}> ${t("Portraits.Manager.ShowAll")}</label>
      <label class="pkh-check"><input type="checkbox" name="bubbles" ${setting("portraitChatBubbles", true) ? "checked" : ""}> ${t("Portraits.Manager.Bubbles")}</label>
      <label class="pkh-check" data-tooltip="${esc(t("Portraits.Manager.VoiceOnlyTip"))}"><input type="checkbox" name="voiceOnly" ${voiceOnly ? "checked" : ""}> ${t("Portraits.Manager.VoiceOnly")}</label>
      <p class="pkh-pm-room"><i class="fa-brands fa-discord"></i> ${line}</p>
      <h3>${t("Portraits.Manager.Players")}</h3>
      <p class="pkh-pick-hint">${t("Portraits.Manager.PlayersHint")}</p>
      <div class="pkh-pm-list">${rows || `<p class="pkh-pm-none">${t("Portraits.Manager.NoPlayers")}</p>`}</div>
      <h3>${t("Portraits.Manager.Gm")}</h3>
      <p class="pkh-pick-hint">${t("Portraits.Manager.GmHint")}</p>
      <div class="pkh-pm-gm">${gmRows}</div>
      ${old ? `<div class="pkh-pm-old">${t("Portraits.Manager.OldSeats")}<button type="button" data-act="auto">${t("Portraits.Manager.ClearOld")}</button></div>` : ""}
      <h3>${t("Portraits.Manager.Layout")}</h3>
      <div class="pkh-seat-buttons">
        <button type="button" data-act="layout"><i class="fa-solid fa-arrows-up-down-left-right"></i> ${t(editing ? "Portraits.Manager.LockLayout" : "Portraits.Manager.EditLayout")}</button>
        <button type="button" data-act="reset"><i class="fa-solid fa-border-all"></i> ${t("Portraits.Manager.Reset")}</button>
      </div>
    </div>`;
  };

  const win = new SimpleWindow({
    id: `${MODULE_ID}-portrait-manager`,
    title: t("Toolkit.Portraits"),
    width: 520,
    classes: ["pkh-fit"],
    html,
    onRender: (root, app) => {
      if (root.dataset.pkhBound) return;
      root.dataset.pkhBound = "1";
      const keep = () => [...root.querySelectorAll(".pkh-pm-user")].filter(n => !n.querySelector(".pkh-pm-rest")?.hidden).map(n => n.dataset.user);
      const redraw = async () => {
        const open = keep();
        await app.render();
        for (const id of open) { const r = root.querySelector(`.pkh-pm-user[data-user="${id}"] .pkh-pm-rest`); if (r) r.hidden = false; }
      };
      // an actor from the sidebar dropped on a GM row becomes that GM's face
      root.addEventListener("dragover", ev => {
        const row = ev.target.closest?.(".pkh-pm-user.gm");
        if (!row) return;
        ev.preventDefault();
        row.classList.add("drop-over");
      });
      root.addEventListener("dragleave", ev => {
        const row = ev.target.closest?.(".pkh-pm-user.gm");
        if (row && !row.contains(ev.relatedTarget)) row.classList.remove("drop-over");
      });
      root.addEventListener("drop", async ev => {
        const row = ev.target.closest?.(".pkh-pm-user.gm");
        if (!row) return;
        ev.preventDefault();
        row.classList.remove("drop-over");
        let data = null;
        try { data = JSON.parse(ev.dataTransfer?.getData("text/plain") || "null"); } catch (_) { data = null; }
        if (data?.type !== "Actor") return;
        const actor = data.uuid ? foundry.utils.fromUuidSync(data.uuid) : game.actors.get(data.id);
        if (actor?.documentName !== "Actor" || actor.pack || !game.actors.get(actor.id)) return ui.notifications.info(`Rutz's HUD | ${t("Portraits.Manager.GmWorldOnly")}`);
        const user = game.users.get(row.dataset.user);
        if (!user?.isGM) return;
        await user.setFlag(MODULE_ID, "portraitActor", actor.id);
        redraw();
      });
      root.addEventListener("change", async ev => {
        const name = ev.target?.name;
        const key = { shown: "portraitsShown", bubbles: "portraitChatBubbles", voiceOnly: "portraitsVoiceOnly" }[name];
        if (!key) return;
        await game.settings.set(MODULE_ID, key, !!ev.target.checked);
        if (name === "voiceOnly") redraw();
      });
      root.addEventListener("click", async ev => {
        const char = ev.target.closest(".pkh-pm-char");
        if (char) {
          // that player's assigned character (Foundry's own), which their portrait shows
          const user = game.users.get(char.dataset.user);
          if (user?.isGM) {
            if (gmPortraitActor(user)?.id === char.dataset.actor) return;
            await user.setFlag(MODULE_ID, "portraitActor", char.dataset.actor);
            return redraw();
          }
          if (!user || user.character?.id === char.dataset.actor) return;
          await user.update({ character: char.dataset.actor });
          return redraw();
        }
        const btn = ev.target.closest("button[data-act]");
        if (!btn) return;
        switch (btn.dataset.act) {
          case "more": {
            const rest = btn.closest(".pkh-pm-user")?.querySelector(".pkh-pm-rest");
            if (rest) rest.hidden = !rest.hidden;
            return;
          }
          case "faces": return openFaces(game.actors.get(btn.dataset.actor));
          case "gm-off": {
            const user = game.users.get(btn.closest(".pkh-pm-user")?.dataset.user);
            if (user?.isGM) await user.unsetFlag(MODULE_ID, "portraitActor");
            return redraw();
          }
          case "layout":
            game.pf2eKrStage?.toggleLayoutEditing();
            return app.close();
          case "reset": return game.pf2eKrStage?.resetLayout();
          case "auto":
            await game.settings.set(MODULE_ID, "portraitSlots", {});
            return redraw();
        }
      });
    }
  });
  win.render({ force: true });
}

/*
 * Expressions (CoCoFolia-style): images per character (MAX_FACES is only a safety cap), switched by typing "@키워드" in chat; "@기본" returns to the normal portrait.
 * flags.pf2e-kr-hud.faces = [{ key, img }, ...]
 * The Cinematic Stage's expressions count too (shared.mjs facesOf): a keyword set only there changes the party portrait.
 */

/** Rutz's Tactics View is on: token image presets can carry a standing sprite for it. */
const tacticsOn = () => !!game.modules.get("rutz-diorama")?.active;

function pickImage(input, type = "image") {
  const FP = foundry.applications?.apps?.FilePicker?.implementation ?? globalThis.FilePicker;
  if (!FP) return;
  try {
    new FP({ type, current: input.value, callback: path => {
      input.value = path;
      input.dispatchEvent(new Event("change", { bubbles: true }));
    } }).render(true);
  } catch (err) {
    ui.notifications.warn(`Rutz's HUD | ${t("Faces.NoPicker")}`);
  }
}

/** Rows the token-image list starts with: one per stored preset, or a single empty row when there is none. */
export function tokenRowIndexes(count) {
  const n = Math.min(MAX_TOKEN_IMAGES, Math.max(0, Number(count) || 0));
  return n ? Array.from({ length: n }, (_, i) => i) : [0];
}

export function openFaces(actor) {
  actor ??= game.pf2eKrHud?.hud?.actor ?? game.user.character;
  if (!actor) return ui.notifications.warn(`Rutz's HUD | ${t("Faces.NoActor")}`);
  // Same rule as the quickbar: GM, the assigned player, or users the GM allowed.
  if (!canEditSlots(actor)) return ui.notifications.warn(`Rutz's HUD | ${t("Faces.NoPermission")}`);
  const faces = actor.getFlag(MODULE_ID, "faces") ?? [];
  const tokenImages = actor.getFlag(MODULE_ID, "tokenImages") ?? [];
  // A webm/mp4 token shows as a little looping video (an <img> can't show it).
  const preview = src => isVideo(src)
    ? `<video class="preview" src="${esc(src)}" muted autoplay loop playsinline></video>`
    : `<img class="preview" src="${esc(src)}" alt="">`;
  // data-i points at the stored preset a row came from (its sprite is kept when Tactics View is off); new rows get fresh numbers.
  const tokenRow = i => {
    const preset = tokenImages[i] ?? {};
    return `<div class="pkh-face-row pkh-token-row" data-i="${i}">
      ${preview(preset.img || actor.prototypeToken?.texture?.src || actor.img)}
      <input type="text" name="tname" placeholder="${esc(t("Faces.PresetName"))}" value="${esc(preset.name ?? "")}" maxlength="20">
      <input type="text" name="img" placeholder="${esc(t("Faces.TokenPath"))}" value="${esc(preset.img ?? "")}">
      <input type="number" name="hp" min="0" max="99" step="1" placeholder="HP%" value="${preset.hp ?? ""}" data-tooltip="${esc(t("Faces.HpTip"))}">
      <select name="size" data-tooltip="${esc(t("Faces.TokenSize"))}">
        ${[["", t("Faces.KeepSize")], ...["0.5", "1", "2", "3", "4"].map(v => [v, t("Faces.Squares", { n: v })])]
          .map(([v, l]) => `<option value="${v}" ${String(preset.size ?? "") === v ? "selected" : ""}>${l}</option>`).join("")}
      </select>
      <button type="button" data-act="browse-token" data-tooltip="${esc(t("Faces.Browse"))}"><i class="fa-solid fa-folder-open"></i></button>
      <button type="button" data-act="remove-token" data-tooltip="${esc(t("Faces.RemoveImage"))}"><i class="fa-solid fa-xmark"></i></button>
      ${tacticsOn() ? `<div class="pkh-sprite-line">
        <i class="fa-solid fa-chess-pawn" data-tooltip="${esc(t("Faces.SpriteTip"))}"></i>
        <input type="text" name="sprite" placeholder="${esc(t("Faces.SpritePath"))}" value="${esc(preset.sprite ?? "")}">
        <button type="button" data-act="browse-sprite" data-tooltip="${esc(t("Faces.Browse"))}"><i class="fa-solid fa-folder-open"></i></button>
      </div>` : ""}
    </div>`;
  };
  const row = (f = {}) => `<div class="pkh-face-row pkh-expr-row">
      <img class="preview" src="${esc(f.img || actor.img)}" alt="">
      <input type="text" name="key" placeholder="${esc(t("Faces.Keyword"))}" value="${esc(f.key ?? "")}" maxlength="20">
      <input type="text" name="img" placeholder="${esc(t("Faces.ImagePath"))}" value="${esc(f.img ?? "")}">
      <button type="button" data-act="browse" data-tooltip="${esc(t("Faces.Browse"))}"><i class="fa-solid fa-folder-open"></i></button>
      <button type="button" data-act="remove-face" data-tooltip="${esc(t("Faces.Remove"))}"><i class="fa-solid fa-xmark"></i></button>
    </div>`;
  const own = hudFaces(actor);
  const stage = stageFaces(actor);
  const fromStage = stage.filter(f => !own.some(o => o.key === f.key));
  const stageLine = stage.length ? `<p class="pkh-pick-hint pkh-stage-faces"><i class="fa-solid fa-masks-theater"></i> ${t("Faces.StageFaces", { list: stage.map(f => `@${esc(f.key)}`).join(" ") })}
      ${fromStage.length ? `<button type="button" data-act="copy-stage">${esc(t("Faces.CopyStage"))}</button>` : ""}</p>` : "";
  // Portrait framing (zoom / turn / mirror), shown as the stage draws it. Saved with the window's Save.
  const frame0 = frameOf(actor.getFlag(MODULE_ID, "portraitFrame"));
  // the party portrait's own picture (empty: the sheet's, or the token's per the setting)
  const ownPic = String(actor.getFlag(MODULE_ID, "portraitImg") ?? "");
  const framing = `<h3 class="pkh-sub">${t("Faces.Frame")}</h3>
      <div class="pkh-portrait-pic">
        <span class="pkh-portrait-pic-label">${t("Faces.PortraitPic")}</span>
        <input type="text" name="portraitImg" placeholder="${esc(t("Faces.PortraitPicEmpty"))}" value="${esc(ownPic)}">
        <button type="button" data-act="browse-portrait" data-tooltip="${esc(t("Faces.Browse"))}"><i class="fa-solid fa-folder-open"></i></button>
        <button type="button" data-act="clear-portrait" data-tooltip="${esc(t("Faces.PortraitPicClear"))}"><i class="fa-solid fa-xmark"></i></button>
      </div>
      <div class="pkh-frame-ed">
        <div class="pkh-frame-preview" data-tooltip="${esc(t("Faces.FrameHint"))}"><div class="pkh-pic clip"><img src="${esc(portraitSrc(actor))}" alt="" draggable="false"></div></div>
        <div class="pkh-frame-ctl">
          <label><span>${t("Faces.FrameZoom")}</span><input type="range" name="fzoom" min="${ZOOM_MIN}" max="${ZOOM_MAX}" step="0.01"><output data-for="fzoom"></output></label>
          <label><span>${t("Faces.FrameTurn")}</span><input type="range" name="frot" min="-180" max="180" step="1"><output data-for="frot"></output></label>
          <div class="pkh-frame-row">
            <label class="pkh-check"><input type="checkbox" name="fflip"> ${t("Faces.FrameFlip")}</label>
            <button type="button" data-act="frame-reset"><i class="fa-solid fa-rotate-left"></i> ${t("Faces.FrameReset")}</button>
          </div>
          <p class="pkh-pick-hint">${t("Faces.FrameHint")}</p>
        </div>
      </div>`;
  new SimpleWindow({
    title: t("Faces.Title", { name: displayName(actor.name) }),
    width: 560,
    classes: ["pkh-fit", "pkh-w-faces"],
    html: `<div class="pkh-faces"><div class="pkh-faces-body">
      ${framing}
      <h3 class="pkh-sub">${t("Faces.Expressions")}</h3>
      <p class="pkh-pick-hint">${t("Faces.Hint1")}
        ${t("Faces.Hint2", { face: game.i18n.lang === "ko" ? DEFAULT_FACE : "default" })}</p>
      ${stageLine}
      <div class="pkh-expr-list">${[...faces, {}].slice(0, MAX_FACES).map(row).join("")}</div>
      <button type="button" data-act="add-face" class="pkh-add-face"><i class="fa-solid fa-plus"></i> ${t("Faces.Add")}</button>
      <h3 class="pkh-sub">${t("Faces.Presets")}</h3>
      <p class="pkh-pick-hint">${t("Faces.PresetsHint", { icon: '<i class="fa-solid fa-images"></i>' })}</p>
      <div class="pkh-token-list">${tokenRowIndexes(tokenImages.length).map(tokenRow).join("")}</div>
      <button type="button" data-act="add-token" class="pkh-add-face"><i class="fa-solid fa-plus"></i> ${t("Faces.AddImage")}</button>
      </div>
      <div class="pkh-seat-buttons"><button type="button" data-act="save" class="primary"><i class="fa-solid fa-check"></i> ${t("Common.Save")}</button></div>
    </div>`,
    onRender: (root, app) => {
      // framing: the preview and the sliders follow one frame object
      const view = root.querySelector(".pkh-frame-preview");
      const input = name => root.querySelector(`[name="${name}"]`);
      const showFrame = f => {
        input("fzoom").value = f.zoom;
        input("frot").value = f.rot;
        input("fflip").checked = f.flip;
        root.querySelector("output[data-for=fzoom]").textContent = `${f.zoom.toFixed(2)}×`;
        root.querySelector("output[data-for=frot]").textContent = `${Math.round(f.rot)}°`;
      };
      fitPreview(view);
      const framer = bindFrameEditor(view, frame0, showFrame);
      showFrame(framer.get());
      root.querySelector(".pkh-frame-ctl").addEventListener("input", ev => {
        const name = ev.target.name;
        if (name === "fzoom") framer.set({ zoom: Number(ev.target.value) });
        else if (name === "frot") framer.set({ rot: Number(ev.target.value) });
        else if (name === "fflip") framer.set({ flip: ev.target.checked });
      });
      // the party portrait's picture: the framing preview shows it straight away
      const portraitInput = input("portraitImg");
      const showPortraitPic = () => {
        const img = view.querySelector("img");
        if (!img) return;
        img.src = portraitInput.value.trim() || sheetPortraitSrc(actor);
      };
      portraitInput.addEventListener("change", showPortraitPic);
      root.addEventListener("change", ev => {
        const r = ev.target.closest(".pkh-face-row");
        if (!r || ev.target.name !== "img") return;
        const src = ev.target.value || actor.img;
        const old = r.querySelector(".preview");
        if (r.classList.contains("pkh-token-row")) old.outerHTML = preview(src);
        else old.src = src;
      });
      const list = root.querySelector(".pkh-expr-list");
      const addRow = f => {
        if (list.children.length >= MAX_FACES) return ui.notifications.info(`Rutz's HUD | ${t("Faces.Full", { n: MAX_FACES })}`);
        list.insertAdjacentHTML("beforeend", row(f));
      };
      const tokenList = root.querySelector(".pkh-token-list");
      let nextTokenIndex = Math.max(tokenImages.length, 1);
      const addTokenRow = () => {
        if (tokenList.children.length >= MAX_TOKEN_IMAGES) return ui.notifications.info(`Rutz's HUD | ${t("Faces.FullImages", { n: MAX_TOKEN_IMAGES })}`);
        tokenList.insertAdjacentHTML("beforeend", tokenRow(nextTokenIndex++));
        tokenList.lastElementChild?.querySelector("input[name=tname]")?.focus();
      };
      root.addEventListener("click", async ev => {
        const btn = ev.target.closest("button[data-act]");
        if (!btn) return;
        if (btn.dataset.act === "browse") return pickImage(btn.closest(".pkh-face-row").querySelector("input[name=img]"));
        // Tokens can be videos (webm …): the picker lists them too.
        if (btn.dataset.act === "browse-token") return pickImage(btn.closest(".pkh-face-row").querySelector("input[name=img]"), "imagevideo");
        if (btn.dataset.act === "frame-reset") return void framer.set(FRAME_DEFAULT);
        if (btn.dataset.act === "browse-portrait") return pickImage(portraitInput);
        if (btn.dataset.act === "clear-portrait") { portraitInput.value = ""; return void showPortraitPic(); }
        if (btn.dataset.act === "add-face") return addRow({});
        if (btn.dataset.act === "add-token") return addTokenRow();
        if (btn.dataset.act === "remove-token") {
          btn.closest(".pkh-token-row")?.remove();
          if (!tokenList.children.length) addTokenRow();
          return;
        }
        if (btn.dataset.act === "remove-face") {
          btn.closest(".pkh-expr-row")?.remove();
          if (!list.children.length) addRow({});
          return;
        }
        if (btn.dataset.act === "copy-stage") {
          const have = new Set([...list.querySelectorAll("input[name=key]")].map(i => i.value.trim()));
          // empty rows first make room
          for (const r of [...list.querySelectorAll(".pkh-expr-row")]) if (!r.querySelector("input[name=key]").value.trim() && !r.querySelector("input[name=img]").value.trim()) r.remove();
          for (const f of stageFaces(actor)) if (!have.has(f.key)) addRow(f);
          btn.remove();
          return;
        }
        if (btn.dataset.act === "browse-sprite") return pickImage(btn.closest(".pkh-face-row").querySelector("input[name=sprite]"), "imagevideo");
        if (btn.dataset.act === "save") {
          // a plain frame is stored as nothing, so the character looks exactly as before
          const frame = framer.get();
          if (isPlain(frame)) { if (actor.getFlag(MODULE_ID, "portraitFrame")) await actor.unsetFlag(MODULE_ID, "portraitFrame"); }
          else await actor.setFlag(MODULE_ID, "portraitFrame", frame);
          const pic = portraitInput.value.trim();
          if (pic) { if (pic !== ownPic) await actor.setFlag(MODULE_ID, "portraitImg", pic); }
          else if (ownPic) await actor.unsetFlag(MODULE_ID, "portraitImg");
          const images0 = tokenImages;
          const images = [...root.querySelectorAll(".pkh-token-row")].map(r => ({
            name: r.querySelector("input[name=tname]").value.trim(),
            img: r.querySelector("input[name=img]").value.trim(),
            size: Number(r.querySelector("select[name=size]")?.value) || null,
            sprite: (el => (el ? el.value.trim() : images0[Number(r.dataset.i)]?.sprite ?? ""))(r.querySelector("input[name=sprite]")),
            hp: (v => (v === "" || !Number.isFinite(Number(v)) ? null : Math.max(0, Math.min(99, Math.round(Number(v))))))(r.querySelector("input[name=hp]")?.value ?? "")
          })).filter(t => t.img).slice(0, MAX_TOKEN_IMAGES);
          await actor.setFlag(MODULE_ID, "tokenImages", images);
          const exprs = [...root.querySelectorAll(".pkh-expr-row")].map(r => ({
            key: r.querySelector("input[name=key]").value.trim().replace(/^@/, "").replace(/\s+/g, ""),
            img: r.querySelector("input[name=img]").value.trim()
          })).filter(f => f.key && f.img && f.key !== DEFAULT_FACE && f.key !== "default").slice(0, MAX_FACES);
          await actor.setFlag(MODULE_ID, "faces", exprs);
          ui.notifications.info(`Rutz's HUD | ${t("Faces.Saved", { faces: exprs.length, images: images.length })}`);
          app.close();
        }
      });
    }
  }).render({ force: true });
}

// "@웃음" or "@ 웃음"; never touches @Check[...] / @UUID[...] or e-mail-like text.
const FACE_RE = /(^|[\s>]|&nbsp;)@ ?([^\s@<>[\]{}|&]{1,20})(?=\s|$|<|&nbsp;)/g;

/** Visible text of chat HTML ("<p></p>" and "&nbsp;" count as empty). */
function visibleText(html) {
  const div = document.createElement("div");
  div.innerHTML = html;
  return (div.textContent ?? "").replace(/\u00a0/g, " ").trim();
}

/** Whose face? The speaking token, else your character, else the character on your HUD. */
function faceActor(message) {
  const bySpeaker = game.actors.get(message.speaker?.actor);
  if (bySpeaker) return bySpeaker;
  const gmFace = gmPortraitActor(game.user);
  if (gmFace) return gmFace;
  if (game.user.character) return game.user.character;
  const hudActor = game.pf2eKrHud?.hud?.actor;
  return hudActor?.isOwner ? hudActor : null;
}

/** Rutz's Cinematic Stage (either edition) in RP mode handles "@표정" itself (stage pictures, timed faces). */
const stageOn = () => !!rutzSetting("rutz-crit-cutin", "stageActive", false);

function registerFaceKeywords() {
  // On the author's own client, before the message exists: pull "@키워드" out.
  Hooks.on("preCreateChatMessage", (message, data, options, userId) => {
    if (userId !== game.user.id || stageOn()) return;
    const content = String(message.content ?? "");
    if (!content.includes("@")) return;
    const actor = faceActor(message);
    if (!actor) return;
    const keys = new Set(facesOf(actor).map(f => f.key));   // the HUD's and the Cinematic Stage's
    keys.add(DEFAULT_FACE);
    keys.add("default"); // English alias of "@기본"

    let found = null;
    const stripped = content.replace(FACE_RE, (m, pre, key) => {
      if (!keys.has(key)) return m;
      found = key;
      return pre;
    }).trim();
    if (!found) return;

    if (!visibleText(stripped)) {
      // Only a keyword: change the face for everyone, post nothing.
      setFace(actor.id, found);
      game.socket.emit(`module.${MODULE_ID}`, { action: "face", actor: actor.id, key: found });
      return false;
    }
    message.updateSource({ content: stripped, [`flags.${MODULE_ID}.face`]: { actor: actor.id, key: found } });
  });

  game.socket.on(`module.${MODULE_ID}`, payload => {
    if (payload?.action === "face") setFace(payload.actor, payload.key);
  });
}

/* Foundry's connected-players box: normal, or a small icon (click to peek) */

let peekTimer = null;

function foldPlayers() {
  clearTimeout(peekTimer);
  document.body.classList.remove("pkh-players-peek");
}

/** Show the real list for a few seconds; it folds again on its own or when the mouse leaves. */
function peekPlayers() {
  document.body.classList.add("pkh-players-peek");
  clearTimeout(peekTimer);
  peekTimer = setTimeout(foldPlayers, 6000);
  const list = document.getElementById("players");
  if (list && !list.dataset.pkhPeekBound) {
    list.dataset.pkhPeekBound = "1";
    list.addEventListener("pointerenter", () => clearTimeout(peekTimer));
    list.addEventListener("pointerleave", () => {
      if (document.body.classList.contains("pkh-players-peek")) peekTimer = setTimeout(foldPlayers, 800);
    });
  }
}

function syncPlayersList() {
  const mode = setting("playersListMode", "icon");
  document.body.classList.toggle("pkh-players-icon", mode === "icon");
  let btn = document.getElementById("pkh-players-toggle");
  if (mode !== "icon") {
    btn?.remove();
    foldPlayers();
    return;
  }
  if (!btn) {
    btn = document.createElement("button");
    btn.id = "pkh-players-toggle";
    btn.type = "button";
    btn.addEventListener("click", peekPlayers);
    document.body.appendChild(btn);
  }
  const online = game.users.filter(u => u.active).length;
  btn.innerHTML = `<i class="fa-solid fa-users"></i><span>${online}</span>`;
  btn.dataset.tooltip = t("Players.Online", { n: online });
  btn.setAttribute("aria-label", btn.dataset.tooltip);
}

/* Token image presets on the token HUD (right-click a token) */

function registerTokenPresets() {
  Hooks.on("renderTokenHUD", (hud, html) => {
    const root = html instanceof HTMLElement ? html : html?.[0];
    const token = hud.object ?? hud.token;
    const actor = token?.actor;
    if (!root || !actor?.isOwner) return;
    const presets = actor.getFlag(MODULE_ID, "tokenImages") ?? [];
    if (!presets.length) return;
    const column = root.querySelector(".col.right") ?? root.querySelector(".right") ?? root;
    const proto = actor.prototypeToken;
    const ringOn = !!token.document.ring?.enabled;
    // With a dynamic token ring the visible picture is ring.subject.texture.
    const shown = doc => (doc?.ring?.enabled && doc.ring.subject?.texture) || doc?.texture?.src;
    const original = shown(proto);
    const baseSize = proto?.width ?? null;
    const choices = [{ name: t("Faces.Original"), img: original, size: baseSize, original: true }, ...presets].filter(c => c.img);
    const sizes = [0.5, 1, 2, 3, 4];

    const button = document.createElement("button");
    button.type = "button";
    button.className = "control-icon pkh-token-presets";
    button.dataset.tooltip = t("Faces.HudButton");
    button.innerHTML = `<i class="fa-solid fa-images"></i>`;
    const palette = document.createElement("div");
    palette.className = "pkh-token-palette hidden";
    const current = shown(token.document);
    const width = token.document.width;
    palette.innerHTML = `
      <div class="imgs">${choices.map((c, i) => `
        <button type="button" data-i="${i}" class="${current === c.img ? "current" : ""}"
                data-tooltip="${esc(c.name || "")}${c.size ? ` · ${t("Faces.Squares", { n: c.size })}` : ""}">${isVideo(c.img) ? `<video src="${esc(c.img)}" muted autoplay loop playsinline></video>` : `<img src="${esc(c.img)}" alt="">`}</button>`).join("")}</div>
      <div class="sizes">${sizes.map(n => `<button type="button" data-size="${n}" class="${width === n ? "current" : ""}">${n}</button>`).join("")}
        <span>${t("Faces.SquaresUnit")}</span></div>`;
    button.addEventListener("click", ev => {
      ev.preventDefault();
      ev.stopPropagation();
      palette.classList.toggle("hidden");
    });
    // The HUD layer ignores the mouse except on Foundry's own buttons; stop the
    // canvas from seeing these clicks and handle them here.
    for (const type of ["pointerdown", "mousedown"]) palette.addEventListener(type, ev => ev.stopPropagation());
    palette.addEventListener("click", async ev => {
      ev.preventDefault();
      ev.stopPropagation();
      const pick = ev.target.closest("button[data-i]");
      const size = ev.target.closest("button[data-size]");
      if (pick) {
        const choice = choices[Number(pick.dataset.i)];
        const update = {};
        if (choice.original) {
          update["texture.src"] = proto.texture?.src;
          if (ringOn) update["ring.subject.texture"] = proto.ring?.subject?.texture ?? null;
        } else if (ringOn) {
          update["ring.subject.texture"] = choice.img;
        } else {
          update["texture.src"] = choice.img;
        }
        if (choice.size) Object.assign(update, { width: choice.size, height: choice.size });
        // Tactics View standee: the preset's standing sprite, or (original) the prototype's; a preset without
        // one leaves the standee as it is
        if (tacticsOn()) {
          if (choice.original) update["flags.rutz-diorama.sprite.img"] = proto?.flags?.["rutz-diorama"]?.sprite?.img ?? "";
          else if (choice.sprite) update["flags.rutz-diorama.sprite.img"] = choice.sprite;
        }
        update[`flags.${MODULE_ID}.hpAuto`] = null;   // picked by hand: HP changes leave it alone
        await token.document.update(update);
        // Combat tracker shows the same picture.
        const combatant = game.combat?.combatants.find(c => c.tokenId === token.document.id);
        if (combatant?.isOwner) await combatant.update({ img: choice.original ? null : choice.img });
      } else if (size) {
        const n = Number(size.dataset.size);
        await token.document.update({ width: n, height: n });
      } else return;
      palette.classList.add("hidden");
    });
    column.appendChild(button);
    column.appendChild(palette);
  });
}

/* Token image by HP: a preset with "HP%" is put on the token when the character's HP drops to that share or below (the lowest match wins); the original returns when HP rises above them all. A picture picked by hand from the token HUD is left alone. The active GM's client writes. */

const shownImg = doc => (doc?.ring?.enabled && doc.ring.subject?.texture) || doc?.texture?.src;

/** The preset for this HP share, or null (above every threshold). */
export function hpPresetFor(presets, pct) {
  const hits = (presets ?? []).filter(p => p?.img && p.hp !== null && p.hp !== undefined && p.hp !== "" && pct <= Number(p.hp));
  return hits.sort((a, b) => Number(a.hp) - Number(b.hp))[0] ?? null;
}

function tokensOf(actor) {
  if (actor.isToken) return actor.token ? [actor.token] : [];
  return game.scenes.contents.flatMap(sc => sc.tokens.filter(tk => tk.actorId === actor.id && tk.actorLink));
}

export async function applyHpImage(actor) {
  if (!game.users.activeGM?.isSelf || !actor) return;
  const presets = (actor.isToken ? actor.token?.baseActor : actor)?.getFlag?.(MODULE_ID, "tokenImages") ?? actor.getFlag?.(MODULE_ID, "tokenImages") ?? [];
  if (!presets.some(p => p?.hp !== null && p?.hp !== undefined && p?.hp !== "")) return;
  const pct = healthPercent(actor);
  if (pct === null) return;
  const target = hpPresetFor(presets, pct);
  const proto = (actor.isToken ? actor.token?.baseActor : actor)?.prototypeToken ?? actor.prototypeToken;
  const original = shownImg(proto);
  for (const doc of tokensOf(actor)) {
    const ringOn = !!doc.ring?.enabled && !!doc.ring?.subject?.texture;
    const now = shownImg(doc);
    const auto = doc.getFlag?.(MODULE_ID, "hpAuto") ?? null;
    // Only over the original picture or one this put there.
    if (now !== original && now !== auto) continue;
    const want = target?.img ?? original;
    if (!want || want === now) continue;
    const update = { [ringOn ? "ring.subject.texture" : "texture.src"]: want };
    update[`flags.${MODULE_ID}.hpAuto`] = target ? want : null;
    try { await doc.update(update); } catch (err) { console.warn(`${MODULE_ID} | HP token image`, err); }
  }
}

function registerHpImages() {
  const hpChanged = changes => healthChanged(changes);
  Hooks.on("updateActor", (actor, changes) => { if (hpChanged(changes)) applyHpImage(actor); });
  // An unlinked token's HP lives in its delta.
  Hooks.on("updateToken", (doc, changes) => { if (hpChanged(changes?.delta) && doc.actor) applyHpImage(doc.actor); });
}

export function registerToolkitSettings() {
  game.settings.register(MODULE_ID, "playersListMode", {
    name: "PKH.Settings.playersListMode.Name", hint: "PKH.Settings.playersListMode.Hint",
    scope: "client", config: true, type: String, default: "icon",
    choices: { normal: "PKH.Settings.playersListMode.Choices.normal", icon: "PKH.Settings.playersListMode.Choices.icon" }, onChange: syncPlayersList
  });
  registerToolkitTab();
  registerTokenPresets();
  registerHpImages();
}

export function initToolkit() {
  game.pf2eKrHud = { ...(game.pf2eKrHud ?? {}), openPortraitManager, openFaces };
  registerFaceKeywords();
  syncPlayersList();
  Hooks.on("userConnected", syncPlayersList);
}
