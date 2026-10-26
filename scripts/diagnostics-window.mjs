import { MODULE_ID, t } from "./shared.mjs";
import { aliveContexts, askReports, chatAudit, diag, dsnImmediate, gpuName, mapLostNow, packageName, perfLabel, performanceMode, setDsnImmediate, summary, topContexts, unverified } from "./diagnostics.mjs";

/* ======================================================================== *
 * 진단 window: this computer's session at a glance, what to do about it
 * (with buttons where a setting can be changed here), the details, and —
 * for the GM — every player's report.
 * ======================================================================== */

const esc = v => foundry.utils.escapeHTML(String(v ?? ""));
const time = ms => new Date(ms).toLocaleTimeString(game.i18n.lang, { hour: "2-digit", minute: "2-digit" });
const PERF = () => CONST.CANVAS_PERFORMANCE_MODES ?? { LOW: 0, MED: 1, HIGH: 2, MAX: 3 };
const CHAT_CODE = "screen-2.2.1";
const secs = ms => new Date(ms).toLocaleTimeString(game.i18n.lang, { hour: "2-digit", minute: "2-digit", second: "2-digit" });
const SOFT_GPU = /swiftshader|llvmpipe|microsoft basic|software/i;
const WEAK_GPU = /intel|uhd|iris|hd graphics|mali|adreno|apple m1(?! (pro|max))/i;

