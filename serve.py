#!/usr/bin/env python3
"""Dev server for Island: the static app, plus a bridge to the omp harness.

`python3 serve.py [port]` serves this directory with caching disabled and, on
the same origin, exposes the local `omp` CLI to the page:

    GET  /api/omp                        -> { available, sessions: [...] }
    POST /api/omp/<id>/start             -> spawn (or reuse) the omp process
    POST /api/omp/<id>/command           -> write one RpcCommand JSON to stdin
    POST /api/omp/<id>/stop              -> terminate the process
    GET  /api/omp/<id>/events            -> SSE of the process's stdout frames
    GET  /api/probe/<name>               -> one local reading (git, cpu, mem, sh)
    GET  /api/fetch?url=<https url>      -> an allowlisted remote GET, proxied

Each <id> is one chat tile in the app and one long-lived `omp --mode rpc`
session, kept under `.island/harness/<id>/` and resumed with `--continue`, so a
conversation outlives a page reload (and a server restart). The bridge binds
loopback only, and every mutating request must carry an `X-Island` header: a
browser cannot set that from another origin without a preflight we never grant,
which keeps a random web page from driving the harness through your browser.

The island's own tools ride the same bridge: the page registers them with omp's
`set_host_tools`, each call arrives as a `host_tool_call` frame on this stream,
and the page answers it with `host_tool_result` on the command endpoint. Nothing
here interprets them — the world lives in the page.

Read-only probes (a dirty-file count, the machine's load, a shell command) and a
proxied fetch are offered beside the harness, so a card can show a live value
without the page holding a token or hitting CORS. The shell probe and the fetch
proxy are both off until asked for: ISLAND_CARDS_SHELL=1 turns on `sh`, and
ISLAND_FETCH_ORIGINS (a comma-separated list of https origins, empty by default)
names what `/api/fetch` may reach.

Set ISLAND_OMP to point at a different binary, ISLAND_OMP_CWD at the directory
the harness works in (default: this one).
"""

import atexit
import collections
import functools
import http.server
import json
import os
import pathlib
import queue
import re
import shutil
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parent
HARNESS_ROOT = ROOT / ".island" / "harness"
OMP = os.environ.get("ISLAND_OMP", "omp")
OMP_CWD = os.environ.get("ISLAND_OMP_CWD", str(ROOT))

RING = 4000          # stdout frames kept so a reconnect can replay what it missed
MAX_BODY = 1 << 20   # largest command we accept from the page
SSE_PING = 15.0      # seconds of quiet before a comment keeps the stream warm

MIB = 1 << 20        # bytes in a mebibyte, for the memory reading's label
PROBE_TIMEOUT = 5.0  # seconds a probe's subprocess may run before it is killed
PROBE_TEXT = 400     # characters of a shell probe's stdout we hand back
SHELL_TIMEOUT = 5.0  # the escape-hatch probe's own hard limit
CPU_TTL = 0.5        # seconds a cpu reading is reused before the next sample
CPU_GAP = 5.0        # a previous /proc/stat sample older than this is no interval
FETCH_TIMEOUT = 8.0  # seconds a proxied fetch may take, all its hops included
FETCH_HOPS = 2       # redirects a proxied fetch will follow before giving up
FETCH_TEXT = 2000    # characters of a non-JSON body we clip for the page
FETCH_BYTES = 1 << 20  # body bytes we read from upstream before clipping
FETCH_UA = "island/1.0"
REDIRECT_CODES = (301, 302, 303, 307, 308)

SID_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")

# A host request is fulfilled by the page that receives it: a tool call is
# answered with host_tool_result, a uri request (which may write a file) with
# host_uri_result. The ring exists so a reconnect can rebuild a transcript, but a
# page that just arrived must not re-run an old request — that would apply its
# edit to the island a second time, or write a second copy of
# `island://cards/<id>.json`. A reconnect (a Last-Event-ID) does get them: that
# client still holds the answers it has already given.
HOST_REQUEST = ("host_tool_call", "host_tool_cancel",
                "host_uri_request", "host_uri_cancel")

