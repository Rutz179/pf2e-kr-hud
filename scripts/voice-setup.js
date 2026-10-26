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

import { t } from "./shared.mjs";

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
        types: [{ description: t("Voice.Setup.BatType"), accept: { "text/plain": [".bat"] } }]
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
    ui.notifications.info(`PF2e-KR HUD | ${t("Voice.Setup.Copied")}`);
  } catch (_) {
    ui.notifications.warn(`PF2e-KR HUD | ${t("Voice.Setup.CopyFailed")}`);
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
    `  echo ${t("Voice.Bat.NoBridge")}`,
    `  echo ${t("Voice.Bat.PutHere")}`,
    "  pause",
    "  exit /b 1",
    ")",
    "cd /d \"%BRIDGE%\"",
    "",
    "where node >nul 2>nul",
    "if errorlevel 1 (",
    `  echo ${t("Voice.Bat.NoNode")}`,
    `  echo ${t("Voice.Bat.InstallLts")}`,
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
    `  echo ${t("Voice.Bat.FirstRun")}`,
    "  call npm install --omit=dev",
    ")",
    "",
    "echo.",
    `echo ${t("Voice.Bat.Starting")}`,
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
    `[ -n "$D" ] && cd "$D" && pwd || echo "${t("Voice.Shell.NoFolder")}"`;

  const writeEnv =
    `printf 'DISCORD_TOKEN=%s\\nGUILD_ID=%s\\nVOICE_CHANNEL_ID=%s\\nPORT=%s\\nSHARED_KEY=%s\\n' ` +
    `'${v.token}' '${v.guildId}' '${v.channelId}' '${v.port}' '${v.key}' > .env && chmod 600 .env && echo ".env OK"`;

  return [
    { id: "cd", label: t("Voice.Cmd.Cd.Label"), cmd: findDir,
      hint: t("Voice.Cmd.Cd.Hint") },
    { id: "env", label: t("Voice.Cmd.Env.Label"), cmd: writeEnv, secret: true,
      hint: t("Voice.Cmd.Env.Hint") },
    { id: "install", label: t("Voice.Cmd.Install.Label"), cmd: "npm install --omit=dev",
      hint: t("Voice.Cmd.Install.Hint") },
    { id: "start", label: t("Voice.Cmd.Start.Label"),
      cmd: "pm2 delete pf2e-kr-voice-bridge 2>/dev/null; pm2 start bridge.js --name pf2e-kr-voice-bridge && pm2 save",
      hint: t("Voice.Cmd.Start.Hint") },
    { id: "check", label: t("Voice.Cmd.Check.Label"), cmd: "pm2 logs pf2e-kr-voice-bridge --lines 20 --nostream",
      hint: t("Voice.Cmd.Check.Hint") }
  ];
}

const REMOVE_COMMAND =
  "pm2 delete pf2e-kr-voice-bridge; pm2 save; " +
  "D=$(find ~ /data /opt /srv /home /mnt /var/lib -maxdepth 8 -type d -path \"*modules/pf2e-kr-hud/tools/discord-voice-bridge\" 2>/dev/null | head -1); " +
  "[ -n \"$D\" ] && rm -f \"$D/.env\" && echo removed";

