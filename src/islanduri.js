// The island as a filesystem: the `island://` scheme a harness reads and writes.
//
// This is how an agent authors work of its own without a bespoke syntax to
// learn. `island://caps/` describes the language a card is written in,
// `island://caps/<id>.json` *is* a capability (write it and the capability
// exists), `island://cards/` is what is on the ground, and
// `island://cards/<id>.json` is one card — write it and the card is placed, in
// the same undo history, save and export as anything clicked into being.
//
// A file name is an id, and a write is the whole interface, so the tree stays
// boring to teach: reads render the world as text, and the two writable leaves
// are validated here rather than at paint time. A definition that will not
// parse, names a source or renderer that does not exist, or carries an
// expression with a syntax error comes back as a tool error naming the problem —
// the author fixes the file, not the card.
//
// The transport side (registering the scheme, and the frames a read or write
// arrives on) lives in src/omp.js; who asked is carried along as the session id
// of the harness tile that made the call, so a card placed without coordinates
// lands beside the tile that asked for it and records where it came from.

import {
  catalog, evaluate, CAP_SOURCES, CAP_RENDERERS, CAP_PROBES, CAP_FUNCS, CAP_VARS,
} from './caps.js';
import { normalizeChat, CARD_NEW, NOTE_MIN, NOTE_MAX, CHAT_PAPER, FS_DEFAULT, clampFs } from './world.js';
import { primeCard, readingOf } from './cards.js';

export const ISLAND_SCHEME = {
  scheme: 'island',
  description: 'the island itself: its cards, and the capabilities they are written against',
  writable: true,
  immutable: false,
};

let ctx = null;               // { world, invalidate, save } — bound once by main.js

/** Wire the tree to the app: the world it reads and the frame it nudges. */
export function bindIslandUri(app) { ctx = app; }

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const WRITABLE = 'writable paths: island://caps/<id>.json and island://cards/<id>.json';

/* ── urls ────────────────────────────────────────────────────────────── */

