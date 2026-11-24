/**
 * The editions of a module, built from one source tree.  (rutz-tools 2026-11-23d)
 *
 *   node tools/edition.mjs plus   [--out dist] [--sale]   → the paid module (구매판) = the source as it is
 *   node tools/edition.mjs lite   [--out dist] [--sale]   → the free module (무료판): plusFiles and @plus blocks left out
 *   node tools/edition.mjs trial  [--out dist] [--sale]   → the trial module (체험판): also trialFiles and @full blocks
 *   node tools/edition.mjs public [--out dist] [--sale]   → the edition edition.json "public" names
 *   node tools/edition.mjs check                          → package ids, what lite / trial leave out, the markers
 *
 * Kinds: no edition.json = a free module (one edition, everything public). With edition.json the source is
 * the paid module (id as in module.json, sold through the hub) and "public" names what goes to GitHub:
 * "lite" (default), "trial", or "plus" (open beta).
 *
 * edition.json (module root):
 *   { "public": "lite" | "trial" | "plus",
 *     "plusFiles":  ["scripts/stage/", "scripts/menu.mjs"],  // left out of lite and trial
 *     "trialFiles": ["scripts/barks.mjs"],                   // also left out of trial
 *     "plus":  { "description": "…" },                       // module.json overrides, per edition
 *     "lite":  { "title": "…", "description": "…" },
 *     "trial": { "title": "…", "styles": […], "readme": "README.trial.md", "readmeKo": "README.trial.ko.md" } }
 *
 * lite and trial are modules of their own: id <id>-lite / <id>-trial, title "<title> Lite" / "<title> (Trial)"
 * unless the edition block names one. "lite": { "id": "<free id>", "title": "…" } (trial likewise) builds that
 * package id instead; with an id the title is required. In such a build:
 *   - module.json: id, title, flags[<id>] moved to flags[<built id>] (with .edition and .rests = <id>), the
 *     edition's overrides;
 *     url / manifest / download stay the public repo's;
 *   - every shipped text file has the module's id rewritten to the built id (see ID_TOKEN), except inside
 *     GitHub URLs (the repo keeps its name) and on lines that carry `@paid-id`;
 *   - every script that uses Hooks gets a module-scoped Hooks from <scripts>/_rest.mjs: while the paid module is
 *     active in the world, Hooks.on / once register nothing (the free module rests);
 *   - scripts/edition.mjs becomes `export const PLUS = false;` (+ `TRIAL` when the source exports it, or in a trial);
 *   - a left-out script becomes a stub with the same exports; other left-out files are not shipped;
 *   - `// @plus` … `// @end-plus` lines are cut (trial: also `// @full` … `// @end-full`) in .mjs/.js/.cjs/.css/
 *     .hbs/.html, in line, block, HTML or Handlebars comments;
 *   - the written folder is checked: a marker left, a left-out file shipped, or the paid id left as a bare token
 *     stops the build (folder removed, no zip).
 *
 * --out <dir> (default dist) writes <dir>/<label>/<module.json id>/, <dir>/<module.json id>-<label>.zip and
 * <dir>/<edition>-module.json (what tools/release.mjs uploads). label = the edition; with --sale "sale"
 * ("trial-sale"), a direct-install copy without manifest/download.
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const ROOT = process.cwd();
const [edition, ...args] = process.argv.slice(2);
const SALE = args.includes("--sale");
const FREE = !fs.existsSync(path.join(ROOT, "edition.json"));
const conf = FREE ? { public: "plus", plusFiles: [] } : JSON.parse(fs.readFileSync(path.join(ROOT, "edition.json"), "utf8"));
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "module.json"), "utf8"));
// media/ holds screenshots and GIFs for README and the Foundry package page, not the module.
const SKIP = new Set([".git", ".github", ".private", "dist", "node_modules", "tools", "media", "edition.json", ".gitignore", ".DS_Store"]);
// Free modules keep their tools/ folder (helpers that ship with them); only these are left out.
const FREE_SKIP = new Set([".git", ".github", ".private", "dist", "node_modules", "media", ".gitignore", ".DS_Store", "Thumbs.db", ".vscode"]);
const FREE_SKIP_FILES = new Set(["tools/edition.mjs", "tools/release.mjs", "tools/update-pages.mjs", "tools/local.config.json", "tools/last-release.json"]);
const freeLeftOut = rel => FREE_SKIP_FILES.has(rel) || /(^|\/)(node_modules|\.DS_Store|LOG|LOG\.old)(\/|$)/.test(rel) || /(^|\/)package-lock\.json$|\.env$/.test(rel);
const TEXT = /\.(mjs|js|cjs|css|hbs|html)$/;
const SCRIPT = /\.(mjs|js)$/;

const norm = p => p.replace(/\\/g, "/");
const inList = (list, rel) => (list ?? []).some(p => (p.endsWith("/") ? norm(rel).startsWith(p) : norm(rel) === p));
const isPlusFile = rel => inList(conf.plusFiles, rel);
const isTrialFile = rel => inList(conf.trialFiles, rel);
const HAS_TRIAL = !FREE && !!(conf.trial || conf.trialFiles || conf.public === "trial");
/** Left out of this edition (stubbed when a script, else not shipped). */
const leftOut = (rel, ed) => ed !== "plus" && (isPlusFile(rel) || (ed === "trial" && isTrialFile(rel)));
const tagsFor = ed => (ed === "trial" ? ["plus", "full"] : ed === "lite" ? ["plus"] : []);

