// Harness tiles: an omp chat lying on the world like a sticky note.
//
// A tile is a w*h block footprint drawn by the renderer as a dark slab in the
// voxel painter order (so terrain in front of it covers it exactly as it covers
// a note), while this module paints the live transcript into the ground plane
// with the projection's own matrix. The world view therefore shows the stream
// as it arrives; opening the tile hands the same session to a real chat window.
//
// The same slab hosts a *card*: a tile whose ink is a readout a harness authored
// (src/caps.js) instead of a transcript, with the same handles, grip, colour and
// preview size. A card is recognised by its record carrying a capability, and
// then there is no omp session behind it at all — `src/cards.js` keeps the live
// half and this module only places, typesets and frames it.

import { project, ISO, NOTE_U } from './iso.js';
import { NOTE_MIN, NOTE_MAX, CHAT_NEW, FS_MIN, FS_MAX, FS_DEFAULT, FS_STEP, clampFs } from './world.js';
import { sessionFor } from './omp.js';
import { paintCard, headerOf, refreshCard, dropCard } from './cards.js';

// How far outside the slab (in tile-local px) still counts as "on the tile",
// wide enough to bridge the gap to the hover toolbar and the corner handles.
const HOT_MARGIN = 44;
const PREVIEW_LINES = 9;

// The same fit ladder a note uses: the tile's own preview size first, then a
// couple of notches down while that still helps, then clip at a whole line.
const FIT_STEPS = [0, -1.5, -3];
const fitLadder = (base) => {
  const out = [];
  for (const d of FIT_STEPS) {
    const s = Math.min(base, Math.max(FS_MIN, base + d));
    if (!out.includes(s)) out.push(s);
  }
  return out;
};

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

/** A tile is a card when its record names a capability instead of a session. */
const isCard = (tile) => tile.cap !== undefined || tile.def !== undefined;

export class Harnesses {
  /**
   * @param {HTMLElement} layer
   * @param {import('./world.js').World} world
   * @param {{cam:Function,pickAt:Function,onOpen:Function,onResize:Function,onResizeEnd:Function,onDrop:Function,onDelete:Function,onFocusChat:Function}} hooks
   */
  constructor(layer, world, hooks) {
    this.layer = layer;
    this.world = world;
    this.hooks = hooks;
    this.els = new Map();
    this.viewKey = -1;
    this.lastPointer = null;
    this.pendingFit = new Set();
    this.fitHandle = 0;
  }

  get view() { return this.hooks.cam().view || ISO; }

  /* ── ground-plane maths (the note tile's mapping, verbatim) ─────────── */

  matrix(cam) {
    const v = cam.view || ISO;
    const k = cam.scale / NOTE_U;
    return [v.cos * v.H * k, v.sin * v.D * k, -v.sin * v.H * k, v.cos * v.D * k];
  }

  originOf(chat, cam) {
    const level = this.world.surfaceUnder(chat.x, chat.y, chat.w, chat.h);
    const p = project(chat.x, chat.y, level, cam.view || ISO);
    const r = this.layer.getBoundingClientRect();
    return { x: r.left + cam.ox + p.x * cam.scale, y: r.top + cam.oy + p.y * cam.scale };
  }

  toLocal(clientX, clientY, chat, cam) {
    const o = this.originOf(chat, cam);
    const [a, b, c, d] = this.matrix(cam);
    const det = a * d - c * b;
    const dx = clientX - o.x;
    const dy = clientY - o.y;
    return { x: (d * dx - c * dy) / det, y: (-b * dx + a * dy) / det };
  }

  /* ── hover proximity (same reason as notes: the toolbar is outside) ── */

  hoverAt(clientX, clientY) {
    this.lastPointer = { x: clientX, y: clientY };
    const cam = this.hooks.cam();
    const [a, b, c, d] = this.matrix(cam);
    const det = a * d - c * b;
    for (const chat of this.world.chats) {
      const el = this.els.get(chat.id);
      if (!el) continue;
      const o = this.originOf(chat, cam);
      const dx = clientX - o.x;
      const dy = clientY - o.y;
      const lx = (d * dx - c * dy) / det;
      const ly = (-b * dx + a * dy) / det;
      const w = chat.w * NOTE_U;
      const h = chat.h * NOTE_U;
      let hot = lx >= -HOT_MARGIN && lx <= w + HOT_MARGIN && ly >= -HOT_MARGIN && ly <= h + HOT_MARGIN;
      if (!hot && el.classList.contains('hot')) {
        const t = el.querySelector('.tools').getBoundingClientRect();
        hot = clientX >= t.left - 4 && clientX <= t.right + 4 && clientY >= t.top - 4 && clientY <= t.bottom + 4;
      }
      el.classList.toggle('hot', hot);
    }
  }

