// The model library: low-poly objects you can stamp into the world.
//
// Every model is a small polygon mesh — vertices in block units, faces of three
// or four of them — grown from a handful of faceted primitives (box, ball, dome,
// tube, log, roof, ring) rather than a hand-written vertex list, which keeps the
// shapes readable and the file short. A model's own size has nothing to do with
// the map's grid: the grid only decides which whole blocks a model claims when
// it is placed, the mesh is centred inside that footprint, and it rests on the
// surface it stands on. Nothing about the map's voxel size leaks into a shape.
//
// Faces are flat-shaded by the renderer from their outward normal (`toneStep` in
// render.js), so a face is the unit of both shape and colour: the primitives are
// coarse enough to read as low-poly and round enough to read as cute. A face
// carries a colour, not a material id — the authored models use the world's
// palette (so a stamped tree matches the terrain), while meshes baked in from a
// pack keep whatever colours they were authored with.
//
// Winding is outward — a face whose normal points away from the camera is culled
// — and every convex primitive orients its own faces away from its own centre, so
// a primitive's winding cannot be got wrong by hand.

import { PALETTE } from './world.js';
import { PACK } from './models.packs.js';

export const MODELS = [];

const [GRASS, DIRT, STONE, SAND, WOOD, BRICK, SNOW, SLATE, LEAF, ROAD, GOLD, , GLASS] =
  PALETTE.map((p) => p.color);

/* ── the mesh ────────────────────────────────────────────────────────── */

const r4 = (v) => Math.round(v * 1e4) / 1e4;

/** Newell normal of a face, or null when the face is degenerate. */
function normalOf(verts, ids) {
  let nx = 0, ny = 0, nz = 0;
  for (let i = 0; i < ids.length; i++) {
    const a = verts[ids[i]];
    const b = verts[ids[(i + 1) % ids.length]];
    nx += (a[1] - b[1]) * (a[2] + b[2]);
    ny += (a[2] - b[2]) * (a[0] + b[0]);
    nz += (a[0] - b[0]) * (a[1] + b[1]);
  }
  const len = Math.hypot(nx, ny, nz);
  return len > 1e-9 ? [nx / len, ny / len, nz / len] : null;
}

class Mesh {
  constructor() {
    this.verts = [];
    this.faces = [];
    this.seen = new Map();      // rounded position -> vertex index
  }

  /** Vertex index for a position, reusing the vertex when it already exists. */
  v(x, y, z) {
    const key = r4(x) + ',' + r4(y) + ',' + r4(z);
    let i = this.seen.get(key);
    if (i === undefined) {
      i = this.verts.length;
      this.verts.push([x, y, z]);
      this.seen.set(key, i);
    }
    return i;
  }

  /**
   * One face, as vertex indices in outward order. `away` is a point it must
   * look away from — the primitive's own centre — which flips the winding when
   * the caller authored it inside out. Omit it for faces that carry their own
   * order (the inner side of a shell).
   */
  face(col, ids, away) {
    const n = normalOf(this.verts, ids);
    if (!n) return;
    let c = 0, d = 0, e = 0;
    for (const i of ids) { c += this.verts[i][0]; d += this.verts[i][1]; e += this.verts[i][2]; }
    c /= ids.length; d /= ids.length; e /= ids.length;
    if (away && (c - away[0]) * n[0] + (d - away[1]) * n[1] + (e - away[2]) * n[2] < 0) {
      ids.reverse();
      n[0] = -n[0]; n[1] = -n[1]; n[2] = -n[2];
    }
    this.faces.push({ v: ids, col, n, c: [c, d, e] });
  }

  /** Face from bare positions: `poly(col, [x,y,z], [x,y,z], [x,y,z], …)`. */
  poly(col, ...pts) { this.face(col, pts.map((p) => this.v(p[0], p[1], p[2])), null); }

  quad(col, a, b, c, d, away) { this.face(col, [this.v(...a), this.v(...b), this.v(...c), this.v(...d)], away); }

  tri(col, a, b, c, away) { this.face(col, [this.v(...a), this.v(...b), this.v(...c)], away); }

  /** Mark to hand to `paint`, so a pass touches only the faces added after it. */
  mark() { return this.faces.length; }

  /** Recolour faces from `from` on, wherever `pick` returns a colour. */
  paint(from, pick) {
    for (let i = from; i < this.faces.length; i++) {
      const col = pick(this.faces[i], i);
      if (col != null) this.faces[i].col = col;
    }
  }
}

/* ── primitives ──────────────────────────────────────────────────────── */

/** Box, centred, with full extents `sx sy sz` and a yaw about z. */
function box(m, col, cx, cy, cz, sx, sy, sz, yaw = 0) {
  const ca = Math.cos(yaw), sa = Math.sin(yaw);
  const at = [];
  for (const i of [0, 1]) {
    for (const j of [0, 1]) {
      for (const k of [0, 1]) {
        const x = (i - 0.5) * sx, y = (j - 0.5) * sy;
        at.push([cx + x * ca - y * sa, cy + x * sa + y * ca, cz + (k - 0.5) * sz]);
      }
    }
  }
  const p = (i, j, k) => at[i * 4 + j * 2 + k];
  const c = [cx, cy, cz];
  m.quad(col, p(0, 0, 0), p(0, 1, 0), p(1, 1, 0), p(1, 0, 0), c);   // bottom
  m.quad(col, p(0, 0, 1), p(1, 0, 1), p(1, 1, 1), p(0, 1, 1), c);   // top
  m.quad(col, p(0, 0, 0), p(1, 0, 0), p(1, 0, 1), p(0, 0, 1), c);   // -y
  m.quad(col, p(1, 1, 0), p(0, 1, 0), p(0, 1, 1), p(1, 1, 1), c);   // +y
  m.quad(col, p(0, 1, 0), p(0, 0, 0), p(0, 0, 1), p(0, 1, 1), c);   // -x
  m.quad(col, p(1, 0, 0), p(1, 1, 0), p(1, 1, 1), p(1, 0, 1), c);   // +x
}

/** Vertices of an elliptical ring in the xy-plane, one per segment. */
function ringAt(m, cx, cy, z, rx, ry, seg) {
  const ids = [];
  for (let s = 0; s < seg; s++) {
    const a = (2 * Math.PI * s) / seg;
    ids.push(m.v(cx + rx * Math.cos(a), cy + ry * Math.sin(a), z));
  }
  return ids;
}

/** Ring of a tube or a log, collapsing to one apex vertex at r = 0. */
function circle(m, cx, cy, z, r, seg) {
  return r <= 1e-6 ? [m.v(cx, cy, z)] : ringAt(m, cx, cy, z, r, r, seg);
}

