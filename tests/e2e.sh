#!/usr/bin/env bash
#
# End to end on a real stack: Postgres + MySQL + the PHP plugin + Redis + worker.
#
#   ./tests/e2e.sh
#
# Three stages, separated by deliberate PROCESS boundaries:
#   1. the "web" creates a site, queues a job, and EXITS
#   2. the worker (a different process) handles the job
#   3. a NEW "web" process reads the results back out of Postgres
#
# If any of that state lived in the web process's memory, stage 3 would see
# nothing at all.
#
# Postgres is the system of record: sites, accounts, runs and per-row results
# all live there. Redis holds only the queue and the cancel flag, so without
# Postgres the entire lib layer cannot run.

set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Where the PHP plugin lives. It used to sit two levels up, when this app was a
# folder inside the plugin repository; it is now its own checkout beside it.
# Both layouts are tried, and PLUGIN_DIR can name a third.
if [ -z "${PLUGIN_DIR:-}" ]; then
    for candidate in "$APP_DIR/../.." "$APP_DIR/../../../GPM_toshstack"; do
        if [ -f "$candidate/index.php" ] && [ -d "$candidate/src" ]; then
            PLUGIN_DIR="$(cd "$candidate" && pwd)"
            break
        fi
    done
fi

if [ -z "${PLUGIN_DIR:-}" ] || [ ! -f "$PLUGIN_DIR/index.php" ]; then
    echo "Could not find the PHP plugin. Set PLUGIN_DIR to its directory." >&2
    exit 1
fi

echo "     plugin: $PLUGIN_DIR"

NETWORK="tsd-e2e-net"
MYSQL="tsd-e2e-mysql"
POSTGRES="tsd-e2e-postgres"
REDIS="tsd-e2e-redis"
PHP="tsd-e2e-php"
IMAGES="tsd-e2e-images"

PG_PASSWORD="e2e-postgres"
PG_DATABASE="gop_e2e"

API_KEY="e2ekey0123456789"
API_SECRET="e2e0000000000000000000000000000000000000000000000000000000000secret"

# The encryption key must be THE SAME in both stages — the site secret is
# encrypted in stage 1 and decrypted in stage 2. Generated once here and passed
# in.
STORE_ENCRYPTION_KEY="$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')"

cleanup() {
    docker rm -f "$MYSQL" "$POSTGRES" "$REDIS" "$PHP" "$IMAGES" >/dev/null 2>&1 || true
    docker network rm "$NETWORK" >/dev/null 2>&1 || true
    rm -rf "$APP_DIR/.e2e-plugin"
}
trap cleanup EXIT
cleanup

docker network create "$NETWORK" >/dev/null

echo "1/6  Starting MySQL, Postgres, Redis and the image host..."
docker run -d --name "$MYSQL" --network "$NETWORK" \
    -e MYSQL_ROOT_PASSWORD=root -e MYSQL_DATABASE=wptest \
    mysql:8.0 --log_bin_trust_function_creators=1 \
    --character-set-server=utf8mb4 --collation-server=utf8mb4_unicode_ci >/dev/null

docker run -d --name "$POSTGRES" --network "$NETWORK" \
    -e POSTGRES_PASSWORD="$PG_PASSWORD" -e POSTGRES_DB="$PG_DATABASE" \
    postgres:17-alpine >/dev/null

docker run -d --name "$REDIS" --network "$NETWORK" -p 6399:6379 redis:7-alpine >/dev/null

# The source of the images an upload_site run copies. The SAME fixture the light
# staging suite uses, so the two describe one host rather than two.
docker run -d --name "$IMAGES" --network "$NETWORK" \
    -v "$APP_DIR/tests/images.py":/images.py:ro \
    python:3.12-alpine python3 -u /images.py >/dev/null

echo -n "     waiting for MySQL"
for _ in $(seq 1 60); do
    if docker exec "$MYSQL" mysqladmin ping -uroot -proot --silent >/dev/null 2>&1; then break; fi
    echo -n "."
    sleep 2
done
echo " — ready"

echo -n "     waiting for Postgres"
for _ in $(seq 1 60); do
    if docker exec "$POSTGRES" pg_isready -U postgres >/dev/null 2>&1; then break; fi
    echo -n "."
    sleep 1
