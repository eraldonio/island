// Fixed-angle isometric projection.
//
//   screenX = (x - y) * HW
//   screenY = (x + y) * HH - z * VZ
//
// The camera never rotates, so this map is linear and constant: there is no
// matrix to carry around, the view ray is always the vector (-1,-1,-1), and
// picking is an exact voxel-grid DDA (no triangles, no raycasting library).

export const TILE = 32;       // tile width in px at zoom 1
export const HW = TILE / 2;   // half width  (16)
export const HH = TILE / 4;   // half height (8)  -> 2:1 dimetric
export const VZ = TILE / 2;   // screen height of one z level (16)
export const Z_MIN = 0;
export const Z_MAX = 128;
export const CHUNK = 16;      // columns per chunk, on x and y

/** World point -> isometric screen point (before camera pan/zoom). */
export function project(x, y, z) {
  return { x: (x - y) * HW, y: (x + y) * HH - z * VZ };
}

/** Isometric screen point + a z level -> world x,y. */
export function unproject(ix, iy, z) {
  const a = ix / HW;               // x - y
  const b = (iy + z * VZ) / HH;    // x + y
  return { x: (a + b) / 2, y: (b - a) / 2 };
}

/**
 * First solid voxel along the view ray through an isometric screen point.
 * The ray is P(t) = P0 + t * (-1,-1,-1); we start one level above the world
 * and walk the grid with Amanatides–Woo, so hits are exact and the entered
 * face is known.
 *
 * @param {(x:number,y:number,z:number)=>boolean} isSolid
 * @returns {{x:number,y:number,z:number,nx:number,ny:number,nz:number,ground:boolean}}
 */
export function raycast(ix, iy, isSolid) {
  const zTop = Z_MAX + 1;
  const p = unproject(ix, iy, zTop);
  let x = Math.floor(p.x);
  let y = Math.floor(p.y);
  let cz = zTop;
  let tx = p.x - x;   // distance to the next x boundary going down
  let ty = p.y - y;
  let tz = 0;
  let nx = 0, ny = 0, nz = 1;

  for (let i = 0, max = 3 * (Z_MAX + 4); i < max; i++) {
    if (tz <= tx && tz <= ty) { cz--; tz += 1; nx = 0; ny = 0; nz = 1; }
    else if (tx <= ty) { x--; tx += 1; nx = 1; ny = 0; nz = 0; }
    else { y--; ty += 1; nx = 0; ny = 1; nz = 0; }
    if (cz < Z_MIN) break;
    if (isSolid(x, y, cz)) return { x, y, z: cz, nx, ny, nz, ground: false };
  }

  // Nothing built: hit the infinite ground plane at z = Z_MIN.
  const t = zTop - Z_MIN;
  return {
    x: Math.floor(p.x - t),
    y: Math.floor(p.y - t),
    z: Z_MIN,
    nx: 0, ny: 0, nz: 1,
    ground: true,
  };
}
