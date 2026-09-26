/* ==========================================================================
 * PF2e-KR HUD | Side Panels  (v0.9.1)
 *
 * The 귓속말 / 노트 tabs used to be injected into the chat sidebar. That
 * approach kept breaking: Foundry re-renders the sidebar on its own schedule
 * and the injected elements were repositioned or detached, so clicks landed
 * only intermittently.
 *
 * These panels are therefore free-floating windows appended to <body> and
 * positioned with `fixed`, exactly like the scene quickbar. They never touch
 * the sidebar DOM, so nothing Foundry does to the sidebar can disturb them.
 * ========================================================================== */

const MODULE_ID = "pf2e-kr-hud";

const PANEL_DEFAULTS = {
  whisper: { left: 120, top: 140, width: 400, height: 460 },
  rolls: { left: 120, top: 630, width: 380, height: 320 },
  notes: { left: 560, top: 140, width: 420, height: 480 }
};

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, ch => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  }[ch]));
}

function setting(key, fallback) {
  try {
    const value = game.settings.get(MODULE_ID, key);
    return value === undefined ? fallback : value;
  } catch (_) {
    return fallback;
  }
}

/** Shared chrome: drag by the header, resize from the bottom-right grip. */
class PkhPanel {
  constructor(key, { id, title, icon }) {
    this.key = key;
    this.id = id;
    this.title = title;
    this.icon = icon;

    this.element = null;
    this._drag = null;
    this._onPointerMove = this._onPointerMove.bind(this);
    this._onPointerUp = this._onPointerUp.bind(this);
    this._saveTimer = null;
  }

  get open() {
    return !!this.element?.isConnected;
  }

  placement() {
    const stored = setting("panelPlacement", {})?.[this.key];
    return foundry.utils.mergeObject(
      foundry.utils.deepClone(PANEL_DEFAULTS[this.key]),
      stored ?? {},
      { inplace: false }
    );
  }

  toggle() {
    if (this.open) return this.close();
    return this.render();
  }

  close() {
    this.element?.remove();
    this.element = null;
    this._setVisible(false);
  }

  _setVisible(visible) {
    const state = { ...(setting("panelVisible", {}) ?? {}) };
    state[this.key] = visible;
    game.settings.set(MODULE_ID, "panelVisible", state);
  }

  ensureElement() {
    if (this.element?.isConnected) return this.element;

    const el = document.createElement("section");
    el.id = this.id;
    el.classList.add("pkh-floating-panel", "pkh-side-panel");

    const placement = this.placement();
    Object.assign(el.style, {
      left: `${placement.left}px`,
      top: `${placement.top}px`,
      width: `${placement.width}px`,
      height: `${placement.height}px`
    });

    document.body.append(el);
    el.addEventListener("pointerdown", this._onPointerDown.bind(this));
    el.addEventListener("click", this._onClick.bind(this));

    this.element = el;
    return el;
  }

  render() {
    const el = this.ensureElement();

    el.innerHTML = `
      <header class="panel-header" data-drag-handle>
        <i class="${this.icon}"></i>
        <span class="panel-title">${escapeHtml(this.title)}</span>
        ${this._headerButtons()}
        <button type="button" class="panel-btn" data-action="close" title="닫기">
          <i class="fa-solid fa-xmark"></i>
        </button>
      </header>
      <div class="panel-body">${this._body()}</div>
      <div class="panel-grip" data-resize-handle title="크기 조정"></div>
    `;

    this._activate(el);
    this._clampIntoView();
    this._setVisible(true);
    return el;
  }

  refresh() {
    if (this.open) this.render();
  }

  /*
   * Replace only the scrolling list, leaving the input box untouched.
   *
   * New messages used to trigger a full re-render, which rebuilt the text
   * box the person was typing in: their text reverted to the last saved
   * draft and the cursor was lost. With several people writing at once,
   * everyone kept knocking everyone else out of the box.
   */
  refreshList(selector) {
    if (!this.open) return;

    const current = this.element.querySelector(selector);
    if (!current) return this.render();

    const holder = document.createElement("div");
    holder.innerHTML = this._body();
    const fresh = holder.querySelector(selector);
    if (!fresh) return;

    // Stay pinned to the newest line only if the reader was already there.
    const atBottom = current.scrollHeight - current.scrollTop - current.clientHeight < 40;
    const previousTop = current.scrollTop;

    current.replaceWith(fresh);
    this._bindList?.(this.element);
    fresh.scrollTop = atBottom ? fresh.scrollHeight : previousTop;
  }