  rehover() {
    if (this.lastPointer) this.hoverAt(this.lastPointer.x, this.lastPointer.y);
  }

  /* ── frame sync ────────────────────────────────────────────────────── */

  sync(cam) {
    const v = cam.view || ISO;
    const key = v.spin * 1000 + v.tilt;
    const viewChanged = key !== this.viewKey;
    this.viewKey = key;

    const live = new Set();
    for (const chat of this.world.chats) {
      live.add(chat.id);
      let el = this.els.get(chat.id);
      if (!el) {
        el = this.create(chat);
        this.els.set(chat.id, el);
        this.layer.appendChild(el);
      }
      if (isCard(chat)) {
        // A card has no process behind it: src/cards.js reads its source on the
        // definition's own cadence and rebuilds the ink when the reading changes.
        this.paintCardTile(el, chat);
      } else {
        const session = sessionFor(chat.id);
        if (!el._unsub) el._unsub = session.on(() => this.paint(el, chat));
        session.open();          // a tile in the world is a live harness
        this.paint(el, chat, session);
      }
      if (el.dataset.dragging !== '1') this.place(el, chat, cam);
      else if (viewChanged) this.place(el, chat, cam);
      // Typeset once the sheet has its block size — and again whenever the
      // tile's preview size changes under us, or a card's ink is redrawn.
      const fs = String(clampFs(chat.fs));
      if (!el.dataset.fitted || el.dataset.fs !== fs || el.dataset.fit === '1') {
        el.dataset.fitted = '1';
        el.dataset.fs = fs;
        el.dataset.fit = '0';
        this.fit(el);
      }
    }
    for (const [id, el] of this.els) {
      if (!live.has(id)) {
        if (el._unsub) el._unsub();
        if (el.dataset.card === '1') dropCard(id);
        el.remove();
        this.els.delete(id);
      }
    }
  }

  paint(el, chat, session) {
    session = session || sessionFor(chat.id);
    if (el.dataset.seq === String(session.seq)) return;
    el.dataset.seq = String(session.seq);

    const state = session.label;
    const stateEl = el.querySelector('.cstate');
    if (stateEl.textContent !== state) stateEl.textContent = state;
    el.dataset.phase = session.phase;
    el.classList.toggle('offline', session.phase === 'offline' || session.phase === 'nobridge');

    const body = el.querySelector('.term-body');
    const lines = session.preview(PREVIEW_LINES);
    const text = lines.length ? lines.join('\n') : 'Ask omp anything — click to open.';
    if (body.textContent !== text) {
      body.textContent = text;
      this.fitSoon(el);        // re-clip at a whole line as the stream grows
    }

    const size = el.querySelector('.size');
    const label = `${chat.w}×${chat.h}`;
    if (size.textContent !== label) size.textContent = label;

    // The preview-size buttons stop at the ends of the range rather than
    // silently swallowing clicks.
    const fs = clampFs(chat.fs);
    el.querySelector('.c-fs-down').disabled = fs <= FS_MIN;
    el.querySelector('.c-fs-up').disabled = fs >= FS_MAX;
  }

  /* ── cards ─────────────────────────────────────────────────────────── */

  /**
   * Bring one card's slab up to date. The reading and the ink come from
   * src/cards.js; all that is left here is the header, which carries the
   * capability's name and the state of its last read.
   */
  paintCardTile(el, chat) {
    paintCard(el, chat);                     // the ink, only when it changed
    const head = headerOf(this.world, chat);
    const title = el.querySelector('.ctitle');
    if (title.textContent !== head.name) title.textContent = head.name;
    const state = el.querySelector('.cstate');
    if (state.textContent !== head.label) state.textContent = head.label;
    if (state.title !== (head.title || '')) state.title = head.title || '';
    el.dataset.phase = head.tone;
    el.classList.toggle('offline', head.tone === 'error');

    const size = el.querySelector('.size');
    const label = `${chat.w}×${chat.h}`;
    if (size.textContent !== label) size.textContent = label;
    const fs = clampFs(chat.fs);
    el.querySelector('.c-fs-down').disabled = fs <= FS_MIN;
    el.querySelector('.c-fs-up').disabled = fs >= FS_MAX;
  }

