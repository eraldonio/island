#!/usr/bin/env python3
"""Static server for the app with caching disabled.

`python3 -m http.server` sends no Cache-Control header, so browsers
heuristically cache the ES modules and you end up editing files that the page
never reloads. This serves the same directory with no-store headers, and always
on the same port:

    python3 serve.py [port]
"""

import functools
import http.server
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parent


class Handler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        super().end_headers()

    def log_message(self, *args):
        pass


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8080
    handler = functools.partial(Handler, directory=str(ROOT))
    with http.server.ThreadingHTTPServer(("127.0.0.1", port), handler) as httpd:
        print(f"serving {ROOT} on http://127.0.0.1:{port} (no-store)")
        httpd.serve_forever()


if __name__ == "__main__":
    main()
