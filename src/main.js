// Wiring: camera, input, tools, editor modal, status, autosave.

import { World, PALETTE, PAPER, CHAT_PAPER, seedStarter, uid, NOTE_NEW, FS_DEFAULT, clampFs, CHAT_NEW } from './world.js';
import { Renderer } from './render.js';
import { Notes, sanitizeHtml } from './notes.js';
import { Harnesses, ChatWindow } from './harness.js';
import { dropSession, dropAllSessions, setHostTools, setHostToolRunner } from './omp.js';
import { HOST_TOOLS, bindHostTools, runHostTool } from './hosttools.js';
import { raycast, unproject, viewOf, ISO, Z_MAX, SPIN0, TILT0, TILT_MAX } from './iso.js';
import { targetsFor, BRUSHES } from './tools.js';
import { Gallery, IslandGallery } from './gallery.js';
import { islandScene, islandParts } from './islands.js';
import { MODELS, modelSize } from './models.js';
import { DEFAULT_BG, applyBackground } from './theme.js';
import * as store from './store.js';

const MODELS_BY_ID = new Map(MODELS.map((m) => [m.id, m]));

const $ = (id) => document.getElementById(id);
const canvas = $('stage');

const world = new World();
const renderer = new Renderer(canvas, world);
const cam = renderer.cam;
const state = { tool: 'build', mat: 0, brush: 1, space: false };

let hover = null;        // voxel pick under the cursor (or null)
let hoverProp = null;    // placed model under the cursor (move tool)
let propDrag = null;     // { id, ox, oy, at } while a model is being dragged
let pointerAt = { x: 0, y: 0 };   // last client point, for key-driven actions
let frameHandle = 0;
let saveTimer = 0;
let editing = null;      // { id, before } while the modal editor is open

/* ── notes layer ─────────────────────────────────────────────────────── */

/** Restores the pre-drag values so patchNote can record a single undo step. */
function commitNote(id, before, after) {
  const n = world.note(id);
  if (!n) return;
  let changed = false;
  for (const k of Object.keys(after)) if (before[k] !== after[k]) changed = true;
  if (!changed) { invalidate(); return; }
  Object.assign(n, before);
  world.patchNote(id, after);
  invalidate();
  requestSave();
}

const notes = new Notes($('notes-layer'), world, {
  cam: () => cam,
  pickAt: (cx, cy) => pickAt(cx, cy),
  onGhost: () => invalidate(),
  onDragStart: () => { hover = null; },
  onDrop: (id, before, after) => commitNote(id, before, after),
  onResize: () => invalidate(),
  onResizeEnd: (id, before, after) => commitNote(id, before, after),
  onCycleColor: (id) => {
    const n = world.note(id);
    if (!n) return;
    world.patchNote(id, { color: (n.color + 1) % PAPER.length });
    // The paper is drawn on the canvas, so the new colour only shows once a
    // frame runs — without this the tile keeps the old colour until some other
    // event (a pointer move off the toolbar, say) happens to repaint.
    invalidate();
    requestSave();
  },
  onFontSize: (id, delta) => {
    const n = world.note(id);
    if (!n) return;
    const fs = clampFs(clampFs(n.fs) + delta);
    if (fs === clampFs(n.fs)) return;
    world.patchNote(id, { fs });
    invalidate();
    requestSave();
  },
  onExpand: (id) => openEditor(id),
  onDelete: (id) => { world.removeNote(id); invalidate(); requestSave(); },
  onFocusNote: () => { hover = null; },
  onTextEdit: (id, before, after) => {
    const clean = sanitizeHtml(after);
    if (clean === before) return;
    world.patchNote(id, { html: clean });
    requestSave();
  },
});

/* ── harness tiles and chat window ───────────────────────────────────── */

/** One undoable step for a tile move or resize (mirrors commitNote). */
function commitChat(id, before, after) {
  const c = world.chat(id);
  if (!c) return;
  let changed = false;
  for (const k of Object.keys(after)) if (before[k] !== after[k]) changed = true;
  if (!changed) { invalidate(); return; }
  Object.assign(c, before);
  world.patchChat(id, after);
  invalidate();
  requestSave();
}

const chats = new Harnesses($('chats-layer'), world, {
  cam: () => cam,
  pickAt: (cx, cy) => pickAt(cx, cy),
  onOpen: (id) => chatWindow.open(id),
  onFocusChat: () => { hover = null; },
  onResize: () => invalidate(),
  onResizeEnd: (id, before, after) => commitChat(id, before, after),
  onDrop: (id, before, after) => commitChat(id, before, after),
  onDelete: (id) => deleteChat(id),
  onCycleColor: (id) => {
    const c = world.chat(id);
    if (!c) return;
    world.patchChat(id, { color: (c.color + 1) % CHAT_PAPER.length });
    // The slab is drawn on the canvas, so the new colour only shows once a
    // frame runs.
    invalidate();
    requestSave();
  },
  onFontSize: (id, delta) => {
    const c = world.chat(id);
    if (!c) return;
    const fs = clampFs(clampFs(c.fs) + delta);
    if (fs === clampFs(c.fs)) return;
    world.patchChat(id, { fs });
    invalidate();
    requestSave();
  },
});

const chatWindow = new ChatWindow($('chat'), {
  chat: (id) => world.chat(id),
  onClose: () => { invalidate(); requestSave(); },
});

/** Place a new harness tile: one undoable edit, then open its chat. */
function createChat(hit) {
  if (!hit) return;
  const { w, h } = CHAT_NEW;
  const chat = {
    id: uid(),
    x: hit.x - ((w - 1) >> 1),
    y: hit.y - ((h - 1) >> 1),
    w, h,
    color: 0,
    fs: FS_DEFAULT,
  };
  world.addChat(chat);
  setTool('pan');
  invalidate();
  requestSave();
  requestAnimationFrame(() => chatWindow.open(chat.id));
}

