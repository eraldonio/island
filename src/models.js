// The model library: low-poly objects you can stamp into the world.
//
// Every model lives on its own mini-voxel grid — `res` mini-voxels to a map
// block — and is grown by a small shape function rather than a hand-written voxel
// list, which keeps the shapes readable and the file short. A model's shape and
// its voxel size have nothing to do with the map's grid: the grid only decides
// which whole blocks a model claims when it is placed.
//
// Sizes are deliberately proportional, so a scene reads at the right scale: the
// duck stands about a block tall, the house about four blocks across.

export const RES = 8;      // mini-voxels per map block, for every model

const GRASS = 0, DIRT = 1, STONE = 2, SAND = 3, WOOD = 4, BRICK = 5, SNOW = 6, SLATE = 7, LEAF = 8;

/* ── shape helpers ───────────────────────────────────────────────────── */

const put = (out, mx, my, mz, mat) => {
  if (mx < 0 || my < 0 || mz < 0) return;
  out.push([mx, my, mz, mat]);
};

/** Axis-aligned box; `shell` keeps only its surface (walls, roofs, hulls). */
function box(out, x0, y0, z0, x1, y1, z1, mat, shell = false) {
  for (let mx = x0; mx <= x1; mx++) {
    for (let my = y0; my <= y1; my++) {
      for (let mz = z0; mz <= z1; mz++) {
        if (shell && mx !== x0 && mx !== x1 && my !== y0 && my !== y1 && mz !== z0 && mz !== z1) continue;
        put(out, mx, my, mz, mat);
      }
    }
  }
}

/** Ellipsoid blob; `shell` keeps only its surface (foliage, boulders, balls). */
function blob(out, cx, cy, cz, rx, ry, rz, mat, shell = false) {
  for (let mx = Math.floor(cx - rx); mx <= Math.ceil(cx + rx); mx++) {
    for (let my = Math.floor(cy - ry); my <= Math.ceil(cy + ry); my++) {
      for (let mz = Math.floor(cz - rz); mz <= Math.ceil(cz + rz); mz++) {
        if (((mx - cx) / rx) ** 2 + ((my - cy) / ry) ** 2 + ((mz - cz) / rz) ** 2 > 1) continue;
        if (shell) {
          const inner = ((mx - cx) / (rx - 1)) ** 2 + ((my - cy) / (ry - 1)) ** 2 + ((mz - cz) / (rz - 1)) ** 2;
          if (inner <= 1) continue;
        }
        put(out, mx, my, mz, mat);
      }
    }
  }
}

/** Flat disc, for caps and crowns seen from above. */
function disc(out, cx, cy, z, r, mat) {
  for (let mx = Math.floor(cx - r); mx <= Math.ceil(cx + r); mx++) {
    for (let my = Math.floor(cy - r); my <= Math.ceil(cy + r); my++) {
      if ((mx - cx) ** 2 + (my - cy) ** 2 > r * r) continue;
      put(out, mx, my, z, mat);
    }
  }
}

/** Remove everything inside a box, for doorways and broken walls. */
function carve(out, x0, y0, z0, x1, y1, z1) {
  for (let i = out.length - 1; i >= 0; i--) {
    const [mx, my, mz] = out[i];
    if (mx >= x0 && mx <= x1 && my >= y0 && my <= y1 && mz >= z0 && mz <= z1) out.splice(i, 1);
  }
}

/** Recolour cells inside a box — moss, embers, patches. */
function tint(out, x0, y0, z0, x1, y1, z1, mat) {
  for (const cell of out) {
    const [mx, my, mz] = cell;
    if (mx >= x0 && mx <= x1 && my >= y0 && my <= y1 && mz >= z0 && mz <= z1) cell[3] = mat;
  }
}

/**
 * Drop fully enclosed cells: with the camera always above the horizon they can
 * never be seen, and they are the bulk of the voxel count for solid shapes.
 */
function visible(cells) {
  const has = new Set(cells.map(([x, y, z]) => x + ',' + y + ',' + z));
  return cells.filter(([x, y, z]) => (
    !has.has((x + 1) + ',' + y + ',' + z)
    || !has.has((x - 1) + ',' + y + ',' + z)
    || !has.has(x + ',' + (y + 1) + ',' + z)
    || !has.has(x + ',' + (y - 1) + ',' + z)
    || !has.has(x + ',' + y + ',' + (z + 1))
  ));
}

/* ── the models ──────────────────────────────────────────────────────── */

