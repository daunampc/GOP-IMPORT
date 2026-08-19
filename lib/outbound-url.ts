/*
 * Do NOT import "server-only" here — the worker imports this, and so does a route.
 */

import { lookup } from "node:dns/promises";
import net from "node:net";

/**
 * URLs this app refuses to open, wherever they came from.
 *
 * Two features hand it strings from outside: the preview's image check (links out of
 * a customer's CSV) and the run-finished webhook (a URL the account typed into
 * Settings). Neither is a URL this app chose, and "make the server fetch this" is
 * the whole of an SSRF. One rule in one place, so the two cannot drift into
 * disagreeing about what is safe.
 */

/**
 * Hostnames this app will not fetch, whatever a file says.
 *
 * The links come out of a customer's CSV, so without this the route would take
 * arbitrary strings from an untrusted file and make the SERVER fetch them — the
 * classic way to turn a helpful preview into a probe of whatever is reachable from
 * inside the network, cloud metadata endpoints included.
 *
 * Reported as `blocked` rather than dropped, because it is also the honest answer
 * to the operator's actual question: a link to `127.0.0.1` or `10.0.0.5` is a link
 * no shopper could ever load either.
 *
 * What this list does NOT catch, stated plainly: a public hostname that RESOLVES to
 * a private address. For the preview check that is tolerable — redirects are not
 * followed, and the response it keeps is a status and a content type, never a body,
 * so what an unblocked private host could reveal is one number.
 *
 * It is NOT tolerable for downloading, which keeps the body and follows redirects.
 * `assertFetchableUrl` below is the stronger check that path uses: it resolves the
 * name and inspects every address. Both live here so the two can never drift into
 * disagreeing about what is safe.
 */