/** Remove a tile and let its omp process go; undo brings both back. */
function deleteChat(id) {
  if (chatWindow.isOpen && chatWindow.chat && chatWindow.chat.id === id) chatWindow.close();
  world.removeChat(id);
  dropSession(id);
  invalidate();
  requestSave();
}

/**
 * Take a note off the island the way the note's own `×` does. A harness can ask
 * for this (island_remove), so the modal editor's copy of the text is dropped
 * without writing back — the note it belongs to is going away.
 */
function deleteNote(id) {
  if (editing && editing.id === id) {
    editing = null;
    $('editor').hidden = true;
    if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
  }
  notes.setEditing(id, false);
  world.removeNote(id);
  invalidate();
  requestSave();
}

/* ── picking ─────────────────────────────────────────────────────────── */

// Notes decide their own hover state from the pointer, because their toolbar
// and handles live outside the paper quad.
window.addEventListener('pointermove', (e) => {
  notes.remember(e.clientX, e.clientY);
  notes.hoverAt(e.clientX, e.clientY);
  chats.hoverAt(e.clientX, e.clientY);
}, { passive: true });

const solid = (x, y, z) => world.get(x, y, z) !== undefined;

/**
 * @param {Map<string, number|undefined>} [override] cells to read from their
 *   pre-stroke state instead of the live world, so a drag picks against the
 *   terrain as it was before the stroke rather than against what it has just
 *   built.
 */
function pickAt(clientX, clientY, override) {
  const r = canvas.getBoundingClientRect();
  const iso = renderer.toIso(clientX - r.left, clientY - r.top);
  const solid = override
    ? (x, y, z) => {
      const k = x + ',' + y + ',' + z;
      if (override.has(k)) return override.get(k) !== undefined;
      return world.get(x, y, z) !== undefined;
    }
    : (x, y, z) => world.get(x, y, z) !== undefined;
  return raycast(iso.ix, iso.iy, solid, cam.view || ISO);
}

function hexA(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

/** Ghost preview for the active tool, or the tile a new note would occupy. */
function ghostVisual(hit) {
  if (!hit) return null;
  const outline = 'rgba(255,255,255,0.6)';

  if (state.tool === 'stamp') {
    const t = stampTarget(hit);
    // Show the blocks the model claims, since that is what placement snaps to.
    return {
      hit,
      cells: [],
      tile: { x: t.x, y: t.y, w: t.size.w, h: t.size.h, level: t.z },
      fill: 'rgba(255,255,255,0.22)',
      outline,
      cursor: null,
    };
  }

  if (state.tool === 'island') {
    // The whole footprint the island claims, on the level its base plate lands
    // on — the same blocks the stamp will take.
    const t = islandTarget(hit);
    return t
      ? { hit, cells: [], tile: { x: t.x, y: t.y, w: t.w, h: t.h, level: t.z }, fill: 'rgba(120,220,255,0.20)', outline, cursor: null }
      : { hit, cells: [], tile: null, fill: 'rgba(255,255,255,0.22)', outline, cursor: { x: hit.x, y: hit.y, z: hit.z, flat: hit.ground } };
  }

  if (state.tool === 'grab') {
    // The model being dragged, or the one under the cursor: either way the ghost
    // is the footprint it claims, which is what it snaps to.
    const prop = (propDrag && world.prop(propDrag.id)) || hoverProp;
    const model = prop && MODELS_BY_ID.get(prop.model);
    if (prop && model) {
      const size = modelSize(model, prop.rot | 0);
      return {
        hit,
        cells: [],
        tile: { x: prop.x, y: prop.y, w: size.w, h: size.h, level: prop.z },
        fill: 'rgba(255,255,255,0.30)',
        outline,
        cursor: null,
      };
    }
    return {
      hit,
      cells: [],
      tile: null,
      fill: 'rgba(255,255,255,0.22)',
      outline,
      cursor: { x: hit.x, y: hit.y, z: hit.z, flat: hit.ground },
    };
  }

  if (state.tool === 'note') {
    const { w, h } = NOTE_NEW;
    const tile = {
      x: hit.x - ((w - 1) >> 1),
      y: hit.y - ((h - 1) >> 1),
      w, h,
    };
    tile.level = world.surfaceUnder(tile.x, tile.y, tile.w, tile.h);
    return { hit, cells: [], tile, fill: 'rgba(255,214,102,0.34)', outline, cursor: null };
  }

  if (state.tool === 'harness') {
    const { w, h } = CHAT_NEW;
    const tile = {
      x: hit.x - ((w - 1) >> 1),
      y: hit.y - ((h - 1) >> 1),
      w, h,
    };
    tile.level = world.surfaceUnder(tile.x, tile.y, tile.w, tile.h);
    return { hit, cells: [], tile, fill: 'rgba(86,217,160,0.26)', outline, cursor: null };
  }

  const cells = targetsFor(world, hit, state.tool, state.brush);
  const fill = state.tool === 'dig' ? 'rgba(255,90,80,0.35)'
    : state.tool === 'paint' ? 'rgba(255,255,255,0.30)'
      : hexA(PALETTE[state.mat].color, 0.38);
  // A click on bare ground targets the ground cell itself, so the cursor
  // marker is a flat rhombus on the plane rather than a cube.
  const cursor = hit.ground
    ? { x: hit.x, y: hit.y, z: 0, flat: true }
    : { x: hit.x, y: hit.y, z: hit.z, flat: false };
  return { hit, cells, tile: null, fill, outline, cursor };
}

/* ── frame loop ──────────────────────────────────────────────────────── */

function invalidate() {
  if (!frameHandle) frameHandle = requestAnimationFrame(frame);
}

function frame() {
  frameHandle = 0;
  renderer.hover = ghostVisual(hover);
  renderer.render();
  notes.sync(cam);
  chats.sync(cam);
  updateStatus();
}

/* ── editor modal ────────────────────────────────────────────────────── */

function placeCaretEnd(el) {
  const r = document.createRange();
  r.selectNodeContents(el);
  r.collapse(false);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(r);
}

function renderPapers(active) {
  const box = $('editor-papers');
  box.textContent = '';
  PAPER.forEach((color, i) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.title = 'Paper ' + (i + 1);
    b.style.background = color;
    if (i === active) b.classList.add('active');
    b.addEventListener('click', () => {
      if (!editing) return;
      world.patchNote(editing.id, { color: i });
      const note = world.note(editing.id);
      const el = notes.element(editing.id);
      if (note && el) el.style.setProperty('--paper', PAPER[note.color % PAPER.length]);
      document.querySelector('.editor').style.setProperty('--paper', PAPER[i]);
      renderPapers(i);
      requestSave();
    });
    box.appendChild(b);
  });
}

