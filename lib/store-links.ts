/**
 * Pure site helpers, safe on BOTH sides.
 *
 * Split out of `lib/stores.ts` by necessity rather than for tidiness:
 * `lib/stores.ts` drags in ioredis, which requires `net`/`tls`/`dns`/`fs`. One
 * Client Component importing one small function from there puts the whole Redis
 * package into the browser bundle and breaks `next build` with "Module not
 * found: Can't resolve 'net'".
 *
 * Nothing here imports anything but types, so it is safe for the client.
 */

export interface StoreIdentity {
  label: string;
  url: string;
}

/** The display name: the label if there is one, otherwise the URL's host. */
export function storeLabel(store: StoreIdentity): string {
  if (store.label.trim() !== "") {
    return store.label.trim();
  }
  try {
    return new URL(store.url).host;
  } catch {
    return store.url;
  }
}

/**
 * A link to the product's edit screen in wp-admin.
 *
 * Prefers the `site_url` the plugin itself reports: the URL someone typed may
 * be a different way in (a reverse proxy, an alternate domain), while what the
 * plugin reports is where WordPress actually lives.
 */
export function adminProductUrl(
  store: { url: string; siteUrl: string | null },
  productId: number,
): string {
  const root = (store.siteUrl ?? store.url).replace(/\/$/, "");
  return `${root}/wp-admin/post.php?post=${productId}&action=edit`;
}
