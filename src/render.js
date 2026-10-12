// Canvas renderer: visible-chunk culling + painter's algorithm.
//
// The view is a parallel projection, so a voxel's depth is the dot product of
// its cell with the view ray: sorting is one number per voxel, with no z-buffer
// and no per-pixel depth. Everything on screen is expressed through the three
// screen-space images of the world axes (U, V, W), and the two visible side
// faces are chosen by the sign of the view ray, so any orbit angle draws
// correctly — including the ones where you see the far sides of blocks.

import { Z_MIN, Z_MAX, CHUNK, project, unproject, ISO } from './iso.js';
import { PALETTE, PAPER, CHAT_PAPER } from './world.js';
import { MODELS, modelFrames, modelSize } from './models.js';

const MODELS_BY_ID = new Map(MODELS.map((m) => [m.id, m]));

const KEY_SHIFT = 1048576;    // 2^20, the index field of the packed sort key
const KEY_MASK = KEY_SHIFT - 1;
const DEPTH_BIAS = 4096;
const DEPTH_SCALE = 4096;

export function shade(hex, f) {
  const n = parseInt(hex.slice(1), 16);
  const r = Math.round(((n >> 16) & 255) * f);
  const g = Math.round(((n >> 8) & 255) * f);
  const b = Math.round((n & 255) * f);
  return `rgb(${r},${g},${b})`;
}

// A fixed directional light, and the flat-shaded tones both painters use. A
// face's tone is its normal's diffuse term quantised to TONE_STEPS, so faces at
// different orientations read as distinct flats even where the colour matches.
const LIGHT = (() => {
  const l = [-0.5, -0.6, 0.75];
  const k = Math.hypot(l[0], l[1], l[2]);
  return l.map((c) => c / k);
})();
export const TONE_STEPS = 16;
export function toneStep(n) {
  return Math.round(Math.max(0, n[0] * LIGHT[0] + n[1] * LIGHT[1] + n[2] * LIGHT[2]) * TONE_STEPS);
}
export function toneColor(base, step) { return shade(base, 0.6 + 0.4 * step / TONE_STEPS); }

// Contact shading for a block's top face, the second cue the two painters share.
// A face's own tone says which way it faces, which is enough only while the
// camera can see the face at all: the projection is parallel, so at a spin of a
// quarter turn a whole family of side faces is exactly edge-on — it projects to
// a line — and looking straight down the height scale goes to zero and every
// riser vanishes with it. Both are poses where a hill would otherwise read as
// flat colour. So the *ground* every top face sits on is shaded too: each of the
// four horizontal neighbours darkens it in proportion to how far its surface
// stands above, quantised to AO_STEPS like a diffuse tone. Flat ground is
// untouched (every neighbour level with it), so relief reads as its own
// contours from any angle — including the ones where nothing stands up.
export const AO_DEPTH = 2;    // block layers above the face that count as full
export const AO_STEPS = 4;    // quantised occlusion levels, like TONE_STEPS
export function aoColor(base, occl) {
  const k = Math.min(AO_STEPS, Math.max(0, occl));
  return shade(base, 1 - 0.32 * k / AO_STEPS);
}

/**
 * How much the terrain around a column shades its surface, 0 (open ground) to
 * AO_STEPS (walled in on every side). `topAt` is the surface height of a column;
 * only the four side neighbours count, so this is four lookups per *drawn top
 * face* — a block only draws its top when it is its column's summit.
 */
export function occlusion(topAt, x, y, z) {
  let o = 0;
  o += Math.min(AO_DEPTH, topAt(x - 1, y) - z);
  o += Math.min(AO_DEPTH, topAt(x + 1, y) - z);
  o += Math.min(AO_DEPTH, topAt(x, y - 1) - z);
  o += Math.min(AO_DEPTH, topAt(x, y + 1) - z);
  return Math.max(0, Math.min(AO_STEPS, o));
}

/** Packed painter key: depth along the view ray, then insertion index. */
function depthKey(x, y, z, v, n) {
  const depth = x * v.dx + y * v.dy + z * v.dz;
  return Math.round((depth + DEPTH_BIAS) * DEPTH_SCALE) * KEY_SHIFT + n;
}

/** Convex outline of a point set (monotone chain). */
function hull(points) {
  const p = points.slice().sort((a, b) => a.x - b.x || a.y - b.y);
  if (p.length < 3) return p;
  const cross = (o, a, b) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lower = [];
  const upper = [];
  for (const q of p) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop();
    lower.push(q);
  }
  for (let i = p.length - 1; i >= 0; i--) {
    const q = p[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], q) <= 0) upper.pop();
    upper.push(q);
  }
  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

