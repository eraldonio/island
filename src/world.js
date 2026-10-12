// The world: a sparse voxel set chunked on x/y, plus sticky notes and a
// command stack for undo/redo.

import { CHUNK, Z_MIN, Z_MAX } from './iso.js';

export const PALETTE = [
  { id: 0, name: 'Grass', color: '#6cbb4f' },
  { id: 1, name: 'Dirt', color: '#9c6b4a' },
  { id: 2, name: 'Stone', color: '#8b929e' },
  { id: 3, name: 'Sand', color: '#e2d3a4' },
  { id: 4, name: 'Wood', color: '#b07a3f' },
  { id: 5, name: 'Brick', color: '#c05b4d' },
  { id: 6, name: 'Snow', color: '#edf3f8' },
  { id: 7, name: 'Slate', color: '#575f6b' },
  { id: 8, name: 'Leaf', color: '#4f9e3f' },
];

export const PAPER = ['#ffe08a', '#ffc9d6', '#c4e2ff', '#c9f0c0', '#e0ccff', '#f4f1e8'];

const ckey = (cx, cy) => cx + ':' + cy;
const tkey = (x, y) => x + ',' + y;
const lkey = (x, y, z) => (x & 15) | ((y & 15) << 4) | (z << 8);

/** The undoable state of a placed model: where it stands and which way it faces. */
const propState = (p) => ({ x: p.x, y: p.y, z: p.z, rot: p.rot | 0 });

export class World {
  constructor() {
    this.chunks = new Map();   // "cx:cy" -> { cx, cy, data: Map<localKey, matId> }
    this.tops = new Map();     // "x,y"   -> highest z (for column ops)
    this.notes = [];
    this.chats = [];          // harness tiles: { id, x, y, w, h }
    this.props = [];          // placed models: { id, model, x, y, z, rot }
    this.undoStack = [];
    this.redoStack = [];
    this.stroke = null;
    this.propDrag = null;     // { id, before } while a model is being dragged
    this.count = 0;
    this.rev = 0;              // bumped on any voxel change (geometry caches)
  }

  /* ── voxels ────────────────────────────────────────────────────────── */

  get(x, y, z) {
    if (z < Z_MIN || z > Z_MAX) return undefined;
    const c = this.chunks.get(ckey(x >> 4, y >> 4));
    return c ? c.data.get(lkey(x, y, z)) : undefined;
  }

  topAt(x, y) {
    const t = this.tops.get(tkey(x, y));
    return t === undefined ? -1 : t;
  }

  /** Raw write. Returns true when the world actually changed. */
  set(x, y, z, mat) {
    if (z < Z_MIN || z > Z_MAX) return false;
    const K = ckey(x >> 4, y >> 4);
    const c = this.chunks.get(K);
    const lk = lkey(x, y, z);
    const prev = c ? c.data.get(lk) : undefined;

    if (mat == null) {
      if (prev === undefined) return false;
      c.data.delete(lk);
      if (c.data.size === 0) this.chunks.delete(K);
      if (this.tops.get(tkey(x, y)) === z) {
        let t = -1;
        for (let zz = z - 1; zz >= Z_MIN; zz--) {
          if (this.get(x, y, zz) !== undefined) { t = zz; break; }
        }
        if (t < 0) this.tops.delete(tkey(x, y)); else this.tops.set(tkey(x, y), t);
      }
      this.count--;
      this.rev++;
      return true;
    }

    if (prev === mat) return false;
    let chunk = c;
    if (!chunk) {
      chunk = { cx: x >> 4, cy: y >> 4, data: new Map() };
      this.chunks.set(K, chunk);
    }
    if (prev === undefined) this.count++;
    chunk.data.set(lk, mat);
    const tk = tkey(x, y);
    const cur = this.tops.get(tk);
    if (cur === undefined || z > cur) this.tops.set(tk, z);
    this.rev++;
    return true;
  }

  /**
   * Height of the surface under a w*h block footprint: one above the highest
   * block beneath it, so a rigid note tile rests on the tallest point.
   * Bare ground reads as 0.
   */
  surfaceUnder(x, y, w, h) {
    let top = -1;
    for (let i = 0; i < w; i++) {
      for (let j = 0; j < h; j++) {
        const t = this.topAt(x + i, y + j);
        if (t > top) top = t;
      }
    }
    return top + 1;
  }