function duck() {
  const v = [];
  blob(v, 3, 3, 2, 3, 2.2, 1.6, SAND);            // body
  blob(v, 5.4, 3, 4.4, 1.6, 1.5, 1.6, SAND);      // head
  box(v, 7, 3, 4, 7, 3, 4, BRICK);                // beak
  tint(v, 6, 2, 4, 7, 4, 5, BRICK);
  return v;
}

function mushroom() {
  const v = [];
  box(v, 2, 2, 0, 3, 3, 5, SNOW);                 // stem
  blob(v, 3, 3, 6.2, 3.4, 3.4, 1.9, BRICK);       // cap
  tint(v, 3, 3, 8, 3, 3, 8, SNOW);                // spots
  tint(v, 1, 1, 7, 1, 1, 7, SNOW);
  tint(v, 5, 5, 7, 5, 5, 7, SNOW);
  return v;
}

function bush() {
  const v = [];
  box(v, 3, 3, 0, 4, 4, 1, WOOD);                 // stub trunk
  blob(v, 3.5, 3.5, 3.4, 3.6, 3.6, 3.2, LEAF);
  return v;
}

function campfire() {
  const v = [];
  blob(v, 3.5, 3.5, 0.5, 3.4, 3.4, 1, STONE, true);   // ring of stones
  box(v, 1, 3, 1, 6, 4, 1, WOOD);                     // crossed logs
  box(v, 3, 1, 1, 4, 6, 1, WOOD);
  tint(v, 3, 3, 1, 4, 4, 1, BRICK);                   // embers
  return v;
}

function boulder() {
  const v = [];
  blob(v, 4.5, 4, 2.6, 4.5, 4, 3, STONE);
  tint(v, 1, 2, 5, 6, 6, 6, GRASS);                   // moss on top
  return v;
}

function snowman() {
  const v = [];
  blob(v, 3.5, 3.5, 3.5, 3.5, 3.5, 3.5, SNOW);
  blob(v, 3.5, 3.5, 8.4, 2.6, 2.6, 2.6, SNOW);
  blob(v, 3.5, 3.5, 11.9, 1.9, 1.9, 1.9, SNOW);
  box(v, 5, 3, 11, 6, 3, 11, BRICK);                  // nose
  tint(v, 2, 1, 12, 5, 1, 13, SLATE);                 // eyes
  tint(v, 3, 3, 5, 4, 4, 5, SLATE);                   // buttons
  tint(v, 3, 3, 9, 4, 4, 9, SLATE);
  return v;
}

function cactus() {
  const v = [];
  box(v, 3, 3, 0, 6, 6, 15, LEAF);                    // trunk
  box(v, 7, 3, 7, 8, 6, 10, LEAF);                    // right arm
  box(v, 7, 4, 10, 8, 5, 12, LEAF);
  box(v, 1, 3, 5, 2, 6, 8, LEAF);                     // left arm
  box(v, 1, 4, 8, 2, 5, 10, LEAF);
  tint(v, 3, 3, 16, 6, 6, 17, LEAF);                  // rounded top
  tint(v, 3, 3, 0, 6, 6, 0, SAND);                    // sandy base
  return v;
}

function well() {
  const v = [];
  blob(v, 5, 5, 1.6, 5, 5, 2.2, STONE, true);         // low stone wall
  disc(v, 5, 5, 1, 3.6, SLATE);                       // water
  box(v, 0, 0, 2, 1, 1, 8, WOOD);                     // posts
  box(v, 9, 9, 2, 10, 10, 8, WOOD);
  box(v, 0, 0, 8, 10, 1, 9, WOOD);                    // beam
  return v;
}

function boat() {
  const v = [];
  blob(v, 9.5, 3.5, 2, 9.5, 3.5, 2.2, WOOD, true);    // hull
  box(v, 9, 3, 3, 10, 4, 8, WOOD);                    // mast
  box(v, 5, 3, 4, 14, 4, 6, SNOW, true);              // sail
  return v;
}

function fence() {
  const v = [];
  box(v, 0, 1, 3, 21, 1, 3, WOOD);                    // rails
  box(v, 0, 1, 5, 21, 1, 5, WOOD);
  for (const x of [0, 7, 14, 21]) box(v, x, 1, 1, x, 2, 6, WOOD);   // posts
  return v;
}

