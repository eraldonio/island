// What a click does. One source of truth for both the hover ghost preview
// and the edit that a click/drag actually performs.

import { Z_MIN, Z_MAX } from './iso.js';


export const BRUSHES = [1, 3, 5];

/** The two unit axes that lie in the plane of a face with the given normal. */
function planeAxes(nx, ny, nz) {
  if (nz === 1) return [[1, 0, 0], [0, 1, 0]];
  if (nx === 1) return [[0, 1, 0], [0, 0, 1]];
  return [[1, 0, 0], [0, 0, 1]];
}

/** Brush footprint: offsets in the two in-plane axes. */
function footprint(size) {
  const r = (size - 1) >> 1;
  if (r === 0) return [[0, 0]];
  const out = [];
  for (let a = -r; a <= r; a++) for (let b = -r; b <= r; b++) out.push([a, b]);
  return out;
}

/**
 * Cells affected by the current tool at the hovered/clicked face.
 * @returns {{x:number,y:number,z:number}[]}
 */
export function targetsFor(world, hit, tool, size) {
  if (!hit) return [];
  const [A, B] = planeAxes(hit.nx, hit.ny, hit.nz);
  const fp = footprint(size);
  const out = [];

  if (tool === 'build') {
    let bx, by, bz;
    if (hit.ground) { bx = hit.x; by = hit.y; bz = Z_MIN; }
    else { bx = hit.x + hit.nx; by = hit.y + hit.ny; bz = hit.z + hit.nz; }
    for (const [a, b] of fp) {
      const x = bx + A[0] * a + B[0] * b;
      const y = by + A[1] * a + B[1] * b;
      const z = bz + A[2] * a + B[2] * b;
      if (z < Z_MIN || z > Z_MAX) continue;
      if (world.get(x, y, z) !== undefined) continue;
      out.push({ x, y, z });
    }
    return out;
  }

  if (tool === 'dig') {
    for (const [a, b] of fp) {
      const x = hit.x + A[0] * a + B[0] * b;
      const y = hit.y + A[1] * a + B[1] * b;
      const z = hit.z + A[2] * a + B[2] * b;
      if (world.get(x, y, z) !== undefined) out.push({ x, y, z });
    }
    return out;
  }

  if (tool === 'paint') {
    if (hit.nz === 1) {
      // Painting the surface: recolour the top block of every column in reach.
      for (const [a, b] of fp) {
        const x = hit.x + a;
        const y = hit.y + b;
        const t = world.topAt(x, y);
        if (t >= 0) out.push({ x, y, z: t });
      }
    } else {
      for (const [a, b] of fp) {
        const x = hit.x + A[0] * a + B[0] * b;
        const y = hit.y + A[1] * a + B[1] * b;
        const z = hit.z + A[2] * a + B[2] * b;
        if (world.get(x, y, z) !== undefined) out.push({ x, y, z });
      }
    }
  }

  return out;
}
