"use client";

import { useEffect } from "react";

import { ButtonLink, ErrorState } from "@/components/ui";

/**
 * The application-wide error boundary.
 *
 * The most common cause by far is a database or Redis that cannot be reached —
 * every page reads state from them. So the hint leads straight to Settings,
 * where the health checks live, rather than only saying "something went
 * wrong".
 */
export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[app]", error);
  }, [error]);

  const looksLikeRedis = /redis|econnrefused|etimedout|enotfound/i.test(error.message);

  return (
    <ErrorState
      title="This page could not load"
      message={error.message || "Unknown error."}
      detail={error.digest ? `digest: ${error.digest}\n\n${error.stack ?? ""}` : error.stack}
      hint={
        looksLikeRedis ? (
          <>
            That message looks like Redis being unreachable. The run queue lives there, so
            losing it stops new runs from starting. Check{" "}
            <code className="font-mono">REDIS_URL</code> and whether the Redis process is still
            running.
          </>
        ) : (
          "Try reloading. If it persists, the web process log has the detail."
        )
      }
      onRetry={reset}
      extra={
        <ButtonLink href="/settings" variant="secondary" size="sm" icon="settings">
          Open Settings to check Redis
        </ButtonLink>
      }
    />
  );
}
