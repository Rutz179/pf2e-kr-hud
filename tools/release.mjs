/**
 * One release, both editions:
 *
 *   node tools/release.mjs 1.6.1             public edition → GitHub release (public repo), Plus → the hub
 *   node tools/release.mjs 1.6.1 --no-hub    GitHub only
 *   node tools/release.mjs 1.6.1 --hub-only  the hub only (Plus)
 *   node tools/release.mjs 1.6.1 --stamp-only   only check and write the version into module.json (Rutz Studio)
 *   node tools/release.mjs --set-token       once: save your GitHub token (all modules use it)
 *   node tools/release.mjs --check           is everything ready? (token, public repo, hub)
 *   node tools/release.mjs --tidy-public     once: the public repo keeps only README.md and LICENSE
 *   node tools/release.mjs --readme          push README.md to the public repo
 *   node tools/release.mjs --media           push media/ (screenshots, GIFs) to the public repo
 *   node tools/release.mjs --clean-public    the public repo keeps only its latest release, and its
 *                                            history becomes one commit (old releases, tags, branches gone)
 *
 * The source lives in a private repository (or only on this PC). The public repository only
 * carries the README and the releases, so the Plus code is never public. Installing and
 * updating keep using the same address:
 *   https://github.com/<owner>/<repo>/releases/latest/download/module.json
 *
 * Which edition goes public: edition.json "public" ("plus" during the open beta, then "lite").
 * No edition.json = a free module: its source repository is the public one, the release carries
 * the folder as it is, and nothing goes to the hub.
 *
 * Settings: ~/.rutz-release.json, shared by every module (never share it):
 *   { "githubToken": "github_pat_…",                  // --set-token; fine-grained, Contents: read and write
 *     "hub": "https://rutz-hub.<you>.workers.dev",    // written by the hub's tools/setup.mjs
 *     "adminKey": "…" }                               //   (no hub → GitHub only)
 * tools/local.config.json, if there, overrides it for this module (e.g. "publicRepo").
 */
import fs from "node:fs";
import os from "node:os";
import crypto from "node:crypto";
import path from "node:path";
import readline from "node:readline/promises";
import { spawnSync } from "node:child_process";