/**
 * Faceted ellipsoid: `seg` facets around z, `rings` bands pole to pole. This is
 * the workhorse for anything round — bodies, heads, clumps, boulders, fruit.
 */
function ball(m, col, cx, cy, cz, rx, ry, rz, seg = 9, rings = 4) {
  const rows = [];
  for (let r = 0; r <= rings; r++) {
    const t = r / rings;
    const z = cz - rz * Math.cos(Math.PI * t);
    const rr = Math.sin(Math.PI * t);
    rows.push(r === 0 || r === rings ? [m.v(cx, cy, z)] : ringAt(m, cx, cy, z, rx * rr, ry * rr, seg));
  }
  const c = [cx, cy, cz];
  for (let r = 0; r < rings; r++) {
    const lo = rows[r], hi = rows[r + 1];
    for (let s = 0; s < seg; s++) {
      const t = (s + 1) % seg;
      if (r === 0) m.face(col, [lo[0], hi[t], hi[s]], c);
      else if (r === rings - 1) m.face(col, [hi[0], lo[s], lo[t]], c);
      else m.face(col, [lo[s], lo[t], hi[t], hi[s]], c);
    }
  }
}

/** Upper half of an ellipsoid, closed underneath: a mushroom cap, a lid. */
function dome(m, col, cx, cy, cz, rx, ry, rz, seg = 10, rings = 3) {
  const rows = [];
  for (let r = 0; r <= rings; r++) {
    const t = (r / rings) * (Math.PI / 2);
    const z = cz + rz * Math.sin(t);
    const rr = Math.cos(t);
    rows.push(r === rings ? [m.v(cx, cy, z)] : ringAt(m, cx, cy, z, rx * rr, ry * rr, seg));
  }
  const c = [cx, cy, cz];
  for (let r = 0; r < rings; r++) {
    const lo = rows[r], hi = rows[r + 1];
    for (let s = 0; s < seg; s++) {
      const t = (s + 1) % seg;
      if (r === rings - 1) m.face(col, [hi[0], lo[s], lo[t]], c);
      else m.face(col, [lo[s], lo[t], hi[t], hi[s]], c);
    }
  }
  m.face(col, ringAt(m, cx, cy, cz, rx, ry, seg), [cx, cy, cz + 1]);
}

/** Flat elliptical disc; `up` faces +z, otherwise -z (water, hatch, lids). */
function disc(m, col, cx, cy, z, rx, ry, seg = 10, up = true) {
  const ids = [];
  for (let s = 0; s < seg; s++) {
    const a = (2 * Math.PI * s) / seg;
    ids.push(m.v(cx + rx * Math.cos(a), cy + ry * Math.sin(a), z));
  }
  m.face(col, ids, [cx, cy, up ? z - 1 : z + 1]);
}

/** Vertical tube: cylinder, frustum, or a cone when `r1` is 0. */
function tube(m, col, cx, cy, z0, z1, r0, r1 = r0, seg = 8, capBot = false, capTop = true) {
  const bot = circle(m, cx, cy, z0, r0, seg);
  const top = circle(m, cx, cy, z1, r1, seg);
  const c = [cx, cy, (z0 + z1) / 2];
  for (let s = 0; s < seg; s++) {
    const t = (s + 1) % seg;
    if (top.length === 1) m.face(col, [bot[s], bot[t], top[0]], c);
    else if (bot.length === 1) m.face(col, [bot[0], top[s], top[t]], c);
    else m.face(col, [bot[s], bot[t], top[t], top[s]], c);
  }
  if (capTop && top.length > 1) m.face(col, top.slice(), [cx, cy, z1 - 1]);
  if (capBot && bot.length > 1) m.face(col, bot.slice(), [cx, cy, z0 + 1]);
}

/** Horizontal tube between two ground points: a log, or a spike when `r1` is 0. */
function log(m, col, x0, y0, x1, y1, z, r0, r1 = r0, seg = 6, capStart = true, capEnd = true) {
  const dx = x1 - x0, dy = y1 - y0;
  const len = Math.hypot(dx, dy) || 1;
  const ux = -dy / len, uy = dx / len;          // the ring's radial basis
  const ring = (x, y, r) => {
    if (r <= 1e-6) return [m.v(x, y, z)];
    const ids = [];
    for (let s = 0; s < seg; s++) {
      const a = (2 * Math.PI * s) / seg;
      ids.push(m.v(x + ux * r * Math.cos(a), y + uy * r * Math.cos(a), z + r * Math.sin(a)));
    }
    return ids;
  };
  const a0 = ring(x0, y0, r0), a1 = ring(x1, y1, r1);
  const c = [(x0 + x1) / 2, (y0 + y1) / 2, z];
  for (let s = 0; s < seg; s++) {
    const t = (s + 1) % seg;
    if (a1.length === 1) m.face(col, [a0[s], a0[t], a1[0]], c);
    else if (a0.length === 1) m.face(col, [a0[0], a1[s], a1[t]], c);
    else m.face(col, [a0[s], a0[t], a1[t], a1[s]], c);
  }
  if (capStart && a0.length > 1) m.face(col, a0.slice(), c);
  if (capEnd && a1.length > 1) m.face(col, a1.slice(), c);
}

/** Gable roof: two slopes and two gable ends, the ridge along x at `cy`. */
function roof(m, col, cx, cy, zEave, zRidge, sx, sy) {
  const x0 = cx - sx / 2, x1 = cx + sx / 2, y0 = cy - sy / 2, y1 = cy + sy / 2;
  const c = [cx, cy, (zEave + zRidge) / 2];
  m.quad(col, [x0, y0, zEave], [x1, y0, zEave], [x1, cy, zRidge], [x0, cy, zRidge], c);
  m.quad(col, [x1, y1, zEave], [x0, y1, zEave], [x0, cy, zRidge], [x1, cy, zRidge], c);
  m.tri(col, [x0, y0, zEave], [x0, cy, zRidge], [x0, y1, zEave], c);
  m.tri(col, [x1, y0, zEave], [x1, y1, zEave], [x1, cy, zRidge], c);
}

/** Annulus wall with both rims: a well's kerb, a rim of a tub. */
function ring(m, col, cx, cy, z0, z1, rOut, rIn, seg = 9) {
  const o0 = circle(m, cx, cy, z0, rOut, seg), o1 = circle(m, cx, cy, z1, rOut, seg);
  const i0 = circle(m, cx, cy, z0, rIn, seg), i1 = circle(m, cx, cy, z1, rIn, seg);
  const c = [cx, cy, (z0 + z1) / 2];
  for (let s = 0; s < seg; s++) {
    const t = (s + 1) % seg;
    m.face(col, [o0[s], o0[t], o1[t], o1[s]], c);                        // outer, faces out
    m.face(col, [i1[s], i1[t], i0[t], i0[s]]);                           // inner, faces the axis
    m.face(col, [o1[s], o1[t], i1[t], i1[s]], [cx, cy, z1 - 1]);         // rim up
    m.face(col, [i0[s], i0[t], o0[t], o0[s]], [cx, cy, z0 + 1]);         // rim down
  }
}

