// Sticky notes: a w*h block tile lying flat on the surface.
//
// The paper itself is drawn by the renderer in the voxel painter order, so a
// hill in front of a note covers it instead of the note floating over it. What
// lives in the DOM is the ink: text transformed into the ground plane with the
// same affine matrix as the projection, which keeps it real contenteditable
// (caret, selection, Ctrl+B/I/U) while looking like writing on a sticker.

import { project, raycast, NOTE_U, HW, HH } from './iso.js';
import { PAPER, NOTE_MIN, NOTE_MAX } from './world.js';

const ALLOWED = new Set([
  'P', 'BR', 'DIV', 'SPAN', 'B', 'STRONG', 'I', 'EM', 'U', 'S', 'STRIKE', 'DEL',
  'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'UL', 'OL', 'LI', 'BLOCKQUOTE', 'PRE',
  'CODE', 'A', 'HR', 'SUB', 'SUP',
]);

// Sample points across the tile, as fractions of its width/height. Occlusion is
// a property of the world and the fixed camera, never of the pan, so this only
// has to be recomputed when the world changes.
const SAMPLES = [[0.5, 0.5], [0.06, 0.5], [0.94, 0.5], [0.5, 0.06], [0.5, 0.94]];
const BURIED_AT = 0.8;

// Preview sizes tried in order; the last one is the floor before clipping.
const FIT_SIZES = [12.5, 11, 9.5];

// How far outside the paper (in tile-local px) still counts as "on the note".
// Large enough to bridge the gap to the hover toolbar and the corner handles.
const HOT_MARGIN = 44;

