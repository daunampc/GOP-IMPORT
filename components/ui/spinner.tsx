import { cn } from "./cn";

/** A busy spinner. Carries a label, because the drawing says nothing on its own. */
export function Spinner({
  className,
  label = "Working",
}: {
  className?: string;
  label?: string;
}) {
  return (
    <span role="status" className="inline-flex">
      <svg
        viewBox="0 0 24 24"
        fill="none"
        aria-hidden="true"
        className={cn("size-4 shrink-0 animate-spin-slow", className)}
      >
        <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth={2.5} opacity={0.25} />
        <path
          d="M21 12a9 9 0 0 0-9-9"
          stroke="currentColor"
          strokeWidth={2.5}
          strokeLinecap="round"
        />
      </svg>
      <span className="sr-only">{label}</span>
    </span>
  );
}