/* ---------------- the free and trial editions as modules of their own ---------------- */

const PAID_ID = manifest.id;
const SUFFIX = { lite: "-lite", trial: "-trial" };
/** A package id as this tool accepts one: lowercase letters, digits, single hyphens between them. */
const PACKAGE_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
/** The id edition.json names for lite / trial, or null. */
const namedId = ed => (FREE || !SUFFIX[ed] || conf[ed]?.id === undefined ? null : conf[ed].id);
/** The package id an edition is built as (the paid one and a free module keep module.json's). */
const builtId = ed => (FREE || !SUFFIX[ed] ? PAID_ID : namedId(ed) ?? `${PAID_ID}${SUFFIX[ed]}`);
/** edition.json's named ids: well formed, titled, not the paid id, lite and trial apart. */
function checkIds() {
  if (FREE) return;
  if (conf.plus && "id" in conf.plus) throw new Error(`edition.json plus.id: the paid id is module.json's (${PAID_ID}); remove plus.id`);
  for (const ed of Object.keys(SUFFIX)) {
    const id = namedId(ed);
    if (id === null) continue;
    if (typeof id !== "string" || !PACKAGE_ID.test(id)) throw new Error(`edition.json ${ed}.id: ${JSON.stringify(id)} is not a package id (lowercase letters, digits and hyphens)`);
    if (id === PAID_ID) throw new Error(`edition.json ${ed}.id: ${id} is module.json's id (the paid module)`);
    if (typeof conf[ed].title !== "string" || !conf[ed].title.trim()) throw new Error(`edition.json ${ed}.title: required with ${ed}.id`);
  }
  if ((namedId("lite") !== null || namedId("trial") !== null) && builtId("lite") === builtId("trial")) throw new Error(`edition.json: lite and trial are both ${builtId("lite")}`);
}
const renamed = ed => builtId(ed) !== PAID_ID;
const reEsc = s => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/**
 * The paid id as a whole token: no letter, digit, "_", "$" or "-" right before or after it. So "modules/<id>/x",
 * "module.<id>", "flags.<id>.x", `"<id>"` match; "<id>-extra", "x-<id>" and an id already followed by
 * "-lite" / "-trial" do not.
 */
