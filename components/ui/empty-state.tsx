import type { ReactNode } from "react";

import { cn } from "./cn";
import { Icon, type IconName } from "./icon";

/**
 * The empty state.
 *
 * `action` is required: an empty screen that does not name the next step leaves
 * the reader stranded. "Nothing here yet" is an unfinished sentence.
 */
export function EmptyState({
  icon = "layers",
  title,
  description,
  action,
  secondary,
  className,
}: {
  icon?: IconName;
  title: string;
  description?: ReactNode;
  action: ReactNode;
  secondary?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center gap-3 px-6 py-12 text-center",
        className,
      )}
    >
      <span className="grid size-12 place-items-center rounded-full bg-surface-sunken text-ink-subtle">
        <Icon name={icon} className="size-5" />
      </span>
      <div className="max-w-md space-y-1">
        <p className="text-sm font-semibold text-ink">{title}</p>
        {description ? <p className="text-xs text-ink-muted">{description}</p> : null}
      </div>
      <div className="flex flex-wrap items-center justify-center gap-2 pt-1">
        {action}
        {secondary}
      </div>
    </div>
  );
}