/**
 * One flat face as a `cols` x `rows` grid, `cell(col, row)` picking a colour
 * per cell. A door or a window has to be real geometry rather than a patch laid
 * on the wall: a coplanar patch of another colour sorts behind the wall it sits
 * on (the wall's centroid is nearer the camera than the patch's) and is never
 * seen, while a grid cell *is* that wall, shaded by its own colour. `away` is a
 * point the wall must look away from — inside the building — so the four walls
 * of a box cannot be wound inside out by hand.
 */
function grid(m, base, a, b, c, d, cols, rows, cell, away) {
  const at = (u, v) => [
    a[0] * (1 - u) * (1 - v) + b[0] * u * (1 - v) + c[0] * u * v + d[0] * (1 - u) * v,
    a[1] * (1 - u) * (1 - v) + b[1] * u * (1 - v) + c[1] * u * v + d[1] * (1 - u) * v,
    a[2] * (1 - u) * (1 - v) + b[2] * u * (1 - v) + c[2] * u * v + d[2] * (1 - u) * v,
  ];
  for (let col = 0; col < cols; col++) {
    for (let row = 0; row < rows; row++) {
      m.quad(cell(col, row) ?? base, at(col / cols, row / rows), at((col + 1) / cols, row / rows),
        at((col + 1) / cols, (row + 1) / rows), at(col / cols, (row + 1) / rows), away);
    }
  }
}

/* ── the models ──────────────────────────────────────────────────────── */

function duck(m) {
  ball(m, SAND, 0.50, 0.50, 0.33, 0.36, 0.31, 0.30, 9, 4);              // body
  ball(m, SAND, 0.18, 0.50, 0.52, 0.15, 0.13, 0.16, 6, 3);              // tail
  ball(m, SAND, 0.67, 0.50, 0.64, 0.21, 0.19, 0.19, 8, 3);              // head
  log(m, BRICK, 0.84, 0.50, 1.02, 0.50, 0.61, 0.09, 0, 6, true, false); // beak
  ball(m, SLATE, 0.76, 0.42, 0.73, 0.035, 0.035, 0.035, 5, 2);          // eyes
  ball(m, SLATE, 0.76, 0.58, 0.73, 0.035, 0.035, 0.035, 5, 2);
}

function penguin(m) {
  ball(m, SLATE, 0.50, 0.50, 0.40, 0.27, 0.25, 0.40, 8, 4);             // body
  ball(m, SNOW, 0.50, 0.44, 0.34, 0.20, 0.16, 0.28, 7, 3);              // white front
  ball(m, SLATE, 0.50, 0.50, 0.86, 0.18, 0.17, 0.17, 7, 3);             // head
  log(m, GOLD, 0.64, 0.50, 0.82, 0.50, 0.84, 0.055, 0, 5, true, false); // beak
  ball(m, SNOW, 0.56, 0.43, 0.90, 0.03, 0.03, 0.03, 4, 2);              // eyes
  ball(m, SNOW, 0.56, 0.57, 0.90, 0.03, 0.03, 0.03, 4, 2);
  box(m, GOLD, 0.38, 0.44, 0.03, 0.24, 0.14, 0.06);                     // feet
  box(m, GOLD, 0.62, 0.56, 0.03, 0.24, 0.14, 0.06);
}

function bear(m) {
  ball(m, DIRT, 0.44, 0.50, 0.60, 0.36, 0.28, 0.30, 8, 4);              // body
  ball(m, DIRT, 0.78, 0.50, 0.86, 0.22, 0.21, 0.22, 7, 3);              // head
  ball(m, DIRT, 0.90, 0.50, 0.76, 0.13, 0.11, 0.10, 6, 3);              // muzzle
  ball(m, SLATE, 0.98, 0.50, 0.74, 0.045, 0.045, 0.04, 4, 2);           // nose
  ball(m, DIRT, 0.70, 0.38, 1.02, 0.08, 0.08, 0.08, 5, 2);              // ears
  ball(m, DIRT, 0.70, 0.62, 1.02, 0.08, 0.08, 0.08, 5, 2);
  for (const [x, y] of [[0.26, 0.32], [0.26, 0.68], [0.66, 0.32], [0.66, 0.68]])
    tube(m, DIRT, x, y, 0.0, 0.34, 0.10, 0.09, 5, false, false);        // legs
}

function lion(m) {
  ball(m, SAND, 0.42, 0.50, 0.40, 0.32, 0.24, 0.22, 8, 4);              // body
  ball(m, GOLD, 0.76, 0.50, 0.48, 0.25, 0.24, 0.26, 8, 3);              // mane
  ball(m, SAND, 0.84, 0.50, 0.48, 0.17, 0.16, 0.17, 7, 3);              // face
  log(m, SAND, 0.12, 0.50, -0.04, 0.50, 0.46, 0.04, 0.025, 4, true, true); // tail
  ball(m, GOLD, -0.04, 0.50, 0.46, 0.055, 0.05, 0.055, 5, 2);           // tail tuft
  for (const [x, y] of [[0.24, 0.34], [0.24, 0.66], [0.58, 0.34], [0.58, 0.66]])
    tube(m, SAND, x, y, 0.0, 0.22, 0.085, 0.075, 5, false, false);      // legs
}

function camel(m) {
  ball(m, SAND, 0.50, 0.50, 0.82, 0.34, 0.26, 0.22, 8, 4);              // body
  ball(m, SAND, 0.50, 0.50, 1.00, 0.22, 0.19, 0.15, 7, 3);              // hump
  for (let i = 0; i <= 3; i++) {                                        // neck, up and forward
    const t = i / 3;
    tube(m, SAND, 0.78 + 0.16 * t, 0.50, 0.95 + 0.24 * t, 1.19 + 0.24 * t, 0.10 - 0.02 * t, 0.09 - 0.02 * t, 6, false, false);
  }
  ball(m, SAND, 0.98, 0.50, 1.40, 0.13, 0.11, 0.11, 6, 3);              // head
  ball(m, SAND, 1.06, 0.50, 1.34, 0.09, 0.08, 0.07, 5, 3);              // muzzle
  for (const [x, y] of [[0.30, 0.34], [0.30, 0.66], [0.68, 0.34], [0.68, 0.66]])
    tube(m, SAND, x, y, 0.0, 0.62, 0.075, 0.07, 5, false, false);       // legs
}

