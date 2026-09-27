import { MODULE_ID, SimpleWindow, esc, localizeMaybe, readDragData, setting } from "./shared.mjs";

/* ======================================================================== *
 * Time of day + scene lighting (no SmallTime needed)
 * ======================================================================== */

function timeOfDay() {
  const dt = game.pf2e?.worldClock?.worldTime;
  if (dt && Number.isFinite(dt.hour)) return { h: dt.hour, m: dt.minute, label: dt.toFormat?.("yyyy.LL.dd") ?? "" };
  const s = ((game.time.worldTime % 86400) + 86400) % 86400;
  return { h: Math.floor(s / 3600), m: Math.floor((s % 3600) / 60), label: "" };
}

function phaseOf(h, m) {
  const t = h + m / 60;
  if (t >= 7 && t < 18) return { name: "낮", icon: "fa-sun" };
  if (t >= 5 && t < 7) return { name: "새벽", icon: "fa-cloud-sun" };
  if (t >= 18 && t < 20) return { name: "황혼", icon: "fa-cloud-moon" };
  return { name: "밤", icon: "fa-moon" };
}

/** 0 = full daylight, 1 = full night, with 2-hour dawn and dusk. */
function darknessFor(h, m) {
  const t = h + m / 60;
  if (t >= 7 && t < 18) return 0;
  if (t >= 20 || t < 5) return 1;
  if (t < 7) return 1 - (t - 5) / 2;
  return (t - 18) / 2;
}

function pf2eSyncsDarkness() {
  try { return !!game.settings.get("pf2e", "worldClock.syncDarkness"); } catch { return false; }
}

async function syncDarkness() {
  if (!game.users.activeGM?.isSelf || !setting("timeDarknessSync", true) || pf2eSyncsDarkness()) return;
  const scene = canvas?.scene;
  if (!scene || scene.getFlag(MODULE_ID, "noTimeSync")) return;
  const { h, m } = timeOfDay();
  const max = Math.clamp(Number(setting("timeDarknessMax", 0.85)) || 0.85, 0, 1);
  const target = Math.round(darknessFor(h, m) * max * 100) / 100;
  const current = Number(scene.environment?.darknessLevel ?? scene.darkness ?? 0);
  if (Math.abs(current - target) < 0.02) return;
  await scene.update({ "environment.darknessLevel": target }, { animateDarkness: 3000 });
}

async function setTimeOfDay(hh, mm) {
  const { h, m } = timeOfDay();
  let delta = (hh * 60 + mm - (h * 60 + m)) * 60;
  if (delta < 0) delta += 86400;
  if (delta) await game.time.advance(delta);
}

/* ======================================================================== *
 * Chat panel: calendar clock on top, dice bar floating above the input.
 * Neither is inserted into Foundry's chat layout (parts of it overlay that
 * area and swallowed the clicks); the dice bar is fixed-position and the chat
 * log gets matching bottom padding so no message hides behind it.
 * ======================================================================== */

const DICE = [
  { n: 4, icon: "fa-dice-d4" }, { n: 6, icon: "fa-dice-d6" }, { n: 8, icon: "fa-dice-d8" },
  { n: 10, icon: "fa-dice-d10" }, { n: 12, icon: "fa-dice-d12" }, { n: 20, icon: "fa-dice-d20" },
  { n: 100, icon: "fa-dice-d10", label: "%" }
];

function phaseEmoji(h, m) {
  const t = h + m / 60;
  if (t >= 7 && t < 18) return "☀️";
  if (t >= 5 && t < 7) return "🌅";
  if (t >= 18 && t < 20) return "🌇";
  return "🌙";
}

