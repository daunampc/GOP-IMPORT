/**
 * Shared display formatting.
 *
 * Imports NOTHING from Node — this file runs on the server and in the browser.
 *
 * Every function accepts `null`/`undefined` and answers with a dash, rather
 * than leaving screens to scatter `?? "—"` across dozens of call sites and
 * still miss one that prints "undefined".
 */

const DASH = "—";

/**
 * Numbers use `en-GB` rather than the reader's locale.
 *
 * A locale-dependent separator would differ between the server render and the
 * browser one, which React reports as a hydration error — the same trap the
 * time helpers in `components/ui/client-time.tsx` exist to avoid.
 */
const LOCALE = "en-GB";

export function formatNumber(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) {
    return DASH;
  }
  return new Intl.NumberFormat(LOCALE).format(value);
}

/* ------------------------------------------------------------------ money */

/**
 * The currencies offered in the picker. `""` means "show the raw number".
 *
 * Not an exhaustive ISO 4217 list on purpose: a 180-entry dropdown is worse than
 * a short one plus the knowledge that adding a line here is trivial.
 */
export const CURRENCIES: ReadonlyArray<{ code: string; label: string }> = [
  { code: "", label: "No symbol — show the raw number" },
  { code: "VND", label: "VND — Vietnamese đồng (₫)" },
  { code: "USD", label: "USD — US dollar ($)" },
  { code: "EUR", label: "EUR — Euro (€)" },
  { code: "GBP", label: "GBP — Pound sterling (£)" },
  { code: "JPY", label: "JPY — Japanese yen (¥)" },
  { code: "CNY", label: "CNY — Chinese yuan (¥)" },
  { code: "KRW", label: "KRW — South Korean won (₩)" },
  { code: "THB", label: "THB — Thai baht (฿)" },
  { code: "SGD", label: "SGD — Singapore dollar (S$)" },
  { code: "MYR", label: "MYR — Malaysian ringgit (RM)" },
  { code: "AUD", label: "AUD — Australian dollar (A$)" },
  { code: "INR", label: "INR — Indian rupee (₹)" },
];

export function isKnownCurrency(code: string): boolean {
  return CURRENCIES.some((currency) => currency.code === code);
}

/**
 * A price, with a currency symbol if one has been chosen.
 *
 * DISPLAY ONLY, and that is the whole of it. This does not touch the site and
 * cannot: the plugin writes `_price`, `_regular_price` and `_sale_price` as raw
 * numbers into `postmeta`, and WooCommerce renders them using the SITE's own
 * `woocommerce_currency` option. Stock WooCommerce has no per-product currency —
 * one shop has one currency — so nothing chosen here changes what a shopper sees.
 * What it changes is what the OPERATOR sees while deciding whether to publish,
 * which is where the confusion was: the same payload displayed as `$199,000.00` on
 * a site set to USD and `₫199,000` on one set to VND, and the app showed a bare
 * `199000` either way and left them to guess.
 *
 * It deliberately does NOT convert. The number here is the number in the file and
 * the number that reaches the database; a symbol in front of it is a label, not
 * arithmetic. Converting would make the results table disagree with the source
 * file for ever after.
 *
 * `LOCALE` is pinned for the same reason as `formatNumber` above, and it matters
 * more here: currency symbol PLACEMENT is locale-dependent, so the reader's own
 * locale would put the symbol in one place on the server and another in the
 * browser, which React reports as a hydration error.
 */
export function formatMoney(
  value: number | string | null | undefined,
  currency: string | null | undefined,
): string {
  const amount = typeof value === "string" ? Number.parseFloat(value) : value;

  if (amount === null || amount === undefined || !Number.isFinite(amount)) {
    return DASH;
  }

  if (!currency || !isKnownCurrency(currency) || currency === "") {
    return new Intl.NumberFormat(LOCALE).format(amount);
  }

  try {
    return new Intl.NumberFormat(LOCALE, { style: "currency", currency }).format(amount);
  } catch {
    // An unrecognised code must not take a whole results table down with it.
    return `${new Intl.NumberFormat(LOCALE).format(amount)} ${currency}`;
  }
}

/**
 * What to say beside a price so nobody mistakes the symbol for a setting that
 * reached the shop. Short enough to sit under a preview table.
 */
export const CURRENCY_DISCLAIMER =
  "Display only. Prices are published as plain numbers and each site shows them in " +
  "its own WooCommerce currency — choosing one here does not change any site.";

export function formatPercent(ratio: number | null | undefined, digits = 1): string {
  if (ratio === null || ratio === undefined || Number.isNaN(ratio)) {
    return DASH;
  }
  return `${(ratio * 100).toFixed(digits).replace(/\.0$/, "")}%`;
}

