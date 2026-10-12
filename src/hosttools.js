// What a harness tile can do to the world.
//
// A harness tile is a live `omp` session the page drives through serve.py's RPC
// bridge. The bridge carries frames both ways but owns no world state, so the
// tools are declared *and* run by the page: `omp.js` hands this list to omp with
// `set_host_tools`, a call comes back as a `host_tool_call` frame, `runHostTool`
// applies it here, and the answer goes back over the same bridge. Every session
// the page spawns — including harness tiles a harness spawns — gets the surface,
// so an agent in the island is not a spectator: it can read the world, shape the
// terrain, write and edit notes, place and move models, stamp an island, drop a
// new harness tile with a first prompt, and remove what it made.
//
// Everything an agent does this way is an ordinary edit. It goes through the same
// World methods a click does, so it lands on the undo stack the world view shares
// (`Ctrl+Z` takes back an agent's edit exactly like the user's own) and it is
// saved and exported like any other work.
//
// Coordinates are block columns: x and y on the ground plane, z a height layer.
// A note or harness tile is a w*h block footprint resting on the highest block
// under it; a model is centred on the column it is placed at.

import {
  PALETTE, PAPER, NOTE_NEW, NOTE_MIN, NOTE_MAX,
  CHAT_NEW, CHAT_PAPER, FS_DEFAULT, uid, normalizeNote, clampFs,
} from './world.js';
import { MODELS, modelSize } from './models.js';
import { ISLANDS, islandScene, islandParts } from './islands.js';
import { sessionFor } from './omp.js';
import { sanitizeHtml } from './notes.js';

// ── wiring ─────────────────────────────────────────────────────────────

let ctx = null;   // the running app, bound once by main.js

/** Wire the tools to the app: world, camera, and the local teardown hooks. */
export function bindHostTools(app) { ctx = app; }

const int = (description) => ({ type: 'integer', description });
const str = (description) => ({ type: 'string', description });

const MODEL_IDS = () => MODELS.map((m) => m.id).join(', ');
const ISLAND_IDS = () => ISLANDS.map((i) => i.id).join(', ');

/**
 * The tool surface registered with every harness session. `loadMode: essential`
 * keeps these at the top level rather than behind the `xd://` transport, since
 * they are how the agent touches the world it lives in.
 */
