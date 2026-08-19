import { getJobLogs, type JobLogLine } from "@/lib/job-log";
import { getJobState, isTerminal } from "@/lib/jobs";
import { apiRequireOwned } from "@/lib/ownership";
import { LOG_CHANNEL, createConnection } from "@/lib/redis";

/**
 * One run's log, live.
 *
 * The realtime path, and it works the same way Stop does — for the same reason:
 *
 *  1. the worker writes the line to Postgres, which is the record;
 *  2. the worker publishes the run id on a Redis channel, which is only a knock on
 *     the door and carries no content;
 *  3. this stream hears the knock, reads Postgres from its cursor, and sends
 *     whatever is new.
 *
 * Publishing the LINES through Redis instead would be simpler and worse: a dropped
 * message would be a log line gone for ever with nothing to notice it. As a knock,
 * a dropped message costs a second or two — the cursor has not moved, and the
 * fallback tick picks it up. Losing speed rather than data.
 *
 * The fallback tick is also what makes this work with no Redis at all: slower, but
 * never silent.
 */

export type LogStreamMessage =
  | { ok: true; lines: JobLogLine[]; cursor: number; done: boolean }
  | { ok: false; error: string };

/**
 * How often to read even with no knock.
 *
 * Two seconds rather than the one second the snapshot stream uses: this is a
 * secondary panel, the knock covers the responsive case, and a run with several
 * lanes writing lines does not need two independent readers racing.
 */
const FALLBACK_MS = 2000;
/** Quiet keep-alive, so a proxy does not cut an idle stream. */
const HEARTBEAT_MS = 20_000;

export async function GET(request: Request, context: RouteContext<"/api/jobs/[id]/logs/stream">) {
  const { id } = await context.params;

  const guard = await apiRequireOwned("job", id);
  if (!guard.ok) {
    return guard.response;
  }

  const url = new URL(request.url);
  const startAfter = Number.parseInt(url.searchParams.get("after") ?? "0", 10);

  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      let closed = false;
      let cursor = Number.isFinite(startAfter) && startAfter > 0 ? startAfter : 0;
      let lastSentAt = Date.now();
      let reading = false;

      const send = (message: LogStreamMessage) => {
        if (closed) {
          return;
        }
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(message)}\n\n`));
          lastSentAt = Date.now();
        } catch {
          // Client went away between reads; cleanup happens in `stop()`.
        }
      };

      /**
       * Read whatever is past the cursor and send it.
       *
       * Guarded by `reading` because a knock and the fallback tick can land
       * together: two concurrent reads at the same cursor would send the same lines
       * twice, and the panel would show every line doubled.
       */
      const drain = async () => {
        if (closed || reading) {
          return;
        }
        reading = true;

        try {
          const lines = await getJobLogs(id, { after: cursor, limit: 500 });

          if (lines.length > 0) {
            cursor = lines[lines.length - 1].id;
          }

          /*
           * `done` is what lets the browser stop listening.
           *
           * Read AFTER the lines, not before: a run that finishes between the two
           * would otherwise be reported done while its last lines were still
           * unsent, and the panel would miss the summary.
           */
          const state = await getJobState(id);
          const done = state === null || isTerminal(state.status);

          if (lines.length > 0 || done || Date.now() - lastSentAt > HEARTBEAT_MS) {
            send({ ok: true, lines, cursor, done });
          }

          if (done) {
            stop();
          }
        } catch (error) {
          send({ ok: false, error: error instanceof Error ? error.message : String(error) });
        } finally {
          reading = false;
        }
      };

      /*
       * A subscriber connection of its own: a Redis client in subscriber mode cannot
       * run ordinary commands, so it cannot be the shared one.
       */
      const subscriber = createConnection();

      subscriber.on("message", (_channel, jobId) => {
        if (jobId === id) {
          void drain();
        }
      });

      void subscriber.subscribe(LOG_CHANNEL).catch(() => {
        // No Redis: the fallback tick below still delivers every line, just later.
      });

      await drain();
      const interval = setInterval(() => void drain(), FALLBACK_MS);

      function stop() {
        if (closed) {
          return;
        }
        closed = true;
        clearInterval(interval);
        // Without this, every reopened detail page leaves a subscriber connection
        // behind and the server slowly runs out of them.
        void subscriber.quit().catch(() => undefined);
        try {
          controller.close();
        } catch {
          // Already closed.
        }
      }

      request.signal.addEventListener("abort", stop);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      // Nginx buffers event streams by default, which turns realtime into
      // "everything at once when the run ends".
      "X-Accel-Buffering": "no",
    },
  });
}