NO_PAGE = ("the island page is not open — nothing in the browser can answer "
           "this; tell the user to open it")


def frame_type(line):
    """The `type` of a stdout frame, or None when it is not one we can read."""
    if '"host_' not in line:
        return None
    try:
        return json.loads(line).get("type")
    except ValueError:
        return None


def now_ms():
    """Wall-clock milliseconds — the `at` every reading carries."""
    return int(time.time() * 1000)


def one(query, key):
    """The single value of a query argument, or None when it is absent."""
    values = query.get(key)
    return values[-1] if values else None


class Harness:
    """One omp RPC process, its stdout fan-out, and the frames it has produced.

    The reader thread broadcasts each stdout line to every connected SSE client
    and keeps it in a bounded ring, so a client that reconnects with a
    Last-Event-ID is sent exactly the frames it missed.
    """

    def __init__(self, sid):
        self.sid = sid
        self.dir = HARNESS_ROOT / sid
        self.lock = threading.RLock()
        self.proc = None
        self.seq = 0
        self.buf = collections.deque(maxlen=RING)   # (seq, line)
        self.subs = set()                            # subscriber queues
        self.err = collections.deque(maxlen=40)
        self.exited = None                           # exit code once seen

    # ── process ──────────────────────────────────────────────────────────

    def start(self, fresh=False):
        with self.lock:
            if self.proc is not None and self.proc.poll() is None:
                return True
            self.dir.mkdir(parents=True, exist_ok=True)
            args = [OMP, "--mode", "rpc", "--cwd", OMP_CWD, "--session-dir", str(self.dir)]
            # Resume this tile's conversation, unless the page asked for a fresh
            # one — a new session file lands beside the old ones either way.
            if not fresh and any(f.stat().st_size > 0 for f in self.dir.glob("*.jsonl")):
                args.append("--continue")
            try:
                self.proc = subprocess.Popen(
                    args, cwd=OMP_CWD,
                    stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE, text=True, bufsize=1,
                )
            except OSError as exc:
                self.proc = None
                self._emit(json.dumps({"type": "bridge_error", "error": str(exc)}))
                return False
            self.exited = None
            # A new process is a new incarnation: nothing from the previous one
            # should be replayed into a client that connects from here on.
            with self.lock:
                self.buf.clear()
            threading.Thread(target=self._pump_out, daemon=True).start()
            threading.Thread(target=self._pump_err, daemon=True).start()
            return True

    def _pump_out(self):
        proc = self.proc
        for line in proc.stdout:
            line = line.strip()
            if line:
                self._emit(self._tag(line))
        code = proc.wait()
        with self.lock:
            if self.proc is not proc:
                return          # superseded: a newer process owns the stream now
            self.exited = code
        self._emit(json.dumps({"type": "bridge_eof", "code": code}))

    def _pump_err(self):
        for line in self.proc.stderr:
            self.err.append(line.rstrip("\n"))

    def command(self, obj):
        with self.lock:
            if self.proc is None or self.proc.poll() is not None:
                if not self.start():
                    return False, "omp is not available"
            try:
                self.proc.stdin.write(json.dumps(obj) + "\n")
                self.proc.stdin.flush()
            except (BrokenPipeError, ValueError, OSError) as exc:
                return False, str(exc)
            return True, None

    def stop(self):
        with self.lock:
            proc = self.proc
            self.proc = None
        if proc is not None and proc.poll() is None:
            proc.terminate()
            try:
                proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                proc.kill()

    def running(self):
        with self.lock:
            return self.proc is not None and self.proc.poll() is None

    # ── fan-out ──────────────────────────────────────────────────────────

    def _tag(self, line):
        """Mark a host request with this session's id, so the page knows its tile.

        A tool or uri request can arrive from any harness; the page needs to
        know which one asked to place its card. Only those frames are touched,
        and only to add a `session` key — every other frame is forwarded
        byte-identical, as is any line we cannot parse.
        """
        if frame_type(line) not in HOST_REQUEST:
            return line
        try:
            frame = json.loads(line)
        except ValueError:
            return line
        frame["session"] = self.sid
        return json.dumps(frame, separators=(",", ":"))

    def _emit(self, line):
        with self.lock:
            self.seq += 1
            entry = (self.seq, line)
            self.buf.append(entry)
            subs = list(self.subs)
            orphan = not subs
        for q in subs:
            try:
                q.put_nowait(entry)
            except queue.Full:
                try:                     # drop the oldest to keep the newest
                    q.get_nowait()
                    q.put_nowait(entry)
                except queue.Empty:
                    pass
        if orphan:
            self._orphan(line)

    def _orphan(self, line):
        """Answer a host request that reached no page, so the harness is not stuck.

        A tool call or a uri request is fulfilled by the page, which is only
        there while it holds an SSE subscriber. With none, the frame lands on
        nobody and the harness blocks until its own timeout; answer it here, in
        the same shape the page would send, the moment it would otherwise be
        lost. A subscriber that is merely slow is a subscriber: this runs only
        when there are none at all.
        """
        kind = frame_type(line)
        if kind not in HOST_REQUEST:
            return
        try:
            frame = json.loads(line)
        except ValueError:
            return
        rid = frame.get("id")
        if kind == "host_tool_call":
            reply = {
                "type": "host_tool_result", "id": rid, "isError": True,
                "result": {"content": [{"type": "text", "text": NO_PAGE}]},
            }
        elif kind == "host_uri_request":
            reply = {
                "type": "host_uri_result", "id": rid, "isError": True,
                "error": f"the island page is not open — "
                         f"{frame.get('operation')} {frame.get('url')} was not performed",
            }
        else:
            return                       # host_tool_cancel expects no answer
        self.command(reply)

    def subscribe(self, after):
        q = queue.Queue(maxsize=4096)
        with self.lock:
            backlog = [
                e for e in self.buf
                if (after is None or e[0] > after)
                and not (after is None and frame_type(e[1]) in HOST_REQUEST)
            ]
            self.subs.add(q)
        return q, backlog

    def unsubscribe(self, q):
        with self.lock:
            self.subs.discard(q)