function openEditor(id) {
  const note = world.note(id);
  if (!note) return;
  editing = { id, before: note.html || '' };
  notes.setEditing(id, true);
  const paper = PAPER[((note.color | 0) % PAPER.length + PAPER.length) % PAPER.length];
  $('editor').hidden = false;
  document.querySelector('.editor').style.setProperty('--paper', paper);
  const body = $('editor-body');
  body.innerHTML = note.html || '<p><br></p>';
  try {
    document.execCommand('defaultParagraphSeparator', false, 'p');
  } catch { /* not fatal */ }
  renderPapers(note.color);
  body.focus();
  placeCaretEnd(body);
}

function closeEditor() {
  if (!editing) return;
  const body = $('editor-body');
  const clean = sanitizeHtml(body.innerHTML);
  const { id, before } = editing;
  editing = null;
  $('editor').hidden = true;
  if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
  if (clean !== before) world.patchNote(id, { html: clean });
  notes.setEditing(id, false);
  invalidate();
  requestSave();
}

function exec(cmd, val) {
  // Inline CSS is only wanted for colour commands: everything else should
  // produce real tags so the sanitizer keeps meaning, not just looks.
  try {
    document.execCommand('styleWithCSS', false, cmd === 'foreColor' || cmd === 'hiliteColor');
    document.execCommand(cmd, false, val);
  } catch (err) {
    console.warn('[island] command failed', cmd, err);
  }
}

/* ── sculpting ───────────────────────────────────────────────────────── */

let mode = null;          // null | 'pan' | 'orbit' | 'sculpt'
let pan = null;
let orbit = null;         // { x, y, spin, tilt } while a middle-drag orbits

// Degrees of spin/tilt per pixel dragged with the middle button.
const ORBIT_SPEED = 0.4;
let strokeKeys = null;    // voxel cells this stroke has already touched
let strokeColumns = null; // "x,y" columns this stroke has already acted on
let strokeUndo = null;    // "x,y,z" -> what was there before this stroke touched it
let strokeAt = null;      // client point of the last action
const pointers = new Map();
let pinch = null;

function startSculpt(e) {
  canvas.setPointerCapture(e.pointerId);
  mode = 'sculpt';
  strokeKeys = new Set();
  strokeColumns = new Set();
  strokeUndo = new Map();
  strokeAt = null;
  world.beginStroke();
  sculptAt(e);
}

/**
 * One action per block the stroke reaches, and every pick is made against the
 * terrain as it was before the stroke started.
 *
 * Without that, a drag climbs: the cells the stroke has just placed become the
 * topmost thing under the cursor, so the next pick targets the cell above them.
 * It is worst with the 3x3 and 5x5 brushes, where the cursor sits over the middle
 * of the patch it just made and the footprint walks up its own side. A column
 * already acted on is skipped too, and a small dead zone absorbs jitter along a
 * cell boundary.
 */
function sculptAt(e) {
  const hit = pickAt(e.clientX, e.clientY, strokeUndo);
  hover = hit;

  const column = hit.x + ',' + hit.y;
  if (strokeColumns.has(column)) { invalidate(); return; }
  if (strokeAt) {
    const dx = e.clientX - strokeAt.x;
    const dy = e.clientY - strokeAt.y;
    if (dx * dx + dy * dy < 9) { invalidate(); return; }
  }
  strokeColumns.add(column);
  strokeAt = { x: e.clientX, y: e.clientY };

  const cells = targetsFor(world, hit, state.tool, state.brush);
  const fresh = [];
  for (const c of cells) {
    const k = c.x + ',' + c.y + ',' + c.z;
    if (strokeKeys.has(k)) continue;
    strokeKeys.add(k);
    if (!strokeUndo.has(k)) strokeUndo.set(k, world.get(c.x, c.y, c.z));
    fresh.push(c);
  }
  if (fresh.length) {
    const dig = state.tool === 'dig';
    world.apply(fresh.map((c) => ({ x: c.x, y: c.y, z: c.z, mat: dig ? null : state.mat })));
  }
  invalidate();
}

function finishStroke(save) {
  if (mode === 'sculpt') {
    world.endStroke();
    strokeKeys = null;
    strokeColumns = null;
    strokeUndo = null;
    strokeAt = null;
    if (save) requestSave();
  }
  mode = null;
}

/* ── placed models ───────────────────────────────────────────────────── */

let gallery = null;
let islandsPanel = null;
let setViewPanel = () => {};   // assigned in buildActions; Escape closes it

/**
 * The block column a click targets: the neighbour of the face it hit, so a model
 * placed against a wall stands beside it rather than inside it. A click on bare
 * ground targets the ground cell itself.
 */
function columnTarget(hit) {
  return {
    x: hit.ground ? hit.x : hit.x + hit.nx,
    y: hit.ground ? hit.y : hit.y + hit.ny,
  };
}

/**
 * Where a stamped model lands: the block column the click targets, with the
 * model's footprint centred on it and resting on its surface. The grid decides
 * the placement; the model keeps its own mesh, centred in the footprint it claims.
 */
