// Model gallery: the panel of low-poly prefabs, each previewed with the same
// projection and palette the world uses, so a card shows what you will get.

import { MODELS, modelFrames } from './models.js';
import { paintModel } from './render.js';
import { project, ISO } from './iso.js';

const THUMB = 62;      // preview size in css px
const PAD = 7;         // breathing room inside the preview

export class Gallery {
  constructor(root, { onPick }) {
    this.root = root;
    this.onPick = onPick;
    this.id = MODELS.length ? MODELS[0].id : null;
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
