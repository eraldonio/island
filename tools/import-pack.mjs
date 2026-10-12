#!/usr/bin/env node
// Bake props out of low-poly model packs into src/models.packs.js.
//
// The app loads no model formats at runtime and has no build step: this is a
// one-off converter, run by hand when a model is wanted from a pack. It reads
// Wavefront OBJ + MTL (the lowest common denominator every pack ships), takes
// each face's colour from its material, and writes geometry in the units the
// renderer wants — block units, z up, one mesh per model, ready for
// `definePack()` in models.js to bake quarter turns for.
//
// What it deliberately does NOT do: textures, and animation. A face here is one
// flat colour and an animated model is baked in its rest pose, which is all a
// prop standing in the world needs. Colours come from the MTL's `Kd`; where a
// pack leaves every material at Blender's default grey, the material's *name* is
// looked up in NAMED, and a mesh whose materials are all `Material.001` takes its
// pick's single `tint`. Anything still grey is reported as it bakes, so a
// colourless model is never a silent surprise. A closed mesh a pack wound inside
// out is turned the right way out (see the signed volume in convert), and each
// model that was flipped is named in the bake table.
//
//   unzip -q kenney_nature-kit.zip -d /tmp/packs/nature
//   unzip -q "Farm Animals by @Quaternius.zip" -d /tmp/packs/farm
//   …one directory per pack, then:
//   node tools/import-pack.mjs /tmp/packs
//
// Every pack in PACKS is read from its own subdirectory of the pack root, and
// all of them are written into the one output file, so re-baking means
// unzipping the packs you touched and rerunning the whole thing.
//
// Only CC0 packs belong here (no attribution, no restrictions). Every pack is
// listed in CREDITS.md.

import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = 'src/models.packs.js';

/**
 * What to bake, per pack: the subdirectory of the pack root to read, the name of
 * the exported array (they all end up in one array, `PACK`), where the pack's
 * OBJ files live inside it, and its licence. For each pick, `blocks` is how tall
 * the model stands in the world, so proportions inside a model are kept but each
 * one lands at the size the map wants: the duck's block, the cow's, the crane's.
 */