HARNESSES = {}
REGISTRY_LOCK = threading.Lock()


def harness(sid):
    with REGISTRY_LOCK:
        h = HARNESSES.get(sid)
        if h is None:
            h = HARNESSES[sid] = Harness(sid)
        return h


def stop_all():
    with REGISTRY_LOCK:
        all_h = list(HARNESSES.values())
    for h in all_h:
        h.stop()


atexit.register(stop_all)


# ── probes ───────────────────────────────────────────────────────────────
#
# A probe is a cheap, read-only reading of this machine, run inline in the
# threaded handler and never cached by the browser: `_json` sends no-store.
# Each takes the parsed query (as `parse_qs` returns it) and returns the card
# payload. Every subprocess they start carries a timeout, so a hung `git` costs
# a thread for PROBE_TIMEOUT and not forever.

def _truthy(value):
    """Whether an environment switch reads as on (1/true/yes/on)."""
    return (value or "").strip().lower() in ("1", "true", "yes", "on")


def shell_enabled():
    """Whether the deliberate shell escape hatch has been switched on."""
    return _truthy(os.environ.get("ISLAND_CARDS_SHELL"))


def probe_git(query):
    """Dirty files and branch of a git worktree.

    Runs `git status --porcelain=v2 --branch` in OMP_CWD, or in `path` when it
    is given — an existing directory, or the probe errors.
    """
    cwd = one(query, "path") or OMP_CWD
    if not os.path.isdir(cwd):
        raise ValueError(f"not a directory: {cwd}")
    out = subprocess.run(
        ["git", "-C", cwd, "status", "--porcelain=v2", "--branch"],
        capture_output=True, text=True, timeout=PROBE_TIMEOUT,
    )
    if out.returncode != 0:
        raise ValueError((out.stderr or out.stdout or "git failed").strip())
    dirty = 0
    branch, ahead, behind = "", "?", "?"
    for line in out.stdout.splitlines():
        if line.startswith("# branch.head "):
            branch = line[len("# branch.head "):]
        elif line.startswith("# branch.ab "):
            for token in line[len("# branch.ab "):].split():
                if token.startswith("+"):
                    ahead = token[1:]
                elif token.startswith("-"):
                    behind = token[1:]
        elif line and not line.startswith("#"):
            dirty += 1
    return {
        "value": dirty,
        "sub": f"{branch} ↑{ahead} ↓{behind}".strip(),
        "status": "dirty" if dirty else "clean",
        "at": now_ms(),
    }


