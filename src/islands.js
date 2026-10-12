// Preconfigured islands: whole little places — their own relief, the low-poly
// elements standing on it and the notes stuck to it — that you stamp onto the
// map wherever you click, the way a model is placed.
//
// An island is authored in its own local blocks: x and y run over its w x h
// footprint and z up from its own base plate, so z = 0 is its first layer and
// the surface of a column is `column`'s own top. Nothing in here reaches the
// world: `islandParts` translates a built scene to the anchor column the click
// chose, and what lands is ordinary relief, ordinary props and ordinary notes —
// an island has no state of its own once it is on the map, and a save never has
// to know one was used.
//
// Two things are worth knowing before reading one:
//
// * **Form.** An island's outline is a test on a column, so it is composed from
//   a few predicates rather than always being a disc: a sand spit to walk out
//   along, a crescent bitten by a bay, a ring with a channel cut through it, a
//   city's square grid. Noise roughens a coastline, so no shore is ever an arc.
// * **Sea.** A coastal island is *filled*: its footprint includes the water
//   around the land, as one layer of `WATER` at z = 0 with the land a block
//   higher. That is what a pier reaches over, what a boat floats on, and what
//   makes the silhouette read as an island rather than as a floating saucer.
//
// A scene is a pure function of the island and a fixed seed, so the card in the
// gallery and the blocks you get are the same island, block for block, every
// time it is placed.

import { PALETTE, FS_DEFAULT, uid } from './world.js';
import { MODELS, modelSize } from './models.js';

// The palette *ids*, not the colours: a voxel carries a material id, while the
// models' faces carry a colour — the two libraries look alike and are not.
const [GRASS, DIRT, STONE, SAND, , , SNOW, SLATE, , ROAD, GOLD, WATER] = PALETTE.map((p) => p.id);
const MODELS_BY_ID = new Map(MODELS.map((m) => [m.id, m]));

/** Deterministic 0..1 hash of a cell, so an island's jitter is the same always. */
function noise(seed, x, y) {
  let n = (x * 73856093) ^ (y * 19349663) ^ (seed * 83492791);
  n = Math.imul(n ^ (n >>> 13), 1274126177);
  return ((n ^ (n >>> 16)) >>> 0) / 4294967296;
}

/* ── shapes ──────────────────────────────────────────────────────────── */

const disc = (cx, cy, r) => (x, y) => Math.hypot(x - cx, y - cy) <= r;
const oval = (cx, cy, rx, ry) => (x, y) => Math.hypot((x - cx) / rx, (y - cy) / ry) <= 1;
const rect = (x0, y0, x1, y1) => (x, y) => x >= x0 && x <= x1 && y >= y0 && y <= y1;
const band = (cx, cy, rIn, rOut) => (x, y) => {
  const d = Math.hypot(x - cx, y - cy);
  return d >= rIn && d <= rOut;
};

/** The union of shapes; `cut` takes the second out of the first. */
const any = (...parts) => (x, y) => parts.some((p) => p(x, y));
const cut = (whole, hole) => (x, y) => whole(x, y) && !hole(x, y);

/* ── a scene under construction ──────────────────────────────────────── */

/**
 * Relief, the elements standing on it and the notes lying on it. Everything is
 * placed against the surface the relief already has, so an element or a note is
 * written in the same "rest on the column below me" terms the live app uses.
 */
class Scene {
  constructor(w, h) {
    this.w = w;
    this.h = h;
    this.voxels = [];      // [x, y, z, mat]
    this.props = [];       // { model, x, y, z, rot }
    this.notes = [];       // { x, y, w, h, color, fs, html }
    this.tops = new Map(); // "x,y"   -> surface z
    this.cells = new Map();// "x,y,z" -> index into `voxels`
    this.problems = [];    // model ids an island names but the library lacks
  }

  /** One column, from the base plate up to `z`, in its own material. */
  column(x, y, z, surface, fill = DIRT) {
    for (let k = 0; k <= z; k++) {
      this.cells.set(x + ',' + y + ',' + k, this.voxels.length);
      this.voxels.push([x, y, k, k === z ? surface : k === 0 ? STONE : fill]);
    }
    this.tops.set(x + ',' + y, z);
  }

