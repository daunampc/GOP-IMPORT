import { readFileSync } from "node:fs";

import puppeteer from "puppeteer";

/**
 * The page origin has to be EXACTLY the app's BETTER_AUTH_URL, or better-auth
 * rejects the sign-in as a cross-origin request and every capture silently
 * becomes the sign-in screen. Inside the container `localhost` is the container
 * itself, so Chrome is told to resolve `localhost` to the host gateway instead.
 */
const GATEWAY = readFileSync("/etc/hosts", "utf8")
  .split("\n")
  .find((line) => line.includes("host.docker.internal"))
  .trim()
  .split(/\s+/)[0];

const BASE = "http://localhost:3100";
const OUT = "/out";
const EMAIL = process.env.EMAIL;
const PASSWORD = process.env.PASSWORD;

const SCREENS = [
  { name: "dashboard", path: "/" },
  { name: "import", path: "/import" },
  { name: "remove", path: "/remove" },
  { name: "activity", path: "/process" },
  { name: "sites", path: "/stores" },
  { name: "settings", path: "/settings" },
];

const browser = await puppeteer.launch({
  headless: "new",
  args: [
    "--no-sandbox",
    "--disable-dev-shm-usage",
    `--host-resolver-rules=MAP localhost ${GATEWAY}`,
  ],
});

const page = await browser.newPage();
await page.setViewport({ width: 1440, height: 1500, deviceScaleFactor: 1 });

// Sign in once; the session cookie carries through every capture.
await page.goto(`${BASE}/sign-in`, { waitUntil: "networkidle2" });
await page.type('input[type="email"]', EMAIL);
await page.type('input[type="password"]', PASSWORD);
await Promise.all([
  page.waitForNavigation({ waitUntil: "networkidle2" }).catch(() => {}),
  page.click('button[type="submit"]'),
]);
await new Promise((r) => setTimeout(r, 2500));

if (page.url().includes("/sign-in")) {
  throw new Error(`still on the sign-in screen after signing in: ${page.url()}`);
}

// Find a finished run and a site to capture the detail screens.
const detail = await page.evaluate(async () => {
  const jobs = await (await fetch("/api/jobs")).json();
  const stores = await (await fetch("/api/stores")).json();
  const list = jobs.history ?? [];
  return {
    // An import run, not a purge — the detail screen has more to show.
    jobId:
      (list.find((j) => j.status === "completed" && j.kind === "import") ??
        list.find((j) => j.status === "completed"))?.id ?? null,
    storeId: stores.stores?.[0]?.id ?? null,
  };
});

const screens = [...SCREENS];
if (detail.jobId) screens.splice(4, 0, { name: "run-detail", path: `/process/${detail.jobId}` });
if (detail.storeId) screens.splice(6, 0, { name: "site-detail", path: `/stores/${detail.storeId}` });

for (const theme of ["light", "dark"]) {
  // Both routes at once: localStorage is what the app reads, and the media
  // feature is the CSS fallback.
  await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: theme }]);
  await page.evaluateOnNewDocument(
    (t) => localStorage.setItem("tsd-theme", t),
    theme,
  );

  for (const screen of screens) {
    await page.goto(`${BASE}${screen.path}`, { waitUntil: "networkidle2" });
    await new Promise((r) => setTimeout(r, 1800));
    await page.screenshot({ path: `${OUT}/${screen.name}-${theme}.png` });
    console.log(`${screen.name}-${theme}.png`);
  }

  // The command palette, over the dashboard.
  await page.goto(`${BASE}/`, { waitUntil: "networkidle2" });
  await new Promise((r) => setTimeout(r, 1200));
  await page.keyboard.down("Control");
  await page.keyboard.press("KeyK");
  await page.keyboard.up("Control");
  await new Promise((r) => setTimeout(r, 900));
  await page.screenshot({ path: `${OUT}/command-palette-${theme}.png` });
  console.log(`command-palette-${theme}.png`);
}

await browser.close();