const PACKS = [
  {
    dir: 'nature',
    objDir: 'Models/OBJ format',
    source: 'Kenney Nature Kit (CC0)',
    picks: [
      { obj: 'tree_default', id: 'pack-tree', name: 'Tree (pack)', blocks: 2.4 },
      { obj: 'tree_pineRoundA', id: 'pack-pine', name: 'Pine (pack)', blocks: 3.0 },
      { obj: 'tree_pineRoundC', id: 'pack-fir', name: 'Fir (pack)', blocks: 1.9 },
      { obj: 'plant_bushDetailed', id: 'pack-bush', name: 'Bush (pack)', blocks: 0.95 },
      { obj: 'mushroom_red', id: 'pack-mushroom', name: 'Mushroom (pack)', blocks: 0.85 },
      { obj: 'cactus_tall', id: 'pack-cactus', name: 'Cactus (pack)', blocks: 2.1 },
      { obj: 'stump_round', id: 'pack-stump', name: 'Stump (pack)', blocks: 0.6 },
      { obj: 'log_stack', id: 'pack-logs', name: 'Log pile (pack)', blocks: 0.7 },
      { obj: 'flower_purpleA', id: 'pack-flower', name: 'Flowers (pack)', blocks: 0.5 },
      { obj: 'grass_large', id: 'pack-grass', name: 'Grass tuft (pack)', blocks: 0.5 },
    ],
  },
  {
    dir: 'farm',
    objDir: 'OBJ',
    source: 'Quaternius Farm Animals (CC0)',
    picks: [
      { obj: 'Cow', id: 'cow', name: 'Cow', blocks: 1.12 },
      { obj: 'Horse', id: 'horse', name: 'Horse', blocks: 1.65 },
      { obj: 'Llama', id: 'llama', name: 'Llama', blocks: 1.60 },
      { obj: 'Sheep', id: 'sheep', name: 'Sheep', blocks: 1.03 },
      { obj: 'Pig', id: 'pig', name: 'Pig', blocks: 0.75 },
      { obj: 'Pug', id: 'pug', name: 'Pug', blocks: 0.53 },
      { obj: 'Zebra', id: 'zebra', name: 'Zebra', blocks: 1.53 },
    ],
  },
  {
    dir: 'animal2',
    objDir: 'OBJ',
    source: 'Quaternius Animal Pack Vol.2 (CC0)',
    picks: [
      { obj: 'Cat', id: 'cat', name: 'Cat', blocks: 0.55 },
      { obj: 'Dog', id: 'dog', name: 'Dog', blocks: 0.55 },
      { obj: 'Wolf', id: 'wolf', name: 'Wolf', blocks: 0.63 },
      { obj: 'Eagle', id: 'eagle', name: 'Eagle', blocks: 0.70 },
      { obj: 'Piranha', id: 'piranha', name: 'Piranha', blocks: 0.28 },
    ],
  },
  {
    dir: 'animals',
    objDir: 'OBJ',
    source: 'Quaternius Animals Pack (CC0)',
    picks: [
      { obj: 'Red Fox', id: 'fox', name: 'Fox', blocks: 0.42, tint: '#c05b4d' },
      { obj: 'bird', id: 'bird', name: 'Bird', blocks: 0.22, tint: '#4f9e3f' },
      { obj: 'Chick', id: 'chick', name: 'Chick', blocks: 0.30, tint: '#e7c34a' },
      { obj: 'Fish', id: 'fish', name: 'Fish', blocks: 0.22, tint: '#3f8ed0' },
      { obj: 'Whale', id: 'whale', name: 'Whale', blocks: 0.98, tint: '#575f6b' },
    ],
  },
  {
    dir: 'pirate',
    objDir: 'OBJ',
    source: 'Quaternius Pirate Pack (CC0)',
    picks: [
      { obj: 'Chest', id: 'chest', name: 'Chest', blocks: 0.90, tint: '#a4713f' },
      { obj: 'Cannon', id: 'cannon', name: 'Cannon', blocks: 0.59, tint: '#575f6b' },
      { obj: 'Skull', id: 'skull', name: 'Skull', blocks: 0.35, tint: '#f1f1ee' },
      { obj: 'Brass Telescope', id: 'telescope', name: 'Telescope', blocks: 0.19 },
    ],
  },
  {
    dir: 'cars',
    objDir: 'OBJ',
    source: 'Quaternius Car Pack (CC0)',
    picks: [
      { obj: 'BasicCar', id: 'car', name: 'Car', blocks: 0.83, tint: '#c05b4d' },
      { obj: 'CopCar', id: 'police-car', name: 'Police car', blocks: 0.97, tint: '#f1f1ee' },
      { obj: 'Taxi', id: 'taxi', name: 'Taxi', blocks: 0.94, tint: '#e7c34a' },
      { obj: 'RaceCar', id: 'racer', name: 'Racer', blocks: 0.71, tint: '#3f8ed0' },
      { obj: 'SimpleCarHigh', id: 'van', name: 'Van', blocks: 1.03, tint: '#8d939c' },
      { obj: 'SimpleCarShort', id: 'compact', name: 'Compact', blocks: 0.82, tint: '#4f9e3f' },
    ],
  },
];

/* ── OBJ / MTL ───────────────────────────────────────────────────────── */

/** Blender's default material grey: what a pack leaves behind when its colour is
 *  in a texture, or in the material's *name*, rather than in its `Kd`. */
const DEFAULT_GREY = '#a3a3a3';

/**
 * What a material name means, for the packs that leave every `Kd` at Blender's
 * default grey and put the colour in the name instead — which is how the
 * Quaternius animal packs carry their palette (`White`, `Wolf`, `Beak`…). A
 * model whose materials are all called `Material.001` has no colour to recover
 * and takes its pick's `tint`, one flat colour for the whole mesh.
 */
const NAMED = {
  White: '#f1f1ee', Black: '#2b2b31', Grey: '#8d939c', Wolf: '#8d939c',
  Pink: '#e08e9b', Brown: '#8a5a3b', Tan: '#d9b98a', Dark: '#3b3b42',
  Wood: '#a4713f', DarkWood: '#6b4526', Glass: '#8fd8e6', Gold_: '#e7bd42',
  LightYellow: '#f0de8a', Dog: '#c9a06a', Beak: '#e7a33c', Claws: '#5a5a60',
  Head: '#c9c9c9', Wings: '#b9b9b9', Eye: '#26262b',
  colorRed: '#c05b4d', colorRedDark: '#8f3b33', colorYellow: '#e7c34a',
  colorWhite: '#f1f1ee', colorTan: '#d9b98a', colorPurple: '#8f6bb5',
  corn: '#e7c34a',
};

/** Material name -> hex colour, from an MTL's `Kd` lines. */
function readMtl(text) {
  const out = new Map();
  let name = null;
  for (const line of text.split('\n')) {
    const m = line.trim().split(/\s+/);
    if (m[0] === 'newmtl') name = m[1];
    else if (m[0] === 'Kd' && name) out.set(name, hexOf(+m[1], +m[2], +m[3]));
  }
  return out;
}

/** `Kd` comes as 0..1 in the file's own space; the app works in sRGB hex. */
const hexOf = (r, g, b) => '#' + [r, g, b].map((c) => {
  const v = Math.max(0, Math.min(255, Math.round(c * 255)));
  return v.toString(16).padStart(2, '0');
}).join('');