  /** Relief from a height function; a column the function puts below 0 is left out. */
  field(height, surface, fill) {
    for (let x = 0; x < this.w; x++) {
      for (let y = 0; y < this.h; y++) {
        const z = height(x, y);
        if (z >= 0) this.column(x, y, z, surface(x, y), fill);
      }
    }
  }

  /** Surface height of a column; one off the island reads as absent. */
  topAt(x, y) {
    const t = this.tops.get(x + ',' + y);
    return t === undefined ? -1 : t;
  }

  /**
   * Recolour a column's surface block — a lane, a plaza, a yard. A column whose
   * top block is water is left alone: a lane painted on the sea reads as nothing
   * at all until you happen to look at the shoreline.
   */
  surface(x, y, mat) {
    const i = this.cells.get(x + ',' + y + ',' + this.topAt(x, y));
    if (i !== undefined && this.voxels[i][3] !== WATER) this.voxels[i][3] = mat;
  }

  /** An element standing on the column's surface, centred on that column. */
  stand(model, x, y, rot = 0) {
    const def = MODELS_BY_ID.get(model);
    // An island may name a model the library does not have; that is an authoring
    // slip, so record it and carry on rather than taking the whole app down.
    if (!def) { this.problems.push(`no model called '${model}' (stood at ${x},${y})`); return; }
    const size = modelSize(def, rot);
    this.props.push({
      model,
      x: x - ((size.w - 1) >> 1),
      y: y - ((size.h - 1) >> 1),
      z: this.topAt(x, y) + 1,
      rot,
    });
  }

  /** A note lying on the ground, centred on the column. */
  note(x, y, w, h, html, color = 0) {
    this.notes.push({
      x: x - ((w - 1) >> 1),
      y: y - ((h - 1) >> 1),
      w, h, color, fs: FS_DEFAULT, html,
    });
  }
}

/* ── the library ─────────────────────────────────────────────────────── */

export const ISLANDS = [];

/** Seeds are fixed per island, so a card and a stamp can never disagree. */
function island(id, name, blurb, build) {
  ISLANDS.push({ id, name, blurb, build });
}

const scenes = new Map();

/** The one scene of an island: built on first use, then handed out as it is. */
export function islandScene(island) {
  let scene = scenes.get(island.id);
  if (!scene) {
    scene = island.build(ISLANDS.indexOf(island) * 7919 + 13);
    scenes.set(island.id, scene);
  }
  return scene;
}

/**
 * An island's contents moved onto the map: centred on the anchor column the
 * click chose and resting on the block level `z` it was given. The result is
 * exactly what `World.stamp` takes, so a whole island is one undoable step.
 */
export function islandParts(scene, anchorX, anchorY, z) {
  const dx = anchorX - ((scene.w - 1) >> 1);
  const dy = anchorY - ((scene.h - 1) >> 1);
  return {
    voxels: scene.voxels.map(([x, y, k, mat]) => ({ x: x + dx, y: y + dy, z: k + z, mat })),
    props: scene.props.map((p) => ({
      id: uid(),
      model: p.model,
      x: p.x + dx,
      y: p.y + dy,
      z: p.z + z,
      rot: p.rot | 0,
    })),
    notes: scene.notes.map((n) => ({
      id: uid(),
      x: n.x + dx,
      y: n.y + dy,
      w: n.w,
      h: n.h,
      color: n.color | 0,
      fs: n.fs,
      html: n.html,
    })),
  };
}

/* ── lighthouse isle: a rock with a sand spit running east ───────────── */

