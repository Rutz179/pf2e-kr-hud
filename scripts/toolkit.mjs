import { MODULE_ID, SimpleWindow, displayName, esc, setting } from "./shared.mjs";
import { PC_SLOTS, setFace, stageActors } from "./portraits.mjs";
import { canEditSlots } from "./slots.mjs";

const MAX_TOKEN_IMAGES = 5;

const MAX_FACES = 5;
const DEFAULT_FACE = "기본";

/* ------------------------------------------------------------------------ *
 * "러츠 툴킷" — one scene-control tab for everything this module adds
 * ------------------------------------------------------------------------ */

function registerToolkitTab() {
  Hooks.on("getSceneControlButtons", controls => {
    const tools = {};
    let order = 0;
    const add = (name, title, icon, onChange, visible = true, extra = {}) => {
      tools[name] = { name, title, icon, order: order++, button: true, visible, onChange, ...extra };
    };
    // A plain (non-button) tool is the group's resting tool, so opening the tab
    // never fires one of the buttons by itself.
    tools.pkhHome = { name: "pkhHome", title: "러츠 툴킷", icon: "fa-solid fa-toolbox", order: order++, onChange: () => {} };
    add("pkhPortraits", "초상화 관리", "fa-solid fa-users-rectangle", () => openPortraitManager(), game.user.isGM);
    add("pkhFaces", "내 초상화 표정", "fa-solid fa-masks-theater", () => openFaces(), !game.user.isGM);
    add("pkhWhisper", "귓속말 창", "fa-solid fa-user-secret", () => game.pkhPanels?.whisper?.());
    add("pkhNotes", "공유 노트 창", "fa-solid fa-book", () => game.pkhPanels?.notes?.());
    // Brand icons (fa-brands) can't render in scene controls — Foundry forces the solid face there.
    add("pkhVoice", "디스코드 음성 연동", "fa-solid fa-headset", () => game.pf2eKrVoiceBridge?.openSetup?.(), game.user.isGM);

    controls.rutzToolkit = {
      name: "rutzToolkit",
      title: "러츠 툴킷",
      icon: "fa-solid fa-toolbox",
      order: Object.keys(controls).length,
      visible: true,
      activeTool: "pkhHome",
      tools
    };
  });
}

/* ------------------------------------------------------------------------ *
 * Unified portrait manager (GM)
 * ------------------------------------------------------------------------ */

