/* ==========================================================================
 * PF2e-KR HUD | Discord Voice Bridge (client side)  (v0.9.6)
 *
 * Foundry cannot observe Discord directly: a browser tab has no access to
 * another application's voice state. So, like other Discord integrations,
 * this relies on a small bot running elsewhere (see tools/discord-voice-bridge)
 * which sits in the voice channel and reports who starts and stops speaking.
 *
 * Only ONE client talks to that bot: the first active keeper. It maps the
 * Discord member to a Foundry user and re-broadcasts the result to every
 * client over Foundry's own module socket.
 *
 * Earlier versions had every client connect to the bot directly. That broke
 * local hosting: an address such as ws://127.0.0.1:8787 means the *host's*
 * machine only on the host — on a player's PC it points at the player's own
 * computer. With a single relay, players never need to reach the bot at all,
 * so no extra port forwarding, no mixed-content issues and no key on player
 * machines.
 *
 * The bot only ever receives Discord's "speaking" notifications. It never
 * subscribes to or decodes anyone's audio.
 * ========================================================================== */

const MODULE_ID = "pf2e-kr-hud";

let socket = null;
let retryDelay = 2000;

/*
 * Consecutive attempts that never managed to open. Once a bridge has been
 * unreachable this many times in a row the client stops trying instead of
 * logging a failed connection every half minute for the rest of the session.
 * "다시 연결" in the editor or the wizard starts over.
 */
let failedAttempts = 0;
const MAX_FAILED_ATTEMPTS = 5;

function isEnabled() {
  return !!setting("voiceBridgeEnabled", false);
}
let retryTimer = null;
let intentionalClose = false;
let userMap = new Map();

/*
 * The bot's voice channel is chosen here, not in the server's .env: tables
 * that run several Discord servers and rooms should not have to edit a file
 * and restart between sessions. The bridge sends the rooms it can see and its
 * current position; the keeper picks one, or tells it to leave.
 */
let voiceGuilds = [];
let voiceStatus = { joined: false, guildId: null, channelId: null, guildName: null, channelName: null };

function sendBridgeCommand(command) {
  if (socket?.readyState !== WebSocket.OPEN) {
    ui.notifications.warn("PF2e-KR HUD | 브리지에 연결되어 있지 않습니다.");
    return false;
  }
  socket.send(JSON.stringify(command));
  return true;
}

const RELAY_SOCKET = `module.${MODULE_ID}`;

/** The one keeper client responsible for talking to the bridge. */
function isRelayClient() {
  if (!game.user.isGM) return false;
  const first = game.users
    .filter(user => user.isGM && user.active)
    .sort((a, b) => a.id.localeCompare(b.id))[0];
  return first?.id === game.user.id;
}

function applyVoice(userId, speaking, slotKey = null) {
  // The relay resolves the stage slot itself (a keeper can see every actor)
  // and sends it along, so a player never has to look up a character they
  // may not have permission to see.
  if (slotKey && game.pf2eKrStage?.setSpeakingSlot) {
    game.pf2eKrStage.setSpeakingSlot(slotKey, speaking);
    return;
  }
  game.pf2eKrStage?.setSpeaking?.(userId, speaking);
}

function broadcastVoice(userId, speaking) {
  const slotKey = game.pf2eKrStage?.slotKeyForUser?.(userId) ?? null;
  applyVoice(userId, speaking, slotKey);
  game.socket.emit(RELAY_SOCKET, { action: "voice", userId, slotKey, speaking });
}

function broadcastClear() {
  game.pf2eKrStage?.clearSpeaking?.();
  game.socket.emit(RELAY_SOCKET, { action: "voiceClear" });
}

/** Discord ids heard recently, surfaced in the editor to help setup. */
const recentlyHeard = new Map();
let connectionState = "off";

function setting(key, fallback) {
  try {
    const value = game.settings.get(MODULE_ID, key);
    return value === undefined ? fallback : value;
  } catch (_) {
    return fallback;
  }
}

/* --- mapping --------------------------------------------------------------- */

/** Stored as [{ discordId, userId, note }]. */
function readMappings() {
  const stored = setting("voiceBridgeUsers", []);
  return Array.isArray(stored) ? stored.filter(row => row?.discordId && row?.userId) : [];
}

