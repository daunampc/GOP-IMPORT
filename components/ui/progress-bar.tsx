import { cn } from "./cn";
import type { Tone } from "./badge";

const FILLS: Record<Tone, string> = {
  neutral: "bg-ink-subtle",
  accent: "bg-accent",
  ok: "bg-ok",
  warn: "bg-warn",
  bad: "bg-bad",
  info: "bg-info",
};

/**
 * A progress bar.
 *
 * `indeterminate` is for work that has started before the total is known — it
 * avoids drawing 0%, which looks exactly like "has not started".
 */
export function ProgressBar({
  value,
  max = 100,
  tone = "accent",
  size = "md",
  label,
  indeterminate = false,
  className,
}: {
  value: number;
  max?: number;
  tone?: Tone;
  size?: "sm" | "md" | "lg";
  label?: string;
  indeterminate?: boolean;
  className?: string;
}) {
  const percent = max <= 0 ? 0 : Math.min(100, Math.max(0, (value / max) * 100));
  const heights = { sm: "h-1", md: "h-2", lg: "h-3" } as const;

  return (
    <div
      role="progressbar"
      aria-valuenow={indeterminate ? undefined : Math.round(percent)}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-label={label}
      className={cn(
        "w-full overflow-hidden rounded-full bg-surface-sunken",
        heights[size],
        className,
      )}
    >
      <div
        className={cn(
          "h-full rounded-full transition-[width] duration-slow ease-out-soft",
          FILLS[tone],
          indeterminate && "w-1/3 animate-pulse-soft",
        )}
        style={indeterminate ? undefined : { width: `${percent}%` }}
      />
    </div>
  );
}

/**
 * A stacked bar — succeeded / deduplicated / failed on one rail. The
 * proportion is legible at a glance, rather than three numbers to divide.
 */
export function StackedBar({
  segments,
  total,
  size = "md",
  label,
  className,
}: {
  segments: Array<{ value: number; tone: Tone; label: string }>;
  total: number;
  size?: "sm" | "md" | "lg";
  label?: string;
  className?: string;
}) {
  const heights = { sm: "h-1", md: "h-2", lg: "h-3" } as const;
  const safeTotal = total <= 0 ? 1 : total;

  return (
    <div
      className={cn(
        "flex w-full overflow-hidden rounded-full bg-surface-sunken",
        heights[size],
        className,
      )}
      role="img"
      aria-label={
        label ?? segments.map((segment) => `${segment.label}: ${segment.value}`).join(", ")
      }
    >
      {segments
        .filter((segment) => segment.value > 0)
        .map((segment) => (
          <span
            key={segment.label}
            className={cn("h-full transition-[width] duration-slow ease-out-soft", FILLS[segment.tone])}
            style={{ width: `${(segment.value / safeTotal) * 100}%` }}
          />
        ))}
    </div>
  );
}
