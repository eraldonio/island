// Model gallery: the panel of low-poly prefabs, each previewed with the same
// projection and palette the world uses, so a card shows what you will get.

import { MODELS, modelSize } from './models.js';
import { paintBoxes, shade } from './render.js';
import { project, ISO } from './iso.js';
import { PALETTE } from './world.js';

const THUMB = 62;      // preview size in css px
const PAD = 7;         // breathing room inside the preview

export class Gallery {
  constructor(root, { onPick }) {
    this.root = root;
    this.onPick = onPick;
    this.id = MODELS.length ? MODELS[0].id : null;
    this.colors = PALETTE.map((p) => ({
      top: p.color,
      right: shade(p.color, 0.79),
      left: shade(p.color, 0.6),
    }));
    this.cards = new Map();
    this.build();
  }

  get model() { return MODELS.find((m) => m.id === this.id) || null; }

  build() {
    for (const model of MODELS) {
      const card = document.createElement('button');
      card.type = 'button';
      card.className = 'mcard';
      card.dataset.id = model.id;
      card.title = model.name;
      const canvas = document.createElement('canvas');
      const name = document.createElement('span');
      name.className = 'mname';
      name.textContent = model.name;
      card.append(canvas, name);
      card.addEventListener('click', () => this.pick(model.id));
      this.root.appendChild(card);
      this.cards.set(model.id, card);
      this.preview(canvas, model);
    }
    this.select(this.id);
  }

  pick(id) {
    this.select(id);
    if (this.onPick) this.onPick(id);
  }

  select(id) {
    this.id = id;
    for (const [key, card] of this.cards) card.classList.toggle('active', key === id);
  }

  show(on) {
    this.root.hidden = !on;
  }

  /** Draw one model into its card, fitted and centred. */
  preview(canvas, model) {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(THUMB * dpr);
    canvas.height = Math.round(THUMB * dpr);
    canvas.style.width = THUMB + 'px';
    canvas.style.height = THUMB + 'px';
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, THUMB, THUMB);

    const { w, h } = modelSize(model);
    let top = 1;
    for (const [, , z] of model.voxels) if (z + 1 > top) top = z + 1;

    const corners = [];
    for (const a of [0, w]) {
      for (const b of [0, h]) {
        for (const c of [0, top]) corners.push(project(a, b, c, ISO));
      }
    }
    const xs = corners.map((p) => p.x);
    const ys = corners.map((p) => p.y);
    const minX = Math.min(...xs), maxX = Math.max(...xs);
    const minY = Math.min(...ys), maxY = Math.max(...ys);
    const spanX = Math.max(1, maxX - minX);
    const spanY = Math.max(1, maxY - minY);
    const scale = Math.min((THUMB - 2 * PAD) / spanX, (THUMB - 2 * PAD) / spanY);
    const ox = (THUMB - spanX * scale) / 2 - minX * scale;
    const oy = (THUMB - spanY * scale) / 2 - minY * scale;

    paintBoxes(ctx, model.voxels.map(([x, y, z, mat]) => ({ x, y, z, mat })), {
      view: ISO, scale, ox, oy, colors: this.colors,
    });
  }
}
