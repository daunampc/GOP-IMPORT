#!/usr/bin/env bash
#
# Image staging: the downloader, the SSRF guard, the packing arithmetic and the
# run-level cache.
#
#   ./tests/images-staging.sh
#
# Deliberately the LIGHT suite. It needs the fake image host and nothing else — no
# Postgres, no Redis, no `next build` — because none of what it tests lives on the
# request path. tests/isolation.sh stands up the whole app for the guards and the
# session handling, and takes minutes to do it; a downloader, an arithmetic function
# and a Map do not need any of that, and a test that takes minutes to run is a test
# that stops being run.
#
# The plugin is stubbed here. What the plugin does with an upload is tested in
# GPM_toshstack/tests/integration.php, and tests/e2e.sh proves the two halves meet
# over real HTTP.
#
# THE GUARD STAYS ON. `GOP_ALLOW_PRIVATE_IMAGE_HOSTS` is not set, because turning it
# off would make the most important assertion here — that a public URL redirecting to
# 169.254.169.254 is refused at the second hop — pass whether the guard exists or
# not. The fixture host is instead allowlisted BY NAME through
# GOP_IMAGE_HOST_ALLOWLIST, which leaves every literal address in those tests
# blocked, so they fail if the guard breaks.

set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

NETWORK="tsd-img-net"
IMAGES="tsd-img-host"
SUITE="tsd-img-suite"

cleanup() {
    docker rm -f "$IMAGES" "$SUITE" >/dev/null 2>&1 || true
    docker network rm "$NETWORK" >/dev/null 2>&1 || true
}
trap cleanup EXIT
cleanup

docker network create "$NETWORK" >/dev/null

echo "1/2  Starting the image host..."
docker run -d --name "$IMAGES" --network "$NETWORK" \
    -v "$APP_DIR/tests/images.py":/images.py:ro \
    python:3.12-alpine python3 -u /images.py >/dev/null

echo -n "     waiting"
for _ in $(seq 1 30); do
    if docker run --rm --network "$NETWORK" curlimages/curl:latest \
        -fsS "http://$IMAGES:8090/_hits" >/dev/null 2>&1; then
        break
    fi
    echo -n "."
    sleep 1
done
echo " — ready"

echo
echo "2/2  Running the staging suite"

# The container name resolves to a Docker network address, which is inside one of the
# ranges the guard blocks. Allowlisting that ONE name keeps the guard live for
# everything else the suite points at.
#
# `tsx` is installed IN THE CONTAINER rather than taken from the mounted
# node_modules, and that is not a preference: tsx runs on esbuild, esbuild ships a
# native binary, and a node_modules installed on macOS carries the darwin build,
# which a Linux container cannot execute. tests/isolation.sh solves the same problem
# by copying the source into a volume and running a full `pnpm install`, which costs
# minutes; this suite needs one package, so it installs one. The application's own
# dependencies are pure JavaScript and resolve from the mount as they are.
docker run --rm --name "$SUITE" --network "$NETWORK" \
    -v "$APP_DIR":/app -w /app \
    -e "IMAGE_HOST=http://$IMAGES:8090" \
    -e "GOP_IMAGE_HOST_ALLOWLIST=$IMAGES" \
    -e "GOP_ALLOW_PRIVATE_IMAGE_HOSTS=" \
    node:22-alpine sh -c 'npm install -g tsx@4 >/dev/null 2>&1 && tsx tests/images-staging.ts' 
