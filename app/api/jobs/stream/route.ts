import { jobsSnapshot } from "@/lib/jobs";
import { apiRequireView } from "@/lib/view";

/**
 * Server-Sent Events for the status bar and the activity screen.
 *
 * State is read once a second, so every open tab sees one truth, and reopening
 * the page after closing it picks up the current progress exactly.
 *
 * Each packet is a union tagged with `ok`. Sending a bare `{ error }` down the
 * same stream as a snapshot, and casting it to a snapshot on the client, is how
 * one dropped tick used to blank the activity screen with
 * `undefined.length`.
 */

export type StreamMessage =
  | { ok: true; snapshot: Awaited<ReturnType<typeof jobsSnapshot>> }
  | { ok: false; error: string };

const TICK_MS = 1000;
/** With nothing to say, a keep-alive every 20 seconds stops proxies cutting the connection. */
const HEARTBEAT_MS = 20_000;

export async function GET(request: Request) {
  const guard = await apiRequireView();
  if (!guard.ok) {
    return guard.response;
  }

  // Captured once, outside the tick: the stream outlives the request, and
  // re-reading the cookie a second later is not something a long-lived
  // connection should be doing.
  const { ownerId } = guard;

  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      let closed = false;
      let lastPayload = "";
      let lastSentAt = 0;

      const send = (message: StreamMessage) => {
        if (closed) {
          return;
        }
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(message)}\n\n`));
        } catch {
          // The client closed between ticks — cleanup happens in `stop()`.
        }
      };

      const tick = async () => {
        if (closed) {
          return;
        }

        try {
          const snapshot = await jobsSnapshot(ownerId);
          // `scheduled` is in the change key too. Without it, rescheduling a run
          // or cancelling one that is waiting for its time would change nothing
          // the stream considers interesting, and the list would sit stale until
          // the next heartbeat.
          const payload =
            JSON.stringify(snapshot.running) +
            JSON.stringify(snapshot.queued) +
            JSON.stringify(snapshot.scheduled);
          const now = Date.now();

          // Only send when something changed. Pushing the whole job list every
          // second even while nothing moves is waste, and makes React re-render
          // continuously for no reason.
          if (payload !== lastPayload || now - lastSentAt > HEARTBEAT_MS) {
            lastPayload = payload;
            lastSentAt = now;
            send({ ok: true, snapshot });
          }
        } catch (error) {
          send({ ok: false, error: error instanceof Error ? error.message : String(error) });
        }
      };

      await tick();
      const interval = setInterval(() => void tick(), TICK_MS);

      // Without clearing the interval when the client closes, every reopened
      // page leaves another loop running forever on the server.
      const stop = () => {
        if (closed) {
          return;
        }
        closed = true;
        clearInterval(interval);
        try {
          controller.close();
        } catch {
          // Already closed.
        }
      };

      request.signal.addEventListener("abort", stop);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      // Disables nginx buffering; without it SSE gets batched and stops being live.
      "X-Accel-Buffering": "no",
    },
  });
}