function elephant(m) {
  ball(m, STONE, 0.46, 0.50, 0.74, 0.40, 0.32, 0.28, 8, 4);             // body
  ball(m, STONE, 0.86, 0.50, 0.86, 0.26, 0.25, 0.25, 7, 3);             // head
  ball(m, STONE, 0.80, 0.24, 0.90, 0.07, 0.14, 0.18, 6, 3);             // ears
  ball(m, STONE, 0.80, 0.76, 0.90, 0.07, 0.14, 0.18, 6, 3);
  for (let i = 0; i < 3; i++) {                                         // trunk, down and forward
    const x = 1.00 + 0.05 * i, z1 = 0.78 - 0.22 * i;
    tube(m, STONE, x, 0.50, z1 - 0.26, z1, 0.08 - 0.012 * i, 0.068 - 0.012 * i, 6, false, false);
  }
  for (const [x, y] of [[0.22, 0.32], [0.22, 0.68], [0.70, 0.32], [0.70, 0.68]])
    tube(m, STONE, x, y, 0.0, 0.50, 0.12, 0.11, 6, false, false);       // legs
}

function giraffe(m) {
  ball(m, SAND, 0.40, 0.50, 0.86, 0.28, 0.22, 0.20, 8, 4);              // body
  ball(m, BRICK, 0.44, 0.50, 0.86, 0.08, 0.15, 0.11, 5, 3);             // patches
  ball(m, BRICK, 0.30, 0.50, 1.00, 0.07, 0.13, 0.05, 5, 2);
  for (let i = 0; i <= 5; i++) {                                        // long neck
    const t = i / 5;
    tube(m, SAND, 0.62 + 0.20 * t, 0.50, 0.86 + 0.32 * t, 1.06 + 0.32 * t, 0.08, 0.07, 6, false, false);
  }
  ball(m, SAND, 0.84, 0.50, 1.42, 0.11, 0.10, 0.10, 6, 3);              // head
  ball(m, SAND, 0.93, 0.50, 1.38, 0.07, 0.06, 0.06, 5, 2);              // muzzle
  ball(m, BRICK, 0.76, 0.41, 1.48, 0.035, 0.035, 0.04, 4, 2);           // ossicones
  ball(m, BRICK, 0.76, 0.59, 1.48, 0.035, 0.035, 0.04, 4, 2);
  for (const [x, y] of [[0.22, 0.36], [0.22, 0.64], [0.58, 0.36], [0.58, 0.64]])
    tube(m, SAND, x, y, 0.0, 0.70, 0.07, 0.065, 5, false, false);       // legs
}

function mushroom(m) {
  tube(m, SNOW, 0.50, 0.50, 0.0, 0.46, 0.15, 0.11, 8, false, false);    // stem
  const cap = m.mark();
  dome(m, BRICK, 0.50, 0.50, 0.44, 0.46, 0.46, 0.32, 11, 3);            // cap
  m.paint(cap, (f, i) => (i % 3 === 0 ? SNOW : null));                  // spots
}

function bush(m) {
  tube(m, WOOD, 0.50, 0.50, 0.0, 0.34, 0.11, 0.09, 6, false, true);     // stub trunk
  ball(m, LEAF, 0.50, 0.50, 0.56, 0.38, 0.38, 0.36, 9, 4);              // clumps
  ball(m, LEAF, 0.26, 0.42, 0.44, 0.26, 0.26, 0.24, 7, 3);
  ball(m, LEAF, 0.74, 0.60, 0.42, 0.24, 0.24, 0.22, 7, 3);
  ball(m, LEAF, 0.52, 0.44, 0.78, 0.20, 0.20, 0.18, 6, 3);
}

function campfire(m) {
  for (let s = 0; s < 5; s++) {                                         // ring of cobbles
    const a = (2 * Math.PI * (s + 0.5)) / 5;
    ball(m, STONE, 0.50 + 0.35 * Math.cos(a), 0.50 + 0.35 * Math.sin(a), 0.10, 0.13, 0.12, 0.11, 5, 3);
  }
  for (let s = 0; s < 3; s++) {                                         // crossed logs
    const a = (Math.PI * s) / 3;
    log(m, WOOD, 0.50 - 0.36 * Math.cos(a), 0.50 - 0.36 * Math.sin(a),
      0.50 + 0.36 * Math.cos(a), 0.50 + 0.36 * Math.sin(a), 0.13, 0.065, 0.065, 6);
  }
  const flame = m.mark();
  tube(m, BRICK, 0.50, 0.50, 0.16, 0.54, 0.15, 0, 6, false, false);     // flame
  m.paint(flame, (f) => (f.c[2] > 0.24 ? SAND : null));                 // hot tip
}

function boulder(m) {
  const rock = m.mark();
  ball(m, STONE, 0.50, 0.50, 0.36, 0.46, 0.42, 0.38, 8, 4);
  ball(m, STONE, 0.24, 0.62, 0.22, 0.22, 0.20, 0.20, 6, 3);
  ball(m, STONE, 0.74, 0.30, 0.20, 0.19, 0.17, 0.17, 6, 3);
  m.paint(rock, (f) => (f.n[2] > 0.75 ? GRASS : null));                 // moss on top
}

function snowman(m) {
  ball(m, SNOW, 0.50, 0.50, 0.42, 0.42, 0.42, 0.40, 9, 4);              // base
  ball(m, SNOW, 0.50, 0.50, 1.02, 0.31, 0.31, 0.30, 7, 3);              // middle
  ball(m, SNOW, 0.50, 0.50, 1.48, 0.25, 0.25, 0.24, 7, 3);              // head
  log(m, BRICK, 0.71, 0.50, 0.94, 0.50, 1.46, 0.07, 0, 5, true, false); // nose
  ball(m, SLATE, 0.66, 0.41, 1.58, 0.04, 0.04, 0.04, 4, 2);             // eyes
  ball(m, SLATE, 0.66, 0.59, 1.58, 0.04, 0.04, 0.04, 4, 2);
  ball(m, SLATE, 0.80, 0.50, 1.00, 0.05, 0.05, 0.05, 4, 2);             // buttons
  ball(m, SLATE, 0.79, 0.50, 1.19, 0.05, 0.05, 0.05, 4, 2);
}

function cactus(m) {
  tube(m, LEAF, 0.50, 0.50, 0.0, 1.88, 0.21, 0.19, 8, false, true);     // trunk
  ball(m, LEAF, 0.50, 0.50, 1.90, 0.19, 0.19, 0.17, 7, 3);              // crown
  log(m, LEAF, 0.50, 0.50, 1.02, 0.50, 1.12, 0.15, 0.15, 6, true, false);  // right arm out
  tube(m, LEAF, 1.02, 0.50, 1.12, 1.58, 0.15, 0.14, 6, true, true);     // …and up
  ball(m, LEAF, 1.02, 0.50, 1.60, 0.14, 0.14, 0.13, 6, 3);
  log(m, LEAF, 0.50, 0.50, -0.02, 0.50, 1.32, 0.14, 0.14, 6, true, false); // left arm out
  tube(m, LEAF, -0.02, 0.50, 1.32, 1.72, 0.14, 0.13, 6, true, true);    // …and up
  ball(m, LEAF, -0.02, 0.50, 1.74, 0.13, 0.13, 0.12, 6, 3);
}