island('lighthouse', 'Lighthouse isle', 'a rocky headland, a sand spit and a striped tower', (seed) => {
  const w = 19, h = 17, cx = 6, cy = 8;
  const s = new Scene(w, h);
  const rad = (x, y) => Math.hypot(x - cx, y - cy) + noise(seed, x, y) * 0.35;
  const spit = rect(cx + 5, cy - 1, w - 1, cy + 1);              // the bar it grows out of
  const land = any(disc(cx, cy, 5.4), spit);
  const outer = any(disc(cx, cy, 7.4), spit);                    // …and the water round it
  s.field(
    (x, y) => (!outer(x, y) ? -1 : !land(x, y) ? 0 : rad(x, y) > 4.6 ? 1 : rad(x, y) > 3.4 ? 2 : 3),
    (x, y) => (!land(x, y) ? WATER : rad(x, y) > 4.6 ? SAND : rad(x, y) > 3.4 ? GRASS : STONE),
  );

  s.stand('lighthouse', cx, cy, 0);
  s.stand('pier', 12, cy, 1);                                    // out along the spit, into the water
  s.stand('boat', 10, 12, 0);                                    // moored beside it
  s.stand('duck', 11, 4, 0);
  s.stand('bird', 12, 6, 0);
  s.stand('boulder', 1, 7, 0);
  s.stand('barrel', 3, 5, 0);
  s.stand('lamp', 4, 6, 0);
  s.stand('bush', 4, 11, 0);
  s.stand('crate', 2, 10, 0);
  s.stand('campfire', 9, 10, 0);
  s.stand('bush', 10, 10, 0);
  s.note(17, 8, 3, 2, '<p><b>Lighthouse isle.</b> Mind the tide, and keep the lamp lit.</p>');
  return s;
});

/* ── village green: an oval green with lanes, ringed by water ────────── */

island('village', 'Village green', 'houses round a well, lanes, fences and a windmill', (seed) => {
  const w = 29, h = 25, cx = 14, cy = 12;
  const s = new Scene(w, h);
  const rad = (x, y) => Math.hypot((x - cx) / 11.6, (y - cy) / 9.4) + noise(seed, x, y) * 0.05;
  const land = oval(cx, cy, 11.6, 9.4);
  const outer = oval(cx, cy, 13.8, 11.4);
  s.field(
    (x, y) => (!outer(x, y) ? -1 : !land(x, y) ? 0 : rad(x, y) > 0.88 ? 1 : 2),
    (x, y) => (!land(x, y) ? WATER : rad(x, y) > 0.88 ? SAND : GRASS),
  );

  for (let i = 5; i <= 21; i++) {                 // two lanes crossing the green,
    s.surface(i, cy, DIRT);                       // …both kept on the land
    s.surface(cx, i, DIRT);
  }
  for (let dx = -1; dx <= 1; dx++) {              // …and a paved square at the crossing
    for (let dy = -1; dy <= 1; dy++) s.surface(cx + dx, cy + dy, STONE);
  }

  s.stand('house', 9, 8, 0);
  s.stand('house', 20, 8, 1);
  s.stand('house', 9, 17, 2);
  s.stand('house', 20, 17, 3);
  s.stand('well', cx, cy, 0);
  s.stand('windmill', 14, 20, 0);
  s.stand('statue', 14, 6, 0);
  s.stand('signpost', 17, 12, 0);
  s.stand('lamp', 17, 9, 0);
  s.stand('lamp', 11, 14, 0);
  s.stand('crate', 22, 13, 0);
  s.stand('barrel', 23, 11, 0);
  s.stand('fence', 5, 14, 0);
  s.stand('fence', 19, 12, 0);
  s.stand('tree', 6, 8, 0);
  s.stand('tree', 6, 16, 0);
  s.stand('pine', 18, 4, 0);
  s.stand('bush', 14, 9, 0);
  s.stand('haystack', 11, 5, 0);
  s.stand('cow', 12, 19, 0);
  s.stand('sheep', 17, 18, 0);
  s.stand('sheep', 22, 15, 0);
  s.stand('dog', 12, 10, 0);
  s.stand('chick', 7, 13, 0);
  s.stand('chick', 8, 14, 0);
  s.stand('duck', 25, 18, 0);
  s.note(8, 11, 5, 2, '<p><b>Village green.</b> Everybody is welcome; the well is for water, not wishes.</p>');
  s.note(14, 17, 4, 2, '<p>Wood behind the mill — mind the gate.</p>', 2);
  return s;
});

