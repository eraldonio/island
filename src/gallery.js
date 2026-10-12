// The prefab panels: cards of models and cards of preconfigured islands, each
// previewed with the same projection and palette the world uses, so a card shows
// what you will get.
//
// The two panels are the same card with a different painter. A model card fits
// one low-poly mesh into its box with `paintModel`; an island card fits a whole
// scene — relief, the elements standing on it and the notes lying on it — with
// `paintScene`.

import { MODELS, modelFrames } from './models.js';
import { ISLANDS, islandScene } from './islands.js';
import { paintModel, paintScene } from './render.js';
import { project, ISO } from './iso.js';

const THUMB = 62;                    // model preview, css px (square)
const PAD = 7;                       // breathing room inside a model preview
const ISLE_W = 108, ISLE_H = 76;     // an island is wide and flat: so is its card
const ISLE_PAD = 6;

/** Size a card's canvas for css `w`x`h` and hand back its context, set up. */
function thumb(canvas, w, h) {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  canvas.style.width = w + 'px';
  canvas.style.height = h + 'px';
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  return ctx;
}

/** One card: a preview canvas, a name, and the click that picks it. */
function card(root, entry, draw, pick) {
  const el = document.createElement('button');
  el.type = 'button';
  el.className = 'mcard';
  el.dataset.id = entry.id;
  el.title = entry.title;
  const canvas = document.createElement('canvas');
  const name = document.createElement('span');
  name.className = 'mname';
  name.textContent = entry.name;
  el.append(canvas, name);
  el.addEventListener('click', () => pick(entry.id));
  root.appendChild(el);
  draw(canvas);
  return el;
}

/** What both panels do with their cards: remember the pick, show or hide. */
class Panel {
  constructor(root, { onPick }) {
    this.root = root;
    this.onPick = onPick;
    this.id = null;
    this.cards = new Map();
  }

  add(entry, draw) {
    this.cards.set(entry.id, card(this.root, entry, draw, (id) => this.pick(id)));
    if (this.id === null) this.id = entry.id;
  }

  pick(id) {
    this.select(id);
    if (this.onPick) this.onPick(id);
  }

  select(id) {
    this.id = id;
    for (const [key, el] of this.cards) el.classList.toggle('active', key === id);
  }

  show(on) { this.root.hidden = !on; }
}

/** The model panel: one card per low-poly prefab, under a heading per source. */
export class Gallery extends Panel {
  constructor(root, opts) {
    super(root, opts);

    // A filter box pinned to the top, because the list is long enough now that
    // scrolling it is not a way to find one model.
    const search = document.createElement('input');
    search.type = 'search';
    search.className = 'gsearch';
    search.placeholder = 'Filter models…';
    search.setAttribute('aria-label', 'Filter models');
    search.addEventListener('input', () => this.filter(search.value));
    search.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();                 // Escape clears the box, not the world
      search.value = '';
      this.filter('');
      search.blur();
    });
    root.appendChild(search);

    // Cards are grouped by provenance — the hand-made models first, then each
    // pack, named the way CREDITS.md names it.
    const groups = new Map();
    for (const model of MODELS) {
      const name = (model.source || 'Hand-made').replace(' (CC0)', '');
      let group = groups.get(name);
      if (!group) {
        const head = document.createElement('div');
        head.className = 'ghead';
        head.textContent = name;
        root.appendChild(head);
        group = { head, cards: [] };
        groups.set(name, group);
      }
      this.add(
        { id: model.id, name: model.name, title: model.source ? `${model.name} — ${model.source}` : model.name },
        (canvas) => this.preview(canvas, model),
      );
      group.cards.push(this.cards.get(model.id));
    }
    this.groups = [...groups.values()];
    this.select(this.id);
  }

  /** Show only the cards whose name, or whose group, matches `query`. */
  filter(query) {
    const needle = query.trim().toLowerCase();
    for (const group of this.groups) {
      let shown = 0;
      const hitGroup = group.head.textContent.toLowerCase().includes(needle);
      for (const el of group.cards) {
        const hit = !needle || hitGroup || el.textContent.toLowerCase().includes(needle);
        el.hidden = !hit;
        if (hit) shown++;
      }
      group.head.hidden = shown === 0;
    }
  }

  get model() { return MODELS.find((m) => m.id === this.id) || null; }

  /** Draw one model into its card, fitted and centred. */
  preview(canvas, model) {
    const ctx = thumb(canvas, THUMB, THUMB);

    // Fit and centre on the model's own world-space bounds: the verts of its
    // first quarter turn, placed by the same origin offset the painters use.
    const frame = modelFrames(model)[0];
    const o = { x: frame.offset.x, y: frame.offset.y, z: 0 };
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const p of frame.verts) {
      const q = project(o.x + p[0], o.y + p[1], o.z + p[2], ISO);
      if (q.x < minX) minX = q.x;
      if (q.x > maxX) maxX = q.x;
      if (q.y < minY) minY = q.y;
      if (q.y > maxY) maxY = q.y;
    }
    const spanX = Math.max(1e-6, maxX - minX);
    const spanY = Math.max(1e-6, maxY - minY);
    const scale = Math.min((THUMB - 2 * PAD) / spanX, (THUMB - 2 * PAD) / spanY);
    const ox = (THUMB - spanX * scale) / 2 - minX * scale;
    const oy = (THUMB - spanY * scale) / 2 - minY * scale;

    paintModel(ctx, frame, { view: ISO, scale, ox, oy });
  }
}

/** The island panel: one card per preconfigured island, whole place previewed. */
export class IslandGallery extends Panel {
  constructor(root, opts) {
    super(root, opts);
    for (const island of ISLANDS) {
      this.add(
        { id: island.id, name: island.name, title: `${island.name} — ${island.blurb}` },
        (canvas) => this.preview(canvas, island),
      );
    }
    this.select(this.id);
  }

  get island() { return ISLANDS.find((i) => i.id === this.id) || null; }

  /** Draw one island into its card: the whole scene, fitted and centred. */
  preview(canvas, island) {
    const ctx = thumb(canvas, ISLE_W, ISLE_H);
    paintScene(ctx, islandScene(island), { view: ISO, w: ISLE_W, h: ISLE_H, pad: ISLE_PAD });
  }
}
