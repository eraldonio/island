// The omp harness, from the browser's side.
//
// `serve.py` bridges one `omp --mode rpc` process per tile: it takes this app's
// commands over POST and streams the process's stdout frames back over SSE.
// This module owns that conversation for one tile — it speaks the handful of
// RPC commands the UI needs, and folds the event stream into a small transcript
// the views can draw.
//
// The transcript is deliberately rebuilt from whole messages rather than patched
// from deltas: a frame may be replayed after a reconnect, and `message_update`
// carries the running `partial` message anyway, so applying it twice changes
// nothing.

const MAX_ITEMS = 500;        // transcript is trimmed from the front past this
const MAX_OUTPUT = 8000;      // tool output kept, in characters

// How long "done" stays up after a turn before the tile settles into "waiting
// for input". omp reports the yield and then the settle back to back, so without
// a hold the completion would never be visible.
const DONE_HOLD = 1500;

// Extension UI methods that expect an answer; the rest are presentation.
const DIALOG_METHODS = new Set(['select', 'confirm', 'input', 'editor', 'ask', 'cancel']);

/** Text of a message or tool result content array. */
function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter((c) => c && c.type === 'text').map((c) => c.text || '').join('');
}

/** The renderable parts of a message, in order. */
function partsOf(content) {
  if (!Array.isArray(content)) return [];
  const out = [];
  for (const c of content) {
    if (!c || typeof c !== 'object') continue;
    if (c.type === 'text') {
      if (c.text) out.push({ type: 'text', text: c.text });
    } else if (c.type === 'thinking') {
      if (c.text || c.thinking) out.push({ type: 'thinking', text: c.text || c.thinking });
    } else if (c.type === 'toolCall') {
      out.push({ type: 'toolCall', id: c.id, name: c.name, args: c.arguments });
    }
  }
  return out;
}

const clip = (s, n) => (s && s.length > n ? s.slice(0, n) + '…' : (s || ''));

/** stopReason of the last assistant message in an `agent_end` payload. */
function lastStopOf(messages) {
  if (!Array.isArray(messages)) return null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m && m.role === 'assistant') return m.stopReason || null;
  }
  return null;
}

export class OmpSession {
  /**
   * @param {string} id tile / session id
   */
  constructor(id) {
    this.id = id;
    this.listeners = new Set();
    this.items = [];
    this.tools = new Map();      // toolCallId -> { name, args, status, output, isError }
    this.model = null;
    this.status = 'connecting';  // connecting | ready | streaming | offline | error
    this.error = null;
    this.available = true;
    this.seq = 0;                // bumped on every change, for cheap dirty checks
    this.es = null;
    this.current = null;         // the assistant entry still being streamed
    this.sawReady = false;
    this.synced = false;
    this.closed = false;
    this.opening = false;
    this.retryAt = 0;
    this.turns = 0;              // turns that have completed
    this.settled = true;         // nothing queued, nothing running
    this.lastStop = null;        // stopReason of the last assistant message
    this.failed = false;         // a command failed since the last prompt
    this.pending = null;         // an omp dialog waiting on the user
    this.settleTimer = 0;
  }

  /* ── transport ─────────────────────────────────────────────────────── */

  url(path) { return `/api/omp/${encodeURIComponent(this.id)}${path}`; }

