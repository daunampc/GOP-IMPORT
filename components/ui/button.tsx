"use client";

import Link from "next/link";
import type { ComponentProps, ReactNode } from "react";

import { cn } from "./cn";
import { Icon, type IconName } from "./icon";
import { Spinner } from "./spinner";

/**
 * A button.
 *
 * `loading` keeps the width by overlaying the spinner on the label rather than
 * replacing it — otherwise the whole row of buttons jumps on every press.
 */

export type ButtonVariant =
  | "primary"
  | "secondary"
  | "ghost"
  | "danger"
  | "success"
  | "subtle";

export type ButtonSize = "sm" | "md" | "lg" | "icon";

const VARIANTS: Record<ButtonVariant, string> = {
  primary:
    "bg-accent text-on-accent shadow-xs hover:bg-accent-hover active:bg-accent-active",
  secondary:
    "bg-surface text-ink border border-field-line hover:bg-surface-sunken active:bg-surface-sunken",
  ghost: "bg-transparent text-ink-muted hover:bg-surface-sunken hover:text-ink",
  danger: "bg-bad text-on-bad shadow-xs hover:opacity-90 active:opacity-100",
  success: "bg-ok text-on-ok shadow-xs hover:opacity-90 active:opacity-100",
  subtle:
    "bg-accent-soft text-accent-fg border border-accent-border hover:bg-accent-soft",
};

const SIZES: Record<ButtonSize, string> = {
  sm: "h-8 gap-1.5 rounded-sm px-2.5 text-xs",
  md: "h-9 gap-2 rounded-md px-3.5 text-sm",
  lg: "h-11 gap-2 rounded-md px-5 text-base",
  icon: "size-9 justify-center rounded-md",
};

const BASE =
  "relative inline-flex shrink-0 items-center font-medium transition-colors duration-fast select-none disabled:cursor-not-allowed disabled:opacity-50";

interface CommonProps {
  variant?: ButtonVariant;
  size?: ButtonSize;
  icon?: IconName;
  iconAfter?: IconName;
  loading?: boolean;
  block?: boolean;
  className?: string;
  children?: ReactNode;
}

function Inner({
  icon,
  iconAfter,
  loading,
  children,
}: Pick<CommonProps, "icon" | "iconAfter" | "loading" | "children">) {
  return (
    <>
      <span
        className={cn(
          "inline-flex items-center gap-2",
          loading && "invisible",
        )}
      >
        {icon ? <Icon name={icon} /> : null}
        {children}
        {iconAfter ? <Icon name={iconAfter} /> : null}
      </span>
      {loading ? (
        <span className="absolute inset-0 grid place-items-center">
          <Spinner />
        </span>
      ) : null}
    </>
  );
}

export function Button({
  variant = "secondary",
  size = "md",
  icon,
  iconAfter,
  loading = false,
  block = false,
  className,
  children,
  disabled,
  ...rest
}: CommonProps & Omit<ComponentProps<"button">, "className" | "children">) {
  return (
    <button
      {...rest}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={cn(BASE, VARIANTS[variant], SIZES[size], block && "w-full justify-center", className)}
    >
      <Inner icon={icon} iconAfter={iconAfter} loading={loading}>
        {children}
      </Inner>
    </button>
  );
}

/** Button-shaped but a real link — middle-click and Ctrl+click keep working. */
export function ButtonLink({
  variant = "secondary",
  size = "md",
  icon,
  iconAfter,
  block = false,
  className,
  children,
  ...rest
}: Omit<CommonProps, "loading"> & ComponentProps<typeof Link>) {
  return (
    <Link
      {...rest}
      className={cn(BASE, VARIANTS[variant], SIZES[size], block && "w-full justify-center", className)}
    >
      <Inner icon={icon} iconAfter={iconAfter}>
        {children}
      </Inner>
    </Link>
  );
}

/** An icon-only button. `label` is required — without it the button is mute. */
export function IconButton({
  label,
  icon,
  variant = "ghost",
  size = "icon",
  className,
  loading,
  disabled,
  ...rest
}: {
  label: string;
  icon: IconName;
  variant?: ButtonVariant;
  size?: ButtonSize;
  className?: string;
  loading?: boolean;
} & Omit<ComponentProps<"button">, "className" | "children">) {
  return (
    <button
      {...rest}
      aria-label={label}
      title={label}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={cn(BASE, VARIANTS[variant], SIZES[size], "justify-center", className)}
    >
      {loading ? <Spinner label={label} /> : <Icon name={icon} />}
    </button>
  );
}