def _interval(prev, now, fallback):
    """Busy percent between two (idle, total) samples, or the fallback."""
    didle, dtotal = now[0] - prev[0], now[1] - prev[1]
    if dtotal <= 0:
        return fallback
    return round(min(100.0, max(0.0, 100.0 * (dtotal - didle) / dtotal)), 1)


class CpuSampler:
    """The machine's busy fraction, from two /proc/stat samples.

    One sampler is shared by every caller: a reading younger than CPU_TTL is
    returned as-is, so a burst of requests costs one pair of reads rather than a
    read apiece — and never a process.
    """

    def __init__(self):
        self.lock = threading.Lock()
        self.at = 0.0
        self.busy = 0.0
        self.prev = None                # (monotonic, idle, total) of last sample

    @staticmethod
    def _sample():
        """(idle, total) jiffies from the aggregate cpu line of /proc/stat."""
        with open("/proc/stat") as fh:
            fields = [int(v) for v in fh.readline().split()[1:]]
        idle = fields[3] + (fields[4] if len(fields) > 4 else 0)   # idle + iowait
        return idle, sum(fields)

    def percent(self):
        with self.lock:
            now = time.monotonic()
            if self.at and now - self.at < CPU_TTL:
                return self.busy
            idle, total = self._sample()
            prev = self.prev
            if prev is None:
                # No interval to measure yet: a short second look costs one
                # sleep, and only ever happens on the very first call.
                time.sleep(CPU_TTL)
                idle2, total2 = self._sample()
                self.busy = _interval((idle, total), (idle2, total2), self.busy)
                idle, total = idle2, total2
            elif now - prev[0] <= CPU_GAP:
                self.busy = _interval((prev[1], prev[2]), (idle, total), self.busy)
            self.at = time.monotonic()
            self.prev = (self.at, idle, total)
            return self.busy


CPU_SAMPLER = CpuSampler()


def probe_cpu(query):
    """The machine's busy percentage, over the shared CPU_SAMPLER's interval."""
    return {
        "value": CPU_SAMPLER.percent(),
        "sub": f"{os.cpu_count() or 1} cores",
        "at": now_ms(),
    }


def probe_mem(query):
    """Used memory from /proc/meminfo, as a percentage and in GiB."""
    info = {}
    with open("/proc/meminfo") as fh:
        for line in fh:
            key, _, rest = line.partition(":")
            if rest:
                info[key] = int(rest.split()[0])        # kB
    total = info["MemTotal"]
    used = total - info.get("MemAvailable", info["MemFree"])
    return {
        "value": round(100.0 * used / total, 1),
        "sub": f"{used / MIB:.1f} / {total / MIB:.1f} GiB",
        "at": now_ms(),
    }


