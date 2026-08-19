"use client";

import { useSyncExternalStore } from "react";

import { elapsedBetween, formatDateTime, formatDuration, formatRelative } from "@/lib/format";

/**
 * Anything derived from "now".
 *
 * "3 minutes ago" and "12 seconds elapsed" are computed from `Date.now()`, so
 * the server and the browser always produce different strings — rendered on the
 * server at 20:19:58 and hydrated in the browser at 20:19:59 are two different
 * answers. React treats that as a hydration error (#418) and re-renders from
 * the nearest error boundary.
 *
 * `useSyncExternalStore` with its own `getServerSnapshot` is React's sanctioned
 * way to let the server and the client disagree: the first client render uses
 * the server's value (matching the DOM), then React re-renders with the real
 * one. No flash, no warning.
 */

const noopSubscribe = () => () => {};

export function useHydrated(): boolean {
  return useSyncExternalStore(
    noopSubscribe,
    () => true,
    () => false,
  );
}

/**
 * An absolute timestamp, independent of the time zone.
 *
 * `Intl.DateTimeFormat` uses the time zone of whichever ENVIRONMENT it runs in:
 * the web process in a container is UTC, the reader's browser is local time. The
 * same instant becomes two strings hours apart — also a hydration error, and a
 * far quieter one than "3 minutes ago", because both strings look plausible.
 *
 * The fallback prints the date-and-time part of the ISO string with a UTC
 * suffix, so before JavaScript runs it still states the truth rather than the
 * wrong hour.
 */
function isoFallback(iso: string): string {
  return `${iso.slice(0, 16).replace("T", " ")} UTC`;
}

export function DateTime({
  iso,
  className,
}: {
  iso: string | null | undefined;
  className?: string;
}) {
  const hydrated = useHydrated();

  if (!iso) {
    return <>{formatDateTime(iso)}</>;
  }

  return (
    <time dateTime={iso} className={className}>
      {hydrated ? formatDateTime(iso) : isoFallback(iso)}
    </time>
  );
}

/**
 * "3 minutes ago" in the browser, an absolute stamp before hydration.
 *
 * `title` goes through the same gate: one mismatched attribute is enough for
 * React to call the hydration broken.
 */
export function RelativeTime({ iso }: { iso: string | null | undefined }) {
  const hydrated = useHydrated();

  if (!iso) {
    return <>{formatRelative(iso)}</>;
  }

  return (
    <time dateTime={iso} title={hydrated ? formatDateTime(iso) : isoFallback(iso)}>
      {hydrated ? formatRelative(iso) : isoFallback(iso)}
    </time>
  );
}

/**
 * Elapsed time.
 *
 * A finished run has a `to` and therefore a fixed answer — rendered directly on
 * both sides. A running one ends at "now", so it is computed in the browser
 * only.
 */
export function ElapsedTime({
  from,
  to,
  fallback = "—",
}: {
  from: string | null;
  to: string | null;
  fallback?: string;
}) {
  const hydrated = useHydrated();

  if (from === null) {
    return <>{fallback}</>;
  }

  if (to === null && !hydrated) {
    return <>{fallback}</>;
  }

  return <>{formatDuration(elapsedBetween(from, to))}</>;
}