  /** Apply a batch of {x,y,z,mat} edits, recording them for undo. */
  apply(list) {
    const edits = [];
    for (const e of list) {
      const before = this.get(e.x, e.y, e.z);
      const after = e.mat == null ? undefined : e.mat;
      if (before === after) continue;
      if (this.set(e.x, e.y, e.z, e.mat)) {
        edits.push({ x: e.x, y: e.y, z: e.z, before, after });
      }
    }
    if (edits.length) this._record({ kind: 'voxels', edits });
    return edits.length;
  }

  /* ── undo / redo ───────────────────────────────────────────────────── */

  /** Group every following edit into a single undo step (one drag stroke). */
  beginStroke() { this.stroke = []; }
  endStroke() {
    const s = this.stroke;
    this.stroke = null;
    if (s && s.length) this._commit({ kind: 'voxels', edits: s });
  }

  _record(cmd) {
    if (this.stroke) { this.stroke.push(...cmd.edits); return; }
    this._commit(cmd);
  }

  _commit(cmd) {
    this.undoStack.push(cmd);
    if (this.undoStack.length > 400) this.undoStack.shift();
    this.redoStack.length = 0;
    this.rev++;              // note geometry can depend on any change
  }

  canUndo() { return this.undoStack.length > 0; }
  canRedo() { return this.redoStack.length > 0; }

  undo() {
    const cmd = this.undoStack.pop();
    if (!cmd) return false;
    this._run(cmd, 'undo');
    this.redoStack.push(cmd);
    this.rev++;
    return true;
  }

  redo() {
    const cmd = this.redoStack.pop();
    if (!cmd) return false;
    this._run(cmd, 'redo');
    this.undoStack.push(cmd);
    this.rev++;
    return true;
  }

  _run(cmd, dir) {
    const back = dir === 'undo';
    switch (cmd.kind) {
      case 'voxels':
        for (const e of cmd.edits) {
          this.set(e.x, e.y, e.z, back ? e.before : e.after);
        }
        break;
      case 'note-add':
        if (back) this._detach(cmd.note.id); else this.notes.push(cmd.note);
        break;
      case 'note-del':
        if (back) this.notes.splice(Math.min(cmd.index, this.notes.length), 0, cmd.note);
        else this._detach(cmd.note.id);
        break;
      case 'note-patch': {
        const n = this.note(cmd.id);
        if (n) Object.assign(n, back ? cmd.before : cmd.after);
        break;
      }
      case 'chat-add':
        if (back) this._detachChat(cmd.chat.id); else this.chats.push(cmd.chat);
        break;
      case 'chat-del':
        if (back) this.chats.splice(Math.min(cmd.index, this.chats.length), 0, cmd.chat);
        else this._detachChat(cmd.chat.id);
        break;
      case 'chat-patch': {
        const c = this.chat(cmd.id);
        if (c) Object.assign(c, back ? cmd.before : cmd.after);
        break;
      }
      case 'prop-add':
        if (back) this._detachProp(cmd.prop.id); else this.props.push(cmd.prop);
        break;
      case 'prop-del':
        if (back) this.props.splice(Math.min(cmd.index, this.props.length), 0, cmd.prop);
        else this._detachProp(cmd.prop.id);
        break;
      case 'prop-move': {
        const p = this.prop(cmd.id);
        if (p) Object.assign(p, back ? cmd.before : cmd.after);
        break;
      }
    }
  }

  /* ── placed models ─────────────────────────────────────────────────── */

  _detachProp(id) {
    const i = this.props.findIndex((p) => p.id === id);
    if (i >= 0) this.props.splice(i, 1);
  }

  /**
   * A model is placed as a prop: the block column it stands on is snapped to the
   * grid, while the model keeps its own mesh, centred in the blocks it claims and
   * facing whichever quarter turn `rot` names.
   */
  addProp(prop) {
    prop.rot = prop.rot | 0;
    this.props.push(prop);
    this._commit({ kind: 'prop-add', prop });
  }

  removeProp(id) {
    const i = this.props.findIndex((p) => p.id === id);
    if (i < 0) return;
    const [prop] = this.props.splice(i, 1);
    this._commit({ kind: 'prop-del', prop, index: i });
  }

  prop(id) { return this.props.find((p) => p.id === id); }

  /**
   * Move and/or turn a placed model — one undoable step, or a piece of one while
   * a drag is open. `at` carries any of x, y, z and rot; the rest is kept.
   */
  moveProp(id, at) {
    const prop = this.prop(id);
    if (!prop) return false;
    const before = propState(prop);
    const after = {
      x: at.x ?? before.x,
      y: at.y ?? before.y,
      z: at.z ?? before.z,
      rot: at.rot ?? before.rot,
    };
    if (after.x === before.x && after.y === before.y && after.z === before.z && after.rot === before.rot) return false;
    Object.assign(prop, after);
    this.rev++;
    if (this.propDrag && this.propDrag.id === id) return true;   // folded in at endPropDrag
    this._commit({ kind: 'prop-move', id, before, after });
    return true;
  }