  _headerButtons() {
    return "";
  }

  _body() {
    return "";
  }

  _activate() {}

  async _onClick(event) {
    const button = event.target.closest("[data-action]");
    if (!button) return;

    event.preventDefault();
    if (button.dataset.action === "close") return this.close();

    return this._onAction(button.dataset.action, button, event);
  }

  async _onAction() {}

  /* --- drag / resize ---------------------------------------------------- */

  _onPointerDown(event) {
    if (event.button !== 0) return;

    const resizeHandle = event.target.closest("[data-resize-handle]");
    const dragHandle = event.target.closest("[data-drag-handle]");
    if (!resizeHandle && !dragHandle) return;
    if (event.target.closest("[data-action]")) return;

    const rect = this.element.getBoundingClientRect();
    event.preventDefault();

    this._drag = {
      mode: resizeHandle ? "resize" : "move",
      startX: event.clientX,
      startY: event.clientY,
      startLeft: rect.left,
      startTop: rect.top,
      startWidth: rect.width,
      startHeight: rect.height
    };

    this.element.classList.add("dragging");
    window.addEventListener("pointermove", this._onPointerMove);
    window.addEventListener("pointerup", this._onPointerUp);
  }

  _onPointerMove(event) {
    const drag = this._drag;
    if (!drag) return;

    const dx = event.clientX - drag.startX;
    const dy = event.clientY - drag.startY;

    if (drag.mode === "resize") {
      this.element.style.width = `${Math.max(280, drag.startWidth + dx)}px`;
      this.element.style.height = `${Math.max(200, drag.startHeight + dy)}px`;
      return;
    }

    this.element.style.left = `${Math.max(0, drag.startLeft + dx)}px`;
    this.element.style.top = `${Math.max(0, drag.startTop + dy)}px`;
  }

  _onPointerUp() {
    window.removeEventListener("pointermove", this._onPointerMove);
    window.removeEventListener("pointerup", this._onPointerUp);
    if (!this._drag) return;

    this._drag = null;
    this.element?.classList.remove("dragging");
    this._clampIntoView();
    this._savePlacement();
  }

  _clampIntoView() {
    if (!this.element) return;
    const rect = this.element.getBoundingClientRect();

    this.element.style.left = `${Math.round(Math.clamp(rect.left, 0, Math.max(0, window.innerWidth - 100)))}px`;
    this.element.style.top = `${Math.round(Math.clamp(rect.top, 0, Math.max(0, window.innerHeight - 60)))}px`;
  }

  _savePlacement() {
    if (!this.element) return;
    const rect = this.element.getBoundingClientRect();

    clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => {
      const all = { ...(setting("panelPlacement", {}) ?? {}) };
      all[this.key] = {
        left: Math.round(rect.left),
        top: Math.round(rect.top),
        width: Math.round(rect.width),
        height: Math.round(rect.height)
      };
      game.settings.set(MODULE_ID, "panelPlacement", all);
    }, 150);
  }
}

/* --- 귓속말 --------------------------------------------------------------- *
 *
 * A tab per conversation partner, so the keeper can hold several private
 * threads at once without retyping /w every time.
 *
 * Who a player may talk to here is a world setting:
 *   "gm"  — players may only whisper the keeper through this panel (default)
 *   "all" — players may whisper each other as well
 * Typing /w by hand is untouched either way; this only governs the panel.
 * ------------------------------------------------------------------------ */

class PkhWhisperPanel extends PkhPanel {
  constructor() {
    super("whisper", {
      id: "pkh-whisper-panel",
      title: "귓속말",
      icon: "fa-solid fa-user-secret"
    });
    this.activeTarget = "all";
    this.showOffline = false;
  }