/** Date in PF2e's own calendar (Golarion or the world's setting), plus time. */
function calendarText() {
  const { h, m } = timeOfDay();
  const wc = game.pf2e?.worldClock;
  let date = "";
  try { date = wc?.date ?? ""; } catch (_) { date = ""; }
  if (!date) {
    const dt = wc?.worldTime;
    date = dt?.setLocale ? dt.setLocale(game.i18n.lang || "ko").toFormat("yyyy년 M월 d일 cccc") : "";
  }
  return { date, time: `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`, emoji: phaseEmoji(h, m), phase: phaseOf(h, m).name };
}

function clockHtml() {
  const c = calendarText();
  return `<span class="emoji">${c.emoji}</span><span class="date">${esc(c.date)}</span><b class="time">${c.time}</b>`;
}

function mountClock() {
  const root = ui.chat?.element?.[0] ?? ui.chat?.element;
  if (!setting("chatDock", true) || !root?.prepend) return;
  let clock = document.getElementById("pkh-clock");
  if (!clock) {
    clock = document.createElement("button");
    clock.type = "button";
    clock.id = "pkh-clock";
    clock.addEventListener("click", () => { if (game.user.isGM) openClock(clock); });
  }
  if (clock.parentElement !== root) root.prepend(clock);
  clock.innerHTML = clockHtml();
  clock.dataset.tooltip = `${calendarText().phase}${game.user.isGM ? " · 눌러서 시간 조절" : ""}`;
}

function mountDice() {
  let bar = document.getElementById("pkh-dice");
  if (!setting("chatDock", true)) { bar?.remove(); return; }
  if (!bar) {
    bar = document.createElement("section");
    bar.id = "pkh-dice";
    bar.innerHTML = `${DICE.map(d => `<button type="button" data-die="${d.n}" data-tooltip="1d${d.n}<br><small>Shift: 2개</small>">
        <i class="fa-solid ${d.icon}"></i>${d.label ? `<b>${d.label}</b>` : ""}</button>`).join("")}
      <span class="sep"></span>
      ${[5, 11].map(dc => `<button type="button" class="flat" data-flat="${dc}" data-tooltip="플랫 체크 DC ${dc}${dc === 5 ? "<br><small>숨겨짐·집중 방해 등</small>" : "<br><small>은폐·감지 등</small>"}">
        <i class="fa-solid fa-dice-d20"></i><b>${dc}</b></button>`).join("")}`;
    bar.addEventListener("click", onDiceClick);
    document.body.appendChild(bar);
  }
  placeDice();
}

/** Sit just above the chat input, as wide as it; reserve that height in the log. */
function placeDice() {
  const bar = document.getElementById("pkh-dice");
  const root = ui.chat?.element?.[0] ?? ui.chat?.element;
  const input = root?.querySelector?.("#chat-message, .chat-form, form, prose-mirror");
  const box = input?.getBoundingClientRect?.();
  const visible = !!bar && !!box && box.width > 0 && root.offsetParent !== null;
  bar?.classList.toggle("hidden", !visible);
  if (!visible) return;
  const controls = root.querySelector("#roll-privacy, .roll-privacy, .chat-controls, #chat-controls");
  const top = Math.min(box.top, controls?.getBoundingClientRect?.().top ?? box.top);
  bar.style.left = `${Math.round(box.left)}px`;
  bar.style.width = `${Math.round(box.width)}px`;
  bar.style.top = `${Math.round(top - bar.offsetHeight - 4)}px`;
  root.style.setProperty("--pkh-dice-h", `${bar.offsetHeight + 6}px`);
  root.classList.add("pkh-has-dice");
}

function refreshClocks() {
  mountClock();
}

async function onDiceClick(ev) {
  const die = ev.target.closest("[data-die]");
  if (die) {
    const count = ev.shiftKey ? 2 : 1;
    const roll = await new Roll(`${count}d${die.dataset.die}`).evaluate();
    return roll.toMessage({ speaker: ChatMessage.getSpeaker(), flavor: `${count}d${die.dataset.die}` });
  }
  const flat = ev.target.closest("[data-flat]");
  if (flat) {
    const dc = Number(flat.dataset.flat);
    const roll = await new Roll("1d20").evaluate();
    const ok = roll.total >= dc;
    return roll.toMessage({
      speaker: ChatMessage.getSpeaker(),
      flavor: `플랫 체크 DC ${dc} — <b style="color:${ok ? "#3f7f2f" : "#a83a2f"}">${ok ? "성공" : "실패"}</b>`
    });
  }
}

