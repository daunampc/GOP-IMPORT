/**
 * A site whose clock differs from this machine's.
 *
 * Run through tests/clock-skew.sh. Stands up a local server that behaves like plugin
 * 3.10.1's `Auth::verify` — signature first, then freshness against ITS OWN clock,
 * which is set two hours off — and drives the real `GopClient` against it.
 *
 * No Docker and no database: the thing under test is the retry in the client, and the
 * plugin's half is covered by `php tests/run.php` in the plugin repository.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { GopApiError, GopClient, resetClockOffsets } from "../lib/gop-client";

const KEY = "key123";
const SECRET = "a-test-secret";
const SKEW_SECONDS = 2 * 3600;
const MAX_CLOCK_SKEW = 300;

let passed = 0;
let failed = 0;

async function check(name: string, test: () => Promise<void>): Promise<void> {
  try {
    await test();
    passed++;
    console.log(`  ok   ${name}`);
  } catch (error) {
    failed++;
    console.log(`  FAIL ${name}\n       ${error instanceof Error ? error.message : String(error)}`);
  }
}

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

interface Fake {
  server: Server;
  url: string;
  requests: number;
  /** When false, behaves like plugin 3.10.0: stale_request without server_time. */
  tellsTime: boolean;
}

async function start(tellsTime: boolean): Promise<Fake> {
  const fake: Fake = { server: undefined as unknown as Server, url: "", requests: 0, tellsTime };

  fake.server = createServer(async (request: IncomingMessage, response) => {
    fake.requests++;

    const chunks: Buffer[] = [];
    for await (const chunk of request) {
      chunks.push(chunk as Buffer);
    }
    const body = Buffer.concat(chunks);

    const route = new URL(request.url ?? "/", "http://x").searchParams.get("route") ?? "/";
    const timestamp = String(request.headers["x-tsd-timestamp"] ?? "");
    const signature = String(request.headers["x-tsd-signature"] ?? "");

    const expected = createHmac("sha256", SECRET)
      .update(Buffer.from(`${request.method}\n${route}\n${timestamp}\n`, "utf8"))
      .update(body)
      .digest("hex");

    const reply = (status: number, payload: unknown): void => {
      response.writeHead(status, { "Content-Type": "application/json" });
      response.end(JSON.stringify(payload));
    };

    const same =
      signature.length === expected.length &&
      timingSafeEqual(Buffer.from(signature), Buffer.from(expected));

    if (request.headers["x-tsd-key"] !== KEY || !/^\d+$/.test(timestamp) || !same) {
      reply(401, { error: { code: "invalid_credentials", message: "Authentication failed." } });
      return;
    }

    // THIS server's clock, two hours away from the test process's.
    const now = Math.floor(Date.now() / 1000) + SKEW_SECONDS;

    if (Math.abs(now - Number(timestamp)) > MAX_CLOCK_SKEW) {
      reply(401, {
        error: {
          code: "stale_request",
          message: "Authentication failed.",
          ...(fake.tellsTime ? { server_time: now } : {}),
        },
      });
      return;
    }

    reply(200, { status: "ok", version: "3.10.1" });
  });

  await new Promise<void>((resolve) => fake.server.listen(0, "127.0.0.1", resolve));
  fake.url = `http://127.0.0.1:${(fake.server.address() as AddressInfo).port}`;

  return fake;
}

function client(url: string, secret = SECRET): GopClient {
  return new GopClient({ baseUrl: url, apiKey: KEY, apiSecret: secret } as ConstructorParameters<typeof GopClient>[0]);
}

async function main(): Promise<void> {
  console.log("\nClock skew");

  await check("a site two hours ahead is corrected with exactly one retry", async () => {
    resetClockOffsets();
    const fake = await start(true);
    try {
      await client(fake.url).health();
      assert(fake.requests === 2, `expected 2 requests, saw ${fake.requests}`);
    } finally {
      fake.server.close();
    }
  });

  await check("the offset is remembered, so the next request goes straight through", async () => {
    resetClockOffsets();
    const fake = await start(true);
    try {
      await client(fake.url).health();
      fake.requests = 0;
      // A NEW client, as the worker builds one per run.
      await client(fake.url).health();
      assert(fake.requests === 1, `expected 1 request, saw ${fake.requests}`);
    } finally {
      fake.server.close();
    }
  });

  await check("a wrong secret is NOT retried, and says so", async () => {
    resetClockOffsets();
    const fake = await start(true);
    try {
      let thrown: unknown;
      try {
        await client(fake.url, "not-the-secret").health();
      } catch (error) {
        thrown = error;
      }
      assert(thrown instanceof GopApiError && thrown.code === "invalid_credentials", "expected invalid_credentials");
      assert(fake.requests === 1, `expected 1 request, saw ${fake.requests}`);
    } finally {
      fake.server.close();
    }
  });

  await check("a plugin that does not send server_time fails once, without looping", async () => {
    resetClockOffsets();
    const fake = await start(false);
    try {
      let thrown: unknown;
      try {
        await client(fake.url).health();
      } catch (error) {
        thrown = error;
      }
      assert(thrown instanceof GopApiError && thrown.code === "stale_request", "expected stale_request");
      assert(fake.requests === 1, `expected 1 request, saw ${fake.requests}`);
    } finally {
      fake.server.close();
    }
  });

  console.log(`\n${"-".repeat(50)}\nPassed: ${passed}   Failed: ${failed}`);
  process.exit(failed === 0 ? 0 : 1);
}

void main();