/** `island://caps/git.json` → `['caps', 'git.json']`; the tree name is caseless. */
function parse(url) {
  const raw = String(url || '');
  if (!/^island:\/\//i.test(raw)) throw new Error(`not an island:// url: ${raw}`);
  const parts = raw.replace(/^island:\/\//i, '').split(/[?#]/)[0].split('/').filter(Boolean);
  if (parts.length) parts[0] = parts[0].toLowerCase();
  return parts.map((p) => decodeURIComponent(p));
}

/** The `<id>.json` leaf of a tree, with the id checked before anything uses it. */
function leaf(parts, tree) {
  const name = parts[1] || '';
  if (!name.toLowerCase().endsWith('.json')) throw new Error(`island://${tree}/ takes <id>.json files`);
  const id = name.slice(0, -'.json'.length);
  if (!ID_RE.test(id)) throw new Error(`bad id '${id}': letters, digits, - and _ only, up to 64 of them`);
  return id;
}

/* ── reads ───────────────────────────────────────────────────────────── */

const md = (content) => ({ content, contentType: 'text/markdown' });
const json = (value) => ({ content: JSON.stringify(value, null, 1) + '\n', contentType: 'application/json' });

/** Where a card should land when its author did not say: the middle of it all. */
function centreOf(world) {
  const boxes = [];
  for (const t of world.chats) boxes.push([t.x + t.w / 2, t.y + t.h / 2]);
  for (const n of world.notes) boxes.push([n.x + n.w / 2, n.y + n.h / 2]);
  for (const p of world.props) boxes.push([p.x, p.y]);
  if (!boxes.length) return { x: 0, y: 0 };
  const xs = boxes.map((b) => b[0]);
  const ys = boxes.map((b) => b[1]);
  return {
    x: Math.round((Math.min(...xs) + Math.max(...xs)) / 2),
    y: Math.round((Math.min(...ys) + Math.max(...ys)) / 2),
  };
}

/** A w*h patch of ground nothing else claims, spiralling out from `near`. */
export function freeSpot(world, w, h, near) {
  const taken = [];
  for (const t of world.chats) taken.push([t.x, t.y, t.w, t.h]);
  for (const n of world.notes) taken.push([n.x, n.y, n.w, n.h]);
  for (const p of world.props) taken.push([p.x, p.y, 1, 1]);
  // One block of clearance, so a new slab never touches a neighbour's edge.
  const clashes = (x, y) => taken.some(([tx, ty, tw, th]) => x < tx + tw + 1 && x + w + 1 > tx && y < ty + th + 1 && y + h + 1 > ty);
  const cx = Math.round(near.x);
  const cy = Math.round(near.y);
  for (let r = 0; r <= 48; r++) {
    for (let dx = -r; dx <= r; dx++) {
      for (let dy = -r; dy <= r; dy++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        if (!clashes(cx + dx, cy + dy)) return { x: cx + dx, y: cy + dy };
      }
    }
  }
  return { x: cx, y: cy };
}

const tileLine = (t) => `${t.cap !== undefined || t.def !== undefined ? 'card' : 'harness'} ${t.id}`
  + `${t.cap ? ` cap ${t.cap}` : ' def inline'}`
  + ` at ${t.x},${t.y} ${t.w}×${t.h}${t.by ? ` (made by ${t.by})` : ''}`;

function indexDoc(world) {
  return [
    '# island://',
    '',
    `${world.count} blocks · ${world.notes.length} notes · ${world.chats.length} tiles · ${world.props.length} models`,
    '',
    '- `island://caps/` — what a card can say, and how to write one',
    '- `island://cards/` — every card on the island, with what it shows',
    '- `island://world/` — where things are, and where a new one fits',
    '',
    'Cards and capabilities are files: read them, write them.',
    WRITABLE,
    '',
  ].join('\n');
}

function probesDoc() {
  return [
    '# Probes',
    '',
    'A `probe` source is a read the dev server performs; a card names one and',
    'gets its answer back as JSON (`{ value, sub, status, at }`).',
    '',
    ...CAP_PROBES.map((p) => `- \`${p}\``),
    '',
    '`git` takes `path` (default: the directory the server was started in) and',
    'answers `{ value: <uncommitted files>, sub: "<branch> ↑ahead ↓behind",',
    'status: "dirty"|"clean" }`; `cpu` and `mem` take nothing and answer a',
    'percentage; `sh` runs a command on the machine and is disabled unless the',
    'server was started with `ISLAND_CARDS_SHELL=1`.',
    '',
    '`http` sources are the other way out: the server fetches the URL for you, so',
    'the page needs no CORS and no token. Only origins in `ISLAND_FETCH_ORIGINS`',
    'are allowed, and HTTPS only.',
    '',
  ].join('\n');
}

function cardsDoc(world) {
  const cards = world.cards;
  return [
    '# Cards',
    '',
    cards.length ? cards.map((c) => `- ${tileLine(c)}`).join('\n') : '(none yet)',
    '',
    `Write \`island://cards/<id>.json\` to place one; ${WRITABLE}.`,
    '',
  ].join('\n');
}

function worldDoc(world) {
  const spot = freeSpot(world, CARD_NEW.w, CARD_NEW.h, centreOf(world));
  const rows = [];
  for (const n of world.notes) rows.push(`note ${n.id} at ${n.x},${n.y} ${n.w}×${n.h}`);
  for (const t of world.chats) rows.push(tileLine(t));
  for (const p of world.props) rows.push(`model ${p.id} ${p.model} at ${p.x},${p.y} z ${p.z}`);
  return [
    '# The island',
    '',
    `${world.count} blocks · ${world.notes.length} notes · ${world.chats.length} tiles · ${world.props.length} models`,
    '',
    `Highest block at 0,0 is ${world.topAt(0, 0)}, so a tile at the origin rests at z ${world.surfaceUnder(0, 0, 1, 1)}.`,
    '',
    rows.length ? rows.join('\n') : '(nothing placed yet)',
    '',
    `A ${CARD_NEW.w}×${CARD_NEW.h} card fits at ${spot.x},${spot.y} (free ground, nearest to the middle of everything).`,
    '',
  ].join('\n');
}

/** One card as a file: what it is, and what it is showing right now. */
function cardDoc(world, card) {
  const record = { id: card.id, x: card.x, y: card.y, w: card.w, h: card.h, color: card.color | 0, fs: clampFs(card.fs) };
  if (card.cap !== undefined) record.cap = card.cap;
  if (card.def !== undefined) record.def = card.def;
  if (card.name !== undefined) record.name = card.name;
  if (card.by !== undefined) record.by = card.by;
  if (card.state !== undefined) record.state = card.state;
  const def = world.cardDef(card);
  return {
    ...record,
    definition: def ? def.name : null,
    reading: readingOf(world, card),
  };
}

/** Read a path in the tree. Throws with a message the author can act on. */
export function readIsland(url) {
  const world = ctx && ctx.world;
  if (!world) throw new Error('the island is not loaded');
  const parts = parse(url);

  if (!parts.length) return md(indexDoc(world));
  const tree = parts[0];
  if (tree === 'caps') {
    if (!parts[1]) return md(catalog(world));
    if (parts[1].toLowerCase() === 'probes') return md(probesDoc());
    const id = leaf(parts, 'caps');
    if (!world.caps[id]) throw new Error(`no capability '${id}' on this island; island://caps/ lists them, and writing this path defines one`);
    return json(world.caps[id]);
  }
  if (tree === 'cards') {
    if (!parts[1]) return md(cardsDoc(world));
    const id = leaf(parts, 'cards');
    const card = world.card(id);
    if (!card) throw new Error(`no card '${id}'; island://cards/ lists them, and writing this path places one`);
    return json(cardDoc(world, card));
  }
  if (tree === 'world') return md(worldDoc(world));
  throw new Error(`island:// has no '${tree}'; try island://caps/, island://cards/ or island://world/`);
}

/* ── writes ──────────────────────────────────────────────────────────── */

const parseJSON = (content, what) => {
  let data;
  try {
    data = JSON.parse(String(content || ''));
  } catch (err) {
    throw new Error(`${what} is not valid JSON: ${String((err && err.message) || err)}`);
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error(`${what} must be a JSON object`);
  return data;
};

/**
 * The names an expression is written against. A check has to run the
 * expression to catch a syntax or arity error, and the evaluator refuses any
 * name the scope does not carry — so it is handed the same names `viewOf`
 * gives a card at paint time. Without this every honest `value: "v"` came back
 * as `unknown name 'v'`, which refused the catalog's own template.
 */
const CHECK_SCOPE = { v: 0, raw: 0, sub: '', status: 'ok', at: 0, age: 0, state: {}, now: 0, error: null };

/** Everything wrong with a definition, so one write reports all of it at once. */
function definitionProblems(def) {
  const bad = [];
  if (def.source !== undefined) {
    const kind = def.source && typeof def.source === 'object' ? def.source.kind : def.source;
    if (kind !== undefined && !CAP_SOURCES.includes(kind)) bad.push(`source.kind '${kind}' is not one of ${CAP_SOURCES.join(', ')}`);
    else if (kind === 'probe' && !def.source.probe) bad.push('a probe source needs `probe`');
    else if (kind === 'http' && !def.source.url) bad.push('an http source needs `url`');
  }
  if (def.render !== undefined && def.render !== null) {
    if (typeof def.render !== 'object' || Array.isArray(def.render)) bad.push('render must be an object');
    else if (def.render.as !== undefined && !CAP_RENDERERS.includes(def.render.as)) bad.push(`render.as '${def.render.as}' is not one of ${CAP_RENDERERS.join(', ')}`);
  }
  const exprs = [];
  if (typeof def.value === 'string') exprs.push(['value', def.value]);
  if (typeof def.staleAfter === 'string') exprs.push(['staleAfter', def.staleAfter]);
  if (Array.isArray(def.buttons)) {
    for (const [i, b] of def.buttons.entries()) {
      if (!b || typeof b !== 'object' || !b.label) { bad.push(`buttons[${i}] needs a label`); continue; }
      if (b.when !== undefined) exprs.push([`buttons[${i}].when`, b.when]);
      for (const [k, v] of Object.entries(b.set || {})) exprs.push([`buttons[${i}].set.${k}`, v]);
    }
  } else if (def.buttons !== undefined) bad.push('buttons must be an array');
  // The definition's own declared state goes into the check scope too, so a
  // state key written bare gets the evaluator's "did you mean state.x?" hint.
  const checkScope = def.state && typeof def.state === 'object' && !Array.isArray(def.state)
    ? Object.assign({}, CHECK_SCOPE, { state: def.state })
    : CHECK_SCOPE;
  for (const [where, src] of exprs) {
    try {
      evaluate(String(src), checkScope);
    } catch (err) {
      bad.push(`${where}: ${String((err && err.message) || err)}`);
    }
  }
  return bad;
}

/** Where a new card lands: beside the tile that asked, or in the middle. */
export function anchorFor(world, session) {
  const owner = session ? world.chat(session) : null;
  if (!owner) return centreOf(world);
  return { x: owner.x + owner.w + 1, y: owner.y };
}

/**
 * Write `island://cards/<id>.json`: place a card, or change the one already
 * there. An omitted `x`/`y` on a new card puts it beside the harness that asked.
 */
function writeCard(world, id, spec, session) {
  if (spec.cap === undefined && spec.def === undefined) {
    throw new Error('a card needs `cap` (a capability id) or `def` (an inline definition) — see island://caps/');
  }
  if (typeof spec.cap === 'string' && !spec.def && !world.caps[spec.cap]) {
    throw new Error(`no capability '${spec.cap}' on this island: write island://caps/${spec.cap}.json first, or pass an inline \`def\``);
  }
  const existing = world.card(id);
  const patch = {};
  for (const key of ['cap', 'def', 'name', 'x', 'y', 'w', 'h', 'color', 'fs', 'state']) {
    if (spec[key] !== undefined) patch[key] = spec[key];
  }
  const clampAll = (into) => {
    if (into.x !== undefined) into.x = Math.round(Number(into.x) || (existing ? existing.x : 0));
    if (into.y !== undefined) into.y = Math.round(Number(into.y) || (existing ? existing.y : 0));
    if (into.w !== undefined) into.w = Math.min(NOTE_MAX, Math.max(NOTE_MIN, Math.round(Number(into.w) || CARD_NEW.w)));
    if (into.h !== undefined) into.h = Math.min(NOTE_MAX, Math.max(NOTE_MIN, Math.round(Number(into.h) || CARD_NEW.h)));
    if (into.color !== undefined) into.color = Math.abs(Math.round(Number(into.color) || 0)) % CHAT_PAPER.length;
    if (into.fs !== undefined) into.fs = clampFs(into.fs);
    return into;
  };
  if (existing) {
    const keys = Object.keys(patch);
    if (!keys.length) return;                     // nothing to do is not a failure
    world.patchChat(id, clampAll(patch));
    return;
  }
  clampAll(patch);
  const spot = patch.x !== undefined && patch.y !== undefined
    ? { x: patch.x, y: patch.y }
    : freeSpot(world, patch.w || CARD_NEW.w, patch.h || CARD_NEW.h, anchorFor(world, session));
  const card = normalizeChat({
    id,
    x: spot.x,
    y: spot.y,
    w: patch.w === undefined ? CARD_NEW.w : patch.w,
    h: patch.h === undefined ? CARD_NEW.h : patch.h,
    color: patch.color === undefined ? 0 : patch.color,
    fs: patch.fs === undefined ? FS_DEFAULT : patch.fs,
    cap: patch.cap,
    def: patch.def,
    name: patch.name,
    state: patch.state,
    by: session,
  });
  world.addCard(card);
}

/** Write a path in the tree. Throws with a message the author can act on. */
export function writeIsland(url, content, session) {
  const world = ctx && ctx.world;
  if (!world) throw new Error('the island is not loaded');
  const parts = parse(url);
  const tree = parts[0];

  if (tree === 'caps') {
    const id = leaf(parts, 'caps');
    const def = parseJSON(content, `island://caps/${id}.json`);
    const bad = definitionProblems(def);
    if (bad.length) {
      throw new Error(`that definition will not do: ${bad.join('; ')}`
        + ` (sources: ${CAP_SOURCES.join(', ')}; renderers: ${CAP_RENDERERS.join(', ')}; functions: ${CAP_FUNCS.join(', ')}; variables: ${CAP_VARS.join(', ')})`);
    }
    world.defineCap(id, def);
    if (ctx.invalidate) ctx.invalidate();
    if (ctx.save) ctx.save();
    return;
  }
  if (tree === 'cards') {
    const id = leaf(parts, 'cards');
    const spec = parseJSON(content, `island://cards/${id}.json`);
    writeCard(world, id, spec, session);
    if (ctx.invalidate) ctx.invalidate();
    if (ctx.save) ctx.save();
    return;
  }
  throw new Error(`island://${tree} is read-only; ${WRITABLE}`);
}

/* ── the runner omp.js calls ─────────────────────────────────────────── */

/**
 * One read or write of an `island://` url, as the transport hands it over.
 * A write answers with nothing (that is what a file write returns), so an
 * author that wants to know what happened reads the path back.
 */
export async function runHostUri(request) {
  const op = request && request.operation;
  const url = request && request.url;
  if (op === 'read') return readIsland(url);
  if (op === 'write') {
    writeIsland(url, request.content, request.session);
    return {};
  }
  throw new Error(`island:// only knows read and write (got '${op}')`);
}

/**
 * The card a tool just made, read once so the answer can say what it shows
 * rather than only where it landed. Used by `island_card` and by nothing else.
 */
export async function describeCard(world, id) {
  const card = world.card(id);
  if (!card) return { id, problem: `no card '${id}'` };
  const reading = await primeCard(id);
  const def = world.cardDef(card);
  return {
    id,
    cap: card.cap || '(inline)',
    name: def ? def.name : null,
    at: { x: card.x, y: card.y, w: card.w, h: card.h },
    ...reading,
  };
}