done
echo " — ready"

echo "2/6  Building a plugin copy configured against the test MySQL..."
rm -rf "$APP_DIR/.e2e-plugin"
mkdir -p "$APP_DIR/.e2e-plugin"
tar cf - -C "$PLUGIN_DIR" --exclude=clients --exclude=docs --exclude=.git --exclude=dist . \
    | tar xf - -C "$APP_DIR/.e2e-plugin"
mkdir -p "$APP_DIR/.e2e-plugin/config" "$APP_DIR/.e2e-plugin/logs"

# A WordPress root the plugin can actually WRITE into, which upload_site needs and
# no earlier stage did. Named explicitly rather than left to `dirname(__DIR__, 4)`,
# which from a plugin mounted at /app resolves to the container's `/`.
mkdir -p "$APP_DIR/.e2e-plugin/wp/wp-content/uploads"

cat > "$APP_DIR/.e2e-plugin/config/config.ini" <<EOF
db_host = "$MYSQL"
db_user = "root"
db_password = "root"
db_name = "wptest"
table_prefix = "wp_"
charset = "utf8mb4"
collate = "utf8mb4_unicode_ci"
site_url = "http://$PHP:8080"
api_key = "$API_KEY"
api_secret = "$API_SECRET"
persistent_connection = "0"
wordpress_root = "/app/wp"
EOF

# The plugin refuses EVERY route without a valid activation key, so the harness has
# to activate the installation it just staged — the same thing an operator does in
# wp-admin, written straight to the file the API reads.
#
# `verified_at` is stamped now rather than left out: the gate refuses a key that has
# never been confirmed, which is the correct behaviour and would otherwise make this
# whole suite a test of the licence gate rather than of the import.
LICENSE_KEY="GOP-E2E1-E2E2-E2E3"
LICENSE_FINGERPRINT="$(printf '%s' "$LICENSE_KEY" | shasum -a 256 | cut -d' ' -f1)"

cat > "$APP_DIR/.e2e-plugin/config/license.json" <<EOF
{
  "key": "$LICENSE_KEY",
  "status": "valid",
  "reason": "",
  "expires_at": null,
  "verified_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "app_url": "http://localhost:3000"
}
EOF

echo "3/6  Loading the schema and stored routines..."
docker run --rm --network "$NETWORK" -v "$APP_DIR/.e2e-plugin":/app -w /app \
    -e MYSQL_HOST="$MYSQL" -e MYSQL_USER=root -e MYSQL_PASSWORD=root -e MYSQL_DATABASE=wptest \
    php:8.2-cli sh -c 'docker-php-ext-install mysqli >/dev/null 2>&1 && php tests/integration.php' \
    | tail -3

echo "4/6  Serving the plugin from PHP's built-in server..."
docker run -d --name "$PHP" --network "$NETWORK" \
    -v "$APP_DIR/.e2e-plugin":/app -w /app \
    php:8.2-cli sh -c 'docker-php-ext-install mysqli >/dev/null 2>&1 && php -S 0.0.0.0:8080' >/dev/null
sleep 4