function well(m) {
  ring(m, STONE, 0.50, 0.50, 0.0, 0.36, 0.62, 0.44, 9);                 // kerb
  disc(m, SLATE, 0.50, 0.50, 0.28, 0.43, 0.43, 9, true);                // water
  box(m, WOOD, 0.10, 0.50, 0.68, 0.10, 0.10, 0.68);                     // posts
  box(m, WOOD, 0.90, 0.50, 0.68, 0.10, 0.10, 0.68);
  box(m, WOOD, 0.50, 0.50, 0.98, 1.00, 0.09, 0.09);                     // beam
  box(m, SLATE, 0.50, 0.50, 0.86, 0.16, 0.16, 0.17);                    // bucket
  roof(m, SLATE, 0.50, 0.50, 1.03, 1.45, 1.10, 0.80);                   // little roof
}

function boat(m) {
  const zF = 0.10, zR = 0.46;
  const out = [[0.00, 0.50], [0.55, 0.06], [2.05, 0.06], [2.60, 0.50], [2.05, 0.94], [0.55, 0.94]];
  const c = [1.30, 0.50, (zF + zR) / 2];
  for (let s = 0; s < out.length; s++) {                                // hull shell
    const a = out[s], b = out[(s + 1) % out.length];
    m.quad(WOOD, [a[0], a[1], zF], [b[0], b[1], zF], [b[0], b[1], zR], [a[0], a[1], zR], c);
  }
  m.poly(WOOD, ...out.map((p) => [p[0], p[1], zR]));                    // deck
  m.poly(SLATE, ...out.map((p) => [1.30 + (p[0] - 1.30) * 0.78, 0.50 + (p[1] - 0.50) * 0.78, zR + 0.014]));  // hatch
  tube(m, WOOD, 1.20, 0.50, 0.44, 1.32, 0.05, 0.045, 5, false, true);   // mast
  const sail = [[1.18, 0.50, 1.29], [1.18, 0.50, 0.50], [2.10, 0.50, 0.50]];
  m.tri(SNOW, ...sail);                                                 // sail, both sides
  m.tri(SNOW, ...[...sail].reverse());
  const flag = [[1.20, 0.50, 1.32], [1.20, 0.50, 1.46], [1.46, 0.50, 1.39]];
  m.tri(BRICK, ...flag);
  m.tri(BRICK, ...[...flag].reverse());
}

function fence(m) {
  for (const z of [0.38, 0.62]) box(m, WOOD, 1.42, 0.50, z, 2.92, 0.05, 0.10);  // rails
  for (const x of [0.06, 0.97, 1.88, 2.79]) {
    box(m, WOOD, x, 0.50, 0.46, 0.11, 0.11, 0.88);                      // pickets
    tube(m, WOOD, x, 0.50, 0.89, 0.99, 0.085, 0, 4, false, false);      // …with a tip
  }
}

function ruins(m) {
  const stone = m.mark();
  // A broken L: each segment of both walls has its own height and a little jitter
  // off the wall line, so they read as collapsed masonry, not a staircase.
  const alongY = [[0.14, 0.24, 1.32], [0.22, 0.34, 0.72], [0.15, 0.30, 1.06], [0.21, 0.26, 0.48], [0.17, 0.26, 0.86]];
  let y = 0.02;
  for (const [cx, len, top] of alongY) {
    box(m, STONE, cx, y + len / 2, top / 2, 0.34, len, top);
    y += len;
  }
  const alongX = [[0.46, 1.00], [0.30, 1.20], [0.32, 0.62]];
  let x = 0.40;
  for (const [len, top] of alongX) {
    box(m, STONE, x + len / 2, 0.18, top / 2, len, 0.34, top);
    x += len;
  }
  tube(m, STONE, 1.62, 1.62, 0.0, 1.52, 0.24, 0.20, 8, true, true);     // column, broken off
  ball(m, STONE, 0.92, 1.55, 0.16, 0.20, 0.20, 0.17, 6, 3);             // rubble
  ball(m, STONE, 1.42, 0.92, 0.14, 0.17, 0.17, 0.15, 6, 3);
  m.paint(stone, (f) => (f.n[2] > 0.9 ? GRASS : null));                 // moss where it is flat
}

function tree(m) {
  tube(m, WOOD, 0.50, 0.50, 0.0, 1.10, 0.17, 0.12, 7, false, false);    // trunk, into the canopy
  const crown = m.mark();
  ball(m, LEAF, 0.50, 0.50, 1.45, 0.55, 0.55, 0.52, 9, 4);              // canopy
  ball(m, LEAF, 0.22, 0.40, 1.20, 0.34, 0.34, 0.32, 7, 3);
  ball(m, LEAF, 0.76, 0.46, 1.16, 0.32, 0.32, 0.30, 7, 3);
  ball(m, LEAF, 0.50, 0.50, 1.88, 0.32, 0.32, 0.30, 6, 3);
  m.paint(crown, (f, i) => (f.c[2] > 1.15 && f.n[2] > 0.65 && i % 4 === 0 ? BRICK : null));  // fruit
}

function pine(m) {
  tube(m, WOOD, 0.50, 0.50, 0.0, 0.55, 0.16, 0.14, 6, false, true);    // trunk
  const tiers = [[0.35, 1.40, 0.68, 9], [1.05, 2.10, 0.56, 9], [1.75, 2.80, 0.44, 8], [2.45, 3.40, 0.30, 7]];
  for (const [z0, z1, r, seg] of tiers) tube(m, LEAF, 0.50, 0.50, z0, z1, r, 0, seg, false, false);
}

