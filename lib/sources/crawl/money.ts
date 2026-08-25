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
 * A decimal price string as an integer in the currency's smallest unit.
 *
 * The inverse of `fromMinorUnits`, and it parses the STRING rather than going
 * through a float: `Number("18.005") * 100` is 1800.4999999999998, which rounds
 * to a price that is not the one the shop quoted, and nothing anywhere would say
 * so. Digits are counted instead, so losing one is an error rather than a
 * rounding.
 *
 * Trailing zeros are not precision. Shopify quotes a VND price as "25400.00"
 * even though the currency has no minor unit at all, so stripping them is what
 * lets that parse rather than being refused for two decimals too many.
 */
export function fromDecimal(value: number | string, minorUnit: number): number {
  if (!Number.isInteger(minorUnit) || minorUnit < 0 || minorUnit > 4) {
    throw new CrawlMoneyError(`A currency's minor unit must be 0 to 4, not ${minorUnit}.`);
  }

  const text = String(value).trim();
  const match = /^(-?)(\d+)(?:\.(\d*))?$/.exec(text);

  if (match === null) {
    throw new CrawlMoneyError(`Not a price: ${JSON.stringify(value)}.`);
  }

  const [, sign, whole, fractionRaw = ""] = match;
  const fraction = fractionRaw.replace(/0+$/, "");

  if (fraction.length > minorUnit) {
    throw new CrawlMoneyError(
      `${text} has ${fraction.length} decimal place(s), which a currency with ${minorUnit} cannot hold.`,
    );
  }

  const minor = Number(`${whole}${fraction.padEnd(minorUnit, "0")}`);

  return sign === "-" ? -minor : minor;
}

/**
 * Multiply by an operator-entered exchange rate.
 *
 * As many decimal places out as the source currency has, not a hardcoded two —
 * `minorUnit` is the same argument `fromMinorUnits`/`fromDecimal` take, and this
 * function is built on top of both of them rather than repeating their scaling
 * with its own assumption baked in. Assuming two silently dropped the third
 * digit of a three-decimal currency (KWD, BHD, OMR) before the rate was even
 * applied — `"19.995"` came out `"20.00"`. The rate itself is recorded on the
 * run — see `lib/crawl-options.ts` — so the number here can always be
 * re-derived from what the operator actually typed.
 */
export function convert(amount: string, rate: number, minorUnit: number): string {
  if (!Number.isFinite(rate) || rate <= 0) {
    throw new CrawlMoneyError(`An exchange rate must be a positive number, not ${rate}.`);
  }

  /*
   * `fromDecimal` parses the STRING rather than going through a float — the same
   * reason it exists in the first place — and it refuses an amount that carries
   * more precision than `minorUnit` can hold, rather than let this function
   * round it away. `price()` in the Shopify adapter always builds `amount` from
   * `fromMinorUnits`/`fromDecimal` at this exact `minorUnit`, so that refusal
   * should never fire in practice — but a caller that broke that invariant gets
   * an error, not a silently wrong price.
   */
  const minor = fromDecimal(amount, minorUnit);

  /*
   * Multiplying on the integer minor-unit amount, not the decimal one, so a
   * half-way result is decided by a rounding rule rather than by a binary
   * floating-point artefact.
   *
   * 19.99 x 0.5 is 9.995, which money rounds up to 10.00. Computed as
   * `19.99 * 0.5` the double is 9.994999999999999, and `.toFixed(2)` answers
   * "9.99" — a cent lost to the representation. As `1999 * 0.5` the result is
   * 999.5 exactly, and `Math.round` takes it to 1000.
   */
  const converted = Math.round(minor * rate);

  return fromMinorUnits(converted, minorUnit);
}
