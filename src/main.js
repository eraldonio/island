// Wiring: camera, input, tools, editor modal, status, autosave.

import { World, PALETTE, PAPER, seedStarter, uid, NOTE_NEW } from './world.js';
import { Renderer } from './render.js';
import { Notes, sanitizeHtml } from './notes.js';
import { raycast, unproject, viewOf, ISO, Z_MAX, SPIN0, TILT0, TILT_MAX } from './iso.js';
import { targetsFor, BRUSHES } from './tools.js';
import { Gallery } from './gallery.js';
import { MODELS, modelSize } from './models.js';
import * as store from './store.js';

const MODELS_BY_ID = new Map(MODELS.map((m) => [m.id, m]));

const $ = (id) => document.getElementById(id);
const canvas = $('stage');

const world = new World();
const renderer = new Renderer(canvas, world);
const cam = renderer.cam;
const state = { tool: 'build', mat: 0, brush: 1, space: false };

let hover = null;        // voxel pick under the cursor (or null)
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

/* ── picking ─────────────────────────────────────────────────────────── */

// Notes decide their own hover state from the pointer, because their toolbar
// and handles live outside the paper quad.
window.addEventListener('pointermove', (e) => {
  notes.remember(e.clientX, e.clientY);
  notes.hoverAt(e.clientX, e.clientY);
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

/**
 * Where a stamped model lands: the block column the click targets (the
 * neighbour of a side face, so a model placed against a wall stands beside it),
 * with the model's footprint centred on that column and resting on its surface.
 * The grid decides the placement; the model keeps its own sub-block geometry.
 */
function stampTarget(hit) {
  const model = gallery && gallery.model;
  const size = model ? modelSize(model) : { w: 1, h: 1, hz: 1 };
  const cx = hit.ground ? hit.x : hit.x + hit.nx;
  const cy = hit.ground ? hit.y : hit.y + hit.ny;
  return {
    size,
    x: cx - ((size.w - 1) >> 1),
    y: cy - ((size.h - 1) >> 1),
    z: world.surfaceUnder(cx, cy, 1, 1),
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
    const s = modelSize(model);
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
  if (state.tool === 'stamp') {
    placeStamp(pickAt(e.clientX, e.clientY));
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

  hover = pickAt(e.clientX, e.clientY);
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
  if (mode === 'sculpt') {
    finishStroke(true);
    invalidate();
  }
}
canvas.addEventListener('pointerup', onUp);
canvas.addEventListener('pointercancel', onUp);
canvas.addEventListener('contextmenu', (e) => e.preventDefault());

// Bound to the window so the wheel works even when the cursor is over a note
// tile; modals keep their own scrolling. Wheel zooms at the cursor, shift pans,
// and ctrl+wheel keeps working because trackpad pinch sends it.
window.addEventListener('wheel', (e) => {
  if (e.target.closest && e.target.closest('.backdrop')) return;
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
    html: '<p><br></p>',
  };
  world.addNote(note);
  invalidate();
  requestSave();
  requestAnimationFrame(() => notes.beginEdit(note.id));
}

/* ── toolbar / status ────────────────────────────────────────────────── */

const TOOL_LABEL = { build: 'Build', dig: 'Dig', paint: 'Paint', note: 'Note', pan: 'Pan', stamp: 'Place' };

function setText(el, str) {
  if (el.textContent !== str) el.textContent = str;
}

function setTool(tool) {
  state.tool = tool;
  for (const b of document.querySelectorAll('#tools .tbtn')) {
    b.classList.toggle('active', b.dataset.tool === tool);
  }
  canvas.classList.toggle('pan', tool === 'pan');
  if (gallery) gallery.show(tool === 'stamp');
  invalidate();
}

function setMat(i) {
  state.mat = i;
  for (const b of document.querySelectorAll('#swatches .swatch')) {
    b.classList.toggle('active', Number(b.dataset.mat) === i);
  }
  invalidate();
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
    b.title = `${p.name} (${i + 1})`;
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
  setText($('st-count'), `${nb} block${nb === 1 ? '' : 's'} · ${nn} note${nn === 1 ? '' : 's'}`);
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

function requestSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => store.save(world, cam), 500);
}

function closeModals() {
  if (editing) closeEditor();
  $('help').hidden = true;
}

function buildActions() {
  $('a-undo').addEventListener('click', () => { world.undo(); invalidate(); requestSave(); });
  $('a-redo').addEventListener('click', () => { world.redo(); invalidate(); requestSave(); });
  $('a-zin').addEventListener('click', () => zoomAt(canvas.clientWidth / 2, canvas.clientHeight / 2, 1.2));
  $('a-zout').addEventListener('click', () => zoomAt(canvas.clientWidth / 2, canvas.clientHeight / 2, 1 / 1.2));
  $('a-view').addEventListener('click', fitView);

  const spin = $('a-spin');
  spin.addEventListener('input', () => setView(Number(spin.value), cam.tilt));
  spin.addEventListener('change', () => requestSave());
  const tilt = $('a-tilt');
  tilt.addEventListener('input', () => setView(cam.spin, Number(tilt.value)));
  tilt.addEventListener('change', () => requestSave());
  setView(cam.spin, cam.tilt);
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

  if (e.key >= '1' && e.key <= '8') setMat(Number(e.key) - 1);
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

// Scripting hook: every part of the app is reachable from the console, e.g.
//   island.world.get(0, 0, 0)      island.cam.scale = 2
//   island.world.apply([{ x: 0, y: 0, z: 5, mat: 2 }])
window.island = { world, cam, state, renderer, notes, invalidate, save: () => store.save(world, cam) };
