// What a card can say, and where the number comes from.
//
// A card is a tile like any other — a footprint, a slab colour, a preview size,
// the same handles and grip — but its ink is neither editable text nor a
// transcript: it is a *capability*, and a capability is data. That is the whole
// point of this module: a harness may author one (see `island://caps/` and the
// `island_card` tool), and nothing an author writes is ever run as code.
//
// A definition names one of a fixed set of sources and one of a fixed set of
// renderers, and this file is the entire vocabulary:
//
//   source   value   a constant the author wrote
//            clock   the wall clock, for anything that counts down
//            probe   a named read the dev server performs (git, cpu, mem, …)
//            http    a GET the dev server proxies, so a page needs no CORS
//            (omitted is the same as a `value` source holding null)
//   value    an expression over `v` (the source's value), `now` and `state`,
//            which is where arithmetic, thresholds and timers live
//   render   one of a handful of readouts: a number, flowing text, a list, a
//            table, a ring, a bar, a sparkline, a keypad
//   buttons  a keypad or a ▶/⏸/⟲ row: each press runs small `set` expressions
//            against the card's own `state`
//
// An unknown source, renderer or function renders as "unsupported: …" on the
// tile instead of throwing, so a definition written by a model that overreached
// is readable, fixable and deletable — never a broken page.
//
// Expressions are parsed here, not `eval`ed. The grammar is arithmetic with
// comparisons, `&&`/`||`/`!`, `?:`, member access on the scope object only, and
// calls to a fixed function table — no assignment, no indexing, no loops, and
// no way to reach anything the caller did not put in the scope.

const DT = 0.25;               // seconds between clock ticks a card is worth
const FETCH_MS = 6000;         // deadline for one probe or proxied fetch
const HISTORY = 40;            // samples kept for a sparkline
const STALE_FACTOR = 4;        // `staleAfter` defaults to this many `every`s

/* ── the expression language ─────────────────────────────────────────── */

const TYPES = new Set(['number', 'string', 'boolean', 'object', 'undefined']);

const num = (v) => (typeof v === 'number' ? v : typeof v === 'boolean' ? (v ? 1 : 0) : v === '' || v == null ? 0 : Number(v));
const truthy = (v) => (typeof v === 'string' ? v !== '' : typeof v === 'number' ? v !== 0 && !Number.isNaN(v) : !!v);

// A null-prototype table, looked up by own key only: a definition that names
// `constructor` or `toString` gets "unknown function", not Object.prototype.
const FUNCS = Object.freeze(Object.assign(Object.create(null), {
  min: Math.min, max: Math.max, abs: Math.abs,
  round: (x, d) => { const p = 10 ** (d === undefined ? 0 : num(d)); return Math.round(num(x) * p) / p; },
  floor: Math.floor, ceil: Math.ceil, sqrt: Math.sqrt,
  pow: (a, b) => num(a) ** num(b), sign: Math.sign,
  clamp: (x, lo, hi) => Math.min(num(hi), Math.max(num(lo), num(x))),
  len: (x) => (Array.isArray(x) ? x.length : String(x ?? '').length),
  str: (x) => format(x),
  num: (x) => num(x),
  pct: (a, b) => (num(b) ? Math.round((num(a) / num(b)) * 1000) / 10 : 0),
  // A calculator's display is a string an author builds a character at a time;
  // `calc` turns it back into a number with this same grammar.
  calc: (x) => {
    const text = String(x ?? '').trim();
    if (!text) return 0;
    try { return evaluate(text, {}); } catch { return 'err'; }
  },
  if: (c, a, b) => (truthy(c) ? a : b),
}));

const hasFunc = (name) => Object.prototype.hasOwnProperty.call(FUNCS, name);
const hasKey = (obj, key) => !!obj && typeof obj === 'object' && Object.prototype.hasOwnProperty.call(obj, key);

/** A number or string as a card would print it: no trailing `.0`, clipped. */
export function format(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) return String(v);
    return Number.isInteger(v) ? String(v) : String(Math.round(v * 1000) / 1000);
  }
  if (Array.isArray(v)) return v.map(format).join('\n');
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

const MULTI = ['==', '!=', '<=', '>=', '&&', '||', '**'];
const SINGLE = '+-*/%^<>!?:().,';
const ALIAS = { '×': '*', '÷': '/', '−': '-' };

