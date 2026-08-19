import { cn } from "./cn";
import { CopyButton } from "./copy-button";

/**
 * A block of code or a technical value.
 *
 * Always has a copy button: everything shown here — API keys, plugin paths,
 * shell commands — exists to be pasted somewhere else, and retyping it by hand
 * means typing it wrong.
 */
export function CodeBlock({
  code,
  language,
  copyable = true,
  wrap = false,
  maxHeight = "20rem",
  className,
}: {
  code: string;
  /** A display label only; there is no syntax highlighting. */
  language?: string;
  copyable?: boolean;
  wrap?: boolean;
  maxHeight?: string;
  className?: string;
}) {
  return (
    <div className={cn("overflow-hidden rounded-md border border-line bg-surface-sunken", className)}>
      {language || copyable ? (
        <div className="flex items-center justify-between gap-2 border-b border-line px-3 py-1">
          <span className="font-mono text-2xs tracking-wide text-ink-subtle uppercase">
            {language ?? ""}
          </span>
          {copyable ? <CopyButton value={code} iconOnly /> : null}
        </div>
      ) : null}

      <pre
        style={{ maxHeight }}
        className={cn(
          "overflow-auto px-3 py-2.5 font-mono text-xs leading-relaxed text-ink",
          wrap ? "break-words whitespace-pre-wrap" : "whitespace-pre",
        )}
      >
        {code}
      </pre>
    </div>
  );
}

/** A short technical value sitting inside a line of prose. */
export function Code({ children, className }: { children: string; className?: string }) {
  return (
    <code
      className={cn(
        "rounded-xs border border-line bg-surface-sunken px-1 py-0.5 font-mono text-2xs text-ink",
        className,
      )}
    >
      {children}
    </code>
  );
}