/** The OBJ's vertices (pack units, y up), faces as [indices, colour]. */
function readObj(text, colours, fallback) {
  const verts = [];
  const faces = [];
  let mat = fallback;
  for (const line of text.split('\n')) {
    if (line[0] === 'v' && line[1] === ' ') {
      const [, x, y, z] = line.trim().split(/\s+/);
      // y-up to z-up. A rotation, so the model's winding survives it.
      verts.push([+x, -+z, +y]);
    } else if (line.startsWith('usemtl')) {
      mat = colours.get(line.trim().split(/\s+/)[1]) || mat;
    } else if (line[0] === 'f' && line[1] === ' ') {
      const ids = line.trim().split(/\s+/).slice(1).map((tok) => {
        const i = Number.parseInt(tok, 10);
        return i > 0 ? i - 1 : verts.length + i;      // supports negative indices
      });
      // Anything with more than three corners is fanned, so the mesh is triangles
      // and the shading stays flat per triangle.
      for (let i = 1; i + 1 < ids.length; i++) faces.push([[ids[0], ids[i], ids[i + 1]], mat]);
    }
  }
  return { verts, faces };
}

/* ── to the app's mesh format ────────────────────────────────────────── */

function convert(base, pick, source) {
  const raw = readMtl(readFileSync(base + '.mtl', 'utf8'));
  // A named colour beats Blender's default grey; a pick's tint covers a mesh
  // whose materials were never named at all.
  const colours = new Map();
  for (const [name, hex] of raw) {
    const plain = hex === DEFAULT_GREY;
    colours.set(name, (plain && (NAMED[name] || pick.tint)) || hex);
  }
  for (const [name, hex] of colours) {
    if (hex === DEFAULT_GREY) {
      console.warn(`! ${pick.id}: material '${name}' has no colour — add it to NAMED or give the pick a tint`);
    }
  }
  const fallback = [...colours.values()][0] || '#cccccc';
  const { verts, faces } = readObj(readFileSync(base + '.obj', 'utf8'), colours, fallback);

  const hi = [-Infinity, -Infinity, -Infinity];
  const lo = [Infinity, Infinity, Infinity];
  for (const v of verts) {
    for (let a = 0; a < 3; a++) {
      if (v[a] < lo[a]) lo[a] = v[a];
      if (v[a] > hi[a]) hi[a] = v[a];
    }
  }
  const scale = pick.blocks / (hi[2] - lo[2]);        // z is up after the rotation

  // Recentre in x/y, drop it on z = 0, scale to the wanted height, and weld the
  // vertices that the OBJ split for its UVs back into one position each.
  const out = [];
  const index = new Map();
  const at = (i) => {
    const v = verts[i];
    const p = [v[0] - (lo[0] + hi[0]) / 2, v[1] - (lo[1] + hi[1]) / 2, v[2] - lo[2]];
    const key = p.map((c) => c.toFixed(4)).join(',');
    let k = index.get(key);
    if (k === undefined) {
      k = out.length / 3;
      index.set(key, k);
      out.push(+(p[0] * scale).toFixed(4), +(p[1] * scale).toFixed(4), +(p[2] * scale).toFixed(4));
    }
    return k;
  };

  const cols = [];
  const colIndex = new Map();
  const tris = [];
  let thin = 0;
  for (const [ids, col] of faces) {
    const [a, b, c] = ids.map(at);
    // A face with no area is a pack quirk, not geometry: drop it rather than
    // give the painter a polygon with no normal.
    const p = [a, b, c].map((i) => [out[i * 3], out[i * 3 + 1], out[i * 3 + 2]]);
    const u = [p[1][0] - p[0][0], p[1][1] - p[0][1], p[1][2] - p[0][2]];
    const v = [p[2][0] - p[0][0], p[2][1] - p[0][1], p[2][2] - p[0][2]];
    const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    if (Math.hypot(...n) < 1e-9) { thin++; continue; }
    let k = colIndex.get(col);
    if (k === undefined) { k = cols.length; cols.push(col); colIndex.set(col, k); }
    tris.push(a, b, c, k);
  }

  const span = [hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]].map((s) => s * scale);

  // A pack can ship a closed mesh wound inside out — the Car Pack does, for five
  // of its six cars — and the renderer culls a face by the way it winds, so such
  // a model would draw its far side and read as a hollow shell. The signed volume
  // of the triangles says which way a closed surface faces; reversing every
  // triangle turns it the right way out. An open mesh (a leaf, a tuft of grass)
  // has a volume near zero and is left exactly as the pack drew it.
  let volume = 0;
  for (let i = 0; i < tris.length; i += 4) {
    const a = [out[tris[i] * 3], out[tris[i] * 3 + 1], out[tris[i] * 3 + 2]];
    const b = [out[tris[i + 1] * 3], out[tris[i + 1] * 3 + 1], out[tris[i + 1] * 3 + 2]];
    const c = [out[tris[i + 2] * 3], out[tris[i + 2] * 3 + 1], out[tris[i + 2] * 3 + 2]];
    volume += (a[0] * (b[1] * c[2] - b[2] * c[1])
      + a[1] * (b[2] * c[0] - b[0] * c[2])
      + a[2] * (b[0] * c[1] - b[1] * c[0])) / 6;
  }
  const flipped = volume < -1e-3;
  if (flipped) {
    for (let i = 0; i < tris.length; i += 4) {
      const swap = tris[i + 1];
      tris[i + 1] = tris[i + 2];
      tris[i + 2] = swap;
    }
  }

  return {
    model: {
      id: pick.id,
      name: pick.name,
      source,
      verts: out.map((n) => Math.round(n * 1e4) / 1e4),
      tris,
      cols,
    },
    stat: {
      name: `${pick.id} (${pick.obj})`,
      tris: tris.length / 4,
      verts: out.length / 3,
      size: `x${span[0].toFixed(2)} y${span[1].toFixed(2)} z${span[2].toFixed(2)}`,
      blocks: `${Math.ceil(span[0] - 1e-6)}×${Math.ceil(span[1] - 1e-6)}×${Math.ceil(span[2] - 1e-6)}`,
      dropped: thin,
      flipped,
    },
  };
}