function openClock(anchor) {
  document.getElementById("pkh-clock-pop")?.remove();
  const pop = document.createElement("section");
  pop.id = "pkh-clock-pop";
  const { h, m } = timeOfDay();
  const noSync = !!canvas?.scene?.getFlag(MODULE_ID, "noTimeSync");
  pop.innerHTML = `
    <div class="row">${[["-3600", "−1시간"], ["-600", "−10분"], ["600", "+10분"], ["3600", "+1시간"], ["28800", "+8시간"]]
      .map(([s, l]) => `<button type="button" data-adv="${s}">${l}</button>`).join("")}</div>
    <div class="row">${[["6:00", "아침"], ["12:00", "정오"], ["18:00", "저녁"], ["0:00", "자정"]]
      .map(([t, l]) => `<button type="button" data-set="${t}">${l}</button>`).join("")}
      <input type="time" value="${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}"><button type="button" data-act="go">이동</button></div>
    <label class="row"><input type="checkbox" ${noSync ? "" : "checked"} data-act="sync"> 이 장면 조명을 시간에 맞추기</label>
    ${pf2eSyncsDarkness() ? `<p class="hint">PF2e 월드 시계의 '장면 어둠 동기화'가 켜져 있어 그쪽이 조명을 맞춥니다.</p>` : ""}`;
  document.body.appendChild(pop);
  const box = anchor.getBoundingClientRect();
  pop.style.left = `${Math.max(8, Math.min(window.innerWidth - pop.offsetWidth - 8, box.left))}px`;
  pop.style.top = `${Math.max(8, box.top - pop.offsetHeight - 6)}px`;
  pop.addEventListener("click", async e => {
    const b = e.target.closest("button, input[type=checkbox]");
    if (!b) return;
    if (b.dataset.adv) await game.time.advance(Number(b.dataset.adv));
    else if (b.dataset.set) await setTimeOfDay(...b.dataset.set.split(":").map(Number));
    else if (b.dataset.act === "go") await setTimeOfDay(...pop.querySelector("input[type=time]").value.split(":").map(Number));
    else if (b.dataset.act === "sync") {
      await canvas.scene?.setFlag(MODULE_ID, "noTimeSync", !b.checked);
      if (b.checked) await syncDarkness();
      return;
    }
    pop.remove();
  });
  setTimeout(() => document.addEventListener("pointerdown", function close(e) {
    if (!pop.contains(e.target)) { pop.remove(); document.removeEventListener("pointerdown", close, true); }
  }, true), 0);
}

/* ======================================================================== *
 * Roll request & macro generator (GM)
 * ======================================================================== */

// PF2e level-based DCs (GM Core table 10-5) and difficulty adjustments.
const LEVEL_DC = [14, 15, 16, 18, 19, 20, 22, 23, 24, 26, 27, 28, 30, 31, 32, 34, 35, 36, 38, 39, 40, 42, 44, 46, 48, 50];
const ADJUST = { "-10": "믿기 힘들 만큼 쉬움", "-5": "매우 쉬움", "-2": "쉬움", "0": "보통", "2": "어려움", "5": "매우 어려움", "10": "믿기 힘들 만큼 어려움" };
const SAVES = { fortitude: "인내", reflex: "반사", will: "의지" };