function lex(src) {
  const out = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) { i++; continue; }
    if (ALIAS[c]) { out.push({ t: 'op', v: ALIAS[c] }); i++; continue; }
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(src[i + 1] || ''))) {
      let j = i + 1;
      while (j < src.length && /[0-9._]/.test(src[j])) j++;
      const text = src.slice(i, j).replace(/_/g, '');
      out.push({ t: 'num', v: Number(text) });
      i = j;
      continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      let s = '';
      while (j < src.length && src[j] !== c) {
        if (src[j] === '\\' && j + 1 < src.length) { j++; s += src[j]; } else s += src[j];
        j++;
      }
      if (j >= src.length) throw new Error('unterminated string');
      out.push({ t: 'str', v: s });
      i = j + 1;
      continue;
    }
    if (/[A-Za-z_$]/.test(c)) {
      let j = i;
      while (j < src.length && /[A-Za-z0-9_$]/.test(src[j])) j++;
      out.push({ t: 'name', v: src.slice(i, j) });
      i = j;
      continue;
    }
    const two = src.slice(i, i + 2);
    if (MULTI.includes(two)) { out.push({ t: 'op', v: two }); i += 2; continue; }
    if (SINGLE.includes(c)) { out.push({ t: 'op', v: c }); i++; continue; }
    throw new Error(`unexpected '${c}'`);
  }
  return out;
}

/**
 * Compile one expression to a closure over a scope object. Parsing happens once
 * per distinct string (cached below); evaluating is then a walk of closures with
 * no further allocation beyond the values themselves.
 */
function compile(src) {
  const toks = lex(String(src));
  let p = 0;
  const peek = () => toks[p];
  const isOp = (v) => { const t = toks[p]; return t && t.t === 'op' && t.v === v; };
  const eat = (v) => { if (!isOp(v)) throw new Error(`expected '${v}'`); p++; return v; };

  const parsed = parseTernary();
  if (p < toks.length) throw new Error(`unexpected '${toks[p].v}'`);
  return parsed;

  function primary() {
    const t = peek();
    if (!t) throw new Error('unexpected end of expression');
    if (t.t === 'num' || t.t === 'str') { p++; return () => t.v; }
    if (t.t === 'op' && t.v === '(') { p++; const inner = parseTernary(); eat(')'); return inner; }
    if (t.t === 'name') {
      p++;
      const name = t.v;
      if (isOp('(')) {
        p++;
        const args = [];
        if (!isOp(')')) {
          args.push(parseTernary());
          while (isOp(',')) { p++; args.push(parseTernary()); }
        }
        eat(')');
        if (!hasFunc(name)) throw new Error(`unknown function '${name}'`);
        const fn = FUNCS[name];
        if (args.length > 3) throw new Error(`'${name}' takes at most 3 arguments`);
        return (scope) => fn(...args.map((a) => a(scope)));
      }
      if (name === 'true') return () => true;
      if (name === 'false') return () => false;
      return (scope) => {
        // A name the author did not get from the scope is almost always a state
        // key written bare. Say so, rather than reading it as nothing and
        // quietly drawing a zero.
        if (!scope || !(name in scope)) {
          const hint = hasKey(scope && scope.state, name) ? ` — did you mean state.${name}?` : '';
          throw new Error(`unknown name '${name}'${hint}`);
        }
        return scope[name];
      };
    }
    throw new Error(`unexpected '${t.v}'`);
  }

  function postfix() {
    let node = primary();
    while (isOp('.') || isOp('(')) {
      if (isOp('.')) {
        p++;
        const t = peek();
        if (!t || t.t !== 'name') throw new Error('expected a property name');
        p++;
        const key = t.v;
        const base = node;
        node = (scope) => {
          const obj = base(scope);
          // Own properties of a scope object only, so `state.left` is the whole
          // of the property access an author gets — `__proto__` and friends are
          // simply names that are not there.
          return hasKey(obj, key) ? obj[key] : undefined;
        };
      } else {
        throw new Error('a value is not callable');
      }
    }
    return node;
  }

  function unary() {
    if (isOp('-')) { p++; const a = unary(); return (s) => -num(a(s)); }
    if (isOp('+')) { p++; const a = unary(); return (s) => num(a(s)); }
    if (isOp('!')) { p++; const a = unary(); return (s) => !truthy(a(s)); }
    return power();
  }

  function power() {
    const base = postfix();
    if (isOp('^') || isOp('**')) { p++; const exp = unary(); return (s) => num(base(s)) ** num(exp(s)); }
    return base;
  }

  function mul() {
    let node = unary();
    while (isOp('*') || isOp('/') || isOp('%')) {
      const op = toks[p].v;
      p++;
      const rhs = unary();
      const lhs = node;
      node = (s) => {
        const a = num(lhs(s));
        const b = num(rhs(s));
        if (op === '*') return a * b;
        if (op === '%') return b === 0 ? NaN : a % b;
        return b === 0 ? NaN : a / b;
      };
    }
    return node;
  }

  function add() {
    let node = mul();
    while (isOp('+') || isOp('-')) {
      const op = toks[p].v;
      p++;
      const rhs = mul();
      const lhs = node;
      node = (s) => {
        const a = lhs(s);
        const b = rhs(s);
        // `+` concatenates when either side is a string: a calculator builds its
        // display one keypress at a time.
        if (op === '+') {
          if (typeof a === 'string' || typeof b === 'string') return format(a) + format(b);
          return num(a) + num(b);
        }
        return num(a) - num(b);
      };
    }
    return node;
  }

  function compare() {
    let node = add();
    while (isOp('==') || isOp('!=') || isOp('<=') || isOp('>=') || isOp('<') || isOp('>')) {
      const op = toks[p].v;
      p++;
      const rhs = add();
      const lhs = node;
      node = (s) => {
        const a = lhs(s);
        const b = rhs(s);
        if (op === '==') return format(a) === format(b);
        if (op === '!=') return format(a) !== format(b);
        if (typeof a === 'string' && typeof b === 'string') {
          return op === '<' ? a < b : op === '<=' ? a <= b : op === '>' ? a > b : a >= b;
        }
        const x = num(a);
        const y = num(b);
        return op === '<' ? x < y : op === '<=' ? x <= y : op === '>' ? x > y : x >= y;
      };
    }
    return node;
  }

  function andor() {
    let node = compare();
    while (isOp('&&') || isOp('||')) {
      const op = toks[p].v;
      p++;
      const rhs = compare();
      const lhs = node;
      node = op === '&&'
        ? (s) => (truthy(lhs(s)) ? rhs(s) : lhs(s))
        : (s) => (truthy(lhs(s)) ? lhs(s) : rhs(s));
    }
    return node;
  }

  function parseTernary() {
    const cond = andor();
    if (!isOp('?')) return cond;
    p++;
    const a = parseTernary();
    eat(':');
    const b = parseTernary();
    return (s) => (truthy(cond(s)) ? a(s) : b(s));
  }
}

