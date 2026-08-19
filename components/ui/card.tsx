import type { ReactNode } from "react";

import { cn } from "./cn";

/**
 * A content box with no fixed header. Lighter than `Panel` — for summary
 * cards, stat tiles and grid cells.
 */
export function Card({
  tone = "default",
  interactive = false,
  className,
  children,
}: {
  tone?: "default" | "raised" | "sunken" | "accent";
  interactive?: boolean;
  className?: string;
  children: ReactNode;
}) {
  const TONES = {
    default: "border-line bg-surface",
    raised: "border-line bg-surface-raised shadow-sm",
    sunken: "border-line bg-surface-sunken",
    accent: "border-accent-border bg-accent-soft",
  } as const;

  return (
    <div
      className={cn(
        "min-w-0 rounded-lg border",
        TONES[tone],
        interactive &&
          "transition-colors duration-fast hover:border-field-line hover:bg-surface-raised",
        className,
      )}
    >
      {children}
    </div>
  );
}

export function CardHeader({
  title,
  description,
  actions,
  className,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-wrap items-start justify-between gap-3 p-4 pb-0", className)}>
      <div className="min-w-0">
        <h3 className="text-sm font-semibold text-ink">{title}</h3>
        {description ? (
          <p className="mt-0.5 text-xs text-ink-subtle">{description}</p>
        ) : null}
      </div>
      {actions ? <div className="flex shrink-0 flex-wrap gap-2">{actions}</div> : null}
    </div>
  );
}

export function CardBody({
  className,
  children,
}: {
  className?: string;
  children: ReactNode;
}) {
  return <div className={cn("p-4", className)}>{children}</div>;
}

export function CardFooter({
  className,
  children,
}: {
  className?: string;
  children: ReactNode;
}) {
  return (
    <div
      className={cn(
        "flex flex-wrap items-center gap-2 border-t border-line px-4 py-3",
        className,
      )}
    >
      {children}
    </div>
  );
}