function safeStyle(raw) {
  const keep = [];
  for (const decl of String(raw).split(';')) {
    const i = decl.indexOf(':');
    if (i < 0) continue;
    const prop = decl.slice(0, i).trim().toLowerCase();
    const val = decl.slice(i + 1).trim();
    if (prop !== 'color' && prop !== 'background-color') continue;
    if (val.length > 40 || !/^[#a-z0-9(),.%\s-]+$/i.test(val)) continue;
    keep.push(prop + ':' + val);
  }
  return keep.join(';');
}

/** Whitelist sanitizer. Parsed detached, so nothing in it can execute. */
export function sanitizeHtml(html) {
  const doc = new DOMParser().parseFromString('<body>' + html + '</body>', 'text/html');
  const root = doc.body;

  const walk = (node) => {
    for (const child of [...node.childNodes]) {
      if (child.nodeType === 3) continue;
      if (child.nodeType !== 1) { child.remove(); continue; }
      if (!ALLOWED.has(child.tagName)) {
        walk(child);
        child.replaceWith(...child.childNodes);
        continue;
      }
      for (const attr of [...child.attributes]) {
        const name = attr.name.toLowerCase();
        if (name === 'style') {
          const s = safeStyle(attr.value);
          if (s) child.setAttribute('style', s); else child.removeAttribute('style');
        } else if (name === 'href' && child.tagName === 'A') {
          const v = attr.value.trim();
          if (/^(https?:|mailto:)/i.test(v)) {
            child.setAttribute('href', v);
            child.setAttribute('target', '_blank');
            child.setAttribute('rel', 'noopener noreferrer');
          } else child.removeAttribute('href');
        } else {
          child.removeAttribute(attr.name);
        }
      }
      walk(child);
    }
  };

  walk(root);
  return root.innerHTML;
}

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

export class Notes {
  /** @param {{cam:Function,pickAt:Function,onGhost:Function,onDrop:Function,onResize:Function,onResizeCommit:Function,onCycleColor:Function,onExpand:Function,onDelete:Function,onTextEdit:Function,onFocusNote:Function}} hooks */
  constructor(layer, world, hooks) {
    this.layer = layer;
    this.world = world;
    this.hooks = hooks;
    this.els = new Map();
    this.rev = -1;
    this.solid = (x, y, z) => world.get(x, y, z) !== undefined;
  }

  element(id) { return this.els.get(id); }
  ink(id) { const el = this.els.get(id); return el ? el.querySelector('.ink') : null; }

  /* ── ground-plane maths ────────────────────────────────────────────── */

  /** Affine matrix [a,b,c,d] mapping tile-local px to screen px at zoom 1. */
  matrix(cam) {
    const k = cam.scale / NOTE_U;
    return [HW * k, HH * k, -HW * k, HH * k];
  }

  originOf(note, cam) {
    const level = this.world.surfaceUnder(note.x, note.y, note.w, note.h);
    const p = project(note.x, note.y, level);
    const r = this.layer.getBoundingClientRect();
    return { x: r.left + cam.ox + p.x * cam.scale, y: r.top + cam.oy + p.y * cam.scale };
  }

  /** Client point -> tile-local px, i.e. the inverse of matrix(). */
  toLocal(clientX, clientY, note, cam) {
    const o = this.originOf(note, cam);
    const [a, b, c, d] = this.matrix(cam);
    const det = a * d - c * b;
    const dx = clientX - o.x;
    const dy = clientY - o.y;
    return { x: (d * dx - c * dy) / det, y: (-b * dx + a * dy) / det };
  }

  /* ── per-world-revision geometry ───────────────────────────────────── */

  /**
   * A note rests on the highest block under its footprint, which is derived
   * from the terrain every time rather than cached: moving a tile, undoing a
   * move, or building under it must all re-derive it consistently with the
   * renderer. Only the (much costlier) occlusion verdict is cached per revision.
   */
  regen(note) {
    note.buried = this.occlusion(note) >= BURIED_AT;
  }

  /** Fraction of the tile hidden behind blocks that sit in front of it. */
  occlusion(note) {
    const L = this.world.surfaceUnder(note.x, note.y, note.w, note.h);
    let hidden = 0;
    for (const [fx, fy] of SAMPLES) {
      const px = note.x + fx * note.w;
      const py = note.y + fy * note.h;
      const s = project(px, py, L);
      const hit = raycast(s.x, s.y, this.solid);
      if (hit.ground) continue;   // no block anywhere along this ray, so nothing hides the tile
      if (hit.x + hit.y + hit.z > px + py + L - 1) hidden++;
    }
    return hidden / SAMPLES.length;
  }

  /* ── hover proximity ───────────────────────────────────────────────── */

  /**
   * The toolbar and the resize handles sit outside the paper quad, so plain
   * :hover on the tile can never reach them. Track the pointer against the
   * quad grown by a margin instead, and against the toolbar's own box.
   */
  hoverAt(clientX, clientY) {
    const cam = this.hooks.cam();
    const [a, b, c, d] = this.matrix(cam);
    const det = a * d - c * b;
    for (const note of this.world.notes) {
      const el = this.els.get(note.id);
      if (!el) continue;
      const o = this.originOf(note, cam);
      const dx = clientX - o.x;
      const dy = clientY - o.y;
      const lx = (d * dx - c * dy) / det;
      const ly = (-b * dx + a * dy) / det;
      const w = note.w * NOTE_U;
      const h = note.h * NOTE_U;
      let hot = lx >= -HOT_MARGIN && lx <= w + HOT_MARGIN && ly >= -HOT_MARGIN && ly <= h + HOT_MARGIN;
      if (!hot && el.classList.contains('hot')) {
        const t = el.querySelector('.tools').getBoundingClientRect();
        hot = clientX >= t.left - 4 && clientX <= t.right + 4 && clientY >= t.top - 4 && clientY <= t.bottom + 4;
      }
      el.classList.toggle('hot', hot);
    }
  }

  /** Re-run the proximity test after the world moves under a still pointer. */
  rehover() {
    if (this.lastPointer) this.hoverAt(this.lastPointer.x, this.lastPointer.y);
  }

  remember(x, y) { this.lastPointer = { x, y }; }

  /* ── frame sync ────────────────────────────────────────────────────── */

  sync(cam) {
    if (this.world.rev !== this.rev) {
      this.rev = this.world.rev;
      for (const note of this.world.notes) this.regen(note);
    }

    const live = new Set();
    for (const note of this.world.notes) {
      live.add(note.id);
      let el = this.els.get(note.id);
      if (!el) {
        el = this.create(note);
        this.els.set(note.id, el);
        this.layer.appendChild(el);
      }
      this.paint(el, note);
      if (el.dataset.dragging !== '1') this.place(el, note, cam);
      // measure the text only once the sheet has its block size
      if (!el.dataset.fitted) { el.dataset.fitted = '1'; this.fit(el); }
    }

    for (const [id, el] of this.els) {
      if (!live.has(id)) { el.remove(); this.els.delete(id); }
    }
  }

  paint(el, note) {
    const paper = PAPER[((note.color | 0) % PAPER.length + PAPER.length) % PAPER.length];
    if (el.dataset.paper !== paper) {
      el.dataset.paper = paper;
      el.style.setProperty('--paper', paper);
    }

    // Converge the card text on the model — undo/redo changes it behind our
    // back. Text the user is editing (inline or in the popup) wins.
    const ink = el.querySelector('.ink');
    if (el.live || document.activeElement === ink) {
      el.html = note.html;
    } else if (el.html !== note.html) {
      ink.innerHTML = note.html || '<p><br></p>';
      el.html = note.html;
      this.fit(el);
    }

    const size = el.querySelector('.size');
    const label = `${note.w}×${note.h}`;
    if (size.textContent !== label) size.textContent = label;
    el.classList.toggle('buried', !!note.buried);
  }

  /**
   * Smart preview: step the text size down while it still helps, then clip at a
   * whole line so the tile never shows a half line or a word cut in half.
   */
  fit(el) {
    const ink = el.querySelector('.ink');
    if (!ink || !ink.clientHeight) return;   // nothing to measure until attached
    ink.style.height = '';

    let fits = false;
    let lines = 1;
    let lh = 0;
    let pad = 0;
    for (const size of FIT_SIZES) {
      ink.style.fontSize = size + 'px';
      const cs = getComputedStyle(ink);
      lh = parseFloat(cs.lineHeight) || size * 1.25;
      pad = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);
      lines = Math.max(1, Math.floor((ink.clientHeight - pad) / lh));
      if (ink.scrollHeight <= ink.clientHeight + 0.5) { fits = true; break; }
    }
    if (!fits) ink.style.height = Math.min(ink.clientHeight, Math.ceil(pad + lines * lh)) + 'px';

    el.classList.toggle('tight', !fits);
    el.dataset.lines = String(lines);
    const badge = el.querySelector('.size');
    if (badge) badge.title = fits ? 'Tile size in blocks' : 'Text is clipped — resize the tile or open the editor';
  }

  place(el, note, cam) {
    const o = this.originOf(note, cam);
    el.style.transform = `translate3d(${o.x}px, ${o.y}px, 0)`;
    el.style.zIndex = String(1000 + Math.round(o.y));

    const [a, b, c, d] = this.matrix(cam);
    const sheet = el.querySelector('.sheet');
    sheet.style.transform = `matrix(${a},${b},${c},${d},0,0)`;

    const w = note.w * NOTE_U;
    const h = note.h * NOTE_U;
    sheet.style.width = w + 'px';
    sheet.style.height = h + 'px';

    const hz = sheet.querySelectorAll('.hz');
    this.put(hz[0], w, 0);      // grows w
    this.put(hz[1], 0, h);      // grows h
    this.put(hz[2], w, h);      // grows both
    el.classList.toggle('small', note.w * note.h < 6);
  }

  put(node, left, top) {
    node.style.left = left + 'px';
    node.style.top = top + 'px';
  }

  /* ── DOM ───────────────────────────────────────────────────────────── */

  create(note) {
    const el = document.createElement('div');
    el.className = 'note fresh';
    el.dataset.id = note.id;
    el.innerHTML =
      '<div class="sheet">' +
        '<div class="ink" contenteditable="true"></div>' +
        '<span class="hz" data-edge="w" title="Drag to resize in blocks"></span>' +
        '<span class="hz" data-edge="h" title="Drag to resize in blocks"></span>' +
        '<span class="hz" data-edge="wh" title="Drag to resize in blocks"></span>' +
      '</div>' +
      '<div class="tools">' +
        '<span class="size"></span>' +
        '<button class="n-grip" title="Drag to move the note">⠿</button>' +
        '<button class="n-color" title="Cycle paper colour">●</button>' +
        '<button class="n-expand" title="Open the big editor">⤢</button>' +
        '<button class="n-del" title="Delete note">×</button>' +
      '</div>';

    const sheet = el.querySelector('.sheet');
    const ink = el.querySelector('.ink');
    ink.innerHTML = note.html || '<p><br></p>';
    el.html = note.html || '';
    setTimeout(() => el.classList.remove('fresh'), 200);

    el.querySelector('.n-color').addEventListener('click', (e) => {
      e.stopPropagation();
      this.hooks.onCycleColor(note.id);
    });
    el.querySelector('.n-expand').addEventListener('click', (e) => {
      e.stopPropagation();
      this.hooks.onExpand(note.id);
    });
    el.querySelector('.n-del').addEventListener('click', (e) => {
      e.stopPropagation();
      this.hooks.onDelete(note.id);
    });

    // ── inline WYSIWYG ──
    let before = null;
    ink.addEventListener('focus', () => {
      before = ink.innerHTML;
      this.hooks.onFocusNote(note.id);
    });
    ink.addEventListener('blur', () => {
      if (before !== null && before !== ink.innerHTML) {
        this.hooks.onTextEdit(note.id, before, ink.innerHTML);
        this.fit(el);
      }
      before = null;
    });
    ink.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      this.hooks.onExpand(note.id);
    });
    ink.addEventListener('paste', (e) => {
      e.preventDefault();
      const data = e.clipboardData;
      if (!data) return;
      const html = data.getData('text/html');
      if (html) document.execCommand('insertHTML', false, sanitizeHtml(html));
      else document.execCommand('insertText', false, data.getData('text/plain') || '');
      this.fit(el);
    });
    ink.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.preventDefault(); ink.blur(); }
      e.stopPropagation();
    });

    // dragging the paper out of the way must not drag the world
    sheet.addEventListener('pointerdown', (e) => e.stopPropagation());
    sheet.addEventListener('dblclick', (e) => e.stopPropagation());

    this.wireGrip(el, sheet, ink, note);
    for (const hz of sheet.querySelectorAll('.hz')) this.wireHandle(el, hz, note);
    return el;
  }

  wireGrip(el, sheet, ink, note) {
    const grip = el.querySelector('.n-grip');
    let drag = null;

    grip.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      grip.setPointerCapture(e.pointerId);
      const cam = this.hooks.cam();
      const local = this.toLocal(e.clientX, e.clientY, note, cam);
      drag = {
        start: { x: note.x, y: note.y },
        grab: {
          i: clamp(Math.floor(local.x / NOTE_U), 0, note.w - 1),
          j: clamp(Math.floor(local.y / NOTE_U), 0, note.h - 1),
        },
      };
      el.dataset.dragging = '1';
      el.classList.add('dragging');
      this.hooks.onDragStart(note.id);
    });

    const finish = (e, commit) => {
      if (!drag) return;
      const start = drag.start;
      drag = null;
      delete el.dataset.dragging;
      el.classList.remove('dragging');
      this.hooks.onGhost(null);
      const moved = note.x !== start.x || note.y !== start.y;
      if (commit && moved) {
        this.hooks.onDrop(note.id, start, { x: note.x, y: note.y });
      } else {
        if (moved && !commit) { note.x = start.x; note.y = start.y; this.regen(note); }
        this.place(el, note, this.hooks.cam());
        this.hooks.onResize(note.id);
      }
    };

    grip.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const hit = this.hooks.pickAt(e.clientX, e.clientY);
      if (!hit) return;
      const nx = hit.x - drag.grab.i;
      const ny = hit.y - drag.grab.j;
      if (nx === note.x && ny === note.y) return;
      note.x = nx;
      note.y = ny;
      this.regen(note);
      this.place(el, note, this.hooks.cam());
      this.hooks.onResize(note.id);
    });

    grip.addEventListener('pointerup', (e) => finish(e, true));
    grip.addEventListener('pointercancel', (e) => finish(e, false));
  }

  wireHandle(el, hz, note) {
    const edge = hz.dataset.edge;
    let active = false;
    let start = null;

    hz.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      hz.setPointerCapture(e.pointerId);
      active = true;
      start = { w: note.w, h: note.h };
      el.classList.add('resizing');
    });

    hz.addEventListener('pointermove', (e) => {
      if (!active) return;
      const cam = this.hooks.cam();
      const local = this.toLocal(e.clientX, e.clientY, note, cam);
      const w = edge === 'h' ? note.w : clamp(Math.round(local.x / NOTE_U), NOTE_MIN, NOTE_MAX);
      const h = edge === 'w' ? note.h : clamp(Math.round(local.y / NOTE_U), NOTE_MIN, NOTE_MAX);
      if (w === note.w && h === note.h) return;
      note.w = w;
      note.h = h;
      this.regen(note);
      this.place(el, note, cam);
      this.paint(el, note);
      this.fit(el);
      this.hooks.onResize(note.id);
    });

    const end = () => {
      if (!active) return;
      active = false;
      el.classList.remove('resizing');
      this.hooks.onResizeEnd(note.id, start, { w: note.w, h: note.h });
      start = null;
    };
    hz.addEventListener('pointerup', end);
    hz.addEventListener('pointercancel', end);
  }

  /* ── editing ───────────────────────────────────────────────────────── */

  setHtml(id, html) {
    const el = this.els.get(id);
    const ink = el && el.querySelector('.ink');
    if (!ink || document.activeElement === ink) return;
    el.live = true;
    if (el.html === html) return;
    ink.innerHTML = html || '<p><br></p>';
    el.html = html;
    this.fit(el);
  }

  setEditing(id, on) {
    const el = this.els.get(id);
    if (!el) return;
    el.live = on;
    if (!on) el.html = null;   // force the next sync to repaint from the model
  }

  beginEdit(id) {
    const ink = this.ink(id);
    if (!ink) return;
    ink.focus();
    const r = document.createRange();
    r.selectNodeContents(ink);
    r.collapse(false);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(r);
  }
}