const CACHE = new Map();

/** The compiled form of an expression, or a throw the caller turns into text. */
function compiled(src) {
  let fn = CACHE.get(src);
  if (!fn) {
    fn = compile(src);
    if (CACHE.size > 500) CACHE.clear();
    CACHE.set(src, fn);
  }
  return fn;
}

/** Evaluate an expression against a scope, e.g. `{ v, now, state }`. */
export function evaluate(src, scope) {
  return compiled(String(src))(scope || {});
}

/** The value of an expression, with a bad one coming back as readable text. */
function safe(src, scope) {
  try {
    return evaluate(src, scope);
  } catch (err) {
    return { __error: String((err && err.message) || err) };
  }
}

const isError = (v) => !!(v && typeof v === 'object' && '__error' in v);

/* ── sources ─────────────────────────────────────────────────────────── */

export const CAP_SOURCES = ['value', 'clock', 'probe', 'http'];
export const CAP_RENDERERS = ['number', 'text', 'list', 'table', 'ring', 'bar', 'spark', 'keypad'];
export const CAP_FUNCS = Object.keys(FUNCS).sort();
export const CAP_PROBES = ['git', 'cpu', 'mem', 'sh'];
export const CAP_VARS = ['v', 'sub', 'status', 'age', 'at', 'raw', 'state', 'now', 'error'];

// The renderers whose ink flows like text, so the tile's fit ladder typesets
// them (`harness.js`): the rest are shaped, and are scaled to the tile instead.
const TEXTUAL = new Set(['number', 'text', 'list', 'table']);

const asText = (v, fallback = '') => (v === undefined || v === null ? fallback : String(v));

