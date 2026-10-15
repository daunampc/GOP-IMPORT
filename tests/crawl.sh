#!/usr/bin/env bash
#
# The crawler's pure parts: money, robots.txt, and the Shopify mapping.
#
#   ./tests/crawl.sh
#
# No Docker, no Postgres, no Redis, no fake host — unlike every other suite here.
# Everything it tests is a function over a saved fixture, so it runs in under a
# second and there is no reason for it ever to be skipped.

set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

cd "$APP_DIR"
exec ./node_modules/.bin/tsx tests/crawl.ts