function rebuildUserMap() {
  userMap = new Map(readMappings().map(row => [String(row.discordId), row.userId]));
}

/**
 * One-time migration from the old "id=name, id=name" text field, so tables
 * that already set the bridge up keep working after the update.
 */
async function migrateLegacyMap() {
  if (!game.user.isGM) return;
  if (readMappings().length) return;

  const raw = String(setting("voiceBridgeMap", "")).trim();
  if (!raw) return;

  const rows = [];
  for (const pair of raw.split(/[,;\n]+/)) {
    const [discordId, ref] = pair.split("=").map(part => part?.trim());
    if (!discordId || !ref) continue;

    const user = game.users.get(ref) ?? game.users.find(u => u.name === ref);
    if (user) rows.push({ discordId, userId: user.id, note: "" });
  }

  if (!rows.length) return;

  await game.settings.set(MODULE_ID, "voiceBridgeUsers", rows);
  await game.settings.set(MODULE_ID, "voiceBridgeMap", "");
  console.log(`${MODULE_ID} | migrated ${rows.length} voice bridge mapping(s)`);
}

/* --- connection ------------------------------------------------------------ */

function setStatus(state) {
  connectionState = state;
  document.body.dataset.pkhVoice = state;
  PkhVoiceMappingApp.refreshOpen();
}

function disconnect() {
  const wasOpen = !!socket;
  intentionalClose = true;
  clearTimeout(retryTimer);
  socket?.close();
  socket = null;
  if (wasOpen && isRelayClient()) broadcastClear();
  setStatus("off");
}

/**
 * @param {object} [options]
 * @param {boolean} [options.manual]  A person asked for this attempt, so any
 *                                     earlier give-up is forgotten.
 */
function connect({ manual = false } = {}) {
  disconnect();
  intentionalClose = false;
  rebuildUserMap();

  if (manual) failedAttempts = 0;

  // Master switch: when voice is off, nothing connects, retries or logs.
  if (!isEnabled()) {
    setStatus("disabled");
    return;
  }

  // Players and secondary keepers only listen to the relay.
  if (!isRelayClient()) {
    setStatus(game.user.isGM ? "standby" : "off");
    return;
  }

  const url = String(setting("voiceBridgeUrl", "")).trim();
  if (!url) return;

  try {
    socket = new WebSocket(url);
  } catch (error) {
    console.error(`${MODULE_ID} | voice bridge: invalid URL`, url, error);
    setStatus("error");
    return;
  }

  setStatus("connecting");

  let opened = false;

  socket.addEventListener("open", () => {
    opened = true;
    retryDelay = 2000;
    failedAttempts = 0;
    setStatus("on");
    console.log(`${MODULE_ID} | voice bridge connected`, url);
  });

  socket.addEventListener("message", event => {
    let payload;
    try {
      payload = JSON.parse(event.data);
    } catch (_) {
      return;
    }

    if (payload?.type === "channels") {
      voiceGuilds = Array.isArray(payload.guilds) ? payload.guilds : [];
      PkhVoiceMappingApp.refreshOpen();
      return;
    }

    if (payload?.type === "status") {
      voiceStatus = payload;
      if (!payload.joined) game.pf2eKrStage?.clearSpeaking?.();
      PkhVoiceMappingApp.refreshOpen();
      return;
    }

    if (payload?.type === "error") {
      ui.notifications.warn(`PF2e-KR HUD | 브리지: ${payload.message}`);
      return;
    }

    if (payload?.type !== "speaking") return;

    const discordId = String(payload.discordId);
    const isSpeaking = !!payload.speaking;

    recentlyHeard.set(discordId, { speaking: isSpeaking, at: Date.now() });
    PkhVoiceMappingApp.refreshOpen();

    const userId = userMap.get(discordId);
    if (userId) broadcastVoice(userId, isSpeaking);
  });

  socket.addEventListener("close", () => {
    voiceStatus = { joined: false, guildId: null, channelId: null, guildName: null, channelName: null };
    socket = null;

    // A dropped bridge must not leave portraits lit on anyone's screen.
    broadcastClear();

    if (intentionalClose) {
      setStatus("off");
      return;
    }

    if (!opened) failedAttempts += 1;

    if (failedAttempts >= MAX_FAILED_ATTEMPTS) {
      setStatus("gaveup");
      console.warn(
        `${MODULE_ID} | voice bridge unreachable after ${failedAttempts} attempts; ` +
        "stopped retrying. Use 다시 연결 once the bridge is running."
      );
      return;
    }

    setStatus("retrying");
    retryTimer = setTimeout(() => connect(), retryDelay);
    retryDelay = Math.min(retryDelay * 2, 30000);
  });

  // Report only the first failure of a run; the browser already logs each
  // failed WebSocket on its own, so repeating it here was pure noise.
  socket.addEventListener("error", () => {
    if (failedAttempts === 0 && !opened) {
      console.warn(`${MODULE_ID} | voice bridge not reachable yet`, url.replace(/key=[^&]+/, "key=•••"));
    }
  });
}