/** A source as this module uses it: known kind, and the fields that kind has. */
function normalizeSource(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const kind = CAP_SOURCES.includes(src.kind) ? src.kind : (src.kind === undefined ? 'value' : null);
  if (!kind) return { kind: 'bad', why: `unknown source '${src.kind}'; sources: ${CAP_SOURCES.join(', ')}` };
  if (kind === 'value') return { kind, value: src.value === undefined ? null : src.value };
  if (kind === 'clock') return { kind, step: clampStep(src.step) };
  if (kind === 'probe') {
    if (!src.probe) return { kind: 'bad', why: 'a probe source needs a `probe` name' };
    return { kind, probe: String(src.probe), args: plainObject(src.args), every: ms(src.every, 5000) };
  }
  if (kind === 'http') {
    if (!src.url) return { kind: 'bad', why: 'an http source needs a `url`' };
    return { kind, url: String(src.url), json: src.json === undefined ? null : String(src.json), every: ms(src.every, 60000) };
  }
  return { kind };
}

function plainObject(v) {
  const out = {};
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    for (const [k, val] of Object.entries(v)) {
      if (typeof val === 'string' || typeof val === 'number' || typeof val === 'boolean') out[k] = val;
    }
  }
  return out;
}

const ms = (v, fallback) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.min(3600_000, Math.max(100, Math.round(n))) : fallback;
};

const clampStep = (v) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.max(DT, Math.min(60, n)) : DT;
};

/** How often the tile has to recompute, and when its value reads as stale. */
export function schedule(def) {
  const src = normalizeSource(def && def.source);
  const every = src.kind === 'probe' || src.kind === 'http'
    ? src.every
    : src.kind === 'clock' ? src.step * 1000 : 0;
  const staleAfter = ms(def && def.staleAfter, every ? every * STALE_FACTOR : 0);
  return { every, staleAfter, source: src };
}

/** Fetch one probe or proxied URL from the dev server, with a deadline. */
async function call(path) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), FETCH_MS);
  try {
    const res = await fetch(path, { signal: ac.signal });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body && body.error ? body.error : `${res.status} ${res.statusText}`);
    return body;
  } finally {
    clearTimeout(timer);
  }
}

/** The dotted path an http source picks out of a JSON body, e.g. `current.temp`. */
function pick(body, path) {
  const root = body && typeof body === 'object' && 'value' in body ? body.value : body;
  if (!path) return root;
  let node = root;
  for (const key of path.split('.')) {
    if (node === null || node === undefined) return undefined;
    node = node[Number.isInteger(Number(key)) ? Number(key) : key];
  }
  return node;
}

/**
 * The source's own reading, before any expression touches it: `{ value, sub,
 * status, at }`. A source that cannot answer throws, and the tile shows why.
 */
export async function readSource(def) {
  const src = normalizeSource(def && def.source);
  const at = Date.now();
  if (src.kind === 'bad') throw new Error(src.why);
  if (src.kind === 'value') return { value: src.value, at, status: 'ok' };
  if (src.kind === 'clock') return { value: at / 1000, at, status: 'ok' };
  if (src.kind === 'probe') {
    const qs = new URLSearchParams(src.args).toString();
    const body = await call(`/api/probe/${encodeURIComponent(src.probe)}${qs ? `?${qs}` : ''}`);
    return { value: body.value, sub: body.sub, status: body.status || 'ok', at: body.at || at };
  }
  const body = await call(`/api/fetch?url=${encodeURIComponent(src.url)}`);
  return { value: pick(body, src.json), sub: undefined, status: body.status ? String(body.status) : 'ok', at: body.at || at };
}

/* ── definitions ─────────────────────────────────────────────────────── */

/**
 * A capability definition, with every default filled in and every unknown left
 * as itself so `catalog()` can name it back to the author.
 */