export function openPortraitManager() {
  if (!game.user.isGM) return openFaces();
  const stored = setting("portraitSlots", {}) ?? {};
  const actors = stageActors();
  const characters = game.actors.filter(a => a.type === "character").sort((a, b) => a.name.localeCompare(b.name, "ko"));
  const labels = { pc1: "왼쪽 위", pc2: "오른쪽 위", pc3: "왼쪽 가운데", pc4: "오른쪽 가운데", pc5: "왼쪽 아래", pc6: "오른쪽 아래" };
  const editing = !!game.pf2eKrStage?.overlay?.editing;

  const seat = (key, i) => `
    <div class="pkh-seat-row">
      <span>${key.toUpperCase()} · ${labels[key]}</span>
      <select name="${key}">
        <option value="">— 자동 / 비움 —</option>
        ${characters.map(a => `<option value="${a.id}" ${stored[key] === a.id ? "selected" : ""}>${esc(displayName(a.name))}</option>`).join("")}
      </select>
      <button type="button" data-act="faces" data-actor="${actors[i]?.id ?? ""}" ${actors[i] ? "" : "disabled"}
              data-tooltip="표정 설정"><i class="fa-solid fa-masks-theater"></i></button>
    </div>`;

  new SimpleWindow({
    id: `${MODULE_ID}-portrait-manager`,
    title: "초상화 관리",
    width: 480,
    html: `<div class="pkh-manager">
      <label class="pkh-check"><input type="checkbox" name="shown" ${setting("portraitsShown", true) ? "checked" : ""}> 모든 참가자에게 파티 초상화 표시</label>
      <label class="pkh-check"><input type="checkbox" name="bubbles" ${setting("portraitChatBubbles", true) ? "checked" : ""}> 채팅 말풍선</label>
      <h3>자리 배정</h3>
      <p class="pkh-pick-hint">비워 두면 플레이어의 <b>할당된 캐릭터</b>가 유저 목록 순서대로 들어갑니다.</p>
      ${PC_SLOTS.map(seat).join("")}
      <h3>배치</h3>
      <div class="pkh-seat-buttons">
        <button type="button" data-act="layout"><i class="fa-solid fa-arrows-up-down-left-right"></i> ${editing ? "배치 잠그기" : "배치 편집 (끌기 · 휠 크기)"}</button>
        <button type="button" data-act="reset"><i class="fa-solid fa-border-all"></i> 기본 자리로</button>
      </div>
      <div class="pkh-seat-buttons">
        <button type="button" data-act="auto"><i class="fa-solid fa-wand-magic-sparkles"></i> 자리 전부 자동</button>
        <button type="button" data-act="save" class="primary"><i class="fa-solid fa-check"></i> 저장</button>
      </div>
    </div>`,
    onRender: (root, app) => {
      root.addEventListener("click", async ev => {
        const btn = ev.target.closest("button[data-act]");
        if (!btn) return;
        switch (btn.dataset.act) {
          case "faces": return openFaces(game.actors.get(btn.dataset.actor));
          case "layout":
            game.pf2eKrStage?.toggleLayoutEditing();
            return app.close();
          case "reset": return game.pf2eKrStage?.resetLayout();
          case "auto":
            await game.settings.set(MODULE_ID, "portraitSlots", {});
            return app.close();
          case "save": {
            const seats = Object.fromEntries(PC_SLOTS.map(k => [k, root.querySelector(`select[name=${k}]`)?.value ?? ""]));
            await game.settings.set(MODULE_ID, "portraitSlots", seats);
            await game.settings.set(MODULE_ID, "portraitsShown", !!root.querySelector("input[name=shown]")?.checked);
            await game.settings.set(MODULE_ID, "portraitChatBubbles", !!root.querySelector("input[name=bubbles]")?.checked);
            return app.close();
          }
        }
      });
    }
  }).render({ force: true });
}

/* ------------------------------------------------------------------------ *
 * Expressions (CoCoFolia-style): up to five images per character, switched by
 * typing "@키워드" in chat. "@기본" goes back to the normal portrait.
 *   flags.pf2e-kr-hud.faces = [{ key, img }, ...]
 * ------------------------------------------------------------------------ */

function pickImage(input) {
  const FP = foundry.applications?.apps?.FilePicker?.implementation ?? globalThis.FilePicker;
  if (!FP) return;
  try {
    new FP({ type: "image", current: input.value, callback: path => {
      input.value = path;
      input.dispatchEvent(new Event("change", { bubbles: true }));
    } }).render(true);
  } catch (err) {
    ui.notifications.warn("PF2e-KR HUD | 파일 선택 창을 열 권한이 없습니다. 이미지 주소를 직접 붙여 넣으세요.");
  }
}

