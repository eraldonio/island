// The card runtime: what a card is showing right now.
//
// A card's ink comes from a capability definition (src/caps.js) plus a reading
// of its source, and neither the reading nor the definition belongs in the world
// record — one is transient, the other is a document. So this module keeps the
// live half: one slot per card holding the last reading, its history for a
// sparkline, how long ago it arrived and what went wrong if it did. The tile
// layer (src/harness.js) calls `paintCard` once a frame per card, exactly where
// it would paint a harness transcript.
//
// Where the value comes from is the definition's business, and the only thing
// this module knows about it is a cadence: `schedule()` says how often the tile
// must ask again (a probe every few seconds, a clock every fraction of one, a
// constant never). Asking is asynchronous and single-flight per card, so a slow
// probe can never stack up behind the frame loop, and a card that cannot read
// keeps showing its last value with the reason beside it instead of going blank.

import { normalizeDef, schedule, readSource, viewOf, renderInk, isTextual, pressButton, format } from './caps.js';

let ctx = null;               // { world, save, invalidate } — bound once by main.js
let pumpTimer = 0;

/**
 * How often the runtime looks at its cards. The app draws a frame only when
 * something asks for one, so a card cannot rely on a frame loop to come past:
 * this timer checks each card's cadence, starts the reads that are due, and asks
 * for a frame only when a readout would actually change. A countdown therefore
 * asks for a frame about once a second, a probe when its answer lands, and a
 * card that reads a constant never — and a hidden tab asks for none at all.
 */
const PUMP = 250;

/** Wire the runtime to the app and start watching the clock. */
export function startCards(app) {
  ctx = app;
  clearInterval(pumpTimer);
  pumpTimer = setInterval(pump, PUMP);
  document.addEventListener('visibilitychange', () => {
    // A tab that was in the background comes back to readings that are due; the
    // session's own reconnect heals the harness tiles the same way.
    if (document.visibilityState === 'visible') pump();
  });
}

function pump() {
  const world = ctx && ctx.world;
  if (!world || document.visibilityState === 'hidden') return;
  const now = Date.now();
  let want = false;
  for (const card of world.cards) {
    const found = defOf(world, card);
    if (!found.def) continue;
    const { every } = schedule(found.def);
    const run = slot(card.id);
    // A card with no cadence is still evaluated every tick: its value can come
    // from `now` or from the state a button just wrote, and an expression costs
    // nothing to run. Only a source that has to be asked has a deadline.
    if (every > 0 && !run.inFlight && now - run.readAt >= Math.max(every, MIN_READ)) read(found.def, run);
    const view = viewOf(found.def, run, card.state);
    if (signature(found.def, view, statusOf(found.def, run)) !== run.sig) want = true;
  }
  if (want && ctx.invalidate) ctx.invalidate();
}

/** How long a card waits before it reads its source again, at minimum. */
const MIN_READ = 200;

/** One card's live half: its last reading, and the signature last drawn. */
const slots = new Map();

function slot(id) {
  let s = slots.get(id);
  if (!s) {
    s = {
      raw: undefined, sub: undefined, status: undefined, at: null, error: null,
      history: [], readAt: 0, inFlight: false, sig: null, el: null,
    };
    slots.set(id, s);
    if (slots.size > 200) slots.delete(slots.keys().next().value);
  }
  return s;
}

/** A card that has gone from the island takes its reading with it. */
export function dropCard(id) { slots.delete(id); }

/* ── definitions ─────────────────────────────────────────────────────── */

/**
 * The definition a card runs, or the reason it has none: an inline definition
 * wins, then the named capability, and a name nothing defines is reported as
 * such rather than silently drawing an empty slab.
 */
export function defOf(world, card) {
  if (card.def) return { def: normalizeDef(card.def, card.cap || card.id) };
  const named = card.cap === undefined ? null : world.caps[card.cap];
  if (named) return { def: normalizeDef(named, card.cap) };
  return { def: null, why: `no capability '${card.cap}' on this island — define it or point the card at one` };
}

/* ── reading ─────────────────────────────────────────────────────────── */

const ageLabel = (seconds) => {
  if (seconds === null || seconds === undefined) return '';
  if (seconds < 90) return `${Math.round(seconds)}s`;
  if (seconds < 5400) return `${Math.round(seconds / 60)}m`;
  return `${Math.round(seconds / 3600)}h`;
};

/**
 * What the tile's header says: `live` while a reading is fresh, `stale` once it
 * is older than the definition allows, the failure at the head of the line when
 * one happened, and `waiting` before the first answer arrives.
 */
export function statusOf(def, run) {
  if (!def) return { label: 'unsupported', tone: 'error' };
  if (def.source.kind === 'bad') return { label: 'unsupported', tone: 'error' };
  if (run.error) return { label: 'error', tone: 'error', title: run.error };
  const { every, staleAfter } = schedule(def);
  // A source that answers instantly — a constant, or the clock — has nothing to
  // wait for, so the tile reads live from the first frame rather than sitting on
  // `waiting` for a read that will never come.
  if (run.at === null) return every > 0 ? { label: 'waiting', tone: 'waiting' } : { label: def.badge || 'live', tone: 'live' };
  const age = (Date.now() - run.at) / 1000;
  if (staleAfter && age * 1000 > staleAfter) return { label: `${ageLabel(age)} ago`, tone: 'stale', title: 'this reading is older than the definition allows' };
  return { label: def.badge || 'live', tone: 'live' };
}

