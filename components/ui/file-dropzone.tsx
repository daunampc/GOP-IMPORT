"use client";

import { useId, useRef, useState } from "react";

import { cn } from "./cn";
import { Icon } from "./icon";
import { IconButton } from "./button";

/**
 * A file drop zone.
 *
 * Underneath is a real `<input type="file">`, only visually hidden — NOT
 * `display:none`, which would remove it from the tab order entirely. That way
 * drag-and-drop and keyboard selection share one control.
 */
export function FileDropzone({
  file,
  onFile,
  accept = ".csv,text/csv",
  hint = "Drop a file here, or click to choose one",
  disabled = false,
  className,
}: {
  file: File | null;
  onFile: (file: File | null) => void;
  accept?: string;
  hint?: string;
  disabled?: boolean;
  className?: string;
}) {
  const id = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);

  function take(list: FileList | null) {
    const next = list?.[0] ?? null;
    onFile(next);
  }

  if (file) {
    return (
      <div
        className={cn(
          "flex items-center gap-3 rounded-md border border-line bg-surface-sunken px-3 py-2.5",
          className,
        )}
      >
        <span className="grid size-9 shrink-0 place-items-center rounded-md bg-accent-soft text-accent-fg">
          <Icon name="file" className="size-4.5" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium text-ink">{file.name}</span>
          <span className="tnum block text-xs text-ink-subtle">{formatBytes(file.size)}</span>
        </span>
        <IconButton
          label="Clear the chosen file"
          icon="x"
          size="sm"
          disabled={disabled}
          onClick={() => {
            if (inputRef.current) {
              inputRef.current.value = "";
            }
            onFile(null);
          }}
        />
        <input
          ref={inputRef}
          id={id}
          type="file"
          accept={accept}
          disabled={disabled}
          onChange={(event) => take(event.target.files)}
          className="sr-only"
        />
      </div>
    );
  }

  return (
    <label
      htmlFor={id}
      onDragOver={(event) => {
        event.preventDefault();
        if (!disabled) {
          setOver(true);
        }
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(event) => {
        event.preventDefault();
        setOver(false);
        if (!disabled) {
          take(event.dataTransfer.files);
        }
      }}
      className={cn(
        "flex flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed px-6 py-8 text-center transition-colors duration-fast",
        disabled
          ? "cursor-not-allowed border-line bg-surface-sunken"
          : "cursor-pointer border-field-line hover:border-accent hover:bg-accent-soft",
        over && "border-accent bg-accent-soft",
        className,
      )}
    >
      <span
        className={cn(
          "grid size-11 place-items-center rounded-full transition-colors duration-fast",
          over ? "bg-accent text-on-accent" : "bg-surface-sunken text-ink-subtle",
        )}
      >
        <Icon name="upload" className="size-5" />
      </span>
      <span className="text-sm font-medium text-ink">{hint}</span>
      <span className="text-xs text-ink-subtle">Accepts {accept}</span>
      <input
        ref={inputRef}
        id={id}
        type="file"
        accept={accept}
        disabled={disabled}
        onChange={(event) => take(event.target.files)}
        className="sr-only"
      />
    </label>
  );
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
