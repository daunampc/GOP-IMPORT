#!/usr/bin/env bash
#
# Cancelling, Stopping and deleting runs, against a site that never answers.
#
#   ./tests/cancel.sh
#
# A different stack from e2e.sh and a different boundary. No MySQL and no PHP:
# the site under test is tests/blackhole.py, which accepts the connection, reads
# the request and never replies. That is the only shape of failure that
# reproduces the defect — a site that REFUSES or CLOSES fails the batch fast, the
# run completes, and Cancel appears to work perfectly.
#
# The worker runs as its own CONTAINER rather than a background process, so it
# can be SIGKILLed without releasing its BullMQ lock. That is what makes the
# resurrection stage a real test of redelivery rather than of clean shutdown.
#
# node_modules comes from the shared tsd-nm volume rather than a pnpm install per
# container, which is what keeps this quick enough to run in a loop.

set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

NETWORK="tsd-cancel-net"
POSTGRES="tsd-cancel-postgres"
REDIS="tsd-cancel-redis"
BLACKHOLE="tsd-cancel-blackhole"
FLAKY="tsd-cancel-flaky"
RECEIVER="tsd-cancel-receiver"
WORKER="tsd-cancel-worker"

PG_PASSWORD="cancel-postgres"
PG_DATABASE="gop_cancel"

STORE_ENCRYPTION_KEY="$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')"

# Short enough that a graceful Cancel can be measured at all, long enough that
# the cancel is what ends the run rather than the deadline beating it there. Stop
# has to come in well under this — that gap is the difference between the buttons.
REQUEST_TIMEOUT_MS="${REQUEST_TIMEOUT_MS:-8000}"

RUN_LOG="$APP_DIR/.cancel-run.log"
rm -f "$RUN_LOG"

cleanup() {
    docker rm -f "$POSTGRES" "$REDIS" "$BLACKHOLE" "$FLAKY" "$RECEIVER" "$WORKER" >/dev/null 2>&1 || true
    docker network rm "$NETWORK" >/dev/null 2>&1 || true
}
trap cleanup EXIT
cleanup

docker network create "$NETWORK" >/dev/null

# Built as an array: a string of docker flags passed unquoted is ONE argument in
# zsh, which is a trap already hit once in this project.
node_env=(
    -e "REDIS_URL=redis://$REDIS:6379"
    -e "STORE_ENCRYPTION_KEY=$STORE_ENCRYPTION_KEY"
    -e "DB_HOST=$POSTGRES"
    -e "DB_PORT=5432"
    -e "DB_USERNAME=postgres"
    -e "DB_PASSWORD=$PG_PASSWORD"
    -e "DB_DATABASE=$PG_DATABASE"
    -e "BLACKHOLE_URL=http://$BLACKHOLE:8080"
    -e "FLAKY_URL=http://$FLAKY:8081"
    -e "RECEIVER_URL=http://$RECEIVER:8091"
    # Telegram, pointed at the receiver: the suite cannot call the real API.
    -e "TELEGRAM_API_BASE=http://$RECEIVER:8091"
    -e "GOP_REQUEST_TIMEOUT_MS=$REQUEST_TIMEOUT_MS"
)

mounts=(-v "$APP_DIR":/app -v tsd-nm:/app/node_modules -w /app)

# One phase of the suite, in its own process, output teed for the secret grep.
phase() {
    local name="$1"
    shift
    docker run --rm --network "$NETWORK" "${mounts[@]}" "${node_env[@]}" "$@" \
        node:22-alpine ./node_modules/.bin/tsx tests/cancel.ts "$name" 2>&1 | tee -a "$RUN_LOG"
    return "${PIPESTATUS[0]}"
}

# Extra `-e` flags are passed straight through, which is how the retry phases get a
# different backoff without a different suite: the WORKER is what reads it, so it
# cannot be set per phase process.
start_worker() {
    docker rm -f "$WORKER" >/dev/null 2>&1 || true
    docker run -d --name "$WORKER" --network "$NETWORK" "${mounts[@]}" "${node_env[@]}" "$@" \
        node:22-alpine ./node_modules/.bin/tsx worker/index.ts >/dev/null
    sleep 3
}

FAILED=0
note_phase() { echo; echo "── $1"; }

echo "1/14 Starting Postgres, Redis and the two fixture sites..."