function house(m) {
  const x0 = 0.10, x1 = 3.90, y0 = 0.20, y1 = 2.80, zT = 1.08;
  const inside = [2.00, 1.50, 0.50];
  const door = (col, row) => (col === 1 ? SLATE : null);                // a doorway, both rows
  const lit = (col, row) => (row === 1 && col !== 1 ? SAND : null);     // a window upstairs
  // Four walls, each split into cells so the door and the windows are the wall
  // itself, never a patch laid on it.
  grid(m, BRICK, [x1, y0, 0], [x1, y1, 0], [x1, y1, zT], [x1, y0, zT], 3, 2, (c, r) => door(c, r) ?? lit(c, r), inside);
  grid(m, BRICK, [x1, y1, 0], [x0, y1, 0], [x0, y1, zT], [x1, y1, zT], 3, 2, (c, r) => lit(c, r), inside);
  grid(m, BRICK, [x0, y1, 0], [x0, y0, 0], [x0, y0, zT], [x0, y1, zT], 3, 2, (c, r) => lit(c, r), inside);
  grid(m, BRICK, [x0, y0, 0], [x1, y0, 0], [x1, y0, zT], [x0, y0, zT], 3, 2, (c, r) => lit(c, r), inside);
  roof(m, SLATE, 2.00, 1.50, 1.00, 1.95, 4.00, 3.00);                   // roof, overhanging
  box(m, BRICK, 0.75, 0.75, 1.62, 0.34, 0.34, 0.72);                    // chimney
}

function lighthouse(m) {
  const waist = 4.30, deck = 5.90;
  tube(m, STONE, 0.50, 0.50, 0.0, 0.30, 1.02, 0.98, 10, true, false);   // plinth
  // The shaft is stacked rather than one taper, because a face carries one
  // colour: only a band that *is* geometry can be painted red.
  let z = 0.30, r = 0.92;
  for (let i = 0; i < 5; i++) {
    const z1 = 0.30 + (waist - 0.30) * ((i + 1) / 5);
    const r1 = 0.92 + (0.40 - 0.92) * ((i + 1) / 5);
    tube(m, i % 2 ? BRICK : SNOW, 0.50, 0.50, z, z1, r, r1, 10, false, false);
    z = z1; r = r1;
  }
  ring(m, SLATE, 0.50, 0.50, waist, waist + 0.18, 1.06, 0.40, 10);      // gallery deck
  ring(m, SNOW, 0.50, 0.50, waist + 0.18, waist + 0.40, 1.02, 0.86, 10); // railing
  tube(m, SAND, 0.50, 0.50, waist + 0.18, deck, 0.36, 0.32, 8, false, false);  // lantern room
  dome(m, BRICK, 0.50, 0.50, deck, 0.44, 0.44, 0.34, 8, 3);             // roof
  ball(m, SAND, 0.50, 0.50, deck + 0.34, 0.09, 0.09, 0.11, 5, 2);       // finial
  box(m, WOOD, 0.50, -0.36, 0.55, 0.34, 0.24, 0.72);                    // door, proud of the wall
}

function windmill(m) {
  const hub = [0.50, -0.30, 3.42];
  tube(m, STONE, 0.50, 0.50, 0.0, 0.32, 1.30, 1.22, 10, true, false);   // stone footing
  tube(m, SNOW, 0.50, 0.50, 0.32, 3.20, 1.14, 0.60, 10, false, false);  // tapering body
  dome(m, BRICK, 0.50, 0.50, 3.20, 0.78, 0.78, 0.60, 10, 3);            // cap
  ball(m, WOOD, hub[0], hub[1], hub[2], 0.17, 0.17, 0.17, 6, 3);        // axle
  box(m, WOOD, hub[0], hub[1], hub[2], 0.11, 0.11, 2.60);               // upright sail beam
  box(m, WOOD, hub[0], hub[1], hub[2], 2.60, 0.11, 0.11);               // and the crossing one
  for (const [dx, dz] of [[0.95, 0], [-0.95, 0], [0, 0.95], [0, -0.95]]) {
    box(m, SAND, hub[0] + dx, hub[1], hub[2] + dz, dx ? 0.82 : 0.62, 0.07, dz ? 0.82 : 0.62);
  }
  box(m, WOOD, 0.50, -0.72, 0.52, 0.46, 0.20, 0.76);                    // door at the foot
}

function tent(m) {
  // The pitch is deliberately shallow: at the default camera elevation a steep
  // ridge hides its own far slope, and the tent reads as one flat sheet.
  roof(m, SAND, 0.50, 0.50, 0.0, 0.95, 2.10, 2.60);                     // A-frame
  box(m, SAND, 0.50, 0.50, 0.03, 2.10, 2.60, 0.06);                     // the groundsheet it sits on
  m.tri(SLATE, [1.57, -0.70, 0.0], [1.57, 1.70, 0.0], [1.57, 0.50, 0.62]);  // the opening
  tube(m, WOOD, 0.50, 0.50, 0.88, 1.24, 0.05, 0, 5, false, false);      // ridge pole
}

function pier(m) {
  const w = 3.20;
  box(m, WOOD, w / 2, 0.50, 0.30, w, 1.00, 0.10);                       // deck
  for (const x of [0.28, 1.60, 2.92]) {
    for (const y of [0.14, 0.86]) tube(m, WOOD, x, y, 0.0, 0.42, 0.10, 0.085, 6, true, false);
    box(m, WOOD, x, 1.06, 0.62, 0.10, 0.10, 0.62);                      // rail posts
  }
  box(m, WOOD, w / 2, 1.06, 0.90, w, 0.07, 0.07);                       // rail
}

function watchtower(m) {
  for (const [x, y] of [[0.14, 0.14], [0.14, 1.06], [1.06, 0.14], [1.06, 1.06]]) {
    tube(m, WOOD, x, y, 0.0, 2.30, 0.11, 0.10, 6, true, false);         // legs
  }
  for (const z of [0.70, 1.50]) {                                       // cross braces
    for (const y of [0.14, 1.06]) box(m, WOOD, 0.60, y, z, 0.94, 0.07, 0.07);
    for (const x of [0.14, 1.06]) box(m, WOOD, x, 0.60, z, 0.07, 0.94, 0.07);
  }
  box(m, WOOD, 0.60, 0.60, 2.36, 1.32, 1.32, 0.12);                     // platform
  for (const y of [0.01, 1.19]) box(m, WOOD, 0.60, y, 2.62, 1.30, 0.07, 0.46);   // railing
  for (const x of [0.01, 1.19]) box(m, WOOD, x, 0.60, 2.62, 0.07, 1.30, 0.46);
  box(m, WOOD, 0.60, 0.60, 2.94, 1.00, 1.00, 0.52);                     // hut
  roof(m, SLATE, 0.60, 0.60, 3.18, 3.66, 1.20, 1.20);                   // overhanging roof
  box(m, WOOD, -0.06, 0.42, 1.20, 0.07, 0.07, 2.20);                    // ladder rails
  box(m, WOOD, -0.06, 0.82, 1.20, 0.07, 0.07, 2.20);
  for (let z = 0.35; z < 2.05; z += 0.42) box(m, WOOD, -0.06, 0.62, z, 0.06, 0.46, 0.06);
}

