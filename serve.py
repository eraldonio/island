#!/usr/bin/env python3
"""Dev server for Island: the static app, plus a bridge to the omp harness.

`python3 serve.py [port]` serves this directory with caching disabled and, on
the same origin, exposes the local `omp` CLI to the page:

    GET  /api/omp                        -> { available, sessions: [...] }
    POST /api/omp/<id>/start             -> spawn (or reuse) the omp process
    POST /api/omp/<id>/command           -> write one RpcCommand JSON to stdin
    POST /api/omp/<id>/stop              -> terminate the process
    GET  /api/omp/<id>/events            -> SSE of the process's stdout frames

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
import urllib.parse

ROOT = pathlib.Path(__file__).resolve().parent
HARNESS_ROOT = ROOT / ".island" / "harness"
OMP = os.environ.get("ISLAND_OMP", "omp")
OMP_CWD = os.environ.get("ISLAND_OMP_CWD", str(ROOT))

RING = 4000          # stdout frames kept so a reconnect can replay what it missed
MAX_BODY = 1 << 20   # largest command we accept from the page
SSE_PING = 15.0      # seconds of quiet before a comment keeps the stream warm

SID_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")

# A host-tool request is answered by the page that received it. The ring exists
# so a reconnect can rebuild a transcript, but a page that just arrived must not
# re-run an old call — that would apply its edit to the island a second time. A
# reconnect (a Last-Event-ID) does get them: that client still holds the answers
# it has already given.
HOST_REQUEST = ("host_tool_call", "host_tool_cancel")


def frame_type(line):
    """The `type` of a stdout frame, or None when it is not one we can read."""
    if '"host_tool_' not in line:
        return None
    try:
        return json.loads(line).get("type")
    except ValueError:
        return None


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
                self._emit(line)
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

    def _emit(self, line):
        with self.lock:
            self.seq += 1
            entry = (self.seq, line)
            self.buf.append(entry)
            subs = list(self.subs)
        for q in subs:
            try:
                q.put_nowait(entry)
            except queue.Full:
                try:                     # drop the oldest to keep the newest
                    q.get_nowait()
                    q.put_nowait(entry)
                except queue.Empty:
                    pass

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
