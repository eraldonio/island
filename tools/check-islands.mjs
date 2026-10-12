// Design check for the island library — run by hand, not at runtime:
//
//     node tools/check-islands.mjs [island-id …]
//
// An island is authored as data, and nothing about a wrong one shows up until you
// stamp it and look: an element standing half off the sand, two of them in the
// same blocks, a note floating on the lagoon, a relief block with a material
// that is not a palette id. This walks every island and says so instead, which is
// what makes eight of them affordable to keep in one file.
//
// Exit code 0 when every island is sound, 1 otherwise, so it can gate a commit.

import { ISLANDS, islandScene } from '../src/islands.js';
import { MODELS, modelSize } from '../src/models.js';
import { PALETTE } from '../src/world.js';

/** Things that may stand on a block of water — everything else must be on land. */
const ON_WATER = new Set(['boat', 'pier', 'duck', 'fish', 'whale', 'piranha', 'bird']);
const WATER_ID = PALETTE.find((p) => p.name === 'Water').id;

const BY_ID = new Map(MODELS.map((m) => [m.id, m]));
const problems = [];
let checked = 0;

const only = process.argv.slice(2);
for (const island of ISLANDS) {
  if (only.length && !only.includes(island.id)) continue;
  checked++;

  const scene = islandScene(island);
  for (const p of scene.problems) problems.push(`${island.id}: ${p}`);
  const tops = new Map();     // "x,y" -> z of the surface block
  const mats = new Map();     // "x,y" -> material id of the surface block
  for (const [x, y, z, mat] of scene.voxels) {
    const key = x + ',' + y;
    if (z >= (tops.get(key) ?? -1)) { tops.set(key, z); mats.set(key, mat); }
    if (!Number.isInteger(mat) || !PALETTE.some((p) => p.id === mat)) {
      problems.push(`${island.id}: block ${x},${y},${z} has material ${JSON.stringify(mat)}, not a palette id`);
    }
  }

  const isWater = (x, y) => mats.get(x + ',' + y) === WATER_ID;
  const taken = new Map();    // "x,y" -> what claimed the column
  const claim = (label, x, y, w, h) => {
    for (let i = 0; i < w; i++) {
      for (let j = 0; j < h; j++) {
        const k = (x + i) + ',' + (y + j);
        const was = taken.get(k);
        if (was) problems.push(`${island.id}: ${label} and ${was} both claim ${k}`);
        else taken.set(k, label);
      }
    }
  };

  let blocks = scene.voxels.length, offshore = 0, wet = 0;

  for (const p of scene.props) {
    const model = BY_ID.get(p.model);
    if (!model) { problems.push(`${island.id}: no model called '${p.model}'`); continue; }
    const size = modelSize(model, p.rot | 0);
    claim(`${p.model} at ${p.x},${p.y}`, p.x, p.y, size.w, size.h);
    let min = Infinity, max = -Infinity, off = 0, water = 0;
    for (let i = 0; i < size.w; i++) {
      for (let j = 0; j < size.h; j++) {
        const x = p.x + i, y = p.y + j;
        const t = tops.get(x + ',' + y);
        if (t === undefined) { off++; continue; }
        min = Math.min(min, t); max = Math.max(max, t);
        if (isWater(x, y)) water++;
      }
    }
    if (off) { problems.push(`${island.id}: ${p.model} at ${p.x},${p.y} stands ${off} block(s) off the island`); offshore++; }
    if (water && water === size.w * size.h && !ON_WATER.has(p.model)) {
      problems.push(`${island.id}: ${p.model} at ${p.x},${p.y} stands on water`);
      wet++;
    } else if (water && water < size.w * size.h && !ON_WATER.has(p.model)) {
      problems.push(`${island.id}: ${p.model} at ${p.x},${p.y} straddles the waterline (${water} wet column(s))`);
      wet++;
    }
    if (max - min > 2) {
      problems.push(`${island.id}: ${p.model} at ${p.x},${p.y} straddles a ${max - min}-block step`);
    }
  }

  for (const n of scene.notes) {
    claim(`note at ${n.x},${n.y}`, n.x, n.y, n.w, n.h);
    let off = 0, water = 0, min = Infinity, max = -Infinity;
    for (let i = 0; i < n.w; i++) {
      for (let j = 0; j < n.h; j++) {
        const x = n.x + i, y = n.y + j;
        const t = tops.get(x + ',' + y);
        if (t === undefined) { off++; continue; }
        min = Math.min(min, t); max = Math.max(max, t);
        if (isWater(x, y)) water++;
      }
    }
    if (off) problems.push(`${island.id}: note at ${n.x},${n.y} hangs ${off} block(s) off the island`);
    if (water) problems.push(`${island.id}: note at ${n.x},${n.y} lies on water (${water} column(s))`);
    if (max - min > 2) {
      problems.push(`${island.id}: note at ${n.x},${n.y} bridges a ${max - min}-block drop`);
    }
  }

  const report = [
    `${island.id.padEnd(11)} ${String(scene.w).padStart(2)}x${String(scene.h).padStart(2)}`,
    `${String(blocks).padStart(5)} blocks`,
    `${String(scene.props.length).padStart(3)} elements`,
    `${String(scene.notes.length).padStart(2)} notes`,
  ];
  console.log(report.join('  ') + (offshore || wet ? `   (${offshore} offshore, ${wet} wet)` : ''));
}

if (!problems.length) {
  console.log(`\n${checked} island(s) sound`);
  process.exit(0);
}
console.log(`\n${problems.length} problem(s):`);
for (const p of problems) console.log('  ' + p);
process.exit(1);