/* ── snow camp: a lobed mound, cut by a frozen pond ──────────────────── */

island('snow', 'Snow camp', 'a tent, a fire and pines on a lumpy snowfield', (seed) => {
  const w = 23, h = 21, cx = 11, cy = 10;
  const s = new Scene(w, h);
  const rad = (x, y) => Math.hypot(x - cx, y - cy) + noise(seed, x, y) * 1.6;   // lobed, not round
  s.field(
    (x, y) => (rad(x, y) > 8.6 ? -1 : rad(x, y) > 7.0 ? 0 : rad(x, y) > 3.4 ? 1 : 2),
    (x, y) => (rad(x, y) > 7.0 ? STONE : SNOW),
    STONE,
  );
  for (let x = 0; x < w; x++) {                   // a frozen pond in the middle
    for (let y = 0; y < h; y++) {
      const r = rad(x, y);
      if (r > 3.6 && r < 5.2) s.surface(x, y, SLATE);
    }
  }

  s.stand('campfire', cx, cy, 0);
  s.stand('tent', 11, 5, 0);
  s.stand('snowman', 15, 8, 0);
  s.stand('snowman', 7, 12, 0);
  s.stand('crate', 15, 12, 0);
  s.stand('barrel', 17, 11, 0);
  s.stand('boulder', 5, 8, 0);
  s.stand('wolf', 9, 12, 0);
  s.stand('eagle', 13, 7, 0);
  s.stand('horse', 12, 12, 0);
  s.stand('pine', 6, 6, 0);
  s.stand('pine', 15, 6, 1);
  s.stand('pine', 14, 14, 0);
  s.stand('pine', 6, 13, 1);
  s.stand('pine', 5, 10, 0);
  s.note(11, 16, 5, 2, '<p><b>Camp.</b> Wood is behind the tent. Put the fire right out.</p>', 3);
  return s;
});

/* ── desert oasis: an elongated dune field with a spring ─────────────── */

island('oasis', 'Desert oasis', 'palms round a spring, dunes, cacti and llamas', (seed) => {
  const w = 25, h = 17, cx = 12, cy = 8;
  const s = new Scene(w, h);
  const rad = (x, y) => Math.hypot((x - cx) / 11.0, (y - cy) / 6.6) + noise(seed, x, y) * 0.10;
  const dune = (x, y) => Math.abs(y - cy + Math.sin(x * 0.55) * 2.2) < 1.6;   // a ridge along the oasis
  s.field(
    (x, y) => (rad(x, y) > 1 ? -1 : dune(x, y) && rad(x, y) > 0.4 ? 3 : rad(x, y) > 0.72 ? 1 : 2),
    (x, y) => (rad(x, y) > 0.72 ? SAND : rad(x, y) < 0.16 ? WATER : SAND),
  );

  s.stand('palm', 8, 5, 0);
  s.stand('palm', 12, 5, 1);
  s.stand('palm', 17, 7, 1);
  s.stand('palm', 10, 10, 3);
  s.stand('cactus', 4, 10, 0);
  s.stand('cactus', 17, 12, 1);
  s.stand('cactus', 5, 5, 0);
  s.stand('llama', 20, 5, 0);
  s.stand('llama', 20, 9, 1);
  s.stand('fox', 15, 4, 0);
  s.stand('ruins', 18, 10, 0);
  s.stand('statue', 3, 7, 0);
  s.stand('barrel', 15, 7, 0);
  s.stand('crate', 13, 12, 0);
  s.stand('boulder', 16, 13, 0);
  s.note(7, 12, 4, 2, '<p><b>Oasis.</b> Water is the whole point. Share it with the camels.</p>', 1);
  return s;
});

/* ── atoll: a broken ring round a lagoon, a channel through it ───────── */

