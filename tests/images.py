#
# An image host with one of everything the preview check has to tell apart.
#
# A dead image link is only discovered halfway through an import, when the run is
# already writing products. The check that finds it beforehand has to distinguish
# four outcomes, and three of them look identical to code that only asks "did the
# request succeed":
#
#   /ok.jpg        200, image/jpeg          — fine
#   /missing.jpg   404                      — the link is dead
#   /page.html     200, text/html           — the link ANSWERS, and is not an image.
#                                             A CDN's "not found" page served with
#                                             200 is the case that fools a naive check
#   /teapot.jpg    418                      — any other refusal
#
# And, since the app itself now DOWNLOADS the images rather than asking the site's
# PHP to fetch them, four more that only a downloader can be caught by:
#
#   /to-metadata.jpg   302 → 169.254.169.254  — a public URL that redirects into the
#                                               cloud metadata endpoint. Following
#                                               this is the SSRF that matters, and a
#                                               guard that only checks the FIRST URL
#                                               walks straight into it
#   /to-loopback.jpg   302 → 127.0.0.1        — the same trick, aimed at the host
#   /to-ok.jpg         302 → /ok.jpg          — an ordinary redirect, which must still
#                                               be followed; a guard that refuses all
#                                               redirects would look like it worked
#   /enormous.jpg      200, huge Content-Length — refused on the header, before a byte
#                                                 of the body is read
#
# Also answers HEAD, because that is what the check sends: an image can be
# megabytes and the preview only needs the headers.
#
# Used by tests/isolation.sh. Never used by the application.

import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PORT = 8090

# Enough bytes to be a plausible body; the check never reads one.
BODY = b"\xff\xd8\xff\xe0not-really-a-jpeg"

ROUTES = {
    "/ok.jpg": (200, "image/jpeg"),
    "/also-ok.png": (200, "image/png"),
    "/missing.jpg": (404, "text/plain"),
    "/page.html": (200, "text/html; charset=utf-8"),
    "/teapot.jpg": (418, "text/plain"),
}

# path -> Location. Answered as 302, so the caller decides whether to follow.
REDIRECTS = {
    "/to-metadata.jpg": "http://169.254.169.254/latest/meta-data/",
    "/to-loopback.jpg": "http://127.0.0.1:9/nope.jpg",
    "/to-ok.jpg": "/ok.jpg",
}

# A Content-Length far over any sane ceiling, with a short body behind it. The
# point is to be refused on the HEADER — a downloader that reads first and measures
# afterwards has already done the damage.
ENORMOUS_PATH = "/enormous.jpg"
ENORMOUS_LENGTH = 64 * 1024 * 1024

hits = {}
hits_lock = threading.Lock()


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        pass

    def path_only(self):
        return self.path.split("?")[0]

    def answer(self, with_body):
        path = self.path_only()

        if path == "/_hits":
            with hits_lock:
                body = repr(dict(hits)).encode()
            self.send_response(200)
            self.send_header("Content-Type", "text/plain")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            if with_body:
                self.wfile.write(body)
            return

        with hits_lock:
            hits[path] = hits.get(path, 0) + 1

        if path in REDIRECTS:
            self.send_response(302)
            self.send_header("Location", REDIRECTS[path])
            self.send_header("Content-Length", "0")
            self.end_headers()
            return

        if path == ENORMOUS_PATH:
            self.send_response(200)
            self.send_header("Content-Type", "image/jpeg")
            self.send_header("Content-Length", str(ENORMOUS_LENGTH))
            self.end_headers()
            if with_body:
                # Deliberately far short of what was declared. The caller must have
                # given up on the header, so it never gets here.
                self.wfile.write(BODY)
            return

        status, content_type = ROUTES.get(path, (404, "text/plain"))

        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(BODY)))
        self.end_headers()

        if with_body:
            self.wfile.write(BODY)

    def do_HEAD(self):
        self.answer(with_body=False)

    def do_GET(self):
        self.answer(with_body=True)


server = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
server.daemon_threads = True

print(
    f"images listening on {PORT} — "
    + ", ".join(sorted(list(ROUTES) + list(REDIRECTS) + [ENORMOUS_PATH])),
    flush=True,
)

server.serve_forever()