function checkOptions() {
  const skills = Object.entries(CONFIG.PF2E?.skills ?? {})
    .map(([slug, v]) => ({ slug, label: localizeMaybe(v?.label ?? v) || slug }))
    .sort((a, b) => a.label.localeCompare(b.label, "ko"));
  return [{ slug: "perception", label: "지각" }, ...Object.entries(SAVES).map(([slug, label]) => ({ slug, label, save: true })), ...skills];
}

function requestContent({ checks, dc, secret, basic, note }) {
  const parts = checks.map(c => {
    const params = [c.slug];
    if (dc) params.push(`dc:${dc}`);
    if (basic && SAVES[c.slug]) params.push("basic");
    if (secret) params.push("traits:secret");
    return `@Check[${params.join("|")}]`;
  });
  return `<div class="pkh-save-request"><header><i class="fa-solid fa-dice-d20"></i> <strong>굴림 요청</strong>${dc ? ` — DC <b>${dc}</b>` : ""}${secret ? " <em>(비밀)</em>" : ""}</header>
    ${note ? `<p>${esc(note)}</p>` : ""}<div class="checks">${parts.join(" ")}</div></div>`;
}

export function openRollRequest() {
  if (!game.user.isGM) return;
  const opts = checkOptions();
  const html = `<div class="pkh-request">
    <div class="pkh-req-grid">${opts.map(o => `<label class="${o.save ? "save" : ""}"><input type="checkbox" value="${o.slug}"> ${esc(o.label)}</label>`).join("")}</div>
    <div class="pkh-req-row">DC <input type="number" name="dc" min="0" max="60" style="width:70px" placeholder="없음">
      <span class="hint">레벨</span><select name="lv">${LEVEL_DC.map((d, i) => `<option value="${i}">${i}</option>`).join("")}</select>
      <select name="adj">${Object.entries(ADJUST).map(([v, l]) => `<option value="${v}" ${v === "0" ? "selected" : ""}>${l}</option>`).join("")}</select>
      <button type="button" data-act="lvdc">레벨 DC 넣기</button></div>
    <div class="pkh-req-row"><label><input type="checkbox" name="secret"> 비밀 굴림</label>
      <label><input type="checkbox" name="basic"> 기본 내성</label>
      <input type="text" name="note" placeholder="설명 (선택): 예) 함정이 작동합니다!" style="flex:1"></div>
    <div class="pkh-req-row"><input type="text" name="mname" placeholder="매크로 이름 (예: 함정 반사 DC 20)" style="flex:1">
      <button type="button" data-act="macro"><i class="fa-solid fa-scroll"></i> 매크로로 저장</button>
      <button type="button" data-act="send" class="primary"><i class="fa-solid fa-paper-plane"></i> 채팅에 보내기</button></div>
    <p class="hint">플레이어는 카드의 버튼으로 자기 캐릭터를 굴리고, GM은 토큰을 선택한 뒤 눌러 NPC를 굴립니다. 매크로는 GM 팔레트 빈칸에 자동으로 들어갑니다.</p>
  </div>`;
  new SimpleWindow({
    id: `${MODULE_ID}-roll-request`, title: "굴림 요청 · 매크로 만들기", width: 560, html,
    onRender: (root, app) => {
      const read = () => ({
        checks: [...root.querySelectorAll(".pkh-req-grid input:checked")].map(i => opts.find(o => o.slug === i.value)),
        dc: Number(root.querySelector("[name=dc]").value) || null,
        secret: root.querySelector("[name=secret]").checked,
        basic: root.querySelector("[name=basic]").checked,
        note: root.querySelector("[name=note]").value.trim()
      });
      root.addEventListener("click", async ev => {
        const act = ev.target.closest("button[data-act]")?.dataset.act;
        if (act === "lvdc") {
          const lv = Number(root.querySelector("[name=lv]").value);
          root.querySelector("[name=dc]").value = LEVEL_DC[lv] + Number(root.querySelector("[name=adj]").value);
          return;
        }
        if (act !== "send" && act !== "macro") return;
        const data = read();
        if (!data.checks.length) return ui.notifications.warn("PF2e-KR HUD | 굴림을 하나 이상 고르세요.");
        const content = requestContent(data);
        if (act === "send") {
          await ChatMessage.create({ speaker: ChatMessage.getSpeaker({ alias: "GM" }), content });
          return app.close();
        }
        const name = root.querySelector("[name=mname]").value.trim()
          || `${data.checks.map(c => c.label).join("·")}${data.dc ? ` DC ${data.dc}` : ""}`;
        const macro = await Macro.create({
          name, type: "script", img: "icons/svg/d20-highlight.svg",
          command: `ChatMessage.create({ speaker: ChatMessage.getSpeaker({ alias: "GM" }), content: ${JSON.stringify(content)} });`
        });
        const placed = await game.pkhPalette?.addEntry({ type: "macro", uuid: macro.uuid });
        ui.notifications.info(`PF2e-KR HUD | 매크로 "${name}"을 만들었습니다${placed ? " — GM 팔레트에 넣었습니다" : ""}.`);
      });
    }
  }).render({ force: true });
}