function statue(m) {
  box(m, SLATE, 0.50, 0.50, 0.16, 1.14, 1.14, 0.32);                    // plinth
  box(m, SLATE, 0.50, 0.50, 0.38, 0.86, 0.86, 0.12);                    // step
  tube(m, STONE, 0.50, 0.50, 0.44, 1.56, 0.36, 0.26, 8, true, false);   // robed figure
  ball(m, STONE, 0.50, 0.50, 1.74, 0.21, 0.21, 0.23, 8, 3);             // head
  for (const x of [0.22, 0.78]) box(m, STONE, x, 0.50, 1.24, 0.16, 0.16, 0.66);  // arms
  box(m, SLATE, 0.78, 0.50, 1.82, 0.08, 0.08, 0.56);                    // staff, raised
}

function crate(m) {
  box(m, WOOD, 0.50, 0.50, 0.44, 0.96, 0.96, 0.88);                     // the box
  for (const x of [-0.01, 1.01]) box(m, DIRT, x, 0.50, 0.44, 0.10, 1.04, 0.92);  // corner battens,
  for (const y of [-0.01, 1.01]) box(m, DIRT, 0.50, y, 0.44, 1.04, 0.10, 0.92);  // …proud of it
}

function barrel(m) {
  tube(m, WOOD, 0.50, 0.50, 0.0, 0.34, 0.34, 0.42, 9, true, false);     // bottom half
  tube(m, WOOD, 0.50, 0.50, 0.34, 0.68, 0.42, 0.34, 9, false, true);    // …and top
  ring(m, SLATE, 0.50, 0.50, 0.08, 0.15, 0.44, 0.35, 9);                // hoops
  ring(m, SLATE, 0.50, 0.50, 0.53, 0.60, 0.45, 0.38, 9);
}

function signpost(m) {
  tube(m, WOOD, 0.50, 0.50, 0.0, 1.72, 0.10, 0.09, 6, true, true);      // post
  ball(m, WOOD, 0.50, 0.50, 1.76, 0.11, 0.11, 0.10, 6, 3);              // cap
  box(m, SAND, 0.84, 0.50, 1.44, 0.70, 0.09, 0.22);                     // board, pointing out
  box(m, SAND, 0.50, 0.84, 1.14, 0.09, 0.70, 0.22);                     // and another
}

function lamp(m) {
  tube(m, SLATE, 0.50, 0.50, 0.0, 0.18, 0.28, 0.22, 8, true, true);     // footing
  tube(m, SLATE, 0.50, 0.50, 0.18, 1.86, 0.08, 0.07, 6, false, false);  // post
  box(m, SLATE, 0.50, 0.50, 1.90, 0.34, 0.34, 0.12);                    // sill
  box(m, SAND, 0.50, 0.50, 2.06, 0.26, 0.26, 0.32);                     // the light
  dome(m, SLATE, 0.50, 0.50, 2.22, 0.29, 0.29, 0.18, 8, 2);             // cap
}

function palm(m) {
  let x = 0.50;
  for (let i = 0; i < 4; i++) {                                         // trunk, leaning
    const x1 = x + 0.10;
    tube(m, WOOD, (x + x1) / 2, 0.50, i * 0.55, (i + 1) * 0.55, 0.19 - i * 0.01, 0.17 - i * 0.01, 7, i === 0, false);
    x = x1;
  }
  const cz = 2.20;
  ball(m, LEAF, x, 0.50, cz + 0.05, 0.20, 0.20, 0.17, 6, 3);            // crown bud
  for (let s = 0; s < 7; s++) {                                         // fronds, one cone each
    const a = (2 * Math.PI * s) / 7 + 0.4;
    log(m, LEAF, x, 0.50, x + 1.05 * Math.cos(a), 0.50 + 1.05 * Math.sin(a), cz, 0.17, 0, 5, false, false);
  }
  ball(m, DIRT, x + 0.16, 0.56, cz - 0.14, 0.11, 0.11, 0.11, 6, 3);     // coconuts
  ball(m, DIRT, x - 0.10, 0.42, cz - 0.16, 0.11, 0.11, 0.11, 6, 3);
}

function haystack(m) {
  tube(m, WOOD, 0.50, 0.50, 0.0, 0.98, 0.05, 0.04, 5, false, false);    // the pole it is built on
  const heap = m.mark();
  dome(m, SAND, 0.50, 0.50, 0.0, 0.78, 0.78, 0.88, 9, 3);
  m.paint(heap, (f, i) => (i % 4 === 1 ? GRASS : null));                // straw flecks
}

/* ── the city ────────────────────────────────────────────────────────── */

/**
 * A walled building: a stone shaft whose walls are split into floors, each band
 * of them a row of glazing. The walls *are* the cells of a `grid`, because a
 * window has to be real geometry — a coplanar pane sorts behind the wall it sits
 * on and would never be seen — so a floor's glass is the wall itself, shaded by
 * its own colour. One helper covers the tower, the office slab and the
 * skyscraper: only their size and their number of floors differ.
 */
function building(m, { w, d, floors, floorH = 0.92, base = SLATE, pane = GLASS, roof = SLATE, crown = true }) {
  const x0 = 0.10, y0 = 0.10, x1 = 0.10 + w, y1 = 0.10 + d;
  const zCurb = 0.22, zTop = zCurb + floors * floorH;
  const cells = (col, row) => (row % 2 ? null : pane);      // a band of glazing per floor
  const middle = [(x0 + x1) / 2, (y0 + y1) / 2, (zCurb + zTop) / 2];
  const cols = Math.max(2, Math.round(w / 1.1));
  box(m, base, middle[0], middle[1], zCurb / 2, w + 0.24, d + 0.24, zCurb);   // the plinth
  grid(m, base, [x1, y0, zCurb], [x1, y1, zCurb], [x1, y1, zTop], [x1, y0, zTop], cols, floors, cells, middle);
  grid(m, base, [x1, y1, zCurb], [x0, y1, zCurb], [x0, y1, zTop], [x1, y1, zTop], cols, floors, cells, middle);
  grid(m, base, [x0, y1, zCurb], [x0, y0, zCurb], [x0, y0, zTop], [x0, y1, zTop], cols, floors, cells, middle);
  grid(m, base, [x0, y0, zCurb], [x1, y0, zCurb], [x1, y0, zTop], [x0, y0, zTop], cols, floors, cells, middle);
  box(m, roof, middle[0], middle[1], zTop + 0.06, w + 0.10, d + 0.10, 0.12);  // roof slab
  if (crown) {
    tube(m, roof, middle[0], middle[1], zTop + 0.12, zTop + 0.92, 0.06, 0.035, 5, false, true);
    ball(m, BRICK, middle[0], middle[1], zTop + 0.98, 0.09, 0.09, 0.09, 5, 2);  // aircraft light
  }
}

