#!/usr/bin/env bash
#
# How a rate-limited image is retried.
#
#   ./tests/image-retry.sh
#
# A fake bucket and a fake clock: no Docker, no network, no database.

set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

cd "$APP_DIR"
exec ./node_modules/.bin/tsx tests/image-retry.ts