  async post(path, body) {
    const res = await fetch(this.url(path), {
      method: 'POST',
      headers: { 'X-Island': '1', 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText);
    return res.json().catch(() => ({}));
  }

  /** Spawn the harness process and start following its frames. */
  async open(fresh = false) {
    if (this.es || this.opening || this.closed) return;
    if (this.retryAt && Date.now() < this.retryAt) return;
    this.opening = true;
    this.status = 'connecting';
    this.bump();
    try {
      const r = await this.post('/start', { fresh });
      this.available = r.available !== false;
    } catch (err) {
      this.status = 'offline';
      this.error = String(err.message || err);
      this.opening = false;
      this.retryAt = Date.now() + 5000;
      this.bump();
      return;
    }
    this.opening = false;
    const es = new EventSource(this.url('/events'));
    this.es = es;
    es.onmessage = (e) => this.frame(e.data);
    es.onerror = () => {
      if (this.closed || this.es !== es) return;
      // EventSource reconnects on its own and resends Last-Event-ID; the
      // transcript rebuild is idempotent, so a gap simply refills.
      if (this.status === 'ready') this.status = 'connecting';
      this.bump();
    };
    es.onopen = () => {
      if (this.es !== es) return;
      if (this.status === 'connecting' || this.status === 'offline') this.status = 'ready';
      this.bump();
    };
  }

  close() {
    this.closed = true;
    if (this.es) { this.es.close(); this.es = null; }
  }

  /** Drop the stream and connect again (after stopping the process). */
  restart(fresh = false) {
    if (this.es) { this.es.close(); this.es = null; }
    this.closed = false;
    this.synced = false;
    this.sawReady = false;
    this.status = 'connecting';
    this.retryAt = 0;
    this.pending = null;
    this.turns = 0;
    this.settled = true;
    this.lastStop = null;
    this.failed = false;
    clearTimeout(this.settleTimer);
    this.settleTimer = 0;
    this.bump();
    return this.open(fresh);
  }

  /** Kill the omp process behind this tile (the conversation is not deleted). */
  async stop() {
    try { await this.post('/stop'); } catch { /* already gone */ }
  }

  /** Send one RpcCommand to the harness. */
  command(cmd) {
    return this.post('/command', cmd).catch((err) => {
      this.error = String(err.message || err);
      this.bump();
    });
  }

  /* ── commands the UI uses ──────────────────────────────────────────── */

  prompt(text, streamingBehavior) {
    const message = String(text).trim();
    if (!message) return;
    this.push({ kind: 'user', text: message });   // optimistic; message_start confirms
    this.status = 'streaming';
    this.bump();
    this.command({ id: `p${++this.seq}`, type: 'prompt', message, streamingBehavior });
  }

  abort() { this.command({ id: `a${++this.seq}`, type: 'abort' }); }

  /**
   * Answer the dialog omp is waiting on. `value` for select/input/editor,
   * `confirmed` for confirm, `answers` for ask, or `cancelled` to dismiss.
   */
  respond(answer) {
    const p = this.pending;
    if (!p) return;
    this.pending = null;
    this.command({ id: `u${++this.seq}`, type: 'extension_ui_response', id: p.id, ...answer });
    this.bump();
  }

  /** Ask for the whole transcript, e.g. after a reload or a resumed session. */
  resync() { this.command({ id: `s${++this.seq}`, type: 'get_messages' }); }

  getState() { this.command({ id: `g${++this.seq}`, type: 'get_state' }); }

  /** Can another line be sent right now (idle, or steering a running turn)? */
  get busy() { return this.status === 'streaming'; }

  /* ── transcript ────────────────────────────────────────────────────── */

  bump() {
    this.seq += 1;
    for (const fn of this.listeners) {
      try { fn(this); } catch (err) { console.warn('[island] harness listener failed', err); }
    }
  }

  /** Observe transcript/status changes; returns an unsubscribe. */
  on(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  push(entry) {
    this.items.push(entry);
    if (this.items.length > MAX_ITEMS) this.items.splice(0, this.items.length - MAX_ITEMS);
  }

  /** The last N entries as plain lines, for the tile preview. */
  preview(maxLines = 8) {
    const lines = [];
    for (let i = this.items.length - 1; i >= 0 && lines.length < maxLines; i--) {
      const ls = this.entryLines(this.items[i]);
      for (let j = ls.length - 1; j >= 0 && lines.length < maxLines; j--) lines.unshift(ls[j]);
    }
    return lines;
  }

  entryLines(entry) {
    if (entry.kind === 'user') return ['› ' + entry.text];
    if (entry.kind === 'notice') return [(entry.level === 'error' ? '! ' : '· ') + entry.text];
    return entry.parts.flatMap((p) => {
      if (p.type === 'text') return p.text.split('\n');
      if (p.type === 'thinking') return ['… thinking'];
      return ['⚙ ' + (p.name || 'tool')];
    });
  }

  /**
   * What the harness is doing, from its own signals: a turn in flight, the
   * moment it yielded, a dialog waiting on the user, a failure, or simply up
   * and idle. This is what the tile's status bar reads.
   */
  get phase() {
    if (this.pending) return 'input';
    if (!this.available) return 'nobridge';
    if (this.status === 'error') return 'error';
    if (this.status === 'offline') return 'offline';
    if (this.status === 'connecting') return 'connecting';
    if (this.status === 'streaming') return 'working';
    if (this.failed || this.lastStop === 'error') return 'error';
    if (!this.turns) return 'idle';
    return this.settled ? 'waiting' : 'done';
  }

  /** One short line for the tile's status bar and the chat header. */
  get label() {
    switch (this.phase) {
      case 'nobridge': return 'no bridge — start serve.py';
      case 'connecting': return 'connecting';
      case 'working': return 'working';
      case 'done': return 'done';
      case 'input': case 'waiting': return 'waiting for input';
      case 'error': return 'error';
      case 'offline': return 'offline';
      default: return 'idle';
    }
  }

  /** Hold "done" up briefly before the tile settles into "waiting for input". */
  armSettle() {
    clearTimeout(this.settleTimer);
    this.settleTimer = setTimeout(() => {
      this.settleTimer = 0;
      this.settled = true;
      this.bump();
    }, DONE_HOLD);
  }

  /** Fold one stdout frame into the transcript. */
  frame(raw) {
    let f;
    try { f = JSON.parse(raw); } catch { return; }
    const t = f.type;

    if (t === 'bridge_error') {
      this.status = 'error';
      this.error = f.error || 'bridge error';
      this.available = false;
      return this.bump();
    }
    if (t === 'bridge_eof') {
      this.current = null;
      if (!this.closed) {
        // The process is gone: drop the stream and let the next sync bring a
        // fresh one up, which resumes this tile's session by id.
        if (this.es) { this.es.close(); this.es = null; }
        this.status = 'offline';
        this.retryAt = Date.now() + 3000;
      }
      return this.bump();
    }
    if (t === 'ready') {
      this.sawReady = true;
      this.retryAt = 0;
      if (this.status === 'connecting') this.status = 'ready';
      if (!this.synced) { this.synced = true; this.resync(); this.getState(); }
      return this.bump();
    }
    if (t === 'agent_start') {
      this.status = 'streaming';
      clearTimeout(this.settleTimer);
      this.settleTimer = 0;
      this.settled = false;
      this.lastStop = null;
      this.failed = false;
      return this.bump();
    }
    if (t === 'agent_end') {
      this.current = null;
      if (this.status === 'streaming') this.status = 'ready';
      for (const e of this.items) if (e.kind === 'assistant') e.streaming = false;
      this.turns += 1;
      this.lastStop = lastStopOf(f.messages);
      this.armSettle();
      return this.bump();
    }
    if (t === 'session_settled') {
      this.current = null;
      if (this.status === 'streaming') this.status = 'ready';
      for (const e of this.items) if (e.kind === 'assistant') e.streaming = false;
      this.armSettle();
      return this.bump();
    }
    if (t === 'extension_ui_request') {
      // Presentation frames (setWidget, notify, …) are dropped; a dialog is the
      // harness asking the user something, so it becomes the tile's state.
      if (DIALOG_METHODS.has(f.method)) {
        this.pending = { id: f.id, method: f.method, request: f };
        return this.bump();
      }
      return;
    }
    if (t === 'extension_ui_error' || t === 'extension_error') {
      this.error = f.error || 'extension error';
      return this.bump();
    }
    if (t === 'message_start') {
      this.adopt(f.message, true);
      return this.bump();
    }
    if (t === 'message_update') {
      const ev = f.assistantMessageEvent;
      if (ev && ev.partial) this.adopt(ev.partial, true);
      else if (ev) this.applyDelta(ev);
      return this.bump();
    }
    if (t === 'message_end') {
      this.adopt(f.message, false);
      return this.bump();
    }
    if (t === 'tool_execution_start') {
      this.tool(f.toolCallId, {
        name: f.toolName, args: f.args, status: 'running', output: '',
      });
      return this.bump();
    }
    if (t === 'tool_execution_update') {
      const cur = this.tools.get(f.toolCallId);
      if (cur) { cur.output = clip(textOf(f.partialResult && f.partialResult.content), MAX_OUTPUT); this.bump(); }
      return;
    }
    if (t === 'tool_execution_end') {
      const cur = this.tools.get(f.toolCallId) || { name: f.toolName, args: f.args };
      cur.status = f.isError ? 'error' : 'ok';
      cur.isError = !!f.isError;
      cur.output = clip((f.result && textOf(f.result.content)) || cur.output, MAX_OUTPUT);
      this.tools.set(f.toolCallId, cur);
      return this.bump();
    }
    if (t === 'response') {
      if (!f.success && f.command !== 'get_messages') {
        this.error = f.error || 'command failed';
        this.failed = true;
        this.push({ kind: 'notice', level: 'error', text: `${f.command}: ${this.error}` });
        return this.bump();
      }
      if (f.command === 'get_messages' && f.success && f.data) {
        return this.seed(f.data.messages || []);
      }
      if (f.command === 'get_state' && f.success && f.data) {
        const m = f.data.model;
        this.model = m ? `${m.id || m.model || ''}`.trim() : this.model;
        if (f.data.isStreaming) this.status = 'streaming';
        return this.bump();
      }
      if (f.command === 'prompt' && f.data && f.data.agentInvoked === false) {
        this.status = 'ready';
        return this.bump();
      }
    }
  }

  /** Merge a whole message into the transcript (idempotent). */
  adopt(message, streaming) {
    if (!message || !message.role) return;
    if (message.role === 'toolResult') return;   // the tool run carries the output
    const parts = partsOf(message.content);

    if (message.role === 'user') {
      const text = textOf(message.content);
      const last = this.items[this.items.length - 1];
      if (last && last.kind === 'user' && last.text === text) return;   // our optimistic copy
      this.push({ kind: 'user', text });
      return;
    }
    if (message.role !== 'assistant') return;

    // A streamed assistant message is one entry, grown in place: `message_start`
    // opens it (its first snapshot already holds content), each `message_update`
    // replaces the parts with the running `partial`, and `message_end` closes it.
    if (streaming) {
      let entry = this.current;
      if (!entry) {
        entry = { kind: 'assistant', parts, streaming: true, model: message.model };
        this.current = entry;
        this.push(entry);
      } else {
        entry.parts = parts;
        entry.model = message.model || entry.model;
      }
      return entry;
    }

    const entry = this.current;
    if (entry && this.items[this.items.length - 1] === entry) {
      entry.parts = parts;
      entry.streaming = false;
      entry.stopReason = message.stopReason;
    } else {
      this.push({
        kind: 'assistant', parts, streaming: false,
        model: message.model, stopReason: message.stopReason,
      });
    }
    this.current = null;
    return entry;
  }

  /** Fallback for a `message_update` without a `partial` payload. */
  applyDelta(ev) {
    if (!this.current) return;
    const parts = this.current.parts;
    const i = ev.contentIndex | 0;
    if (ev.type === 'text_start') parts[i] = { type: 'text', text: '' };
    else if (ev.type === 'text_delta') {
      if (!parts[i] || parts[i].type !== 'text') parts[i] = { type: 'text', text: '' };
      parts[i].text += ev.delta || '';
    } else if (ev.type === 'text_end') {
      parts[i] = { type: 'text', text: ev.content || (parts[i] && parts[i].text) || '' };
    } else if (ev.type === 'thinking_delta') {
      if (!parts[i] || parts[i].type !== 'thinking') parts[i] = { type: 'thinking', text: '' };
      parts[i].text += ev.delta || '';
    }
  }

  tool(id, info) {
    if (!id) return;
    this.tools.set(id, Object.assign(this.tools.get(id) || {}, info));
  }

  /** Replace the transcript with a full history (get_messages). */
  seed(messages) {
    if (this.busy) return;                       // a live stream owns the transcript
    this.items = [];
    this.current = null;
    for (const m of messages) {
      if (m.role === 'user') this.items.push({ kind: 'user', text: textOf(m.content) });
      else if (m.role === 'assistant') {
        const parts = partsOf(m.content);
        if (parts.length) this.items.push({ kind: 'assistant', parts, streaming: false, model: m.model });
      } else if (m.role === 'toolResult') {
        // Attach a result that arrived without a matching execution frame.
        if (m.toolCallId && !this.tools.has(m.toolCallId)) {
          this.tools.set(m.toolCallId, {
            name: m.toolName, args: null, status: 'ok', output: clip(textOf(m.content), MAX_OUTPUT),
          });
        }
      }
    }
    this.bump();
  }
}

/** Sessions are per tile and live as long as the page. */
const sessions = new Map();

export function sessionFor(id) {
  let s = sessions.get(id);
  if (!s) { s = new OmpSession(id); sessions.set(id, s); }
  return s;
}

export function dropSession(id) {
  const s = sessions.get(id);
  if (s) { s.close(); s.stop(); s.listeners.clear(); sessions.delete(id); }
}

export function dropAllSessions() {
  for (const s of sessions.values()) { s.close(); s.stop(); s.listeners.clear(); }
  sessions.clear();
}
