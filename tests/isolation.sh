#!/usr/bin/env bash
#
# Customer isolation, administrator power, and the secret-reveal audit trail,
# against a REAL running app.
#
#   ./tests/isolation.sh
#
# Separate from tests/e2e.sh because it tests a different boundary and needs a
# different stack. e2e.sh proves the wire protocol and that a run survives a
# process boundary, and for that it needs MySQL and the PHP plugin. This one
# proves what a signed-in caller can reach, and for that it needs the actual
# Next.js server with the actual session handling — the guards, the ownership
# check and the view cookie all live on the request path, and calling the lib
# layer directly would prove only that an argument was passed.
#
# Three things happen here that cannot happen anywhere else:
#
#   1. Two member accounts in two cookie jars, asserting BY ID. The list filter
#      and the ownership check are two different bugs, and only the second one
#      is reachable by pasting a URL.
#   2. An administrator entering an account and writing INTO it.
#   3. The server's own stdout/stderr is captured and grepped for the fixture
#      secrets afterwards. "No secret reaches a log" is not something you can
#      assert from inside the process doing the logging.

set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

NETWORK="tsd-iso-net"
POSTGRES="tsd-iso-postgres"
REDIS="tsd-iso-redis"
WEB="tsd-iso-web"
IMAGES="tsd-iso-images"

PG_PASSWORD="iso-postgres"
PG_DATABASE="gop_isolation"

STORE_ENCRYPTION_KEY="$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')"
JWT_SECRET="$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')"

# The app must be reached at exactly BETTER_AUTH_URL or better-auth rejects
# every sign-in as INVALID_ORIGIN, and the whole suite silently becomes a test
# of the sign-in screen.
#
# The suite runs in its own container and reaches the app by container name, so
# that name — not localhost — is what BETTER_AUTH_URL has to be. The host port
# is mapped anyway, for the readiness probe and for looking at it by hand.
PORT=3131
APP_URL="http://$WEB:3000"
HOST_URL="http://localhost:$PORT"

LOG="$APP_DIR/.isolation-server.log"

cleanup() {
    docker rm -f "$WEB" "$POSTGRES" "$REDIS" "$IMAGES" >/dev/null 2>&1 || true
    docker network rm "$NETWORK" >/dev/null 2>&1 || true
}
trap cleanup EXIT
cleanup
rm -f "$LOG"

docker network create "$NETWORK" >/dev/null

echo "1/5  Starting Postgres, Redis and the image host..."
docker run -d --name "$POSTGRES" --network "$NETWORK" \
    -e POSTGRES_PASSWORD="$PG_PASSWORD" -e POSTGRES_DB="$PG_DATABASE" \
    postgres:17-alpine >/dev/null

docker run -d --name "$REDIS" --network "$NETWORK" redis:7-alpine >/dev/null

# An image host with a live link, a dead one and one that answers 200 with a page
# rather than an image — the three outcomes the preview check has to tell apart.
docker run -d --name "$IMAGES" --network "$NETWORK" \
    -v "$APP_DIR/tests/images.py":/images.py:ro \
    python:3.12-alpine python3 -u /images.py >/dev/null

echo -n "     waiting for Postgres"
for _ in $(seq 1 60); do
    if docker exec "$POSTGRES" pg_isready -U postgres >/dev/null 2>&1; then break; fi
    echo -n "."
    sleep 1
done
echo " — ready"

ENV_ARGS=(
    -e "REDIS_URL=redis://$REDIS:6379"
    -e "STORE_ENCRYPTION_KEY=$STORE_ENCRYPTION_KEY"
    -e "JWT_SECRET=$JWT_SECRET"
    -e "BETTER_AUTH_URL=$APP_URL"
    -e "DB_HOST=$POSTGRES"
    -e "DB_PORT=5432"
    -e "DB_USERNAME=postgres"
    -e "DB_PASSWORD=$PG_PASSWORD"
    -e "DB_DATABASE=$PG_DATABASE"
    -e "APP_URL=$APP_URL"
    -e "IMAGE_HOST=http://$IMAGES:8090"
)

echo "2/5  Building the app and applying the schema..."
docker run --rm --network "$NETWORK" -v "$APP_DIR":/src:ro -v tsd-iso-work:/work \
    "${ENV_ARGS[@]}" node:22-alpine sh -c '
rm -rf /work/* /work/.next 2>/dev/null || true
cd /src && tar cf - --exclude=node_modules --exclude=.next --exclude=.git --exclude=backup . | (cd /work && tar xf -)
cd /work
corepack enable >/dev/null 2>&1
pnpm install --no-frozen-lockfile >/dev/null 2>&1
./node_modules/.bin/tsx db/migrate.ts
./node_modules/.bin/next build 2>&1 | tail -5
'

echo "3/5  Starting the app..."
docker run -d --name "$WEB" --network "$NETWORK" -p "$PORT:3000" \
    -v tsd-iso-work:/work -w /work "${ENV_ARGS[@]}" -e NODE_ENV=production \
    node:22-alpine ./node_modules/.bin/next start >/dev/null

echo -n "     waiting for the app"
for _ in $(seq 1 90); do
    if curl -fsS "$HOST_URL/api/register" >/dev/null 2>&1; then break; fi
    echo -n "."
    sleep 1
done
echo " — ready"

echo
echo "4/5  Running the isolation suite"
set +e
docker run --rm --network "$NETWORK" -v tsd-iso-work:/work -w /work \
    "${ENV_ARGS[@]}" node:22-alpine ./node_modules/.bin/tsx tests/isolation.ts
SUITE_STATUS=$?
set -e

echo
echo "5/5  No secret in the server log"

# Captured from the SERVER, not from the process that sent the secrets. A
# secret must never reach a log, a URL or an error message, and the only way to
# know is to look at what the server actually wrote.
docker logs "$WEB" > "$LOG" 2>&1

LEAKED=0
for secret in \
    "alice-webhook-secret-R2vT8x" \
    "alice-site-secret-Q7bX2m" \
    "bob-site-secret-Z4kP9w" \
    "alice-aws-secret-H3nR6t" \
    "bob-aws-secret-V8dL1c" \
    "correct-horse-battery-staple"
do
    if grep -qF "$secret" "$LOG"; then
        echo "  FAIL a fixture secret appears in the server log: $secret"
        grep -nF "$secret" "$LOG" | head -3
        LEAKED=1
    fi
done

if [ "$LEAKED" -eq 0 ]; then
    echo "  ok   none of the 5 fixture secrets appears in $(wc -l < "$LOG" | tr -d ' ') lines of server output"
fi

docker volume rm tsd-iso-work >/dev/null 2>&1 || true

if [ "$SUITE_STATUS" -ne 0 ] || [ "$LEAKED" -ne 0 ]; then
    exit 1
fi
