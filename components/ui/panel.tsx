import type { ReactNode } from "react";

import { cn } from "./cn";
import { Icon, type IconName } from "./icon";

/**
 * A titled content block. This is the largest layout unit inside a screen;
 * every screen is built from Panels so the rhythm is the same page to page.
 */
export function Panel({
  title,
  icon,
  description,
  actions,
  footer,
  padded = true,
  className,
  bodyClassName,
  children,
}: {
  title: ReactNode;
  icon?: IconName;
  description?: ReactNode;
  actions?: ReactNode;
  footer?: ReactNode;
  /** Turn off when the contents are an edge-to-edge table. */
  padded?: boolean;
  className?: string;
  bodyClassName?: string;
  children: ReactNode;
}) {
  return (
    <section
      className={cn(
        "min-w-0 overflow-hidden rounded-lg border border-line bg-surface shadow-xs",
        className,
      )}
    >
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-line bg-surface-sunken px-4 py-2.5">
        <div className="flex min-w-0 items-center gap-2">
          {icon ? <Icon name={icon} className="size-4 shrink-0 text-ink-subtle" /> : null}
          <h2 className="truncate text-sm font-semibold text-ink">{title}</h2>
          {description ? (
            <p className="hidden min-w-0 truncate text-xs text-ink-subtle sm:block">
              {description}
            </p>
          ) : null}
        </div>
        {actions ? <div className="flex shrink-0 flex-wrap gap-2">{actions}</div> : null}
      </header>

      <div className={cn(padded && "p-4", bodyClassName)}>{children}</div>

      {footer ? (
        <div className="flex flex-wrap items-center gap-2 border-t border-line bg-surface-sunken px-4 py-2.5">
          {footer}
        </div>
      ) : null}
    </section>
  );
}
