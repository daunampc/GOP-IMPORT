/*
 * Money for the crawler.
 *
 * Do NOT import "server-only" here — the worker imports this, and so does the
 * test suite, which runs under plain tsx.
 */

/**
 * Prices are STRINGS all the way through, and that is not a style preference.
 *
 * `Product.regular_price` accepts `number | string`, and a float cannot hold
 * 19.99 exactly: `1999 / 100` is 19.989999999999998 on some values, and the
 * arithmetic that follows a currency conversion compounds it. A decimal string
 * built from integer arithmetic has no such failure mode, and the plugin parses
 * a string exactly as happily as a number.
 */

export class CrawlMoneyError extends Error {}

/**
 * An integer in a currency's smallest unit, as a decimal string.
 *
 * The `minorUnit` argument is the whole point of this function. Shopify sends
 * cents and dividing by 100 is right for USD, EUR and GBP — and WRONG for VND
 * and JPY, which have no minor unit at all, where it would report a 25,400 đ
 * product as 254 đ. WooCommerce's Store API states its own exponent in
 * `currency_minor_unit`; Shopify does not, so the Shopify adapter passes the
 * exponent for the currency it was told.
 */
export function fromMinorUnits(value: number | string, minorUnit: number): string {
  if (!Number.isInteger(minorUnit) || minorUnit < 0 || minorUnit > 4) {
    throw new CrawlMoneyError(`A currency's minor unit must be 0 to 4, not ${minorUnit}.`);
  }

  const raw = typeof value === "string" ? value.trim() : value;
  const amount = typeof raw === "string" ? Number(raw) : raw;

  if (!Number.isInteger(amount)) {
    throw new CrawlMoneyError(
      `A price in minor units must be a whole number, not ${JSON.stringify(value)}.`,
    );
  }

  if (minorUnit === 0) {
    return String(amount);
  }

  const negative = amount < 0;
  const digits = String(Math.abs(amount)).padStart(minorUnit + 1, "0");
  const whole = digits.slice(0, digits.length - minorUnit);
  const fraction = digits.slice(digits.length - minorUnit);

  return `${negative ? "-" : ""}${whole}.${fraction}`;
}

/**
 * Multiply by an operator-entered exchange rate.
 *
 * Two decimal places out, because that is what a shop displays. The rate itself
 * is recorded on the run — see `lib/crawl-options.ts` — so the number here can
 * always be re-derived from what the operator actually typed.
 */
export function convert(amount: string, rate: number): string {
  if (!Number.isFinite(rate) || rate <= 0) {
    throw new CrawlMoneyError(`An exchange rate must be a positive number, not ${rate}.`);
  }

  const value = Number(amount);
  if (!Number.isFinite(value)) {
    throw new CrawlMoneyError(`Not a price: ${JSON.stringify(amount)}.`);
  }

  return (value * rate).toFixed(2);
}
