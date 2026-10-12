#!/usr/bin/env node
// Bake props out of a low-poly model pack into src/models.pack.js.
//
// The app loads no model formats at runtime and has no build step: this is a
// one-off converter, run by hand when a model is wanted from a pack. It reads
// Wavefront OBJ + MTL (the lowest common denominator every pack ships), takes
// each face's colour from its material, and writes geometry in the units the
// renderer wants — block units, z up, one mesh per model, ready for
// `definePack()` in models.js to bake quarter turns for.
//
// What it deliberately does NOT do: textures. A face here is one flat colour,
// so a pack that colours its models with a texture atlas would come out
// single-coloured. Kenney's kits put a Kd colour in the MTL instead, which is
// why this tool works on them.
//
//   unzip -q kenney_nature-kit.zip -d /tmp/nature
//   node tools/import-pack.mjs /tmp/nature
//
// Only CC0 packs belong here (no attribution, no restrictions). Add the pack to
// CREDITS.md when you bake from a new one.

import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Where each pack keeps its OBJ files, relative to the pack root. */
const OBJ_DIR = 'Models/OBJ format';

/**
 * What to bake, and how tall it should stand in blocks. `blocks` is the height,
 * so proportions within a model are kept but each one lands at the scale the
 * world wants; the footprint follows from the result (`ceil` of the bounding
 * box), exactly as it does for the models authored by hand.
 */
const PICKS = [
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
];

const SOURCE = 'Kenney Nature Kit (CC0)';

/* ── OBJ / MTL ───────────────────────────────────────────────────────── */

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

function convert(root, pick) {
  const base = join(root, OBJ_DIR, pick.obj);
  const colours = readMtl(readFileSync(base + '.mtl', 'utf8'));
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
  return {
    model: {
      id: pick.id,
      name: pick.name,
      source: SOURCE,
      verts: out.map((n) => Math.round(n * 1e4) / 1e4),
      tris,
      cols,
    },
    stat: {
      name: pick.obj,
      tris: tris.length / 4,
      verts: out.length / 3,
      size: `x${span[0].toFixed(2)} y${span[1].toFixed(2)} z${span[2].toFixed(2)}`,
      blocks: `${Math.ceil(span[0] - 1e-6)}×${Math.ceil(span[1] - 1e-6)}×${Math.ceil(span[2] - 1e-6)}`,
      dropped: thin,
    },
  };
}

/* ── main ────────────────────────────────────────────────────────────── */

const root = process.argv[2];
if (!root) {
  console.error('usage: node tools/import-pack.mjs <unzipped pack root>');
  process.exit(2);
}

const built = [];
const rows = [];
for (const pick of PICKS) {
  const { model, stat } = convert(root, pick);
  built.push(model);
  rows.push(stat);
  if (stat.blocks.split('×').map(Number).some((n) => n > 4)) {
    console.warn(`! ${stat.name}: ${stat.blocks} blocks is a lot of ground — check the height`);
  }
}

const header = `// Baked from a model pack by tools/import-pack.mjs — do not edit by hand.
//
// Source: ${SOURCE}
// Colours come from each model's material (Kd), one flat colour per triangle:
// this renderer has no textures. Coordinates are block units with z up, the
// model's base on z = 0 and its centre on the origin, so definePack() in
// models.js can treat it exactly like an authored mesh.
//
// Regenerate with:  unzip -q <pack>.zip -d /tmp/pack && node tools/import-pack.mjs /tmp/pack

export const PACK_SOURCE = ${JSON.stringify(SOURCE)};

export const PACK = [
`;

const body = built.map((m) => {
  const verts = [];
  for (let i = 0; i < m.verts.length; i += 6) verts.push(m.verts.slice(i, i + 6).join(', '));
  const tris = [];
  for (let i = 0; i < m.tris.length; i += 8) tris.push(m.tris.slice(i, i + 8).join(', '));
  return `  {\n    id: ${JSON.stringify(m.id)},\n    name: ${JSON.stringify(m.name)},\n    source: ${JSON.stringify(m.source)},\n    cols: ${JSON.stringify(m.cols)},\n    verts: [\n      ${verts.join(',\n      ')},\n    ],\n    tris: [\n      ${tris.join(',\n      ')},\n    ],\n  },`;
}).join('\n');

writeFileSync(join(ROOT, 'src/models.pack.js'), header + body + '\n];\n');

const pad = (s, n) => String(s).padEnd(n);
console.log(pad('model', 22), pad('tris', 6), pad('verts', 6), pad('blocks', 10), 'size (blocks)', 'dropped');
for (const r of rows) console.log(pad(r.name, 22), pad(r.tris, 6), pad(r.verts, 6), pad(r.blocks, 10), r.size, r.dropped || '');
console.log(`\nwrote src/models.pack.js — ${built.length} models, ${rows.reduce((a, r) => a + r.tris, 0)} triangles`);
