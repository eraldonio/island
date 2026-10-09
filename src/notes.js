// Sticky notes: real DOM elements floating over the canvas.
//
// Notes are the one thing in this app that must be text-editable, so they stay
// in the DOM (contenteditable) instead of being drawn. The layer is
// pointer-events:none and each note re-enables them, so panning and sculpting
// keep working everywhere else.

import { project } from './iso.js';
import { PAPER } from './world.js';

const ALLOWED = new Set([
  'P', 'BR', 'DIV', 'SPAN', 'B', 'STRONG', 'I', 'EM', 'U', 'S', 'STRIKE', 'DEL',
  'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'UL', 'OL', 'LI', 'BLOCKQUOTE', 'PRE',
  'CODE', 'A', 'HR', 'SUB', 'SUP',
]);

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
  /** @param {{pickAt:Function,onGhost:Function,onDrop:Function,onCycleColor:Function,onExpand:Function,onDelete:Function,onTextEdit:Function,onFocusNote:Function}} hooks */
  constructor(layer, world, hooks) {
    this.layer = layer;
    this.world = world;
    this.hooks = hooks;
    this.els = new Map();
  }

  element(id) { return this.els.get(id); }
  body(id) { const el = this.els.get(id); return el ? el.querySelector('.body') : null; }

  /** Create / destroy / reposition note elements to match the world. */
  sync(cam) {
    const live = new Set();
    for (const note of this.world.notes) {
      live.add(note.id);
      let el = this.els.get(note.id);
      if (!el) {
        el = this.create(note);
        this.els.set(note.id, el);
        this.layer.appendChild(el);
      }
      const paper = PAPER[((note.color | 0) % PAPER.length + PAPER.length) % PAPER.length];
      if (el.dataset.paper !== paper) {
        el.dataset.paper = paper;
        el.style.setProperty('--paper', paper);
      }

      // Converge the card text on the model — undo/redo changes it behind our
      // back. Text the user is editing (inline or in the popup) wins.
      const body = el.querySelector('.body');
      if (el.live || document.activeElement === body) {
        el.html = note.html;
      } else if (el.html !== note.html) {
        body.innerHTML = note.html || '<p><br></p>';
        el.html = note.html;
      }

      if (el.dataset.dragging !== '1') this.place(el, note, cam);
    }
    for (const [id, el] of this.els) {
      if (!live.has(id)) { el.remove(); this.els.delete(id); }
    }
  }

  place(el, note, cam) {
    const p = project(note.x, note.y, note.z);
    const x = cam.ox + p.x * cam.scale;
    const y = cam.oy + p.y * cam.scale;
    const k = clamp(cam.scale, 0.55, 1.25);
    el.dataset.k = k;
    el.style.transform = `translate3d(${x}px, ${y}px, 0) scale(${k})`;
    el.style.zIndex = String(1000 + Math.round(y));
  }

  /** Write the note's html into its card (used by the popup editor mirror). */
  setHtml(id, html) {
    const el = this.els.get(id);
    const body = el && el.querySelector('.body');
    if (!body || document.activeElement === body) return;
    el.live = true;
    if (el.html === html) return;
    body.innerHTML = html || '<p><br></p>';
    el.html = html;
  }

  /** Mark a note as owned by the popup editor, or hand it back to the model. */
  setEditing(id, on) {
    const el = this.els.get(id);
    if (!el) return;
    el.live = on;
    if (!on) el.html = null;   // force the next sync to repaint from the model
  }

  /** Focus a note's text and put the caret at the end. */
  beginEdit(id) {
    const body = this.body(id);
    if (!body) return;
    body.focus();
    const r = document.createRange();
    r.selectNodeContents(body);
    r.collapse(false);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(r);
  }

  create(note) {
    const el = document.createElement('div');
    el.className = 'note fresh';
    el.dataset.id = note.id;
    el.innerHTML =
      '<div class="stem"></div>' +
      '<div class="card">' +
        '<div class="bar">' +
          '<span class="paper-dot"></span>' +
          '<span class="grip"></span>' +
          '<button class="n-color" title="Cycle paper colour">●</button>' +
          '<button class="n-expand" title="Open the big editor">⤢</button>' +
          '<button class="n-del" title="Delete note">×</button>' +
        '</div>' +
        '<div class="body" contenteditable="true"></div>' +
      '</div>';

    const body = el.querySelector('.body');
    body.innerHTML = note.html || '<p><br></p>';
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

    // ── inline WYSIWYG editing ──
    let before = null;
    body.addEventListener('focus', () => {
      before = body.innerHTML;
      this.hooks.onFocusNote(note.id);
    });
    body.addEventListener('blur', () => {
      if (before !== null && before !== body.innerHTML) {
        this.hooks.onTextEdit(note.id, before, body.innerHTML);
      }
      before = null;
    });
    body.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      this.hooks.onExpand(note.id);
    });
    body.addEventListener('paste', (e) => {
      e.preventDefault();
      const data = e.clipboardData;
      if (!data) return;
      const html = data.getData('text/html');
      if (html) {
        document.execCommand('insertHTML', false, sanitizeHtml(html));
      } else {
        document.execCommand('insertText', false, data.getData('text/plain') || '');
      }
    });
    body.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.preventDefault(); body.blur(); }
      e.stopPropagation();
    });

    // ── drag the note by its bar ──
    const bar = el.querySelector('.bar');
    let drag = null;

    bar.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || e.target.closest('button')) return;
      e.preventDefault();
      e.stopPropagation();
      bar.setPointerCapture(e.pointerId);
      drag = { x0: e.clientX, y0: e.clientY, moved: false };
      el.dataset.dragging = '1';
      el.classList.add('dragging');
    });

    bar.addEventListener('pointermove', (e) => {
      if (!drag) return;
      if (Math.abs(e.clientX - drag.x0) + Math.abs(e.clientY - drag.y0) > 3) drag.moved = true;
      el.style.transform = `translate3d(${e.clientX}px, ${e.clientY}px, 0) scale(${el.dataset.k})`;
      el.style.zIndex = '4000';
      this.hooks.onGhost(this.hooks.pickAt(e.clientX, e.clientY));
    });

    const endDrag = (e) => {
      if (!drag) return;
      const moved = drag.moved;
      drag = null;
      delete el.dataset.dragging;
      el.classList.remove('dragging');
      this.hooks.onGhost(null);
      if (moved) {
        this.hooks.onDrop(note.id, this.hooks.pickAt(e.clientX, e.clientY));
      } else {
        const live = this.world.note(note.id);
        if (live) this.place(el, live, this.hooks.cam());
      }
    };
    bar.addEventListener('pointerup', endDrag);
    bar.addEventListener('pointercancel', endDrag);

    return el;
  }
}
