import type { PublicStore } from "@/lib/stores";
import { isOutdated } from "@/lib/plugin-version";
import { StatusPill, type Tone } from "@/components/ui";

/**
 * A site's health, reduced to one verdict.
 *
 * Four states rather than two. A green/red dot alone makes "never checked" look
 * exactly like "checked and broken", and leaves "reachable but running an older
 * plugin" with nowhere to appear at all.
 */
export type StoreHealth = "unknown" | "ok" | "outdated" | "broken";

export function storeHealth(store: PublicStore, expectedVersion: string | null): StoreHealth {
  if (store.lastCheckOk === null) {
    return "unknown";
  }
  if (!store.lastCheckOk) {
    return "broken";
  }
  if (isOutdated(store.pluginVersion, expectedVersion)) {
    return "outdated";
  }
  return "ok";
}

const META: Record<StoreHealth, { label: string; tone: Tone }> = {
  unknown: { label: "Not checked", tone: "neutral" },
  ok: { label: "Healthy", tone: "ok" },
  outdated: { label: "Older plugin", tone: "warn" },
  broken: { label: "Unreachable", tone: "bad" },
};

export function StoreHealthPill({
  store,
  expectedVersion,
}: {
  store: PublicStore;
  expectedVersion: string | null;
}) {
  const meta = META[storeHealth(store, expectedVersion)];
  return <StatusPill tone={meta.tone} label={meta.label} />;
}

export { META as STORE_HEALTH_META };