export const HOST_TOOLS = [
  {
    name: 'island_look',
    label: 'Look at the island',
    description:
      'Read the island: how much is built, where the camera is, and every note, harness tile ' +
      'and placed model near a point, with the ids needed to edit or remove them. Pass `note` ' +
      'to read one note\'s full rich text. Call this first: nothing else tells you what is there.',
    loadMode: 'essential',
    parameters: {
      type: 'object',
      properties: {
        x: int('Column to look around. Omit to list the whole island.'),
        y: int('Row to look around. Omit to list the whole island.'),
        radius: int('How far around (x, y) to list tiles and models, in blocks. Default 24.'),
        note: str('Id of one note: return its full rich text instead of the summary.'),
      },
      additionalProperties: false,
    },
  },
  {
    name: 'island_blocks',
    label: 'Shape the terrain',
    description:
      'Build on, dig out or paint the surface over a w*h patch of block columns at (x, y). ' +
      'Without `z`: build stacks one block on top of each column\'s own surface, dig removes ' +
      'each column\'s top block, paint recolours it. With `z`: the same operation on that one ' +
      'height layer. `mat` names a material by number or name (default grass).',
    loadMode: 'essential',
    parameters: {
      type: 'object',
      properties: {
        op: { type: 'string', enum: ['build', 'dig', 'paint'], description: 'What to do. Default build.' },
        x: int('Block column of the patch\'s near corner.'),
        y: int('Block row of the patch\'s near corner.'),
        w: int('Patch width in blocks, 1…32. Default 1.'),
        h: int('Patch depth in blocks, 1…32. Default 1.'),
        mat: { type: ['integer', 'string'], description: `Material id or name (${PALETTE.map((p) => `${p.id} ${p.name}`).join(', ')}).` },
        z: int('Exact height layer to act on, instead of each column\'s own surface.'),
      },
      required: ['op', 'x', 'y'],
      additionalProperties: false,
    },
  },
  {
    name: 'island_note',
    label: 'Write a note',
    description:
      'Create a sticky note on the surface at (x, y), or edit an existing one by id. `html` is ' +
      'the note\'s rich text (kept as written, sanitised); w and h are its size in blocks; ' +
      '`color` picks the paper; `fs` is the preview text size in px. A new note defaults to ' +
      `${NOTE_NEW.w}×${NOTE_NEW.h}. Returns the note's id.`,
    loadMode: 'essential',
    parameters: {
      type: 'object',
      properties: {
        id: str('Id of an existing note to edit. Omit to create one.'),
        x: int('Block column the note\'s near corner sits at.'),
        y: int('Block row the note\'s near corner sits at.'),
        w: int(`Width in blocks, ${NOTE_MIN}…${NOTE_MAX}.`),
        h: int(`Depth in blocks, ${NOTE_MIN}…${NOTE_MAX}.`),
        html: str('The note\'s rich text (paragraphs, headings, lists, code, emphasis).'),
        color: int(`Paper colour, 0…${PAPER.length - 1}.`),
        fs: int('Preview text size in px, 3…40.'),
      },
      additionalProperties: false,
    },
  },
  {
    name: 'island_model',
    label: 'Place a model',
    description:
      'Place one of the low-poly models standing on the surface at column (x, y), or move and ' +
      'turn an existing one by id. A model is centred on the column and rests on its surface; ' +
      '`rot` is a quarter turn (0…3). Returns the model\'s id.',
    loadMode: 'essential',
    parameters: {
      type: 'object',
      properties: {
        model: str(`Model id: ${MODEL_IDS()}.`),
        id: str('Id of an already placed model to move or turn. Omit to place a new one.'),
        x: int('Block column to stand it on.'),
        y: int('Block row to stand it on.'),
        rot: int('Quarter turn, 0…3 (0 faces the default way).'),
      },
      additionalProperties: false,
    },
  },
  {
    name: 'island_island',
    label: 'Stamp an island',
    description:
      'Stamp one of the preconfigured islands — its relief, its models and its notes together — ' +
      'centred on column (x, y). One undoable step, and nothing about it stays special ' +
      'afterwards: it is ordinary blocks, models and notes.',
    loadMode: 'essential',
    parameters: {
      type: 'object',
      properties: {
        island: str(`Island id or name: ${ISLAND_IDS()}.`),
        x: int('Block column to centre it on.'),
        y: int('Block row to centre it on.'),
      },
      required: ['island', 'x', 'y'],
      additionalProperties: false,
    },
  },
  {
    name: 'island_harness',
    label: 'Spawn a harness',
    description:
      'Drop a new harness tile at (x, y) and immediately send it `prompt` as its first message. ' +
      'The new session has this same tool surface, so one agent can hand work to another. ' +
      'Returns the new tile\'s id; its answer streams on the tile, not here.',
    loadMode: 'essential',
    parameters: {
      type: 'object',
      properties: {
        x: int('Block column of the near corner.'),
        y: int('Block row of the near corner.'),
        w: int(`Width in blocks, ${NOTE_MIN}…${NOTE_MAX}. Default ${CHAT_NEW.w}.`),
        h: int(`Depth in blocks, ${NOTE_MIN}…${NOTE_MAX}. Default ${CHAT_NEW.h}.`),
        prompt: str('The first message to send the new harness.'),
        color: int(`Slab colour, 0…${CHAT_PAPER.length - 1}.`),
        fs: int('Preview text size in px, 3…40.'),
      },
      required: ['x', 'y', 'prompt'],
      additionalProperties: false,
    },
  },
  {
    name: 'island_remove',
    label: 'Remove something',
    description:
      'Remove a note, a placed model or a harness tile by id (undo on the island brings it ' +
      'back). Ids come from island_look or from the tool that created the thing.',
    loadMode: 'essential',
    parameters: {
      type: 'object',
      properties: { id: str('Id of the note, model or harness tile to remove.') },
      required: ['id'],
      additionalProperties: false,
    },
  },
];

// ── small helpers ──────────────────────────────────────────────────────

const MODEL_BY_ID = new Map(MODELS.map((m) => [m.id, m]));

const round = (v, fallback) => (Number.isFinite(Number(v)) ? Math.round(Number(v)) : fallback);
const clampInt = (v, lo, hi, fallback) => Math.min(hi, Math.max(lo, round(v, fallback)));
const clampIdx = (v, count, fallback) => clampInt(v, 0, count - 1, fallback);

