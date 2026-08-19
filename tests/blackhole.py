#
# A site that accepts the connection, reads the request, and never answers.
#
# This is the shape of failure that made Cancel useless: not a refused
# connection and not a slow site, but an overloaded shop, a hung PHP-FPM pool or
# a firewall that blackholes the response. `nc` is no good for it — a busybox
# listener CLOSES the connection, so the batch fails fast and the run completes
# before a cancel can land, which is exactly why this defect was never
# reproduced before.
#
# Threaded rather than the single accept loop, so every lane's connection is
# genuinely accepted and read. With one thread the extra lanes would sit in the
# listen backlog, which is a different stall from the one under test.
#
# Used by tests/cancel.sh. Never answers, never closes, never times out.

import socket
import threading

PORT = 8080

def handle(connection):
    try:
        connection.recv(65536)  # read the request, answer nothing, never close
        # Hold the connection open for ever. The client is what has to give up.
        threading.Event().wait()
    except Exception:
        pass

listener = socket.socket()
listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
listener.bind(("0.0.0.0", PORT))
listener.listen(64)

print(f"blackhole listening on {PORT} — reads requests, never replies", flush=True)

while True:
    connection, _address = listener.accept()
    # Daemon threads: the process is killed by docker rm, not by a clean exit.
    threading.Thread(target=handle, args=(connection,), daemon=True).start()