/** What the missing files point to: { lines: [{ group, count, why }], caseClash, percent }. */
function missingAdvice() {
  const groups = new Map();
  const lower = new Map();
  let percent = 0;
  for (const [path, m] of diag.missing) {
    const g = groups.get(m.group) ?? { group: m.group, count: 0, paths: [] };
    g.count++;
    if (g.paths.length < 4) g.paths.push(path);
    groups.set(m.group, g);
    const key = path.toLowerCase();
    lower.set(key, (lower.get(key) ?? 0) + 1);
    if (/%(?![0-9a-f]{2})/i.test(path)) percent++;
  }
  const caseClash = [...lower.values()].some(n => n > 1);
  const lines = [...groups.values()].sort((a, b) => b.count - a.count).map(g => {
    const m = /^modules\/(.+)$/.exec(g.group);
    let why = "";
    if (m) {
      const mod = game.modules.get(m[1]);
      why = !mod ? t("Diag.Why.NotInstalled", { id: m[1] }) : !mod.active ? t("Diag.Why.Inactive", { id: mod.title }) : t("Diag.Why.FileGone", { id: mod.title });
    } else if (!/^(systems|worlds)\//.test(g.group)) why = t("Diag.Why.UserFiles", { folder: g.group });
    return { ...g, why };
  });
  return { lines, caseClash, percent };
}

/** Suggestions, most useful first: { text, button?: { act, label } }. */
function suggestions() {
  const out = [];
  const perf = performanceMode();
  const P = PERF();
  const gpu = gpuName();
  const lost = mapLostNow();
  if (lost) out.push({ level: "bad", text: t("Diag.Tip.Lost"), button: { act: "reload", label: t("Diag.Reload") } });
  if (SOFT_GPU.test(gpu)) out.push({ level: "bad", text: t("Diag.Tip.NoAccel", { gpu }) });
  const alive = aliveContexts();
  const many = alive >= 10;
  if (many) out.push({ level: "warn", text: t("Diag.Tip.Many", { n: alive, top: topContexts(3) }) });
  // One module making canvas after canvas: most likely the same one again and again (a leak).
  const byPkg = new Map();
  for (const c of diag.contexts) {
    if (c.src.kind === "core" || c.src.kind === "unknown") continue;
    const e = byPkg.get(c.src.id) ?? { src: c.src, n: 0, alive: 0 };
    e.n++;
    if (!c.lost && c.ref.deref()) e.alive++;
    byPkg.set(c.src.id, e);
  }
  for (const e of [...byPkg.values()].filter(x => x.n >= 5).sort((a, b) => b.n - a.n)) {
    out.push({ level: "bad", text: t("Diag.Tip.Leaky", { name: packageName(e.src), n: e.n, alive: e.alive }) });
  }
  if (diag.released) out.push({ level: "info", text: t("Diag.Tip.Released", { n: diag.released }) });
  if (perf !== null && perf > P.LOW && (lost || many || WEAK_GPU.test(gpu))) {
    out.push({ level: "warn", text: t("Diag.Tip.Perf", { now: perfLabel(perf), next: perfLabel(perf - 1) }), button: { act: "perf-down", label: t("Diag.PerfDown") } });
  }
  const fps = (() => { try { return Number(game.settings.get("core", "maxFPS")); } catch (_) { return null; } })();
  if (fps && fps > 30 && (lost || many || WEAK_GPU.test(gpu))) out.push({ level: "warn", text: t("Diag.Tip.Fps", { fps }), button: { act: "fps-30", label: t("Diag.Fps30") } });
  const dsn = dsnImmediate();
  const dsnErrors = diag.errors.get("module:dice-so-nice")?.count ?? 0;
  if (dsn === false) out.push({ level: diag.rescued || dsnErrors ? "warn" : "info", text: t("Diag.Tip.Dsn", { rescued: diag.rescued, errors: dsnErrors }), button: { act: "dsn-immediate", label: t("Diag.DsnOn") } });
  else if (diag.rescued) out.push({ level: "info", text: t("Diag.Tip.Rescued", { n: diag.rescued }) });
  for (const e of [...diag.errors.values()].sort((a, b) => b.count - a.count).slice(0, 5)) {
    if (e.src.kind === "core" || e.src.kind === "unknown") continue;
    const old = e.src.kind === "module" && unverified(e.src.id);
    out.push({ level: e.count >= 5 ? "warn" : "info", text: `${t("Diag.Tip.Errors", { name: packageName(e.src), n: e.count })}${old ? ` ${t("Diag.Tip.Unverified", { gen: game.release?.generation ?? "" })}` : ""}` });
  }
  const audit = chatAudit();
  if (audit.version !== CHAT_CODE) out.push({ level: "bad", text: t("Diag.Tip.OldChat", { version: audit.version ?? "-" }), button: { act: "reload", label: t("Diag.Reload") } });
  const mixed = audit.rows.filter(r => r.issues.includes("mixed")).length;
  if (mixed) out.push({ level: "bad", text: t("Diag.Tip.Mixed", { n: mixed }) });
  for (const c of audit.clocks) out.push({ level: "warn", text: t("Diag.Tip.Clock", { user: c.name, s: Math.round(Math.abs(c.skew) / 1000) }) });
  const miss = missingAdvice();
  if (diag.missing.size) out.push({ level: "info", text: t("Diag.Tip.Missing", { n: diag.missing.size }) });
  if (miss.caseClash) out.push({ level: "warn", text: t("Diag.Tip.Case") });
  if (miss.percent) out.push({ level: "warn", text: t("Diag.Tip.Percent", { n: miss.percent }) });
  if (!out.length) out.push({ level: "ok", text: t("Diag.Tip.AllGood") });
  return out;
}

/** The same in plain text, for pasting into Discord. */
function textReport() {
  const s = summary();
  const lines = [
    `[${game.user.name}] ${t("Diag.Since", { time: time(diag.started) })} · Foundry ${game.version ?? game.release?.version ?? ""} · ${game.system.id} ${game.system.version}`,
    `GPU: ${s.gpu || "?"} · ${t("Diag.PerfMode")}: ${perfLabel(s.perf)} · ${t("Diag.MapGraphics")}: ${s.mapLost ? t("Diag.Lost") : t("Diag.Ok")}`,
    `WebGL: ${s.alive} / ${s.contexts} (${topContexts(5) || "-"}) · released ${diag.released}`,
    `${t("Diag.Rescues")}: ${diag.rescued}`,
    `${t("Diag.Errors")}:`,
    ...[...diag.errors.values()].sort((a, b) => b.count - a.count).map(e => `  - ${packageName(e.src)} ×${e.count}: ${[...e.samples.keys()].slice(0, 2).join(" | ")}`),
    `${t("Diag.Chat")} (${chatAudit().version ?? "old"}):`,
    ...chatAudit(20).rows.map(r => `  ${secs(r.time)} ${r.grouped ? "  ↳" : "■"} [${r.user} / ${r.alias}${r.actor ? ` / a:${r.actor}` : ""}${r.token ? ` t:${r.token}` : ""}${r.style !== null ? ` s:${r.style}` : ""}] ${r.typed ? "" : "(card) "}${r.text}${r.issues.length ? `   <<< ${r.issues.join(",")}` : ""}`),
    ...chatAudit().clocks.map(c => `  clock: ${c.name} ${Math.round(c.skew / 1000)}s`),
    `${t("Diag.Missing")}: ${diag.missing.size}`,
    ...[...diag.missing.entries()].slice(0, 30).map(([p, m]) => `  - ${m.status || "?"} ${decodeURIComponentSafe(p)}`)
  ];
  return lines.join("\n");
}

function decodeURIComponentSafe(p) {
  try { return decodeURIComponent(p); } catch (_) { return p; }
}

export class DiagnosticsWindow extends foundry.applications.api.ApplicationV2 {
  static DEFAULT_OPTIONS = {
    id: "pkh-diagnostics",
    classes: ["pkh-window", "pkh-diag-window"],
    window: { title: "PKH.Diag.Title", icon: "fa-solid fa-stethoscope", resizable: true },
    position: { width: 760, height: 680 }
  };

  /** One window: opening it again brings the open one up. */
  render(...args) {
    const open = foundry.applications.instances.get("pkh-diagnostics");
    if (open && open !== this) { open.render(true); open.bringToFront?.(); return open; }
    this._hook ??= Hooks.on("pkhDiagnosticsReport", () => { if (this.rendered) this.render(); });
    return super.render(...args);
  }

  async _renderHTML() {
    const s = summary();
    const tips = suggestions().map(x => `<li class="${x.level}"><span>${esc(x.text)}</span>${x.button ? `<button type="button" data-act="${x.button.act}">${esc(x.button.label)}</button>` : ""}</li>`).join("");
    const card = (label, value, cls = "") => `<div class="stat ${cls}"><small>${esc(label)}</small><b>${esc(value)}</b></div>`;
    const ctxRows = diag.contexts.map(c => `<tr class="${c.lost && !c.released ? "lost" : ""}"><td>${c.n}</td><td>${esc(packageName(c.src))}</td><td>${esc(c.type)}</td><td>${time(c.at)}</td><td>${c.released ? `${t("Diag.ReleasedOne")} ${time(c.released)}` : c.lost ? `${t("Diag.Lost")} ${time(c.lost)}${c.restored ? ` → ${t("Diag.Restored")}` : ""}` : ""}</td></tr>`).join("");
    const errRows = [...diag.errors.values()].sort((a, b) => b.count - a.count).map(e => `<tr><td>${esc(packageName(e.src))}${e.src.kind === "module" && unverified(e.src.id) ? ` <span class="tag">${esc(t("Diag.NotVerified"))}</span>` : ""}</td><td>${e.count}</td>
        <td>${[...e.samples].map(([text, n]) => `<div class="sample">${esc(text)}${n > 1 ? ` <small>×${n}</small>` : ""}</div>`).join("")}</td></tr>`).join("");
    const miss = missingAdvice();
    const missRows = miss.lines.map(g => `<tr><td>${esc(g.group)}</td><td>${g.count}</td><td>${g.why ? `<div>${esc(g.why)}</div>` : ""}${g.paths.map(p => `<div class="path">${esc(decodeURIComponentSafe(p))}</div>`).join("")}</td></tr>`).join("");
    const reports = game.user.isGM ? this.reportsHtml() : "";
    return `<div class="pkh-diag">
      <p class="lead">${esc(t("Diag.Lead", { time: time(diag.started) }))}</p>
      <div class="stats">
        ${card(t("Diag.MapGraphics"), s.mapLost ? t("Diag.Lost") : t("Diag.Ok"), s.mapLost ? "bad" : "ok")}
        ${card(t("Diag.WebglNow"), `${s.alive} / ${s.contexts}`, s.alive >= 12 ? "bad" : s.alive >= 8 ? "warn" : "")}
        ${card(t("Diag.Errors"), `${[...diag.errors.values()].reduce((n, e) => n + e.count, 0)}`)}
        ${card(t("Diag.Missing"), `${diag.missing.size}`)}
        ${card(t("Diag.Rescues"), `${diag.rescued}`)}
        ${card(t("Diag.PerfMode"), perfLabel(s.perf))}
      </div>
      <p class="gpu"><i class="fa-solid fa-microchip"></i> ${esc(s.gpu || t("Diag.GpuUnknown"))}</p>
      <h3>${esc(t("Diag.Suggestions"))}</h3>
      <ul class="tips">${tips}</ul>
      <details ${diag.errors.size ? "open" : ""}><summary>${esc(t("Diag.Errors"))} (${diag.errors.size})</summary>
        <table><thead><tr><th>${esc(t("Diag.Package"))}</th><th>#</th><th>${esc(t("Diag.Message"))}</th></tr></thead><tbody>${errRows || `<tr><td colspan="3">${esc(t("Diag.None"))}</td></tr>`}</tbody></table></details>
      <details><summary>${esc(t("Diag.Missing"))} (${diag.missing.size})</summary>
        <table><thead><tr><th>${esc(t("Diag.Where"))}</th><th>#</th><th>${esc(t("Diag.Files"))}</th></tr></thead><tbody>${missRows || `<tr><td colspan="3">${esc(t("Diag.None"))}</td></tr>`}</tbody></table></details>
      ${this.chatHtml()}
      <details><summary>WebGL (${diag.contexts.length})</summary>
        <p class="hint">${esc(t("Diag.WebglHint"))}</p>
        <table><thead><tr><th>#</th><th>${esc(t("Diag.Package"))}</th><th></th><th>${esc(t("Diag.When"))}</th><th></th></tr></thead><tbody>${ctxRows || `<tr><td colspan="5">${esc(t("Diag.None"))}</td></tr>`}</tbody></table></details>
      ${reports}
    </div>
    <footer class="pkh-diag-foot">
      <button type="button" data-act="copy"><i class="fa-solid fa-copy"></i> ${esc(t("Diag.Copy"))}</button>
      ${game.user.isGM ? `<button type="button" data-act="ask"><i class="fa-solid fa-satellite-dish"></i> ${esc(t("Diag.Ask"))}</button>` : ""}
      <span class="grow"></span>
      <button type="button" data-act="refresh"><i class="fa-solid fa-arrows-rotate"></i> ${esc(t("Diag.Refresh"))}</button>
      <button type="button" data-act="reload"><i class="fa-solid fa-rotate-right"></i> ${esc(t("Diag.Reload"))}</button>
    </footer>`;
  }

  chatHtml() {
    const a = chatAudit();
    const bad = a.rows.some(r => r.issues.length);
    const word = { mixed: t("Diag.Issue.mixed"), order: t("Diag.Issue.order"), time: t("Diag.Issue.time") };
    const rows = a.rows.map(r => `<tr class="${r.issues.includes("mixed") ? "lost" : r.issues.length ? "odd" : ""}"><td>${secs(r.time)}</td><td>${r.grouped ? "↳" : ""}</td>
        <td>${esc(r.user)}</td><td>${esc(r.alias)}</td><td>${r.typed ? "" : `<span class="tag">${esc(t("Diag.Card"))}</span> `}${esc(r.text)}</td><td>${r.issues.map(i => esc(word[i] ?? i)).join(", ")}</td></tr>`).join("");
    return `<details ${bad ? "open" : ""}><summary>${esc(t("Diag.Chat"))} (${a.rows.length}) · ${esc(t("Diag.ChatCode"))} ${esc(a.version ?? "-")}</summary>
      <p class="hint">${esc(t("Diag.ChatHint"))}</p>
      <table><thead><tr><th>${esc(t("Diag.When"))}</th><th></th><th>${esc(t("Diag.Player"))}</th><th>${esc(t("Diag.Speaker"))}</th><th>${esc(t("Diag.Message"))}</th><th></th></tr></thead>
      <tbody>${rows || `<tr><td colspan="6">${esc(t("Diag.None"))}</td></tr>`}</tbody></table></details>`;
  }

  reportsHtml() {
    const rows = [...diag.reports.values()].sort((a, b) => a.user.localeCompare(b.user, game.i18n.lang)).map(r => {
      const top = Object.entries(r.contextsBy ?? {}).sort((a, b) => b[1] - a[1]).slice(0, 2).map(([id, n]) => `${id} ${n}`).join(", ");
      const errs = (r.errors ?? []).slice(0, 3).map(e => `${packageName(e.src)} ×${e.count}`).join(", ");
      const bad = r.mapLost || (r.alive ?? r.contexts) >= 12;
      return `<tr class="${bad ? "lost" : ""}"><td><b>${esc(r.user)}</b><small>${time(r.at)}</small></td><td>${r.mapLost ? esc(t("Diag.Lost")) : esc(t("Diag.Ok"))}</td>
        <td>${r.alive ?? "?"} / ${r.contexts}${top ? ` <small>(${esc(top)})</small>` : ""}</td><td>${esc(errs || "-")}</td><td>${r.missing}</td><td>${r.rescued}</td>
        <td>${esc(perfLabel(r.perf))}${r.dsn === false ? ` <span class="tag">DSN</span>` : ""}${r.chat !== CHAT_CODE ? ` <span class="tag">${esc(t("Diag.OldCode"))}</span>` : ""}</td><td class="gpu">${esc(r.gpu || "?")}</td></tr>`;
    }).join("");
    return `<h3>${esc(t("Diag.Players"))}</h3>
      <p class="hint">${esc(t("Diag.PlayersHint"))}</p>
      <table class="reports"><thead><tr><th>${esc(t("Diag.Player"))}</th><th>${esc(t("Diag.MapGraphics"))}</th><th>WebGL</th><th>${esc(t("Diag.Errors"))}</th><th>${esc(t("Diag.Missing"))}</th><th>${esc(t("Diag.Rescues"))}</th><th>${esc(t("Diag.PerfMode"))}</th><th>GPU</th></tr></thead>
      <tbody>${rows || `<tr><td colspan="8">${esc(t("Diag.NoReports"))}</td></tr>`}</tbody></table>`;
  }

  _replaceHTML(html, content) {
    const top = content.querySelector(".pkh-diag")?.scrollTop ?? 0;
    const open = [...content.querySelectorAll("details")].map(d => d.open);
    content.innerHTML = html;
    const body = content.querySelector(".pkh-diag");
    if (body) body.scrollTop = top;
    content.querySelectorAll("details").forEach((d, i) => { if (open[i] !== undefined) d.open = open[i]; });
    if (this._wired === content) return;
    this._wired = content;
    content.addEventListener("click", ev => this.onClick(ev));
  }

  async onClick(ev) {
    const el = ev.target.closest("[data-act]");
    if (!el) return;
    ev.preventDefault();
    const P = PERF();
    switch (el.dataset.act) {
      case "reload": return window.location.reload();
      case "refresh": return this.render();
      case "copy": {
        const text = textReport();
        try { await navigator.clipboard.writeText(text); ui.notifications.info(t("Diag.Copied")); }
        catch (_) { foundry.applications.api.DialogV2.prompt({ window: { title: t("Diag.Copy") }, content: `<textarea style="width:100%;height:300px" readonly>${esc(text)}</textarea>`, rejectClose: false }).catch(() => {}); }
        return;
      }
      case "ask": askReports(); ui.notifications.info(t("Diag.Asked")); return;
      case "perf-down": {
        const now = performanceMode();
        if (now === null || now <= P.LOW) return;
        await game.settings.set("core", "performanceMode", now - 1);
        ui.notifications.info(t("Diag.PerfChanged", { mode: perfLabel(now - 1) }));
        return this.render();
      }
      case "fps-30": await game.settings.set("core", "maxFPS", 30); ui.notifications.info(t("Diag.FpsChanged")); return this.render();
      case "dsn-immediate": await setDsnImmediate(); ui.notifications.info(t("Diag.DsnChanged")); return this.render();
    }
  }

  async close(options) {
    if (this._hook) Hooks.off("pkhDiagnosticsReport", this._hook);
    this._hook = null;
    return super.close(options);
  }
}

export function openDiagnostics() {
  const open = foundry.applications.instances.get("pkh-diagnostics");
  if (open) { open.render(true); return open; }
  const app = new DiagnosticsWindow();
  app.render(true);
  return app;
}

export function registerDiagnosticsSettings() {
  game.settings.registerMenu(MODULE_ID, "diagMenu", {
    name: "PKH.Diag.Title", label: "PKH.Diag.Open", hint: "PKH.Diag.MenuHint",
    icon: "fa-solid fa-stethoscope", type: DiagnosticsWindow, restricted: false
  });
  game.settings.register(MODULE_ID, "diagWatch", {
    name: "PKH.Settings.diagWatch.Name", hint: "PKH.Settings.diagWatch.Hint",
    scope: "client", config: true, type: Boolean, default: true
  });
  game.settings.register(MODULE_ID, "diagGuard", {
    name: "PKH.Settings.diagGuard.Name", hint: "PKH.Settings.diagGuard.Hint",
    scope: "client", config: true, type: Boolean, default: true
  });
  game.settings.register(MODULE_ID, "chatRescue", {
    name: "PKH.Settings.chatRescue.Name", hint: "PKH.Settings.chatRescue.Hint",
    scope: "client", config: true, type: Boolean, default: true
  });
}
