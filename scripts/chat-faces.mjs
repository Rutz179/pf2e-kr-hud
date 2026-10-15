import { MODULE_ID, setting } from "./shared.mjs";

/* ======================================================================== *
 * Chat portraits: the finished round token, not the huge figure.
 *
 * What PF2e does: after the chat card is built (and after Foundry's
 * renderChatMessageHTML hook has already run — which is why hooking that did
 * nothing), it prepends <div class="portrait token"><img></div> to the card
 * header with the token picture, enlarged by `transform: scale(…)` to make up
 * for a dynamic token ring. Art modules such as PF2e Rutz Token give NPCs a
 * ring "subject": a figure on a transparent background, meant to be drawn
 * inside the ring on the map. In the chat there is no ring, so the enlarged
 * figure spills over the top of the card.
 *
 * So we wrap the message's renderHTML, run after PF2e, and replace that
 * picture with a finished token drawn here: the subject inside a circle with
 * the token's ring colour, like on the map (no enlarging, nothing spills).
 * A plain portrait (no token picture) that is not square gets its face cut
 * out instead. Ordinary square token art is left alone. Nothing is saved.
 * ======================================================================== */

const made = new Map();     // key → data URL ("" = leave as is)
const SIZE = 112;

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const timer = setTimeout(() => reject(new Error("timeout")), 4000);
    img.decoding = "async";
    img.onload = () => { clearTimeout(timer); resolve(img); };
    img.onerror = err => { clearTimeout(timer); reject(err); };
    img.src = src;
  });
}