function stampTarget(hit) {
  const model = gallery && gallery.model;
  const size = model ? modelSize(model) : { w: 1, h: 1, hz: 1 };
  const col = columnTarget(hit);
  return {
    size,
    x: col.x - ((size.w - 1) >> 1),
    y: col.y - ((size.h - 1) >> 1),
    z: world.surfaceUnder(col.x, col.y, 1, 1),
  };
}

/** Place the selected model: one undoable edit. */
function placeStamp(hit) {
  const model = gallery && gallery.model;
  if (!model) return;
  const t = stampTarget(hit);
  world.addProp({ id: uid(), model: model.id, x: t.x, y: t.y, z: t.z });
  invalidate();
  requestSave();
}

/**
 * Where the selected island lands: its footprint centred on the block column the
 * click targets, and its base plate at the level a block placed on that column
 * would take — the same rule a single model is placed by, so the column under the
 * cursor is the one that decides the height.
 */
function islandTarget(hit) {
  const island = islandsPanel && islandsPanel.island;
  if (!island) return null;
  const scene = islandScene(island);
  const col = columnTarget(hit);
  return {
    col,
    scene,
    x: col.x - ((scene.w - 1) >> 1),
    y: col.y - ((scene.h - 1) >> 1),
    w: scene.w,
    h: scene.h,
    z: world.surfaceUnder(col.x, col.y, 1, 1),
  };
}

/**
 * Stamp the selected island — its relief, the elements standing on it and its
 * notes — where the click landed. The whole place is one undoable step, and
 * nothing about it stays special once it is down: it is ordinary blocks, models
 * and notes, so they can be dug, painted, moved and saved like anything else.
 */
function placeIsland(hit) {
  const t = islandTarget(hit);
  if (!t) return;
  world.stamp(islandParts(t.scene, t.col.x, t.col.y, t.z));
  invalidate();
  requestSave();
}

/**
 * The placed model the pointer ray reaches first, if it is in front of the
 * terrain under the cursor. Ray/box slabs, compared against the terrain by the
 * same view-space depth the painter uses.
 */
function propAt(clientX, clientY) {
  if (!world.props.length) return null;
  const r = canvas.getBoundingClientRect();
  const view = cam.view || ISO;
  const iso = renderer.toIso(clientX - r.left, clientY - r.top);
  const start = unproject(iso.ix, iso.iy, Z_MAX + 1, view);
  const p = { x: start.x, y: start.y, z: Z_MAX + 1 };
  const len = Math.hypot(view.dx, view.dy, view.dz);
  const d = { x: -view.dx / len, y: -view.dy / len, z: -view.dz / len };

  let best = null;
  let bestT = Infinity;
  for (const prop of world.props) {
    const model = MODELS_BY_ID.get(prop.model);
    if (!model) continue;
    const s = modelSize(model, prop.rot | 0);
    const lo = { x: prop.x, y: prop.y, z: prop.z };
    const hi = { x: prop.x + s.w, y: prop.y + s.h, z: prop.z + s.hz };
    let t0 = 0;
    let t1 = Infinity;
    let ok = true;
    for (const axis of ['x', 'y', 'z']) {
      if (Math.abs(d[axis]) < 1e-9) {
        if (p[axis] < lo[axis] || p[axis] > hi[axis]) { ok = false; break; }
        continue;
      }
      let ta = (lo[axis] - p[axis]) / d[axis];
      let tb = (hi[axis] - p[axis]) / d[axis];
      if (ta > tb) { const tmp = ta; ta = tb; tb = tmp; }
      if (ta > t0) t0 = ta;
      if (tb < t1) t1 = tb;
      if (t0 > t1) { ok = false; break; }
    }
    if (ok && t0 < bestT) { bestT = t0; best = prop; }
  }
  if (!best) return null;

  const hit = pickAt(clientX, clientY);
  const depthOf = (x, y, z) => x * view.dx + y * view.dy + z * view.dz;
  const front = depthOf(p.x + d.x * bestT, p.y + d.y * bestT, p.z + d.z * bestT);
  return front >= depthOf(hit.x, hit.y, hit.z) - 1e-6 ? best : null;
}

/**
 * A model's footprint after a quarter turn, kept where it stands. The size delta
 * is halved *toward zero*, so the footprint's centre stays within half a block of
 * where it was and — because trunc(-a) === -trunc(a) — the same turn back lands
 * on exactly the block it started on. Four turns never walk a model. The level is
 * re-derived, because a turned footprint can cover different ground.
 */
function turned(model, prop, rot) {
  const from = modelSize(model, prop.rot | 0);
  const to = modelSize(model, rot);
  const x = prop.x + Math.trunc((from.w - to.w) / 2);
  const y = prop.y + Math.trunc((from.h - to.h) / 2);
  return { x, y, z: world.surfaceUnder(x, y, to.w, to.h), rot };
}

/** Turn the model under the cursor a quarter turn (the other way for dir -1). */
function rotatePropAt(clientX, clientY, dir) {
  const prop = propAt(clientX, clientY);
  if (!prop) return false;
  const model = MODELS_BY_ID.get(prop.model);
  if (!model) return false;
  const rot = ((prop.rot | 0) + dir + 4) & 3;
  if (!world.moveProp(prop.id, turned(model, prop, rot))) return false;
  invalidate();
  requestSave();
  return true;
}

/**
 * Pick a model up: remember the block offset between the cursor and the model's
 * footprint corner, so it keeps its place under the pointer instead of jumping
 * to it, and fold the whole drag into one undo step.
 */
function startPropDrag(e) {
  const prop = propAt(e.clientX, e.clientY);
  if (!prop) return false;
  const hit = pickAt(e.clientX, e.clientY);
  const col = columnTarget(hit);
  propDrag = { id: prop.id, ox: prop.x - col.x, oy: prop.y - col.y, at: prop.x + ',' + prop.y };
  world.beginPropDrag(prop.id);
  mode = 'grab';
  canvas.setPointerCapture(e.pointerId);
  canvas.classList.add('dragging');
  hoverProp = prop;
  return true;
}

