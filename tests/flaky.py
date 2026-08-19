#
# A site that fails in a way that GOES AWAY, and one that fails in a way that does not.
#
# tests/blackhole.py answers nothing, ever. That reproduces a wedged run, but it
# cannot reproduce the case batch-level retry exists for: a site that times out
# once and then answers perfectly. "It worked on the second attempt" is not
# observable against a site that never works, and neither is "it was NOT retried,
# because the site's answer was a decision rather than a hiccup".
#
# One process serves several scenarios, chosen by the FIRST PATH SEGMENT, because
# GopClient builds every URL as `<baseUrl>/index.php?route=…` — so a store whose
# base URL is `http://host:8081/timeout-once` lands here as
# `/timeout-once/index.php?route=/products/batch`. That keeps one container for
# the whole suite while each scenario keeps its own request counter.
#
# The counters are the point of several assertions: "was it retried" and "was it
# retried the right number of times" are questions about how many requests the
# site RECEIVED, which is a fact only the site has. `GET /_counts` returns them,
# keyed by "<scenario> <route>" — a run does not only send batches, and counting
# every request together made a successful run's closing `/maintenance/clear-
# transients` read as a third attempt at the batch.
#
# Threaded, for the same reason blackhole.py is: a scenario that hangs must hang
# only its own connection, or the counter read would hang with it.
#
# Used by tests/cancel.sh. Never used by the application.

import json
import threading
import time
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PORT = 8081

# How long the `slow` scenario takes to answer. Well over the lane-reduction
# threshold the suite runs with (1500ms) and well under the request deadline
# (8000ms), so a slow site is unambiguously slow WITHOUT ever being a timeout —
# which is the distinction the lane-reduction phases exist to make.
SLOW_SECONDS = 3

counts = {}
counts_lock = threading.Lock()


def bump(key):
    with counts_lock:
        counts[key] = counts.get(key, 0) + 1
        return counts[key]


class Handler(BaseHTTPRequestHandler):
    # Quiet: the suite's output is read by a person, and one line per request
    # would bury the assertions.
    def log_message(self, fmt, *args):
        pass

    def scenario(self):
        parts = [part for part in self.path.split("?")[0].split("/") if part != ""]
        return parts[0] if parts else ""

    def route(self):
        query = urllib.parse.urlparse(self.path).query
        return (urllib.parse.parse_qs(query).get("route") or [""])[0]

    def body(self):
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length) if length > 0 else b""
        try:
            return json.loads(raw or b"{}")
        except ValueError:
            return {}

    def send_json(self, status, payload):
        encoded = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(encoded)))
        self.end_headers()
        self.wfile.write(encoded)

    def ok_batch(self, payload):
        """What the plugin answers for a batch where every row succeeded."""
        products = payload.get("products") or []
        results = [
            {
                "index": index,
                "ok": True,
                "product_id": 500000 + index,
                "sku": (product or {}).get("sku") or "",
            }
            for index, product in enumerate(products)
        ]

        self.send_json(
            200,
            {
                "total": len(results),
                "succeeded": len(results),
                "failed": 0,
                "elapsed_ms": 7,
                "results": results,
            },
        )

    def hang(self):
        """Read the request, answer nothing, never close — the client must give up."""
        threading.Event().wait()

    def do_GET(self):
        if self.path.startswith("/_counts"):
            with counts_lock:
                self.send_json(200, dict(counts))
            return

        self.send_json(404, {"error": {"code": "unknown_route", "message": "no such route"}})

    def do_POST(self):
        scenario = self.scenario()
        route = self.route()
        payload = self.body()
        # Counted per route, so "how many times was the BATCH sent" is answerable.
        attempt = bump(f"{scenario} {route}")

        # A run that succeeded clears the site's transients afterwards. Answered
        # rather than treated as another batch, or the scenarios below would see
        # an attempt that was never a batch.
        if route == "/maintenance/clear-transients":
            self.send_json(200, {"cleared": True})
            return

        # Times out once, then works. The whole reason retry exists.
        if scenario == "timeout-once":
            if attempt == 1:
                self.hang()
            else:
                self.ok_batch(payload)
            return

        # Never answers. Two scenarios rather than one because each keeps its own
        # counter, and both phases assert an exact request count: `always-timeout`
        # proves the attempts are BOUNDED, `stop-backoff` proves a Stop during a
        # backoff means the batch is never sent again.
        if scenario in ("always-timeout", "stop-backoff"):
            self.hang()
            return

        # Answers correctly, but slowly. A shop that is coping badly rather than
        # failing: nothing here is an error, and a run that only watched for errors
        # would hammer it with every lane it was given.
        if scenario == "slow":
            time.sleep(SLOW_SECONDS)
            self.ok_batch(payload)
            return

        # Answers correctly and at once. The control: the same worker, the same
        # threshold, the same run shape — and no lane should stand down.
        if scenario == "fast":
            self.ok_batch(payload)
            return

        # A decision, not a hiccup: the site looked at the batch and refused it.
        # Retrying would take three times as long to reach the same answer, so
        # this scenario's counter must stay at 1.
        if scenario == "reject":
            self.send_json(
                400,
                {
                    "error": {
                        "code": "missing_name",
                        "message": "A product has no name. This will fail identically however "
                        "many times it is sent.",
                    }
                },
            )
            return

        self.send_json(404, {"error": {"code": "unknown_route", "message": scenario}})


server = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
# Daemon threads: the process is killed by `docker rm`, not by a clean exit.
server.daemon_threads = True

print(
    f"flaky listening on {PORT} — /timeout-once, /always-timeout, /stop-backoff, "
    f"/reject, /slow ({SLOW_SECONDS}s), /fast, GET /_counts",
    flush=True,
)

server.serve_forever()
