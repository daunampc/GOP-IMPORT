/*
 * Do NOT import "server-only" here — this module is in the worker's import
 * graph, and `server-only` throws outside a React Server Component.
 */

import Redis from "ioredis";

/**
 * Redis now does exactly two jobs: it backs the BullMQ queue, and it carries the
 * Stop broadcast.
 *
 * Everything durable moved to Postgres. That is the point: flushing Redis used
 * to destroy every store, every run and all history, and now it costs a queue
 * position.
 *
 * THE CANCEL FLAG USED TO LIVE HERE, and the comment in its place argued that a
 * database round trip per batch would be "pure waste". That was wrong twice
 * over. It was wrong on cost — a batch is up to 50 products over HTTP measured
 * in seconds, against one indexed primary-key lookup on an already-open
 * connection. And it was wrong on correctness: holding one fact in two stores
 * with different lifetimes produced two live bugs. `finishJob()` deleted the flag
 * at the exact moment a cancelled run finished, so a BullMQ redelivery
 * afterwards found nothing and re-ran the whole payload; and a cancel that raced
 * a finishing run left a flag behind for its full 24-hour TTL, ready to cancel
 * an unrelated redelivery of that id for no reason at all.
 *
 * The cancel record is now `job.cancel_requested_at` in Postgres, which cascades
 * with the run and cannot outlive it. See `db/schema.ts`.
 *
 * What is left here is a BROADCAST, not a fact: Stop has to reach the worker
 * PROCESS to abort a request already in flight, and no amount of database
 * polling can do that without the polling interval becoming the response time.
 * Losing a published message costs responsiveness, never correctness — the
 * durable record is still in Postgres, and the lane stops at its boundary or its
 * deadline regardless.
 */

const REDIS_URL = process.env.REDIS_URL ?? "redis://127.0.0.1:6379";

declare global {
  var __gopRedis: Redis | undefined;
}

/**
 * `lazyConnect` matters: without it, merely importing this module opens a
 * connection — including inside Next.js's build process, which never touches
 * Redis. The result was build logs full of ECONNREFUSED.
 */
export function createConnection(): Redis {
  const client = new Redis(REDIS_URL, {
    // BullMQ requires null for connections that run blocking commands.
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
    lazyConnect: true,
  });

  client.on("error", (error) => {
    console.error("[redis]", error.message);
  });

  return client;
}

/**
 * Shared connection for ordinary reads and writes.
 *
 * Cached on globalThis in development because Next.js re-evaluates modules on
 * every hot reload, and without it each edit leaks another connection.
 */
export const redis: Redis = globalThis.__gopRedis ?? createConnection();

if (process.env.NODE_ENV !== "production") {
  globalThis.__gopRedis = redis;
}

/**
 * Where a Stop is announced. Prefixed so this Redis can be shared with other
 * services without collisions.
 *
 * ONE channel carrying the run id, rather than a channel per run: a worker
 * subscribes once at startup and never has to subscribe or unsubscribe as runs
 * come and go, and an id for a run this worker is not holding is simply ignored.
 */
export const STOP_CHANNEL = "gop:job:stop";

/**
 * Where a new log line is announced. Carries the run id and nothing else.
 *
 * Same arrangement as STOP_CHANNEL and for the same reason: Postgres holds the
 * lines, this only says "go and look". Publishing the line itself would make a
 * dropped message a line lost silently for ever; as a knock on the door, a dropped
 * message costs a second or two because the reader's cursor is still there and its
 * fallback heartbeat catches up.
 */
export const LOG_CHANNEL = "gop:job:log";

export interface RedisHealth {
  ok: boolean;
  latencyMs: number;
  message: string;
  version: string | null;
  usedMemory: string | null;
}

export async function checkRedis(): Promise<RedisHealth> {
  const startedAt = Date.now();

  try {
    await redis.ping();
    const latencyMs = Date.now() - startedAt;

    let version: string | null = null;
    let usedMemory: string | null = null;

    try {
      version = /redis_version:(\S+)/.exec(await redis.info("server"))?.[1] ?? null;
      usedMemory = /used_memory_human:(\S+)/.exec(await redis.info("memory"))?.[1] ?? null;
    } catch {
      // Some managed Redis instances block INFO. Reachability is still proven.
    }

    return {
      ok: true,
      latencyMs,
      version,
      usedMemory,
      message: `Connected${version ? ` — Redis ${version}` : ""}`,
    };
  } catch (error) {
    return {
      ok: false,
      latencyMs: Date.now() - startedAt,
      version: null,
      usedMemory: null,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}