/** One move per block the cursor enters, riding whatever surface it lands on. */
function dragPropAt(e) {
  const prop = world.prop(propDrag.id);
  const model = prop && MODELS_BY_ID.get(prop.model);
  if (!model) return;
  hover = pickAt(e.clientX, e.clientY);
  const col = columnTarget(hover);
  const x = col.x + propDrag.ox;
  const y = col.y + propDrag.oy;
  const key = x + ',' + y;
  if (key === propDrag.at) { invalidate(); return; }    // holding still moves nothing
  propDrag.at = key;
  const size = modelSize(model, prop.rot | 0);
  world.moveProp(prop.id, { x, y, z: world.surfaceUnder(x, y, size.w, size.h) });
  hoverProp = prop;
  invalidate();
}

function finishPropDrag(save) {
  if (mode !== 'grab') return;
  canvas.classList.remove('dragging');
  if (propDrag) {
    world.endPropDrag();
    propDrag = null;
    if (save) requestSave();
  }
  mode = null;
  invalidate();
}

function pinchState() {
  const [a, b] = [...pointers.values()];
  return {
    mx: (a.x + b.x) / 2,
    my: (a.y + b.y) / 2,
    dist: Math.hypot(a.x - b.x, a.y - b.y),
  };
}

/* ── pointer events ──────────────────────────────────────────────────── */

canvas.addEventListener('pointerdown', (e) => {
  if (editing) return;

  if (e.pointerType === 'touch') {
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 2) {
      finishStroke(true);
      finishPropDrag(true);
      pinch = pinchState();
      return;
    }
  }

  // The middle button orbits: horizontal drags take the world to any azimuth,
  // vertical drags raise or lower the camera, exactly like the spin/tilt
  // sliders (down pulls the view toward straight down). Panning keeps
  // Space+drag, right-drag, the pan tool and Shift+wheel.
  if (e.button === 1) {
    e.preventDefault();          // no middle-click autoscroll
    canvas.setPointerCapture(e.pointerId);
    mode = 'orbit';
    orbit = { x: e.clientX, y: e.clientY, spin: cam.spin, tilt: cam.tilt };
    canvas.classList.add('orbiting');
    return;
  }

  const wantsPan = e.button === 2 || state.space || state.tool === 'pan';
  if (wantsPan) {
    canvas.setPointerCapture(e.pointerId);
    mode = 'pan';
    pan = { x: e.clientX, y: e.clientY };
    canvas.classList.add('panning');
    return;
  }
  if (e.button !== 0) return;

  if (e.shiftKey || state.tool === 'note') {
    createNote(pickAt(e.clientX, e.clientY));
    return;
  }
  if (state.tool === 'harness') {
    createChat(pickAt(e.clientX, e.clientY));
    return;
  }
  if (state.tool === 'stamp') {
    placeStamp(pickAt(e.clientX, e.clientY));
    return;
  }
  if (state.tool === 'island') {
    placeIsland(pickAt(e.clientX, e.clientY));
    return;
  }
  if (state.tool === 'grab') {
    startPropDrag(e);
    return;
  }
  // Digging a placed model takes it away; undo brings it back.
  if (state.tool === 'dig') {
    const prop = propAt(e.clientX, e.clientY);
    if (prop) {
      world.removeProp(prop.id);
      invalidate();
      requestSave();
      return;
    }
  }
  startSculpt(e);
});

canvas.addEventListener('pointermove', (e) => {
  if (pointers.has(e.pointerId)) pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  pointerAt = { x: e.clientX, y: e.clientY };

  if (pinch && pointers.size === 2) {
    const now = pinchState();
    const r = canvas.getBoundingClientRect();
    if (pinch.dist > 8 && now.dist > 8) zoomAt(now.mx - r.left, now.my - r.top, now.dist / pinch.dist);
    cam.ox += now.mx - pinch.mx;
    cam.oy += now.my - pinch.my;
    pinch = now;
    notes.rehover();
    invalidate();
    return;
  }

  if (mode === 'orbit' && orbit) {
    setView(
      orbit.spin - (e.clientX - orbit.x) * ORBIT_SPEED,
      orbit.tilt + (e.clientY - orbit.y) * ORBIT_SPEED,
    );
    notes.rehover();
    return;
  }

  if (mode === 'pan' && pan) {
    cam.ox += e.clientX - pan.x;
    cam.oy += e.clientY - pan.y;
    pan = { x: e.clientX, y: e.clientY };
    notes.rehover();
    invalidate();
    return;
  }

  if (mode === 'sculpt') {
    sculptAt(e);
    return;
  }

  if (mode === 'grab') {
    dragPropAt(e);
    return;
  }

  hover = pickAt(e.clientX, e.clientY);
  hoverProp = state.tool === 'grab' ? propAt(e.clientX, e.clientY) : null;
  invalidate();
});

function onUp(e) {
  if (pointers.has(e.pointerId)) {
    pointers.delete(e.pointerId);
    if (pointers.size < 2) pinch = null;
  }
  if (mode === 'orbit') {
    mode = null;
    orbit = null;
    canvas.classList.remove('orbiting');
    requestSave();
    return;
  }
  if (mode === 'pan') {
    canvas.classList.remove('panning');
    mode = null;
    pan = null;
    requestSave();
    return;
  }
  if (mode === 'grab') {
    finishPropDrag(true);
    return;
  }
  if (mode === 'sculpt') {
    finishStroke(true);
    invalidate();
  }
}
canvas.addEventListener('pointerup', onUp);
canvas.addEventListener('pointercancel', onUp);
canvas.addEventListener('contextmenu', (e) => e.preventDefault());