export function normalizeDef(raw, id) {
  const def = raw && typeof raw === 'object' ? raw : {};
  const render = def.render && typeof def.render === 'object' ? def.render : {};
  return {
    id: asText(def.id || id, ''),
    name: asText(def.name, asText(def.id || id, 'card')),
    badge: asText(def.badge, ''),
    desc: asText(def.desc, ''),
    source: def.source === undefined ? { kind: 'value', value: null } : normalizeSource(def.source),
    value: def.value === undefined ? null : String(def.value),
    render: {
      as: asText(render.as, 'number'),
      label: asText(render.label, ''),
      unit: asText(render.unit, ''),
      decimals: Number.isFinite(Number(render.decimals)) ? Math.max(0, Math.min(4, Number(render.decimals))) : null,
      max: render.max === undefined ? null : String(render.max),
      tone: render.tone === undefined ? null : String(render.tone),
      rows: Array.isArray(render.rows) ? render.rows.map(String) : null,
      display: render.display === undefined ? null : String(render.display),
    },
    buttons: Array.isArray(def.buttons) ? def.buttons.map(normalizeButton).filter(Boolean) : [],
    state: plainState(def.state),
    every: def.every === undefined ? null : ms(def.every, null),
    staleAfter: def.staleAfter === undefined ? null : ms(def.staleAfter, null),
  };
}

function normalizeButton(raw) {
  if (!raw || typeof raw !== 'object' || !raw.label) return null;
  const set = {};
  if (raw.set && typeof raw.set === 'object' && !Array.isArray(raw.set)) {
    for (const [k, v] of Object.entries(raw.set)) set[k] = String(v);
  }
  return {
    label: asText(raw.label),
    title: asText(raw.title, ''),
    after: asText(raw.after, ''),      // a literal appended to `state[into]`
    into: asText(raw.into, 'expr'),    // the state key a keypad key appends to
    set,
    when: raw.when === undefined ? null : String(raw.when),
    wide: !!raw.wide,
  };
}

function plainState(v) {
  const out = {};
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    for (const [k, val] of Object.entries(v)) {
      if (typeof val === 'string' || typeof val === 'number' || typeof val === 'boolean') out[k] = val;
    }
  }
  return out;
}

/** A definition's text, exactly as an author would write it back. */
export function defJSON(def) {
  return JSON.stringify(def, null, 1) + '\n';
}

/** True when the renderer lays out like text and the tile should typeset it. */
export const isTextual = (def) => TEXTUAL.has(def && def.render && def.render.as);

/* ── rendering one reading ───────────────────────────────────────────── */

/**
 * Everything a renderer needs: the source's reading, the author's expression
 * applied to it, and the history a sparkline draws. `value` is `null` when the
 * expression itself failed, in which case `problem` says why.
 *
 * The card's own state comes in from the world record (it is saved with the
 * card), layered over the definition's defaults so a card that has never been
 * pressed still has every key its expressions expect.
 */
export function viewOf(def, runtime, cardState) {
  const state = Object.assign({}, def.state, cardState || {});
  const now = Date.now() / 1000;
  const scope = {
    v: runtime.raw,
    raw: runtime.raw,
    sub: runtime.sub,
    status: runtime.status,
    at: runtime.at,
    age: runtime.at ? Math.max(0, Math.round((Date.now() - runtime.at) / 1000)) : null,
    state,
    now,
    error: runtime.error || null,
  };
  let value = scope.v;
  let problem = null;
  if (runtime.error) problem = runtime.error;
  else if (def.value) {
    const got = safe(def.value, scope);
    if (isError(got)) problem = `bad expression: ${got.__error}`;
    else value = got;
  }
  return { scope, value, problem, state, now, history: runtime.history || [], status: runtime.status, sub: runtime.sub, at: runtime.at, age: scope.age };
}

const el = (tag, cls, text) => {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined && text !== null && text !== '') node.textContent = String(text);
  return node;
};

/** A number as the renderer's decimals and unit ask for it. */
function shown(def, v) {
  const r = def.render;
  if (typeof v === 'number' && Number.isFinite(v)) {
    // `decimals` is the author's explicit choice; without it a card gets the
    // same three-digit courtesy `format` gives every other number, rather than
    // a float's full thirteen digits.
    const x = r.decimals === null ? format(v) : v.toFixed(r.decimals);
    return `${x}${r.unit}`;
  }
  return `${format(v)}${v === '' || v === null ? '' : r.unit}`;
}