island('atoll', 'Treasure atoll', 'a ring of sand round a lagoon, with chests on it', (seed) => {
  const w = 27, h = 27, cx = 13, cy = 13;
  const s = new Scene(w, h);
  const rad = (x, y) => Math.hypot(x - cx, y - cy) + noise(seed, x, y) * 1.1;
  const lagoon = disc(cx, cy, 3.6);
  const channel = rect(15, 3, 17, 9);                                     // the gap in the ring
  const ring = cut(band(cx, cy, 3.6, 10.6), channel);
  const islet = disc(cx - 9, cy + 6, 3.4);                                // a cay off the west end
  // The footprint is the *uncut* band: the channel is water, joining the lagoon
  // to the sea, and the sea reaches past the land so the ring stands in it.
  const outer = any(band(cx, cy, 3.6, 12.4), islet, lagoon);
  const land = any(ring, islet);
  s.field(
    (x, y) => (!outer(x, y) ? -1 : !land(x, y) ? 0 : rad(x, y) > 9.0 ? 1 : 2),
    (x, y) => (!land(x, y) ? WATER : rad(x, y) > 9.0 ? SAND : GRASS),
  );

  for (const [x, y] of [[8, 11], [18, 11], [18, 15], [8, 15]]) s.surface(x, y, GOLD);  // a hoard at each chest

  s.stand('chest', 8, 10, 0);
  s.stand('chest', 18, 10, 1);
  s.stand('chest', 18, 16, 2);
  s.stand('chest', 8, 16, 3);
  s.stand('skull', 13, 18, 0);
  s.stand('skull', 17, 10, 0);
  s.stand('cannon', 20, 7, 0);
  s.stand('cannon', 5, 10, 1);
  s.stand('telescope', 10, 20, 0);
  s.stand('palm', 8, 6, 0);
  s.stand('palm', 7, 12, 1);
  s.stand('palm', 18, 13, 2);
  s.stand('palm', 4, 19, 0);
  s.stand('ruins', 16, 19, 0);
  s.stand('boat', 13, 11, 0);
  s.stand('boulder', 19, 17, 0);
  s.stand('barrel', 11, 18, 0);
  s.stand('crate', 4, 12, 0);
  s.stand('campfire', 20, 11, 0);
  s.note(13, 19, 4, 2, '<p><b>Treasure atoll.</b> Four chests, one tide.</p>', 1);
  s.note(11, 5, 3, 2, '<p>X marks nothing. Dig where the palms are.</p>', 0);
  return s;
});

/* ── zoo park: an oval park, pens of animals off a path cross ────────── */

island('zoo', 'Zoo park', 'pens of animals round a path, with a duck pond', (seed) => {
  const w = 31, h = 27, cx = 15, cy = 13;
  const s = new Scene(w, h);
  const rad = (x, y) => Math.hypot((x - cx) / 14.2, (y - cy) / 12.0) + noise(seed, x, y) * 0.05;
  const pond = (x, y) => Math.hypot((x - 22) / 4.4, (y - 20) / 3.0) <= 1;   // the duck pond, south-east
  s.field(
    (x, y) => (rad(x, y) > 1 ? -1 : pond(x, y) ? 0 : 1),
    (x, y) => (pond(x, y) ? WATER : GRASS),
  );

  for (let i = 3; i <= 27; i++) {                 // a path cross between the pens
    s.surface(i, cy, SAND);
    s.surface(cx, i, SAND);
  }
  for (const [x, y] of [[7, 6], [23, 6], [6, 20], [24, 10]]) s.surface(x, y, STONE);   // feed yards

  // The pens: fences along the paths, the animals behind them.
  for (const x of [4, 7, 10, 18, 21, 24]) {
    s.stand('fence', x, cy - 2, 0);
    s.stand('fence', x, cy + 2, 0);
  }
  for (const y of [4, 7, 17, 20, 23]) {
    s.stand('fence', cx - 2, y, 1);
    s.stand('fence', cx + 2, y, 1);
  }

  s.stand('cow', 7, 5, 0);                        // the farm pen
  s.stand('sheep', 10, 5, 0);
  s.stand('pig', 5, 9, 0);
  s.stand('chick', 9, 9, 0);
  s.stand('pug', 11, 8, 0);
  s.stand('chick', 10, 7, 0);
  s.stand('horse', 20, 4, 0);                     // the paddock
  s.stand('llama', 23, 5, 0);
  s.stand('zebra', 25, 8, 0);
  s.stand('eagle', 19, 9, 0);
  s.stand('fox', 6, 17, 0);                       // the small predators
  s.stand('wolf', 9, 16, 0);
  s.stand('cat', 6, 21, 0);
  s.stand('dog', 8, 21, 0);
  s.stand('fish', 22, 20, 0);                     // and the pond
  s.stand('duck', 20, 22, 0);
  s.stand('bird', 24, 17, 0);

  s.stand('signpost', cx + 1, 3, 0);
  s.stand('lamp', cx - 1, 3, 0);
  s.stand('well', 4, 12, 0);
  s.stand('haystack', 12, 12, 0);
  s.stand('crate', 11, 22, 0);
  s.stand('barrel', 26, 14, 0);
  s.stand('tree', 6, 7, 0);
  s.stand('tree', 25, 12, 0);
  s.stand('pine', 26, 16, 0);
  s.stand('bush', 10, 22, 0);
  s.stand('bush', 18, 23, 0);
  s.note(9, 13, 5, 2, '<p><b>Zoo park.</b> Feeding at noon. Do not feed the wolf.</p>', 2);
  s.note(10, 19, 4, 2, '<p>The pond is the fish tank; keep your hands out.</p>', 3);
  return s;
});