  /** Users this client may start a whisper thread with, in tab order. */
  partners() {
    const others = game.users.contents.filter(user => user.id !== game.user.id);

    // GM: only players who are connected right now, unless "접속 안 함 포함" is on.
    // An open thread stays listed even if that player drops out.
    if (game.user.isGM) {
      return others
        .filter(user => user.active || this.showOffline || user.id === this.activeTarget)
        .sort((a, b) => Number(b.isGM) - Number(a.isGM) || Number(b.active) - Number(a.active));
    }

    const allowPlayerToPlayer = setting("whisperPolicy", "gm") !== "gm";
    return others
      .filter(user => user.isGM || allowPlayerToPlayer)
      .sort((a, b) => Number(b.isGM) - Number(a.isGM));
  }

  /** Whispers visible to this client, optionally narrowed to one partner. */
  _messages(partnerId = null) {
    const allowPlayerToPlayer =
      game.user.isGM || setting("whisperPolicy", "gm") !== "gm";

    return game.messages.contents
      .filter(message => {
        const whisper = message.whisper ?? [];
        if (!whisper.length || !message.visible) return false;

        const author = message.author ?? message.user;
        const involved = new Set([author?.id, ...whisper].filter(Boolean));

        if (!allowPlayerToPlayer) {
          const hasGm = [...involved].some(id => game.users.get(id)?.isGM);
          if (!hasGm) return false;
        }

        if (!partnerId) return true;
        return involved.has(partnerId) && involved.has(game.user.id);
      })
      .slice(-80);
  }

  _headerButtons() {
    const offline = game.user.isGM ? `
      <button type="button" class="panel-btn ${this.showOffline ? "active" : ""}" data-action="offline"
              title="${this.showOffline ? "접속 중인 플레이어만 보기" : "접속하지 않은 플레이어도 보기 (지난 대화 확인)"}">
        <i class="fa-solid ${this.showOffline ? "fa-user-check" : "fa-user-clock"}"></i>
      </button>` : "";
    return `${offline}
      <button type="button" class="panel-btn" data-action="refresh" title="새로고침">
        <i class="fa-solid fa-rotate"></i>
      </button>
    `;
  }

  _body() {
    const partners = this.partners();

    const tabs = [
      `<button type="button" class="wtab ${this.activeTarget === "all" ? "active" : ""}"
               data-action="tab" data-target="all">전체</button>`,
      ...partners.map(user => `
        <button type="button"
                class="wtab ${this.activeTarget === user.id ? "active" : ""} ${user.active ? "" : "offline"}"
                data-action="tab" data-target="${user.id}"
                title="${escapeHtml(user.name)}">
          <span class="dot" style="background:${user.color?.css ?? user.color ?? "#888"}"></span>
          ${escapeHtml(user.name)}${user.isGM ? " (GM)" : ""}
        </button>
      `)
    ].join("");

    const partnerId = this.activeTarget === "all" ? null : this.activeTarget;
    const messages = this._messages(partnerId);

    const rows = messages.length
      ? messages.map(message => {
          const author = message.author ?? message.user;
          const alias = message.speaker?.alias || author?.name || "";
          const targets = (message.whisper ?? []).filter(id => id !== (message.author ?? message.user)?.id)
            .map(id => game.users.get(id)?.name)
            .filter(Boolean)
            .join(", ");

          const div = document.createElement("div");
          div.innerHTML = message.content ?? "";
          const text = (div.textContent ?? "").replace(/\s+/g, " ").trim();

          const mine = author?.id === game.user.id;

          return `
            <article class="whisper-row ${mine ? "mine" : ""}">
              <div class="whisper-meta">
                <strong>${escapeHtml(alias)}</strong>
                <span class="arrow"><i class="fa-solid fa-arrow-right"></i></span>
                <span>${escapeHtml(targets || "?")}</span>
                <time>${new Date(message.timestamp).toLocaleTimeString(game.i18n.lang)}</time>
              </div>
              <div class="whisper-text">${escapeHtml(text) || "<i>(내용 없음)</i>"}</div>
            </article>
          `;
        }).join("")
      : `<p class="hint">주고받은 귓속말이 없습니다.</p>`;

    const canSend = this.activeTarget !== "all";
    const targetName = canSend ? game.users.get(this.activeTarget)?.name ?? "" : "";

    const compose = canSend
      ? `<div class="whisper-compose">
           <input type="text" class="whisper-input"
                  placeholder="${escapeHtml(targetName)}에게 귓속말... (Enter로 전송)">
         </div>`
      : `<p class="hint compose-hint">탭에서 상대를 고르면 바로 귓속말을 보낼 수 있습니다.</p>`;

    return `
      <nav class="whisper-tabs">${tabs}</nav>
      <div class="whisper-list">${rows}</div>
      ${compose}
    `;
  }