/* --- mapping editor -------------------------------------------------------- */

const STATUS_TEXT = {
  off: ["fa-circle", "연결 안 됨", "off"],
  connecting: ["fa-circle-notch fa-spin", "연결 중...", "busy"],
  retrying: ["fa-rotate fa-spin", "재연결 대기 중...", "busy"],
  on: ["fa-circle", "연결됨", "on"],
  standby: ["fa-circle-pause", "대기 (다른 GM이 중계 중)", "off"],
  disabled: ["fa-power-off", "사용 안 함 (모듈 설정에서 켤 수 있습니다)", "off"],
  gaveup: ["fa-circle-stop", "브리지를 찾지 못해 재시도를 멈췄습니다", "error"],
  error: ["fa-triangle-exclamation", "주소 오류", "error"]
};

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, ch => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[ch]));
}

class PkhVoiceMappingApp extends foundry.applications.api.ApplicationV2 {
  static DEFAULT_OPTIONS = {
    id: "pkh-voice-mapping",
    tag: "section",
    window: {
      title: "디스코드 음성 연결",
      icon: "fa-brands fa-discord",
      resizable: true
    },
    position: { width: 560, height: 520 }
  };

  static instance = null;

  static refreshOpen() {
    const app = PkhVoiceMappingApp.instance;
    if (app?.rendered) app._refreshLive();
  }

  constructor(options) {
    super(options);
    this.rows = readMappings().map(row => ({ ...row }));
    PkhVoiceMappingApp.instance = this;
  }

  async _renderHTML() {
    const users = game.users.contents
      .slice()
      .sort((a, b) => Number(b.isGM) - Number(a.isGM) || a.name.localeCompare(b.name, game.i18n.lang));

    const userOptions = selected => users.map(user => `
      <option value="${user.id}" ${user.id === selected ? "selected" : ""}>
        ${escapeHtml(user.name)}${user.isGM ? " (GM)" : ""}
      </option>
    `).join("");

    const rows = this.rows.map((row, index) => `
      <div class="vmap-row" data-index="${index}" data-discord-id="${escapeHtml(row.discordId)}">
        <span class="vmap-live" title="말하는 중이면 초록색으로 켜집니다"></span>
        <select name="userId">
          <option value="">— Foundry 사용자 —</option>
          ${userOptions(row.userId)}
        </select>
        <input type="text" name="discordId" value="${escapeHtml(row.discordId)}"
               placeholder="디스코드 사용자 ID" inputmode="numeric">
        <input type="text" name="note" value="${escapeHtml(row.note ?? "")}"
               placeholder="메모 (선택)">
        <button type="button" data-action="remove" title="삭제">
          <i class="fa-solid fa-trash"></i>
        </button>
      </div>
    `).join("");

    return `
      <div class="pkh-vmap">
        <div class="vmap-status"></div>

        <div class="vmap-head">
          <span></span><span>Foundry 사용자</span><span>디스코드 ID</span><span>메모</span><span></span>
        </div>

        <div class="vmap-rows">
          ${rows || `<p class="hint vmap-empty">아직 연결된 사용자가 없습니다. 아래 버튼으로 추가하세요.</p>`}
        </div>

        <div class="vmap-actions">
          <button type="button" data-action="add"><i class="fa-solid fa-plus"></i> 사용자 추가</button>
        </div>

        <div class="vmap-heard">
          ${this._channelSection()}

          <h4>최근 음성 신호</h4>
          <p class="hint">
            브리지가 연결된 상태에서 음성 채널에 말해 보세요. 들린 디스코드 ID가 여기 나타나며,
            <b>+</b>를 누르면 바로 줄이 추가됩니다. ID를 직접 찾을 필요가 없습니다.
          </p>
          <div class="vmap-heard-list"></div>
        </div>

        <footer class="vmap-footer">
          <button type="button" data-action="reconnect"><i class="fa-solid fa-plug"></i> 다시 연결</button>
          <button type="button" data-action="save" class="primary"><i class="fa-solid fa-floppy-disk"></i> 저장</button>
        </footer>
      </div>
    `;
  }