/** Screen-space images of the world x, y and z axes for a view and zoom. */
export function basisOf(view, scale) {
  return {
    U: { x: view.cos * view.H * scale, y: view.sin * view.D * scale },
    V: { x: -view.sin * view.H * scale, y: view.cos * view.D * scale },
    W: { x: 0, y: -view.C * scale },
  };
}

function polyPath(ctx, pts) {
  ctx.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
  ctx.closePath();
}

/** The 4 corners of each face of the box whose origin corner is P0. */
function faceSet(P0, U, V, W, v) {
  const at = (a, b, c) => ({
    x: P0.x + (a ? U.x : 0) + (b ? V.x : 0) + (c ? W.x : 0),
    y: P0.y + (a ? U.y : 0) + (b ? V.y : 0) + (c ? W.y : 0),
  });
  return {
    top: [at(0, 0, 1), at(1, 0, 1), at(1, 1, 1), at(0, 1, 1)],
    // The camera sees the +x face when it looks along -x, and vice versa.
    x: v.sx > 0
      ? [at(1, 0, 0), at(1, 1, 0), at(1, 1, 1), at(1, 0, 1)]
      : [at(0, 0, 0), at(0, 1, 0), at(0, 1, 1), at(0, 0, 1)],
    y: v.sy > 0
      ? [at(0, 1, 0), at(1, 1, 0), at(1, 1, 1), at(0, 1, 1)]
      : [at(0, 0, 0), at(1, 0, 0), at(1, 0, 1), at(0, 0, 1)],
  };
}

/** Convex outline of a projected box. */
function boxOutline(P0, U, V, W) {
  const at = (a, b, c) => ({
    x: P0.x + (a ? U.x : 0) + (b ? V.x : 0) + (c ? W.x : 0),
    y: P0.y + (a ? U.y : 0) + (b ? V.y : 0) + (c ? W.y : 0),
  });
  const pts = [];
  for (const a of [0, 1]) for (const b of [0, 1]) for (const c of [0, 1]) pts.push(at(a, b, c));
  return hull(pts);
}

/**
 * Painter for one model frame, used for the gallery thumbnails. The live
 * renderer has its own batched, culled path; this one trades speed for being
 * obviously correct: it back-face culls, sorts faces far-to-near by centroid
 * depth, and fills and strokes each face in the same flat tone.
 */
export function paintModel(ctx, frame, { x = 0, y = 0, z = 0, view = ISO, scale = 1, ox = 0, oy = 0 } = {}) {
  const o = { x: x + frame.offset.x, y: y + frame.offset.y, z };
  const { U, V, W } = basisOf(view, scale);
  const bx = ox + (o.x * view.cos - o.y * view.sin) * view.H * scale;
  const by = oy + ((o.x * view.sin + o.y * view.cos) * view.D - o.z * view.C) * scale;

  // Back-face cull, then sort far-to-near by centroid depth along the view ray.
  const order = [];
  for (const f of frame.faces) {
    const n = f.n;
    if (n[0] * view.dx + n[1] * view.dy + n[2] * view.dz <= 0) continue;
    order.push({ f, d: f.c[0] * view.dx + f.c[1] * view.dy + f.c[2] * view.dz });
  }
  order.sort((a, b) => a.d - b.d);

  ctx.lineWidth = 1;
  ctx.lineJoin = 'round';
  let style = '';
  for (const { f } of order) {
    const c = toneColor(f.col, toneStep(f.n));
    if (c !== style) { ctx.fillStyle = style = c; ctx.strokeStyle = style; }
    const vs = f.v;
    ctx.beginPath();
    for (let i = 0; i < vs.length; i++) {
      const p = frame.verts[vs[i]];
      const sx = bx + p[0] * U.x + p[1] * V.x + p[2] * W.x;
      const sy = by + p[0] * U.y + p[1] * V.y + p[2] * W.y;
      if (i === 0) ctx.moveTo(sx, sy); else ctx.lineTo(sx, sy);
    }
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
  }
}

const PALETTE_COLORS = PALETTE.map((p) => p.color);

/**
 * Painter for a whole scene — relief, the elements standing on it and the notes
 * lying on it — used for the cards of the preconfigured islands. It gathers
 * every block face, element face and note quad into one painter order by the
 * same depth rule the live renderer uses, and draws them far to near. Like
 * `paintModel` it trades speed for being obviously correct: it runs once per
 * card, not once per frame, so it can afford to walk everything.
 */