docker run -d --name "$POSTGRES" --network "$NETWORK" \
    -e POSTGRES_PASSWORD="$PG_PASSWORD" -e POSTGRES_DB="$PG_DATABASE" \
    postgres:17-alpine >/dev/null

docker run -d --name "$REDIS" --network "$NETWORK" redis:7-alpine >/dev/null

docker run -d --name "$BLACKHOLE" --network "$NETWORK" \
    -v "$APP_DIR/tests/blackhole.py":/blackhole.py:ro \
    python:3.12-alpine python3 -u /blackhole.py >/dev/null

# The other end of the run-finished webhook: records what actually arrived, so a
# test can verify the signature over the bytes rather than trust this app's account.
docker run -d --name "$RECEIVER" --network "$NETWORK" \
    -v "$APP_DIR/tests/receiver.py":/receiver.py:ro \
    python:3.12-alpine python3 -u /receiver.py >/dev/null

# A site that fails and then STOPS failing — the only way "it went through on the
# second attempt" is observable. The blackhole cannot serve it: it never works.
docker run -d --name "$FLAKY" --network "$NETWORK" \
    -v "$APP_DIR/tests/flaky.py":/flaky.py:ro \
    python:3.12-alpine python3 -u /flaky.py >/dev/null

echo -n "     waiting for Postgres"
for _ in $(seq 1 60); do
    if docker exec "$POSTGRES" pg_isready -U postgres >/dev/null 2>&1; then break; fi
    echo -n "."
    sleep 1
done
echo " — ready"

echo "2/14  Loading the schema..."
docker run --rm --network "$NETWORK" "${mounts[@]}" "${node_env[@]}" node:22-alpine \
    ./node_modules/.bin/tsx db/migrate.ts >/dev/null

note_phase "3/14  Stage 1 — the web process stages a run at the blackhole and exits"
SEED=$(docker run --rm --network "$NETWORK" "${mounts[@]}" "${node_env[@]}" \
    -e SEED_TAG=a node:22-alpine ./node_modules/.bin/tsx tests/cancel.ts seed 2>&1) || FAILED=1
echo "$SEED" | tee -a "$RUN_LOG"

ACCOUNT_ALICE=$(echo "$SEED" | grep '^ACCOUNT_ALICE=' | cut -d= -f2)
STORE_ID=$(echo "$SEED" | grep '^STORE_ID=' | cut -d= -f2)
JOB_A=$(echo "$SEED" | grep '^JOB_ID=' | cut -d= -f2)

if [ -z "$JOB_A" ]; then
    echo "No JOB_ID came back — stopping."
    exit 1
fi

# Every later seed reuses the account and the site.
reuse=(-e "ACCOUNT_ALICE=$ACCOUNT_ALICE" -e "STORE_ID=$STORE_ID")

seed_run() {
    local tag="$1"
    docker run --rm --network "$NETWORK" "${mounts[@]}" "${node_env[@]}" "${reuse[@]}" \
        -e "SEED_TAG=$tag" node:22-alpine ./node_modules/.bin/tsx tests/cancel.ts seed 2>&1 \
        | tee -a "$RUN_LOG" | grep '^JOB_ID=' | cut -d= -f2
}

note_phase "4/14  Cancel — the red test: a wedged run must reach cancelled"
start_worker
phase cancel -e "JOB_ID=$JOB_A" || FAILED=1

note_phase "5/14  Redelivery — the cancelled run is handed to the queue again"
phase redeliver -e "JOB_ID=$JOB_A" || FAILED=1

note_phase "6/14  Stop — end a wedged run immediately, and say what that costs"
JOB_B=$(seed_run b)
phase stop -e "JOB_ID=$JOB_B" || FAILED=1

note_phase "6b/14  Bulk edit — the same queue, log and Stop, at the same wedged site"
# This phase stages its own run rather than taking one from seed_run: a bulk edit's
# payload is a list of resolved changes, not products, so `seed_run` cannot make one.
# It does need the account and the site, which is what `reuse` carries.
phase editstop "${reuse[@]}" || FAILED=1

note_phase "7/14  Resurrection — SIGKILL the worker mid-cancel, then restart it"
JOB_C=$(seed_run c)

# Wedge the run and press Cancel, then kill hard before the worker can write the
# final status. SIGKILL, so the BullMQ lock is NOT released — a clean SIGTERM
# would finish the run, which is the case that already worked.
phase arm -e "JOB_ID=$JOB_C" || FAILED=1