  /** Room picker: where the bot listens, and whether it is in a room at all. */
  _channelSection() {
    if (!game.user.isGM) return "";

    // Remember what the keeper picked; a re-render must not snap it back to
    // the server the bot happens to be in right now.
    const guildId = this._pickedGuild ?? voiceStatus.guildId ?? voiceGuilds[0]?.id ?? "";
    const guild = voiceGuilds.find(item => item.id === guildId) ?? voiceGuilds[0];

    const guildOptions = voiceGuilds.map(item =>
      `<option value="${item.id}" ${item.id === guild?.id ? "selected" : ""}>${foundry.utils.escapeHTML(item.name)}</option>`
    ).join("");

    const channelOptions = (guild?.channels ?? []).map(channel =>
      `<option value="${channel.id}" ${channel.id === voiceStatus.channelId ? "selected" : ""}>${foundry.utils.escapeHTML(channel.name)}</option>`
    ).join("");

    const where = voiceStatus.joined
      ? `<b>${foundry.utils.escapeHTML(voiceStatus.guildName ?? "")} / ${foundry.utils.escapeHTML(voiceStatus.channelName ?? "")}</b> 에서 듣는 중`
      : "지금은 어느 음성 채널에도 들어가 있지 않습니다.";

    return `
      <h4>음성 채널</h4>
      <p class="hint">${where}</p>

      ${voiceGuilds.length ? `
        <div class="vmap-channel">
          <select name="guildId">${guildOptions}</select>
          <select name="channelId">${channelOptions}</select>
        </div>
        <div class="vmap-channel-actions">
          <button type="button" data-action="joinVoice" class="primary">
            <i class="fa-solid fa-headphones"></i> ${voiceStatus.joined ? "이 방으로 옮기기" : "이 방에서 듣기"}
          </button>
          <button type="button" data-action="leaveVoice" ${voiceStatus.joined ? "" : "disabled"}>
            <i class="fa-solid fa-right-from-bracket"></i> 나가기
          </button>
          <button type="button" data-action="refreshChannels" title="채널 목록 새로 고침">
            <i class="fa-solid fa-rotate"></i>
          </button>
        </div>
        <p class="hint">
          세션을 안 할 때는 <b>나가기</b>를 눌러 두세요. 봇이 음성 채널에서 빠지고, 다음에 다시
          누르면 그 자리로 돌아옵니다. 서버에서 프로그램을 껐다 켤 필요가 없습니다.
        </p>
      ` : `<p class="hint">연결되면 봇이 볼 수 있는 음성 채널 목록이 여기 나타납니다.</p>`}
    `;
  }