  /** Open a drag: every `moveProp` until `endPropDrag` becomes one undo step. */
  beginPropDrag(id) {
    const prop = this.prop(id);
    this.propDrag = prop ? { id, before: propState(prop) } : null;
  }

  endPropDrag() {
    const drag = this.propDrag;
    this.propDrag = null;
    if (!drag) return false;
    const prop = this.prop(drag.id);
    if (!prop) return false;
    const after = propState(prop);
    const { before } = drag;
    if (after.x === before.x && after.y === before.y && after.z === before.z && after.rot === before.rot) return false;
    this._commit({ kind: 'prop-move', id: drag.id, before, after });
    return true;
  }

  /* ── notes ─────────────────────────────────────────────────────────── */

  note(id) { return this.notes.find((n) => n.id === id); }

  _detach(id) {
    const i = this.notes.findIndex((n) => n.id === id);
    if (i >= 0) this.notes.splice(i, 1);
  }

  addNote(note) {
    this.notes.push(note);
    this._commit({ kind: 'note-add', note });
  }

  removeNote(id) {
    const i = this.notes.findIndex((n) => n.id === id);
    if (i < 0) return;
    const [note] = this.notes.splice(i, 1);
    this._commit({ kind: 'note-del', note, index: i });
  }

  /** Patch a note (html / colour / anchor) as one undoable step. */
  patchNote(id, patch) {
    const n = this.note(id);
    if (!n) return;
    const before = {};
    for (const k of Object.keys(patch)) before[k] = n[k];
    Object.assign(n, patch);
    this._commit({ kind: 'note-patch', id, before, after: { ...patch } });
  }

  /* ── harness tiles ─────────────────────────────────────────────────── */

  chat(id) { return this.chats.find((c) => c.id === id); }

  _detachChat(id) {
    const i = this.chats.findIndex((c) => c.id === id);
    if (i >= 0) this.chats.splice(i, 1);
  }

  addChat(chat) {
    this.chats.push(chat);
    this._commit({ kind: 'chat-add', chat });
  }

  removeChat(id) {
    const i = this.chats.findIndex((c) => c.id === id);
    if (i < 0) return;
    const [chat] = this.chats.splice(i, 1);
    this._commit({ kind: 'chat-del', chat, index: i });
  }

  /** Move or resize a harness tile as one undoable step. */
  patchChat(id, patch) {
    const c = this.chat(id);
    if (!c) return;
    const before = {};
    for (const k of Object.keys(patch)) before[k] = c[k];
    Object.assign(c, patch);
    this._commit({ kind: 'chat-patch', id, before, after: { ...patch } });
  }

  /* ── persistence ───────────────────────────────────────────────────── */

  serialize() {
    const voxels = [];
    for (const chunk of this.chunks.values()) {
      const bx = chunk.cx * CHUNK;
      const by = chunk.cy * CHUNK;
      for (const [lk, mat] of chunk.data) {
        voxels.push([bx + (lk & 15), by + ((lk >> 4) & 15), lk >>> 8, mat]);
      }
    }
    return {
      version: 4,
      voxels,
      notes: this.notes.map((n) => ({ id: n.id, x: n.x, y: n.y, w: n.w, h: n.h, color: n.color, fs: n.fs, html: n.html })),
      chats: this.chats.map((c) => ({ id: c.id, x: c.x, y: c.y, w: c.w, h: c.h, color: c.color, fs: c.fs })),
      props: this.props.map((p) => ({ id: p.id, model: p.model, x: p.x, y: p.y, z: p.z, rot: p.rot | 0 })),
    };
  }

  load(data) {
    this.chunks.clear();
    this.tops.clear();
    this.notes.length = 0;
    this.chats.length = 0;
    this.props.length = 0;
    this.undoStack.length = 0;
    this.redoStack.length = 0;
    this.stroke = null;
    this.count = 0;
    for (const [x, y, z, mat] of data.voxels || []) this.set(x, y, z, mat);
    for (const n of data.notes || []) this.notes.push(normalizeNote(n));
    for (const c of data.chats || []) this.chats.push(normalizeChat(c));
    // Unknown model ids are kept: the renderer simply skips them, which beats
    // silently dropping someone's work on load.
    for (const p of data.props || []) {
      if (!p || typeof p.model !== 'string') continue;
      this.props.push({
        id: p.id || uid(),
        model: p.model,
        x: Math.round(Number(p.x) || 0),
        y: Math.round(Number(p.y) || 0),
        z: Math.round(Number(p.z) || 0),
        rot: ((Math.round(Number(p.rot) || 0) % 4) + 4) % 4,
      });
    }
    this.rev++;
  }
}

