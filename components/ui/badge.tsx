import type { ReactNode } from "react";

import { cn } from "./cn";
import { Icon, type IconName } from "./icon";

export type Tone = "neutral" | "accent" | "ok" | "warn" | "bad" | "info";

const SOFT: Record<Tone, string> = {
  neutral: "border-line bg-surface-sunken text-ink-muted",
  accent: "border-accent-border bg-accent-soft text-accent-fg",
  ok: "border-ok-border bg-ok-soft text-ok-fg",
  warn: "border-warn-border bg-warn-soft text-warn-fg",
  bad: "border-bad-border bg-bad-soft text-bad-fg",
  info: "border-info-border bg-info-soft text-info-fg",
};

const SOLID: Record<Tone, string> = {
  neutral: "border-transparent bg-ink text-ink-inverse",
  accent: "border-transparent bg-accent text-on-accent",
  ok: "border-transparent bg-ok text-on-ok",
  warn: "border-transparent bg-warn text-on-warn",
  bad: "border-transparent bg-bad text-on-bad",
  info: "border-transparent bg-info text-on-info",
};

/** A small label. Always carries text — colour alone never conveys meaning. */
export function Badge({
  tone = "neutral",
  variant = "soft",
  icon,
  className,
  children,
}: {
  tone?: Tone;
  variant?: "soft" | "solid";
  icon?: IconName;
  className?: string;
  children: ReactNode;
}) {
  return (
    <span
      className={cn(
        "inline-flex max-w-full items-center gap-1 rounded-full border px-2 py-0.5 text-2xs font-medium whitespace-nowrap",
        variant === "soft" ? SOFT[tone] : SOLID[tone],
        className,
      )}
    >
      {icon ? <Icon name={icon} className="size-3 shrink-0" /> : null}
      <span className="truncate">{children}</span>
    </span>
  );
}

export { SOFT as BADGE_SOFT_TONES };