/**
 * Whether the wheel belongs to something under the cursor rather than to the
 * camera: a panel that is actually scrollable (the model gallery, once the list
 * is longer than the screen) keeps its own scrolling, and a modal keeps its own
 * too. Everything else — the toolbar, the status bar, bare canvas, a note — is a
 * zoom.
 */
function wheelBelongsToPanel(target) {
  for (let el = target instanceof Element ? target : null; el; el = el.parentElement) {
    if (el.scrollHeight > el.clientHeight && /(auto|scroll)/.test(getComputedStyle(el).overflowY)) return true;
  }
  return false;
}

// Bound to the window so the wheel works even when the cursor is over a note
// tile; modals keep their own scrolling. Wheel zooms at the cursor, shift pans,
// and ctrl+wheel keeps working because trackpad pinch sends it.
window.addEventListener('wheel', (e) => {
  if (e.target.closest && e.target.closest('.backdrop')) return;
  if (wheelBelongsToPanel(e.target)) return;
  e.preventDefault();
  const r = canvas.getBoundingClientRect();
  if (e.shiftKey) {
    cam.ox -= e.deltaX;
    cam.oy -= e.deltaY;
    notes.rehover();
  } else {
    const step = e.deltaMode === 1 ? 0.06 : 0.0018;   // line-scroll vs pixel-scroll
    zoomAt(e.clientX - r.left, e.clientY - r.top, Math.exp(-e.deltaY * step));
  }
  invalidate();
}, { passive: false });

function zoomAt(px, py, factor) {
  const s0 = cam.scale;
  const s1 = Math.min(3, Math.max(0.2, s0 * factor));
  if (s1 === s0) return;
  cam.ox = px - (px - cam.ox) * (s1 / s0);
  cam.oy = py - (py - cam.oy) * (s1 / s0);
  cam.scale = s1;
  notes.rehover();
  invalidate();
}

/* ── notes ───────────────────────────────────────────────────────────── */

function createNote(hit) {
  if (!hit) return;
  const { w, h } = NOTE_NEW;
  const note = {
    id: uid(),
    x: hit.x - ((w - 1) >> 1),
    y: hit.y - ((h - 1) >> 1),
    w, h,
    color: 0,
    fs: FS_DEFAULT,
    html: '<p><br></p>',
  };
  world.addNote(note);
  // One note at a time is the common case: hand the pointer back to the pan
  // tool so the next drag moves the world instead of dropping another note.
  setTool('pan');
  invalidate();
  requestSave();
  requestAnimationFrame(() => notes.beginEdit(note.id));
}

/* ── toolbar / status ────────────────────────────────────────────────── */

const TOOL_LABEL = { build: 'Build', dig: 'Dig', paint: 'Paint', note: 'Note', pan: 'Pan', stamp: 'Place', island: 'Island', grab: 'Move', harness: 'Harness' };

function setText(el, str) {
  if (el.textContent !== str) el.textContent = str;
}

function setTool(tool) {
  state.tool = tool;
  for (const b of document.querySelectorAll('#tools .tbtn')) {
    b.classList.toggle('active', b.dataset.tool === tool);
  }
  canvas.classList.toggle('pan', tool === 'pan');
  canvas.classList.toggle('grab', tool === 'grab');
  if (tool !== 'grab') {
    if (propDrag) finishPropDrag(true);   // a tool switch ends a drag, as it commits it
    hoverProp = null;
  }
  if (gallery) gallery.show(tool === 'stamp');
  if (islandsPanel) islandsPanel.show(tool === 'island');
  invalidate();
}

function setMat(i) {
  state.mat = i;
  for (const b of document.querySelectorAll('#swatches .swatch')) {
    b.classList.toggle('active', Number(b.dataset.mat) === i);
  }
  invalidate();
}

/** Step the material through the whole palette — the ones past `9` included. */
function stepMat(dir) {
  setMat((state.mat + dir + PALETTE.length) % PALETTE.length);
}

function setBrush(n) {
  state.brush = n;
  for (const b of document.querySelectorAll('#brushes .brush')) {
    b.classList.toggle('active', Number(b.dataset.brush) === n);
  }
  invalidate();
}

function buildToolbar() {
  for (const b of document.querySelectorAll('#tools .tbtn')) {
    b.addEventListener('click', () => setTool(b.dataset.tool));
  }

  const sw = $('swatches');
  PALETTE.forEach((p, i) => {
    const b = document.createElement('button');
    b.className = 'swatch';
    b.dataset.mat = String(i);
    b.title = i < 9 ? `${p.name} (${i + 1})` : p.name;
    b.style.background = p.color;
    b.addEventListener('click', () => setMat(i));
    sw.appendChild(b);
  });

  const br = $('brushes');
  for (const n of BRUSHES) {
    const b = document.createElement('button');
    b.className = 'brush';
    b.dataset.brush = String(n);
    b.title = `${n}×${n} brush`;
    b.textContent = String(n);
    b.addEventListener('click', () => setBrush(n));
    br.appendChild(b);
  }

  setTool(state.tool);
  setMat(state.mat);
  setBrush(state.brush);
}

function updateStatus() {
  setText($('st-tool'), TOOL_LABEL[state.tool]);
  setText($('st-mat'), PALETTE[state.mat].name);
  setText($('st-brush'), `${state.brush}×${state.brush}`);
  setText($('st-pos'), hover ? `${hover.x}, ${hover.y} · h ${hover.ground ? 0 : hover.z + 1}` : '–');
  const nb = world.count;
  const nn = world.notes.length;
  const nc = world.chats.length;
  let counts = `${nb} block${nb === 1 ? '' : 's'} · ${nn} note${nn === 1 ? '' : 's'}`;
  if (nc) counts += ` · ${nc} harness${nc === 1 ? '' : 'es'}`;
  setText($('st-count'), counts);
  setText($('st-zoom'), Math.round(cam.scale * 100) + '%');
  $('a-undo').disabled = !world.canUndo();
  $('a-redo').disabled = !world.canRedo();
}

