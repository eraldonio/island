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
];

export const PAPER = ['#ffe08a', '#ffc9d6', '#c4e2ff', '#c9f0c0', '#e0ccff', '#f4f1e8'];

const ckey = (cx, cy) => cx + ':' + cy;
const tkey = (x, y) => x + ',' + y;
const lkey = (x, y, z) => (x & 15) | ((y & 15) << 4) | (z << 8);

export class World {
  constructor() {
    this.chunks = new Map();   // "cx:cy" -> { cx, cy, data: Map<localKey, matId> }
    this.tops = new Map();     // "x,y"   -> highest z (for column ops)
    this.notes = [];
    this.undoStack = [];
    this.redoStack = [];
    this.stroke = null;
    this.count = 0;
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
    return true;
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
  }

  canUndo() { return this.undoStack.length > 0; }
  canRedo() { return this.redoStack.length > 0; }

  undo() {
    const cmd = this.undoStack.pop();
    if (!cmd) return false;
    this._run(cmd, 'undo');
    this.redoStack.push(cmd);
    return true;
  }

  redo() {
    const cmd = this.redoStack.pop();
    if (!cmd) return false;
    this._run(cmd, 'redo');
    this.undoStack.push(cmd);
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
    }
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
      version: 1,
      voxels,
      notes: this.notes.map((n) => ({ id: n.id, x: n.x, y: n.y, z: n.z, color: n.color, html: n.html })),
    };
  }

  load(data) {
    this.chunks.clear();
    this.tops.clear();
    this.notes.length = 0;
    this.undoStack.length = 0;
    this.redoStack.length = 0;
    this.stroke = null;
    this.count = 0;
    for (const [x, y, z, mat] of data.voxels || []) this.set(x, y, z, mat);
    for (const n of data.notes || []) {
      this.notes.push({
        id: n.id || uid(),
        x: n.x,
        y: n.y,
        z: n.z,
        color: n.color | 0,
        html: n.html || '',
      });
    }
  }
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
    x: 0.5, y: 0.5, z: 3,
    color: 0,
    html:
      '<h3>Hello 👋</h3>' +
      '<p>This is your island. <b>Drag</b> the world to pan forever, ' +
      '<b>B</b> to build, <b>D</b> to dig.</p>' +
      '<p>Hold <code>Shift</code> and click anywhere to drop a note.</p>',
  });
}