echo "5/6  Stage 1 — the web process queues a job and exits"
SEED_OUTPUT=$(docker run --rm --network "$NETWORK" -v "$APP_DIR":/src:ro node:22-alpine sh -c '
mkdir -p /work && cd /src && tar cf - --exclude=node_modules --exclude=.next --exclude=.git --exclude=.e2e-plugin . | (cd /work && tar xf -)
cd /work
corepack enable >/dev/null 2>&1
pnpm install --no-frozen-lockfile >/dev/null 2>&1
export REDIS_URL="redis://'"$REDIS"':6379"
export STORE_ENCRYPTION_KEY="'"$STORE_ENCRYPTION_KEY"'"
export DB_HOST="'"$POSTGRES"'"
export DB_PORT="5432"
export DB_USERNAME="postgres"
export DB_PASSWORD="'"$PG_PASSWORD"'"
export DB_DATABASE="'"$PG_DATABASE"'"
export PLUGIN_URL="http://'"$PHP"':8080"
export PLUGIN_API_KEY="'"$API_KEY"'"
export PLUGIN_API_SECRET="'"$API_SECRET"'"
export E2E_LICENSE_KEY="'"$LICENSE_KEY"'"
export IMAGE_HOST="http://'"$IMAGES"':8090"
export GOP_IMAGE_HOST_ALLOWLIST="'"$IMAGES"'"
# The Postgres schema has to exist before anything in the lib layer touches it.
./node_modules/.bin/tsx db/migrate.ts >/dev/null
./node_modules/.bin/tsx tests/e2e.ts seed
' 2>&1) || true

echo "$SEED_OUTPUT"
JOB_ID=$(echo "$SEED_OUTPUT" | grep '^JOB_ID=' | cut -d= -f2)
# The accounts are created in stage 1 and needed again in stage 3, in a
# different process. Carried across the boundary the same way the job id is.
ACCOUNT_BOB=$(echo "$SEED_OUTPUT" | grep '^ACCOUNT_BOB=' | cut -d= -f2)
ACCOUNT_ADMIN=$(echo "$SEED_OUTPUT" | grep '^ACCOUNT_ADMIN=' | cut -d= -f2)

if [ -z "$JOB_ID" ]; then
    echo "No JOB_ID came back — stopping."
    exit 1
fi

echo
echo "6/6  Stages 2+3 — the worker runs, then a new process reads the results"

# Captured rather than streamed, so the WORKER's own output can be grepped for
# the fixture secrets afterwards. The worker is the noisy process here — it
# decrypts a site secret to talk to the plugin and reads an account's AWS keys
# to stage images — so it is the one worth checking. `tee` keeps it on screen.
RUN_LOG="$APP_DIR/.e2e-run.log"
rm -f "$RUN_LOG"

set +e
docker run --rm --network "$NETWORK" -v "$APP_DIR":/src:ro node:22-alpine sh -c '
mkdir -p /work && cd /src && tar cf - --exclude=node_modules --exclude=.next --exclude=.git --exclude=.e2e-plugin . | (cd /work && tar xf -)
cd /work
corepack enable >/dev/null 2>&1
pnpm install --no-frozen-lockfile >/dev/null 2>&1
export REDIS_URL="redis://'"$REDIS"':6379"
export STORE_ENCRYPTION_KEY="'"$STORE_ENCRYPTION_KEY"'"
export DB_HOST="'"$POSTGRES"'"
export DB_PORT="5432"
export DB_USERNAME="postgres"
export DB_PASSWORD="'"$PG_PASSWORD"'"
export DB_DATABASE="'"$PG_DATABASE"'"
export JOB_ID="'"$JOB_ID"'"
export ACCOUNT_BOB="'"$ACCOUNT_BOB"'"
export ACCOUNT_ADMIN="'"$ACCOUNT_ADMIN"'"
export IMAGE_HOST="http://'"$IMAGES"':8090"
export GOP_IMAGE_HOST_ALLOWLIST="'"$IMAGES"'"

./node_modules/.bin/tsx worker/index.ts &
WORKER_PID=$!
sleep 2
./node_modules/.bin/tsx tests/e2e.ts verify
STATUS=$?
kill $WORKER_PID 2>/dev/null || true
exit $STATUS
' 2>&1 | tee "$RUN_LOG"
RUN_STATUS=${PIPESTATUS[0]}
set -e

echo
echo "     No secret in the worker output"

LEAKED=0
for secret in \
    "alice-secret-never-logged" \
    "admin-secret-never-logged" \
    "bob-secret-never-logged" \
    "$API_SECRET" \
    "$STORE_ENCRYPTION_KEY"
do
    if grep -qF "$secret" "$RUN_LOG"; then
        echo "  FAIL a secret appears in the worker output"
        LEAKED=1
    fi
done

if [ "$LEAKED" -eq 0 ]; then
    echo "  ok   none of the 5 secrets appears in $(wc -l < "$RUN_LOG" | tr -d ' ') lines of output"
fi

if [ "$RUN_STATUS" -ne 0 ] || [ "$LEAKED" -ne 0 ]; then
    exit 1
fi
