# Screenshots

Captured with headless Chrome at 1440×1500 against a REAL stack — MySQL 8, the
actual PHP plugin, Redis, Postgres, the worker, and a production `next start`.
Everything in these images is data the plugin genuinely returned; none of it is
mocked for the picture.

The theme is forced down both routes at once: `localStorage` (what the app
reads) and `prefers-color-scheme` (the CSS fallback).

| Screen | Light | Dark |
|---|---|---|
| Dashboard | `dashboard-light.png` | `dashboard-dark.png` |
| Import — source file step | `import-light.png` | `import-dark.png` |
| Remove — selection and preview | `remove-light.png` | `remove-dark.png` |
| Activity — list | `activity-light.png` | `activity-dark.png` |
| Activity — one run in detail | `run-detail-light.png` | `run-detail-dark.png` |
| Sites — list | `sites-light.png` | `sites-dark.png` |
| Sites — one site in detail | `site-detail-light.png` | `site-detail-dark.png` |
| Settings | `settings-light.png` | `settings-dark.png` |
| Command palette (Ctrl/⌘+K) | `command-palette-light.png` | `command-palette-dark.png` |

## Reading these images

**They stop at the bottom of the viewport, not the bottom of the page.** The
layout is a viewport-tall shell: only the content area scrolls while the sidebar
and both bars stay put. A "full page" capture therefore cannot be any longer —
that is the layout working, not a cropped screenshot.

## Recapturing them

The capture script signs in, walks every screen in both themes, and writes the
files. One detail matters enough to write down: Chrome has to see the app at the
**exact origin** in `BETTER_AUTH_URL`, or better-auth rejects the sign-in as
cross-origin and every image quietly becomes the sign-in screen. From inside a
container that means mapping `localhost` to the host gateway:

```bash
docker run --rm --add-host=host.docker.internal:host-gateway \
  -v "$PWD/shots.mjs":/home/pptruser/shots.mjs -v "$PWD/out":/out \
  -e EMAIL=... -e PASSWORD=... \
  --entrypoint sh ghcr.io/puppeteer/puppeteer:latest \
  -c 'cd /home/pptruser && node shots.mjs'
```

with Chrome launched as:

```js
args: ["--no-sandbox", `--host-resolver-rules=MAP localhost ${GATEWAY}`]
```

The script asserts it is no longer on `/sign-in` before capturing anything —
without that check a failed sign-in produces eighteen identical images and
nothing says so.