docker kill -s KILL "$WORKER" >/dev/null 2>&1 || true
echo "     Worker SIGKILLed — its BullMQ lock was never released."

start_worker
phase resurrect -e "JOB_ID=$JOB_C" || FAILED=1

note_phase "8/14  Scheduled — a run fires on its own, and is re-checked when it does"
phase schedule -e "ACCOUNT_ALICE=$ACCOUNT_ALICE" -e "STORE_ID=$STORE_ID" || FAILED=1

note_phase "9/14  Delete — a finished run's rows go; a live run is refused"
JOB_D=$(seed_run d)
phase remove -e "JOB_ID=$JOB_B" -e "LIVE_JOB_ID=$JOB_D" || FAILED=1

note_phase "10/14 Retry — a transient failure is sent again; a refusal is not"
# A short backoff here: three phases run under it and the suite is meant to be
# runnable in a loop. The one that MEASURES the backoff gets its own worker below.
start_worker -e "GOP_RETRY_BACKOFF_MS=1000"
phase retrysucceeds "${reuse[@]}" || FAILED=1
phase retryexhausted "${reuse[@]}" || FAILED=1
phase retrynever "${reuse[@]}" || FAILED=1

note_phase "11/14 Retry — Stop pressed while a batch waits out its backoff"
# Deliberately long, so "it did not wait the backoff out" is measured rather than
# assumed. Both the worker and the phase need it: one obeys it, the other asserts it.
RETRY_STOP_BACKOFF_MS=25000
start_worker -e "GOP_RETRY_BACKOFF_MS=$RETRY_STOP_BACKOFF_MS"
phase retrystop "${reuse[@]}" -e "GOP_RETRY_BACKOFF_MS=$RETRY_STOP_BACKOFF_MS" || FAILED=1

note_phase "12/14 Lanes — a slow site stands lanes down; a fast one keeps them all"
# ONE threshold for both phases, so the only variable is how fast the fixture
# answers. 1500ms is under the 3s the `slow` scenario takes and over what `fast`
# takes, and both are well inside the 8s request deadline — this is about a shop
# coping badly, not about a timeout.
LANE_SLOW_MS=1500
start_worker -e "GOP_SLOW_BATCH_MS=$LANE_SLOW_MS"
phase lanesdown "${reuse[@]}" -e "GOP_SLOW_BATCH_MS=$LANE_SLOW_MS" || FAILED=1
phase lanessteady "${reuse[@]}" -e "GOP_SLOW_BATCH_MS=$LANE_SLOW_MS" || FAILED=1

note_phase "13/14 Notify — the run tells a webhook and Telegram it has finished"
# The worker for these phases needs no special env: what changes is the account's
# own settings, written by the phase itself.
phase notify "${reuse[@]}" || FAILED=1
phase notifyfailures "${reuse[@]}" || FAILED=1
phase telegram "${reuse[@]}" || FAILED=1

note_phase "14/14 Repeat — a series fires, stages the next occurrence, and survives"
phase repeat "${reuse[@]}" || FAILED=1

echo
echo "── No secret in any of the output"

LEAKED=0
for secret in "cancel-secret-never-logged" "webhook-secret-never-logged" "telegram-token-never-logged" "$STORE_ENCRYPTION_KEY"; do
    if grep -qF "$secret" "$RUN_LOG"; then
        echo "  FAIL a secret appears in the output"
        LEAKED=1
    fi
done

if [ "$LEAKED" -eq 0 ]; then
    echo "  ok   neither secret appears in $(wc -l < "$RUN_LOG" | tr -d ' ') lines of output"
fi

# The worker's own output is the noisiest and the one worth checking: it decrypts
# a site secret to talk to the plugin.
docker logs "$WORKER" > "$APP_DIR/.cancel-worker.log" 2>&1 || true
for secret in "cancel-secret-never-logged" "webhook-secret-never-logged" "telegram-token-never-logged" "$STORE_ENCRYPTION_KEY"; do
    if grep -qF "$secret" "$APP_DIR/.cancel-worker.log"; then
        echo "  FAIL a secret appears in the worker log"
        LEAKED=1
    fi
done

echo
if [ "$FAILED" -ne 0 ] || [ "$LEAKED" -ne 0 ]; then
    echo "FAILED"
    exit 1
fi
echo "All phases passed."
