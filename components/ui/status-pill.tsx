import { cn } from "./cn";
import { Icon, type IconName } from "./icon";
import type { Tone } from "./badge";

/**
 * A status indicator.
 *
 * Three overlapping signals — icon shape, text and colour — so someone who
 * cannot separate the colours still reads the status. A colour-changing dot
 * alone makes colour the ONLY signal, which is a WCAG 1.4.1 failure.
 */

const ICONS: Record<Tone, IconName> = {
  neutral: "clock",
  accent: "zap",
  ok: "check-circle",
  warn: "alert-triangle",
  bad: "alert-circle",
  info: "info",
};

const COLORS: Record<Tone, string> = {
  neutral: "text-ink-muted",
  accent: "text-accent-fg",
  ok: "text-ok-fg",
  warn: "text-warn-fg",
  bad: "text-bad-fg",
  info: "text-info-fg",
};

const DOTS: Record<Tone, string> = {
  neutral: "bg-ink-subtle",
  accent: "bg-accent",
  ok: "bg-ok",
  warn: "bg-warn",
  bad: "bg-bad",
  info: "bg-info",
};

export function StatusPill({
  tone,
  label,
  icon,
  pulse = false,
  compact = false,
  className,
}: {
  tone: Tone;
  label: string;
  icon?: IconName;
  /** Turn on for in-flight states — the dot pulses gently. */
  pulse?: boolean;
  /** Show only the dot and icon; the text becomes a screen-reader label. */
  compact?: boolean;
  className?: string;
}) {
  return (
    <span
      className={cn("inline-flex items-center gap-1.5 text-xs font-medium", COLORS[tone], className)}
    >
      <span className="relative grid size-4 shrink-0 place-items-center">
        <span
          aria-hidden
          className={cn(
            "size-2 rounded-full",
            DOTS[tone],
            pulse && "animate-pulse-soft",
          )}
        />
      </span>
      <Icon name={icon ?? ICONS[tone]} className="size-3.5 shrink-0" />
      <span className={compact ? "sr-only" : "truncate"}>{label}</span>
    </span>
  );
}
