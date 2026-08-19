#
# The other end of the run-finished webhook.
#
# Records every delivery so a test can assert what was ACTUALLY sent — the headers,
# the signature and the body — rather than that this app believes it sent something.
# The signature in particular can only be checked from out here: verifying it against
# the bytes that arrived is the whole difference between "we signed it" and "a
# receiver can verify it".
#
#   POST /hook      records and answers 200
#   POST /broken    records and answers 500 — a receiver that is down must not take
#                   the run with it
#   GET  /_deliveries  every delivery as JSON, newest last
#   POST /_reset    forget them, so one phase's deliveries are not another's
#
# Used by tests/cancel.sh. Never used by the application.

import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PORT = 8091

deliveries = []
lock = threading.Lock()

# Only the headers a test asserts on. A dump of everything would put the whole
# request in the suite's output for no benefit.
INTERESTING = ("x-tsd-event", "x-tsd-timestamp", "x-tsd-signature", "content-type")


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        pass

    def path_only(self):
        return self.path.split("?")[0]

    def send_json(self, status, payload):
        encoded = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(encoded)))
        self.end_headers()
        self.wfile.write(encoded)

    def do_GET(self):
        if self.path_only() == "/_deliveries":
            with lock:
                self.send_json(200, list(deliveries))
            return

        self.send_json(404, {"error": "no such route"})

    def do_POST(self):
        path = self.path_only()

        if path == "/_reset":
            with lock:
                deliveries.clear()
            self.send_json(200, {"reset": True})
            return

        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length) if length > 0 else b""

        with lock:
            deliveries.append(
                {
                    "path": path,
                    # The RAW body, kept byte for byte: the signature covers these
                    # exact bytes, and re-serialising the JSON would change them.
                    "body": raw.decode("utf-8", "replace"),
                    "headers": {
                        name: value
                        for name, value in self.headers.items()
                        if name.lower() in INTERESTING
                    },
                }
            )

        if path == "/broken":
            self.send_json(500, {"error": "this receiver is having a bad day"})
            return

        self.send_json(200, {"received": True})


server = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
server.daemon_threads = True

print(f"receiver listening on {PORT} — /hook, /broken, GET /_deliveries", flush=True)

server.serve_forever()
