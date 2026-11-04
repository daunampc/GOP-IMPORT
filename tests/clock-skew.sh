#!/usr/bin/env bash
#
# The client's correction for a site whose clock is off.
#
#   ./tests/clock-skew.sh
#
# A local fake of the plugin's authentication, no Docker, no database.

set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

cd "$APP_DIR"
exec ./node_modules/.bin/tsx tests/clock-skew.ts
