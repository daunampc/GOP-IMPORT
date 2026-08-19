import type { ReactNode } from "react";

import { cn } from "./cn";
import { Icon, type IconName } from "./icon";
import type { Tone } from "./badge";

const VALUE_TONES: Record<Tone, string> = {
  neutral: "text-ink",
  accent: "text-accent-fg",
  ok: "text-ok-fg",
  warn: "text-warn-fg",
  bad: "text-bad-fg",
  info: "text-info-fg",
};

/**
 * A prominent number tile.
 *
 * The figure uses `tabular-nums` so tiles in a row line up — a number that
 * changes every second with variable-width digits makes the whole row shiver.
 */
export function Stat({
  label,
  value,
  unit,
  hint,
  icon,
  tone = "neutral",
  trailing,
  className,
}: {
  label: string;
  value: ReactNode;
  unit?: string;
  hint?: ReactNode;
  icon?: IconName;
  tone?: Tone;
  /** Room for a sparkline or a small progress bar. */
  trailing?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex min-w-0 flex-col gap-1 rounded-lg border border-line bg-surface p-4",
        className,
      )}
    >
      <div className="flex items-center gap-1.5 text-xs font-medium text-ink-subtle">
        {icon ? <Icon name={icon} className="size-3.5 shrink-0" /> : null}
        <span className="truncate">{label}</span>
      </div>

      <div className="flex items-baseline gap-1.5">
        <span className={cn("tnum text-2xl leading-none font-semibold", VALUE_TONES[tone])}>
          {value}
        </span>
        {unit ? <span className="text-xs text-ink-subtle">{unit}</span> : null}
      </div>

      {hint ? <div className="truncate text-xs text-ink-subtle">{hint}</div> : null}
      {trailing ? <div className="pt-1">{trailing}</div> : null}
    </div>
  );
}