  async _replaceHTML(result, content) {
    content.innerHTML = result;

    /*
     * The window's content element survives re-renders; only its innerHTML
     * is replaced. Adding the click handler on every render stacked up one
     * more handler each time, so a single click ran several times — which
     * made the wizard skip steps and jump back to the start. Bind it once.
     */
    if (content.dataset.pkhBound === "1") {
      this._afterRender?.(content);
      return;
    }
    content.dataset.pkhBound = "1";

    content.addEventListener("click", async event => {
      const button = event.target.closest("[data-action]");
      if (!button) return;

      const action = button.dataset.action;

      if (action === "add") {
        this._collect(content);
        this.rows.push({ discordId: "", userId: "", note: "" });
        return this.render();
      }

      if (action === "remove") {
        this._collect(content);
        const index = Number(button.closest(".vmap-row")?.dataset.index);
        this.rows.splice(index, 1);
        return this.render();
      }

      if (action === "adopt") {
        this._collect(content);
        const discordId = button.dataset.discordId;
        if (!this.rows.some(row => row.discordId === discordId)) {
          this.rows.push({ discordId, userId: "", note: "" });
        }
        return this.render();
      }

      if (action === "reconnect") return connect({ manual: true });

      if (action === "refreshChannels") return sendBridgeCommand({ type: "listChannels" });

      if (action === "joinVoice") {
        const guildId = content.querySelector("select[name='guildId']")?.value;
        const channelId = content.querySelector("select[name='channelId']")?.value;
        if (!guildId || !channelId) return ui.notifications.warn("PF2e-KR HUD | 음성 채널을 고르세요.");
        return sendBridgeCommand({ type: "join", guildId, channelId });
      }

      if (action === "leaveVoice") return sendBridgeCommand({ type: "leave" });

      if (action === "save") return this._save(content);
    });

    content.querySelector("select[name='guildId']")?.addEventListener("change", event => {
      this._pickedGuild = event.target.value;
      this.render();
    });

    this._afterRender(content);
  }

  /** Work that must happen on every render, not only the first. */
  _afterRender() {
    this._refreshLive();
  }

  /** Reads the current form values back into this.rows. */
  _collect(content) {
    this.rows = [...content.querySelectorAll(".vmap-row")].map(row => ({
      userId: row.querySelector("[name='userId']")?.value ?? "",
      discordId: (row.querySelector("[name='discordId']")?.value ?? "").trim(),
      note: (row.querySelector("[name='note']")?.value ?? "").trim()
    }));
  }

  async _save(content) {
    this._collect(content);

    const complete = this.rows.filter(row => row.discordId && row.userId);
    const incomplete = this.rows.length - complete.length;

    const invalid = complete.filter(row => !/^\d{15,21}$/.test(row.discordId));
    if (invalid.length) {
      return ui.notifications.warn(
        `PF2e-KR HUD | 디스코드 ID는 15~21자리 숫자입니다: ${invalid.map(r => r.discordId).join(", ")}`
      );
    }

    const duplicates = complete
      .map(row => row.discordId)
      .filter((id, index, all) => all.indexOf(id) !== index);
    if (duplicates.length) {
      return ui.notifications.warn(`PF2e-KR HUD | 같은 디스코드 ID가 두 번 들어 있습니다: ${[...new Set(duplicates)].join(", ")}`);
    }

    await game.settings.set(MODULE_ID, "voiceBridgeUsers", complete);
    rebuildUserMap();

    ui.notifications.info(
      incomplete
        ? `PF2e-KR HUD | ${complete.length}명 저장했습니다. 칸이 비어 있는 ${incomplete}줄은 제외했습니다.`
        : `PF2e-KR HUD | ${complete.length}명 저장했습니다.`
    );

    this.rows = complete.map(row => ({ ...row }));
    this.render();
  }

  /** Updates the status line, live dots and heard list without a re-render. */
  _refreshLive() {
    const content = this.element?.querySelector(".pkh-vmap");
    if (!content) return;

    const [icon, label, cls] = STATUS_TEXT[connectionState] ?? STATUS_TEXT.off;
    const url = String(setting("voiceBridgeUrl", "")).trim();

    content.querySelector(".vmap-status").innerHTML = `
      <span class="vmap-state ${cls}"><i class="fa-solid ${icon}"></i> ${label}</span>
      <span class="vmap-url">${url ? escapeHtml(url.replace(/key=[^&]+/, "key=•••")) : "브리지 주소가 설정되지 않았습니다 (모듈 설정)"}</span>
    `;

    const now = Date.now();

    for (const row of content.querySelectorAll(".vmap-row")) {
      const heard = recentlyHeard.get(row.dataset.discordId);
      row.classList.toggle("speaking", !!heard?.speaking && now - heard.at < 8000);
    }

    const mapped = new Set(this.rows.map(row => row.discordId));
    const heardRows = [...recentlyHeard.entries()]
      .sort((a, b) => b[1].at - a[1].at)
      .slice(0, 12)
      .map(([discordId, info]) => {
        const userId = userMap.get(discordId);
        const who = userId ? game.users.get(userId)?.name : null;
        const live = info.speaking && now - info.at < 8000;

        return `
          <div class="vmap-heard-row ${live ? "speaking" : ""}">
            <span class="vmap-live"></span>
            <code>${escapeHtml(discordId)}</code>
            <span class="who">${who ? `→ ${escapeHtml(who)}` : "<i>연결 안 됨</i>"}</span>
            ${mapped.has(discordId) ? "" : `
              <button type="button" data-action="adopt" data-discord-id="${escapeHtml(discordId)}" title="이 ID로 줄 추가">
                <i class="fa-solid fa-plus"></i>
              </button>`}
          </div>
        `;
      }).join("");

    content.querySelector(".vmap-heard-list").innerHTML =
      heardRows || `<p class="hint">아직 들어온 신호가 없습니다.</p>`;
  }