/* ── actions ─────────────────────────────────────────────────────────── */

/**
 * Point the camera: spin is the azimuth in degrees (any angle) and tilt the
 * elevation, from nearly edge-on to straight down. Straight down with spin 0
 * puts the world axes square on screen, which is where note writing reads
 * head-on.
 */
function setView(spin, tilt) {
  cam.spin = Number.isFinite(+spin) ? +spin : cam.spin;
  cam.tilt = Number.isFinite(+tilt) ? +tilt : cam.tilt;
  cam.view = viewOf(cam.spin, cam.tilt);
  const v = cam.view;
  const si = $('a-spin');
  if (si && document.activeElement !== si) si.value = String(Math.round(v.spin));
  const ti = $('a-tilt');
  if (ti && document.activeElement !== ti) ti.value = String(Math.round(v.tilt));
  const so = $('a-spin-val');
  if (so) so.textContent = `${Math.round(v.spin)}°`;
  const to = $('a-tilt-val');
  if (to) to.textContent = `${Math.round(v.tilt)}°`;
  const face = $('a-face');
  if (face) face.classList.toggle('active', v.tilt >= TILT_MAX - 0.5 && v.spin < 0.5);
  invalidate();
}

/** Preset: the isometric look, or straight down facing the notes. */
function toggleView() {
  const v = cam.view;
  if (v && v.tilt >= TILT_MAX - 0.5 && v.spin < 0.5) setView(SPIN0, TILT0);
  else setView(0, TILT_MAX);
}

/** Restore a saved camera, including the angles (and the older single slider). */
function applyCamera(c) {
  if (!c || !Number.isFinite(c.scale)) return false;
  cam.ox = c.ox;
  cam.oy = c.oy;
  cam.scale = c.scale;
  let spin = Number.isFinite(c.spin) ? c.spin : SPIN0;
  let tilt = Number.isFinite(c.tilt) ? c.tilt : TILT0;
  if (tilt <= 1) {                    // v2 saves stored the 0..1 blend
    tilt = TILT0 + (TILT_MAX - TILT0) * Math.max(0, Math.min(1, tilt));
    spin = SPIN0;
  }
  setView(spin, tilt);
  return true;
}

function fitView() {
  cam.scale = 1;
  cam.ox = window.innerWidth / 2;
  cam.oy = window.innerHeight / 2 + 60;
  invalidate();
}

/**
 * Repaint the backdrop and keep the choice — the one path the swatch, its reset
 * and the console share, so what is stored is always what is on screen.
 */
function setBackground(hex) {
  const color = applyBackground(hex);
  $('a-bg').value = color;
  store.saveUI({ background: color });
  invalidate();
  return color;
}

function requestSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => store.save(world, cam), 500);
}

function closeModals() {
  if (editing) closeEditor();
  if (chatWindow.isOpen) chatWindow.close();
  $('help').hidden = true;
  setViewPanel(false);
}

function buildActions() {
  $('a-undo').addEventListener('click', () => { world.undo(); invalidate(); requestSave(); });
  $('a-redo').addEventListener('click', () => { world.redo(); invalidate(); requestSave(); });
  $('a-zin').addEventListener('click', () => zoomAt(canvas.clientWidth / 2, canvas.clientHeight / 2, 1.2));
  $('a-zout').addEventListener('click', () => zoomAt(canvas.clientWidth / 2, canvas.clientHeight / 2, 1 / 1.2));
  $('a-view').addEventListener('click', fitView);

  // The camera angle and the backdrop live in their own panel, opened by the
  // sliders button; a click anywhere else or Escape puts it away again.
  const viewPanel = $('viewpanel');
  const camBtn = $('a-cam');
  setViewPanel = (open) => {
    viewPanel.hidden = !open;
    camBtn.classList.toggle('active', open);
    camBtn.setAttribute('aria-expanded', String(open));
  };
  camBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    setViewPanel(viewPanel.hidden);
  });
  window.addEventListener('pointerdown', (e) => {
    if (viewPanel.hidden) return;
    if (viewPanel.contains(e.target) || camBtn.contains(e.target)) return;
    setViewPanel(false);
  }, true);
  $('a-face').addEventListener('click', toggleView);

  const spin = $('a-spin');
  spin.addEventListener('input', () => setView(Number(spin.value), cam.tilt));
  spin.addEventListener('change', () => requestSave());
  const tilt = $('a-tilt');
  tilt.addEventListener('input', () => setView(cam.spin, Number(tilt.value)));
  tilt.addEventListener('change', () => requestSave());
  setView(cam.spin, cam.tilt);

  // Background: the sky is a preference rather than part of the world, so it is
  // stored apart from it and never exported. The preview follows the colour
  // dialog live; the value is only remembered once it closes.
  const bg = $('a-bg');
  const prefs = store.loadUI();
  bg.value = applyBackground(prefs && prefs.background);
  bg.addEventListener('input', () => { applyBackground(bg.value); invalidate(); });
  bg.addEventListener('change', () => setBackground(bg.value));
  $('a-bg-reset').addEventListener('click', () => setBackground(DEFAULT_BG));
  $('a-help').addEventListener('click', () => { $('help').hidden = false; });
  $('help-done').addEventListener('click', () => { $('help').hidden = true; });

  $('a-export').addEventListener('click', () => store.download(world, cam));

  const file = $('import-file');
  $('a-import').addEventListener('click', () => file.click());
  file.addEventListener('change', async () => {
    const f = file.files && file.files[0];
    file.value = '';
    if (!f) return;
    try {
      const data = await store.readFile(f);
      if (!confirm(`Replace the current world with "${f.name}" (${data.voxels.length} blocks, ${(data.notes || []).length} notes)?`)) return;
      dropAllSessions();
      world.load(data);
      if (!applyCamera(data.camera)) fitView();
      invalidate();
      requestSave();
    } catch (err) {
      alert('Could not read that file: ' + err.message);
    }
  });

  $('a-reset').addEventListener('click', () => {
    if (!confirm('Erase every block and note? This cannot be undone.')) return;
    dropAllSessions();
    world.load({ voxels: [], notes: [] });
    store.clear();
    fitView();
    requestSave();
  });

  $('editor-done').addEventListener('click', closeEditor);
  $('editor-delete').addEventListener('click', () => {
    if (!editing) return;
    const id = editing.id;
    editing = null;
    $('editor').hidden = true;
    world.removeNote(id);
    invalidate();
    requestSave();
  });

  const editorBody = $('editor-body');
  editorBody.addEventListener('input', () => {
    if (!editing) return;
    notes.setHtml(editing.id, sanitizeHtml(editorBody.innerHTML));
  });
  editorBody.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); closeEditor(); }
  });
  for (const b of document.querySelectorAll('.fbtn')) {
    b.addEventListener('mousedown', (e) => e.preventDefault());   // keep the selection
    b.addEventListener('click', () => {
      if (b.dataset.cmd === 'formatBlock') exec(b.dataset.cmd, b.dataset.val);
      else if (b.dataset.val) exec(b.dataset.cmd, b.dataset.val);
      else exec(b.dataset.cmd);
      editorBody.focus();
    });
  }
  $('editor').addEventListener('mousedown', (e) => {
    if (e.target === $('editor')) closeEditor();
  });
}

