import { cn } from "./cn";

/**
 * A pulsing grey block standing in for content that has not arrived.
 *
 * Used instead of the word "Loading…": the skeleton's shape says in advance
 * whether a table, a card or a paragraph is coming, so the eye does not have to
 * re-parse the layout twice.
 */
export function Skeleton({
  className,
  rounded = "md",
}: {
  className?: string;
  rounded?: "xs" | "sm" | "md" | "lg" | "full";
}) {
  const radii = {
    xs: "rounded-xs",
    sm: "rounded-sm",
    md: "rounded-md",
    lg: "rounded-lg",
    full: "rounded-full",
  } as const;

  return (
    <span
      aria-hidden
      className={cn("skeleton-sweep block", radii[rounded], className)}
    />
  );
}

/** A table skeleton — used by the `loading.tsx` of screens built around tables. */
export function SkeletonTable({
  rows = 6,
  columns = 5,
  className,
}: {
  rows?: number;
  columns?: number;
  className?: string;
}) {
  return (
    <div className={cn("space-y-2", className)} role="status" aria-label="Loading">
      <div className="flex gap-3 border-b border-line pb-2">
        {Array.from({ length: columns }, (_value, index) => (
          <Skeleton key={index} className="h-3 flex-1" rounded="sm" />
        ))}
      </div>
      {Array.from({ length: rows }, (_value, row) => (
        <div key={row} className="flex gap-3 py-1.5">
          {Array.from({ length: columns }, (_column, index) => (
            <Skeleton
              key={index}
              className={cn("h-4 flex-1", index === 0 && "flex-[2]")}
              rounded="sm"
            />
          ))}
        </div>
      ))}
    </div>
  );
}

/** A card-grid skeleton. */
export function SkeletonCards({
  count = 4,
  className,
}: {
  count?: number;
  className?: string;
}) {
  return (
    <div
      role="status"
      aria-label="Loading"
      className={cn("grid gap-4 sm:grid-cols-2 xl:grid-cols-4", className)}
    >
      {Array.from({ length: count }, (_value, index) => (
        <div key={index} className="space-y-3 rounded-lg border border-line bg-surface p-4">
          <Skeleton className="h-3 w-24" rounded="sm" />
          <Skeleton className="h-7 w-16" rounded="sm" />
          <Skeleton className="h-2 w-full" rounded="full" />
        </div>
      ))}
    </div>
  );
}