/* ── skyscraper city: a square of streets, towers and traffic ────────── */

island('city', 'Skyscraper city', 'a street grid of towers, traffic and a crane', (seed) => {
  const w = 41, h = 41;
  const s = new Scene(w, h);
  const street = (x, y) => x % 8 < 2 || y % 8 < 2 || x === w - 1 || y === h - 1;
  s.field(
    (x, y) => (street(x, y) ? 0 : 1),
    (x, y) => (street(x, y) ? ROAD : (x % 8 < 3 || y % 8 < 3) ? STONE : GRASS),
  );

  // One tower per block, on the grid the streets leave: a skyline, not a wall.
  const towers = [
    ['skyscraper', 4, 4, 0], ['tower', 12, 4, 0], ['skyscraper', 20, 4, 1],
    ['office', 28, 4, 0], ['tower', 36, 4, 1],
    ['office', 4, 12, 1], ['skyscraper', 12, 12, 0], ['tower', 20, 12, 0],
    ['tower', 28, 12, 1], ['office', 36, 12, 0],
    ['tower', 4, 20, 0], ['office', 12, 20, 1], ['skyscraper', 28, 20, 0], ['tower', 36, 20, 1],
    ['office', 4, 28, 0], ['tower', 12, 28, 1], ['skyscraper', 28, 28, 1], ['tower', 36, 28, 0],
    ['tower', 4, 36, 1], ['skyscraper', 12, 36, 0], ['office', 20, 36, 0], ['tower', 28, 36, 0],
  ];
  for (const [model, x, y, rot] of towers) s.stand(model, x, y, rot);

  for (let x = 19; x <= 22; x++) {                // a paved plaza with a statue in it
    for (let y = 19; y <= 22; y++) s.surface(x, y, STONE);
  }
  s.stand('statue', 20, 19, 0);

  for (let x = 19; x <= 23; x++) {                // …and a fenced lot for the crane
    for (let y = 27; y <= 31; y++) s.surface(x, y, DIRT);
  }
  s.stand('crane', 21, 29, 1);
  s.stand('crate', 23, 28, 0);
  s.stand('barrel', 23, 30, 0);

  // Traffic keeps to its lane: a car's three-long axis runs along the street,
  // so an east-west street takes a turned car and a north-south one a straight
  // one, and the footprint lands exactly on the two rows of tarmac.
  for (const [model, x, y, rot] of [
    ['car', 6, 8, 1], ['taxi', 4, 16, 1], ['van', 30, 24, 1], ['compact', 12, 32, 1],
    ['police-car', 8, 6, 0], ['racer', 16, 14, 0], ['car', 24, 20, 0], ['taxi', 32, 28, 0],
    ['police-car', 8, 30, 0], ['car', 16, 36, 0], ['van', 24, 4, 0], ['compact', 32, 18, 0],
  ]) s.stand(model, x, y, rot);

  for (const [x, y] of [[2, 2], [10, 2], [18, 2], [26, 2], [34, 2], [2, 10], [34, 10],
    [2, 18], [34, 18], [2, 26], [34, 26], [2, 34], [34, 34], [18, 34], [26, 34]]) {
    s.stand('lamp', x, y, 0);
  }
  for (const [x, y] of [[35, 35], [37, 35], [35, 37], [37, 37]]) s.stand('tree', x, y, 0);
  s.stand('tree', 6, 18, 0);
  s.stand('tree', 32, 6, 0);
  s.stand('pine', 32, 32, 0);
  s.stand('bush', 15, 15, 0);
  s.note(12, 15, 5, 2, '<p><b>Skyscraper city.</b> Mind the traffic — and the crane.</p>', 0);
  s.note(22, 22, 3, 2, '<p>Lot 7: breaking ground, keep out.</p>', 3);
  return s;
});