/* ── main ────────────────────────────────────────────────────────────── */

const root = process.argv[2];
if (!root) {
  console.error('usage: node tools/import-pack.mjs <pack root — one subdirectory per pack>');
  process.exit(2);
}

const built = [];
const rows = [];
const credits = [];
const seen = new Map();
for (const pack of PACKS) {
  credits.push(`//   * ${pack.source} — read from ${pack.dir}/`);
  for (const pick of pack.picks) {
    if (seen.has(pick.id)) {
      console.error(`! ${pick.id}: two models share this id (${seen.get(pick.id)} and ${pack.source})`);
      process.exit(1);
    }
    seen.set(pick.id, pack.source);
    const base = join(root, pack.dir, pack.objDir, pick.obj);
    const { model, stat } = convert(base, pick, pack.source);
    built.push(model);
    rows.push(stat);
    if (stat.blocks.split('×').map(Number).some((n) => n > 9)) {
      console.warn(`! ${stat.name}: ${stat.blocks} blocks is a lot of ground — check the height`);
    }
  }
}

const header = `// Baked from low-poly model packs by tools/import-pack.mjs — do not edit by hand.
//
// Packs, all CC0 (see CREDITS.md):
${credits.join('\n')}
//
// Colours come from each model's material (Kd), one flat colour per triangle:
// this renderer has no textures, and an animated model is baked in its rest
// pose. Coordinates are block units with z up, the model's base on z = 0 and
// its centre on the origin, so definePack() in models.js can treat one exactly
// like an authored mesh.
//
// Regenerate with:  unzip each pack into one root, then
//                   node tools/import-pack.mjs <pack root>

export const PACK = [
`;

const body = built.map((m) => {
  const verts = [];
  for (let i = 0; i < m.verts.length; i += 6) verts.push(m.verts.slice(i, i + 6).join(', '));
  const tris = [];
  for (let i = 0; i < m.tris.length; i += 8) tris.push(m.tris.slice(i, i + 8).join(', '));
  return `  {\n    id: ${JSON.stringify(m.id)},\n    name: ${JSON.stringify(m.name)},\n    source: ${JSON.stringify(m.source)},\n    cols: ${JSON.stringify(m.cols)},\n    verts: [\n      ${verts.join(',\n      ')},\n    ],\n    tris: [\n      ${tris.join(',\n      ')},\n    ],\n  },`;
}).join('\n');

writeFileSync(join(ROOT, OUT), header + body + '\n];\n');

const pad = (s, n) => String(s).padEnd(n);
console.log(pad('model', 24), pad('tris', 6), pad('verts', 6), pad('blocks', 10), 'size (blocks)');
for (const r of rows) {
  const notes = [r.dropped ? `${r.dropped} thin` : '', r.flipped ? 'winding flipped' : ''].filter(Boolean);
  console.log(pad(r.name, 24), pad(r.tris, 6), pad(r.verts, 6), pad(r.blocks, 10), r.size, notes.join(', '));
}
console.log(`\nwrote ${OUT} — ${built.length} models, ${rows.reduce((a, r) => a + r.tris, 0)} triangles`);