const BLOCKED_HOST_PATTERNS = [
  /^localhost$/i,
  /\.localhost$/i,
  /^127\./,
  /^0\.0\.0\.0$/,
  /^10\./,
  /^192\.168\./,
  /^172\.(1[6-9]|2[0-9]|3[01])\./,
  // Link-local, which is where cloud instance metadata lives.
  /^169\.254\./,
  /^\[?::1\]?$/,
  // IPv6 unique-local and link-local.
  /^\[?f[cd][0-9a-f]{2}:/i,
  /^\[?fe80:/i,
  /\.local$/i,
  /\.internal$/i,
];

/** Why this app refuses to fetch a URL at all, or null when it will. */
export function blockedReason(raw: string): string | null {
  let url: URL;

  try {
    url = new URL(raw);
  } catch {
    return "This is not a URL the browser could load either.";
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return `Only http and https links can be checked — this one is \`${url.protocol}\`.`;
  }

  const host = url.hostname;

  if (BLOCKED_HOST_PATTERNS.some((pattern) => pattern.test(host))) {
    return (
      `\`${host}\` is a private or local address. It was not requested, and a shopper's ` +
      `browser could not load it either.`
    );
  }

  return null;
}


/* ------------------------------------------------------------------------- *
 * The stronger check: resolve the name, and look at what comes back.
 *
 * Used by the image downloader, where the stakes are different from the preview's.
 * The preview asks for headers and keeps a status; the downloader keeps the BODY and
 * follows redirects, and it runs on this app's own infrastructure against URLs typed
 * into a CSV by a customer. Until plugin 3.9.0 those fetches were made by PHP on the
 * customer's own site, so an internal URL only ever reached the customer's own
 * network — moving the work here is what makes resolution-aware checking necessary.
 * ------------------------------------------------------------------------- */

export class OutboundUrlError extends Error {}

/**
 * Private, loopback, link-local and carrier-grade-NAT ranges.
 *
 * `169.254.0.0/16` earns its own mention: `169.254.169.254` is the cloud instance
 * metadata endpoint, and reading it is the single most valuable thing an SSRF can do
 * to a worker like ours.
 */
const BLOCKED_V4: Array<{ network: string; bits: number }> = [
  { network: "0.0.0.0", bits: 8 }, // "this host"
  { network: "10.0.0.0", bits: 8 },
  { network: "100.64.0.0", bits: 10 }, // CGNAT
  { network: "127.0.0.0", bits: 8 },
  { network: "169.254.0.0", bits: 16 }, // link-local, incl. cloud metadata
  { network: "172.16.0.0", bits: 12 },
  { network: "192.0.0.0", bits: 24 },
  { network: "192.168.0.0", bits: 16 },
  { network: "198.18.0.0", bits: 15 }, // benchmarking
  { network: "224.0.0.0", bits: 4 }, // multicast
  { network: "240.0.0.0", bits: 4 }, // reserved
];

function toV4(ip: string): number | null {
  const octets = ip.split(".").map((part) => Number.parseInt(part, 10));

  if (octets.length !== 4) {
    return null;
  }

  if (octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) {
    return null;
  }

  return ((octets[0] << 24) | (octets[1] << 16) | (octets[2] << 8) | octets[3]) >>> 0;
}

function ipv4Blocked(ip: string): boolean {
  const value = toV4(ip);

  // Unparseable is not something to give the benefit of the doubt.
  if (value === null) {
    return true;
  }

  return BLOCKED_V4.some(({ network, bits }) => {
    const base = toV4(network) ?? 0;
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    return (value & mask) === (base & mask);
  });
}

/**
 * An IPv6 address as its eight 16-bit groups, or null if it is not one.
 *
 * Written out rather than pattern-matched on the text because the text cannot be
 * trusted to look like what was typed. `new URL("http://[::ffff:127.0.0.1]/")` hands
 * back `[::ffff:7f00:1]` — the WHATWG parser rewrites the dotted tail as hex — so a
 * check looking for `::ffff:` followed by a dotted quad matches what a person writes
 * and misses the value the program holds. That was a real hole: it let
 * `::ffff:127.0.0.1` through, and `tests/images-staging.ts` caught it.
 */
function ipv6Groups(address: string): number[] | null {
  let text = address;

  // A trailing dotted quad, in case a caller hands one over unnormalised.
  const dotted = /:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(text);
  if (dotted !== null) {
    const value = toV4(dotted[1]);

    if (value === null) {
      return null;
    }

    text =
      text.slice(0, dotted.index + 1) +
      ((value >>> 16) & 0xffff).toString(16) +
      ":" +
      (value & 0xffff).toString(16);
  }

  const halves = text.split("::");
  if (halves.length > 2) {
    return null;
  }

  const head = halves[0] === "" ? [] : halves[0].split(":");
  const tail = halves.length === 2 && halves[1] !== "" ? halves[1].split(":") : [];

  let parts: string[];

  if (halves.length === 1) {
    if (head.length !== 8) {
      return null;
    }
    parts = head;
  } else {
    if (head.length + tail.length > 7) {
      return null;
    }
    parts = [...head, ...new Array<string>(8 - head.length - tail.length).fill("0"), ...tail];
  }

  const groups = parts.map((part) =>
    /^[0-9a-f]{1,4}$/.test(part) ? Number.parseInt(part, 16) : NaN,
  );

  return groups.length === 8 && groups.every((group) => Number.isInteger(group)) ? groups : null;
}

function ipv6Blocked(ip: string): boolean {
  const groups = ipv6Groups(ip.toLowerCase().split("%")[0]);

  if (groups === null) {
    return true;
  }

  /*
   * IPv4-mapped (`::ffff:a.b.c.d`) and IPv4-compatible (`::a.b.c.d`) addresses are
   * IPv4 addresses wearing a hat: unwrap and apply the IPv4 rules, so
   * `::ffff:127.0.0.1` and `127.0.0.1` get the same answer.
   *
   * `::` and `::1` land here too and need no case of their own — they unwrap to
   * 0.0.0.0 and 0.0.0.1, which `0.0.0.0/8` already blocks.
   */
  if (
    groups.slice(0, 5).every((group) => group === 0) &&
    (groups[5] === 0xffff || groups[5] === 0)
  ) {
    const value = ((groups[6] << 16) | groups[7]) >>> 0;

    return ipv4Blocked(
      [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff].join("."),
    );
  }

  // fc00::/7 unique-local, fe80::/10 link-local, ff00::/8 multicast.
  return (
    (groups[0] & 0xfe00) === 0xfc00 ||
    (groups[0] & 0xffc0) === 0xfe80 ||
    (groups[0] & 0xff00) === 0xff00
  );
}

/** Turn the resolution check off entirely. For local development only. */
function privateHostsAllowed(): boolean {
  return process.env.GOP_ALLOW_PRIVATE_IMAGE_HOSTS === "1";
}

/**
 * Hosts whose private address is tolerated — BY NAME, one at a time.
 *
 * The all-or-nothing switch above is the wrong tool twice over.
 *
 * A customer whose product images genuinely sit on a machine inside their own network
 * needs that ONE host reachable, and the plugin's `allow_private_image_hosts` made
 * them disable the check for every URL in every run to get it. The narrower control
 * is the better product, not merely the testable one.
 *
 * And it is what lets the test suite assert anything at all.
 * `tests/images-staging.sh` runs its fake host in a container whose name resolves
 * into a blocked range; with the global switch that suite would run with the guard
 * OFF, and its most important assertion — that a public URL redirecting to
 * 169.254.169.254 is refused at the second hop — would pass without the guard
 * existing.
 *
 * Matched on the host exactly, never on a suffix: `example.com` in the list must not
 * admit `example.com.attacker.net`.
 */
function allowlistedHosts(): Set<string> {
  return new Set(
    (process.env.GOP_IMAGE_HOST_ALLOWLIST ?? "")
      .split(",")
      .map((host) => host.trim().toLowerCase())
      .filter((host) => host !== ""),
  );
}

/**
 * Throw unless this URL is http(s) and resolves ONLY to public addresses.
 *
 * "Only" matters: a name answering with one public and one private address is
 * refused, because which one the socket picks is not ours to decide.
 *
 * A known and accepted limit: between this resolution and the socket, the name can be
 * re-resolved to something else (DNS rebinding). Closing that needs the connection
 * pinned to the address checked here, which Node's `fetch` does not expose. The
 * plugin's `ImageFetcher::reject()` had exactly the same hole, so nothing regresses —
 * it is simply not fixed. Recorded in the README's known gaps.
 */
export async function assertFetchableUrl(raw: string): Promise<URL> {
  // The cheap name-based rules first, and the SAME ones the preview reports — so a
  // link the preview called `blocked` is not then fetched by the downloader.
  const named = blockedReason(raw);

  if (named !== null) {
    throw new OutboundUrlError(named);
  }

  // blockedReason has already proved this parses and is http(s).
  const url = new URL(raw);

  if (privateHostsAllowed()) {
    return url;
  }

  const host = url.hostname.replace(/^\[|\]$/g, "");

  if (allowlistedHosts().has(host.toLowerCase())) {
    return url;
  }

  if (net.isIP(host) !== 0) {
    if (addressBlocked(host)) {
      throw new OutboundUrlError(`\`${host}\` is an internal address, which is blocked.`);
    }

    return url;
  }

  let addresses: Array<{ address: string }>;

  try {
    addresses = await lookup(host, { all: true });
  } catch {
    throw new OutboundUrlError(`\`${host}\` could not be resolved.`);
  }

  if (addresses.length === 0) {
    throw new OutboundUrlError(`\`${host}\` could not be resolved.`);
  }

  for (const { address } of addresses) {
    if (addressBlocked(address)) {
      throw new OutboundUrlError(
        `\`${host}\` resolves to \`${address}\`, an internal address, which is blocked.`,
      );
    }
  }

  return url;
}

/** True when this literal IP is one this app refuses to open. Exported for tests. */
export function addressBlocked(ip: string): boolean {
  return net.isIPv6(ip) ? ipv6Blocked(ip) : ipv4Blocked(ip);
}