const ID_SRC = `(?<![\\w$-])${reEsc(PAID_ID)}(?![\\w$-])`;
const ID_TOKEN = new RegExp(ID_SRC, "g");
const HAS_ID = new RegExp(ID_SRC);
/** A GitHub address (github.com/…, raw.githubusercontent.com/…) up to a space, quote or bracket: the public repo keeps its name. */
const GH_URL = /(?:https?:\/\/)?(?:www\.)?(?:github\.com|raw\.githubusercontent\.com)\/[^\s"'`<>()[\]{}\\]+/g;
/** A line that carries this marker keeps the paid id. */
const PAID_MARK = "@paid-id";
/** Text files whose id is rewritten (binaries and anything else ship as they are). */
const TEXT_ANY = /\.(mjs|js|cjs|css|hbs|handlebars|html|htm|json|md|txt|ya?ml|csv|xml)$/i;
const isText = (rel, buf) => TEXT_ANY.test(rel) && !buf.includes(0);

/** fn on every piece of the line outside GitHub URLs; the URLs as they are. */
function outsideUrls(line, fn) {
  let out = "", at = 0;
  for (const m of line.matchAll(GH_URL)) { out += fn(line.slice(at, m.index)) + m[0]; at = m.index + m[0].length; }
  return out + fn(line.slice(at));
}
const counts = { ids: 0, urls: 0, marked: 0 };
/** The paid id → `to`, except in GitHub URLs and on @paid-id lines. */
function rewriteId(text, to) {
  return text.split("\n").map(line => {
    if (!HAS_ID.test(line)) return line;
    if (line.includes(PAID_MARK)) { counts.marked++; return line; }
    for (const m of line.matchAll(GH_URL)) if (HAS_ID.test(m[0])) counts.urls++;
    return outsideUrls(line, part => part.replace(ID_TOKEN, () => { counts.ids++; return to; }));
  }).join("\n");
}

const ESM = new Set((manifest.esmodules ?? []).map(f => norm(f).replace(/^\.\//, "")));
/** The rest stand-in: in scripts/ when every entry script is there, else next to the first entry. */
const REST = (() => {
  const entries = [...ESM];
  const dir = !entries.length || entries.every(f => f.startsWith("scripts/")) ? "scripts" : path.posix.dirname(entries[0]);
  return dir === "." ? "_rest.mjs" : `${dir}/_rest.mjs`;
})();
const isEsm = (rel, text) => /\.mjs$/.test(rel) || (/\.js$/.test(rel) && (ESM.has(norm(rel)) || /^\s*(import|export)\s/m.test(text)));
const USES_HOOKS = /(?<![\w$.])Hooks\s*\??\./;
const OWN_HOOKS = /\b(?:const|let|var|function|class)\s+Hooks\b|\bimport\s*\{[^}]*\bHooks\b/;
const IMPORT_START = /^\s*import\s*(?:[\w${*]|["'])/;
const IMPORT_END = /["'][^"']*["']\s*(?:(?:with|assert)\s*\{[^}]*\}\s*)?;?\s*(?:\/\/.*)?$/;
const REST_LINE = "const Hooks = __rutzRestHooks();";
const warnings = [];

/** <REST>: Hooks.on / once register nothing while the paid module is active; decided at each call. */
const restMjs = ed => `// ${builtId(ed)}: Hooks.on / once register nothing while ${PAID_ID} is active in the world; the rest passes through.
const PAID = "${PAID_ID}";
const SELF = "${builtId(ed)}";
let told = false;
/** true / false once game.modules is there, null before. */
function paidActive() {
  try { const mods = globalThis.game?.modules; return typeof mods?.get === "function" ? !!mods.get(PAID)?.active : null; } catch { return null; }
}
function rest() {
  if (!told) { told = true; console.log(\`\${SELF} | \${PAID} is active: this module rests.\`); }
}
export function restHooks() {
  return new Proxy({}, {
    get(_, key) {
      const real = globalThis.Hooks;
      if (key !== "on" && key !== "once") { const v = real?.[key]; return typeof v === "function" ? v.bind(real) : v; }
      return (name, fn, options) => {
        const paid = paidActive();
        if (paid) { rest(); return undefined; }
        // Not known yet (game not set up): the callback asks again when it runs.
        const call = paid === null && typeof fn === "function" ? (...a) => (paidActive() ? rest() : fn(...a)) : fn;
        return globalThis.Hooks[key](name, call, options);
      };
    }
  });
}
`;

/** After the script's last top-level import: a module-scoped Hooks from <REST>. */
function withRest(text, rel) {
  if (!USES_HOOKS.test(text)) return text;
  if (OWN_HOOKS.test(text)) throw new Error(`${rel}: declares its own Hooks, so the rest stand-in cannot go in`);
  const lines = text.split("\n");
  let at = 0;
  for (let i = 0; i < lines.length; i++) {
    if (!IMPORT_START.test(lines[i])) continue;
    let j = i;
    while (j < lines.length - 1 && !IMPORT_END.test(lines[j])) j++;
    at = j + 1;
    i = j;
  }
  const early = lines.slice(0, at).findIndex(l => !IMPORT_START.test(l) && USES_HOOKS.test(l) && !/^\s*(\/\/|\/?\*)/.test(l));
  if (early >= 0) throw new Error(`${rel}:${early + 1}: Hooks used before the last import`);
  let spec = path.posix.relative(path.posix.dirname(norm(rel)), REST);
  if (!spec.startsWith(".")) spec = `./${spec}`;
  lines.splice(at, 0, `import { restHooks as __rutzRestHooks } from "${spec}";`, REST_LINE);
  if (/(?:globalThis|window|self)\s*\.\s*Hooks\s*\??\.\s*(on|once)\b/.test(text)) warnings.push(`${rel}: globalThis.Hooks.on/once bypasses the stand-in`);
  return lines.join("\n");
}

/** A shipped text file of a renamed edition: id rewritten; a module script also gets the stand-in. */
function renameText(rel, buf, ed) {
  if (!renamed(ed) || !isText(rel, buf)) return buf;
  const src = buf.toString("utf8");
  let text = rewriteId(src, builtId(ed));
  if (SCRIPT.test(rel)) {
    if (isEsm(rel, text)) text = withRest(text, rel);
    else if (USES_HOOKS.test(text)) warnings.push(`${rel}: not an ES module, so it has no stand-in`);
  }
  return text === src ? buf : Buffer.from(text);
}

/** The Trial's README files: { "README.md": "README.trial.md", … } (paths inside the module, never README.md itself). */
const TRIAL_README = (() => {
  const out = {};
  for (const [to, key] of [["README.md", "readme"], ["README.ko.md", "readmeKo"]]) {
    const from = conf.trial?.[key];
    if (from === undefined) continue;
    const rel = norm(String(from)).replace(/^\.\//, "");
    if (!rel || path.isAbsolute(rel) || rel.split("/").includes("..") || rel === "README.md" || rel === "README.ko.md") throw new Error(`edition.json trial.${key}: a file in the module folder such as README.trial.md`);
    out[to] = rel;
  }
  return out;
})();
const readmeSource = rel => Object.values(TRIAL_README).includes(norm(rel));

const argAfter = name => { const i = args.indexOf(name); return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : null; };
const OUT = path.resolve(ROOT, argAfter("--out") ?? "dist");

/** scripts/edition.mjs of a left-out edition. */
function editionMjs(ed, source) {
  const trial = ed === "trial" || /^export\s+const\s+TRIAL\b/m.test(source);
  return `export const PLUS = false;\n${trial ? `export const TRIAL = ${ed === "trial"};\n` : ""}`;
}

/** First line of every stub: what the post-build check looks for. */
const stubHead = (rel, ed) => (ed === "trial" ? `// ${rel}: not in the Trial edition.` : `// ${rel}: Plus edition only (this is the Lite edition).`);

/** Same exports, no behaviour. */
function stubFor(source, rel, ed = "lite") {
  const lines = [stubHead(rel, ed)];
  const names = new Set();
  const add = (name, kind) => {
    if (names.has(name)) return;
    names.add(name);
    if (kind === "class") lines.push(`export class ${name} {}`);
    else if (kind === "fn") lines.push(`export function ${name}() { return null; }`);
    else lines.push(`export const ${name} = Object.freeze({});`);
  };
  for (const m of source.matchAll(/^export\s+(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/gm)) add(m[1], "fn");
  for (const m of source.matchAll(/^export\s+class\s+([A-Za-z_$][\w$]*)/gm)) add(m[1], "class");
  for (const m of source.matchAll(/^export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)/gm)) add(m[1], "const");
  for (const m of source.matchAll(/^export\s*\{([^}]+)\}/gm)) {
    for (const part of m[1].split(",")) {
      const name = part.trim().split(/\s+as\s+/).pop()?.trim();
      if (name && name !== "default") add(name, "fn");
    }
  }
  if (/^export\s+default\b/m.test(source)) lines.push("export default null;");
  return `${lines.join("\n")}\n`;
}

const startRe = tag => new RegExp(`(?:\\/\\/|\\/\\*|<!--|\\{\\{!--)\\s*@${tag}\\b(?!-)`);
const endRe = tag => new RegExp(`@end-${tag}\\b`);

/**
 * Removes the `tags` blocks ("plus": // @plus … // @end-plus, "full": // @full … // @end-full).
 * Markers of the other tags stay as they are (they are comments); every tag is checked for pairs.
 */
function stripBlocks(text, rel, tags = ["plus"]) {
  const out = [];
  const depth = { plus: 0, full: 0 };
  for (const line of text.split("\n")) {
    let marker = false;
    for (const tag of Object.keys(depth)) {
      if (startRe(tag).test(line) && !new RegExp(`@end-${tag}`).test(line)) { depth[tag]++; marker = tags.includes(tag); }
      else if (endRe(tag).test(line)) {
        if (depth[tag] === 0) throw new Error(`${rel}: @end-${tag} without @${tag}`);
        depth[tag]--;
        marker = tags.includes(tag);
      }
    }
    if (marker) continue;
    if (tags.every(tag => depth[tag] === 0)) out.push(line);
  }
  for (const tag of Object.keys(depth)) if (depth[tag]) throw new Error(`${rel}: @${tag} without @end-${tag}`);
  return out.join("\n");
}

function transform(rel, buf, ed) {
  if (ed === "plus") return buf;
  if (norm(rel) === "scripts/edition.mjs") return Buffer.from(editionMjs(ed, buf.toString("utf8")));
  if (leftOut(rel, ed)) return SCRIPT.test(rel) ? Buffer.from(stubFor(buf.toString("utf8"), rel, ed)) : null;
  const cut = TEXT.test(rel) ? Buffer.from(stripBlocks(buf.toString("utf8"), rel, tagsFor(ed))) : buf;
  return renameText(rel, cut, ed);
}

function moduleJsonFor(ed) {
  const m = structuredClone(manifest);
  if (!FREE) {
    const { readme, readmeKo, id, ...overrides } = conf[ed] ?? {};
    if (renamed(ed)) {
      m.id = builtId(ed);
      m.title = ed === "trial" ? `${manifest.title} (Trial)` : `${manifest.title} Lite`;
      // flags[<id>] is the package's own (pf2e reads flags[<package id>]["pf2e-homebrew"], pf2e.mjs:55027)
      if (m.flags && PAID_ID in m.flags) m.flags = Object.fromEntries(Object.entries(m.flags).map(([k, v]) => [k === PAID_ID ? m.id : k, v]));
    }
    Object.assign(m, overrides);
    m.flags ??= {};
    m.flags[m.id] = { ...(m.flags[m.id] ?? {}), edition: ed, ...(renamed(ed) ? { rests: PAID_ID } : {}) };
  }
  // A copy sold for direct install: no update address, or Foundry's "update" would swap it for
  // the public GitHub release.
  if (SALE) { delete m.manifest; delete m.download; }
  return m;
}

/** Never in a module zip: a wiki clone or any other git repository inside, zip files at the top. */
const stray = (entry, rel, dir) => entry.name === ".git" || (entry.isDirectory() && (/\.wiki$/i.test(entry.name) || fs.existsSync(path.join(dir, entry.name, ".git"))))
  || (!rel && entry.isFile() && /\.zip$/i.test(entry.name));

function walk(dir, rel = "") {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!rel && (FREE ? FREE_SKIP : SKIP).has(entry.name)) continue;
    if (stray(entry, rel, dir)) continue;
    // the build folder itself (--out inside the module): earlier builds must never be packed again
    if (entry.isDirectory() && path.resolve(dir, entry.name) === OUT) continue;
    const r = rel ? `${rel}/${entry.name}` : entry.name;
    if (FREE && freeLeftOut(r)) continue;
    if (entry.isDirectory()) out.push(...walk(path.join(dir, entry.name), r));
    else if (r !== "module.json" && !readmeSource(r)) out.push(r);
  }
  return out;
}

function build(ed, target) {
  for (const rel of walk(ROOT)) {
    const data = transform(rel, fs.readFileSync(path.join(ROOT, rel)), ed);
    if (data === null) continue;
    const dest = path.join(target, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, data);
  }
  if (ed === "trial") {
    for (const [to, from] of Object.entries(TRIAL_README)) {
      if (!fs.existsSync(path.join(ROOT, from))) throw new Error(`edition.json trial: ${from} is not there`);
      fs.writeFileSync(path.join(target, to), renameText(to, fs.readFileSync(path.join(ROOT, from)), ed));
    }
  }
  if (renamed(ed)) {
    if (fs.existsSync(path.join(ROOT, REST))) throw new Error(`${REST}: the build writes this file; rename the source file`);
    fs.mkdirSync(path.dirname(path.join(target, REST)), { recursive: true });
    fs.writeFileSync(path.join(target, REST), restMjs(ed));
  }
  fs.writeFileSync(path.join(target, "module.json"), `${JSON.stringify(moduleJsonFor(ed), null, 2)}\n`);
}

/** Every file under dir, relative, "/"-separated. */
const filesIn = (dir, rel = "") => fs.readdirSync(path.join(dir, rel), { withFileTypes: true })
  .flatMap(e => (e.isDirectory() ? filesIn(dir, rel ? `${rel}/${e.name}` : e.name) : [rel ? `${rel}/${e.name}` : e.name]));

/**
 * A public build (lite, trial) as written: no left-out file shipped as it is, and no @plus (Trial: @full)
 * marker anywhere — in any file type — so nothing from inside a block can have slipped through.
 */
function verify(ed, target) {
  const tags = tagsFor(ed);
  if (!tags.length) return;
  const problems = [];
  for (const rel of filesIn(target)) {
    const buf = fs.readFileSync(path.join(target, rel));
    if (leftOut(rel, ed) && !(SCRIPT.test(rel) && buf.toString("utf8").startsWith(`${stubHead(rel, ed)}\n`))) problems.push(`${rel}: left out of ${ed}, but shipped`);
    if (buf.includes(0)) continue;  // binary
    const text = buf.toString("utf8");
    for (const tag of tags) if (startRe(tag).test(text) || endRe(tag).test(text)) problems.push(`${rel}: @${tag} marker left (only .mjs/.js/.cjs/.css/.hbs/.html are cut)`);
    if (!renamed(ed) || rel === REST) continue;
    // module.json's flags[<built id>].rests names the paid module on purpose (one line, written by moduleJsonFor)
    const rests = rel === "module.json" ? text.split("\n").findIndex(l => l.replace(/,$/, "") === `      "rests": ${JSON.stringify(PAID_ID)}`) : -1;
    text.split("\n").forEach((line, i) => {
      if (i !== rests && !line.includes(PAID_MARK) && HAS_ID.test(line.replace(GH_URL, " "))) problems.push(`${rel}:${i + 1}: ${PAID_ID} left (outside a GitHub URL, no @paid-id)`);
    });
    if (SCRIPT.test(rel) && !leftOut(rel, ed) && isEsm(rel, text) && USES_HOOKS.test(text) && !text.includes(REST_LINE)) problems.push(`${rel}: uses Hooks without the rest stand-in`);
  }
  if (problems.length) throw new Error(`${ed}: stopped, nothing zipped —\n  ${problems.join("\n  ")}`);
}

function zipDir(dir, zipPath) {
  fs.rmSync(zipPath, { force: true });
  // Files at the root of the zip (what Foundry expects), named one by one: Windows' tar doesn't expand "*".
  const entries = fs.readdirSync(dir);
  const ps = p => `'${p.replace(/'/g, "''")}'`;
  const tries = process.platform === "win32"
    ? [["tar", ["-a", "-c", "-f", zipPath, ...entries]],
       ["powershell", ["-NoProfile", "-Command", `Compress-Archive -Path ${entries.map(ps).join(",")} -DestinationPath ${ps(zipPath)}`]]]
    : [["zip", ["-r", "-q", zipPath, ...entries]]];
  for (const [cmd, a] of tries) {
    const r = spawnSync(cmd, a, { cwd: dir, stdio: "inherit" });
    if (r.status === 0 && fs.existsSync(zipPath)) return;
  }
  throw new Error("could not make the zip");
}

const usage = () => {
  console.log(`usage: node tools/edition.mjs ${HAS_TRIAL ? "trial|" : ""}plus|lite|public [--out dist] [--sale]  ·  node tools/edition.mjs check`);
  process.exit(1);
};

try {
  checkIds();
  if (args.includes("--in-place")) {
    // It rewrote the working tree (the old GitHub Actions release); run in a source folder it deleted the
    // Plus code there. Nothing uses it now.
    console.log("--in-place is gone: use --out (tools/release.mjs does).");
    process.exit(1);
  }
  if (edition === "check") {
    const files = walk(ROOT);
    const left = files.filter(isPlusFile);
    console.log(`Lite leaves out ${left.length} file(s):\n  ${left.join("\n  ")}`);
    if (HAS_TRIAL) {
      const more = files.filter(r => isTrialFile(r) && !isPlusFile(r));
      console.log(`Trial also leaves out ${more.length} file(s):\n  ${more.join("\n  ")}`);
    }
    let blocks = 0;
    let full = 0;
    for (const rel of files.filter(r => TEXT.test(r))) {
      const text = fs.readFileSync(path.join(ROOT, rel), "utf8");
      stripBlocks(text, rel, ["plus", "full"]);
      blocks += (text.match(/@plus\b(?!-)/g) ?? []).length;
      full += (text.match(/@full\b(?!-)/g) ?? []).length;
    }
    console.log(`${blocks} @plus block(s)${HAS_TRIAL || full ? `, ${full} @full block(s)` : ""}, all closed. Public release: ${conf.public ?? "lite"}.`);
    console.log(FREE ? `Package id: ${PAID_ID} (one edition)` : `Package ids: plus ${builtId("plus")} · lite ${builtId("lite")}${HAS_TRIAL ? ` · trial ${builtId("trial")}` : ""}`);
  } else if (["lite", "plus", "trial", "public"].includes(edition)) {
    const ed = edition === "public" ? (conf.public ?? "lite") : edition;
    if (!["lite", "plus", "trial"].includes(ed) || (ed === "trial" && !HAS_TRIAL)) usage();
    if (OUT === ROOT || ROOT.startsWith(`${OUT}${path.sep}`)) throw new Error(`--out ${OUT}: not the module folder or a folder above it`);
    fs.mkdirSync(OUT, { recursive: true });
    // git leaves the build folder alone without touching the module's .gitignore
    if (!fs.existsSync(path.join(OUT, ".gitignore"))) fs.writeFileSync(path.join(OUT, ".gitignore"), "*\n");
    const label = SALE ? (ed === "trial" ? "trial-sale" : "sale") : ed;
    const target = path.join(OUT, label, manifest.id);
    fs.rmSync(target, { recursive: true, force: true });
    fs.mkdirSync(target, { recursive: true });
    try {
      build(ed, target);
      verify(ed, target);
    } catch (err) {
      fs.rmSync(target, { recursive: true, force: true });
      throw err;
    }
    if (renamed(ed)) console.log(`${builtId(ed)}: ${counts.ids} id(s) rewritten, ${counts.urls} GitHub URL(s) and ${counts.marked} @paid-id line(s) kept`);
    for (const w of warnings) console.log(`  ! ${w}`);
    const zip = path.join(OUT, `${manifest.id}-${label}.zip`);
    zipDir(target, zip);
    if (SALE) console.log(`${zip}  (${ed === "trial" ? "체험판 " : ""}판매용: 업데이트 주소 없음)`);
    else {
      fs.copyFileSync(path.join(target, "module.json"), path.join(OUT, `${ed}-module.json`));
      console.log(`${zip}\n${path.join(OUT, `${ed}-module.json`)}`);
    }
  } else usage();
} catch (err) {
  console.error(err.message ?? err);
  process.exit(1);
}
