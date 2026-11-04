#!/usr/bin/env bash
#
# A resend folds back into the run it came from.
#
#   ./tests/resend-merge.sh
#
# Needs Docker: a throwaway Postgres (the merge is SQL) and Redis (importing lib/jobs
# opens its queue). No app build, no worker.

set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

NETWORK="tsd-merge-net"
POSTGRES="tsd-merge-postgres"
REDIS="tsd-merge-redis"
PG_PASSWORD="merge-postgres"
PG_DATABASE="gop_merge"

cleanup() {
    docker rm -f "$POSTGRES" "$REDIS" >/dev/null 2>&1 || true
    docker network rm "$NETWORK" >/dev/null 2>&1 || true
}
trap cleanup EXIT
cleanup

docker network create "$NETWORK" >/dev/null

docker run -d --name "$POSTGRES" --network "$NETWORK" \
    -e POSTGRES_PASSWORD="$PG_PASSWORD" -e POSTGRES_DB="$PG_DATABASE" \
    postgres:17-alpine >/dev/null
docker run -d --name "$REDIS" --network "$NETWORK" redis:7-alpine >/dev/null

echo -n "waiting for Postgres"
for _ in $(seq 1 60); do
    if docker exec "$POSTGRES" pg_isready -U postgres >/dev/null 2>&1; then break; fi
    echo -n "."
    sleep 1
done
echo " — ready"

# A Linux tsx beside the app: the host's node_modules holds the host's esbuild.
docker run --rm --network "$NETWORK" -v "$APP_DIR":/app:ro -w /tmp \
    -e "REDIS_URL=redis://$REDIS:6379" \
    -e "STORE_ENCRYPTION_KEY=$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')" \
    -e "JWT_SECRET=$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')" \
    -e "DB_HOST=$POSTGRES" -e "DB_PORT=5432" -e "DB_USERNAME=postgres" \
    -e "DB_PASSWORD=$PG_PASSWORD" -e "DB_DATABASE=$PG_DATABASE" \
    node:22 sh -c '
npm i tsx@4 --silent --no-audit --no-fund >/dev/null 2>&1
cd /app
/tmp/node_modules/.bin/tsx db/migrate.ts >/dev/null
/tmp/node_modules/.bin/tsx tests/resend-merge.ts
'