/* ── harbour town: a bay, a quay, and a lighthouse on the point ─────── */

island('harbour', 'Harbour town', 'a wavy coastline, docks, warehouses and boats', (seed) => {
  const w = 33, h = 31, cx = 16;
  const s = new Scene(w, h);
  // The shore wanders: land where y is behind the waterline, sea in front of it,
  // and a three-block quay raised along the whole waterfront.
  const shore = (x) => 16 + Math.round(Math.sin(x * 0.5) * 2.5);
  const islet = disc(26, 25, 3.6);
  const land = any((x, y) => y <= shore(x) - 3, islet);
  const quay = (x, y) => y > shore(x) - 3 && y <= shore(x);
  // The quay is tested first, because it sits *in front of* the land: a row the
  // land test rejects is the waterfront, not sea.
  s.field(
    (x, y) => (quay(x, y) ? 2 : land(x, y) ? 1 : 0),
    (x, y) => (quay(x, y) ? STONE : land(x, y) ? (y > shore(x) - 6 ? SAND : GRASS) : WATER),
  );

  s.stand('office', 8, 4, 0);                     // warehouses behind the quay
  s.stand('office', 21, 4, 1);
  s.stand('tower', 13, 3, 0);
  s.stand('tower', 26, 3, 0);
  s.stand('crane', 3, 7, 1);                      // working the docks
  s.stand('crane', 29, 7, 1);
  s.stand('statue', 16, 8, 0);
  s.stand('signpost', 11, 8, 0);
  s.stand('lamp', 19, 5, 0);
  s.stand('lamp', 5, 8, 0);
  s.stand('crate', 12, 8, 0);
  s.stand('barrel', 15, 9, 0);
  s.stand('crate', 26, 8, 0);
  s.stand('barrel', 30, 8, 0);
  s.stand('telescope', 14, 8, 0);
  s.stand('fence', 6, 6, 0);
  s.stand('fence', 31, 6, 1);
  s.stand('tree', 5, 3, 0);
  s.stand('tree', 28, 3, 0);
  s.stand('pine', 1, 9, 0);
  s.stand('bush', 30, 3, 0);
  s.stand('haystack', 2, 3, 0);
  s.stand('lighthouse', 26, 25, 0);               // on the point, across the water
  s.stand('boat', 9, 22, 0);
  s.stand('boat', 19, 24, 0);
  s.stand('boat', 30, 23, 0);
  s.stand('pier', 6, 20, 1);
  s.stand('pier', 28, 20, 1);
  s.stand('whale', 22, 27, 0);
  s.stand('fish', 12, 21, 0);
  s.stand('duck', 16, 21, 0);
  s.note(20, 8, 5, 2, '<p><b>Harbour town.</b> Berths 1 to 3, mind the cranes.</p>', 2);
  s.note(8, 8, 4, 2, '<p>The point is lit; the channel is west of it.</p>', 0);
  return s;
});