const tower = (m) => building(m, { w: 2.0, d: 1.7, floors: 4 });
const office = (m) => building(m, { w: 3.4, d: 2.4, floors: 2, crown: false });
const skyscraper = (m) => building(m, { w: 2.2, d: 2.2, floors: 8 });

function crane(m) {
  tube(m, SLATE, 0.60, 0.60, 0.0, 5.60, 0.18, 0.11, 6, true, false);    // mast
  for (const z of [1.30, 2.70, 4.10]) {                                 // rungs
    box(m, SLATE, 0.60, 0.60, z, 0.42, 0.42, 0.10);
  }
  box(m, ROAD, 0.60, 0.60, 5.72, 0.56, 0.56, 0.30);                     // slewing unit
  box(m, GOLD, 2.60, 0.60, 5.72, 4.00, 0.16, 0.16);                     // jib, out to one side
  box(m, ROAD, 0.06, 0.60, 5.72, 1.00, 0.34, 0.34);                     // counterweight, behind it
  tube(m, ROAD, 4.60, 0.60, 3.40, 5.66, 0.03, 0.03, 4, false, false);   // hoist rope
  box(m, WOOD, 4.60, 0.60, 3.18, 0.54, 0.54, 0.44);                     // the load it is lifting
  tube(m, SLATE, 0.60, 0.60, 5.78, 6.10, 0.10, 0.06, 5, false, true);   // operator's cab, on top
}

/* ── placement ───────────────────────────────────────────────────────── */

/** One vector turned a quarter turn about z. Exact: it only swaps and negates. */
const turnZ = ([x, y, z]) => [y, -x, z];

/**
 * One mesh at one quarter turn: verts with their bounding box dropped on the
 * origin, the whole blocks that box claims, and the offset that centres it
 * inside them.
 */
function frame(verts, faces) {
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (const v of verts) {
    for (let a = 0; a < 3; a++) {
      if (v[a] < lo[a]) lo[a] = v[a];
      if (v[a] > hi[a]) hi[a] = v[a];
    }
  }
  const span = [hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]];
  const w = Math.ceil(span[0] - 1e-6), h = Math.ceil(span[1] - 1e-6), hz = Math.ceil(span[2] - 1e-6);
  return {
    verts: verts.map((v) => [v[0] - lo[0], v[1] - lo[1], v[2] - lo[2]]),
    faces: faces.map((f) => ({ v: f.v, col: f.col, n: f.n, c: [f.c[0] - lo[0], f.c[1] - lo[1], f.c[2] - lo[2]] })),
    size: { w, h, hz },
    offset: { x: (w - span[0]) / 2, y: (h - span[1]) / 2 },
  };
}

/**
 * Bake a built mesh's four quarter turns and publish it. A rotation about z only
 * swaps and negates coordinates, so the frames are exact and a placed model can
 * be turned without re-deriving anything. The mesh is centred in the whole blocks
 * it claims — the grid is the placement's business, not the model's — and models
 * keep their proportions, so the duck stands about a block tall and the house is
 * about four across.
 */
function bake(id, name, m, source) {
  const frames = [];
  let verts = m.verts, faces = m.faces;
  for (let k = 0; k < 4; k++) {
    frames.push(frame(verts, faces));
    verts = verts.map(turnZ);
    faces = faces.map((f) => ({ v: f.v, col: f.col, n: turnZ(f.n), c: turnZ(f.c) }));
  }
  MODELS.push(source ? { id, name, frames, source } : { id, name, frames });
}

/** Register a model built from the primitives above. */
function define(id, name, build) {
  const m = new Mesh();
  build(m);
  bake(id, name, m);
}

/**
 * Register a mesh baked in from a pack by tools/import-pack.mjs. Pack geometry
 * arrives as block-unit triangles with a colour each — the same thing the
 * primitives above produce (and they are welded again here) — so a pack model
 * gets quarter turns, a footprint, a ghost and a gallery card on the same terms
 * as an authored one. It keeps the pack's own colours rather than the world's
 * palette: an imported tree is greener than the terrain it stands on, which is
 * the point of importing it.
 */
function definePack(entry) {
  const m = new Mesh();
  const at = (i) => [entry.verts[i * 3], entry.verts[i * 3 + 1], entry.verts[i * 3 + 2]];
  for (let t = 0; t < entry.tris.length; t += 4) {
    m.tri(entry.cols[entry.tris[t + 3]], at(entry.tris[t]), at(entry.tris[t + 1]), at(entry.tris[t + 2]));
  }
  bake(entry.id, entry.name, m, entry.source);
}

define('duck', 'Duck', duck);
define('penguin', 'Penguin', penguin);
define('bear', 'Bear', bear);
define('lion', 'Lion', lion);
define('camel', 'Camel', camel);
define('elephant', 'Elephant', elephant);
define('giraffe', 'Giraffe', giraffe);
define('mushroom', 'Mushroom', mushroom);
define('bush', 'Bush', bush);
define('campfire', 'Campfire', campfire);
define('boulder', 'Boulder', boulder);
define('snowman', 'Snowman', snowman);
define('cactus', 'Cactus', cactus);
define('well', 'Well', well);
define('boat', 'Boat', boat);
define('fence', 'Fence', fence);
define('ruins', 'Ruins', ruins);
define('tree', 'Tree', tree);
define('pine', 'Pine', pine);
define('house', 'House', house);
define('lighthouse', 'Lighthouse', lighthouse);
define('windmill', 'Windmill', windmill);
define('tent', 'Tent', tent);
define('pier', 'Pier', pier);
define('watchtower', 'Watchtower', watchtower);
define('statue', 'Statue', statue);
define('crate', 'Crate', crate);
define('barrel', 'Barrel', barrel);
define('signpost', 'Signpost', signpost);
define('lamp', 'Lamp', lamp);
define('palm', 'Palm', palm);
define('haystack', 'Haystack', haystack);
define('skyscraper', 'Skyscraper', skyscraper);
define('tower', 'Tower', tower);
define('office', 'Office', office);
define('crane', 'Crane', crane);

// Meshes baked out of the CC0 packs by tools/import-pack.mjs (see CREDITS.md):
// the animals, the pirate chest and the cars — everything a pack draws better
// than a handful of primitives can. They come after the authored models, so the
// gallery reads hand-made first and each card names the pack it came from.
for (const entry of PACK) definePack(entry);

/** A model's four quarter turns, in order: index straight in by a prop's `rot`. */
export function modelFrames(model) {
  return model.frames;
}

/**
 * How many whole blocks a model claims when it is placed, at quarter turn `rot`.
 * A model that is not square across its footprint turns its footprint with it.
 */
export function modelSize(model, rot = 0) {
  if (!model || !model.frames) throw new Error(`modelSize: no such model (${JSON.stringify(model && model.id)})`);
  return model.frames[rot & 3].size;
}