export function paintScene(ctx, scene, { view = ISO, w = 104, h = 78, pad = 6 } = {}) {
  const v = view;
  const solid = new Set();
  for (const [x, y, z] of scene.voxels) solid.add(x + ',' + y + ',' + z);
  const has = (x, y, z) => solid.has(x + ',' + y + ',' + z);
  const topAt = (x, y) => {
    for (let z = Z_MAX; z >= Z_MIN; z--) if (has(x, y, z)) return z;
    return Z_MIN - 1;
  };

  // Fit: the world bounds of the relief and the elements. A model's mesh lives
  // inside the whole blocks it claims, so the claimed boxes bound the scene.
  let x0 = Infinity, y0 = Infinity, z0 = Infinity;
  let x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
  const see = (x, y, z) => {
    if (x < x0) x0 = x; if (x > x1) x1 = x;
    if (y < y0) y0 = y; if (y > y1) y1 = y;
    if (z < z0) z0 = z; if (z > z1) z1 = z;
  };
  for (const [x, y, z] of scene.voxels) { see(x, y, z); see(x + 1, y + 1, z + 1); }
  for (const p of scene.props) {
    const size = modelSize(MODELS_BY_ID.get(p.model), p.rot | 0);
    see(p.x, p.y, p.z);
    see(p.x + size.w, p.y + size.h, p.z + size.hz);
  }

  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const ax of [x0, x1]) {
    for (const ay of [y0, y1]) {
      for (const az of [z0, z1]) {
        const q = project(ax, ay, az, v);
        if (q.x < minX) minX = q.x;
        if (q.x > maxX) maxX = q.x;
        if (q.y < minY) minY = q.y;
        if (q.y > maxY) maxY = q.y;
      }
    }
  }
  const spanX = Math.max(1e-6, maxX - minX);
  const spanY = Math.max(1e-6, maxY - minY);
  const scale = Math.min((w - 2 * pad) / spanX, (h - 2 * pad) / spanY);
  const ox = (w - spanX * scale) / 2 - minX * scale;
  const oy = (h - spanY * scale) / 2 - minY * scale;

  const { U, V, W } = basisOf(v, scale);
  const px = (x, y) => ox + (x * v.cos - y * v.sin) * v.H * scale;
  const py = (x, y, z) => oy + ((x * v.sin + y * v.cos) * v.D - z * v.C) * scale;

  const items = [];
  for (const [x, y, z, mat] of scene.voxels) {
    const up = has(x, y, z + 1);
    const rt = !v.faceX || has(x + v.sx, y, z);
    const lf = !v.faceY || has(x, y + v.sy, z);
    if (up && rt && lf) continue;
    items.push({ d: x * v.dx + y * v.dy + z * v.dz, kind: 0, x, y, z, mat, up, rt, lf });
  }
  for (const n of scene.notes) {
    let level = Z_MIN - 1;
    for (let i = 0; i < n.w; i++) {
      for (let j = 0; j < n.h; j++) level = Math.max(level, topAt(n.x + i, n.y + j));
    }
    items.push({
      d: (n.x + n.w) * v.dx + (n.y + n.h) * v.dy + level * v.dz,
      kind: 1, note: n, level,
    });
  }
  for (const p of scene.props) {
    const model = MODELS_BY_ID.get(p.model);
    if (!model) continue;
    const frame = modelFrames(model)[(p.rot | 0) & 3];
    const o = { x: p.x + frame.offset.x, y: p.y + frame.offset.y, z: p.z };
    const bx = px(o.x, o.y);
    const by = py(o.x, o.y, o.z);
    for (const f of frame.faces) {
      if (f.n[0] * v.dx + f.n[1] * v.dy + f.n[2] * v.dz <= 0) continue;   // back-face cull
      items.push({
        d: (o.x + f.c[0]) * v.dx + (o.y + f.c[1]) * v.dy + (o.z + f.c[2]) * v.dz,
        kind: 2, f, frame, bx, by,
      });
    }
  }
  items.sort((a, b) => a.d - b.d);

  ctx.lineWidth = 1;
  ctx.lineJoin = 'round';
  for (const it of items) {
    if (it.kind === 1) {                            // a note lying on the surface
      const n = it.note;
      const paper = PAPER[((n.color | 0) % PAPER.length + PAPER.length) % PAPER.length];
      const a = { x: px(n.x, n.y), y: py(n.x, n.y, it.level) };
      ctx.fillStyle = paper;
      ctx.strokeStyle = shade(paper, 0.7);
      ctx.beginPath();
      polyPath(ctx, [
        a,
        { x: a.x + U.x * n.w, y: a.y + U.y * n.w },
        { x: a.x + U.x * n.w + V.x * n.h, y: a.y + U.y * n.w + V.y * n.h },
        { x: a.x + V.x * n.h, y: a.y + V.y * n.h },
      ]);
      ctx.fill();
      ctx.stroke();
      continue;
    }

    if (it.kind === 2) {                            // an element's face
      const c = toneColor(it.f.col, toneStep(it.f.n));
      ctx.fillStyle = c;
      ctx.strokeStyle = c;
      ctx.beginPath();
      const vs = it.f.v;
      for (let i = 0; i < vs.length; i++) {
        const p = it.frame.verts[vs[i]];
        const sx = it.bx + p[0] * U.x + p[1] * V.x + p[2] * W.x;
        const sy = it.by + p[0] * U.y + p[1] * V.y + p[2] * W.y;
        if (i === 0) ctx.moveTo(sx, sy); else ctx.lineTo(sx, sy);
      }
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      continue;
    }

    const base = PALETTE_COLORS[it.mat] || '#8b929e';
    const P0 = { x: px(it.x, it.y), y: py(it.x, it.y, it.z) };
    const f = faceSet(P0, U, V, W, v);
    const faces = [];
    if (!it.up) faces.push(['top', aoColor(base, occlusion(topAt, it.x, it.y, it.z))]);
    if (!it.rt && v.faceX) faces.push(['x', shade(base, v.sx > 0 ? 0.79 : 0.6)]);
    if (!it.lf && v.faceY) faces.push(['y', shade(base, v.sy > 0 ? 0.6 : 0.79)]);
    for (const [which, col] of faces) {
      ctx.fillStyle = col;
      ctx.strokeStyle = col;
      ctx.beginPath();
      polyPath(ctx, f[which]);
      ctx.fill();
      ctx.stroke();
    }
  }
}