function ring(def, view) {
  const max = maxOf(def, view);
  const v = num(view.value);
  const frac = max > 0 ? Math.min(1, Math.max(0, v / max)) : 0;
  const R = 15.9;
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 40 40');
  svg.setAttribute('class', 'card-ring');
  const track = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
  track.setAttribute('cx', '20');
  track.setAttribute('cy', '20');
  track.setAttribute('r', String(R));
  track.setAttribute('class', 'ring-track');
  const arc = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
  arc.setAttribute('cx', '20');
  arc.setAttribute('cy', '20');
  arc.setAttribute('r', String(R));
  arc.setAttribute('class', 'ring-arc');
  arc.setAttribute('stroke-dasharray', `${(2 * Math.PI * R).toFixed(2)}`);
  arc.setAttribute('stroke-dashoffset', `${(2 * Math.PI * R * (1 - frac)).toFixed(2)}`);
  arc.setAttribute('transform', 'rotate(-90 20 20)');
  svg.append(track, arc);
  const wrap = el('div', 'card-ringwrap');
  wrap.append(svg, el('span', 'card-ringval', shown(def, view.value)));
  return wrap;
}

function bar(def, view) {
  const max = maxOf(def, view);
  const frac = max > 0 ? Math.min(1, Math.max(0, num(view.value) / max)) : 0;
  const wrap = el('div', 'card-bar');
  const fill = el('div', 'card-barfill');
  fill.style.width = `${(frac * 100).toFixed(1)}%`;
  wrap.append(fill, el('span', 'card-barval', shown(def, view.value)));
  return wrap;
}

function spark(def, view) {
  const pts = view.history.slice(-HISTORY).map(num).filter((n) => Number.isFinite(n));
  const wrap = el('div', 'card-spark');
  if (pts.length < 2) { wrap.append(el('span', 'card-sparkval', shown(def, view.value))); return wrap; }
  const lo = Math.min(...pts);
  const hi = Math.max(...pts);
  const span = hi - lo || 1;
  const d = pts.map((n, i) => `${((i / (pts.length - 1)) * 100).toFixed(2)},${(24 - ((n - lo) / span) * 22).toFixed(2)}`);
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 100 26');
  svg.setAttribute('preserveAspectRatio', 'none');
  svg.setAttribute('class', 'spark-line');
  const line = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
  line.setAttribute('points', d.join(' '));
  svg.append(line);
  wrap.append(svg, el('span', 'card-sparkval', shown(def, view.value)));
  return wrap;
}

function table(def, view) {
  const rows = Array.isArray(view.value) ? view.value : [];
  const t = el('table', 'card-table');
  const heads = def.render.rows;
  if (heads) {
    const tr = el('tr');
    for (const h of heads) tr.append(el('th', null, h));
    t.append(tr);
  }
  for (const row of rows.slice(0, 20)) {
    const tr = el('tr');
    const cells = Array.isArray(row) ? row : [row];
    for (const c of cells) tr.append(el('td', null, format(c)));
    t.append(tr);
  }
  return t;
}

const maxOf = (def, view) => {
  const m = def.render.max;
  if (m === null) return 0;
  const got = safe(m, view.scope);
  const n = num(isError(got) ? NaN : got);
  return Number.isFinite(n) ? n : 0;
};

/**
 * What one press writes into the card's state. A `set` entry is an expression
 * over the same scope the card's value uses (`state` included, so `left - (now -
 * at)` can pause a timer); `after`/`into` is the literal a keypad appends.
 * A button whose expression will not parse writes the error text, which is the
 * one place a bad author is visible on the tile itself.
 */
export function pressButton(button, view) {
  const patch = {};
  for (const [key, expr] of Object.entries(button.set)) {
    const got = safe(expr, view.scope);
    if (isError(got)) patch[key] = `!${got.__error}`;
    else if (got === null || got === undefined) patch[key] = '';
    else if (typeof got === 'number' || typeof got === 'string' || typeof got === 'boolean') patch[key] = got;
    else patch[key] = format(got);
  }
  if (button.after) {
    const into = button.into || 'expr';
    patch[into] = String(view.scope.state[into] ?? '') + button.after;
  }
  return patch;
}

/** One button's row, wired to the card's own `state` (never to the world). */
function keys(def, view, onPress) {
  const wrap = el('div', `card-keys${def.render.as === 'keypad' ? ' keypad' : ''}`);
  for (const b of def.buttons) {
    const node = el('button', 'card-key' + (b.wide ? ' wide' : ''), b.label);
    if (b.title) node.title = b.title;
    if (b.when) {
      const got = safe(b.when, view.scope);
      if (!isError(got) && !truthy(got)) node.disabled = true;
    }
    node.addEventListener('pointerdown', (e) => e.stopPropagation());
    node.addEventListener('click', (e) => { e.stopPropagation(); onPress(b); });
    wrap.append(node);
  }
  return wrap;
}

