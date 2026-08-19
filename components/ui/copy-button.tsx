"use client";

import { useEffect, useRef, useState } from "react";

import { Button, IconButton, type ButtonSize, type ButtonVariant } from "./button";

/**
 * A copy button.
 *
 * Confirms both by swapping the icon for a tick and through an `aria-live`
 * region — a screen-reader user cannot see the icon change. Falls back to
 * `document.execCommand` in non-HTTPS contexts, because this app usually runs
 * internally over http://.
 */
export function CopyButton({
  value,
  label = "Copy",
  copiedLabel = "Copied",
  iconOnly = false,
  variant = "ghost",
  size = "sm",
}: {
  value: string;
  label?: string;
  copiedLabel?: string;
  iconOnly?: boolean;
  variant?: ButtonVariant;
  size?: ButtonSize;
}) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timer.current) {
        clearTimeout(timer.current);
      }
    },
    [],
  );

  async function copy() {
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(value);
      } else {
        const area = document.createElement("textarea");
        area.value = value;
        area.setAttribute("readonly", "");
        area.style.position = "fixed";
        area.style.opacity = "0";
        document.body.appendChild(area);
        area.select();
        document.execCommand("copy");
        document.body.removeChild(area);
      }

      setCopied(true);
      if (timer.current) {
        clearTimeout(timer.current);
      }
      timer.current = setTimeout(() => setCopied(false), 1600);
    } catch {
      setCopied(false);
    }
  }

  return (
    <>
      {iconOnly ? (
        <IconButton
          label={copied ? copiedLabel : label}
          icon={copied ? "check" : "copy"}
          variant={variant}
          size={size}
          onClick={() => void copy()}
        />
      ) : (
        <Button
          variant={variant}
          size={size}
          icon={copied ? "check" : "copy"}
          onClick={() => void copy()}
        >
          {copied ? copiedLabel : label}
        </Button>
      )}
      <span aria-live="polite" className="sr-only">
        {copied ? `${copiedLabel}: ${value}` : ""}
      </span>
    </>
  );
}