function buildCaddySnippet(v) {
  return `${v.domain || t("Voice.Caddy.Domain")} {
    # ${t("Voice.Caddy.BridgeComment")}
    handle_path /discord-voice/* {
        reverse_proxy 127.0.0.1:${v.port}
    }

    # ${t("Voice.Caddy.FoundryComment")}
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
      title: "PKH.Voice.Setup.Title",
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
    return [t("Voice.Setup.Steps.Mode"), t("Voice.Setup.Steps.Bot"), t("Voice.Setup.Steps.Files"), t("Voice.Setup.Steps.Check")];
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
            ${this.step > 0 ? `<button type="button" data-action="back"><i class="fa-solid fa-arrow-left"></i> ${t("Voice.Setup.Back")}</button>` : ""}
            <button type="button" data-action="reset" class="subtle" title="${escapeHtml(t("Voice.Setup.ResetTip"))}">
              <i class="fa-solid fa-arrow-rotate-left"></i> ${t("Voice.Setup.Reset")}
            </button>
          </div>
          ${this.step < 3
            ? `<button type="button" data-action="next" class="primary">${t("Voice.Setup.Next")} <i class="fa-solid fa-arrow-right"></i></button>`
            : `<button type="button" data-action="finish" class="primary"><i class="fa-solid fa-check"></i> ${t("Voice.Setup.Finish")}</button>`}
        </footer>
      </div>
    `;
  }

  _step0() {
    const v = this.values;
    return `
      <h3>${t("Voice.Setup.WhereTitle")}</h3>
      <label class="vs-choice ${v.mode === "local" ? "selected" : ""}">
        <input type="radio" name="mode" value="local" ${v.mode === "local" ? "checked" : ""}>
        <i class="fa-solid fa-desktop"></i>
        <div>
          <strong>${t("Voice.Setup.Local")}</strong>
          <p>${t("Voice.Setup.LocalDesc")}</p>
        </div>
      </label>
      <label class="vs-choice ${v.mode === "server" ? "selected" : ""}">
        <input type="radio" name="mode" value="server" ${v.mode === "server" ? "checked" : ""}>
        <i class="fa-solid fa-server"></i>
        <div>
          <strong>${t("Voice.Setup.Server")}</strong>
          <p>${t("Voice.Setup.ServerDesc")}</p>
        </div>
      </label>
      <p class="hint">
        ${t("Voice.Setup.EitherWay")}
      </p>

      <details class="vs-more">
        <summary>${t("Voice.Setup.RemoveSummary")}</summary>
        <p class="hint">${t("Voice.Setup.RemoveHint")}</p>
        <div class="vs-code">
          <pre>${escapeHtml(REMOVE_COMMAND)}</pre>
          <button type="button" data-action="copyRemove" title="${t("Voice.Setup.Copy")}"><i class="fa-solid fa-copy"></i></button>
        </div>
      </details>
    `;
  }

  _step1() {
    const v = this.values;
    return `
      <h3>${t("Voice.Setup.BotTitle")}</h3>
      <ol class="vs-guide">
        <li>${t("Voice.Setup.Guide1", { portal: `<a href="https://discord.com/developers/applications" target="_blank">${t("Voice.Setup.Portal")}</a>` })}</li>
        <li>${t("Voice.Setup.Guide2")}</li>
        <li>${t("Voice.Setup.Guide3")}</li>
        <li>${t("Voice.Setup.Guide4")}</li>
      </ol>

      <div class="vs-field">
        <label>${t("Voice.Setup.Token")} <span class="secret">${t("Voice.Setup.NotSaved")}</span></label>
        <input type="password" name="token" value="${escapeHtml(v.token)}" placeholder="MTEx...">
      </div>
      <div class="vs-field">
        <label>${t("Voice.Setup.GuildId")}</label>
        <input type="text" name="guildId" value="${escapeHtml(v.guildId)}" placeholder="123456789012345678" inputmode="numeric">
      </div>
      <div class="vs-field">
        <label>${t("Voice.Setup.ChannelId")}</label>
        <input type="text" name="channelId" value="${escapeHtml(v.channelId)}" placeholder="123456789012345678" inputmode="numeric">
      </div>
      <p class="hint">
        ${t("Voice.Setup.TokenHint")}
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
          ${t("Voice.Setup.SavedDialog", { name: escapeHtml(saved.name) })}
        </div>
      `;
    }

    return `
      <div class="vs-saved fallback">
        <i class="fa-solid fa-circle-info"></i>
        ${t("Voice.Setup.SavedFallback1")}
        <br>
        ${t("Voice.Setup.SavedFallback2")}
        <span class="hint">
          ${t("Voice.Setup.SavedFallback3")}
        </span>
      </div>
    `;
  }

  _step2Local() {
    return `
      <h3>${t("Voice.Setup.GetBat")}</h3>
      <ol class="vs-guide">
        <li>${t("Voice.Setup.LocalGuide1")}</li>
        <li>${t("Voice.Setup.LocalGuide2")}</li>
        <li>${t("Voice.Setup.LocalGuide3")}</li>
      </ol>
      <p>
        <button type="button" data-action="downloadBat" class="primary">
          <i class="fa-solid fa-floppy-disk"></i> ${t("Voice.Setup.SaveBat")}
        </button>
      </p>
      <p class="hint">
        ${t("Voice.Setup.SaveDirHint", { path: "modules\\pf2e-kr-hud\\tools\\discord-voice-bridge" })}
      </p>
      <div class="vs-code inline">
        <pre>${DEFAULT_BRIDGE_DIR}</pre>
        <button type="button" data-action="copyBridgeDir" title="${t("Voice.Setup.CopyPath")}"><i class="fa-solid fa-copy"></i></button>
      </div>
      ${this._savedNote()}

      <details class="vs-more">
        <summary>${t("Voice.Setup.AutoStartSummary")}</summary>
        <ol>
          <li>${t("Voice.Setup.AutoStart1")}</li>
          <li>${t("Voice.Setup.AutoStart2")}</li>
        </ol>
        <p class="hint">${t("Voice.Setup.AutoStart3")}</p>
      </details>
      <p class="hint">
        ${t("Voice.Setup.LocalNote1")}<br>
        ${t("Voice.Setup.LocalNote2")}
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
          <button type="button" data-action="copyCmd" data-cmd="${step.id}" title="${t("Voice.Setup.Copy")}"><i class="fa-solid fa-copy"></i></button>
        </div>
        <p class="hint">${escapeHtml(step.hint)}</p>
      </div>
    `).join("");

    return `
      <h3>${t("Voice.Setup.ServerTitle")}</h3>

      <details class="vs-more" open>
        <summary>${t("Voice.Setup.NodeSummary")}</summary>
        <p class="hint">
          ${t("Voice.Setup.NodeHint")}
        </p>
        <div class="vs-code"><pre>curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - &amp;&amp; sudo apt-get install -y nodejs</pre>
          <button type="button" data-action="copyText" data-text="curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - &amp;&amp; sudo apt-get install -y nodejs" title="${t("Voice.Setup.Copy")}"><i class="fa-solid fa-copy"></i></button></div>
        <div class="vs-code"><pre>sudo npm install -g pm2</pre>
          <button type="button" data-action="copyText" data-text="sudo npm install -g pm2" title="${t("Voice.Setup.Copy")}"><i class="fa-solid fa-copy"></i></button></div>
        <p class="hint">
          ${t("Voice.Setup.NodeModulesHint")}
        </p>
      </details>

      <div class="vs-field">
        <label>${t("Voice.Setup.Domain")}</label>
        <input type="text" name="domain" value="${escapeHtml(v.domain)}" placeholder="myfoundry.duckdns.org">
        <p class="hint">${t("Voice.Setup.DomainHint")}</p>
      </div>
      <div class="vs-field">
        <label>${t("Voice.Setup.DataPath")}</label>
        <input type="text" name="dataPath" value="${escapeHtml(v.dataPath)}">
      </div>
      <button type="button" data-action="regen" class="small"><i class="fa-solid fa-rotate"></i> ${t("Voice.Setup.Regen")}</button>

      <h4>${t("Voice.Setup.SshTitle")}</h4>
      <p class="hint">${t("Voice.Setup.SshHint")}</p>
      ${steps}

      <h4>${t("Voice.Setup.CaddyTitle")}</h4>
      <p class="hint">
        ${t("Voice.Setup.CaddyHint")}
      </p>
      <div class="vs-code">
        <pre>${escapeHtml(caddy)}</pre>
        <button type="button" data-action="copyCaddy" title="${t("Voice.Setup.Copy")}"><i class="fa-solid fa-copy"></i></button>
      </div>

      <p class="hint">
        ${t("Voice.Setup.UpdateHint")}
      </p>
    `;
  }

  _step3() {
    const v = this.values;
    const url = bridgeUrlFor(v);
    const current = String(game.settings.get(MODULE_ID, "voiceBridgeUrl") ?? "");
    const state = game.pf2eKrVoiceBridge?.state ?? "off";

    const stateText = {
      on: ["on", t("Voice.Setup.State.on")],
      connecting: ["busy", t("Voice.Setup.State.connecting")],
      retrying: ["busy", t("Voice.Setup.State.retrying")],
      error: ["error", t("Voice.Setup.State.error")],
      standby: ["off", t("Voice.Setup.State.standby")],
      disabled: ["off", t("Voice.Setup.State.disabled")],
      gaveup: ["error", t("Voice.Setup.State.gaveup")],
      off: ["off", t("Voice.Setup.State.off")]
    }[state] ?? ["off", state];

    return `
      <h3>${t("Voice.Setup.Steps.Check")}</h3>
      <div class="vs-field">
        <label>${t("Voice.Setup.BridgeUrl")}</label>
        <div class="vs-code inline">
          <pre>${escapeHtml(url)}</pre>
        </div>
      </div>
      <p>
        <button type="button" data-action="applyUrl" class="primary">
          <i class="fa-solid fa-plug"></i> ${t(current === url ? "Voice.Reconnect" : "Voice.Setup.Connect")}
        </button>
      </p>

      <div class="vs-state ${stateText[0]}">
        <i class="fa-solid fa-circle"></i> ${stateText[1]}
      </div>

      <div class="vs-security"></div>

      ${state === "on" || state === "disabled" ? "" : this._howToStart()}

      <h4>${t("Voice.Setup.LinkTitle")}</h4>
      <p>
        ${t("Voice.Setup.LinkHint")}
      </p>
      <p>
        <button type="button" data-action="openMapping">
          <i class="fa-solid fa-users"></i> ${t("Voice.Setup.OpenMapping")}
        </button>
      </p>
    `;
  }

  /** What "turn the bridge on" actually means for the chosen setup. */
  _howToStart() {
    if (this.values.mode === "local") {
      return `
        <div class="vs-howto">
          <h4><i class="fa-solid fa-circle-play"></i> ${t("Voice.Setup.HowToTitle")}</h4>
          <p>
            ${t("Voice.Setup.HowToLocal")}
          </p>
          <p class="hint">
            ${t("Voice.Setup.HowToLocalWhy")}
          </p>
          <p>
            <button type="button" data-action="downloadBat" class="small">
              <i class="fa-solid fa-floppy-disk"></i> ${t("Voice.Setup.SaveBatAgain")}
            </button>
          </p>
          ${this._savedNote()}
        </div>
      `;
    }

    return `
      <div class="vs-howto">
        <h4><i class="fa-solid fa-server"></i> ${t("Voice.Setup.HowToServerTitle")}</h4>
        <p>
          ${t("Voice.Setup.HowToServer")}
        </p>
        <p class="hint">
          ${t("Voice.Setup.HowToServerTrouble", { logs: "pm2 logs pf2e-kr-voice-bridge --lines 20 --nostream" })}
        </p>
      </div>
    `;
  }

  /** Wipes the wizard and the connection settings so setup can start over. */
  async _reset() {
    const confirmed = await foundry.applications.api.DialogV2.confirm({
      window: { title: t("Voice.Setup.Reset"), icon: "fa-solid fa-arrow-rotate-left" },
      content: `
        <p>${t("Voice.Setup.ResetConfirm1")}</p>
        <p class="hint">${t("Voice.Setup.ResetConfirm2")}</p>
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

    ui.notifications.info(`PF2e-KR HUD | ${t("Voice.Setup.ResetDone")}`);
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
            <b>${t("Voice.Setup.Danger1")}</b><br>
            ${t("Voice.Setup.Danger2")}
          </div>
        `;
        return;
      }

      slot.innerHTML = `
        <p class="hint vs-safe"><i class="fa-solid fa-shield-halved"></i>
        ${t("Voice.Setup.Safe")}</p>
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

    if (this.step === 0 && !v.mode) return t("Voice.Setup.Validate.Mode");

    if (this.step === 1) {
      if (!v.token) return t("Voice.Setup.Validate.Token");
      if (!/^\d{15,21}$/.test(v.guildId)) return t("Voice.Setup.Validate.Guild");
      if (!/^\d{15,21}$/.test(v.channelId)) return t("Voice.Setup.Validate.Channel");
    }

    if (this.step === 2 && v.mode === "server" && !v.domain) {
      return t("Voice.Setup.Validate.Domain");
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
            `PF2e-KR HUD | ${t("Voice.Setup.TokenAgainDownload")}`
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
          return ui.notifications.warn(`PF2e-KR HUD | ${t("Voice.Setup.TokenAgain")}`);
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
          return ui.notifications.warn(`PF2e-KR HUD | ${t("Voice.Setup.DomainEmpty")}`);
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
    name: "PKH.Settings.voiceSetupMenu.Name",
    label: "PKH.Settings.voiceSetupMenu.Label",
    hint: "PKH.Settings.voiceSetupMenu.Hint",
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