/** Visible box of a picture (alpha > 24) and how much of it is filled. */
function measure(img) {
  const w = img.naturalWidth || 1;
  const h = img.naturalHeight || 1;
  const k = Math.min(1, 160 / Math.max(w, h));
  const cw = Math.max(1, Math.round(w * k));
  const ch = Math.max(1, Math.round(h * k));
  const c = document.createElement("canvas");
  c.width = cw;
  c.height = ch;
  const g = c.getContext("2d", { willReadFrequently: true });
  g.drawImage(img, 0, 0, cw, ch);
  const data = g.getImageData(0, 0, cw, ch).data;
  let x0 = cw, y0 = ch, x1 = -1, y1 = -1, solid = 0;
  for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) {
    if (data[(y * cw + x) * 4 + 3] > 24) {
      solid++;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  if (x1 < 0) return null;
  return { w, h, x0: (x0 / cw) * w, y0: (y0 / ch) * h, x1: ((x1 + 1) / cw) * w, y1: ((y1 + 1) / ch) * h, fill: solid / (cw * ch) };
}

function startCanvas() {
  const c = document.createElement("canvas");
  c.width = c.height = SIZE;
  const g = c.getContext("2d");
  const r = SIZE / 2;
  g.save();
  g.beginPath();
  g.arc(r, r, r - 4, 0, Math.PI * 2);
  g.clip();
  const bg = g.createRadialGradient(r, r * 0.8, 4, r, r, r);
  bg.addColorStop(0, "#55545c");
  bg.addColorStop(1, "#1f1e24");
  g.fillStyle = bg;
  g.fillRect(0, 0, SIZE, SIZE);
  return { c, g, r };
}

function finish({ c, g, r }, ring) {
  g.restore();
  g.beginPath();
  g.arc(r, r, r - 3, 0, Math.PI * 2);
  g.lineWidth = 5;
  g.strokeStyle = ring || "#b9a26a";
  g.stroke();
  g.beginPath();
  g.arc(r, r, r - 6, 0, Math.PI * 2);
  g.lineWidth = 1;
  g.strokeStyle = "rgba(0,0,0,0.45)";
  g.stroke();
  return c.toDataURL("image/webp", 0.92);
}

/** A ring token like on the map: the subject fitted into the circle, scaled as on the token. */
async function ringToken(src, scale, ring) {
  const key = `ring|${src}|${scale}|${ring}`;
  if (made.has(key)) return made.get(key);
  let out = "";
  try {
    const img = await loadImage(src);
    const cv = startCanvas();
    const inner = (SIZE - 8) * Math.min(1.6, Math.max(0.6, Number(scale) || 1));
    const k = inner / Math.max(img.naturalWidth, img.naturalHeight);
    const w = img.naturalWidth * k;
    const h = img.naturalHeight * k;
    cv.g.drawImage(img, (SIZE - w) / 2, (SIZE - h) / 2, w, h);
    out = finish(cv, ring);
  } catch (_) { out = ""; }
  made.set(key, out);
  return out;
}

/** A face cut out of a big portrait or a full figure (for pictures that are not square token art). */
async function faceCut(src, ring) {
  const key = `face|${src}|${ring}`;
  if (made.has(key)) return made.get(key);
  let out = "";
  try {
    const img = await loadImage(src);
    const m = measure(img);
    const square = Math.abs(img.naturalWidth / img.naturalHeight - 1) < 0.08;
    if (m && (m.fill < 0.6 || !square)) {
      const bw = m.x1 - m.x0;
      const bh = m.y1 - m.y0;
      const transparent = m.fill < 0.6;
      let side = transparent ? (bh >= bw ? Math.min(bw, bh * 0.32) : Math.min(bh * 0.75, bw)) : Math.min(m.w, m.h) * 0.62;
      side = Math.max(side, Math.min(m.w, m.h) * 0.15);
      const cx = transparent ? (m.x0 + m.x1) / 2 : m.w / 2;
      const top = transparent ? Math.max(0, m.y0 - side * 0.06) : Math.max(0, m.h * 0.04);
      const cv = startCanvas();
      cv.g.drawImage(img, cx - side / 2, top, side, side, 4, 4, SIZE - 8, SIZE - 8);
      out = finish(cv, ring);
    }
  } catch (_) { out = ""; }
  made.set(key, out);
  return out;
}

function ringColor(token) {
  const c = token?.ring?.enabled ? token.ring.colors?.ring : null;
  if (!c) return null;
  return typeof c === "string" ? c : (c.css ?? null);
}

/** After PF2e built the card: swap its portrait for a finished token. */
export async function fixChatPortrait(message, html) {
  if (setting("chatFaceZoom", true) === false) return;
  const img = html?.querySelector?.("header.message-header .portrait img");
  if (!img || img.dataset.pkhFace) return;
  img.dataset.pkhFace = "1";
  const actor = message.speakerActor ?? null;
  const token = message.token ?? actor?.prototypeToken ?? null;
  const ring = ringColor(token);
  let face = "";
  const subject = token?.ring?.enabled ? (token.ring.subject?.texture || token.texture?.src) : null;
  if (subject) face = await ringToken(subject, token.ring.subject?.scale ?? 1, ring);
  if (!face) face = await faceCut(img.getAttribute("src"), ring);
  if (!face) return;
  img.src = face;
  img.style.transform = "none";
  img.style.maskImage = "none";
  img.style.webkitMaskImage = "none";
  img.style.objectFit = "contain";
  img.closest(".portrait")?.classList.add("pkh-face");
}

/** Wrap the chat message's renderHTML so we run after the system's own additions. */
export function patchChatPortraits() {
  const cls = CONFIG.ChatMessage?.documentClass;
  const proto = cls?.prototype;
  if (!proto?.renderHTML || proto.renderHTML.__pkhFaces) return;
  const original = proto.renderHTML;
  const wrapped = async function (...args) {
    const html = await original.apply(this, args);
    try { await fixChatPortrait(this, html); } catch (err) { console.warn(`${MODULE_ID} | chat portrait`, err); }
    return html;
  };
  wrapped.__pkhFaces = true;
  proto.renderHTML = wrapped;
}

export function registerChatFaceSettings() {
  game.settings.register(MODULE_ID, "chatFaceZoom", {
    name: "채팅 초상화: 큰 전신 그림 대신 원형 토큰",
    hint: "토큰 링을 쓰는 토큰(아트 모듈의 NPC 등)은 채팅 카드 머리의 그림이 크게 넘쳐 보입니다. 맵에서처럼 링 안에 들어간 원형 토큰 그림으로 바꿔 보여 줍니다. 보통 정사각형 토큰 그림은 그대로 둡니다.",
    scope: "client", config: true, type: Boolean, default: true,
    onChange: () => ui.chat?.render?.()
  });
}