/* ======================================================================== *
 * GM palette: a small always-on grid of macros / effects / conditions that
 * apply to whichever tokens are selected.
 * ======================================================================== */

const SIZES = { "3x2": [3, 2], "4x2": [4, 2], "4x3": [4, 3], "5x3": [5, 3], "6x2": [6, 2] };

class GmPalette {
  constructor() { this.el = null; }

  data() {
    return foundry.utils.mergeObject({ slots: [], x: null, y: null, locked: true, open: false },
      game.user.getFlag(MODULE_ID, "palette") ?? {}, { inplace: false });
  }

  async save(changes) {
    await game.user.setFlag(MODULE_ID, "palette", { ...this.data(), ...changes });
  }

  async toggle() {
    await this.save({ open: !this.data().open });
    this.render();
  }

  async addEntry(entry) {
    const d = this.data();
    const [c, r] = SIZES[setting("paletteSize", "3x2")] ?? [3, 2];
    const slots = Array.from({ length: c * r }, (_, i) => d.slots[i] ?? null);
    const i = slots.findIndex(s => !s);
    if (i < 0) return false;
    slots[i] = entry;
    await this.save({ slots, open: true });
    this.render();
    return true;
  }

  render() {
    if (!game.user.isGM) return;
    const d = this.data();
    if (!d.open) { this.el?.remove(); this.el = null; return; }
    const [cols, rows] = SIZES[setting("paletteSize", "3x2")] ?? [3, 2];
    if (!this.el) {
      this.el = document.createElement("section");
      this.el.id = "pkh-palette";
      document.body.appendChild(this.el);
      this.el.addEventListener("click", ev => this.onClick(ev));
      this.el.addEventListener("contextmenu", ev => this.onContext(ev));
      this.el.addEventListener("dragover", ev => { if (!this.data().locked) ev.preventDefault(); });
      this.el.addEventListener("drop", ev => this.onDrop(ev));
      this.el.addEventListener("pointerdown", ev => this.onDragWindow(ev));
    }
    const cells = Array.from({ length: cols * rows }, (_, i) => {
      const e = d.slots[i];
      if (!e) return `<div class="cell empty" data-i="${i}"></div>`;
      const doc = e.uuid ? fromUuidSync(e.uuid) : null;
      const name = e.name ?? doc?.name ?? "?";
      const img = e.img ?? doc?.img ?? "icons/svg/mystery-man.svg";
      return `<div class="cell t-${e.type}" data-i="${i}" data-tooltip="${esc(name)}<br><small>${e.type === "condition" ? "클릭 +1 · 우클릭 −1" : e.type === "effect" ? "클릭: 넣기/빼기" : "클릭: 실행"} · 선택한 토큰에</small>">
        <img src="${esc(img)}" alt=""></div>`;
    }).join("");
    this.el.classList.toggle("unlocked", !d.locked);
    this.el.style.setProperty("--cols", cols);
    this.el.style.setProperty("--pal-opacity", String(setting("paletteOpacity", 0.75)));
    this.el.innerHTML = `
      <header data-drag>
        <span>GM 팔레트</span>
        <button type="button" data-act="lock" data-tooltip="${d.locked ? "잠김 — 눌러서 편집(이동·추가·제거)" : "편집 중 — 끌어서 이동, 끌어다 놓아 추가, 우클릭 제거"}"><i class="fa-solid ${d.locked ? "fa-lock" : "fa-lock-open"}"></i></button>
        <button type="button" data-act="close" data-tooltip="닫기"><i class="fa-solid fa-xmark"></i></button>
      </header>
      <div class="grid">${cells}</div>`;
    const x = d.x ?? window.innerWidth - 360;
    const y = d.y ?? 120;
    this.el.style.left = `${Math.max(0, Math.min(window.innerWidth - 60, x))}px`;
    this.el.style.top = `${Math.max(0, Math.min(window.innerHeight - 40, y))}px`;
  }