const tileSize = (args, fallback) => ({
  w: clampInt(args.w, NOTE_MIN, NOTE_MAX, fallback.w),
  h: clampInt(args.h, NOTE_MIN, NOTE_MAX, fallback.h),
});

/** A material id from a number or a palette name, or `fallback` when unknown. */
function material(mat, fallback = 0) {
  if (mat === undefined || mat === null) return fallback;
  const text = String(mat).trim();
  if (/^-?\d+$/.test(text)) return clampIdx(text, PALETTE.length, fallback);
  const byName = PALETTE.find((p) => p.name.toLowerCase() === text.toLowerCase());
  return byName ? byName.id : fallback;
}

const htmlText = (html) => String(html || '').replace(/<[^>]*>/g, ' ');
const clip = (s, n) => {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n) + '…' : t;
};

const propFootprint = (p) => {
  const model = MODEL_BY_ID.get(p.model);
  return model ? modelSize(model, p.rot | 0) : { w: 1, h: 1, hz: 1 };
};

/** The things an agent can name, so it never has to guess an id. */
const catalogue = () => [
  `materials: ${PALETTE.map((p) => `${p.id} ${p.name}`).join(', ')}`,
  `models: ${MODEL_IDS()}`,
  `islands: ${ISLAND_IDS()}`,
  `paper: 0…${PAPER.length - 1}, harness slabs: 0…${CHAT_PAPER.length - 1}`,
];

// ── the tools ──────────────────────────────────────────────────────────

/** Every edit is a frame and a save, exactly like a click. */
function after() {
  ctx.invalidate();
  ctx.requestSave();
}