  /* ── preview typography (the note tile's ladder, over the stream) ──── */

  /** Coalesce refits to one per frame, since the stream rewrites the body. */
  fitSoon(el) {
    this.pendingFit.add(el);
    if (this.fitHandle) return;
    this.fitHandle = requestAnimationFrame(() => {
      this.fitHandle = 0;
      for (const node of this.pendingFit) this.fit(node);
      this.pendingFit.clear();
    });
  }

  /**
   * Typeset the tail like a note's ink: start at the tile's own preview size,
   * step down while that still helps, then clip at a whole line so the slab
   * never shows half a line.
   */
  fit(el) {
    // A shaped card is not text: its ink is a ring, a bar, a keypad or a
    // sparkline, so the ladder below would only move its font size.
    if (el.dataset.card === '1' && el.dataset.layout === 'scale') return this.fitScale(el);
    const body = el.querySelector('.term-body');
    if (!body || !body.clientHeight) return;   // nothing to measure until attached
    body.style.height = '';
    body.style.flex = '';
    const chat = this.world.chat(el.dataset.id);
    let fits = false;
    let lines = 1;
    let lh = 0;
    let pad = 0;
    for (const size of fitLadder(clampFs(chat ? chat.fs : FS_DEFAULT))) {
      body.style.fontSize = size + 'px';
      const cs = getComputedStyle(body);
      lh = parseFloat(cs.lineHeight) || size * 1.3;
      pad = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);
      lines = Math.max(1, Math.floor((body.clientHeight - pad) / lh));
      if (body.scrollHeight <= body.clientHeight + 0.5) { fits = true; break; }
    }
    if (!fits) {
      body.style.flex = '0 0 auto';
      body.style.height = Math.min(body.clientHeight, Math.ceil(pad + lines * lh)) + 'px';
    }
    // The clip is set, so scroll last: a slab shows the newest lines, not the
    // oldest ones that happen to be at the top of the preview.
    body.scrollTop = body.scrollHeight;
    el.classList.toggle('tight', !fits);
    el.dataset.lines = String(lines);
    const badge = el.querySelector('.size');
    if (badge) badge.title = fits ? 'Tile size in blocks' : 'Text is clipped — resize the tile or open the chat';
  }

  /**
   * Scale a shaped card's ink to the slab. Its own preview size is what the
   * ink is drawn at, so `−`/`+` still trade size against room; past that the
   * whole thing shrinks about its middle rather than being clipped, because
   * half a ring says less than a small one.
   */
  fitScale(el) {
    const body = el.querySelector('.term-body');
    if (!body || !body.clientHeight) return;
    body.style.height = '';
    body.style.flex = '';
    const chat = this.world.chat(el.dataset.id);
    body.style.fontSize = clampFs(chat ? chat.fs : FS_DEFAULT) + 'px';
    body.scrollTop = 0;
    const ink = body.firstElementChild;
    if (ink) {
      ink.style.transform = '';
      const iw = ink.scrollWidth;
      const ih = ink.scrollHeight;
      const k = iw && ih ? Math.min(1, body.clientWidth / iw, body.clientHeight / ih) : 1;
      ink.style.transform = k < 0.999 ? `scale(${k.toFixed(3)})` : '';
      el.classList.toggle('tight', k < 0.999);
      const badge = el.querySelector('.size');
      if (badge) badge.title = k < 0.999 ? 'Scaled down to fit the slab — make the tile bigger or press −' : 'Tile size in blocks';
    }
    el.dataset.lines = '1';
  }

  place(el, chat, cam) {
    const o = this.originOf(chat, cam);
    el.style.transform = `translate3d(${o.x}px, ${o.y}px, 0)`;
    el.style.zIndex = String(1000 + Math.round(o.y));

    const [a, b, c, d] = this.matrix(cam);
    const sheet = el.querySelector('.sheet');
    sheet.style.transform = `matrix(${a},${b},${c},${d},0,0)`;

    const w = chat.w * NOTE_U;
    const h = chat.h * NOTE_U;
    sheet.style.width = w + 'px';
    sheet.style.height = h + 'px';
    const hz = sheet.querySelectorAll('.hz');
    this.put(hz[0], w, 0);
    this.put(hz[1], 0, h);
    this.put(hz[2], w, h);
  }

  put(node, left, top) {
    node.style.left = left + 'px';
    node.style.top = top + 'px';
  }

  /* ── DOM ───────────────────────────────────────────────────────────── */

  create(chat) {
    const card = isCard(chat);
    const el = document.createElement('div');
    el.className = 'chat fresh' + (card ? ' card' : '');
    el.dataset.id = chat.id;
    el.dataset.card = card ? '1' : '0';
    el.innerHTML =
      '<div class="sheet">' +
        '<div class="term">' +
          '<div class="term-head"><span class="cdot"></span>' +
            `<span class="ctitle">${card ? 'card' : 'omp'}</span><span class="cstate"></span></div>` +
          '<div class="term-body"></div>' +
        '</div>' +
        '<span class="hz" data-edge="w" title="Drag to resize in blocks"></span>' +
        '<span class="hz" data-edge="h" title="Drag to resize in blocks"></span>' +
        '<span class="hz" data-edge="wh" title="Drag to resize in blocks"></span>' +
      '</div>' +
      '<div class="tools">' +
        '<span class="size"></span>' +
        '<button class="c-fs c-fs-down" title="Smaller preview text">−</button>' +
        '<button class="c-fs c-fs-up" title="Larger preview text">+</button>' +
        '<button class="c-grip" title="Drag to move the tile">⠿</button>' +
        '<button class="c-color" title="Cycle slab colour">●</button>' +
        (card
          ? '<button class="c-refresh" title="Read this card again now">↻</button>'
          : '<button class="c-open" title="Open the harness chat">⤢</button>') +
        `<button class="c-del" title="${card ? 'Delete this card' : 'Delete this harness tile'}">×</button>` +
      '</div>';

    const sheet = el.querySelector('.sheet');
    setTimeout(() => el.classList.remove('fresh'), 200);

    const open = (e) => { e.stopPropagation(); this.hooks.onOpen(chat.id); };
    if (card) {
      // There is no conversation behind a card: its extra button reads its
      // source again, which is what "look at it now" means for a readout.
      el.querySelector('.c-refresh').addEventListener('click', (e) => {
        e.stopPropagation();
        refreshCard(chat.id);
      });
    } else {
      sheet.addEventListener('click', open);
      el.querySelector('.c-open').addEventListener('click', open);
    }
    el.querySelector('.c-del').addEventListener('click', (e) => {
      e.stopPropagation();
      this.hooks.onDelete(chat.id);
    });
    el.querySelector('.c-color').addEventListener('click', (e) => {
      e.stopPropagation();
      this.hooks.onCycleColor(chat.id);
    });
    for (const b of el.querySelectorAll('.c-fs')) {
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        this.hooks.onFontSize(chat.id, b.classList.contains('c-fs-up') ? FS_STEP : -FS_STEP);
      });
    }

    sheet.addEventListener('pointerdown', (e) => e.stopPropagation());
    sheet.addEventListener('dblclick', (e) => e.stopPropagation());

    this.wireGrip(el, sheet, chat);
    for (const hz of sheet.querySelectorAll('.hz')) this.wireHandle(el, hz, chat);
    return el;
  }

  wireGrip(el, sheet, chat) {
    const grip = el.querySelector('.c-grip');
    let drag = null;

    grip.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      grip.setPointerCapture(e.pointerId);
      const cam = this.hooks.cam();
      const local = this.toLocal(e.clientX, e.clientY, chat, cam);
      drag = {
        start: { x: chat.x, y: chat.y },
        grab: {
          i: clamp(Math.floor(local.x / NOTE_U), 0, chat.w - 1),
          j: clamp(Math.floor(local.y / NOTE_U), 0, chat.h - 1),
        },
      };
      el.dataset.dragging = '1';
      el.classList.add('dragging');
      this.hooks.onFocusChat(chat.id);
    });

    const finish = (commit) => {
      if (!drag) return;
      const start = drag.start;
      drag = null;
      delete el.dataset.dragging;
      el.classList.remove('dragging');
      const moved = chat.x !== start.x || chat.y !== start.y;
      if (commit && moved) this.hooks.onDrop(chat.id, start, { x: chat.x, y: chat.y });
      else {
        if (moved && !commit) { chat.x = start.x; chat.y = start.y; }
        this.place(el, chat, this.hooks.cam());
        this.hooks.onResize(chat.id);
      }
    };

    grip.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const hit = this.hooks.pickAt(e.clientX, e.clientY);
      if (!hit) return;
      const nx = hit.x - drag.grab.i;
      const ny = hit.y - drag.grab.j;
      if (nx === chat.x && ny === chat.y) return;
      chat.x = nx;
      chat.y = ny;
      this.place(el, chat, this.hooks.cam());
      this.hooks.onResize(chat.id);
    });

    grip.addEventListener('pointerup', () => finish(true));
    grip.addEventListener('pointercancel', () => finish(false));
  }

  wireHandle(el, hz, chat) {
    const edge = hz.dataset.edge;
    let active = false;
    let start = null;

    hz.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      hz.setPointerCapture(e.pointerId);
      active = true;
      start = { w: chat.w, h: chat.h };
      el.classList.add('resizing');
    });

    hz.addEventListener('pointermove', (e) => {
      if (!active) return;
      const cam = this.hooks.cam();
      const local = this.toLocal(e.clientX, e.clientY, chat, cam);
      const w = edge === 'h' ? chat.w : clamp(Math.round(local.x / NOTE_U), NOTE_MIN, NOTE_MAX);
      const h = edge === 'w' ? chat.h : clamp(Math.round(local.y / NOTE_U), NOTE_MIN, NOTE_MAX);
      if (w === chat.w && h === chat.h) return;
      chat.w = w;
      chat.h = h;
      this.place(el, chat, cam);
      this.fitSoon(el);          // the tile grew or shrank: retypeset the tail
      this.hooks.onResize(chat.id);
    });

    const end = () => {
      if (!active) return;
      active = false;
      el.classList.remove('resizing');
      this.hooks.onResizeEnd(chat.id, start, { w: chat.w, h: chat.h });
      start = null;
    };
    hz.addEventListener('pointerup', end);
    hz.addEventListener('pointercancel', end);
  }
}

