/*
 * Do NOT import "server-only" here — this module is in the worker's import graph.
 *
 * This file touches the database. Anything a Client Component needs lives in
 * `lib/purge-options.ts` instead: importing this one from the browser pulls in
 * bullmq and ioredis and fails the build with `Can't resolve 'net'`.
 */

import { getJobItems } from "./jobs";
import type { PurgeItem } from "./purge-options";

/** Read a purge run's staged list back, tolerating rows written as bare ids. */
export async function getPurgeItems(jobId: string): Promise<PurgeItem[]> {
  const items = await getJobItems(jobId);

  return items
    .map((item): PurgeItem | null => {
      if (typeof item === "number") {
        return { product_id: item, sku: "", name: "" };
      }

      if (item !== null && typeof item === "object" && "product_id" in item) {
        const record = item as Record<string, unknown>;
        const productId = Number(record.product_id);

        if (!Number.isInteger(productId) || productId <= 0) {
          return null;
        }

        return {
          product_id: productId,
          sku: typeof record.sku === "string" ? record.sku : "",
          name: typeof record.name === "string" ? record.name : "",
        };
      }

      return null;
    })
    .filter((item): item is PurgeItem => item !== null);
}
