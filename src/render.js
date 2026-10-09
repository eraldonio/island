// Canvas renderer: visible-chunk culling + painter's algorithm.
//
// Because the camera angle is fixed, a voxel's depth is exactly x+y+z, so
// sorting is a single integer per voxel — no z-buffer, no per-pixel depth.

import { HW, HH, VZ, Z_MIN, Z_MAX, CHUNK, project, unproject } from './iso.js';
import { PALETTE } from './world.js';

const KEY_SHIFT = 1048576;   // 2^20, index field of the packed sort key
const KEY_MASK = KEY_SHIFT - 1;
const DEPTH_BIAS = 16384;

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
    this.cam = { ox: 0, oy: 0, scale: 1 };
    this.hover = null;         // { hit, cells, tint, alpha }
    this.colors = PALETTE.map((p) => ({
      top: p.color,
      right: shade(p.color, 0.79),
      left: shade(p.color, 0.6),
      raw: p.color,
    }));
    // Reused per-frame buffers (no allocation while panning).
    this.buf = { keys: [], xs: [], ys: [], zs: [], mats: [], masks: [], ax: [], ay: [] };
    this.resize();
  }

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

  /** World point -> screen px, including pan and zoom. */
  toScreen(x, y, z) {
    const p = project(x, y, z);
    return { x: this.cam.ox + p.x * this.cam.scale, y: this.cam.oy + p.y * this.cam.scale };
  }

  /** Screen px (viewport-relative) -> isometric space, for picking. */
  toIso(px, py) {
    return { ix: (px - this.cam.ox) / this.cam.scale, iy: (py - this.cam.oy) / this.cam.scale };
  }

  /** Chunk range whose columns can touch the viewport, at any height. */
  visibleChunks() {
    const { ox, oy, scale } = this.cam;
    const pts = [];
    for (const [sx, sy] of [[0, 0], [this.w, 0], [0, this.h], [this.w, this.h]]) {
      const ix = (sx - ox) / scale;
      const iy = (sy - oy) / scale;
      pts.push(unproject(ix, iy, Z_MIN), unproject(ix, iy, Z_MAX));
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
    this.drawVoxels(ctx);
    this.drawHover(ctx);
  }

  /* ── ground grid ───────────────────────────────────────────────────── */

  drawGround(ctx, r) {
    const s = this.cam.scale;
    let step = 1;
    while (HW * s * step < 10) step *= 2;

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

  /* ── voxels ────────────────────────────────────────────────────────── */

  gather(r) {
    const g = this.buf;
    g.keys.length = 0; g.xs.length = 0; g.ys.length = 0; g.zs.length = 0;
    g.mats.length = 0; g.masks.length = 0; g.ax.length = 0; g.ay.length = 0;

    const world = this.world;
    const { ox, oy, scale } = this.cam;
    const hw = HW * scale, hh = HH * scale, vz = VZ * scale;
    const W = this.w, H = this.h;
    let n = 0;

    outer:
    for (const chunk of world.chunks.values()) {
      if (chunk.cx < r.cx0 || chunk.cx > r.cx1 || chunk.cy < r.cy0 || chunk.cy > r.cy1) continue;
      const bx = chunk.cx * CHUNK;
      const by = chunk.cy * CHUNK;
      for (const [lk, mat] of chunk.data) {
        const x = bx + (lk & 15);
        const y = by + ((lk >> 4) & 15);
        const z = lk >>> 8;

        const up = world.get(x, y, z + 1) !== undefined;
        const rt = world.get(x + 1, y, z) !== undefined;
        const lf = world.get(x, y + 1, z) !== undefined;
        if (up && rt && lf) continue;   // fully hidden behind its neighbours

        const ax = (x - y) * HW * scale + ox;
        const ay = ((x + y) * HH - (z + 1) * VZ) * scale + oy;
        if (ax + hw < -1 || ax - hw > W + 1) continue;
        if (ay + 2 * hh + vz < -1 || ay - hh > H + 1) continue;

        g.xs.push(x); g.ys.push(y); g.zs.push(z);
        g.mats.push(mat);
        g.masks.push((up ? 1 : 0) | (rt ? 2 : 0) | (lf ? 4 : 0));
        g.ax.push(ax); g.ay.push(ay);
        g.keys.push((x + y + z + DEPTH_BIAS) * KEY_SHIFT + n);
        if (++n >= KEY_MASK) break outer;
      }
    }
    g.keys.sort((a, b) => a - b);
  }

  drawVoxels(ctx) {
    const g = this.buf;
    const keys = g.keys;
    const s = this.cam.scale;
    const hw = HW * s, hh = HH * s, vz = VZ * s, h2 = 2 * hh;
    let style = '';

    ctx.lineWidth = 1;
    ctx.lineJoin = 'round';

    for (let i = 0; i < keys.length; i++) {
      const k = keys[i] & KEY_MASK;
      const m = g.masks[k];
      const A = g.ax[k];
      const B = g.ay[k];
      const col = this.colors[g.mats[k]];

      if (!(m & 1)) {                             // +z (top)
        if (col.top !== style) { ctx.fillStyle = style = col.top; ctx.strokeStyle = style; }
        ctx.beginPath();
        ctx.moveTo(A, B);
        ctx.lineTo(A + hw, B + hh);
        ctx.lineTo(A, B + h2);
        ctx.lineTo(A - hw, B + hh);
        ctx.closePath();
        ctx.fill(); ctx.stroke();
      }
      if (!(m & 2)) {                             // +x (right)
        if (col.right !== style) { ctx.fillStyle = style = col.right; ctx.strokeStyle = style; }
        ctx.beginPath();
        ctx.moveTo(A + hw, B + hh);
        ctx.lineTo(A, B + h2);
        ctx.lineTo(A, B + h2 + vz);
        ctx.lineTo(A + hw, B + hh + vz);
        ctx.closePath();
        ctx.fill(); ctx.stroke();
      }
      if (!(m & 4)) {                             // +y (left)
        if (col.left !== style) { ctx.fillStyle = style = col.left; ctx.strokeStyle = style; }
        ctx.beginPath();
        ctx.moveTo(A - hw, B + hh);
        ctx.lineTo(A, B + h2);
        ctx.lineTo(A, B + h2 + vz);
        ctx.lineTo(A - hw, B + hh + vz);
        ctx.closePath();
        ctx.fill(); ctx.stroke();
      }
    }
  }

  /* ── hover feedback ────────────────────────────────────────────────── */

  drawHover(ctx) {
    const hv = this.hover;
    if (!hv || !hv.hit) return;

    const s = this.cam.scale;
    const hw = HW * s, hh = HH * s, vz = VZ * s, h2 = 2 * hh;

    if (hv.cells.length) {
      ctx.fillStyle = hv.fill;
      ctx.beginPath();
      for (const c of hv.cells) {
        const p = this.toScreen(c.x, c.y, c.z + 1);
        const A = p.x, B = p.y;
        ctx.moveTo(A, B);
        ctx.lineTo(A + hw, B + hh);
        ctx.lineTo(A, B + h2);
        ctx.lineTo(A - hw, B + hh);
        ctx.closePath();
        ctx.moveTo(A + hw, B + hh);
        ctx.lineTo(A, B + h2);
        ctx.lineTo(A, B + h2 + vz);
        ctx.lineTo(A + hw, B + hh + vz);
        ctx.closePath();
        ctx.moveTo(A - hw, B + hh);
        ctx.lineTo(A, B + h2);
        ctx.lineTo(A, B + h2 + vz);
        ctx.lineTo(A - hw, B + hh + vz);
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
        ctx.lineTo(A + hw, B + hh);
        ctx.lineTo(A, B + h2);
        ctx.lineTo(A - hw, B + hh);
      } else {
        ctx.moveTo(A, B);
        ctx.lineTo(A + hw, B + hh);
        ctx.lineTo(A + hw, B + hh + vz);
        ctx.lineTo(A, B + h2 + vz);
        ctx.lineTo(A - hw, B + hh + vz);
        ctx.lineTo(A - hw, B + hh);
      }
      ctx.closePath();
      ctx.stroke();
    }
  }
}