  _onClose(options) {
    super._onClose?.(options);
    if (PkhVoiceMappingApp.instance === this) PkhVoiceMappingApp.instance = null;
  }
}

/* --- registration ---------------------------------------------------------- */

Hooks.once("init", () => {
  game.settings.register(MODULE_ID, "voiceBridgeEnabled", {
    name: "디스코드 음성 연동 사용",
    hint: "끄면 브리지에 전혀 접속하지 않으며, 접속 실패 로그도 남지 않습니다. 디스코드 연동을 쓰지 않는 테이블은 꺼 두세요. 설정 도우미에서 연결하면 자동으로 켜집니다.",
    scope: "world",
    config: true,
    type: Boolean,
    default: false,
    onChange: () => connect({ manual: true })
  });

  game.settings.register(MODULE_ID, "voiceBridgeUrl", {
    name: "디스코드 음성 브리지 주소",
    hint: "브리지 봇 주소입니다. GM 한 명만 접속해 모두에게 중계하므로 플레이어는 이 주소에 닿을 필요가 없습니다. 설정 도우미를 쓰면 자동으로 채워집니다.",
    scope: "world",
    config: true,
    type: String,
    default: "",
    onChange: () => connect({ manual: true })
  });

  game.settings.registerMenu(MODULE_ID, "voiceBridgeMenu", {
    name: "디스코드 ↔ Foundry 사용자 연결",
    label: "연결 관리",
    hint: "디스코드 사용자와 Foundry 사용자를 한 명씩 연결합니다. 연결 상태와 최근 음성 신호도 여기서 확인할 수 있습니다.",
    icon: "fa-brands fa-discord",
    type: PkhVoiceMappingApp,
    restricted: true
  });

  game.settings.register(MODULE_ID, "voiceBridgeUsers", {
    name: "Voice Bridge Users",
    scope: "world",
    config: false,
    type: Array,
    default: [],
    onChange: () => rebuildUserMap()
  });

  // Kept only so older tables can be migrated to the list above.
  game.settings.register(MODULE_ID, "voiceBridgeMap", {
    name: "Voice Bridge Map (legacy)",
    scope: "world",
    config: false,
    type: String,
    default: ""
  });

  game.pf2eKrVoiceBridge = {
    connect: () => connect({ manual: true }),
    disconnect,
    openMapping: () => new PkhVoiceMappingApp().render({ force: true }),
    get state() {
      return connectionState;
    }
  };
});

Hooks.once("ready", async () => {
  // Every client listens; only the relay keeper ever sends.
  game.socket.on(RELAY_SOCKET, payload => {
    if (payload?.action === "voice") applyVoice(payload.userId, !!payload.speaking, payload.slotKey);
    if (payload?.action === "voiceClear") game.pf2eKrStage?.clearSpeaking?.();
  });

  await migrateLegacyMap();
  connect();
});

/*
 * If the relay keeper logs out, the next keeper takes over; if a keeper logs
 * in who sorts first, the relay moves to them. Re-evaluate on any change.
 */
Hooks.on("userConnected", () => {
  if (!game.user.isGM || !isEnabled()) return;
  const shouldRelay = isRelayClient();
  const isRelaying = !!socket;
  if (shouldRelay !== isRelaying) connect();
});
