import type { ReactNode } from "react";

import { cn } from "./cn";
import { Icon, type IconName } from "./icon";
import type { Tone } from "./badge";

const TONES: Record<Tone, { box: string; mark: string; icon: IconName }> = {
  neutral: {
    box: "border-line bg-surface-sunken text-ink",
    mark: "text-ink-muted",
    icon: "info",
  },
  accent: {
    box: "border-accent-border bg-accent-soft text-accent-fg",
    mark: "text-accent-fg",
    icon: "zap",
  },
  ok: { box: "border-ok-border bg-ok-soft text-ok-fg", mark: "text-ok-fg", icon: "check-circle" },
  warn: {
    box: "border-warn-border bg-warn-soft text-warn-fg",
    mark: "text-warn-fg",
    icon: "alert-triangle",
  },
  bad: { box: "border-bad-border bg-bad-soft text-bad-fg", mark: "text-bad-fg", icon: "alert-circle" },
  info: { box: "border-info-border bg-info-soft text-info-fg", mark: "text-info-fg", icon: "info" },
};

/**
 * An in-place notice.
 *
 * `bad` carries `role="alert"` so a screen reader announces it the moment it
 * appears; the other tones do not, because interrupting someone for a note is
 * simply too loud.
 */
export function Alert({
  tone = "info",
  title,
  icon,
  actions,
  className,
  children,
}: {
  tone?: Tone;
  title?: ReactNode;
  icon?: IconName;
  actions?: ReactNode;
  className?: string;
  children?: ReactNode;
}) {
  const style = TONES[tone];

  return (
    <div
      role={tone === "bad" ? "alert" : undefined}
      className={cn("flex gap-3 rounded-md border px-3.5 py-3 text-sm", style.box, className)}
    >
      <Icon name={icon ?? style.icon} className={cn("mt-0.5 size-4.5 shrink-0", style.mark)} />
      <div className="min-w-0 flex-1 space-y-1.5">
        {title ? <p className="font-semibold">{title}</p> : null}
        {children ? <div className="[&_a]:underline">{children}</div> : null}
        {actions ? <div className="flex flex-wrap gap-2 pt-1">{actions}</div> : null}
      </div>
    </div>
  );
}

/** A bulleted list inside an Alert — for several warnings at once. */
export function AlertList({ items }: { items: ReadonlyArray<string> }) {
  return (
    <ul className="list-disc space-y-1 pl-4">
      {items.map((item, index) => (
        <li key={`${index}-${item}`}>{item}</li>
      ))}
    </ul>
  );
}
