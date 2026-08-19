import { cn } from "./cn";
import type { Tone } from "./badge";

/**
 * Two small charts, drawn straight in SVG.
 *
 * No charting library on purpose: the whole application needs exactly two
 * shapes — throughput over time, and products per day. A charting library would
 * outweigh the entire rest of the interface.
 *
 * Both are `role="img"` with an `aria-label` describing the trend, and both
 * always sit beside the number itself — the drawing is never the only place the
 * information exists.
 */

const STROKES: Record<Tone, string> = {
  neutral: "stroke-ink-subtle",
  accent: "stroke-accent",
  ok: "stroke-ok",
  warn: "stroke-warn",
  bad: "stroke-bad",
  info: "stroke-info",
};

const FILLS: Record<Tone, string> = {
  neutral: "fill-ink-subtle",
  accent: "fill-accent",
  ok: "fill-ok",
  warn: "fill-warn",
  bad: "fill-bad",
  info: "fill-info",
};

export function Sparkline({
  values,
  tone = "accent",
  label,
  height = 36,
  className,
}: {
  values: ReadonlyArray<number>;
  tone?: Tone;
  label: string;
  height?: number;
  className?: string;
}) {
  if (values.length < 2) {
    return (
      <div
        className={cn("flex items-center text-2xs text-ink-subtle", className)}
        style={{ height }}
      >
        Not enough data yet
      </div>
    );
  }

  const width = 100;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;

  const points = values.map((value, index) => {
    const x = (index / (values.length - 1)) * width;
    // SVG's y axis points down; flip it so larger values sit higher.
    const y = 100 - ((value - min) / span) * 100;
    return `${x.toFixed(2)},${y.toFixed(2)}`;
  });

  return (
    <svg
      viewBox={`0 0 ${width} 100`}
      preserveAspectRatio="none"
      role="img"
      aria-label={label}
      style={{ height }}
      className={cn("w-full", className)}
    >
      <polyline
        points={`0,100 ${points.join(" ")} ${width},100`}
        className={cn(FILLS[tone], "opacity-10")}
        stroke="none"
      />
      <polyline
        points={points.join(" ")}
        fill="none"
        vectorEffect="non-scaling-stroke"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
        className={STROKES[tone]}
      />
    </svg>
  );
}

export interface BarDatum {
  label: string;
  value: number;
  /** A differently-shaded portion inside the bar, e.g. failed rows. */
  secondary?: number;
}

export function BarChart({
  data,
  tone = "accent",
  secondaryTone = "bad",
  height = 120,
  valueSuffix = "",
  className,
}: {
  data: ReadonlyArray<BarDatum>;
  tone?: Tone;
  secondaryTone?: Tone;
  height?: number;
  valueSuffix?: string;
  className?: string;
}) {
  const max = Math.max(1, ...data.map((entry) => entry.value));

  const BAR_FILLS: Record<Tone, string> = {
    neutral: "bg-ink-subtle",
    accent: "bg-accent",
    ok: "bg-ok",
    warn: "bg-warn",
    bad: "bg-bad",
    info: "bg-info",
  };

  return (
    <div
      role="img"
      aria-label={data
        .map((entry) => `${entry.label}: ${entry.value}${valueSuffix}`)
        .join("; ")}
      // `items-stretch`, NOT `items-end`: each column has to fill the chart's
      // height, because the bar inside it is sized as a PERCENTAGE of its
      // parent. With `items-end` the column shrinks to its label, that
      // percentage resolves against zero, and every bar renders 0px tall — a
      // chart that silently draws nothing at all.
      className={cn("flex items-stretch gap-1.5", className)}
      style={{ height }}
    >
      {data.map((entry) => {
        const total = (entry.value / max) * 100;
        const bad = entry.secondary ? (entry.secondary / max) * 100 : 0;

        return (
          <div key={entry.label} className="flex min-w-0 flex-1 flex-col items-center gap-1">
            <div className="flex w-full flex-1 flex-col justify-end">
              <div
                className="flex w-full flex-col justify-end overflow-hidden rounded-t-sm bg-surface-sunken"
                style={{ height: `${Math.max(total, 2)}%` }}
                title={`${entry.label}: ${entry.value}${valueSuffix}`}
              >
                <div className={cn("w-full flex-1", BAR_FILLS[tone])} />
                {bad > 0 ? (
                  <div
                    className={cn("w-full shrink-0", BAR_FILLS[secondaryTone])}
                    style={{ height: `${(bad / Math.max(total, 1)) * 100}%` }}
                  />
                ) : null}
              </div>
            </div>
            <span className="w-full truncate text-center text-2xs text-ink-subtle">
              {entry.label}
            </span>
          </div>
        );
      })}
    </div>
  );
}
