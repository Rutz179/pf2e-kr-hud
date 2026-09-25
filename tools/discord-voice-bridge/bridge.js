/*
 * PF2e-KR HUD Discord voice bridge.
 *
 * Joins one voice channel, listens only for Discord's "speaking" start/stop
 * notifications, and broadcasts them to connected Foundry clients over a
 * WebSocket. It never subscribes to or decodes audio.
 *
 * Configuration (environment variables):
 *   DISCORD_TOKEN      bot token from the Discord developer portal
 *   GUILD_ID           optional; first server to use (chosen in Foundry later)
 *   VOICE_CHANNEL_ID   optional; first voice channel to use
 *   PORT               WebSocket port (default 8787)
 *   SHARED_KEY         optional; clients must connect with ?key=<value>
 */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join as joinPath } from "node:path";
import { fileURLToPath } from "node:url";
import { ChannelType, Client, Events, GatewayIntentBits } from "discord.js";
import { joinVoiceChannel, VoiceConnectionStatus, entersState } from "@discordjs/voice";
import { WebSocketServer } from "ws";

/*
 * Settings live in a .env file next to this script, inside the module folder.
 * It is read here directly, so the bridge starts the same way everywhere —
 * `node bridge.js`, pm2, or the Windows .bat — with no extra flags.
 *
 * The file always wins over inherited environment values. pm2 stores the
 * environment a process was first started with and hands it back on every
 * restart; if that snapshot held an empty or outdated token, letting the
 * environment take precedence meant edits to .env were silently ignored until
 * the process was deleted and re-created. Reading the file last makes
 * "edit .env, then pm2 restart" simply work.
 */
function loadEnvFile() {
  const file = joinPath(dirname(fileURLToPath(import.meta.url)), ".env");
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return;
  }

  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!match || line.trimStart().startsWith("#")) continue;

    const [, key, raw] = match;
    const value = raw.replace(/^(['"])(.*)\1$/, "$2");
    process.env[key] = value;
  }
}

loadEnvFile();

const {
  DISCORD_TOKEN,
  GUILD_ID,
  VOICE_CHANNEL_ID,
  PORT = "8787",
  SHARED_KEY = ""
} = process.env;

if (!DISCORD_TOKEN) {
  console.error("Missing setting: DISCORD_TOKEN. Create a .env file next to bridge.js (the setup wizard shows how).");
  process.exit(1);
}

/*
 * Which voice channel to listen to is chosen from inside Foundry, not from
 * this file: one table runs several Discord servers and rooms, and editing
 * .env before every session was the worst part of using this.
 *
 * GUILD_ID / VOICE_CHANNEL_ID, if present, only provide the starting choice.
 * The last channel picked in Foundry is remembered in channel.json beside this
 * script, so a restart comes back to the same room — but the bot only rejoins
 * on its own if it was in a channel when it stopped.
 */
const STATE_FILE = joinPath(dirname(fileURLToPath(import.meta.url)), "channel.json");

function loadState() {
  try {
    return JSON.parse(readFileSync(STATE_FILE, "utf8"));
  } catch {
    return {
      guildId: GUILD_ID ?? null,
      channelId: VOICE_CHANNEL_ID ?? null,
      joined: !!(GUILD_ID && VOICE_CHANNEL_ID)
    };
  }
}

function saveState() {
  try {
    writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch (error) {
    console.warn("Could not save channel.json:", error.message);
  }
}

const state = loadState();

/* --- WebSocket side -------------------------------------------------------- */

const wss = new WebSocketServer({ port: Number(PORT) });

wss.on("connection", (socket, request) => {
  if (SHARED_KEY) {
    const key = new URL(request.url ?? "/", "http://localhost").searchParams.get("key");
    if (key !== SHARED_KEY) {
      socket.close(1008, "invalid key");
      return;
    }
  }
  console.log(`Foundry client connected (${wss.clients.size} total)`);

  // Tell the newcomer where the bot stands and what rooms it can see.
  sendStatus(socket);
  sendChannelList(socket).catch(error => console.warn("Channel list failed:", error.message));

  /*
   * Commands from Foundry. Anyone reaching this point already passed the
   * shared key; the module only shows these controls to a keeper.
   */
  socket.on("message", async raw => {
    let command;
    try {
      command = JSON.parse(String(raw));
    } catch {
      return;
    }

    try {
      if (command.type === "listChannels") await sendChannelList(socket);
      if (command.type === "join") await join(command.guildId, command.channelId);
      if (command.type === "leave") leave();
    } catch (error) {
      console.warn(`Command ${command?.type} failed:`, error.message);
      socket.send(JSON.stringify({ type: "error", message: String(error.message ?? error) }));
    }
  });
});

async function sendChannelList(socket) {
  if (!client.isReady()) return;

  const guilds = [];
  for (const [, partial] of await client.guilds.fetch()) {
    const guild = await partial.fetch();
    const channels = (await guild.channels.fetch())
      .filter(channel => channel?.type === ChannelType.GuildVoice)
      .map(channel => ({ id: channel.id, name: channel.name }));

    if (channels.length) guilds.push({ id: guild.id, name: guild.name, channels });
  }

  socket.send(JSON.stringify({ type: "channels", guilds }));
}

function statusMessage() {
  return {
    type: "status",
    joined: !!connection,
    guildId: state.guildId,
    channelId: state.channelId,
    guildName: state.guildName ?? null,
    channelName: state.channelName ?? null
  };
}

function sendStatus(socket) {
  const data = JSON.stringify(statusMessage());
  if (socket) {
    if (socket.readyState === 1) socket.send(data);
    return;
  }
  broadcast(statusMessage());
}

function broadcast(message) {
  const data = JSON.stringify(message);
  for (const client of wss.clients) {
    if (client.readyState === 1) client.send(data);
  }
}

/* --- Speaking state ---------------------------------------------------------
 *
 * Discord reports speaking only at its start and its end. The Foundry side
 * clears a highlight that has gone quiet for a few seconds, so that someone
 * who drops out of the channel mid-sentence is not left lit forever. To keep
 * a long monologue lit, everyone currently speaking is re-announced on a
 * short heartbeat.
 */
const speaking = new Set();
const HEARTBEAT_MS = 3000;

setInterval(() => {
  for (const discordId of speaking) {
    broadcast({ type: "speaking", discordId, speaking: true });
  }
}, HEARTBEAT_MS);

function markSpeaking(discordId, isSpeaking) {
  if (isSpeaking) speaking.add(discordId);
  else speaking.delete(discordId);
  broadcast({ type: "speaking", discordId, speaking: isSpeaking });
}

/* --- Discord side ---------------------------------------------------------- */

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates]
});

