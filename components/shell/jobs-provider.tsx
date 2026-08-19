"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import type { JobState, JobsSnapshot } from "@/lib/jobs";

/**
 * One SSE stream for the whole application.
 *
 * The status bar, the command palette, the dashboard and the activity screen
 * all read from here. If each screen opened its own `EventSource`, four
 * connections would poll every second — and worse, four screens could show four
 * different numbers at the same instant.
 *
 * This is what makes a running job visible on EVERY screen, not only
 * `/process`.
 */

export type ConnectionState = "connecting" | "live" | "offline";

interface JobsApi {
  snapshot: JobsSnapshot;
  connection: ConnectionState;
  /** A server-side error sent down the stream, e.g. Redis dropping out. */
  streamError: string | null;
  /** Force an immediate re-read, for right after cancelling or creating a run. */
  refresh: () => Promise<void>;
}

const EMPTY: JobsSnapshot = { running: [], queued: [], scheduled: [], history: [], at: "" };

const JobsContext = createContext<JobsApi | null>(null);

export function useJobs(): JobsApi {
  const api = useContext(JobsContext);
  if (api === null) {
    throw new Error("useJobs must be used inside <JobsProvider>");
  }
  return api;
}

type StreamMessage =
  | { ok: true; snapshot: JobsSnapshot }
  | { ok: false; error: string };

export function JobsProvider({
  initial,
  children,
}: {
  initial?: JobsSnapshot;
  children: ReactNode;
}) {
  const [snapshot, setSnapshot] = useState<JobsSnapshot>(initial ?? EMPTY);
  const [connection, setConnection] = useState<ConnectionState>("connecting");
  const [streamError, setStreamError] = useState<string | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const refresh = useCallback(async () => {
    try {
      const response = await fetch("/api/jobs", { cache: "no-store" });
      if (!response.ok) {
        return;
      }
      const payload = (await response.json()) as JobsSnapshot;
      if (mounted.current) {
        setSnapshot(payload);
      }
    } catch {
      // The stream catches up on its next tick; no need to make noise here.
    }
  }, []);

  useEffect(() => {
    const source = new EventSource("/api/jobs/stream");

    source.onopen = () => setConnection("live");

    source.onmessage = (event) => {
      // The payload is a tagged union. Casting it straight to a snapshot means
      // one dropped tick turns `snapshot.queued` into `undefined` and blanks the
      // whole activity screen.
      let message: StreamMessage;
      try {
        message = JSON.parse(event.data) as StreamMessage;
      } catch {
        return;
      }

      setConnection("live");

      if (message.ok) {
        setStreamError(null);
        setSnapshot(message.snapshot);
      } else {
        setStreamError(message.error);
      }
    };

    // EventSource reconnects on its own; this flag only tells the operator the
    // numbers are frozen, NOT that a run has hung.
    source.onerror = () => setConnection("offline");

    return () => source.close();
  }, []);

  const value = useMemo<JobsApi>(
    () => ({ snapshot, connection, streamError, refresh }),
    [snapshot, connection, streamError, refresh],
  );

  return <JobsContext.Provider value={value}>{children}</JobsContext.Provider>;
}

/** The run worth showing on the status bar: running first, then queued. */
export function primaryJob(snapshot: JobsSnapshot): JobState | null {
  return snapshot.running[0] ?? snapshot.queued[0] ?? null;
}

export function jobPercent(job: JobState): number {
  return job.total === 0 ? 0 : Math.round((job.processed / job.total) * 100);
}
