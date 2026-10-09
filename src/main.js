// Wiring: camera, input, tools, editor modal, status, autosave.

import { World, PALETTE, PAPER, seedStarter } from './world.js';
import { Renderer } from './render.js';
import { Notes, sanitizeHtml } from './notes.js';
import { raycast } from './iso.js';
import { targetsFor, anchorZ, BRUSHES } from './tools.js';
import * as store from './store.js';

const $ = (id) => document.getElementById(id);
const canvas = $('stage');

const world = new World();
const renderer = new Renderer(canvas, world);
const cam = renderer.cam;
const state = { tool: 'build', mat: 0, brush: 1, space: false };

let hover = null;        // voxel pick under the cursor (or null)
let noteGhost = null;    // voxel pick a dragged note would land on
let frameHandle = 0;
let saveTimer = 0;
let editing = null;      // { id, before } while the modal editor is open

/* ── notes layer ─────────────────────────────────────────────────────── */

const notes = new Notes($('notes-layer'), world, {
  cam: () => cam,
  pickAt: (cx, cy) => pickAt(cx, cy),
  onGhost: (hit) => { noteGhost = hit; invalidate(); },
  onDrop: (id, hit) => {
    if (hit) world.patchNote(id, { x: hit.x + 0.5, y: hit.y + 0.5, z: anchorZ(hit) });
    invalidate();
    requestSave();
  },
  onCycleColor: (id) => {
    const n = world.note(id);
    if (!n) return;
    world.patchNote(id, { color: (n.color + 1) % PAPER.length });
    requestSave();
  },
  onExpand: (id) => openEditor(id),
  onDelete: (id) => { world.removeNote(id); invalidate(); requestSave(); },
  onFocusNote: () => { hover = null; noteGhost = null; },
  onTextEdit: (id, before, after) => {
    const clean = sanitizeHtml(after);
    if (clean === before) return;
    world.patchNote(id, { html: clean });
    requestSave();
  },
});

/* ── picking ─────────────────────────────────────────────────────────── */

const solid = (x, y, z) => world.get(x, y, z) !== undefined;

function pickAt(clientX, clientY) {
  const r = canvas.getBoundingClientRect();
  const iso = renderer.toIso(clientX - r.left, clientY - r.top);
  return raycast(iso.ix, iso.iy, solid);
}

function hexA(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

/** Ghost preview for the active tool (or for a note being dropped). */
function ghostVisual(hit, forceNote = false) {
  if (!hit) return null;
  const isNote = forceNote || state.tool === 'note';
  const cells = isNote
    ? [{ x: hit.x, y: hit.y, z: hit.ground ? 0 : hit.z + 1 }]
    : targetsFor(world, hit, state.tool, state.brush);
  const fill = isNote ? 'rgba(255,214,102,0.45)'
    : state.tool === 'dig' ? 'rgba(255,90,80,0.35)'
      : state.tool === 'paint' ? 'rgba(255,255,255,0.30)'
        : hexA(PALETTE[state.mat].color, 0.38);
  // A click on bare ground targets the ground cell itself, so the cursor
  // marker is a flat rhombus on the plane rather than a cube.
  const cursor = hit.ground
    ? { x: hit.x, y: hit.y, z: 0, flat: true }
    : { x: hit.x, y: hit.y, z: hit.z, flat: false };
  return { hit, cells, fill, outline: 'rgba(255,255,255,0.6)', cursor };
}

/* ── frame loop ──────────────────────────────────────────────────────── */

function invalidate() {
  if (!frameHandle) frameHandle = requestAnimationFrame(frame);
}

function frame() {
  frameHandle = 0;
  renderer.hover = noteGhost ? ghostVisual(noteGhost, true) : ghostVisual(hover);
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

let mode = null;          // null | 'pan' | 'sculpt'
let pan = null;
let strokeKeys = null;
const pointers = new Map();
let pinch = null;

function startSculpt(e) {
  canvas.setPointerCapture(e.pointerId);
  mode = 'sculpt';
  strokeKeys = new Set();
  world.beginStroke();
  sculptAt(e);
}

function sculptAt(e) {
  const hit = pickAt(e.clientX, e.clientY);
  hover = hit;
  const cells = targetsFor(world, hit, state.tool, state.brush);
  const fresh = [];
  for (const c of cells) {
    const k = c.x + ',' + c.y + ',' + c.z;
    if (strokeKeys.has(k)) continue;
    strokeKeys.add(k);
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
    if (save) requestSave();
  }
  mode = null;
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

  const wantsPan = e.button === 1 || e.button === 2 || state.space || state.tool === 'pan';
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
    invalidate();
    return;
  }

  if (mode === 'pan' && pan) {
    cam.ox += e.clientX - pan.x;
    cam.oy += e.clientY - pan.y;
    pan = { x: e.clientX, y: e.clientY };
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

canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  const r = canvas.getBoundingClientRect();
  if (e.ctrlKey || e.metaKey || e.altKey) {
    zoomAt(e.clientX - r.left, e.clientY - r.top, Math.exp(-e.deltaY * 0.0022));
  } else {
    cam.ox -= e.deltaX;
    cam.oy -= e.deltaY;
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
  invalidate();
}

/* ── notes ───────────────────────────────────────────────────────────── */

function createNote(hit) {
  if (!hit) return;
  const note = {
    id: 'n' + Date.now().toString(36) + Math.floor(Math.random() * 1e6).toString(36),
    x: hit.x + 0.5,
    y: hit.y + 0.5,
    z: anchorZ(hit),
    color: 0,
    html: '<p><br></p>',
  };
  world.addNote(note);
  invalidate();
  requestSave();
  requestAnimationFrame(() => notes.beginEdit(note.id));
}

/* ── toolbar / status ────────────────────────────────────────────────── */

const TOOL_LABEL = { build: 'Build', dig: 'Dig', paint: 'Paint', note: 'Note', pan: 'Pan' };

function setText(el, str) {
  if (el.textContent !== str) el.textContent = str;
}

function setTool(tool) {
  state.tool = tool;
  for (const b of document.querySelectorAll('#tools .tbtn')) {
    b.classList.toggle('active', b.dataset.tool === tool);
  }
  canvas.classList.toggle('pan', tool === 'pan');
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
      if (data.camera && Number.isFinite(data.camera.scale)) Object.assign(cam, data.camera);
      else fitView();
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

buildToolbar();
buildActions();

const saved = store.load();
if (saved) {
  world.load(saved);
  if (saved.camera && Number.isFinite(saved.camera.scale)) Object.assign(cam, saved.camera);
  else fitView();
} else {
  seedStarter(world);
  fitView();
}

invalidate();

// Scripting hook: every part of the app is reachable from the console, e.g.
//   island.world.get(0, 0, 0)      island.cam.scale = 2
//   island.world.apply([{ x: 0, y: 0, z: 5, mat: 2 }])
window.island = { world, cam, state, renderer, notes, invalidate, save: () => store.save(world, cam) };