  targets() {
    return (canvas?.tokens?.controlled ?? []).map(t => t.actor).filter(a => a?.isOwner);
  }

  async onClick(ev) {
    const act = ev.target.closest("button[data-act]")?.dataset.act;
    if (act === "lock") { await this.save({ locked: !this.data().locked }); return this.render(); }
    if (act === "close") return this.toggle();
    const cell = ev.target.closest(".cell:not(.empty)");
    if (!cell) return;
    const e = this.data().slots[Number(cell.dataset.i)];
    if (e.type === "macro") return (await fromUuid(e.uuid))?.execute();
    const targets = this.targets();
    if (!targets.length) return ui.notifications.warn("PF2e-KR HUD | 먼저 토큰을 선택하세요.");
    if (e.type === "condition") for (const a of targets) await a.increaseCondition?.(e.slug);
    if (e.type === "effect") await toggleEffect(targets, e.uuid);
  }

  async onContext(ev) {
    ev.preventDefault();
    const cell = ev.target.closest(".cell:not(.empty)");
    if (!cell) return;
    const d = this.data();
    const i = Number(cell.dataset.i);
    if (!d.locked) {
      const slots = [...d.slots];
      slots[i] = null;
      await this.save({ slots });
      return this.render();
    }
    const e = d.slots[i];
    const targets = this.targets();
    if (e.type === "condition") for (const a of targets) await a.decreaseCondition?.(e.slug);
    if (e.type === "effect") await toggleEffect(targets, e.uuid, { removeOnly: true });
  }

  async onDrop(ev) {
    const d = this.data();
    if (d.locked) return;
    ev.preventDefault();
    const data = readDragData(ev);
    const cell = ev.target.closest(".cell");
    let entry = null;
    if (data?.type === "Macro" && data.uuid) entry = { type: "macro", uuid: data.uuid };
    else if (data?.type === "Item" && data.uuid) {
      const doc = await fromUuid(data.uuid);
      if (doc?.type === "condition") entry = { type: "condition", slug: doc.slug, name: doc.name, img: doc.img };
      else if (doc?.type === "effect") entry = { type: "effect", uuid: doc.parent ? (doc._stats?.compendiumSource ?? doc.uuid) : doc.uuid };
    }
    if (!entry) return ui.notifications.warn("PF2e-KR HUD | 매크로, 효과, 상태만 올릴 수 있습니다.");
    const [c, r] = SIZES[setting("paletteSize", "3x2")] ?? [3, 2];
    const slots = Array.from({ length: c * r }, (_, i) => d.slots[i] ?? null);
    const at = cell ? Number(cell.dataset.i) : slots.findIndex(s => !s);
    if (at < 0) return ui.notifications.warn("PF2e-KR HUD | 빈칸이 없습니다.");
    slots[at] = entry;
    await this.save({ slots });
    this.render();
  }