function pushHistory(run, value) {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return;
  run.history.push(n);
  if (run.history.length > 60) run.history.splice(0, run.history.length - 60);
}

/** Ask the source once. Never more than one ask in flight for a card. */
async function read(def, run) {
  if (run.inFlight) return;
  run.inFlight = true;
  run.readAt = Date.now();
  try {
    const got = await readSource(def);
    run.raw = got.value;
    run.sub = got.sub;
    run.status = got.status;
    run.at = got.at || Date.now();
    run.error = null;
    pushHistory(run, got.value);
  } catch (err) {
    // The last good value stays on the tile: an unreachable probe is a stale
    // readout with a reason beside it, not a blank card.
    run.error = String((err && err.message) || err);
  } finally {
    run.inFlight = false;
  }
}

/** Read a card again now — the ↻ button, or `island_card op:refresh`. */
export function refreshCard(id) {
  const world = ctx && ctx.world;
  const card = world && world.card(id);
  if (!card) return false;
  const found = defOf(world, card);
  if (!found.def) return false;
  read(found.def, slot(id));
  return true;
}

/* ── painting ────────────────────────────────────────────────────────── */

function signature(def, view, status) {
  return [
    status.tone, status.label,
    format(view.value), view.sub || '', view.problem || '', view.status || '',
  ].join('\u0000');
}

/**
 * Bring one card's ink up to date. Called once a frame from the tile layer, so
 * everything here is cheap until something actually changed: the reading is
 * refreshed only when its cadence says so, and the ink is rebuilt only when its
 * rendering differs from the last one.
 */
export function paintCard(el, card) {
  const world = ctx && ctx.world;
  if (!world) return;
  const run = slot(card.id);
  run.el = el;
  const found = defOf(world, card);
  const body = el.querySelector('.card-body') || el.querySelector('.term-body');

  if (!found.def) {
    if (run.sig !== found.why) {
      run.sig = found.why;
      body.textContent = '';
      const bad = document.createElement('div');
      bad.className = 'card-v';
      bad.dataset.layout = 'text';
      const line = document.createElement('div');
      line.className = 'card-bad';
      line.textContent = found.why;
      bad.append(line);
      body.append(bad);
      el.dataset.layout = 'text';
      body.dataset.layout = 'text';
      el.dataset.fit = '1';
    }
    return el;
  }

  const def = found.def;
  const { every } = schedule(def);
  const now = Date.now();
  if (every > 0 && !run.inFlight && now - run.readAt >= Math.max(every, MIN_READ)) read(def, run);

  const view = viewOf(def, run, card.state);
  const status = statusOf(def, run);
  const sig = signature(def, view, status);
  if (sig === run.sig) return el;

  run.sig = sig;
  const layout = isTextual(def) ? 'text' : 'scale';
  el.dataset.layout = layout;
  body.dataset.layout = layout;
  el.dataset.fit = '1';         // the slab owes it a typeset pass
  body.textContent = '';
  body.append(renderInk(def, view, (button) => press(card, button, view)));
  body.scrollTop = 0;
  return el;
}

/**
 * What the slab's own header says: the capability's name, and the state of its
 * last read — the same place a harness tile reports `working` or `offline`.
 */
export function headerOf(world, card) {
  const found = defOf(world, card);
  const run = slot(card.id);
  const status = statusOf(found.def, run);
  return {
    name: found.def ? found.def.name : 'card',
    label: status.label,
    tone: status.tone,
    title: status.title || (run.at ? `read ${ageLabel((Date.now() - run.at) / 1000)} ago` : 'nothing read yet'),
  };
}

/** A press writes the card's own state, saves, and repaints on the next frame. */
function press(card, button, view) {
  const patch = pressButton(button, view);
  if (!Object.keys(patch).length) return;
  ctx.world.setCardState(card.id, patch);
  const run = slot(card.id);
  run.sig = null;               // the buttons' own `when` may have flipped
  if (ctx.save) ctx.save();
}

/** The value a card currently shows, for the tools that read one back. */
export function readingOf(world, card) {
  const found = defOf(world, card);
  const run = slot(card.id);
  if (!found.def) return { problem: found.why };
  const view = viewOf(found.def, run, card.state);
  const status = statusOf(found.def, run);
  return {
    value: view.value,
    shown: format(view.value),
    sub: view.sub,
    status: status.label,
    tone: status.tone,
    at: run.at,
    error: run.error || view.problem || null,
  };
}

/** Every live reading, for `island_card op:list`. */
export function readings(world) {
  const out = [];
  for (const card of world.cards) out.push(Object.assign({ id: card.id, cap: card.cap || '(inline)' }, readingOf(world, card)));
  return out;
}

/**
 * Read a card once and answer with what it shows. This is how a tool that just
 * placed a card can tell its author the reading instead of only the address —
 * and await the first one, rather than reporting `waiting` for a card that was
 * created this instant.
 */
export async function primeCard(id) {
  const world = ctx && ctx.world;
  const card = world && world.card(id);
  if (!card) return { problem: `no card '${id}'` };
  const found = defOf(world, card);
  if (!found.def) return { problem: found.why };
  const run = slot(id);
  await read(found.def, run);
  return readingOf(world, card);
}
