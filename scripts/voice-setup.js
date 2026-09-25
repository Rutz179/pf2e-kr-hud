/* ==========================================================================
 * PF2e-KR HUD | Discord Voice Setup Wizard  (v0.9.7)
 *
 * Walks a keeper through connecting the voice bridge without touching a
 * terminal more than necessary.
 *
 *   Local host (Windows)  → downloads a ready-made .bat to double-click
 *   Oracle server         → one block to paste into SSH (pm2) plus the
 *                           Caddy snippet
 *
 * The bot token is used only to fill in those generated files. It is never
 * written to a world setting: world settings are sent to every connected
 * client, so storing it there would hand the token to all players.
 * ========================================================================== */

const MODULE_ID = "pf2e-kr-hud";

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, ch => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[ch]));
}

function randomKey() {
  const bytes = new Uint8Array(18);
  crypto.getRandomValues(bytes);
  return `pf2ekrvoice-${[...bytes].map(b => b.toString(16).padStart(2, "0")).join("")}`;
}

function download(filename, text, mime = "text/plain") {
  const blob = new Blob([text], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

/*
 * Saves a file through the browser's native "Save as" dialog, so the keeper
 * chooses where it goes and knows where to find it.
 *
 * The plain <a download> trick drops the file silently into the Downloads
 * folder — or, inside the Foundry desktop app, may not surface it at all —
 * which is exactly how the .bat got "lost".
 *
 * showSaveFilePicker exists in Chromium browsers and Electron, but only on a
 * secure origin (https or localhost). A game opened over plain http by IP
 * does not qualify, so there the old download is used and the keeper is told
 * where it landed.
 */
async function saveWithDialog(filename, text) {
  const blob = new Blob([text], { type: "text/plain" });

  if (typeof window.showSaveFilePicker === "function") {
    try {
      const handle = await window.showSaveFilePicker({
        suggestedName: filename,
        startIn: "desktop",
        types: [{ description: "Windows 배치 파일", accept: { "text/plain": [".bat"] } }]
      });

      const writable = await handle.createWritable();
      await writable.write(blob);
      await writable.close();

      return { ok: true, name: handle.name, dialog: true };
    } catch (error) {
      if (error?.name === "AbortError") return { ok: false, cancelled: true };
      console.warn(`${MODULE_ID} | save dialog failed, falling back to download`, error);
    }
  }

  download(filename, text);
  return { ok: true, name: filename, dialog: false };
}

async function copy(text) {
  try {
    await navigator.clipboard.writeText(text);
    ui.notifications.info("PF2e-KR HUD | 복사했습니다.");
  } catch (_) {
    ui.notifications.warn("PF2e-KR HUD | 복사하지 못했습니다. 직접 선택해서 복사하세요.");
  }
}

/* --- generated files ------------------------------------------------------- */

/*
 * The .bat finds the bridge inside the default Foundry data folder, so the
 * user can keep the file anywhere (the desktop is fine). It installs the
 * dependencies on first run and again automatically if a module update
 * wiped them.
 */
/*
 * The .bat runs the bridge from the module's own folder. It is meant to be
 * saved into tools/discord-voice-bridge inside the module; if it is saved
 * elsewhere it falls back to the default Foundry data location.
 *
 * Dependencies are installed next to bridge.js on first run, and again
 * automatically if a module update removed them.
 */
const DEFAULT_BRIDGE_DIR =
  "%LOCALAPPDATA%\\FoundryVTT\\Data\\modules\\pf2e-kr-hud\\tools\\discord-voice-bridge";

function buildLocalBat(v) {
  return [
    "@echo off",
    "chcp 65001 >nul",
    "",
    "if /I not \"%~1\"==\"min\" (",
    "  start \"PF2e-KR Voice Bridge\" /min \"%~f0\" min",
    "  exit /b",
    ")",
    "title PF2e-KR HUD Discord Voice Bridge",
    "",
    "set \"BRIDGE=%~dp0\"",
    `if not exist "%BRIDGE%bridge.js" set "BRIDGE=${DEFAULT_BRIDGE_DIR}\\"`,
    "if not exist \"%BRIDGE%bridge.js\" (",
    "  echo [오류] bridge.js 를 찾지 못했습니다.",
    "  echo 이 파일을 모듈 폴더의 pf2e-kr-hud\\tools\\discord-voice-bridge 안에 두고 실행하세요.",
    "  pause",
    "  exit /b 1",
    ")",
    "cd /d \"%BRIDGE%\"",
    "",
    "where node >nul 2>nul",
    "if errorlevel 1 (",
    "  echo [안내] Node.js 가 설치되어 있지 않습니다. 설치 페이지를 엽니다.",
    "  echo LTS 버전을 설치한 뒤 이 파일을 다시 실행하세요.",
    "  start https://nodejs.org/ko",
    "  pause",
    "  exit /b 1",
    ")",
    "",
    "rem Settings go to .env next to bridge.js; the bridge reads it by itself.",
    "> \".env\" (",
    `  echo DISCORD_TOKEN=${v.token}`,
    `  echo GUILD_ID=${v.guildId}`,
    `  echo VOICE_CHANNEL_ID=${v.channelId}`,
    `  echo PORT=${v.port}`,
    `  echo SHARED_KEY=${v.key}`,
    ")",
    "",
    "if not exist node_modules (",
    "  echo 처음 실행: 필요한 파일을 이 컴퓨터에 설치합니다. 1~2분 걸릴 수 있습니다...",
    "  call npm install --omit=dev",
    ")",
    "",
    "echo.",
    "echo 브리지를 시작합니다. 이 창을 닫으면 음성 연동이 멈춥니다.",
    "echo.",
    "node bridge.js",
    "pause",
    ""
  ].join("\r\n");
}

/*
 * Server install, as a handful of one-line commands.
 *
 * A single multi-line block (with heredocs) was fragile to paste into SSH
 * clients — terminals mangle or reject it — so each step is now one short
 * line with its own copy button. Settings go into .env inside the module
 * folder; bridge.js reads that file itself, so pm2 needs no extra flags.
 */
function serverCommands(v) {
  const given = String(v.dataPath || "").replace(/\/+$/, "");
  const findDir =
    `D=$(ls -d "${given}/modules/pf2e-kr-hud/tools/discord-voice-bridge" 2>/dev/null || ` +
    `find ~ /data /opt /srv /home /mnt /var/lib -maxdepth 8 -type d -path "*modules/pf2e-kr-hud/tools/discord-voice-bridge" 2>/dev/null | head -1); ` +
    `[ -n "$D" ] && cd "$D" && pwd || echo "모듈 폴더를 찾지 못했습니다. Foundry에 모듈이 설치되어 있는지 확인하세요."`;

  const writeEnv =
    `printf 'DISCORD_TOKEN=%s\\nGUILD_ID=%s\\nVOICE_CHANNEL_ID=%s\\nPORT=%s\\nSHARED_KEY=%s\\n' ` +
    `'${v.token}' '${v.guildId}' '${v.channelId}' '${v.port}' '${v.key}' > .env && chmod 600 .env && echo ".env OK"`;

  return [
    { id: "cd", label: "모듈 폴더로 이동", cmd: findDir,
      hint: "브리지 폴더를 찾아 이동합니다. 마지막 줄에 폴더 경로가 나오면 성공입니다." },
    { id: "env", label: "설정 파일(.env) 만들기", cmd: writeEnv, secret: true,
      hint: "봇 토큰이 들어 있는 한 줄입니다. 화면 공유 중이라면 주의하세요." },
    { id: "install", label: "필요한 파일 설치", cmd: "npm install --omit=dev",
      hint: "이 서버에 맞는 파일을 새로 받습니다. 1~2분 걸릴 수 있습니다." },
    { id: "start", label: "실행하고 자동 시작 등록",
      cmd: "pm2 delete pf2e-kr-voice-bridge 2>/dev/null; pm2 start bridge.js --name pf2e-kr-voice-bridge && pm2 save",
      hint: "서버가 재부팅돼도 pm2가 다시 켭니다." },
    { id: "check", label: "동작 확인", cmd: "pm2 logs pf2e-kr-voice-bridge --lines 20 --nostream",
      hint: "Joined voice channel 이 보이면 성공입니다." }
  ];
}

const REMOVE_COMMAND =
  "pm2 delete pf2e-kr-voice-bridge; pm2 save; " +
  "D=$(find ~ /data /opt /srv /home /mnt /var/lib -maxdepth 8 -type d -path \"*modules/pf2e-kr-hud/tools/discord-voice-bridge\" 2>/dev/null | head -1); " +
  "[ -n \"$D\" ] && rm -f \"$D/.env\" && echo removed";

function buildCaddySnippet(v) {
  return `${v.domain || "내도메인.duckdns.org"} {
    # 음성 브리지 (이 블록을 Foundry 설정보다 위에 두세요)
    handle_path /discord-voice/* {
        reverse_proxy 127.0.0.1:${v.port}
    }

    # 기존 Foundry 설정
    handle {
        reverse_proxy 127.0.0.1:30000
    }
}`;
}

/*
 * The bridge sits behind the same Caddy site as Foundry, so the domain the
 * keeper is using right now is the right one. Only a real hostname counts;
 * localhost and bare IPs cannot carry a TLS certificate.
 */
function currentDomain() {
  const host = window.location.hostname ?? "";
  if (!host || host === "localhost" || /^[\d.]+$/.test(host) || host.includes(":")) return "";
  return host;
}

function bridgeUrlFor(v) {
  return v.mode === "local"
    ? `ws://127.0.0.1:${v.port}/?key=${v.key}`
    : `wss://${v.domain}/discord-voice/?key=${v.key}`;
}

/* --- wizard ---------------------------------------------------------------- */

class PkhVoiceSetupWizard extends foundry.applications.api.ApplicationV2 {
  static DEFAULT_OPTIONS = {
    id: "pkh-voice-setup",
    tag: "section",
    window: {
      title: "디스코드 음성 연동 설정 도우미",
      icon: "fa-brands fa-discord",
      resizable: true
    },
    position: { width: 640, height: 680 }
  };

  constructor(options) {
    super(options);

    const saved = game.settings.get(MODULE_ID, "voiceSetupDraft") ?? {};
    this.step = 0;
    this.values = {
      mode: saved.mode ?? "",
      guildId: saved.guildId ?? "",
      channelId: saved.channelId ?? "",
      domain: saved.domain || currentDomain(),
      dataPath: saved.dataPath ?? "/home/ubuntu/foundrydata/Data",
      port: saved.port ?? "8787",
      key: saved.key || randomKey(),
      token: ""
    };
  }

  /** Non-secret answers are remembered; the token never is. */
  async _saveDraft() {
    const { token, ...rest } = this.values;
    await game.settings.set(MODULE_ID, "voiceSetupDraft", rest);
  }

  _steps() {
    return ["방식", "디스코드 봇", "파일 만들기", "연결 확인"];
  }

  async _renderHTML() {
    const steps = this._steps().map((label, index) => `
      <li class="${index === this.step ? "active" : ""} ${index < this.step ? "done" : ""}">
        <span>${index + 1}</span>${label}
      </li>
    `).join("");

    return `
      <div class="pkh-vsetup">
        <ol class="vs-steps">${steps}</ol>
        <div class="vs-body">${this[`_step${this.step}`]()}</div>
        <footer class="vs-footer">
          <div class="vs-footer-left">
            ${this.step > 0 ? `<button type="button" data-action="back"><i class="fa-solid fa-arrow-left"></i> 이전</button>` : ""}
            <button type="button" data-action="reset" class="subtle" title="입력값과 연결 설정을 모두 지우고 처음부터 다시 합니다">
              <i class="fa-solid fa-arrow-rotate-left"></i> 처음부터 다시
            </button>
          </div>
          ${this.step < 3
            ? `<button type="button" data-action="next" class="primary">다음 <i class="fa-solid fa-arrow-right"></i></button>`
            : `<button type="button" data-action="finish" class="primary"><i class="fa-solid fa-check"></i> 완료</button>`}
        </footer>
      </div>
    `;
  }

  _step0() {
    const v = this.values;
    return `
      <h3>Foundry를 어디서 실행하고 계신가요?</h3>
      <label class="vs-choice ${v.mode === "local" ? "selected" : ""}">
        <input type="radio" name="mode" value="local" ${v.mode === "local" ? "checked" : ""}>
        <i class="fa-solid fa-desktop"></i>
        <div>
          <strong>내 PC에서 실행 (로컬 호스팅)</strong>
          <p>Windows에서 Foundry를 켜고 플레이어가 접속하는 방식. 실행 파일(.bat) 하나를 더블클릭하면 됩니다.</p>
        </div>
      </label>
      <label class="vs-choice ${v.mode === "server" ? "selected" : ""}">
        <input type="radio" name="mode" value="server" ${v.mode === "server" ? "checked" : ""}>
        <i class="fa-solid fa-server"></i>
        <div>
          <strong>Oracle 등 서버에서 실행 (pm2 + Caddy)</strong>
          <p>SSH에 한 번 붙여넣고 Caddy 설정에 몇 줄 추가하면 됩니다. 서버가 재부팅돼도 자동으로 다시 켜집니다.</p>
        </div>
      </label>
      <p class="hint">
        어느 쪽이든 음성 신호는 <b>GM 화면 하나만</b> 받아서 모든 플레이어에게 전달합니다.
        플레이어는 아무것도 설정할 필요가 없습니다.
      </p>

      <details class="vs-more">
        <summary>서버에 설치했던 브리지를 지우고 다시 하고 싶다면</summary>
        <p class="hint">SSH에서 아래 한 줄을 실행하면 pm2 등록과 설정 파일(.env)이 지워집니다.</p>
        <div class="vs-code">
          <pre>${escapeHtml(REMOVE_COMMAND)}</pre>
          <button type="button" data-action="copyRemove" title="복사"><i class="fa-solid fa-copy"></i></button>
        </div>
      </details>
    `;
  }

  _step1() {
    const v = this.values;
    return `
      <h3>디스코드 봇 준비</h3>
      <ol class="vs-guide">
        <li><a href="https://discord.com/developers/applications" target="_blank">디스코드 개발자 포털</a>에서 <b>New Application</b>을 만듭니다.</li>
        <li><b>Bot</b> 메뉴 → <b>Reset Token</b> → 나온 토큰을 아래에 붙여넣습니다.</li>
        <li><b>OAuth2 → URL Generator</b>에서 Scopes <code>bot</code>, 권한 <code>View Channels</code> · <code>Connect</code>를 고르고 생성된 주소로 봇을 서버에 초대합니다.</li>
        <li>디스코드 <b>설정 → 고급 → 개발자 모드</b>를 켠 뒤, 서버와 음성 채널을 우클릭해 <b>ID 복사</b>합니다.</li>
      </ol>

      <div class="vs-field">
        <label>봇 토큰 <span class="secret">저장되지 않음</span></label>
        <input type="password" name="token" value="${escapeHtml(v.token)}" placeholder="MTEx...">
      </div>
      <div class="vs-field">
        <label>서버 ID</label>
        <input type="text" name="guildId" value="${escapeHtml(v.guildId)}" placeholder="123456789012345678" inputmode="numeric">
      </div>
      <div class="vs-field">
        <label>음성 채널 ID</label>
        <input type="text" name="channelId" value="${escapeHtml(v.channelId)}" placeholder="123456789012345678" inputmode="numeric">
      </div>
      <p class="hint">
        토큰은 다음 단계의 파일을 만드는 데만 쓰이고 월드에 저장되지 않습니다.
        월드 설정은 모든 플레이어에게 전송되므로 토큰을 거기 두면 안 되기 때문입니다.
      </p>
    `;
  }

  _step2() {
    return this.values.mode === "local" ? this._step2Local() : this._step2Server();
  }

  /** Confirmation line shown after the .bat has been saved. */
  _savedNote() {
    const saved = this.savedBat;
    if (!saved) return "";

    if (saved.dialog) {
      return `
        <div class="vs-saved">
          <i class="fa-solid fa-circle-check"></i>
          <b>${escapeHtml(saved.name)}</b> 을(를) 저장했습니다. 모듈 폴더 안에 저장했다면
          그 파일을 더블클릭하세요.
        </div>
      `;
    }

    return `
      <div class="vs-saved fallback">
        <i class="fa-solid fa-circle-info"></i>
        저장 위치를 고르는 창을 열 수 없는 환경이라 <b>다운로드 폴더</b>에 저장했습니다.
        다운로드 폴더에서 모듈 폴더(위 경로)로 옮긴 뒤 실행하세요.
        <br>
        파일 탐색기(<code>Win+E</code>) → <b>다운로드</b>, 또는 브라우저에서 <code>Ctrl+J</code>로 찾을 수 있습니다.
        <span class="hint">
          (http://IP 주소로 접속하면 브라우저가 저장 창을 막습니다. https 주소나 localhost에서는 창이 뜹니다.)
        </span>
      </div>
    `;
  }

  _step2Local() {
    return `
      <h3>실행 파일 받기</h3>
      <ol class="vs-guide">
        <li>아래 버튼으로 <code>start-voice-bridge.bat</code>을 <b>모듈 폴더 안</b>에 저장합니다.</li>
        <li>더블클릭합니다. 처음에는 필요한 파일을 설치하느라 1~2분 걸립니다.</li>
        <li>검은 창에 <code>Joined voice channel</code>이 나오면 성공입니다. <b>세션 동안 그 창을 켜 두세요.</b></li>
      </ol>
      <p>
        <button type="button" data-action="downloadBat" class="primary">
          <i class="fa-solid fa-floppy-disk"></i> start-voice-bridge.bat 저장하기
        </button>
      </p>
      <p class="hint">
        버튼을 누르면 저장할 위치를 고르는 창이 뜹니다. 그 창 위쪽 주소 칸에 아래 경로를 붙여넣고
        Enter를 누르면 바로 그 폴더로 이동합니다. (Foundry 데이터 폴더를 옮기셨다면 그 안의
        <code>modules\pf2e-kr-hud\tools\discord-voice-bridge</code>로 가세요.)
      </p>
      <div class="vs-code inline">
        <pre>${DEFAULT_BRIDGE_DIR}</pre>
        <button type="button" data-action="copyBridgeDir" title="경로 복사"><i class="fa-solid fa-copy"></i></button>
      </div>
      ${this._savedNote()}

      <details class="vs-more">
        <summary>Windows를 켤 때마다 자동으로 실행하고 싶다면</summary>
        <ol>
          <li><code>Win+R</code>을 누르고 <code>shell:startup</code>을 입력한 뒤 확인을 누릅니다.</li>
          <li>열린 <b>시작 프로그램</b> 폴더에 저장한 <code>start-voice-bridge.bat</code>을 복사해 넣습니다.</li>
        </ol>
        <p class="hint">그만두려면 같은 폴더에서 파일을 지우면 됩니다.</p>
      </details>
      <p class="hint">
        Node.js가 없으면 설치 페이지가 자동으로 열립니다. LTS를 설치한 뒤 다시 실행하세요.<br>
        이 파일에는 봇 토큰이 들어 있습니다. <b>다른 사람에게 보내지 마세요.</b>
      </p>
    `;
  }

  _step2Server() {
    const v = this.values;
    const caddy = buildCaddySnippet(v);

    const steps = serverCommands(v).map((step, index) => `
      <div class="vs-cmd">
        <div class="vs-cmd-head">
          <span class="vs-cmd-no">${index + 1}</span>
          <strong>${escapeHtml(step.label)}</strong>
        </div>
        <div class="vs-code">
          <pre class="${step.secret ? "secret" : ""}">${escapeHtml(step.cmd)}</pre>
          <button type="button" data-action="copyCmd" data-cmd="${step.id}" title="복사"><i class="fa-solid fa-copy"></i></button>
        </div>
        <p class="hint">${escapeHtml(step.hint)}</p>
      </div>
    `).join("");

    return `
      <h3>서버에 설치</h3>

      <details class="vs-more" open>
        <summary>먼저: 서버에 Node.js와 pm2가 있나요?</summary>
        <p class="hint">
          SSH에서 <code>node -v</code> 를 쳐서 v20 이상이 나오면 건너뛰세요. 없다면 아래 두 줄을 차례로 실행합니다.
        </p>
        <div class="vs-code"><pre>curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - &amp;&amp; sudo apt-get install -y nodejs</pre>
          <button type="button" data-action="copyText" data-text="curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - &amp;&amp; sudo apt-get install -y nodejs" title="복사"><i class="fa-solid fa-copy"></i></button></div>
        <div class="vs-code"><pre>sudo npm install -g pm2</pre>
          <button type="button" data-action="copyText" data-text="sudo npm install -g pm2" title="복사"><i class="fa-solid fa-copy"></i></button></div>
        <p class="hint">
          <b>PC의 node_modules 폴더를 서버로 복사하지 마세요.</b> 그 안의 파일은 운영체제마다 다르게
          만들어져서, Windows에서 설치한 것은 Linux 서버에서 동작하지 않습니다. 아래 3번 단계가 서버에 맞게 새로 설치합니다.
        </p>
      </details>

      <div class="vs-field">
        <label>도메인</label>
        <input type="text" name="domain" value="${escapeHtml(v.domain)}" placeholder="myfoundry.duckdns.org">
        <p class="hint">지금 접속한 주소에서 자동으로 채웠습니다. Foundry에 접속할 때 쓰는 도메인과 같으면 그대로 두세요.</p>
      </div>
      <div class="vs-field">
        <label>Foundry 데이터 폴더 (서버, 모르면 그대로)</label>
        <input type="text" name="dataPath" value="${escapeHtml(v.dataPath)}">
      </div>
      <button type="button" data-action="regen" class="small"><i class="fa-solid fa-rotate"></i> 입력값 반영</button>

      <h4>① SSH에서 한 줄씩 실행</h4>
      <p class="hint">위에서부터 하나씩 복사해 붙여넣고 Enter를 누르세요. 앞 단계가 끝난 뒤 다음 줄로 넘어가면 됩니다.</p>
      ${steps}

      <h4>② Caddy 설정에 추가</h4>
      <p class="hint">
        <code>sudo nano /etc/caddy/Caddyfile</code> 로 열어 기존 블록을 아래처럼 바꾼 뒤
        <code>sudo systemctl reload caddy</code>. Caddy가 인증서와 WebSocket을 처리하므로 8787 포트는 열 필요가 없습니다.
      </p>
      <div class="vs-code">
        <pre>${escapeHtml(caddy)}</pre>
        <button type="button" data-action="copyCaddy" title="복사"><i class="fa-solid fa-copy"></i></button>
      </div>

      <p class="hint">
        모듈을 업데이트하면 이 폴더의 <code>.env</code>와 설치 파일이 지워질 수 있습니다. 업데이트 후 연결이 안 되면
        이 단계의 1~4번을 다시 실행하세요.
      </p>
    `;
  }

  _step3() {
    const v = this.values;
    const url = bridgeUrlFor(v);
    const current = String(game.settings.get(MODULE_ID, "voiceBridgeUrl") ?? "");
    const state = game.pf2eKrVoiceBridge?.state ?? "off";

    const stateText = {
      on: ["on", "연결됨 — 설정이 끝났습니다!"],
      connecting: ["busy", "연결 중..."],
      retrying: ["busy", "브리지를 기다리는 중... (브리지가 켜져 있는지 확인하세요)"],
      error: ["error", "주소 형식 오류"],
      standby: ["off", "다른 GM이 중계 중입니다"],
      disabled: ["off", "음성 연동이 꺼져 있습니다 — 위 버튼을 누르면 켜고 연결합니다"],
      gaveup: ["error", "브리지를 찾지 못해 재시도를 멈췄습니다 — 브리지를 켠 뒤 위 버튼을 누르세요"],
      off: ["off", "연결 안 됨"]
    }[state] ?? ["off", state];

    return `
      <h3>연결 확인</h3>
      <div class="vs-field">
        <label>브리지 주소</label>
        <div class="vs-code inline">
          <pre>${escapeHtml(url)}</pre>
        </div>
      </div>
      <p>
        <button type="button" data-action="applyUrl" class="primary">
          <i class="fa-solid fa-plug"></i> ${current === url ? "다시 연결" : "이 주소로 연결"}
        </button>
      </p>

      <div class="vs-state ${stateText[0]}">
        <i class="fa-solid fa-circle"></i> ${stateText[1]}
      </div>

      <div class="vs-security"></div>

      ${state === "on" || state === "disabled" ? "" : this._howToStart()}

      <h4>마지막으로 사람 연결</h4>
      <p>
        연결되면 <b>연결 관리</b> 창을 열고 음성 채널에서 한 명씩 말해 보세요.
        들린 디스코드 ID 옆 <b>+</b>를 누르고 Foundry 사용자를 고르면 끝입니다.
      </p>
      <p>
        <button type="button" data-action="openMapping">
          <i class="fa-solid fa-users"></i> 연결 관리 열기
        </button>
      </p>
    `;
  }

  /** What "turn the bridge on" actually means for the chosen setup. */
  _howToStart() {
    if (this.values.mode === "local") {
      return `
        <div class="vs-howto">
          <h4><i class="fa-solid fa-circle-play"></i> 브리지 켜는 법</h4>
          <p>
            3단계에서 저장한 <code>start-voice-bridge.bat</code>을 <b>더블클릭</b>하세요.
            명령어를 칠 필요는 없습니다. 작업 표시줄에 최소화된 창이 생기고, 잠시 뒤 위의 상태가
            <b>연결됨</b>으로 바뀝니다. 이 화면은 저절로 갱신됩니다.
          </p>
          <p class="hint">
            웹페이지(Foundry)는 보안상 PC의 프로그램을 직접 실행할 수 없어서, 이 한 번의
            더블클릭만은 직접 해 주셔야 합니다.
          </p>
          <p>
            <button type="button" data-action="downloadBat" class="small">
              <i class="fa-solid fa-floppy-disk"></i> .bat 다시 저장하기
            </button>
          </p>
          ${this._savedNote()}
        </div>
      `;
    }

    return `
      <div class="vs-howto">
        <h4><i class="fa-solid fa-server"></i> 서버에서는 이미 켜져 있어야 합니다</h4>
        <p>
          3단계의 명령을 실행했다면 pm2가 브리지를 계속 실행하고, 서버를 재부팅해도 다시 켭니다.
          따로 켤 일은 없습니다.
        </p>
        <p class="hint">
          연결이 안 되면: SSH에서 <code>pm2 logs pf2e-kr-voice-bridge --lines 20 --nostream</code> 로 봇 로그를 보고,
          Caddy 설정을 바꿨다면 <code>sudo systemctl reload caddy</code> 를 했는지 확인하세요.
        </p>
      </div>
    `;
  }

  /** Wipes the wizard and the connection settings so setup can start over. */
  async _reset() {
    const confirmed = await foundry.applications.api.DialogV2.confirm({
      window: { title: "처음부터 다시", icon: "fa-solid fa-arrow-rotate-left" },
      content: `
        <p>도우미에 입력한 값, 브리지 주소, 연결 키를 모두 지우고 음성 연동을 끕니다.</p>
        <p class="hint">디스코드 ↔ Foundry 사용자 연결 목록은 그대로 둡니다.
        서버에 설치한 브리지까지 지우려면 첫 화면의 안내를 따르세요.</p>
      `,
      modal: true
    });
    if (!confirmed) return;

    game.pf2eKrVoiceBridge?.disconnect();
    await game.settings.set(MODULE_ID, "voiceBridgeEnabled", false);
    await game.settings.set(MODULE_ID, "voiceBridgeUrl", "");
    await game.settings.set(MODULE_ID, "voiceSetupDraft", {});

    this.values = {
      mode: "",
      guildId: "",
      channelId: "",
      domain: currentDomain(),
      dataPath: "/home/ubuntu/foundrydata/Data",
      port: "8787",
      key: randomKey(),
      token: ""
    };
    this.savedBat = null;
    this.step = 0;

    ui.notifications.info("PF2e-KR HUD | 음성 연동 설정을 초기화했습니다.");
    this.render();
  }

  /*
   * The .env holding the bot token sits inside the module folder, which
   * Foundry serves over the web. Dotfiles are normally not served, but that is
   * a server detail this module cannot guarantee — so it is checked for real:
   * request the file the way anyone on the internet could, and warn loudly if
   * the token comes back.
   */
  async _checkEnvExposure(el) {
    const slot = el?.querySelector(".vs-security");
    if (!slot) return;

    const url = foundry.utils.getRoute(`modules/${MODULE_ID}/tools/discord-voice-bridge/.env`);

    try {
      const response = await fetch(url, { cache: "no-store", credentials: "omit" });
      const body = response.ok ? await response.text() : "";

      if (response.ok && body.includes("DISCORD_TOKEN")) {
        slot.innerHTML = `
          <div class="vs-danger">
            <i class="fa-solid fa-triangle-exclamation"></i>
            <b>위험: 봇 토큰이 담긴 .env 파일을 인터넷에서 누구나 읽을 수 있습니다.</b><br>
            이 서버는 점으로 시작하는 파일도 웹으로 제공하고 있습니다. 즉시 디스코드 개발자 포털에서
            토큰을 재발급(Reset Token)하고, 호스팅 설정에서 이 파일이 웹으로 제공되지 않도록 막으세요.
          </div>
        `;
        return;
      }

      slot.innerHTML = `
        <p class="hint vs-safe"><i class="fa-solid fa-shield-halved"></i>
        보안 확인: 설정 파일(.env)은 인터넷에서 읽을 수 없습니다.</p>
      `;
    } catch (_) {
      slot.innerHTML = "";
    }
  }

  /** Reads whatever inputs the current step shows into this.values. */
  _collect(content) {
    for (const input of content.querySelectorAll("input[name]")) {
      if (input.type === "radio") {
        if (input.checked) this.values[input.name] = input.value;
        continue;
      }
      if (input.type === "checkbox") {
        this.values[input.name] = input.checked;
        continue;
      }
      this.values[input.name] = input.value.trim();
    }
  }

  _validate() {
    const v = this.values;

    if (this.step === 0 && !v.mode) return "실행 방식을 골라 주세요.";

    if (this.step === 1) {
      if (!v.token) return "봇 토큰을 입력해 주세요.";
      if (!/^\d{15,21}$/.test(v.guildId)) return "서버 ID는 15~21자리 숫자입니다.";
      if (!/^\d{15,21}$/.test(v.channelId)) return "음성 채널 ID는 15~21자리 숫자입니다.";
    }

    if (this.step === 2 && v.mode === "server" && !v.domain) {
      return "도메인을 입력해 주세요.";
    }

    return null;
  }

  async _replaceHTML(result, content) {
    content.innerHTML = result;

    // Picking a mode card highlights it immediately.
    content.querySelectorAll("input[name='mode']").forEach(radio => {
      radio.addEventListener("change", () => {
        content.querySelectorAll(".vs-choice").forEach(card =>
          card.classList.toggle("selected", card.contains(radio) && radio.checked)
        );
      });
    });

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

      this._collect(content);
      const action = button.dataset.action;

      if (action === "back") {
        this.step = Math.max(0, this.step - 1);
        return this.render();
      }

      if (action === "next") {
        const problem = this._validate();
        if (problem) return ui.notifications.warn(`PF2e-KR HUD | ${problem}`);
        await this._saveDraft();
        this.step += 1;
        return this.render();
      }

      if (action === "regen") {
        await this._saveDraft();
        return this.render();
      }

      if (action === "downloadBat") {
        if (!this.values.token) {
          return ui.notifications.warn(
            "PF2e-KR HUD | 봇 토큰은 저장되지 않습니다. 2단계에서 토큰을 다시 입력한 뒤 받아 주세요."
          );
        }
        const result = await saveWithDialog("start-voice-bridge.bat", buildLocalBat(this.values));
        if (result.cancelled) return;

        this.savedBat = result;
        return this.render();
      }

      if (action === "copyCmd") {
        const step = serverCommands(this.values).find(item => item.id === button.dataset.cmd);
        if (step?.secret && !this.values.token) {
          return ui.notifications.warn("PF2e-KR HUD | 봇 토큰은 저장되지 않습니다. 2단계에서 토큰을 다시 입력해 주세요.");
        }
        return step ? copy(step.cmd) : null;
      }
      if (action === "copyText") return copy(button.dataset.text ?? "");
      if (action === "copyRemove") return copy(REMOVE_COMMAND);
      if (action === "reset") return this._reset();
      if (action === "copyBridgeDir") return copy(DEFAULT_BRIDGE_DIR);
      if (action === "copyCaddy") return copy(buildCaddySnippet(this.values));

      if (action === "applyUrl") {
        if (this.values.mode === "server" && !this.values.domain) {
          return ui.notifications.warn("PF2e-KR HUD | 도메인이 비어 있습니다. 3단계에서 도메인을 입력해 주세요.");
        }

        // Connecting from the wizard is an explicit "yes, use voice".
        await game.settings.set(MODULE_ID, "voiceBridgeEnabled", true);
        await game.settings.set(MODULE_ID, "voiceBridgeUrl", bridgeUrlFor(this.values));
        game.pf2eKrVoiceBridge?.connect();
        // Give the socket a moment, then show the result.
        setTimeout(() => this.rendered && this.render(), 1500);
        return;
      }

      if (action === "openMapping") return game.pf2eKrVoiceBridge?.openMapping();

      if (action === "finish") {
        this.values.token = "";
        await this._saveDraft();
        return this.close();
      }
    });
  }

  _onRender(context, options) {
    super._onRender?.(context, options);

    // On the last step, watch the connection and redraw when it changes, so
    // the keeper sees "연결됨" the moment the bridge comes up.
    clearInterval(this._statusTimer);
    if (this.step !== 3) return;

    this._checkEnvExposure(this.element);

    this._lastState = game.pf2eKrVoiceBridge?.state;
    this._statusTimer = setInterval(() => {
      const state = game.pf2eKrVoiceBridge?.state;
      if (state !== this._lastState && this.rendered) this.render();
    }, 1000);
  }

  async _onClose(options) {
    clearInterval(this._statusTimer);

    // Drop the token from memory as soon as the wizard goes away.
    this.values.token = "";
    return super._onClose?.(options);
  }
}

Hooks.once("init", () => {
  game.settings.register(MODULE_ID, "voiceSetupDraft", {
    name: "Voice Setup Draft",
    scope: "world",
    config: false,
    type: Object,
    default: {}
  });

  game.settings.registerMenu(MODULE_ID, "voiceSetupMenu", {
    name: "디스코드 음성 연동 설정 도우미",
    label: "설정 도우미 열기",
    hint: "로컬 PC나 Oracle 서버에 음성 브리지를 설치하는 과정을 단계별로 안내합니다. 명령을 직접 입력할 필요가 거의 없습니다.",
    icon: "fa-solid fa-wand-magic-sparkles",
    type: PkhVoiceSetupWizard,
    restricted: true
  });
});

Hooks.once("ready", () => {
  if (game.pf2eKrVoiceBridge) {
    game.pf2eKrVoiceBridge.openSetup = () => new PkhVoiceSetupWizard().render({ force: true });
  }
});