  _activate(el) {
    const list = el.querySelector(".whisper-list");
    if (list) list.scrollTop = list.scrollHeight;

    el.querySelector(".whisper-input")?.addEventListener("keydown", async event => {
      if (event.key !== "Enter" || event.shiftKey) return;
      event.preventDefault();

      const input = event.currentTarget;
      const content = input.value.trim();
      if (!content || this.activeTarget === "all") return;

      await ChatMessage.implementation.create({
        content,
        // The sender must be a recipient too: leaving them out meant the
        // message never reached their own client, so they could not see
        // what they had sent. Their name is hidden from the "To:" line
        // instead (see renderChatMessageHTML in chat-enhancements.js).
        whisper: [...new Set([game.user.id, this.activeTarget])]
      });

      input.value = "";
    });
  }

  async _onAction(action, button) {
    if (action === "refresh") return this.refresh();
    if (action === "offline") {
      this.showOffline = !this.showOffline;
      return this.refresh();
    }

    if (action === "tab") {
      this.activeTarget = button.dataset.target;
      this.refresh();
      this.element?.querySelector(".whisper-input")?.focus();
    }
  }
}

/* --- 노트 ----------------------------------------------------------------- *
 *
 * Shared, editable, and backed by ChatMessage documents carrying a module
 * flag — exactly like the whisper panel reads ordinary whispers.
 *
 * The previous version kept notes in a world setting, which only a keeper's
 * client may write; a player's entry had to be relayed over a socket and
 * applied by the keeper. That relay failed silently in play. Chat messages
 * need no relay: every player may create one, and Foundry already lets an
 * author update or delete their own, with the keeper able to edit any of
 * them. The permission model we wanted comes for free.
 *
 * These messages are flagged so the chat log hides them; the panel is where
 * they are read.
 * ------------------------------------------------------------------------ */

const NOTE_FLAG = "note";

function noteMessages() {
  return game.messages.contents
    .filter(message => message.getFlag(MODULE_ID, NOTE_FLAG))
    .slice(-200);
}

class PkhNotesPanel extends PkhPanel {
  constructor() {
    super("notes", {
      id: "pkh-notes-panel-window",
      title: "노트 (공유)",
      icon: "fa-solid fa-book"
    });
    this._draftTimer = null;
  }

  _headerButtons() {
    return `
      <button type="button" class="panel-btn" data-action="export" title="저널 항목으로 내보내기">
        <i class="fa-solid fa-file-export"></i>
      </button>
      <button type="button" class="panel-btn" data-action="copy" title="전체 복사">
        <i class="fa-solid fa-copy"></i>
      </button>
    `;
  }

  _plainText(message) {
    const div = document.createElement("div");
    div.innerHTML = message.content ?? "";
    return (div.textContent ?? "").trim();
  }

  _body() {
    const entries = noteMessages();
    const draft = game.user.getFlag(MODULE_ID, "noteDraft") ?? "";

    const rows = entries.length
      ? entries.map(message => {
          const author = message.author ?? message.user;
          const editable = message.isAuthor || game.user.isGM;

          return `
            <article class="note-row ${author?.id === game.user.id ? "mine" : ""}"
                     data-message-id="${message.id}">
              <div class="note-meta">
                <strong>${escapeHtml(author?.name ?? "?")}</strong>
                <time>${new Date(message.timestamp).toLocaleString(game.i18n.lang)}</time>
                ${editable ? `<span class="editable" title="우클릭하여 수정"><i class="fa-solid fa-pen"></i></span>` : ""}
              </div>
              <div class="note-text">${escapeHtml(this._plainText(message))}</div>
            </article>
          `;
        }).join("")
      : `<p class="hint">아직 기록이 없습니다. 아래에 입력하고 Enter를 누르세요.</p>`;

    return `
      <div class="note-list">${rows}</div>
      <div class="note-compose">
        <textarea class="note-input"
                  placeholder="모두가 함께 보는 기록장입니다. Enter로 등록, Shift+Enter로 줄바꿈. 내 기록은 우클릭으로 수정·삭제할 수 있습니다.">${escapeHtml(draft)}</textarea>
        <span class="note-status"></span>
      </div>
    `;
  }