  onDragWindow(ev) {
    if (this.data().locked || !ev.target.closest("[data-drag]") || ev.target.closest("button")) return;
    const el = this.el;
    const start = { x: ev.clientX - el.offsetLeft, y: ev.clientY - el.offsetTop };
    const move = e => { el.style.left = `${e.clientX - start.x}px`; el.style.top = `${e.clientY - start.y}px`; };
    const up = () => {
      document.removeEventListener("pointermove", move);
      document.removeEventListener("pointerup", up);
      this.save({ x: el.offsetLeft, y: el.offsetTop });
    };
    document.addEventListener("pointermove", move);
    document.addEventListener("pointerup", up);
  }
}

async function toggleEffect(targets, uuid, { removeOnly = false } = {}) {
  const source = await fromUuid(uuid);
  if (!source) return;
  const slug = source.slug ?? source.system?.slug;
  for (const actor of targets) {
    const existing = actor.itemTypes?.effect?.find(e =>
      (e._stats?.compendiumSource ?? e.flags?.core?.sourceId) === uuid || (slug && e.slug === slug));
    if (existing) await existing.delete();
    else if (!removeOnly) {
      const data = source.toObject();
      delete data._id;
      data._stats = { ...(data._stats ?? {}), compendiumSource: source.uuid };
      await actor.createEmbeddedDocuments("Item", [data]);
    }
  }
}

/* ======================================================================== *
 * Health estimate on hover (for tokens you can't see the HP of)
 * ======================================================================== */

function healthLevels() {
  const text = String(setting("healthLevels", "") || "75:가벼운 부상|50:부상|25:심한 부상|1:죽음의 문턱");
  return text.split("|").map(p => p.split(":")).map(([pct, label]) => ({ pct: Number(pct), label: (label ?? "").trim() }))
    .filter(l => Number.isFinite(l.pct) && l.label).sort((a, b) => b.pct - a.pct);
}

export function healthEstimate(actor) {
  const hp = actor?.system?.attributes?.hp;
  if (!hp || !Number(hp.max)) return null;
  const pct = Math.max(0, Number(hp.value)) / Number(hp.max) * 100;
  if (pct <= 0) return { label: setting("healthZero", "쓰러짐") || "쓰러짐", pct };
  if (pct >= 100) return { label: setting("healthFull", "멀쩡함") || "멀쩡함", pct };
  const hit = healthLevels().find(l => pct >= l.pct);
  return { label: hit?.label ?? healthLevels().at(-1)?.label ?? "", pct };
}

let hoverEl = null;
function showHealth(token, hovered) {
  hoverEl ??= Object.assign(document.body.appendChild(document.createElement("div")), { id: "pkh-health" });
  const actor = token?.actor;
  const visibleHp = actor?.testUserPermission(game.user, "OBSERVER");
  const allowed = hovered && actor && setting("healthOnHover", true) && (!visibleHp || (game.user.isGM && setting("healthShowGM", false)));
  const est = allowed ? healthEstimate(actor) : null;
  if (!est) { hoverEl.classList.add("hidden"); return; }
  const b = token.bounds ?? { x: token.x, y: token.y, width: token.w, height: token.h };
  const point = { x: b.x + b.width / 2, y: b.y };
  const screen = canvas.clientCoordinatesFromCanvas?.(point) ?? canvas.stage.worldTransform.apply(point);
  const hue = Math.round(Math.min(100, est.pct) * 1.2);
  hoverEl.innerHTML = `<span style="--h:${hue}">${esc(est.label)}</span>`;
  hoverEl.classList.remove("hidden");
  hoverEl.style.left = `${Math.round(screen.x)}px`;
  hoverEl.style.top = `${Math.round(screen.y - 8)}px`;
}

/* ======================================================================== */

