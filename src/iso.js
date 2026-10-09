// Axonometric projection with a rotatable view.
//
//   screenX = (x cosθ - y sinθ) * H
//   screenY = (x sinθ + y cosθ) * D - z * C
//
// θ is the view azimuth, D/H the ground foreshortening and C the height scale.
// k = 0 is the classic 2:1 isometric look; k = 1 looks straight down with the
// world axes square on the screen, which is the pose in which a note's writing
// reads head-on — no shear, no vertical squash.
//
// Every k keeps the projection linear, so the view ray is a constant direction
// and picking stays an exact voxel-grid march.

export const TILE = 32;
export const HW = TILE / 2;
export const Z_MIN = 0;
export const Z_MAX = 128;
export const CHUNK = 16;       // columns per chunk, on x and y
export const NOTE_U = 18;      // local px per block for a note lying on the ground

const H0 = HW * Math.SQRT2;    // 22.63 px per ground unit, screen-horizontal
const D0 = H0 / 2;             // 11.31 px per ground unit into the screen (2:1)
const C0 = 16;                 // px per z level
const THETA0 = Math.PI / 4;

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

/**
 * View parameters for a rotation 0..1: everything the projection, the renderer
 * and picking need, including the view ray (world -> camera).
 */
export function viewOf(k) {
  const t = clamp01(Number(k) || 0);
  const theta = THETA0 * (1 - t);
  const sin = Math.sin(theta);
  const cos = Math.cos(theta);
  const D = D0 + (H0 - D0) * t;
  const C = C0 * (1 - t);
  return {
    k: t,
    theta, sin, cos,
    H: H0,
    D,
    C,
    // Null space of the projection: ∝ (sinθ·C, cosθ·C, D).
    dx: sin * C,
    dy: cos * C,
    dz: D,
    // A side face can only be seen while its normal faces the camera.
    faceX: sin * C > 1e-6,
    faceY: cos * C > 1e-6,
  };
}

export const ISO = viewOf(0);

/** World point -> screen point (before the camera's pan and zoom). */
export function project(x, y, z, v = ISO) {
  return {
    x: (x * v.cos - y * v.sin) * v.H,
    y: (x * v.sin + y * v.cos) * v.D - z * v.C,
  };
}

/** Screen point plus a z level -> world x,y. */
export function unproject(sx, sy, z, v = ISO) {
  const a = sx / v.H;
  const b = (sy + z * v.C) / v.D;
  return { x: a * v.cos + b * v.sin, y: -a * v.sin + b * v.cos };
}

/**
 * First solid voxel along the view ray through a screen point, marching the
 * grid with Amanatides–Woo. Returns the cell plus the face it was entered
 * through; `ground: true` means nothing was hit and the infinite ground plane
 * at z = Z_MIN was used instead.
 */
export function raycast(sx, sy, isSolid, v = ISO) {
  const zTop = Z_MAX + 1;
  const p = unproject(sx, sy, zTop, v);
  const { dx, dy, dz } = v;

  let cx = Math.floor(p.x);
  let cy = Math.floor(p.y);
  let cz = zTop;
  let tx = dx > 1e-9 ? (p.x - cx) / dx : Infinity;
  let ty = dy > 1e-9 ? (p.y - cy) / dy : Infinity;
  let tz = 0;                        // already level with the top plane
  const stepX = dx > 1e-9 ? 1 / dx : Infinity;
  const stepY = dy > 1e-9 ? 1 / dy : Infinity;
  const stepZ = 1 / dz;
  let nx = 0, ny = 0, nz = 1;

  for (let i = 0, max = 3 * (Z_MAX + 4) * 2; i < max; i++) {
    if (tz <= tx && tz <= ty) { cz -= 1; tz += stepZ; nx = 0; ny = 0; nz = 1; }
    else if (tx <= ty) { cx -= 1; tx += stepX; nx = 1; ny = 0; nz = 0; }
    else { cy -= 1; ty += stepY; nx = 0; ny = 1; nz = 0; }
    if (cz < Z_MIN) break;
    if (isSolid(cx, cy, cz)) return { x: cx, y: cy, z: cz, nx, ny, nz, ground: false };
  }

  const s = zTop / dz;               // where the ray meets the ground plane
  return {
    x: Math.floor(p.x - s * dx),
    y: Math.floor(p.y - s * dy),
    z: Z_MIN,
    nx: 0, ny: 0, nz: 1,
    ground: true,
  };
}