const ROOT = process.cwd();
const args = process.argv.slice(2);
const flag = f => args.includes(f);
const HOME_FILE = path.join(os.homedir(), ".rutz-release.json");
const readJson = file => { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return {}; } };
const local = { ...readJson(HOME_FILE), ...readJson(path.join(ROOT, "tools", "local.config.json")) };
const manifestPath = path.join(ROOT, "module.json");
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
const FREE = !fs.existsSync(path.join(ROOT, "edition.json"));
const edition = FREE ? { public: "plus" } : JSON.parse(fs.readFileSync(path.join(ROOT, "edition.json"), "utf8"));
const git = (...a) => spawnSync("git", a, { cwd: ROOT, encoding: "utf8" });
/** Is this folder's git origin the public repository (always so for a free module)? */
function originIsPublic() {
  const src = git("remote", "get-url", "origin").stdout?.trim() ?? "";
  return !!src && !!repoName && new RegExp(`[/:]${repoName.replace("/", "\\/")}(\\.git)?$`, "i").test(src);
}
// The public repository: local.config.json, module.json "url", or (free modules) the folder's GitHub origin.
const repoName = local.publicRepo
  ?? /github\.com\/([^/]+\/[^/#?]+)/.exec(manifest.url ?? "")?.[1]?.replace(/\.git$/, "")
  ?? (FREE ? /github\.com[/:]([^/]+\/[^/#?]+?)(?:\.git)?$/.exec(git("remote", "get-url", "origin").stdout?.trim() ?? "")?.[1] : undefined);
const token = local.githubToken ?? process.env.GITHUB_TOKEN;
const API = process.env.GITHUB_API ?? "https://api.github.com";
const UPLOADS = process.env.GITHUB_UPLOADS ?? "https://uploads.github.com";

/* ---------------- GitHub ---------------- */

async function gh(method, url, body, type) {
  if (!token) throw new Error("GitHub 토큰이 없습니다: node tools/release.mjs --set-token");
  const full = url.startsWith("http") ? url : `${API}/repos/${repoName}${url}`;
  const headers = { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" };
  const isRaw = body instanceof Uint8Array || Buffer.isBuffer(body);
  if (body !== undefined) headers["Content-Type"] = type ?? (isRaw ? "application/octet-stream" : "application/json");
  const res = await fetch(full, { method, headers, body: body === undefined ? undefined : isRaw ? body : JSON.stringify(body) });
  const text = await res.text();
  if (!res.ok) {
    const noAccess = res.status === 403 && /not accessible by (personal access|integration)/i.test(text);
    const err = new Error(res.status === 401 ? "GitHub 토큰이 맞지 않거나 만료됐습니다: node tools/release.mjs --set-token"
      : noAccess ? tokenHelp() : `GitHub ${method} ${url} → ${res.status} ${text.slice(0, 300)}`);
    err.status = res.status;
    throw err;
  }
  return text ? JSON.parse(text) : null;
}

function tokenHelp() {
  return `GitHub 토큰에 ${repoName} 저장소 쓰기 권한이 없습니다 (아무것도 바꾸지 않았습니다).\n`
    + `  github.com → 오른쪽 위 사진 → Settings → Developer settings → Personal access tokens → Fine-grained tokens → 쓰는 토큰 → Edit\n`
    + `  · Repository access: All repositories, 또는 Only select repositories에 ${repoName.split("/")[1]} 추가\n`
    + `  · Permissions → Repository permissions → Contents: Read and write\n`
    + `  → Update. 토큰 값은 그대로라 다시 넣을 필요 없음. 그다음 같은 버전으로 다시 릴리스.`;
}

async function upload(release, file, name, type) {
  const data = fs.readFileSync(file);
  const url = `${UPLOADS}/repos/${repoName}/releases/${release.id}/assets?name=${encodeURIComponent(name)}`;
  return gh("POST", url, data, type);
}

/** The public repo's README.md follows the local one. */
/** README.md and its translations (README.ko.md …) in the folder's top level. */
function readmeFiles() {
  return fs.readdirSync(ROOT).filter(f => /^README(\.[A-Za-z-]+)?\.md$/.test(f)).sort((a, b) => (a === "README.md" ? -1 : b === "README.md" ? 1 : a.localeCompare(b)));
}

async function pushReadme() {
  let sent = 0;
  for (const name of readmeFiles()) {
    const text = fs.readFileSync(path.join(ROOT, name), "utf8");
    let sha;
    try {
      const cur = await gh("GET", `/contents/${name}`);
      sha = cur.sha;
      if (Buffer.from(cur.content, "base64").toString("utf8") === text) continue;
    } catch (err) { if (err.status !== 404) throw err; }
    await gh("PUT", `/contents/${name}`, { message: name.replace(/\.md$/, ""), content: Buffer.from(text).toString("base64"), ...(sha ? { sha } : {}) });
    sent++;
  }
  return sent > 0;
}

/**
 * media/ (screenshots, GIFs for README and the Foundry page) → the public repo's media/, so
 * https://raw.githubusercontent.com/<public repo>/<branch>/media/<file> works even when the
 * source repo is private. Only changed files are sent. Returns how many were sent.
 */
async function pushMedia() {
  const dir = path.join(ROOT, "media");
  if (!fs.existsSync(dir)) return 0;
  const blobSha = data => crypto.createHash("sha1").update(`blob ${data.length}\0`).update(data).digest("hex");
  let sent = 0;
  for (const name of fs.readdirSync(dir)) {
    if (name.startsWith(".")) continue;
    const file = path.join(dir, name);
    if (!fs.statSync(file).isFile()) continue;
    const data = fs.readFileSync(file);
    if (data.length > 50 * 1048576) { console.log(`    ! media/${name}: 50MB가 넘어 건너뜁니다`); continue; }
    const at = `/contents/media/${encodeURIComponent(name)}`;
    let sha;
    try { sha = (await gh("GET", at)).sha; } catch (err) { if (err.status !== 404) throw err; }
    if (sha === blobSha(data)) continue;
    await gh("PUT", at, { message: `media/${name}`, content: data.toString("base64"), ...(sha ? { sha } : {}) });
    console.log(`    media/${name} 올림 (${Math.round(data.length / 1024)} KB)`);
    sent++;
  }
  return sent;
}

/** Once: one new commit on the public repo that holds only README.md (and LICENSE). The history stays. */
async function tidyPublic() {
  if (FREE) return console.log("무료 모듈은 소스가 공개 저장소에 있으므로 정리하지 않습니다.");
  if (originIsPublic()) return console.log("이 폴더의 git origin이 아직 공개 저장소입니다. 먼저 소스를 비공개 저장소로 옮기세요 (.private/RELEASE.md).");
  const repo = await gh("GET", "");
  const branch = repo.default_branch;
  const head = await gh("GET", `/git/ref/heads/${branch}`);
  const keep = [...readmeFiles(), "LICENSE", "LICENSE.md"].filter(f => fs.existsSync(path.join(ROOT, f)));
  console.log(`${repoName} (${branch}): 공개 저장소에 ${keep.join(", ")} 만 남깁니다. 이전 기록(커밋·태그·릴리스)은 그대로입니다.`);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ok = (await rl.question("진행할까요? (y/N) ")).trim().toLowerCase();
  rl.close();
  if (ok !== "y" && ok !== "yes") return console.log("취소했습니다.");
  const tree = [];
  for (const f of keep) {
    const blob = await gh("POST", "/git/blobs", { content: fs.readFileSync(path.join(ROOT, f)).toString("base64"), encoding: "base64" });
    tree.push({ path: f, mode: "100644", type: "blob", sha: blob.sha });
  }
  const t = await gh("POST", "/git/trees", { tree });
  const commit = await gh("POST", "/git/commits", { message: "Public repository: README and releases only", tree: t.sha, parents: [head.object.sha] });
  await gh("PATCH", `/git/refs/heads/${branch}`, { sha: commit.sha });
  console.log("완료 — 공개 저장소는 이제 README와 릴리스만 보여 줍니다.");
}

/* ---------------- cleaning the public repository ---------------- */

/** Every page of a list endpoint. */
async function allPages(url) {
  const out = [];
  for (let page = 1; page < 50; page++) {
    const list = await gh("GET", `${url}${url.includes("?") ? "&" : "?"}per_page=100&page=${page}`);
    if (!Array.isArray(list) || !list.length) break;
    out.push(...list);
    if (list.length < 100) break;
  }
  return out;
}

const semver = v => String(v ?? "").replace(/^v/, "").split(/[.+-]/).map(n => Number(n) || 0);
const newer = (a, b) => { const x = semver(a), y = semver(b); for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0); return false; };

/**
 * The public repository is left with: its latest release only (the one the install address
 * …/releases/latest/download/module.json serves), and a history of one commit holding what it
 * shows now. Every other release, tag and branch is deleted, and so is the old history.
 *
 *  - Lite/Plus module (source in a private repo): the public repo's current files (README, media …)
 *    become one new commit, through the GitHub API.
 *  - Free module (this folder is the public repo): this folder's history becomes one commit too
 *    (git checkout --orphan, force push) — so it must have nothing uncommitted or unpushed.
 * The kept release's tag is moved to the new commit. Can't be undone.
 */
async function cleanPublic() {
  const repo = await gh("GET", "");
  if (repo.permissions && !repo.permissions.push) throw new Error(tokenHelp());
  const branch = repo.default_branch;
  const viaGit = FREE || originIsPublic();
  let latest = null;
  try { latest = await gh("GET", "/releases/latest"); } catch (err) { if (err.status !== 404) throw err; }
  const releases = await allPages("/releases");
  if (!latest) latest = releases.filter(r => !r.draft).reduce((best, r) => (!best || newer(r.tag_name, best.tag_name) ? r : best), null);
  const tags = (await allPages("/tags")).map(t => t.name);
  const branches = (await allPages("/branches")).map(b => b.name).filter(b => b !== branch);
  const dropReleases = releases.filter(r => r.id !== latest?.id);
  const dropTags = tags.filter(t => t !== latest?.tag_name);
  const commits = Number(viaGit ? git("rev-list", "--count", "HEAD").stdout?.trim() : NaN);
  console.log(`${repoName} (${branch})`);
  console.log(`  남길 릴리스: ${latest ? `${latest.tag_name} (${latest.name ?? ""})` : "없음"}`);
  console.log(`  지울 릴리스 ${dropReleases.length}개: ${dropReleases.map(r => r.tag_name).join(", ") || "-"}`);
  console.log(`  지울 태그 ${dropTags.length}개: ${dropTags.join(", ") || "-"}`);
  if (branches.length) console.log(`  지울 브랜치 ${branches.length}개: ${branches.join(", ")}`);
  console.log(`  커밋 기록: ${Number.isFinite(commits) ? `${commits}개 → ` : ""}지금 상태의 커밋 1개${viaGit ? " (이 PC의 기록도 같이)" : " (공개 저장소만 — 이 PC의 비공개 소스 기록은 그대로)"}`);

  if (viaGit) {
    // This folder's history goes too: everything must be committed and on GitHub first.
    if (git("status", "--porcelain").stdout?.trim()) throw new Error("커밋하지 않은 변경이 있습니다. 먼저 커밋·푸시한 다음 다시 정리하세요 (아무것도 바꾸지 않았습니다).");
    const local = git("rev-parse", "--abbrev-ref", "HEAD").stdout?.trim();
    if (local !== branch) throw new Error(`지금 브랜치가 ${local}입니다. ${branch}로 바꾼 다음 다시 정리하세요 (아무것도 바꾸지 않았습니다).`);
    const fetched = git("fetch", "origin", branch);
    if (fetched.status !== 0) throw new Error(`git fetch 실패: ${fetched.stderr}`);
    const here = git("rev-parse", "HEAD").stdout?.trim();
    const there = git("rev-parse", `origin/${branch}`).stdout?.trim();
    if (here !== there) throw new Error(`이 PC와 GitHub의 ${branch}가 다릅니다 (푸시하지 않았거나 받지 않은 커밋). 먼저 맞춘 다음 다시 정리하세요 (아무것도 바꾸지 않았습니다).`);
  }
  if (!flag("--yes")) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const ok = (await rl.question(`되돌릴 수 없습니다. 진행하려면 ${manifest.id} 를 입력하세요: `)).trim();
    rl.close();
    if (ok !== manifest.id) return console.log("취소했습니다.");
  }

  // 1. The new history: one commit. (Nothing is deleted before this has worked.)
  const message = `${manifest.title ?? manifest.id}${latest ? ` ${latest.tag_name}` : ""}`;
  let sha;
  if (viaGit) {
    const step = (...a) => { const r = git(...a); if (r.status !== 0) throw new Error(`git ${a.join(" ")} 실패: ${r.stderr || r.stdout}`); return r; };
    step("checkout", "--orphan", "rutz-clean-history");
    step("commit", "-q", "-m", message);
    step("branch", "-M", "rutz-clean-history", branch);
    step("push", "--force", "-u", "origin", branch);
    sha = git("rev-parse", "HEAD").stdout.trim();
    console.log(`[1] 이 PC와 GitHub의 ${branch}: 커밋 1개 (${sha.slice(0, 7)})`);
  } else {
    const head = await gh("GET", `/git/ref/heads/${branch}`);
    const current = await gh("GET", `/git/commits/${head.object.sha}`);
    const commit = await gh("POST", "/git/commits", { message, tree: current.tree.sha, parents: [] });
    await gh("PATCH", `/git/refs/heads/${branch}`, { sha: commit.sha, force: true });
    sha = commit.sha;
    console.log(`[1] 공개 저장소 ${branch}: 커밋 1개 (${sha.slice(0, 7)}) — 파일은 지금 그대로`);
  }
  // 2. The kept release's tag on the new commit (its "Source code" zip then holds only what the repo shows now).
  if (latest) {
    try { await gh("PATCH", `/git/refs/tags/${latest.tag_name}`, { sha, force: true }); }
    catch (err) { if (err.status !== 422 && err.status !== 404) throw err; await gh("POST", "/git/refs", { ref: `refs/tags/${latest.tag_name}`, sha }); }
    console.log(`[2] ${latest.tag_name} 태그를 새 커밋으로 옮겼습니다.`);
  }
  // 3. The rest goes.
  for (const r of dropReleases) { await gh("DELETE", `/releases/${r.id}`); }
  console.log(`[3] 릴리스 ${dropReleases.length}개 삭제`);
  for (const t of dropTags) { try { await gh("DELETE", `/git/refs/tags/${encodeURIComponent(t)}`); } catch (err) { if (err.status !== 422 && err.status !== 404) throw err; } }
  console.log(`[4] 태그 ${dropTags.length}개 삭제`);
  for (const b of branches) { try { await gh("DELETE", `/git/refs/heads/${encodeURIComponent(b)}`); } catch (err) { if (err.status !== 422 && err.status !== 404) throw err; } }
  if (branches.length) console.log(`[5] 브랜치 ${branches.length}개 삭제`);
  // 4. This folder forgets the old tags and commits too (a later "git push --tags" must not bring them back).
  if (viaGit) {
    const localTags = (git("tag", "-l").stdout ?? "").split(/\r?\n/).filter(Boolean);
    if (localTags.length) git("tag", "-d", ...localTags);
    git("fetch", "origin", "--prune");
    if (latest) git("fetch", "origin", `refs/tags/${latest.tag_name}:refs/tags/${latest.tag_name}`);
    git("reflog", "expire", "--expire=now", "--all");
    git("gc", "--prune=now", "--quiet");
    console.log("    이 PC의 옛 태그와 기록도 지웠습니다.");
  }
  console.log("\n완료. 설치 주소(…/releases/latest/download/module.json)는 그대로입니다.");
  console.log("참고: GitHub이 옛 커밋을 커밋 주소(SHA)로 한동안 더 보여 줄 수 있습니다. 완전히 지우려면 GitHub Support에 'remove cached views'를 요청하세요. 이미 받아 간 사본은 지울 수 없습니다.");
}

/** Once: the GitHub token into ~/.rutz-release.json (kept with the hub settings already there). */
async function setToken() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  console.log("GitHub → Settings → Developer settings → Personal access tokens → Fine-grained tokens 에서 만든 토큰");
  const value = (await rl.question("토큰 붙여 넣기 (github_pat_…): ")).trim();
  rl.close();
  if (!/^(github_pat_|ghp_)[\w]{20,}$/.test(value)) return console.log("github_pat_ 로 시작하는 값이 아닙니다. 저장하지 않았습니다.");
  const cur = readJson(HOME_FILE);
  fs.writeFileSync(HOME_FILE, `${JSON.stringify({ ...cur, githubToken: value }, null, 2)}\n`, { mode: 0o600 });
  console.log(`저장했습니다: ${HOME_FILE}\n이제 node tools/release.mjs --check 로 확인해 보세요.`);
}

/** Is everything ready? Nothing is changed. */
async function check() {
  const mark = ok => (ok ? "✓" : "✗");
  console.log(`모듈            ${manifest.id} ${manifest.version} · ${FREE ? "무료 모듈" : `공개판: ${edition.public ?? "lite"}`}`);
  console.log(`공개 저장소      ${repoName}`);
  try {
    const repo = await gh("GET", "");
    console.log(`GitHub 토큰      ${mark(!!repo.permissions?.push)} ${repo.permissions?.push ? "쓰기 가능" : "읽기만 됨 — 토큰의 Contents 권한을 Read and write로"}${repo.private ? " (이 저장소가 비공개입니다! 공개 저장소여야 설치가 됩니다)" : ""}`);
  } catch (err) {
    console.log(`GitHub 토큰      ${mark(false)} ${err.status === 404 ? "이 저장소를 볼 수 없습니다 — 토큰의 Repository access에 이 저장소를 넣어 주세요" : err.message}`);
  }
  const src = git("remote", "get-url", "origin").stdout?.trim() ?? "";
  const leaks = !FREE && originIsPublic();
  console.log(`소스(git origin) ${src ? `${mark(!leaks)} ${src}${leaks ? "  ← 공개 저장소입니다! .private/RELEASE.md 의 '소스를 비공개로'" : FREE ? "  (무료 모듈: 소스 공개 그대로)" : ""}` : "- (git 없음)"}`);
  if (FREE) console.log("허브             - 무료 모듈 (허브 안 씀)");
  else if (local.hub && local.adminKey) {
    try {
      const res = await fetch(`${local.hub.replace(/\/$/, "")}/admin/check`, { headers: { Authorization: `Bearer ${local.adminKey}` } });
      const c = res.ok ? await res.json() : null;
      console.log(`허브             ${mark(!!c)} ${local.hub}${c ? ` · 올라간 Plus ${c.releases?.[manifest.id] ?? "-"}${c.releases && !(manifest.id in c.releases) ? "  ← 허브 wrangler.toml의 MODULES에 이 모듈이 없습니다" : ""}` : ` (응답 ${res.status})`}`);
    } catch (err) { console.log(`허브             ${mark(false)} ${local.hub} (${err.message})`); }
  } else console.log("허브             - 설정 없음 (GitHub에만 올립니다)");
}

/* ---------------- building ---------------- */

function build(ed) {
  const r = spawnSync(process.execPath, [path.join("tools", "edition.mjs"), ed, "--out", "dist"], { cwd: ROOT, stdio: "inherit" });
  if (r.status !== 0) throw new Error(`${ed} 판을 만들지 못했습니다.`);
  return { zip: path.join(ROOT, "dist", `${manifest.id}-${ed}.zip`), json: path.join(ROOT, "dist", `${ed}-module.json`) };
}

async function hubPut(p, file, type) {
  const res = await fetch(`${local.hub.replace(/\/$/, "")}${p}`, { method: "PUT", headers: { Authorization: `Bearer ${local.adminKey}`, "Content-Type": type }, body: fs.readFileSync(file) });
  const text = await res.text();
  if (!res.ok) throw new Error(`허브 ${res.status} ${text}`);
  return text;
}

/* ---------------- main ---------------- */

async function main() {
  if (flag("--set-token")) return setToken();
  if (!repoName) throw new Error("공개 저장소를 모르겠습니다: module.json 의 url 이나 local.config.json 의 publicRepo 를 확인하세요.");
  if (flag("--check")) return check();
  if (flag("--tidy-public")) return tidyPublic();
  if (flag("--clean-public")) return cleanPublic();
  if (flag("--readme")) return console.log((await pushReadme()) ? "README를 올렸습니다." : "README가 이미 같습니다.");
  if (flag("--media")) {
    if (originIsPublic()) return console.log("소스가 공개 저장소에 있으니 media/는 커밋·푸시로 올라갑니다.");
    // The README(s) go with the pictures, so a page that shows them is up at once (no release needed).
    const n = await pushMedia();
    console.log(n ? `media 파일 ${n}개를 공개 저장소에 올렸습니다.` : "media/가 이미 같습니다 (또는 비어 있음).");
    return console.log((await pushReadme()) ? `README(${readmeFiles().join(", ")})도 올렸습니다.` : "README는 이미 같습니다.");
  }

  const version = (args.find(a => !a.startsWith("--")) ?? "").replace(/^v/, "");
  if (!/^\d+\.\d+\.\d+([-.][0-9A-Za-z.]+)?$/.test(version)) {
    console.log(fs.readFileSync(new URL(import.meta.url), "utf8").split("\n").slice(1, 10).join("\n"));
    process.exit(1);
  }
  const tag = `v${version}`;
  const toGitHub = !flag("--hub-only");
  const toHub = !FREE && !flag("--no-hub") && !!(local.hub && local.adminKey);
  if (!FREE && !toHub && !flag("--no-hub")) console.log("(허브 설정이 없어 Plus판은 올리지 않습니다 — 허브 폴더에서 node tools/setup.mjs)");

  // 0. nothing is changed before the token and the tag are known to be fine
  if (toGitHub) {
    if (!token) throw new Error("GitHub 토큰이 없습니다: node tools/release.mjs --set-token");
    try { await gh("GET", `/releases/tags/${tag}`); throw new Error(`${tag} 릴리스가 이미 있습니다. 버전을 올리세요.`); } catch (err) { if (err.status !== 404) throw err; }
    // Reading works with any token (public repo); making a release needs write access to this repo.
    const repo = await gh("GET", "");
    if (repo?.permissions && !repo.permissions.push) throw new Error(tokenHelp());
  }
  if (flag("--hub-only") && !toHub) throw new Error("허브 설정이 없습니다 (허브 폴더에서 node tools/setup.mjs).");
  if (toHub) {
    let c = null;
    try {
      const res = await fetch(`${local.hub.replace(/\/$/, "")}/admin/check`, { headers: { Authorization: `Bearer ${local.adminKey}` } });
      if (res.ok) c = await res.json(); else throw new Error(res.status === 401 ? "관리 키가 맞지 않습니다" : `응답 ${res.status}`);
    } catch (err) { throw new Error(`허브(${local.hub})에 올릴 수 없습니다: ${err.message}. GitHub에만 올리려면 --no-hub`); }
    if (c.releases && !(manifest.id in c.releases)) throw new Error(`허브 wrangler.toml의 MODULES에 ${manifest.id} 가 없습니다 (넣고 npx wrangler deploy). GitHub에만 올리려면 --no-hub`);
  }

  // 1. version and addresses into module.json
  const base = `https://github.com/${repoName}`;
  Object.assign(manifest, { version, url: base, manifest: `${base}/releases/latest/download/module.json`, download: `${base}/releases/download/${tag}/module.zip` });
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`[1] module.json → ${version}`);
  if (flag("--stamp-only")) return;

  // 2. the editions
  const pub = edition.public ?? "lite";
  const built = { [pub]: build(pub) };
  if (toHub && !built.plus) built.plus = build("plus");
  console.log(FREE ? "[2] 모듈 zip을 만들었습니다 (무료 모듈)" : `[2] ${Object.keys(built).join(" + ")} 판을 만들었습니다 (공개판: ${pub})`);

  // 3. GitHub release on the public repo
  if (toGitHub) {
    // The README is pushed through the API only when the source lives elsewhere; otherwise it is
    // committed like any file (an API commit would leave this folder behind its origin).
    if (originIsPublic()) {
      if (Number(git("rev-list", "--count", "@{u}..HEAD").stdout?.trim() || 0) > 0) console.log("    ! 푸시하지 않은 커밋이 있습니다 — 릴리스 태그는 GitHub에 올라간 코드에 붙습니다.");
    } else {
      if (await pushReadme()) console.log("    README 갱신");
      await pushMedia();
    }
    const repo = await gh("GET", "");
    const release = await gh("POST", "/releases", { tag_name: tag, name: tag, target_commitish: repo.default_branch, body: `${manifest.title} ${tag}` });
    await upload(release, built[pub].json, "module.json", "application/json");
    await upload(release, built[pub].zip, "module.zip", "application/zip");
    console.log(`[3] GitHub 릴리스: ${release.html_url}`);
  }

  // 4. Plus to the hub (the zip first: a manifest must never point at a missing zip)
  if (toHub) {
    await hubPut(`/admin/release/${manifest.id}/module.zip`, built.plus.zip, "application/zip");
    await hubPut(`/admin/release/${manifest.id}/module.json`, built.plus.json, "application/json");
    console.log(`[4] 허브에 Plus ${version} 를 올렸습니다.`);
  }

  fs.mkdirSync(path.join(ROOT, "dist"), { recursive: true });
  fs.writeFileSync(path.join(ROOT, "dist", "last-release.json"), `${JSON.stringify({ version, tag, date: new Date().toISOString(), public: FREE ? "free" : pub, hub: toHub, commit: git("rev-parse", "HEAD").stdout?.trim() || null }, null, 2)}\n`);
  console.log(`\n설치 주소(공개): ${manifest.manifest}`);
}

main().catch(err => { console.error(err.message ?? err); process.exit(1); });