  _activate(el) {
    const list = el.querySelector(".note-list");
    if (list) list.scrollTop = list.scrollHeight;

    const input = el.querySelector(".note-input");
    const status = el.querySelector(".note-status");

    // The unsent draft survives a reload; failure here is never fatal.
    input?.addEventListener("input", () => {
      status.textContent = "임시 저장 중...";
      clearTimeout(this._draftTimer);
      this._draftTimer = setTimeout(async () => {
        try {
          await game.user.setFlag(MODULE_ID, "noteDraft", input.value);
          status.textContent = "임시 저장됨";
        } catch (error) {
          console.warn(`${MODULE_ID} | could not save note draft`, error);
          status.textContent = "";
        }
      }, 600);
    });

    input?.addEventListener("keydown", async event => {
      if (event.key !== "Enter" || event.shiftKey) return;
      event.preventDefault();

      const text = input.value.trim();
      if (!text) return;

      input.value = "";
      status.textContent = "";

      try {
        await ChatMessage.implementation.create({
          content: foundry.utils.escapeHTML(text).replace(/\n/g, "<br>"),
          flags: { [MODULE_ID]: { [NOTE_FLAG]: true } }
        });
      } catch (error) {
        console.error(`${MODULE_ID} | note create failed`, error);
        input.value = text;
        ui.notifications.error("PF2e-KR HUD | 노트를 등록하지 못했습니다.");
        return;
      }

      try {
        await game.user.unsetFlag(MODULE_ID, "noteDraft");
      } catch (_) {}
    });

    this._bindList(el);
  }

  _bindList(el) {
    el.querySelectorAll(".note-row").forEach(row => {
      row.addEventListener("contextmenu", event => {
        event.preventDefault();
        this._editEntry(row.dataset.messageId);
      });
    });
  }

  async _editEntry(id) {
    const message = game.messages.get(id);
    if (!message) return;

    if (!message.isAuthor && !game.user.isGM) {
      return ui.notifications.warn("PF2e-KR HUD | 다른 사람의 기록은 GM만 수정할 수 있습니다.");
    }

    const result = await foundry.applications.api.DialogV2.wait({
      window: { title: "노트 수정", icon: "fa-solid fa-pen" },
      position: { width: 460 },
      content: `<textarea name="text" style="width:100%;height:160px;">${escapeHtml(this._plainText(message))}</textarea>`,
      buttons: [
        {
          action: "save",
          label: "저장",
          default: true,
          callback: (event, button, dialog) => {
            const root = dialog?.element ?? button?.form ?? button?.closest("dialog");
            return { type: "edit", text: root?.querySelector("[name='text']")?.value ?? "" };
          }
        },
        { action: "delete", label: "삭제", callback: () => ({ type: "delete" }) },
        { action: "cancel", label: "취소" }
      ]
    });

    if (!result || result === "cancel") return;

    try {
      if (result.type === "delete") await message.delete();
      else if (result.text.trim()) {
        await message.update({
          content: foundry.utils.escapeHTML(result.text).replace(/\n/g, "<br>")
        });
      }
    } catch (error) {
      console.error(`${MODULE_ID} | note edit failed`, error);
      ui.notifications.error("PF2e-KR HUD | 노트를 수정하지 못했습니다.");
    }
  }

  async _onAction(action) {
    const entries = noteMessages();
    const lines = entries.map(message => {
      const author = message.author ?? message.user;
      const time = new Date(message.timestamp).toLocaleString(game.i18n.lang);
      return `[${time}] ${author?.name ?? "?"}: ${this._plainText(message)}`;
    });

    if (action === "copy") {
      await navigator.clipboard?.writeText(lines.join("\n"));
      return ui.notifications.info("PF2e-KR HUD | 노트를 클립보드에 복사했습니다.");
    }

    if (action === "export") {
      if (!game.user.can("JOURNAL_CREATE")) {
        return ui.notifications.warn("PF2e-KR HUD | 저널을 생성할 권한이 없습니다.");
      }

      const paragraphs = entries.map(message => {
        const author = message.author ?? message.user;
        return `<p><strong>${escapeHtml(author?.name ?? "?")}</strong> — ${escapeHtml(this._plainText(message))}</p>`;
      }).join("");

      const journal = await JournalEntry.create({
        name: `공유 노트 (${new Date().toLocaleString(game.i18n.lang)})`,
        pages: [{ name: "노트", type: "text", text: { content: paragraphs } }]
      });

      journal?.sheet?.render(true);
    }
  }
}