const HANDLERS = {
  island_look(args) {
    const world = ctx.world;
    if (args.note !== undefined && args.note !== null && String(args.note) !== '') {
      const note = world.note(String(args.note));
      if (!note) throw new Error(`no note with id ${args.note}`);
      return [
        `note ${note.id} at ${note.x},${note.y} ${note.w}×${note.h} paper ${note.color} fs ${clampFs(note.fs)}`,
        note.html || '(empty)',
      ].join('\n');
    }

    const out = [];
    out.push(`blocks ${world.count} · notes ${world.notes.length} · harnesses ${world.chats.length} · models ${world.props.length}`);
    const cam = ctx.cam;
    out.push(`camera spin ${Math.round(cam.spin)}° tilt ${Math.round(cam.tilt)}° zoom ${Math.round(cam.scale * 100)}%`);

    const centred = args.x !== undefined && args.y !== undefined;
    const at = { x: round(args.x, 0), y: round(args.y, 0) };
    const radius = clampInt(args.radius, 1, 512, 24);
    if (centred) {
      const top = world.topAt(at.x, at.y);
      out.push(`column ${at.x},${at.y}: ${top < 0 ? 'bare ground' : `top block at z ${top}`} → a tile there rests at z ${world.surfaceUnder(at.x, at.y, 1, 1)}`);
    }
    const near = (x, y, w, h) => !centred
      || (Math.abs(x + (w - 1) / 2 - at.x) <= radius && Math.abs(y + (h - 1) / 2 - at.y) <= radius);

    const rows = [];
    for (const n of world.notes) {
      if (!near(n.x, n.y, n.w, n.h)) continue;
      rows.push(`note ${n.id} at ${n.x},${n.y} ${n.w}×${n.h} paper ${n.color} fs ${clampFs(n.fs)}: “${clip(htmlText(n.html), 90)}”`);
    }
    for (const c of world.chats) {
      if (!near(c.x, c.y, c.w, c.h)) continue;
      rows.push(`harness ${c.id} at ${c.x},${c.y} ${c.w}×${c.h} slab ${c.color} fs ${clampFs(c.fs)} — ${sessionFor(c.id).label}`);
    }
    for (const p of world.props) {
      const size = propFootprint(p);
      if (!near(p.x, p.y, size.w, size.h)) continue;
      rows.push(`model ${p.id} ${p.model} at ${p.x},${p.y} z ${p.z} turn ${p.rot | 0}`);
    }
    out.push(rows.length ? rows.slice(0, 60).join('\n') : (centred ? 'nothing placed there yet' : 'the island is empty'));
    if (rows.length > 60) out.push(`… and ${rows.length - 60} more`);
    out.push(...catalogue());
    return out.join('\n');
  },

  island_blocks(args) {
    const world = ctx.world;
    const op = String(args.op || 'build').toLowerCase();
    if (op !== 'build' && op !== 'dig' && op !== 'paint') {
      throw new Error(`op must be build, dig or paint (got ${args.op})`);
    }
    const x = round(args.x, 0);
    const y = round(args.y, 0);
    const w = clampInt(args.w, 1, 32, 1);
    const h = clampInt(args.h, 1, 32, 1);
    const mat = material(args.mat, 0);
    const fixed = args.z === undefined || args.z === null ? null : round(args.z, 0);

    const edits = [];
    for (let i = 0; i < w; i++) {
      for (let j = 0; j < h; j++) {
        const cx = x + i;
        const cy = y + j;
        if (fixed !== null) {
          // One height layer named outright: build only into air, dig and paint
          // only what is there.
          const there = world.get(cx, cy, fixed) !== undefined;
          if (op === 'build' ? !there : there) edits.push({ x: cx, y: cy, z: fixed, mat: op === 'dig' ? null : mat });
          continue;
        }
        const top = world.topAt(cx, cy);
        if (op === 'build') edits.push({ x: cx, y: cy, z: top + 1, mat });
        else if (top >= 0) edits.push({ x: cx, y: cy, z: top, mat: op === 'dig' ? null : mat });
      }
    }

    const n = world.apply(edits);
    if (n) after();
    const verb = op === 'dig' ? 'dug out' : op === 'paint' ? 'painted' : 'built';
    return `${verb} ${n} block${n === 1 ? '' : 's'} over ${w}×${h} at ${x},${y}${fixed !== null ? ` (layer z ${fixed})` : ''}`;
  },

  island_note(args) {
    const world = ctx.world;
    const id = args.id === undefined || args.id === null ? '' : String(args.id);

    if (id) {
      const note = world.note(id);
      if (!note) throw new Error(`no note with id ${id}`);
      const patch = {};
      if (args.x !== undefined) patch.x = round(args.x, note.x);
      if (args.y !== undefined) patch.y = round(args.y, note.y);
      if (args.w !== undefined) patch.w = clampInt(args.w, NOTE_MIN, NOTE_MAX, note.w);
      if (args.h !== undefined) patch.h = clampInt(args.h, NOTE_MIN, NOTE_MAX, note.h);
      if (args.color !== undefined) patch.color = clampIdx(args.color, PAPER.length, note.color);
      if (args.fs !== undefined) patch.fs = clampFs(args.fs);
      if (args.html !== undefined) patch.html = sanitizeHtml(String(args.html));
      const keys = Object.keys(patch);
      if (!keys.length) return `note ${id} is unchanged: nothing to patch`;
      world.patchNote(id, patch);
      after();
      return `patched note ${id} (${keys.join(', ')})`;
    }

    const { w, h } = tileSize(args, NOTE_NEW);
    const note = normalizeNote({
      id: uid(),
      x: round(args.x, 0),
      y: round(args.y, 0),
      w,
      h,
      color: clampIdx(args.color, PAPER.length, 0),
      fs: args.fs === undefined ? FS_DEFAULT : clampFs(args.fs),
      html: sanitizeHtml(String(args.html || '')),
    });
    world.addNote(note);
    after();
    return `created note ${note.id} at ${note.x},${note.y} ${note.w}×${note.h}`;
  },

  island_model(args) {
    const world = ctx.world;
    const id = args.id === undefined || args.id === null ? '' : String(args.id);

    if (id) {
      const prop = world.prop(id);
      if (!prop) throw new Error(`no placed model with id ${id}`);
      const model = MODEL_BY_ID.get(prop.model);
      const rot = args.rot === undefined ? prop.rot | 0 : ((round(args.rot, 0) % 4) + 4) % 4;
      const at = { rot };
      const moved = args.x !== undefined || args.y !== undefined;
      if (!model) {
        // An unknown model id is kept by the world but has no footprint to
        // centre; move it where it was asked to go.
        if (moved) {
          at.x = args.x === undefined ? prop.x : round(args.x, prop.x);
          at.y = args.y === undefined ? prop.y : round(args.y, prop.y);
          at.z = world.surfaceUnder(at.x, at.y, 1, 1);
        }
      } else if (moved) {
        // x/y name the column it should stand centred on, the way placing it did.
        const from = modelSize(model, prop.rot | 0);
        const to = modelSize(model, rot);
        const cx = args.x === undefined ? prop.x + ((from.w - 1) >> 1) : round(args.x, 0);
        const cy = args.y === undefined ? prop.y + ((from.h - 1) >> 1) : round(args.y, 0);
        at.x = cx - ((to.w - 1) >> 1);
        at.y = cy - ((to.h - 1) >> 1);
        at.z = world.surfaceUnder(cx, cy, 1, 1);
      } else {
        // A turn on the spot: keep the footprint centred, as `R` does.
        const from = modelSize(model, prop.rot | 0);
        const to = modelSize(model, rot);
        at.x = prop.x + Math.trunc((from.w - to.w) / 2);
        at.y = prop.y + Math.trunc((from.h - to.h) / 2);
      }
      if (!world.moveProp(id, at)) return `model ${id} did not move`;
      after();
      return `moved model ${id} (${prop.model}) to ${prop.x},${prop.y} z ${prop.z}, turn ${prop.rot | 0}`;
    }

    const model = MODEL_BY_ID.get(String(args.model || ''));
    if (!model) throw new Error(`unknown model '${args.model}'; models: ${MODEL_IDS()}`);
    const rot = ((round(args.rot, 0) % 4) + 4) % 4;
    const size = modelSize(model, rot);
    const cx = round(args.x, 0);
    const cy = round(args.y, 0);
    const prop = {
      id: uid(),
      model: model.id,
      x: cx - ((size.w - 1) >> 1),
      y: cy - ((size.h - 1) >> 1),
      z: world.surfaceUnder(cx, cy, 1, 1),
      rot,
    };
    world.addProp(prop);
    after();
    return `placed ${model.id} (${model.name}) as ${prop.id} at ${prop.x},${prop.y} z ${prop.z}, turn ${rot}`;
  },

  island_island(args) {
    const world = ctx.world;
    const want = String(args.island ?? '').trim().toLowerCase();
    const found = ISLANDS.find((i) => i.id.toLowerCase() === want)
      || ISLANDS.find((i) => i.name.toLowerCase() === want);
    if (!found) throw new Error(`unknown island '${args.island}'; islands: ${ISLAND_IDS()}`);
    const scene = islandScene(found);
    const cx = round(args.x, 0);
    const cy = round(args.y, 0);
    const z = world.surfaceUnder(cx, cy, 1, 1);
    const parts = islandParts(scene, cx, cy, z);
    world.stamp(parts);
    after();
    return `stamped ${found.name} (${scene.w}×${scene.h}) centred on ${cx},${cy} resting at z ${z}: `
      + `${parts.voxels.length} blocks, ${parts.props.length} models, ${parts.notes.length} notes`;
  },

  async island_harness(args) {
    const world = ctx.world;
    const { w, h } = tileSize(args, CHAT_NEW);
    const chat = {
      id: uid(),
      x: round(args.x, 0),
      y: round(args.y, 0),
      w,
      h,
      color: clampIdx(args.color, CHAT_PAPER.length, 0),
      fs: args.fs === undefined ? FS_DEFAULT : clampFs(args.fs),
    };
    world.addChat(chat);
    after();
    const prompt = String(args.prompt || '').trim();
    const session = sessionFor(chat.id);
    await session.open();
    if (prompt) session.prompt(prompt);
    return `spawned harness ${chat.id} at ${chat.x},${chat.y} ${chat.w}×${chat.h}`
      + (prompt ? ` and sent it: ${clip(prompt, 140)}` : ' (no prompt sent)');
  },

  island_remove(args) {
    const world = ctx.world;
    const id = String(args.id ?? '');
    if (!id) throw new Error('id is required');
    if (world.note(id)) { ctx.removeNote(id); return `removed note ${id}`; }
    if (world.chat(id)) { ctx.removeChat(id); return `removed harness ${id} and stopped its session`; }
    if (world.prop(id)) { world.removeProp(id); after(); return `removed model ${id}`; }
    throw new Error(`nothing on the island has id ${id}`);
  },
};

/**
 * Run one host tool call against the world (`host_tool_call` in omp.js).
 * Throwing is how a tool fails: omp.js turns it into an `isError` result the
 * model can read and correct.
 */
export async function runHostTool(name, args) {
  if (!ctx) throw new Error('the island is not wired to run harness tools');
  const handler = HANDLERS[name];
  if (!handler) throw new Error(`unknown island tool ${name}`);
  const text = await handler(args && typeof args === 'object' ? args : {});
  return { content: [{ type: 'text', text }] };
}
