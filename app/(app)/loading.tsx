import { Skeleton, SkeletonCards, SkeletonTable } from "@/components/ui";

/**
 * The application-wide loading skeleton.
 *
 * Used by every segment that does not declare its own `loading.tsx`. Shaped
 * deliberately like the screens themselves — a row of stat tiles, then a table
 * — so the layout does not jump when the real content lands.
 */
export default function Loading() {
  return (
    <div className="space-y-5" role="status" aria-label="Loading the page">
      <SkeletonCards count={4} />

      <div className="space-y-3 rounded-lg border border-line bg-surface p-4">
        <Skeleton className="h-4 w-48" rounded="sm" />
        <SkeletonTable rows={6} columns={5} />
      </div>

      <span className="sr-only">Loading, please wait.</span>
    </div>
  );
}
