import type { ReactNode } from "react";

import { cn } from "./cn";

export interface DescriptionItem {
  term: string;
  value: ReactNode;
  /** Small print under the value — notes, units, where a number came from. */
  hint?: ReactNode;
  /** Lets the value take the whole row (long lists, code). */
  wide?: boolean;
}

/**
 * A term-and-value list. Used for a site's `/health` data, run details and
 * option summaries.
 */
export function DescriptionList({
  items,
  columns = 2,
  className,
}: {
  items: ReadonlyArray<DescriptionItem>;
  columns?: 1 | 2 | 3;
  className?: string;
}) {
  const grids = {
    1: "sm:grid-cols-1",
    2: "sm:grid-cols-2",
    3: "sm:grid-cols-2 lg:grid-cols-3",
  } as const;

  return (
    <dl className={cn("grid grid-cols-1 gap-x-6 gap-y-3", grids[columns], className)}>
      {items.map((item) => (
        <div
          key={item.term}
          className={cn("min-w-0 space-y-0.5", item.wide && "sm:col-span-full")}
        >
          <dt className="text-2xs font-semibold tracking-wide text-ink-subtle uppercase">
            {item.term}
          </dt>
          <dd className="min-w-0 text-sm break-words text-ink">{item.value}</dd>
          {item.hint ? <p className="text-xs text-ink-subtle">{item.hint}</p> : null}
        </div>
      ))}
    </dl>
  );
}
