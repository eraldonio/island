// Axonometric projection with a free camera orbit.
//
//   screenX = (x cosθ - y sinθ) * H
//   screenY = (x sinθ + y cosθ) * D - z * C
//
// θ (spin) is the view azimuth and may be any angle; D/H is the ground
// foreshortening and C the height scale, both driven by the elevation (tilt).
// The default spin 45 / tilt 30 is the classic 2:1 isometric look; spin 0 with
// tilt 90 looks straight down with the world axes square on the screen, which
// is the pose in which a note's writing reads head-on.
//
// Every pose keeps the projection linear, so the view ray is one constant
// direction and picking stays an exact voxel-grid march.

export const TILE = 32;
export const HW = TILE / 2;
export const Z_MIN = 0;
export const Z_MAX = 128;
export const CHUNK = 16;       // columns per chunk, on x and y
export const NOTE_U = 18;      // local px per block for a note lying on the ground

export const SPIN0 = 45;       // default azimuth, degrees
export const TILT0 = 30;       // default elevation, degrees
export const TILT_MIN = 10;    // nearly edge-on
export const TILT_MAX = 90;    // straight down

const H0 = HW * Math.SQRT2;    // 22.63 px per ground unit, screen-horizontal
const C0 = 16;                 // px per z level at the default elevation

/**
 * View parameters for a spin/tilt pair: everything the projection, the renderer
 * and picking need, including the view ray (world -> camera) and which of the
 * two side faces the camera can see on each axis.
 */
export function viewOf(spinDeg, tiltDeg) {
  const spin = (((Number(spinDeg) || 0) % 360) + 360) % 360;
  const t = Number(tiltDeg);
  const tilt = Math.min(TILT_MAX, Math.max(TILT_MIN, Number.isFinite(t) ? t : TILT0));
  const theta = (spin * Math.PI) / 180;
  const sin = Math.sin(theta);
  const cos = Math.cos(theta);
  const D = H0 * Math.sin((tilt * Math.PI) / 180);
  // Heights read full size at the default elevation and vanish looking straight
  // down, where nothing stands up any more.
  const C = C0 * Math.max(0, (TILT_MAX - tilt) / (TILT_MAX - TILT0));
  const dx = sin * C;
  const dy = cos * C;
  return {
    spin, tilt, theta, sin, cos,
    H: H0,
    D,
    C,
    // Null space of the projection: ∝ (sinθ·C, cosθ·C, D).
    dx, dy, dz: D,
    // A side face is visible while its normal still faces the camera.
    faceX: Math.abs(dx) > 1e-6,
    faceY: Math.abs(dy) > 1e-6,
    sx: dx >= 0 ? 1 : -1,      // +x or -x face
    sy: dy >= 0 ? 1 : -1,      // +y or -y face
  };
}

export const ISO = viewOf(SPIN0, TILT0);

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

  const ax = Math.abs(dx);
  const ay = Math.abs(dy);
  const stepXDir = dx >= 0 ? -1 : 1;     // always marching away from the camera
  const stepYDir = dy >= 0 ? -1 : 1;
  const nx0 = dx >= 0 ? 1 : -1;
  const ny0 = dy >= 0 ? 1 : -1;

  let cx = Math.floor(p.x);
  let cy = Math.floor(p.y);
  let cz = zTop;
  let tx = ax > 1e-9 ? (stepXDir < 0 ? p.x - cx : cx + 1 - p.x) / ax : Infinity;
  let ty = ay > 1e-9 ? (stepYDir < 0 ? p.y - cy : cy + 1 - p.y) / ay : Infinity;
  let tz = 0;                        // already level with the top plane
  const stepX = ax > 1e-9 ? 1 / ax : Infinity;
  const stepY = ay > 1e-9 ? 1 / ay : Infinity;
  const stepZ = 1 / dz;
  let nx = 0, ny = 0, nz = 1;

  for (let i = 0, max = 3 * (Z_MAX + 4) * 2; i < max; i++) {
    if (tz <= tx && tz <= ty) { cz -= 1; tz += stepZ; nx = 0; ny = 0; nz = 1; }
    else if (tx <= ty) { cx += stepXDir; tx += stepX; nx = nx0; ny = 0; nz = 0; }
    else { cy += stepYDir; ty += stepY; nx = 0; ny = ny0; nz = 0; }
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