const panels = {
  whisper: new PkhWhisperPanel(),
  notes: new PkhNotesPanel()
};

Hooks.once("init", () => {

  game.settings.register(MODULE_ID, "whisperPolicy", {
    name: "귓속말 범위",
    hint: "플레이어가 누구에게 귓속말할 수 있는지, GM이 플레이어끼리의 귓속말을 보는지 정합니다. '/w'로 직접 입력한 귓속말에도 똑같이 적용됩니다.",
    scope: "world",
    config: true,
    type: String,
    choices: {
      gm: "GM하고만 (기본)",
      allGmSees: "플레이어끼리도 가능 — GM이 항상 함께 봄",
      all: "플레이어끼리도 가능 — GM 없이"
    },
    default: "gm",
    onChange: () => panels.whisper.refresh()
  });


  game.settings.register(MODULE_ID, "panelPlacement", {
    name: "Side Panel Placement",
    scope: "client",
    config: false,
    type: Object,
    default: {}
  });

  game.settings.register(MODULE_ID, "panelVisible", {
    name: "Side Panel Visibility",
    scope: "client",
    config: false,
    type: Object,
    default: {}
  });

  game.pkhPanels = {
    whisper: () => panels.whisper.toggle(),
    notes: () => panels.notes.toggle()
  };
});

Hooks.once("ready", () => {
  const visible = setting("panelVisible", {}) ?? {};
  if (visible.whisper) panels.whisper.render();
  if (visible.notes) panels.notes.render();
});

// Keep the whisper list current without touching the sidebar.
Hooks.on("createChatMessage", message => {
  if (!panels.whisper.open) return;
  if (!(message.whisper ?? []).length) return;
  panels.whisper.refreshList(".whisper-list");
});

Hooks.on("deleteChatMessage", () => {
  if (panels.whisper.open) panels.whisper.refreshList(".whisper-list");
  if (panels.notes.open) panels.notes.refreshList(".note-list");
});

// Notes are chat messages, so the panel follows the same document events.
Hooks.on("createChatMessage", message => {
  if (panels.notes.open && message.getFlag(MODULE_ID, NOTE_FLAG)) panels.notes.refreshList(".note-list");
});

Hooks.on("updateChatMessage", message => {
  if (panels.notes.open && message.getFlag(MODULE_ID, NOTE_FLAG)) panels.notes.refreshList(".note-list");
});

/* --- GM의 귓속말 열람 --------------------------------------------------- *
 *
 * Foundry gives keepers no special right to read whispers: a whisper between
 * two players is invisible to the keeper unless the keeper is a recipient.
 * With this setting on, keepers are added as recipients when a player
 * whispers another player — the same thing the "GM Always See Whispers"
 * approach does. It is deliberately visible: players see the keeper in the
 * recipient list, so nothing is read behind their backs.
 *
 * Handled on the author's own client, before the message is created, so it
 * covers /w typed in chat, the whisper panel and whispers from other modules.
 * ------------------------------------------------------------------------ */
Hooks.on("preCreateChatMessage", (message, data, options, userId) => {
  if (userId !== game.user.id) return;
  // "all" = players may whisper each other privately; the other two modes copy the GM in.
  if (setting("whisperPolicy", "gm") === "all") return;

  const author = game.users.get(userId);
  if (!author || author.isGM) return;

  const whisper = Array.from(message.whisper ?? data.whisper ?? []);
  if (!whisper.length) return;

  // A whisper only to oneself (e.g. a self roll) is left private.
  if (!whisper.some(id => id !== userId)) return;

  // Already includes a keeper: nothing to do.
  if (whisper.some(id => game.users.get(id)?.isGM)) return;

  const keepers = game.users.filter(user => user.isGM).map(user => user.id);
  if (!keepers.length) return;

  message.updateSource({ whisper: [...new Set([...whisper, ...keepers])] });
});