/** A span in milliseconds → "1.2 s" / "3 min 20 s". */
export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || Number.isNaN(ms)) {
    return DASH;
  }

  if (ms < 1000) {
    return `${Math.round(ms)} ms`;
  }

  const seconds = ms / 1000;
  if (seconds < 60) {
    return `${seconds.toFixed(seconds < 10 ? 1 : 0)} s`;
  }

  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds % 60);

  if (minutes < 60) {
    return rest === 0 ? `${minutes} min` : `${minutes} min ${rest} s`;
  }

  const hours = Math.floor(minutes / 60);
  const restMinutes = minutes % 60;
  return restMinutes === 0 ? `${hours} h` : `${hours} h ${restMinutes} min`;
}

export function formatSeconds(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined) {
    return DASH;
  }
  // An estimate that rounds down to zero and prints "0 ms" reads as broken. Say
  // what is actually meant.
  if (seconds <= 0) {
    return "under a second";
  }
  return formatDuration(seconds * 1000);
}

/**
 * The span between two ISO timestamps. With no end, it runs to now — which is
 * what a running job needs.
 */
export function elapsedBetween(
  startedAt: string | null,
  finishedAt: string | null,
): number | null {
  if (startedAt === null) {
    return null;
  }
  const end = finishedAt === null ? Date.now() : new Date(finishedAt).getTime();
  return Math.max(0, end - new Date(startedAt).getTime());
}

/**
 * An absolute timestamp. Date AND time, always: an operations log that says
 * only "14:32" is unreadable the next morning.
 */
export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) {
    return DASH;
  }
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return DASH;
  }
  return new Intl.DateTimeFormat(LOCALE, {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

export function formatDayLabel(date: string): string {
  const parsed = new Date(`${date}T00:00:00`);
  if (Number.isNaN(parsed.getTime())) {
    return date;
  }
  return new Intl.DateTimeFormat(LOCALE, { day: "2-digit", month: "2-digit" }).format(parsed);
}

/**
 * "3 minutes ago", or "in 6 hours".
 *
 * BOTH DIRECTIONS, and the future half is not hypothetical: this only ever looked
 * backwards, so a scheduled run six hours away rendered as "just now" — the
 * negative difference fell straight into the under-45-seconds branch. A countdown
 * that says "just now" about tomorrow morning is worse than no countdown, because
 * it reads as a run that should already have started.
 */
export function formatRelative(iso: string | null | undefined): string {
  if (!iso) {
    return "never";
  }

  const time = new Date(iso).getTime();
  if (Number.isNaN(time)) {
    return DASH;
  }

  const diff = Date.now() - time;
  const ahead = diff < 0;
  const size = Math.abs(diff);

  // The dead zone has to be symmetric, or a due time seconds away reads as
  // "in 0 minutes".
  if (size < 45_000) {
    return ahead ? "in a moment" : "just now";
  }

  const say = (value: number, unit: string) => {
    const plural = `${value} ${unit}${value === 1 ? "" : "s"}`;
    return ahead ? `in ${plural}` : `${plural} ago`;
  };

  const minutes = Math.round(size / 60_000);
  if (minutes < 60) {
    return say(minutes, "minute");
  }

  const hours = Math.round(minutes / 60);
  if (hours < 24) {
    return say(hours, "hour");
  }

  return say(Math.round(hours / 24), "day");
}

/**
 * Is this timestamp coming up within `withinMs`?
 *
 * A function here rather than an expression at the call site for a mechanical
 * reason: `react-hooks/purity` rejects `Date.now()` written directly in a render
 * body, and it is an error in this codebase rather than a warning. Reading the
 * clock inside a plain helper is the same arrangement `formatRelative` above uses,
 * and it keeps the component free of the impure call.
 *
 * Callers must still gate the RESULT behind `useHydrated()` — the lint rule and the
 * hydration mismatch are two separate problems, and moving the call out of the
 * render body only solves the first.
 */
export function isWithin(
  iso: string | null | undefined,
  withinMs: number,
): boolean {
  if (!iso) {
    return false;
  }

  const time = new Date(iso).getTime();
  if (Number.isNaN(time)) {
    return false;
  }

  const remaining = time - Date.now();
  return remaining > 0 && remaining < withinMs;
}

export function formatThroughput(perSecond: number | null | undefined): string {
  if (perSecond === null || perSecond === undefined || Number.isNaN(perSecond)) {
    return DASH;
  }
  if (perSecond < 1) {
    return `${(perSecond * 60).toFixed(1)}/min`;
  }
  return `${perSecond.toFixed(1)}/s`;
}
