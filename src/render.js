// Canvas renderer: visible-chunk culling + painter's algorithm.
//
// The view is a parallel projection, so a voxel's depth is the dot product of
// its cell with the view ray: sorting is one number per voxel, with no z-buffer
// and no per-pixel depth. Everything on screen is expressed through the three
// screen-space images of the world axes (U, V, W), so the same code draws the
// isometric view and the straight-down one.

import { Z_MIN, Z_MAX, CHUNK, project, unproject, ISO } from './iso.js';
import { PALETTE, PAPER } from './world.js';

const KEY_SHIFT = 1048576;    // 2^20, the index field of the packed sort key
const KEY_MASK = KEY_SHIFT - 1;
const DEPTH_BIAS = 4096;
const DEPTH_SCALE = 4096;

function shade(hex, f) {
  const n = parseInt(hex.slice(1), 16);
  const r = Math.round(((n >> 16) & 255) * f);
  const g = Math.round(((n >> 8) & 255) * f);
  const b = Math.round((n & 255) * f);
  return `rgb(${r},${g},${b})`;
}

export class Renderer {
  constructor(canvas, world) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.world = world;
    this.cam = { ox: 0, oy: 0, scale: 1, tilt: 0, view: ISO };
    this.hover = null;         // { hit, cells, tile, fill, outline, cursor }
    this.colors = PALETTE.map((p) => ({
      top: p.color,
      right: shade(p.color, 0.79),
      left: shade(p.color, 0.6),
      raw: p.color,
    }));
    // Reused per-frame buffers (no allocation while panning).
    this.buf = { keys: [], kinds: [], notes: [], xs: [], ys: [], zs: [], mats: [], masks: [], ax: [], ay: [] };
    this.resize();
  }

  /** The current view parameters (kept on the camera so it is saved with it). */
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
  basis() {
    const v = this.v;
    const s = this.cam.scale;
    return {
      U: { x: v.cos * v.H * s, y: v.sin * v.D * s },
      V: { x: -v.sin * v.H * s, y: v.cos * v.D * s },
      W: { x: 0, y: -v.C * s },
    };
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

    const world = this.world;
    const v = this.v;
    const { U, V, W } = this.basis();
    const { ox, oy, scale } = this.cam;
    const W_ = this.w;
    const H_ = this.h;
    let n = 0;

    // Silhouette of a cube relative to its top vertex, used for culling.
    const off = [
      [0, 0],
      [U.x, U.y],
      [U.x, U.y - W.y],
      [U.x + V.x, U.y + V.y - W.y],
      [V.x, V.y - W.y],
      [V.x, V.y],
    ];
    let minX = 0, maxX = 0, minY = 0, maxY = 0;
    for (const [px, py] of off) {
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

        // Faces that cannot be seen are treated as covered, so a stack of
        // blocks under a straight-down view collapses to its top one.
        const up = world.get(x, y, z + 1) !== undefined;
        const rt = !v.faceX || world.get(x + 1, y, z) !== undefined;
        const lf = !v.faceY || world.get(x, y + 1, z) !== undefined;
        if (up && rt && lf) continue;

        const ax = (x * v.cos - y * v.sin) * v.H * scale + ox;
        const ay = ((x * v.sin + y * v.cos) * v.D - (z + 1) * v.C) * scale + oy;
        if (ax + maxX < -1 || ax + minX > W_ + 1) continue;
        if (ay + maxY < -1 || ay + minY > H_ + 1) continue;

        g.xs.push(x); g.ys.push(y); g.zs.push(z);
        g.mats.push(mat);
        g.masks.push((up ? 1 : 0) | (rt ? 2 : 0) | (lf ? 4 : 0));
        g.ax.push(ax); g.ay.push(ay);
        g.kinds.push(0); g.notes.push(0);
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
      g.keys.push(depthKey(note.x + note.w, note.y + note.h, L, v, n));
      if (++n >= KEY_MASK) break;
    }
    g.keys.sort((a, b) => a - b);
  }

  drawSorted(ctx) {
    const g = this.buf;
    const keys = g.keys;
    const { U, V, W } = this.basis();
    let style = '';

    ctx.lineWidth = 1;
    ctx.lineJoin = 'round';

    for (let i = 0; i < keys.length; i++) {
      const k = keys[i] & KEY_MASK;
      if (g.kinds[k] === 1) { this.drawNoteTile(ctx, this.world.notes[g.notes[k]], g.zs[k], U, V); continue; }
      const m = g.masks[k];
      const A = g.ax[k];
      const B = g.ay[k];
      const col = this.colors[g.mats[k]];

      if (!(m & 1)) {                             // top
        if (col.top !== style) { ctx.fillStyle = style = col.top; ctx.strokeStyle = style; }
        ctx.beginPath();
        ctx.moveTo(A, B);
        ctx.lineTo(A + U.x, B + U.y);
        ctx.lineTo(A + U.x + V.x, B + U.y + V.y);
        ctx.lineTo(A + V.x, B + V.y);
        ctx.closePath();
        ctx.fill(); ctx.stroke();
      }
      if (!(m & 2)) {                             // +x
        if (col.right !== style) { ctx.fillStyle = style = col.right; ctx.strokeStyle = style; }
        ctx.beginPath();
        ctx.moveTo(A + U.x, B + U.y);
        ctx.lineTo(A + U.x + V.x, B + U.y + V.y);
        ctx.lineTo(A + U.x + V.x - W.x, B + U.y + V.y - W.y);
        ctx.lineTo(A + U.x - W.x, B + U.y - W.y);
        ctx.closePath();
        ctx.fill(); ctx.stroke();
      }
      if (!(m & 4)) {                             // +y
        if (col.left !== style) { ctx.fillStyle = style = col.left; ctx.strokeStyle = style; }
        ctx.beginPath();
        ctx.moveTo(A + V.x, B + V.y);
        ctx.lineTo(A + U.x + V.x, B + U.y + V.y);
        ctx.lineTo(A + U.x + V.x - W.x, B + U.y + V.y - W.y);
        ctx.lineTo(A + V.x - W.x, B + V.y - W.y);
        ctx.closePath();
        ctx.fill(); ctx.stroke();
      }
    }
  }

  /* ── notes ─────────────────────────────────────────────────────────── */

  /** Paper of a note tile: a solid slab lying on the surface. */
  drawNoteTile(ctx, note, level, U, V) {
    const a = this.toScreen(note.x, note.y, level);
    const b = { x: a.x + U.x * note.w, y: a.y + U.y * note.w };
    const c = { x: b.x + V.x * note.h, y: b.y + V.y * note.h };
    const d = { x: a.x + V.x * note.h, y: a.y + V.y * note.h };
    const paper = PAPER[((note.color | 0) % PAPER.length + PAPER.length) % PAPER.length];

    // Thickness: the same quad pushed toward the viewer, so only the two
    // camera-facing rims show and the paper reads as a slab, not a decal.
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
        const p = this.toScreen(c.x, c.y, c.z + 1);
        const A = p.x, B = p.y;
        ctx.moveTo(A, B);
        ctx.lineTo(A + U.x, B + U.y);
        ctx.lineTo(A + U.x + V.x, B + U.y + V.y);
        ctx.lineTo(A + V.x, B + V.y);
        ctx.closePath();
        ctx.moveTo(A + U.x, B + U.y);
        ctx.lineTo(A + U.x + V.x, B + U.y + V.y);
        ctx.lineTo(A + U.x + V.x - W.x, B + U.y + V.y - W.y);
        ctx.lineTo(A + U.x - W.x, B + U.y - W.y);
        ctx.closePath();
        ctx.moveTo(A + V.x, B + V.y);
        ctx.lineTo(A + U.x + V.x, B + U.y + V.y);
        ctx.lineTo(A + U.x + V.x - W.x, B + U.y + V.y - W.y);
        ctx.lineTo(A + V.x - W.x, B + V.y - W.y);
        ctx.closePath();
      }
      ctx.fill();
    }

    if (hv.cursor) {
      const c = hv.cursor;
      ctx.strokeStyle = hv.outline;
      ctx.lineWidth = 1.5;
      const p = this.toScreen(c.x, c.y, c.z + 1);
      const A = p.x, B = p.y;
      ctx.beginPath();
      if (c.flat) {
        ctx.moveTo(A, B);
        ctx.lineTo(A + U.x, B + U.y);
        ctx.lineTo(A + U.x + V.x, B + U.y + V.y);
        ctx.lineTo(A + V.x, B + V.y);
      } else {
        ctx.moveTo(A, B);
        ctx.lineTo(A + U.x, B + U.y);
        ctx.lineTo(A + U.x - W.x, B + U.y - W.y);
        ctx.lineTo(A + U.x + V.x - W.x, B + U.y + V.y - W.y);
        ctx.lineTo(A + V.x - W.x, B + V.y - W.y);
        ctx.lineTo(A + V.x, B + V.y);
      }
      ctx.closePath();
      ctx.stroke();
    }
  }
}

/** Packed painter key: depth along the view ray, then insertion index. */
function depthKey(x, y, z, v, n) {
  const depth = x * v.dx + y * v.dy + z * v.dz;
  return Math.round((depth + DEPTH_BIAS) * DEPTH_SCALE) * KEY_SHIFT + n;
}