def probe_sh(query):
    """Run one shell command — the deliberate escape hatch, off by default.

    This is the one probe that can do anything at all: it hands `cmd` to the
    shell as this user, in OMP_CWD. It is enabled only by ISLAND_CARDS_SHELL
    (1/true/yes/on) and, because a cross-origin page can fire a GET without a
    preflight, it is the one probe the handler gates on X-Island (see
    `_trusted`). Disabled, it errors with that instruction instead of running.
    """
    if not shell_enabled():
        raise ValueError("the sh probe is disabled by default; "
                         "set ISLAND_CARDS_SHELL=1 to enable it")
    cmd = one(query, "cmd")
    if not cmd:
        raise ValueError("the sh probe needs a cmd argument")
    out = subprocess.run(
        cmd, shell=True, cwd=OMP_CWD, capture_output=True, text=True,
        timeout=SHELL_TIMEOUT,
    )
    return {
        "value": (out.stdout or "").strip()[:PROBE_TEXT],
        "sub": f"exit {out.returncode}",
        "status": "ok" if out.returncode == 0 else "error",
        "at": now_ms(),
    }


# The registry the endpoint reads: exactly the names below, and the arguments
# each one accepts — anything else on the query string is refused.
PROBES = {
    "git": probe_git,
    "cpu": probe_cpu,
    "mem": probe_mem,
    "sh": probe_sh,
}
PROBE_ARGS = {"git": ("path",), "cpu": (), "mem": (), "sh": ("cmd",)}


# ── fetch proxy ──────────────────────────────────────────────────────────
#
# A card may want a value from somewhere else without the page carrying a token
# or tripping CORS; this proxies one GET, to https origins the operator named in
# ISLAND_FETCH_ORIGINS (empty, the default, allows nothing).