function ruins() {
  const v = [];
  box(v, 0, 0, 0, 1, 11, 8, STONE);                   // tall broken wall
  carve(v, 0, 9, 6, 1, 11, 8);
  box(v, 0, 0, 0, 9, 1, 5, STONE);                    // return wall
  carve(v, 6, 0, 0, 9, 1, 2);
  box(v, 12, 12, 0, 14, 14, 11, STONE, true);         // column
  carve(v, 12, 12, 10, 14, 14, 11);
  box(v, 4, 12, 0, 6, 14, 1, STONE);                  // rubble
  tint(v, 0, 0, 8, 14, 14, 8, LEAF);                  // moss where it is flat
  return v;
}

function tree() {
  const v = [];
  box(v, 4, 4, 0, 5, 5, 11, WOOD);                    // trunk
  blob(v, 4.5, 4.5, 15, 4.9, 4.9, 4.4, LEAF, true);
  blob(v, 6, 3, 12.5, 2.6, 2.6, 2, LEAF);
  return v;
}

function pine() {
  const v = [];
  box(v, 4, 4, 0, 5, 5, 9, WOOD);                     // trunk
  blob(v, 4.5, 4.5, 9, 4.6, 4.6, 2.6, LEAF);
  blob(v, 4.5, 4.5, 14, 3.6, 3.6, 2.4, LEAF);
  blob(v, 4.5, 4.5, 19, 2.7, 2.7, 2.2, LEAF);
  blob(v, 4.5, 4.5, 24, 1.8, 1.8, 2, LEAF);
  blob(v, 4.5, 4.5, 27.5, 1, 1, 1.4, LEAF);
  return v;
}

function house() {
  const v = [];
  box(v, 0, 0, 0, 15, 12, 6, BRICK, true);            // walls
  box(v, 0, 0, 7, 15, 12, 7, SLATE);                  // roof
  carve(v, 6, 0, 0, 9, 0, 4);                         // doorway
  carve(v, 2, 0, 2, 4, 0, 3);                         // windows
  carve(v, 11, 0, 2, 13, 0, 3);
  return v;
}

export const MODELS = [
  { id: 'duck', name: 'Duck', res: RES, voxels: visible(duck()) },
  { id: 'mushroom', name: 'Mushroom', res: RES, voxels: visible(mushroom()) },
  { id: 'bush', name: 'Bush', res: RES, voxels: visible(bush()) },
  { id: 'campfire', name: 'Campfire', res: RES, voxels: visible(campfire()) },
  { id: 'boulder', name: 'Boulder', res: RES, voxels: visible(boulder()) },
  { id: 'snowman', name: 'Snowman', res: RES, voxels: visible(snowman()) },
  { id: 'cactus', name: 'Cactus', res: RES, voxels: visible(cactus()) },
  { id: 'well', name: 'Well', res: RES, voxels: visible(well()) },
  { id: 'boat', name: 'Boat', res: RES, voxels: visible(boat()) },
  { id: 'fence', name: 'Fence', res: RES, voxels: visible(fence()) },
  { id: 'ruins', name: 'Ruins', res: RES, voxels: visible(ruins()) },
  { id: 'tree', name: 'Tree', res: RES, voxels: visible(tree()) },
  { id: 'pine', name: 'Pine', res: RES, voxels: visible(pine()) },
  // The house covers enough ground that an eighth-of-a-block voxel would cost
  // thousands of boxes; at a quarter of a block it reads the same and stays lean.
  { id: 'house', name: 'House', res: 4, voxels: visible(house()) },
];

/**
 * How many whole blocks a model claims, plus its own mini-voxel extent.
 * The grid is the placement's business, not the model's.
 */
export function modelSize(model) {
  let w = 1, h = 1, hz = 1;
  for (const [mx, my, mz] of model.voxels) {
    if (mx + 1 > w) w = mx + 1;
    if (my + 1 > h) h = my + 1;
    if (mz + 1 > hz) hz = mz + 1;
  }
  const res = model.res;
  return {
    w: Math.ceil(w / res),
    h: Math.ceil(h / res),
    hz: Math.ceil(hz / res),
    mini: { w, h, hz },
  };
}

/**
 * The model's mini-voxels as world-space boxes, centred in the footprint it
 * claims and based at `z`. Every box is `1 / res` of a block across.
 */
export function modelBoxes(model, x, y, z) {
  const { w, h, mini } = modelSize(model);
  const res = model.res;
  const u = 1 / res;
  const ox = (w * res - mini.w) / 2;
  const oy = (h * res - mini.h) / 2;
  return model.voxels.map(([mx, my, mz, mat]) => ({
    x: x + (mx + ox) * u,
    y: y + (my + oy) * u,
    z: z + mz * u,
    u, mat,
  }));
}