/**
 * The ink of a card: a value, a caption, and whatever the renderer adds around
 * them. `onPress` is how a button reaches the card's state — the tile passes
 * its own writer, so nothing here knows about the world.
 */
export function renderInk(def, view, onPress) {
  const root = el('div', 'card-v');
  root.dataset.layout = isTextual(def) ? 'text' : 'scale';

  // `tone` is the one bit of styling an author gets: an expression that names a
  // mood ("ok", "warn", "bad"), which the stylesheet paints the value with.
  if (def.render.tone) {
    const got = safe(def.render.tone, view.scope);
    const word = isError(got) ? '' : String(got || '').trim().toLowerCase().replace(/[^a-z0-9-]/g, '');
    if (word) root.classList.add(`tone-${word}`);
    if (isError(got)) view = Object.assign({}, view, { problem: view.problem || `bad tone expression: ${got.__error}` });
  }

  if (view.problem) {
    root.append(el('div', 'card-bad', view.problem.split('\n')[0]));
    if (def.buttons.length) root.append(keys(def, view, onPress));
    return root;
  }

  const as = def.render.as;
  if (!CAP_RENDERERS.includes(as)) root.append(el('div', 'card-bad', `unsupported renderer '${as}'; renderers: ${CAP_RENDERERS.join(', ')}`));
  else if (as === 'ring') root.append(ring(def, view));
  else if (as === 'bar') root.append(bar(def, view));
  else if (as === 'spark') root.append(spark(def, view));
  else if (as === 'table') root.append(table(def, view));
  else if (as === 'list') {
    const items = Array.isArray(view.value) ? view.value : String(format(view.value)).split('\n');
    const list = el('ul', 'card-list');
    for (const it of items.slice(0, 12)) list.append(el('li', null, format(it)));
    root.append(list);
  } else if (as === 'text') root.append(el('div', 'card-text', format(view.value)));
  else root.append(el('div', 'card-num', shown(def, view.value)));

  if (as === 'keypad' && def.render.display) {
    const got = safe(def.render.display, view.scope);
    root.prepend(el('div', 'card-display', isError(got) ? '' : format(got)));
  }
  const sub = [def.render.label, view.sub].filter(Boolean).join(' · ');
  if (sub) root.append(el('div', 'card-sub', sub));
  if (def.buttons.length) root.append(keys(def, view, onPress));
  return root;
}

/* ── the catalog ─────────────────────────────────────────────────────── */

/**
 * The vocabulary, as the author reads it: what a source can be, what a renderer
 * draws, what an expression may say. `island://caps/` serves this text, so the
 * description of the language can never drift from the language itself.
 */