export function registerGmToolSettings() {
  const redock = () => { document.getElementById("pkh-clock")?.remove(); mountClock(); mountDice(); };
  const s = (key, data) => game.settings.register(MODULE_ID, key, data);
  s("chatDock", { name: "채팅창 시계와 주사위", hint: "채팅창 맨 위에 날짜·시간, 입력칸 위에 주사위와 플랫 체크(5·11) 버튼을 띄웁니다.", scope: "client", config: true, type: Boolean, default: true, onChange: redock });
  s("timeDarknessSync", { name: "시간에 맞춰 장면 조명 조절", hint: "게임 시간이 바뀌면 현재 장면의 어둠을 낮·새벽·황혼·밤에 맞춥니다 (장면별로 끌 수 있음). PF2e 월드 시계의 동기화가 켜져 있으면 그쪽이 우선합니다.", scope: "world", config: true, type: Boolean, default: true });
  s("timeDarknessMax", { name: "한밤중 어둠 정도", scope: "world", config: true, type: Number, default: 0.85, range: { min: 0.3, max: 1, step: 0.05 } });
  s("paletteSize", { name: "GM 팔레트 크기", scope: "client", config: true, type: String, default: "3x2", choices: Object.fromEntries(Object.keys(SIZES).map(k => [k, `${k.replace("x", " × ")}칸`])), onChange: () => game.pkhPalette?.render() });
  s("paletteOpacity", { name: "GM 팔레트 투명도", hint: "마우스를 올리면 불투명해집니다.", scope: "client", config: true, type: Number, default: 0.75, range: { min: 0.2, max: 1, step: 0.05 }, onChange: () => game.pkhPalette?.render() });
  s("healthOnHover", { name: "토큰에 마우스를 올리면 체력 상태 표시", hint: "HP를 볼 권한이 없는 토큰(보통 NPC)에 '가벼운 부상' 같은 대략적인 상태만 보여줍니다.", scope: "world", config: true, type: Boolean, default: true });
  s("healthShowGM", { name: "GM에게도 체력 상태 표시", scope: "client", config: true, type: Boolean, default: false });
  s("healthFull", { name: "체력 상태: 최대일 때", scope: "world", config: true, type: String, default: "멀쩡함" });
  s("healthLevels", { name: "체력 상태 단계", hint: "\"퍼센트:이름\"을 |로 구분. 그 퍼센트 이상이면 그 이름. 예) 75:가벼운 부상|50:부상|25:심한 부상|1:죽음의 문턱", scope: "world", config: true, type: String, default: "75:가벼운 부상|50:부상|25:심한 부상|1:죽음의 문턱" });
  s("healthZero", { name: "체력 상태: 0일 때", scope: "world", config: true, type: String, default: "쓰러짐" });
}

export function initGmTools() {
  document.body.classList.toggle("pkh-gm", game.user.isGM);
  const palette = new GmPalette();
  game.pkhPalette = palette;
  palette.render();
  mountClock();
  mountDice();
  Hooks.on("renderChatLog", () => { mountClock(); mountDice(); });
  Hooks.on("changeSidebarTab", () => setTimeout(() => { mountClock(); placeDice(); }, 50));
  Hooks.on("collapseSidebar", () => setTimeout(placeDice, 300));
  window.addEventListener("resize", () => placeDice());
  setInterval(placeDice, 1500); // chat input grows/shrinks with its toolbar
  Hooks.on("updateWorldTime", () => { refreshClocks(); syncDarkness(); });
  Hooks.on("canvasReady", () => syncDarkness());
  Hooks.on("hoverToken", (token, hovered) => showHealth(token, hovered));
  Hooks.on("canvasPan", () => hoverEl?.classList.add("hidden"));
  Hooks.on("updateActor", () => hoverEl?.classList.add("hidden"));
  game.pf2eKrHud = { ...(game.pf2eKrHud ?? {}), openRollRequest, palette };
}
