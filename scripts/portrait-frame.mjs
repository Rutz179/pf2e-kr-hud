/*
 * Per-character framing of the party portrait: zoom, which part stays in view, turn, mirror.
 *   flags.pf2e-kr-hud.portraitFrame = { zoom, x, y, rot, flip }
 * Pure maths + DOM helpers, no Foundry globals, so the stage, the editor and a test page share them.
 * x / y work like object-position: at zoom > 1, x = 0 shows the left edge of the (square) frame area, 100 the right edge, 50 the middle (same for y). The picture is zoomed about that point, turned about the frame's centre and, when zoomed in or turned, clipped to the frame so it never reaches the name plate. Zoom under 1 shrinks it toward that point.
 */

export const FRAME_DEFAULT = Object.freeze({ zoom: 1, x: 50, y: 50, rot: 0, flip: false });
export const ZOOM_MIN = 0.3;
export const ZOOM_MAX = 4;

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const num = (v, fallback) => (Number.isFinite(Number(v)) && v !== null && v !== "" ? Number(v) : fallback);
const esc = value => String(value ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

/** Any stored value → a clean frame (missing or broken parts fall back to the default). */
export function frameOf(raw) {
  const r = raw && typeof raw === "object" ? raw : {};
  return {
    zoom: clamp(num(r.zoom, 1), ZOOM_MIN, ZOOM_MAX),
    x: clamp(num(r.x, 50), 0, 100),
    y: clamp(num(r.y, 50), 0, 100),
    rot: clamp(num(r.rot, 0), -180, 180),
    flip: !!r.flip
  };
}

const unzoomed = z => Math.abs(z - 1) < 1e-3;

/** Looks exactly like no framing: x / y only matter once zoomed in or out. */
export function isPlain(frame) {
  const f = frameOf(frame);
  return unzoomed(f.zoom) && f.rot === 0 && !f.flip;
}

/** The picture is cut at the frame when zoomed or turned (a mirror alone never leaves the frame). */
export function needsClip(frame) {
  const f = frameOf(frame);
  return f.zoom > 1 || f.rot !== 0;
}

const n = v => String(Math.round(v * 1000) / 1000);

/** CSS `transform` for the <img> (with transform-origin 0 0): zoom about (x, y), after turning/mirroring about the centre. */
export function frameTransform(frame) {
  const f = frameOf(frame);
  const parts = [];
  if (!unzoomed(f.zoom)) parts.push(`translate(${n(f.x)}%, ${n(f.y)}%) scale(${n(f.zoom)}) translate(${n(-f.x)}%, ${n(-f.y)}%)`);
  if (f.rot !== 0 || f.flip) {
    parts.push(`translate(50%, 50%)${f.rot !== 0 ? ` rotate(${n(f.rot)}deg)` : ""}${f.flip ? " scaleX(-1)" : ""} translate(-50%, -50%)`);
  }
  return parts.join(" ") || "none";
}

/** Extra class for the stage's frame element: "" = markup untouched. */
export function frameClass(frame) {
  return isPlain(frame) ? "" : " framed";
}

/** Inner HTML of the stage's frame element. No framing → the same <img> as always. */
export function pictureHtml(src, frame) {
  const img = (style = "") => `<img src="${esc(src)}" alt="" draggable="false"${style}>`;
  if (isPlain(frame)) return img();
  const style = ` style="transform:${frameTransform(frame)};transform-origin:0 0"`;
  return `<div class="pkh-pic${needsClip(frame) ? " clip" : ""}">${img(style)}</div>`;
}

/** Editor preview: show a frame on an existing `.pkh-pic > img` (always clipped, so it shows what the stage keeps). */
export function applyFrame(previewEl, frame) {
  const img = previewEl.querySelector("img");
  if (img) {
    img.style.transformOrigin = "0 0";
    img.style.transform = frameTransform(frame);
  }
}

/**
 * Size the preview like the stage's frame: as wide as the card, as tall as the picture's own shape needs
 * (never shorter than square, which is how the stage's frame behaves). Tall art is scaled down to fit maxH.
 */
export function fitPreview(previewEl, base = 150, maxH = 260) {
  const img = previewEl.querySelector("img");
  if (!img) return;
  const fit = () => {
    const ratio = img.naturalWidth ? Math.max(1, img.naturalHeight / img.naturalWidth) : 1;
    const w = Math.min(base, Math.floor(maxH / ratio));
    previewEl.style.width = `${w}px`;
    previewEl.style.height = `${Math.round(w * ratio)}px`;
  };
  if (img.complete) fit();
  img.addEventListener("load", fit);
}

/**
 * Drag = move, wheel = zoom on a square preview. Calls onChange(frame) with a clean frame after every change
 * (and the caller keeps its sliders in step). Returns { get, set(patch), destroy }.
 */
export function bindFrameEditor(previewEl, initial, onChange = () => {}) {
  let frame = frameOf(initial);
  const set = (patch, { silent = false } = {}) => {
    // first time smaller than the frame from the middle: shrink toward the bottom, so the feet stay down
    if (patch.zoom < 1 && frame.zoom >= 1 && patch.y === undefined && frame.y === 50) patch = { ...patch, y: 100 };
    frame = frameOf({ ...frame, ...patch });
    applyFrame(previewEl, frame);
    if (!silent) onChange({ ...frame });
    return frame;
  };
  applyFrame(previewEl, frame);

  const onDown = ev => {
    if (ev.button !== undefined && ev.button !== 0) return;
    ev.preventDefault();
    // the picture's own box (the frame) before its transform: what x / y are percentages of
    const img = previewEl.querySelector("img");
    const box = previewEl.getBoundingClientRect();
    const w = img?.offsetWidth || box.width || 1, h = img?.offsetHeight || box.height || w;
    const start = { px: ev.clientX, py: ev.clientY, x: frame.x, y: frame.y };
    previewEl.setPointerCapture?.(ev.pointerId);
    previewEl.classList.add("dragging");
    const move = e => {
      // The picture follows the pointer one to one: as x goes 0 → 100 it slides by (1 - zoom) of the frame
      // (zoomed in that is backwards: the window over it moves). Nothing to move at exactly the frame's size.
      const travel = 1 - frame.zoom;
      if (Math.abs(travel) < 0.02) return;
      set({
        x: start.x + ((e.clientX - start.px) / w) * 100 / travel,
        y: start.y + ((e.clientY - start.py) / h) * 100 / travel
      });
    };
    const up = () => {
      previewEl.removeEventListener("pointermove", move);
      previewEl.classList.remove("dragging");
    };
    previewEl.addEventListener("pointermove", move);
    previewEl.addEventListener("pointerup", up, { once: true });
    previewEl.addEventListener("pointercancel", up, { once: true });
  };
  const onWheel = ev => {
    ev.preventDefault();
    set({ zoom: Math.round(frame.zoom * Math.exp(-ev.deltaY * 0.0015) * 100) / 100 });
  };
  previewEl.addEventListener("pointerdown", onDown);
  previewEl.addEventListener("wheel", onWheel, { passive: false });

  return {
    get: () => ({ ...frame }),
    set,
    destroy() {
      previewEl.removeEventListener("pointerdown", onDown);
      previewEl.removeEventListener("wheel", onWheel);
    }
  };
}