export const NOTE_MIN = 1;
export const NOTE_MAX = 16;
export const NOTE_NEW = { w: 6, h: 4 };

// Harness tiles: a chat needs more room than a post-it for the stream to read.
// They carry the same per-tile knobs as a note — a footprint, a preview text
// size and a cycled colour — so the world view reads as one family of tiles.
export const CHAT_NEW = { w: 9, h: 6 };
export const CHAT_PAPER = ['#151b24', '#1e2440', '#0f2a24', '#33191d', '#2b1e3d', '#2e2a12'];

// Preview text size, in tile-local px (NOTE_U per block). The default is small
// on purpose: a tile is a post-it, and the `−`/`+` buttons in its toolbar trade
// how much fits against how big it reads. The range is deliberately wide — 3 px
// fits a wall of text on a small tile, 40 px is a single shouted line.
export const FS_MIN = 3;
export const FS_MAX = 40;
export const FS_DEFAULT = 9;
export const FS_STEP = 1;

const blocks = (v, fallback) => {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(NOTE_MAX, Math.max(NOTE_MIN, n));
};

/** A note's preview text size, clamped to the range the buttons can reach. */
export const clampFs = (v) => {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return FS_DEFAULT;
  return Math.min(FS_MAX, Math.max(FS_MIN, n));
};

/**
 * Notes are a w*h block tile lying on the surface. Stored revisions before v2
 * kept a floating pin (fractional centre x/y plus an explicit z), so those are
 * converted to the corner cell and given a tile size.
 */
export function normalizeNote(raw) {
  const legacy = raw.w === undefined || raw.h === undefined;
  return {
    id: raw.id || uid(),
    x: legacy ? Math.round((Number(raw.x) || 0) - 0.5) : Math.round(Number(raw.x) || 0),
    y: legacy ? Math.round((Number(raw.y) || 0) - 0.5) : Math.round(Number(raw.y) || 0),
    w: legacy ? 6 : blocks(raw.w, NOTE_NEW.w),
    h: legacy ? 4 : blocks(raw.h, NOTE_NEW.h),
    color: Number(raw.color) | 0,
    fs: clampFs(raw.fs),
    html: raw.html || '',
  };
}

/**
 * A harness tile is just a footprint: its conversation lives in the omp session
 * keyed by its id (under `.island/harness/<id>/` on the dev server), so a save
 * only has to remember where the tile sits.
 */
export function normalizeChat(raw) {
  return {
    id: raw.id || uid(),
    x: Math.round(Number(raw.x) || 0),
    y: Math.round(Number(raw.y) || 0),
    w: blocks(raw.w, CHAT_NEW.w),
    h: blocks(raw.h, CHAT_NEW.h),
    color: Number(raw.color) | 0,
    fs: clampFs(raw.fs),
  };
}

let seq = 0;
export function uid() {
  seq += 1;
  return 'n' + Date.now().toString(36) + seq.toString(36);
}

/** A small stepped island so a fresh canvas is not just empty space. */
export function seedStarter(world) {
  const put = (x, y, z, mat) => world.set(x, y, z, mat);

  for (let x = -5; x <= 5; x++) {
    for (let y = -5; y <= 5; y++) {
      const d = Math.max(Math.abs(x), Math.abs(y));
      if (d > 5) continue;
      const edge = d === 5;
      put(x, y, 0, edge ? 3 : 0);
    }
  }
  for (let x = -3; x <= 3; x++) {
    for (let y = -3; y <= 3; y++) {
      if (Math.max(Math.abs(x), Math.abs(y)) > 3) continue;
      put(x, y, 1, 0);
    }
  }
  for (let x = -1; x <= 1; x++) {
    for (let y = -1; y <= 1; y++) {
      if (Math.max(Math.abs(x), Math.abs(y)) > 1) continue;
      put(x, y, 2, 2);
    }
  }
  put(4, -4, 1, 4);
  put(4, -4, 2, 4);
  put(-4, 4, 1, 2);
  put(-4, 4, 2, 6);

  world.notes.push({
    id: uid(),
    x: 6, y: -2, w: 10, h: 5,
    color: 0,
    fs: FS_DEFAULT,
    html:
      '<p><b>Welcome.</b> Shift+click to stick a note on any block.</p>' +
      '<p>B build · D dig · P paint · drag a corner to resize.</p>',
  });
}
