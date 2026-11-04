#!/usr/bin/env bash
#
# S3 mode never publishes a source link.
#
#   ./tests/s3-only.sh
#
# A fake bucket, no Docker, no network, no database.

set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

cd "$APP_DIR"
exec ./node_modules/.bin/tsx tests/s3-only.ts