/* ── keyboard ────────────────────────────────────────────────────────── */

window.addEventListener('keydown', (e) => {
  const el = document.activeElement;
  const typing = !!el && (el.isContentEditable || el.tagName === 'INPUT' || el.tagName === 'TEXTAREA');
  const mod = e.ctrlKey || e.metaKey;

  if (e.key === 'Escape') { closeModals(); return; }
  if (typing || editing) {
    if (mod && e.key.toLowerCase() === 's') e.preventDefault();
    return;
  }

  if (mod && e.key.toLowerCase() === 'z') {
    e.preventDefault();
    if (e.shiftKey) world.redo(); else world.undo();
    invalidate();
    requestSave();
    return;
  }
  if (mod && e.key.toLowerCase() === 'y') {
    e.preventDefault();
    world.redo();
    invalidate();
    requestSave();
    return;
  }
  if (mod) return;

  switch (e.key) {
    case 'b': case 'B': setTool('build'); return;
    case 'd': case 'D': setTool('dig'); return;
    case 'p': case 'P': setTool('paint'); return;
    case 'n': case 'N': setTool('note'); return;
    case 'h': case 'H': setTool('pan'); return;
    case 'm': case 'M': setTool('stamp'); return;
    case 'i': case 'I': setTool('island'); return;
    case 'k': case 'K': setTool('harness'); return;
    case 'g': case 'G': setTool('grab'); return;
    case 'q': case 'Q': stepMat(-1); return;
    case 'e': case 'E': stepMat(1); return;
    case 'r': case 'R': {
      // Turn the model under the cursor a quarter turn; Shift turns it back.
      if (!e.repeat) rotatePropAt(pointerAt.x, pointerAt.y, e.shiftKey ? -1 : 1);
      return;
    }
    case 'v': case 'V': toggleView(); return;
    case '[': setBrush(BRUSHES[Math.max(0, BRUSHES.indexOf(state.brush) - 1)]); return;
    case ']': setBrush(BRUSHES[Math.min(BRUSHES.length - 1, BRUSHES.indexOf(state.brush) + 1)]); return;
    case '+': case '=': zoomAt(canvas.clientWidth / 2, canvas.clientHeight / 2, 1.2); return;
    case '-': case '_': zoomAt(canvas.clientWidth / 2, canvas.clientHeight / 2, 1 / 1.2); return;
    case '0': fitView(); return;
    case '?': case 'F1': $('help').hidden = false; return;
    case ' ':
      e.preventDefault();
      state.space = true;
      canvas.classList.add('pan');
      return;
    default: break;
  }

  if (e.key >= '1' && e.key <= '9') setMat(Number(e.key) - 1);
});

window.addEventListener('keyup', (e) => {
  if (e.key === ' ') {
    state.space = false;
    canvas.classList.toggle('pan', state.tool === 'pan');
  }
});

window.addEventListener('resize', () => {
  renderer.resize();
  invalidate();
});

window.addEventListener('beforeunload', () => {
  clearTimeout(saveTimer);
  store.save(world, cam);
});

/* ── boot ────────────────────────────────────────────────────────────── */

gallery = new Gallery($('gallery'), { onPick: () => setTool('stamp') });
islandsPanel = new IslandGallery($('islands'), { onPick: () => setTool('island') });

buildToolbar();
buildActions();

const saved = store.load();
if (saved) {
  world.load(saved);
  if (!applyCamera(saved.camera)) fitView();
} else {
  seedStarter(world);
  fitView();
}

invalidate();

// How a harness tile touches the world. Every omp session the page spawns is
// handed the tool surface in src/hosttools.js — look, terrain, notes, models,
// islands, spawning another harness, removing things — and a call runs through
// the same World methods a click does, so each one is a normal undoable edit.
// A call that fails (an unknown model id, a missing note) comes back to the
// model as a tool error instead of changing anything.
bindHostTools({ world, cam, invalidate, requestSave, removeNote: deleteNote, removeChat: deleteChat });
setHostTools(HOST_TOOLS);
setHostToolRunner(runHostTool);

// Scripting hook: every part of the app is reachable from the console, e.g.
//   island.world.get(0, 0, 0)      island.cam.scale = 2
//   island.world.apply([{ x: 0, y: 0, z: 5, mat: 2 }])
window.island = { world, cam, state, renderer, notes, chats, chatWindow, islands: islandsPanel, invalidate, save: () => store.save(world, cam), theme: { set: setBackground, default: DEFAULT_BG } };