class FetchDenied(Exception):
    """A fetch hop landed on an origin that is not allowlisted."""


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    """Refuse to follow redirects: the proxy walks them itself, re-checking each."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


FETCH_OPENER = urllib.request.build_opener(_NoRedirect)


def allowed_origins():
    """The (scheme, host) pairs ISLAND_FETCH_ORIGINS names, lowercased.

    The variable is a comma-separated list of https origins; only https is ever
    accepted and matching is exact on host — never a substring or a suffix.
    """
    allowed = set()
    for item in os.environ.get("ISLAND_FETCH_ORIGINS", "").split(","):
        parts = urllib.parse.urlsplit(item.strip())
        if parts.scheme.lower() == "https" and parts.hostname:
            allowed.add((parts.scheme.lower(), parts.hostname.lower()))
    return allowed


def origin_pair(url):
    """(scheme, host) of an absolute url, lowercased, for allowlist checks."""
    parts = urllib.parse.urlsplit(url)
    return parts.scheme.lower(), (parts.hostname or "").lower()


def origin_of(url):
    """The `scheme://host` an absolute url names, for the refusal message."""
    parts = urllib.parse.urlsplit(url)
    return f"{parts.scheme}://{parts.netloc}"


def remote_get(url, allowed):
    """GET an allowlisted https url, following at most FETCH_HOPS redirects.

    No cookie jar is attached and no client header is forwarded — the one
    User-Agent below is all that leaves — and every hop is re-checked against the
    allowlist, so an allowed origin cannot bounce the request to an arbitrary
    one. Returns (status, body bytes, content type).
    """
    hops = 0
    while True:
        if origin_pair(url) not in allowed:
            raise FetchDenied(origin_of(url))
        req = urllib.request.Request(url, headers={"User-Agent": FETCH_UA})
        try:
            resp = FETCH_OPENER.open(req, timeout=FETCH_TIMEOUT)
        except urllib.error.HTTPError as exc:
            resp = exc                   # a response too: its status may be 3xx
        except (urllib.error.URLError, ValueError, OSError) as exc:
            raise ValueError(f"fetch failed: {exc}")
        try:
            status = getattr(resp, "status", None) or getattr(resp, "code", None)
            location = resp.headers.get("Location") if status in REDIRECT_CODES else None
            body = b"" if location else resp.read(FETCH_BYTES)
            ctype = resp.headers.get("Content-Type", "")
        finally:
            resp.close()
        if not location:
            return status, body, ctype
        if hops >= FETCH_HOPS:
            raise ValueError(f"too many redirects (more than {FETCH_HOPS})")
        hops += 1
        url = urllib.parse.urljoin(url, location)      # checked at the top


def fetch_value(body, ctype):
    """What a card sees: parsed JSON, or the text clipped to FETCH_TEXT chars."""
    if "json" in ctype.lower():
        try:
            return json.loads(body.decode("utf-8", "replace"))
        except ValueError:
            pass
    return body.decode("utf-8", "replace")[:FETCH_TEXT]



class Handler(http.server.SimpleHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *args):
        pass

    # ── helpers ──────────────────────────────────────────────────────────

    def _route(self):
        """(command, sid) for an /api/omp path, or (None, None) for a file."""
        path = urllib.parse.urlparse(self.path).path
        if not path.startswith("/api/omp"):
            return None, None
        rest = [p for p in path[len("/api/omp"):].split("/") if p]
        if not rest:
            return "status", None
        if not SID_RE.match(rest[0]):
            return "bad", None
        return (rest[1] if len(rest) > 1 else "status"), rest[0]

    def end_headers(self):
        # This is a dev server whose page is edited while it runs, so nothing here
        # is cacheable: a module the browser kept from one edit ago fails in a way
        # that reads like a code error ("does not provide an export named …").
        # The JSON helpers already say so for their own responses; this covers the
        # static files.
        if not any(b"Cache-Control" in h for h in (self._headers_buffer or [])):
            self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def _json(self, code, payload):
        body = json.dumps(payload).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _trusted(self):
        # A cross-origin page cannot add a custom header without a preflight,
        # which we never approve; same-origin fetches and EventSource (GET) work.
        return self.headers.get("X-Island") == "1"

    # ── GET ──────────────────────────────────────────────────────────────

    def do_GET(self):
        path = urllib.parse.urlparse(self.path)
        if path.path.startswith("/api/probe/"):
            return self._probe(path)
        if path.path == "/api/fetch":
            return self._fetch(path)
        cmd, sid = self._route()
        if cmd is None:
            return super().do_GET()
        if cmd == "bad":
            return self._json(400, {"error": "bad session id"})
        if cmd == "status":
            if sid:
                h = harness(sid)
                return self._json(200, {
                    "id": sid, "running": h.running(),
                    "exited": h.exited, "stderr": list(h.err),
                })
            with REGISTRY_LOCK:
                sessions = [{"id": h.sid, "running": h.running()} for h in HARNESSES.values()]
            return self._json(200, {"available": shutil.which(OMP) is not None, "sessions": sessions})
        if cmd == "events":
            return self._sse(harness(sid))
        return self._json(404, {"error": "unknown endpoint"})

    def _probe(self, parsed):
        """GET /api/probe/<name> — one read-only reading, run inline, never cached."""
        name = parsed.path[len("/api/probe/"):].strip("/")
        query = urllib.parse.parse_qs(parsed.query)
        probe = PROBES.get(name)
        if probe is None:
            return self._json(404, {
                "error": f"unknown probe {name}; probes: {', '.join(sorted(PROBES))}",
            })
        extra = set(query) - set(PROBE_ARGS[name])
        if extra:
            return self._json(400, {
                "error": f"unknown argument(s): {', '.join(sorted(extra))}",
            })
        # The shell probe is the one that can act, so it is the one a stray
        # cross-origin GET must not be able to reach; but its disabled message
        # is the more useful answer, so it is checked first (`probe_sh` raises).
        if name == "sh" and shell_enabled() and not self._trusted():
            return self._json(403, {"error": "missing X-Island header"})
        try:
            return self._json(200, probe(query))
        except Exception as exc:
            return self._json(500, {"error": str(exc)})

    def _fetch(self, parsed):
        """GET /api/fetch?url=… — proxy one allowlisted https GET for a card."""
        url = one(urllib.parse.parse_qs(parsed.query), "url")
        if not url:
            return self._json(400, {"error": "needs a url argument"})
        allowed = allowed_origins()
        if origin_pair(url) not in allowed:
            return self._json(403, {
                "error": f"origin not allowed: {origin_of(url)}; "
                         f"set ISLAND_FETCH_ORIGINS=<comma list>",
            })
        try:
            status, body, ctype = remote_get(url, allowed)
        except FetchDenied as exc:
            return self._json(403, {
                "error": f"origin not allowed: {exc}; set ISLAND_FETCH_ORIGINS=<comma list>",
            })
        except Exception as exc:
            return self._json(502, {"error": str(exc)})
        return self._json(200, {
            "value": fetch_value(body, ctype), "status": status, "at": now_ms(),
        })

    def _sse(self, h):
        after = None
        last = self.headers.get("Last-Event-ID")
        if last is not None:
            try:
                after = int(last)
            except ValueError:
                after = None
        q, backlog = h.subscribe(after)
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Accel-Buffering", "no")
        self.send_header("Transfer-Encoding", "chunked")
        self.end_headers()
        try:
            for seq, line in backlog:
                self._chunk(f"id: {seq}\ndata: {line}\n\n".encode())
            while True:
                try:
                    seq, line = q.get(timeout=SSE_PING)
                except queue.Empty:
                    self._chunk(b": ping\n\n")
                    continue
                self._chunk(f"id: {seq}\ndata: {line}\n\n".encode())
        except (BrokenPipeError, ConnectionResetError, ValueError, OSError):
            pass
        finally:
            h.unsubscribe(q)
            try:
                self._chunk(b"")     # terminating chunk
            except OSError:
                pass

    def _chunk(self, data):
        self.wfile.write(b"%x\r\n" % len(data) + data + b"\r\n")
        self.wfile.flush()

    # ── POST ─────────────────────────────────────────────────────────────

    def do_POST(self):
        cmd, sid = self._route()
        if cmd is None:
            return self._json(404, {"error": "not found"})
        if not self._trusted():
            return self._json(403, {"error": "missing X-Island header"})
        if cmd == "bad" or not sid:
            return self._json(400, {"error": "bad session id"})
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            length = 0
        if length > MAX_BODY:
            return self._json(413, {"error": "command too large"})
        raw = self.rfile.read(length) if length else b""
        h = harness(sid)
        if cmd == "start":
            fresh = False
            if raw:
                try:
                    fresh = bool(json.loads(raw).get("fresh"))
                except (ValueError, AttributeError):
                    fresh = False
            return self._json(200, {"ok": h.start(fresh), "available": shutil.which(OMP) is not None})
        if cmd == "stop":
            h.stop()
            return self._json(200, {"ok": True})
        if cmd == "command":
            try:
                obj = json.loads(raw or b"{}")
            except ValueError as exc:
                return self._json(400, {"error": "bad json: " + str(exc)})
            if not isinstance(obj, dict) or "type" not in obj:
                return self._json(400, {"error": "not an RpcCommand"})
            ok, err = h.command(obj)
            return self._json(200 if ok else 502, {"ok": ok, "error": err})
        return self._json(404, {"error": "unknown endpoint"})


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8080
    handler = functools.partial(Handler, directory=str(ROOT))
    httpd = http.server.ThreadingHTTPServer(("127.0.0.1", port), handler)
    httpd.daemon_threads = True
    omp = shutil.which(OMP)
    print(f"serving {ROOT} on http://127.0.0.1:{port} (no-store)")
    print(f"harness: {omp or 'omp NOT FOUND on PATH'}  cwd {OMP_CWD}")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        stop_all()


if __name__ == "__main__":
    main()
