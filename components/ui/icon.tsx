import { cn } from "./cn";

/**
 * A stroked icon set, drawn directly in SVG.
 *
 * No icon library: the whole application needs about forty shapes, while an
 * icon package brings a few hundred kilobytes and a dependency to keep track
 * of.
 *
 * Every icon is `aria-hidden`. The meaning has to live in the text beside it,
 * or in the `aria-label` of the button around it — never in the drawing alone.
 */

const PATHS = {
  dashboard: "M4 4h7v7H4zM13 4h7v4h-7zM13 10h7v10h-7zM4 13h7v7H4z",
  upload: "M12 16V4m0 0L7.5 8.5M12 4l4.5 4.5M4 16v2.5A1.5 1.5 0 0 0 5.5 20h13a1.5 1.5 0 0 0 1.5-1.5V16",
  activity: "M3 12h4l3 8 4-16 3 8h4",
  store: "M4 9.5V19a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1V9.5M3 9.5 5 4h14l2 5.5a3 3 0 0 1-6 0 3 3 0 0 1-6 0 3 3 0 0 1-6 0Z",
  settings:
    "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1.03 1.56V21a2 2 0 1 1-4 0v-.1A1.7 1.7 0 0 0 8.9 19.3a1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.7 1.7 0 0 0 .34-1.87 1.7 1.7 0 0 0-1.56-1.03H3a2 2 0 1 1 0-4h.1A1.7 1.7 0 0 0 4.7 8.9a1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.7 1.7 0 0 0 1.87.34H9.1A1.7 1.7 0 0 0 10.1 3V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1.03 1.56 1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87v.08A1.7 1.7 0 0 0 21 10.1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1.03Z",
  search: "M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14ZM20 20l-4-4",
  check: "M4.5 12.5 9.5 17.5 19.5 6.5",
  x: "M6 6l12 12M18 6 6 18",
  plus: "M12 5v14M5 12h14",
  minus: "M5 12h14",
  "alert-triangle": "M12 4 2.7 20h18.6zM12 10v4M12 17.5v.01",
  "alert-circle": "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM12 8v5M12 16v.01",
  info: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM12 11v5M12 8v.01",
  "check-circle": "M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0ZM8 12.5l2.5 2.5 5.5-5.5",
  copy: "M9 9h9.5A1.5 1.5 0 0 1 20 10.5V20a1.5 1.5 0 0 1-1.5 1.5H9A1.5 1.5 0 0 1 7.5 20v-9.5A1.5 1.5 0 0 1 9 9ZM4.5 15A1.5 1.5 0 0 1 3 13.5V4A1.5 1.5 0 0 1 4.5 2.5H14A1.5 1.5 0 0 1 15.5 4v1",
  trash: "M4 7h16M9 7V4.5A.5.5 0 0 1 9.5 4h5a.5.5 0 0 1 .5.5V7M6 7l1 12.5A1.5 1.5 0 0 0 8.5 21h7a1.5 1.5 0 0 0 1.5-1.5L18 7M10 11v6M14 11v6",
  edit: "M4 20h4L19 9a2.1 2.1 0 0 0-3-3L5 17v3ZM14.5 7.5l2 2",
  refresh: "M20 11a8 8 0 0 0-14.2-4.5M4 13a8 8 0 0 0 14.2 4.5M4 4v4h4M20 20v-4h-4",
  play: "M7 4.5 19 12 7 19.5Z",
  stop: "M6.5 6.5h11v11h-11z",
  download: "M12 4v12m0 0 4.5-4.5M12 16l-4.5-4.5M4 18.5V20a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-1.5",
  "external-link": "M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5",
  filter: "M3 5h18l-7 8v6l-4 2v-8Z",
  sun: "M12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10ZM12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4",
  moon: "M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5Z",
  monitor: "M4 5h16a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1ZM9 20h6M12 16v4",
  "panel-left": "M4 4h16a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1ZM9.5 4v16",
  command: "M9 6a3 3 0 1 0-3 3h12a3 3 0 1 0-3-3v12a3 3 0 1 0 3-3H6a3 3 0 1 0 3 3Z",
  "chevron-down": "M6 9.5 12 15.5 18 9.5",
  "chevron-up": "M6 14.5 12 8.5 18 14.5",
  "chevron-right": "M9.5 6 15.5 12 9.5 18",
  "chevron-left": "M14.5 6 8.5 12 14.5 18",
  "chevrons-up-down": "M8 9.5 12 5.5 16 9.5M8 14.5 12 18.5 16 14.5",
  "arrow-right": "M4 12h16m0 0-6-6m6 6-6 6",
  "arrow-left": "M20 12H4m0 0 6-6m-6 6 6 6",
  "arrow-up": "M12 20V4m0 0-6 6m6-6 6 6",
  "arrow-down": "M12 4v16m0 0 6-6m-6 6-6-6",
  clock: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM12 7v5.2l3.2 2",
  zap: "M13 3 4.5 13.5H11l-1 7.5L19.5 10.5H13Z",
  database: "M12 8c4.4 0 8-1.1 8-2.5S16.4 3 12 3 4 4.1 4 5.5 7.6 8 12 8ZM4 5.5v13C4 19.9 7.6 21 12 21s8-1.1 8-2.5v-13M4 12c0 1.4 3.6 2.5 8 2.5s8-1.1 8-2.5",
  tag: "M4 4h7l9 9-7 7-9-9V4ZM8 8.01V8",
  folder: "M3 6.5A1.5 1.5 0 0 1 4.5 5h4L11 7.5h8.5A1.5 1.5 0 0 1 21 9v9a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 18V6.5Z",
  image: "M4 5h16a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1ZM8.5 10.5a1.25 1.25 0 1 0 0-2.5 1.25 1.25 0 0 0 0 2.5ZM3 16l5-4.5 4.5 4 3-2.5L21 17",
  file: "M13 3H7a1.5 1.5 0 0 0-1.5 1.5v15A1.5 1.5 0 0 0 7 21h10a1.5 1.5 0 0 0 1.5-1.5V8.5L13 3ZM13 3v5.5h5.5",
  layers: "m12 3 9 5-9 5-9-5 9-5ZM3 12.5 12 17.5l9-5M3 17l9 5 9-5",
  package:
    "m12 2.5 8.5 4.6v9.8L12 21.5 3.5 16.9V7.1L12 2.5ZM3.7 7 12 11.6 20.3 7M12 11.6v9.9",
  "more-horizontal": "M6 12v.01M12 12v.01M18 12v.01",
  menu: "M4 7h16M4 12h16M4 17h16",
  history: "M3.5 9A9 9 0 1 1 3 13M3.5 4v5h5M12 8v4.5l3 1.8",
  key: "M14.5 3a6.5 6.5 0 0 1 3.1 12.2L15 21l-2.5-1.5L10 21l-1.5-3 3-5.4A6.5 6.5 0 0 1 14.5 3ZM15.5 8v.01",
  broom: "M14 3 21 10M12.5 4.5 19.5 11.5M13 9 5.5 16.5 3 21l4.5-2.5L15 11",
  gauge: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM12 12l4-4",
  "shield-check": "M12 3 20 6v6c0 4.4-3.3 7.9-8 9-4.7-1.1-8-4.6-8-9V6l8-3ZM8.5 12l2.5 2.5 4.5-4.5",
  link: "M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 1 0-5.7-5.7L11.5 6.8M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 1 0 5.7 5.7l1.4-1.4",
  save: "M5 3h11l3 3v14a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1ZM8 3v6h7V3M8 14h8",
} as const;

export type IconName = keyof typeof PATHS;

export const ICON_NAMES = Object.keys(PATHS) as IconName[];

export function Icon({
  name,
  className,
}: {
  name: IconName;
  /** For sizing and inherited colour only (`size-4`, `shrink-0`). */
  className?: string;
}) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      className={cn("size-4 shrink-0", className)}
    >
      <path d={PATHS[name]} />
    </svg>
  );
}