let connection = null;

/** Stops listening and clears every highlight, without stopping the process. */
function leave({ remember = true } = {}) {
  for (const discordId of [...speaking]) markSpeaking(discordId, false);

  connection?.destroy();
  connection = null;

  if (remember) {
    state.joined = false;
    saveState();
  }

  console.log("Left the voice channel.");
  sendStatus();
}

async function join(guildId = state.guildId, channelId = state.channelId) {
  if (!guildId || !channelId) throw new Error("No voice channel chosen yet.");

  // Switching rooms: drop the old connection first, keeping the memory of
  // where we are heading.
  if (connection) leave({ remember: false });

  const guild = await client.guilds.fetch(guildId);
  const channel = await guild.channels.fetch(channelId);

  connection = joinVoiceChannel({
    channelId,
    guildId,
    adapterCreator: guild.voiceAdapterCreator,
    // Speaking events are only delivered to a member that is not deafened.
    selfDeaf: false,
    selfMute: true
  });

  await entersState(connection, VoiceConnectionStatus.Ready, 30_000);
  console.log(`Joined ${guild.name} / ${channel?.name ?? channelId}; relaying speaking events.`);

  Object.assign(state, {
    guildId,
    channelId,
    guildName: guild.name,
    channelName: channel?.name ?? null,
    joined: true
  });
  saveState();
  sendStatus();

  connection.receiver.speaking.on("start", userId => markSpeaking(userId, true));
  connection.receiver.speaking.on("end", userId => markSpeaking(userId, false));

  // Rejoin if the connection drops (server restart, kicked, network blip).
  connection.on(VoiceConnectionStatus.Disconnected, async () => {
    try {
      await Promise.race([
        entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
        entersState(connection, VoiceConnectionStatus.Connecting, 5_000)
      ]);
    } catch {
      connection?.destroy();
      connection = null;
      // Only come back if we are still meant to be in a channel.
      if (state.joined) setTimeout(() => join().catch(console.error), 5_000);
    }
  });
}

// Someone leaving or moving channel while talking never sends "end".
client.on(Events.VoiceStateUpdate, (before, after) => {
  if (before.channelId === state.channelId && after.channelId !== state.channelId) {
    if (speaking.has(before.id)) markSpeaking(before.id, false);
  }
});

/*
 * discord.js renamed "ready" to "clientReady" and warns about the old name.
 * Pick whichever the installed version provides, so the bridge runs cleanly
 * on both the current release and the next major one.
 */
const READY_EVENT = Object.values(Events).includes("clientReady") ? "clientReady" : "ready";

client.once(READY_EVENT, () => {
  console.log(`Logged in as ${client.user.tag}. WebSocket on :${PORT}`);

  if (!state.joined || !state.guildId || !state.channelId) {
    console.log("Waiting: choose a voice channel from Foundry (모듈 설정 → 연결 관리).");
    return;
  }

  join().catch(error => {
    // A room that has gone away must not take the whole bridge down with it.
    console.error("Could not rejoin the last voice channel:", error.message);
    state.joined = false;
    saveState();
  });
});

/* --- Leaving cleanly -------------------------------------------------------
 *
 * pm2 stop (and Ctrl+C) send a signal and then kill the process. Killed
 * outright, the bot never tells Discord it is leaving, and Discord can keep
 * showing it sitting in the voice channel — a "ghost" that stays until
 * something else refreshes that channel's state.
 *
 * So: leave the voice channel and close the gateway first, then exit. The
 * remembered channel is NOT cleared, so starting the bridge again brings the
 * bot back to the same room.
 */
let shuttingDown = false;

function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;

  console.log(`Shutting down (${signal}); leaving the voice channel first.`);

  try {
    connection?.destroy();
  } catch (error) {
    console.warn("Voice disconnect failed:", error.message);
  }
  connection = null;

  // Give the gateway a moment to deliver the disconnect, but never hang.
  const done = () => process.exit(0);
  Promise.resolve()
    .then(() => client.destroy())
    .catch(error => console.warn("Discord logout failed:", error.message))
    .finally(done);

  setTimeout(done, 3000).unref();
}

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => shutdown(signal));
}

client.login(DISCORD_TOKEN);
