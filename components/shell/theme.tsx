"use client";

import {
  createContext,
  useCallback,
  useContext,
  useLayoutEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";

import { Segmented } from "@/components/ui";

/**
 * Light / dark / follow-the-system theming.
 *
 * The choice lives in `localStorage` and is applied by a script inlined into
 * `<head>` (see `ThemeScript`) — that script runs while the browser is still
 * parsing HTML, which is to say BEFORE the first paint. Waiting for a
 * `useEffect` would give dark-theme users a white flash on every page load.
 *
 * Three states rather than two: "system" is the default, and in that state NO
 * attribute is set on `<html>` at all, leaving CSS `prefers-color-scheme` to
 * decide.
 */

export type ThemeChoice = "light" | "dark" | "system";

export const THEME_STORAGE_KEY = "tsd-theme";

interface ThemeApi {
  choice: ThemeChoice;
  /** The theme actually on screen, with "system" already resolved. */
  resolved: "light" | "dark";
  setChoice: (next: ThemeChoice) => void;
}

const ThemeContext = createContext<ThemeApi | null>(null);

export function useTheme(): ThemeApi {
  const api = useContext(ThemeContext);
  if (api === null) {
    throw new Error("useTheme must be used inside <ThemeProvider>");
  }
  return api;
}

/**
 * Inlined into `<head>`. Kept as a small dependency-free string: this runs
 * before React does.
 */
function apply(choice: ThemeChoice): void {
  const root = document.documentElement;
  if (choice === "system") {
    root.removeAttribute("data-theme");
  } else {
    root.setAttribute("data-theme", choice);
  }
}

/**
 * `prefers-color-scheme` is state owned by a system outside React, so it is
 * read with `useSyncExternalStore` rather than `useState` plus an effect — the
 * latter renders one frame with the wrong value right after mounting.
 */
const SYSTEM_DARK_QUERY = "(prefers-color-scheme: dark)";

function subscribeToSystemTheme(onChange: () => void): () => void {
  const query = window.matchMedia(SYSTEM_DARK_QUERY);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

function getSystemTheme(): boolean {
  return window.matchMedia(SYSTEM_DARK_QUERY).matches;
}

function readStored(): ThemeChoice {
  try {
    const stored = localStorage.getItem(THEME_STORAGE_KEY);
    return stored === "light" || stored === "dark" ? stored : "system";
  } catch {
    return "system";
  }
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  // Lazy initialisation from the same source the <head> script read, so React
  // state and the DOM always agree.
  const [choice, setChoiceState] = useState<ThemeChoice>(() =>
    typeof window === "undefined" ? "system" : readStored(),
  );
  const systemDark = useSyncExternalStore(
    subscribeToSystemTheme,
    getSystemTheme,
    // There is no `matchMedia` on the server; answer "light" and let the <head>
    // script handle what is on screen before the first paint.
    () => false,
  );

  // React Strict Mode in development clears the attribute on <html> when it
  // remounts; set it again here. In production this is a harmless no-op.
  useLayoutEffect(() => {
    apply(readStored());
  }, []);

  const setChoice = useCallback((next: ThemeChoice) => {
    setChoiceState(next);
    apply(next);
    try {
      if (next === "system") {
        localStorage.removeItem(THEME_STORAGE_KEY);
      } else {
        localStorage.setItem(THEME_STORAGE_KEY, next);
      }
    } catch {
      // Private browsing blocks the write — the theme still changes for this session.
    }
  }, []);

  const value = useMemo<ThemeApi>(
    () => ({
      choice,
      resolved: choice === "system" ? (systemDark ? "dark" : "light") : choice,
      setChoice,
    }),
    [choice, systemDark, setChoice],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

/** The light / dark / system trio. */
export function ThemeSwitch({ block = false }: { block?: boolean }) {
  const { choice, setChoice } = useTheme();

  return (
    <Segmented
      label="Light or dark"
      value={choice}
      block={block}
      size="sm"
      onChange={setChoice}
      options={[
        { value: "light", label: "Light", icon: "sun" },
        { value: "dark", label: "Dark", icon: "moon" },
        { value: "system", label: "System", icon: "monitor" },
      ]}
    />
  );
}