export class Renderer {
  constructor(canvas, world) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.world = world;
    this.cam = { ox: 0, oy: 0, scale: 1, spin: 45, tilt: 30, view: ISO };
    this.hover = null;         // { hit, cells, tile, fill, outline, cursor }
    this.colors = PALETTE.map((p) => ({
      top: Array.from({ length: AO_STEPS + 1 }, (_, k) => aoColor(p.color, k)),
      right: shade(p.color, 0.79),
      left: shade(p.color, 0.6),
      raw: p.color,
    }));
    // Reused per-frame buffers (no allocation while panning).
    // `masks` is one packed byte per voxel: which of its three faces are
    // covered, plus its top face's occlusion level above bit 2.
    this.buf = {
      keys: [], kinds: [], notes: [], xs: [], ys: [], zs: [], mats: [], masks: [], ax: [], ay: [],
      // Model faces: one run of screen coords per entry, referenced by fstart/fcount.
      fx: [], fy: [], fstart: [], fcount: [], fcol: [], fstep: [],
    };
    this.tone = new Map();   // face colour -> [step] -> css colour, built lazily
    this.resize();
  }

  /** The current view parameters (kept on the camera so they are saved with it). */
  get v() { return this.cam.view || ISO; }

  resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.w = w;
    this.h = h;
    this.dpr = dpr;
    this.canvas.width = Math.max(1, Math.round(w * dpr));
    this.canvas.height = Math.max(1, Math.round(h * dpr));
    this.canvas.style.width = w + 'px';
    this.canvas.style.height = h + 'px';
  }

  /** Screen-space images of the world x, y and z axes at the current zoom. */
  basis() { return basisOf(this.v, this.cam.scale); }

  /** Cached flat tone for a (face colour, tone step) pair. */
  toneFor(col, step) {
    let row = this.tone.get(col);
    if (!row) this.tone.set(col, row = []);
    let c = row[step];
    if (c === undefined) c = row[step] = toneColor(col, step);
    return c;
  }

  /** World point -> screen px, including pan and zoom. */
  toScreen(x, y, z) {
    const p = project(x, y, z, this.v);
    return { x: this.cam.ox + p.x * this.cam.scale, y: this.cam.oy + p.y * this.cam.scale };
  }

  /** Screen px (viewport-relative) -> view space, for picking. */
  toIso(px, py) {
    return { ix: (px - this.cam.ox) / this.cam.scale, iy: (py - this.cam.oy) / this.cam.scale };
  }

  /** Chunk range whose columns can touch the viewport, at any height. */
  visibleChunks() {
    const v = this.v;
    const { ox, oy, scale } = this.cam;
    const pts = [];
    for (const [sx, sy] of [[0, 0], [this.w, 0], [0, this.h], [this.w, this.h]]) {
      const ix = (sx - ox) / scale;
      const iy = (sy - oy) / scale;
      pts.push(unproject(ix, iy, Z_MIN, v), unproject(ix, iy, Z_MAX, v));
    }
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const p of pts) {
      if (p.x < x0) x0 = p.x;
      if (p.y < y0) y0 = p.y;
      if (p.x > x1) x1 = p.x;
      if (p.y > y1) y1 = p.y;
    }
    return {
      cx0: Math.floor((x0 - 1) / CHUNK),
      cy0: Math.floor((y0 - 1) / CHUNK),
      cx1: Math.floor((x1 + 1) / CHUNK),
      cy1: Math.floor((y1 + 1) / CHUNK),
    };
  }

  render() {
    const ctx = this.ctx;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.w, this.h);
    const range = this.visibleChunks();
    this.drawGround(ctx, range);
    this.gather(range);
    this.drawSorted(ctx);
    this.drawHover(ctx);
  }

  /* ── ground grid ───────────────────────────────────────────────────── */

  drawGround(ctx, r) {
    const { U, V } = this.basis();
    // Roughly the spacing between neighbouring grid lines on screen.
    const cell = Math.min(Math.hypot(U.x, U.y), Math.hypot(V.x, V.y)) * 0.8;
    let step = 1;
    while (cell * step < 10) step *= 2;

    const gx0 = r.cx0 * CHUNK, gy0 = r.cy0 * CHUNK;
    const gx1 = (r.cx1 + 1) * CHUNK, gy1 = (r.cy1 + 1) * CHUNK;

    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(255,255,255,0.075)';
    ctx.beginPath();
    for (let x = Math.ceil(gx0 / step) * step; x <= gx1; x += step) {
      const a = this.toScreen(x, gy0, Z_MIN);
      const b = this.toScreen(x, gy1, Z_MIN);
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
    }
    for (let y = Math.ceil(gy0 / step) * step; y <= gy1; y += step) {
      const a = this.toScreen(gx0, y, Z_MIN);
      const b = this.toScreen(gx1, y, Z_MIN);
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
    }
    ctx.stroke();

    ctx.strokeStyle = 'rgba(255,255,255,0.175)';
    ctx.beginPath();
    const a = this.toScreen(0, gy0, Z_MIN), b = this.toScreen(0, gy1, Z_MIN);
    ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y);
    const c = this.toScreen(gx0, 0, Z_MIN), d = this.toScreen(gx1, 0, Z_MIN);
    ctx.moveTo(c.x, c.y); ctx.lineTo(d.x, d.y);
    ctx.stroke();
  }

  /* ── voxels and tiles ──────────────────────────────────────────────── */

  gather(r) {
    const g = this.buf;
    g.keys.length = 0; g.kinds.length = 0; g.notes.length = 0;
    g.xs.length = 0; g.ys.length = 0; g.zs.length = 0;
    g.mats.length = 0; g.masks.length = 0; g.ax.length = 0; g.ay.length = 0;
    g.fx.length = 0; g.fy.length = 0; g.fstart.length = 0; g.fcount.length = 0;
    g.fcol.length = 0; g.fstep.length = 0;

    const world = this.world;
    const v = this.v;
    const { U, V, W } = this.basis();
    const { ox, oy, scale } = this.cam;
    const W_ = this.w;
    const H_ = this.h;
    const topAt = (x, y) => world.topAt(x, y);
    let n = 0;

    // Bounding box of a box, relative to its origin corner, for culling.
    let minX = 0, maxX = 0, minY = 0, maxY = 0;
    for (const a of [0, 1]) for (const b of [0, 1]) for (const c of [0, 1]) {
      const px = a * U.x + b * V.x + c * W.x;
      const py = a * U.y + b * V.y + c * W.y;
      if (px < minX) minX = px;
      if (px > maxX) maxX = px;
      if (py < minY) minY = py;
      if (py > maxY) maxY = py;
    }

    outer:
    for (const chunk of world.chunks.values()) {
      if (chunk.cx < r.cx0 || chunk.cx > r.cx1 || chunk.cy < r.cy0 || chunk.cy > r.cy1) continue;
      const bx = chunk.cx * CHUNK;
      const by = chunk.cy * CHUNK;
      for (const [lk, mat] of chunk.data) {
        const x = bx + (lk & 15);
        const y = by + ((lk >> 4) & 15);
        const z = lk >>> 8;

        // Faces the camera cannot see are treated as covered, so a stack of
        // blocks collapses to the one block that is actually visible.
        const up = world.get(x, y, z + 1) !== undefined;
        const rt = !v.faceX || world.get(x + v.sx, y, z) !== undefined;
        const lf = !v.faceY || world.get(x, y + v.sy, z) !== undefined;
        if (up && rt && lf) continue;

        const ax = (x * v.cos - y * v.sin) * v.H * scale + ox;
        const ay = ((x * v.sin + y * v.cos) * v.D - z * v.C) * scale + oy;
        if (ax + maxX < -1 || ax + minX > W_ + 1) continue;
        if (ay + maxY < -1 || ay + minY > H_ + 1) continue;

        g.xs.push(x); g.ys.push(y); g.zs.push(z);
        g.mats.push(mat);
        // The top face carries its contact shading in the mask too: `up`, `rt`,
        // `lf` in the low three bits, the occlusion level (0…AO_STEPS) above
        // them. Only a summit draws a top face, so only a summit has to ask the
        // neighbours anything.
        g.masks.push((up ? 1 : 0) | (rt ? 2 : 0) | (lf ? 4 : 0)
          | (up ? 0 : occlusion(topAt, x, y, z) << 3));
        g.ax.push(ax); g.ay.push(ay);
        g.kinds.push(0); g.notes.push(0);
        g.fstart.push(0); g.fcount.push(0); g.fcol.push(0); g.fstep.push(0);
        g.keys.push(depthKey(x, y, z, v, n));
        if (++n >= KEY_MASK) break outer;
      }
    }

    // Note tiles ride the same painter order as the blocks they lie on, so a
    // hill in front of a note covers it instead of the note floating over it.
    const notes = world.notes;
    for (let ni = 0; ni < notes.length; ni++) {
      const note = notes[ni];
      const L = world.surfaceUnder(note.x, note.y, note.w, note.h);
      const a = this.toScreen(note.x, note.y, L);
      const bx = a.x + U.x * note.w;
      const by = a.y + U.y * note.w;
      const cx = bx + V.x * note.h;
      const cy = by + V.y * note.h;
      const dx = a.x + V.x * note.h;
      const dy = a.y + V.y * note.h;
      if (Math.max(a.x, bx, cx, dx) < -2 || Math.min(a.x, bx, cx, dx) > W_ + 2) continue;
      if (Math.max(a.y, by, cy, dy) < -2 || Math.min(a.y, by, cy, dy) > H_ + 2) continue;

      g.xs.push(note.x); g.ys.push(note.y); g.zs.push(L);
      g.mats.push(0); g.masks.push(0);
      g.kinds.push(1); g.notes.push(ni);
      g.ax.push(a.x); g.ay.push(a.y);
      g.fstart.push(0); g.fcount.push(0); g.fcol.push(0); g.fstep.push(0);
      g.keys.push(depthKey(note.x + note.w, note.y + note.h, L, v, n));
      if (++n >= KEY_MASK) break;
    }

    // Harness tiles are the same kind of object as notes: a ground quad in the
    // painter order, so terrain in front of one covers it.
    const chats = world.chats;
    for (let ci = 0; ci < chats.length; ci++) {
      const chat = chats[ci];
      const L = world.surfaceUnder(chat.x, chat.y, chat.w, chat.h);
      const a = this.toScreen(chat.x, chat.y, L);
      const bx = a.x + U.x * chat.w;
      const by = a.y + U.y * chat.w;
      const cx = bx + V.x * chat.h;
      const cy = by + V.y * chat.h;
      const dx = a.x + V.x * chat.h;
      const dy = a.y + V.y * chat.h;
      if (Math.max(a.x, bx, cx, dx) < -2 || Math.min(a.x, bx, cx, dx) > W_ + 2) continue;
      if (Math.max(a.y, by, cy, dy) < -2 || Math.min(a.y, by, cy, dy) > H_ + 2) continue;

      g.xs.push(chat.x); g.ys.push(chat.y); g.zs.push(L);
      g.mats.push(0); g.masks.push(0);
      g.kinds.push(4); g.notes.push(ci);
      g.ax.push(a.x); g.ay.push(a.y);
      g.fstart.push(0); g.fcount.push(0); g.fcol.push(0); g.fstep.push(0);
      g.keys.push(depthKey(chat.x + chat.w, chat.y + chat.h, L, v, n));
      if (++n >= KEY_MASK) break;
    }

    // Placed models: each face is projected and drawn as its own flat-shaded
    // polygon, keyed by its centroid so it sorts against the terrain exactly
    // where it stands. The prop's bounding box is culled once, then every face
    // gets its own painter key.
    const props = world.props;
    prop:
    for (let pi = 0; pi < props.length; pi++) {
      const prop = props[pi];
      const model = MODELS_BY_ID.get(prop.model);
      if (!model) continue;
      const frame = modelFrames(model)[(prop.rot | 0) & 3];
      const size = frame.size;
      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
      for (const dx of [0, size.w]) {
        for (const dy of [0, size.h]) {
          for (const dz of [0, size.hz]) {
            const p = this.toScreen(prop.x + dx, prop.y + dy, prop.z + dz);
            if (p.x < minX) minX = p.x;
            if (p.x > maxX) maxX = p.x;
            if (p.y < minY) minY = p.y;
            if (p.y > maxY) maxY = p.y;
          }
        }
      }
      if (maxX < -2 || minX > W_ + 2 || maxY < -2 || minY > H_ + 2) continue;

      // The prop's screen origin, and the linear coefficients that map a local
      // vertex offset to screen px. Both are view-constant, so no trig is
      // recomputed per vertex. The mesh is the one for this quarter turn.
      const o = { x: prop.x + frame.offset.x, y: prop.y + frame.offset.y, z: prop.z };
      const bx = (o.x * v.cos - o.y * v.sin) * v.H * scale + ox;
      const by = ((o.x * v.sin + o.y * v.cos) * v.D - o.z * v.C) * scale + oy;
      const verts = frame.verts;

      for (const f of frame.faces) {
        const fn = f.n;
        if (fn[0] * v.dx + fn[1] * v.dy + fn[2] * v.dz <= 0) continue;   // back-face cull
        const idx = f.v;
        const cnt = idx.length;
        const start = g.fx.length;
        let fMinX = Infinity, fMaxX = -Infinity, fMinY = Infinity, fMaxY = -Infinity;
        for (let j = 0; j < cnt; j++) {
          const p = verts[idx[j]];
          const sx = bx + p[0] * U.x + p[1] * V.x + p[2] * W.x;
          const sy = by + p[0] * U.y + p[1] * V.y + p[2] * W.y;
          g.fx.push(sx); g.fy.push(sy);
          if (sx < fMinX) fMinX = sx;
          if (sx > fMaxX) fMaxX = sx;
          if (sy < fMinY) fMinY = sy;
          if (sy > fMaxY) fMaxY = sy;
        }
        if (fMaxX < -2 || fMinX > W_ + 2 || fMaxY < -2 || fMinY > H_ + 2) {
          g.fx.length = start; g.fy.length = start;   // off-screen: drop the run
          continue;
        }
        g.xs.push(0); g.ys.push(0); g.zs.push(0);
        g.mats.push(0); g.masks.push(0);
        g.kinds.push(3); g.notes.push(0);
        g.ax.push(0); g.ay.push(0);
        g.fstart.push(start); g.fcount.push(cnt);
        g.fcol.push(f.col); g.fstep.push(toneStep(fn));
        g.keys.push(depthKey(o.x + f.c[0], o.y + f.c[1], o.z + f.c[2], v, n));
        if (++n >= KEY_MASK) break prop;
      }
    }
    g.keys.sort((a, b) => a - b);
  }

  drawSorted(ctx) {
    const g = this.buf;
    const keys = g.keys;
    const v = this.v;
    const { U, V, W } = this.basis();
    let style = '';

    ctx.lineWidth = 1;
    ctx.lineJoin = 'round';

    for (let i = 0; i < keys.length; i++) {
      const k = keys[i] & KEY_MASK;
      const kind = g.kinds[k];
      if (kind === 1) { this.drawNoteTile(ctx, this.world.notes[g.notes[k]], g.zs[k], U, V); continue; }
      if (kind === 4) { this.drawChatTile(ctx, this.world.chats[g.notes[k]], g.zs[k], U, V); continue; }

      if (kind === 3) {                           // a placed model's face
        const c = this.toneFor(g.fcol[k], g.fstep[k]);
        if (c !== style) { ctx.fillStyle = style = c; ctx.strokeStyle = style; }
        const s = g.fstart[k];
        const e = s + g.fcount[k];
        ctx.beginPath();
        ctx.moveTo(g.fx[s], g.fy[s]);
        for (let j = s + 1; j < e; j++) ctx.lineTo(g.fx[j], g.fy[j]);
        ctx.closePath();
        ctx.fill(); ctx.stroke();
        continue;
      }

      const P0 = { x: g.ax[k], y: g.ay[k] };
      const m = g.masks[k];
      const col = this.colors[g.mats[k]];
      const f = faceSet(P0, U, V, W, v);

      if (!(m & 1)) {                             // top, in its contact tone
        const c = col.top[m >> 3];
        if (c !== style) { ctx.fillStyle = style = c; ctx.strokeStyle = style; }
        ctx.beginPath();
        polyPath(ctx, f.top);
        ctx.fill(); ctx.stroke();
      }
      if (!(m & 2) && v.faceX) {                  // the visible x face
        const c = v.sx > 0 ? col.right : col.left;
        if (c !== style) { ctx.fillStyle = style = c; ctx.strokeStyle = style; }
        ctx.beginPath();
        polyPath(ctx, f.x);
        ctx.fill(); ctx.stroke();
      }
      if (!(m & 4) && v.faceY) {                  // the visible y face
        const c = v.sy > 0 ? col.left : col.right;
        if (c !== style) { ctx.fillStyle = style = c; ctx.strokeStyle = style; }
        ctx.beginPath();
        polyPath(ctx, f.y);
        ctx.fill(); ctx.stroke();
      }
    }
  }

  /* ── notes and harness tiles ───────────────────────────────────────── */

  /** Paper of a note tile: a solid slab lying on the surface. */
  drawNoteTile(ctx, note, level, U, V) {
    const paper = PAPER[((note.color | 0) % PAPER.length + PAPER.length) % PAPER.length];
    this.drawTile(ctx, note, level, U, V, paper);
  }

  /** The slab of a harness tile, drawn in the same painter order. */
  drawChatTile(ctx, chat, level, U, V) {
    const paper = CHAT_PAPER[((chat.color | 0) % CHAT_PAPER.length + CHAT_PAPER.length) % CHAT_PAPER.length];
    this.drawTile(ctx, chat, level, U, V, paper);
  }

  /**
   * A tile is a w*h block quad lying on the surface. Thickness: the same quad
   * pushed toward the viewer, so only the two camera-facing rims show and the
   * tile reads as a slab, not a decal.
   */
  drawTile(ctx, tile, level, U, V, paper) {
    const a = this.toScreen(tile.x, tile.y, level);
    const b = { x: a.x + U.x * tile.w, y: a.y + U.y * tile.w };
    const c = { x: b.x + V.x * tile.h, y: b.y + V.y * tile.h };
    const d = { x: a.x + V.x * tile.h, y: a.y + V.y * tile.h };

    ctx.fillStyle = shade(paper, 0.6);
    ctx.beginPath();
    ctx.moveTo(a.x + 1, a.y + 3);
    ctx.lineTo(b.x + 1, b.y + 3);
    ctx.lineTo(c.x + 1, c.y + 3);
    ctx.lineTo(d.x + 1, d.y + 3);
    ctx.closePath();
    ctx.fill();

    ctx.save();
    ctx.shadowColor = 'rgba(0, 0, 0, 0.45)';
    ctx.shadowBlur = 8;
    ctx.shadowOffsetX = 2;
    ctx.shadowOffsetY = 5;
    ctx.fillStyle = paper;
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.lineTo(c.x, c.y);
    ctx.lineTo(d.x, d.y);
    ctx.closePath();
    ctx.fill();
    ctx.restore();

    ctx.strokeStyle = shade(paper, 0.7);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.lineTo(c.x, c.y);
    ctx.lineTo(d.x, d.y);
    ctx.closePath();
    ctx.stroke();
  }

  /* ── hover feedback ────────────────────────────────────────────────── */

  drawHover(ctx) {
    const hv = this.hover;
    if (!hv || !hv.hit) return;
    const v = this.v;
    const { U, V, W } = this.basis();

    if (hv.tile) {
      const t = hv.tile;
      const a = this.toScreen(t.x, t.y, t.level);
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(a.x + U.x * t.w, a.y + U.y * t.w);
      ctx.lineTo(a.x + U.x * t.w + V.x * t.h, a.y + U.y * t.w + V.y * t.h);
      ctx.lineTo(a.x + V.x * t.h, a.y + V.y * t.h);
      ctx.closePath();
      ctx.fillStyle = hv.fill;
      ctx.fill();
      ctx.strokeStyle = hv.outline;
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }

    if (hv.cells.length) {
      ctx.fillStyle = hv.fill;
      ctx.beginPath();
      for (const c of hv.cells) {
        const f = faceSet(this.toScreen(c.x, c.y, c.z), U, V, W, v);
        polyPath(ctx, f.top);
        if (v.faceX) polyPath(ctx, f.x);
        if (v.faceY) polyPath(ctx, f.y);
      }
      ctx.fill();
    }

    if (hv.cursor) {
      const c = hv.cursor;
      ctx.strokeStyle = hv.outline;
      ctx.lineWidth = 1.5;
      const P0 = this.toScreen(c.x, c.y, c.z);
      ctx.beginPath();
      if (c.flat) {
        polyPath(ctx, [
          { x: P0.x + W.x, y: P0.y + W.y },
          { x: P0.x + W.x + U.x, y: P0.y + W.y + U.y },
          { x: P0.x + W.x + U.x + V.x, y: P0.y + W.y + U.y + V.y },
          { x: P0.x + W.x + V.x, y: P0.y + W.y + V.y },
        ]);
      } else {
        polyPath(ctx, boxOutline(P0, U, V, W));
      }
      ctx.stroke();
    }
  }
}
