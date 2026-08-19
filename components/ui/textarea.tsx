"use client";

import type { ComponentProps } from "react";

import { cn } from "./cn";
import { CONTROL_BASE, CONTROL_BORDER, CONTROL_INVALID } from "./input";

export function Textarea({
  invalid,
  className,
  rows = 4,
  ...rest
}: { invalid?: boolean } & ComponentProps<"textarea">) {
  return (
    <textarea
      {...rest}
      rows={rows}
      aria-invalid={invalid || undefined}
      className={cn(
        CONTROL_BASE,
        invalid ? CONTROL_INVALID : CONTROL_BORDER,
        "resize-y px-3 py-2 text-sm",
        className,
      )}
    />
  );
}