/* ── the chat window ─────────────────────────────────────────────────── */

/**
 * The interactive side of a tile: the full transcript, streaming, and an input
 * box. It drives the tile's own OmpSession, so a turn started here shows up on
 * the slab in the world as it runs.
 */
export class ChatWindow {
  constructor(root, hooks = {}) {
    this.root = root;
    this.hooks = hooks;
    this.session = null;
    this.chat = null;
    this.unsub = null;
    this.els = [];               // per-item element, aligned with session.items
    this.sigs = [];              // per-item content signature, to skip redraws
    this.dialogKey = null;
    $('chat-close', root).addEventListener('click', () => this.close());
    $('chat-stop', root).addEventListener('click', () => { if (this.session) this.session.abort(); });
    $('chat-new', root).addEventListener('click', () => this.resetSession());
    this.input = $('chat-input', root);
    this.log = $('chat-log', root);
    this.empty = document.createElement('div');
    this.empty.className = 'ci ci-empty';
    this.empty.textContent = 'Say something to the harness — it is a real omp session rooted in this project.';
    $('chat-send', root).addEventListener('click', () => this.send());
    this.input.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.preventDefault(); this.close(); return; }
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); this.send(); }
      e.stopPropagation();
    });
    this.input.addEventListener('input', () => this.growInput());
    root.addEventListener('mousedown', (e) => { if (e.target === root) this.close(); });
  }

  open(chatId) {
    const chat = this.hooks.chat(chatId);
    if (!chat) return;
    this.chat = chat;
    this.session = sessionFor(chatId);
    if (this.unsub) this.unsub();
    this.unsub = this.session.on(() => this.render());
    this.session.open();
    this.root.hidden = false;
    this.els = [];
    this.sigs = [];
    this.dialogKey = null;
    this.log.textContent = '';
    this.render();
    this.input.focus();
  }

  close() {
    if (this.root.hidden) return;
    this.root.hidden = true;
    this.chat = null;
    this.session = null;
    if (this.unsub) { this.unsub(); this.unsub = null; }
    if (this.hooks.onClose) this.hooks.onClose();
  }

  get isOpen() { return !this.root.hidden; }

  async resetSession() {
    if (!this.session) return;
    await this.session.stop();
    this.session.items = [];
    this.session.tools.clear();
    this.session.current = null;
    this.session.model = null;
    this.els = [];
    this.sigs = [];
    this.log.textContent = '';
    await this.session.restart(true);
    this.render();
  }

  growInput() {
    this.input.style.height = 'auto';
    this.input.style.height = Math.min(160, this.input.scrollHeight) + 'px';
  }

  send() {
    if (!this.session) return;
    const text = this.input.value.trim();
    if (!text) return;
    this.input.value = '';
    this.growInput();
    // While a turn runs, a new line steers it instead of queueing a second turn.
    this.session.prompt(text, this.session.busy ? 'steer' : undefined);
    this.render();
  }

  /* ── rendering ─────────────────────────────────────────────────────── */

  render() {
    const s = this.session;
    if (!s || this.root.hidden) return;
    $('chat-state', this.root).textContent = s.label;
    $('chat-model', this.root).textContent = s.model || '';
    $('chat-dot', this.root).className = 'cdot ' + s.phase;
    $('chat-stop', this.root).disabled = !s.busy;
    this.renderDialog(s);

    const stick = this.log.scrollTop + this.log.clientHeight >= this.log.scrollHeight - 40;

    // Grow/shrink the item list, then redraw only the items that changed.
    while (this.els.length < s.items.length) {
      const el = document.createElement('div');
      this.log.appendChild(el);
      this.els.push(el);
      this.sigs.push(null);
    }
    while (this.els.length > s.items.length) {
      this.els.pop().remove();
      this.sigs.pop();
    }
    for (let i = 0; i < s.items.length; i++) {
      const sig = this.signature(s.items[i]);
      if (sig === this.sigs[i]) continue;
      this.sigs[i] = sig;
      this.els[i].innerHTML = this.itemHtml(s.items[i]);
      this.els[i].className = 'ci ci-' + s.items[i].kind;
    }

    if (this.els.length === 0) {
      this.empty.hidden = false;
      if (this.empty.parentNode !== this.log) this.log.insertBefore(this.empty, this.log.firstChild);
    } else {
      this.empty.hidden = true;
    }
    if (stick) this.log.scrollTop = this.log.scrollHeight;
  }

  /* ── dialogs omp is waiting on ─────────────────────────────────────── */

  /**
   * When omp asks the user something — an approval, a choice, a free-text
   * answer — the chat cannot continue until it is answered, so the request is
   * rendered here and the tile's status bar reads "waiting for input".
   */
  renderDialog(s) {
    const box = $('chat-dialog', this.root);
    const p = s.pending;
    if (!p) {
      if (!box.hidden) { box.hidden = true; box.textContent = ''; this.dialogKey = null; }
      return;
    }
    const key = p.id + ':' + p.method;
    if (this.dialogKey === key) return;      // build once per request
    this.dialogKey = key;
    box.hidden = false;
    box.textContent = '';
    box.appendChild(this.dialogBody(s, p));
  }

  dialogBody(s, p) {
    const r = p.request || {};
    const wrap = document.createElement('div');
    const say = (text) => {
      const d = document.createElement('div');
      d.className = 'dq';
      d.textContent = text;
      wrap.appendChild(d);
      return d;
    };
    const row = () => {
      const d = document.createElement('div');
      d.className = 'drow';
      wrap.appendChild(d);
      return d;
    };
    const btn = (label, fn) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'dopt';
      b.textContent = label;
      b.addEventListener('click', fn);
      return b;
    };
    const textField = (placeholder) => {
      const i = document.createElement('input');
      i.type = 'text';
      i.placeholder = placeholder;
      i.addEventListener('keydown', (e) => e.stopPropagation());
      return i;
    };

    if (p.method === 'confirm') {
      say(r.message || r.title || 'Confirm?');
      const rr = row();
      rr.append(btn('Yes', () => s.respond({ confirmed: true })), btn('No', () => s.respond({ confirmed: false })));
      return wrap;
    }
    if (p.method === 'select') {
      say(r.message || r.title || 'Choose one');
      const rr = row();
      for (const o of r.options || []) rr.appendChild(btn(String(o), () => s.respond({ value: String(o) })));
      return wrap;
    }
    if (p.method === 'input' || p.method === 'editor') {
      say(r.message || r.title || 'omp needs an answer');
      const field = textField(r.placeholder || 'type an answer…');
      field.value = typeof r.value === 'string' ? r.value : '';
      const send = () => s.respond({ value: field.value });
      field.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); send(); }
      });
      const rr = row();
      rr.append(field, btn('Send', send));
      field.focus();
      return wrap;
    }
    if (p.method === 'ask') {
      const questions = Array.isArray(r.questions) ? r.questions : [];
      const picked = questions.map(() => new Set());
      const fields = [];
      questions.forEach((q, i) => {
        say(q.question || q.title || `Question ${i + 1}`);
        const rr = row();
        for (const o of q.options || []) {
          const label = String(o);
          const b = btn(label, () => {
            if (q.multi) {
              if (picked[i].has(label)) picked[i].delete(label); else picked[i].add(label);
            } else {
              picked[i].clear();
              picked[i].add(label);
            }
            for (const sib of rr.querySelectorAll('.dopt')) {
              sib.classList.toggle('on', picked[i].has(sib.textContent));
            }
          });
          rr.appendChild(b);
        }
        const field = textField('or type an answer…');
        fields.push(field);
        rr.appendChild(field);
      });
      const foot = row();
      foot.append(
        btn('Submit', () => s.respond({
          answers: questions.map((q, i) => ({
            id: q.id,
            selectedOptions: [...picked[i]],
            customInput: fields[i].value.trim() || undefined,
          })),
        })),
        btn('Cancel', () => s.respond({ cancelled: true })),
      );
      return wrap;
    }

    say(`omp asked: ${p.method}`);
    const rr = row();
    rr.appendChild(btn('Dismiss', () => s.respond({ cancelled: true })));
    return wrap;
  }

  signature(entry) {
    if (entry.kind === 'user') return 'u:' + entry.text;
    if (entry.kind === 'notice') return 'n:' + entry.text;
    return 'a:' + entry.parts.map((p) => {
      if (p.type !== 'toolCall') return p.type + p.text;
      const t = this.session.tools.get(p.id);
      return 't' + p.name + (t ? t.status + t.output : '') + (t && t.output ? t.output.length : 0);
    }).join('\u0000');
  }

  itemHtml(entry) {
    if (entry.kind === 'user') {
      return `<div class="ci-role">you</div><pre class="ci-text">${esc(entry.text)}</pre>`;
    }
    if (entry.kind === 'notice') {
      return `<div class="ci-role">island</div><pre class="ci-text">${esc(entry.text)}</pre>`;
    }
    const body = entry.parts.map((p) => {
      if (p.type === 'text') return `<pre class="ci-text">${esc(p.text)}</pre>`;
      if (p.type === 'thinking') {
        return `<details class="ci-think"><summary>thinking</summary><pre>${esc(p.text)}</pre></details>`;
      }
      const run = this.session.tools.get(p.id) || {};
      const args = p.args ? JSON.stringify(p.args, null, 1) : (run.args ? JSON.stringify(run.args, null, 1) : '');
      const status = run.status || 'running';
      return '<details class="ci-tool ' + status + '">' +
        `<summary><span class="ci-toolname">${esc(p.name || run.name || 'tool')}</span>` +
        `<span class="ci-toolstatus">${status}</span></summary>` +
        (args ? `<pre class="ci-args">${esc(args)}</pre>` : '') +
        (run.output ? `<pre class="ci-out">${esc(run.output)}</pre>` : '') +
        '</details>';
    }).join('');
    const caret = entry.streaming ? '<span class="ci-caret"></span>' : '';
    return `<div class="ci-role">omp${entry.model ? ' · ' + esc(entry.model) : ''}</div>${body}${caret}`;
  }
}

function $(sel, root) {
  return (root || document).querySelector(sel.startsWith('#') || sel.startsWith('.') ? sel : '#' + sel);
}