export function catalog(world) {
  const L = [];
  L.push('# Cards');
  L.push('');
  L.push('A card is a tile whose ink is a readout. It is described by data, never');
  L.push('by code: pick a source for the number, a renderer for the shape, and an');
  L.push('expression for anything arithmetic in between.');
  L.push('');
  L.push('## A definition');
  L.push('');
  L.push('```json');
  L.push(defJSON(exampleDef()).trimEnd());
  L.push('```');
  L.push('');
  L.push(`- \`source.kind\` — ${CAP_SOURCES.map((k) => `\`${k}\``).join(', ')}`);
  L.push('  - `value` — a constant you write (`source.value`).');
  L.push('  - `clock` — the wall clock; `v` is epoch seconds. Use `now` for arithmetic.');
  L.push(`  - \`probe\` — a read the dev server performs: ${CAP_PROBES.map((p) => `\`${p}\``).join(', ')} (see \`island://caps/probes\`).`);
  L.push('  - `http` — a GET the dev server proxies (no CORS, no token in the page); `url`, optional `json` dotted path, `every` ms.');
  L.push('- `value` — an expression over `v` (the source reading), `now`, `state`, `sub`, `status`, `age`. Omit to show `v`.');
  L.push(`- \`render.as\` — ${CAP_RENDERERS.map((r) => `\`${r}\``).join(', ')}; plus \`label\`, \`unit\`, \`decimals\`, \`max\`, \`display\` (keypad) and \`rows\` (table headers).`);
  L.push('- `buttons` — `[{ label, when, set: { key: expr } }]` pressed by the user; each `set` expression runs against `state` and the result is stored on the card. `{ label: "7", after: "7", into: "expr" }` appends text to a state key (a calculator).');
  L.push('- `state` — the card\'s own scratch values, saved with it and never an edit (a timer keeps counting across a reload).');
  L.push('');
  L.push('## Expressions');
  L.push('');
  L.push('Arithmetic (`+ - * / % ^`), comparisons, `&& || !`, `?:`, parentheses, and');
  L.push('strings. There is no assignment, no indexing and no way to reach anything');
  L.push('outside the scope above.');
  L.push('');
  L.push(`Functions: ${CAP_FUNCS.map((f) => `\`${f}()\``).join(', ')}.`);
  L.push('Variables: ' + CAP_VARS.map((v) => `\`${v}\``).join(', ') + '.');
  L.push('');
  L.push('## Worked examples');
  L.push('');
  L.push('A countdown that survives a reload, with real buttons:');
  L.push('');
  L.push('```json');
  L.push(defJSON(pomodoroDef()).trimEnd());
  L.push('```');
  L.push('');
  L.push('A calculator: `state.expr` is the string the keypad builds, and `calc()`');
  L.push('turns it back into a number.');
  L.push('');
  L.push('```json');
  L.push(defJSON(calcDef()).trimEnd());
  L.push('```');
  L.push('');
  if (world) {
    const ids = Object.keys(world.caps || {}).sort();
    L.push('## Capabilities on this island');
    L.push('');
    L.push(ids.length ? ids.map((id) => `- \`${id}\` — ${asText(world.caps[id].name, id)}`).join('\n') : '(none defined yet)');
    L.push('');
    const cards = (world.chats || []).filter((c) => c.cap);
    L.push('## Cards on this island');
    L.push('');
    L.push(cards.length ? cards.map((c) => `- \`${c.id}\` — ${c.cap} at ${c.x},${c.y} ${c.w}×${c.h}`).join('\n') : '(none)');
    L.push('');
  }
  return L.join('\n');
}

/* ── the examples the catalog teaches with ───────────────────────────── */

/** A countdown with a ring, three buttons and no server: a card can keep time. */
export function pomodoroDef() {
  return {
    id: 'countdown',
    name: 'Countdown',
    badge: 'timer',
    desc: 'Runs a countdown; ▶ starts it, ⏸ pauses, ⟲ resets.',
    source: { kind: 'clock' },
    state: { running: 0, left: 1500, at: 0 },
    value: 'state.running ? max(0, round(state.left - (now - state.at))) : state.left',
    render: { as: 'ring', max: '1500', label: 'seconds left', tone: 'state.left <= 0 ? "ok" : ""' },
    buttons: [
      { label: '▶', title: 'Start', when: '!state.running', set: { running: '1', at: 'now' } },
      { label: '⏸', title: 'Pause', when: 'state.running', set: { running: '0', left: 'max(0, round(state.left - (now - state.at)))' } },
      { label: '⟲', title: 'Reset', set: { running: '0', left: '1500', at: 'now' } },
    ],
  };
}

/** A calculator: state is a string, `calc` is the expression, keys append. */
export function calcDef() {
  const keys = ['7', '8', '9', '/', '4', '5', '6', '*', '1', '2', '3', '-', '0', '.', 'C', '+'];
  return {
    id: 'calculator',
    name: 'Calculator',
    badge: 'calc',
    desc: 'A keypad over its own state; the display shows the sum as you type it.',
    state: { expr: '' },
    value: 'calc(state.expr)',
    render: { as: 'keypad', display: 'state.expr', label: '' },
    buttons: keys.map((k) => (k === 'C'
      ? { label: 'C', title: 'Clear', set: { expr: '""' } }
      : { label: k, into: 'expr', after: k })),
  };
}

/** The one definition the catalog prints as the shape of the whole language. */
function exampleDef() {
  return {
    id: 'tree-count',
    name: 'Uncommitted files',
    badge: 'git',
    desc: 'How many files the working tree has touched.',
    source: { kind: 'probe', probe: 'git', every: 5000 },
    value: 'v',
    render: { as: 'number', label: 'dirty', tone: 'v > 0 ? "warn" : "ok"' },
    staleAfter: 30000,
  };
}

export { exampleDef };