export function openFaces(actor) {
  actor ??= game.pf2eKrHud?.hud?.actor ?? game.user.character;
  if (!actor) return ui.notifications.warn("PF2e-KR HUD | 표정을 설정할 캐릭터를 먼저 선택하세요.");
  // Same rule as the quickbar: GM, the assigned player, or users the GM allowed.
  if (!canEditSlots(actor)) return ui.notifications.warn("PF2e-KR HUD | 이 캐릭터의 표정·토큰 이미지를 바꿀 권한이 없습니다.");
  const faces = actor.getFlag(MODULE_ID, "faces") ?? [];
  const tokenImages = actor.getFlag(MODULE_ID, "tokenImages") ?? [];
  const tokenRow = i => {
    const t = tokenImages[i] ?? {};
    return `<div class="pkh-face-row pkh-token-row" data-i="${i}">
      <img class="preview" src="${esc(t.img || actor.prototypeToken?.texture?.src || actor.img)}" alt="">
      <input type="text" name="tname" placeholder="이름 (예: 변장)" value="${esc(t.name ?? "")}" maxlength="20">
      <input type="text" name="img" placeholder="토큰 이미지 경로" value="${esc(t.img ?? "")}">
      <select name="size" data-tooltip="토큰 크기 (칸)">
        ${[["", "크기 유지"], ["0.5", "0.5칸"], ["1", "1칸"], ["2", "2칸"], ["3", "3칸"], ["4", "4칸"]]
          .map(([v, l]) => `<option value="${v}" ${String(t.size ?? "") === v ? "selected" : ""}>${l}</option>`).join("")}
      </select>
      <button type="button" data-act="browse" data-tooltip="이미지 고르기"><i class="fa-solid fa-folder-open"></i></button>
    </div>`;
  };
  const row = i => {
    const f = faces[i] ?? {};
    return `<div class="pkh-face-row" data-i="${i}">
      <img class="preview" src="${esc(f.img || actor.img)}" alt="">
      <input type="text" name="key" placeholder="키워드 (예: 웃음)" value="${esc(f.key ?? "")}" maxlength="20">
      <input type="text" name="img" placeholder="이미지 경로" value="${esc(f.img ?? "")}">
      <button type="button" data-act="browse" data-tooltip="이미지 고르기"><i class="fa-solid fa-folder-open"></i></button>
    </div>`;
  };
  new SimpleWindow({
    title: `표정 · 토큰 이미지 — ${displayName(actor.name)}`,
    width: 560,
    html: `<div class="pkh-faces">
      <p class="pkh-pick-hint">채팅에 <b>@키워드</b>를 넣으면 초상화가 그 표정으로 바뀝니다. 키워드는 메시지에서 지워집니다.
        <b>@${DEFAULT_FACE}</b>은 원래 초상화로 되돌립니다. 키워드만 보내면 메시지 없이 표정만 바뀝니다.</p>
      ${Array.from({ length: MAX_FACES }, (_, i) => row(i)).join("")}
      <h3 class="pkh-sub">토큰 이미지 프리셋</h3>
      <p class="pkh-pick-hint">토큰을 우클릭하면 나오는 <b><i class="fa-solid fa-images"></i></b> 버튼에서 바로 바꿀 수 있습니다. '원래 이미지'도 항상 함께 나옵니다.</p>
      ${Array.from({ length: MAX_TOKEN_IMAGES }, (_, i) => tokenRow(i)).join("")}
      <div class="pkh-seat-buttons"><button type="button" data-act="save" class="primary"><i class="fa-solid fa-check"></i> 저장</button></div>
    </div>`,
    onRender: (root, app) => {
      root.addEventListener("change", ev => {
        const r = ev.target.closest(".pkh-face-row");
        if (r && ev.target.name === "img") r.querySelector(".preview").src = ev.target.value || actor.img;
      });
      root.addEventListener("click", async ev => {
        const btn = ev.target.closest("button[data-act]");
        if (!btn) return;
        if (btn.dataset.act === "browse") return pickImage(btn.closest(".pkh-face-row").querySelector("input[name=img]"));
        if (btn.dataset.act === "save") {
          const images = [...root.querySelectorAll(".pkh-token-row")].map(r => ({
            name: r.querySelector("input[name=tname]").value.trim(),
            img: r.querySelector("input[name=img]").value.trim(),
            size: Number(r.querySelector("select[name=size]")?.value) || null
          })).filter(t => t.img);
          await actor.setFlag(MODULE_ID, "tokenImages", images);
          const list = [...root.querySelectorAll(".pkh-face-row:not(.pkh-token-row)")].map(r => ({
            key: r.querySelector("input[name=key]").value.trim().replace(/^@/, "").replace(/\s+/g, ""),
            img: r.querySelector("input[name=img]").value.trim()
          })).filter(f => f.key && f.img && f.key !== DEFAULT_FACE);
          await actor.setFlag(MODULE_ID, "faces", list);
          ui.notifications.info(`PF2e-KR HUD | 표정 ${list.length}개, 토큰 이미지 ${images.length}개를 저장했습니다.`);
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
  if (game.user.character) return game.user.character;
  const hudActor = game.pf2eKrHud?.hud?.actor;
  return hudActor?.isOwner ? hudActor : null;
}

function registerFaceKeywords() {
  // On the author's own client, before the message exists: pull "@키워드" out.
  Hooks.on("preCreateChatMessage", (message, data, options, userId) => {
    if (userId !== game.user.id) return;
    const content = String(message.content ?? "");
    if (!content.includes("@")) return;
    const actor = faceActor(message);
    if (!actor) return;
    const keys = new Set((actor.getFlag(MODULE_ID, "faces") ?? []).map(f => f?.key).filter(Boolean));
    keys.add(DEFAULT_FACE);

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

/* ------------------------------------------------------------------------ *
 * Foundry's connected-players box: normal, or a small icon (click to peek)
 * ------------------------------------------------------------------------ */

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
  btn.dataset.tooltip = `접속 중 ${online}명 — 눌러서 잠깐 보기`;
  btn.setAttribute("aria-label", btn.dataset.tooltip);
}

/* ------------------------------------------------------------------------ *
 * Token image presets on the token HUD (right-click a token)
 * ------------------------------------------------------------------------ */

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
    const choices = [{ name: "원래 이미지", img: original, size: baseSize, original: true }, ...presets].filter(c => c.img);
    const sizes = [0.5, 1, 2, 3, 4];

    const button = document.createElement("button");
    button.type = "button";
    button.className = "control-icon pkh-token-presets";
    button.dataset.tooltip = "토큰 이미지·크기 바꾸기";
    button.innerHTML = `<i class="fa-solid fa-images"></i>`;
    const palette = document.createElement("div");
    palette.className = "pkh-token-palette hidden";
    const current = shown(token.document);
    const width = token.document.width;
    palette.innerHTML = `
      <div class="imgs">${choices.map((c, i) => `
        <button type="button" data-i="${i}" class="${current === c.img ? "current" : ""}"
                data-tooltip="${esc(c.name || "")}${c.size ? ` · ${c.size}칸` : ""}"><img src="${esc(c.img)}" alt=""></button>`).join("")}</div>
      <div class="sizes">${sizes.map(n => `<button type="button" data-size="${n}" class="${width === n ? "current" : ""}">${n}</button>`).join("")}
        <span>칸</span></div>`;
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
        await token.document.update(update);
        // Combat tracker shows the same picture (as the old Disguise feature did).
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

/* ------------------------------------------------------------------------ */

export function registerToolkitSettings() {
  game.settings.register(MODULE_ID, "playersListMode", {
    name: "접속자 목록 표시", hint: "왼쪽 아래 접속자 목록이 초상화를 가리면 작은 아이콘으로 접어 두세요. 아이콘을 누르면 잠깐 펼쳐집니다.",
    scope: "client", config: true, type: String, default: "icon",
    choices: { normal: "그대로 보이기", icon: "작은 아이콘으로 접기" }, onChange: syncPlayersList
  });
  registerToolkitTab();
  registerTokenPresets();
}

export function initToolkit() {
  game.pf2eKrHud = { ...(game.pf2eKrHud ?? {}), openPortraitManager, openFaces };
  registerFaceKeywords();
  syncPlayersList();
  Hooks.on("userConnected", syncPlayersList);
}
