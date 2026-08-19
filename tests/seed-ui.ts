/**
 * Seeds a REAL stack with sample data, for looking at the interface.
 *
 * Not a test — there is not an assertion in it. This exists to produce an
 * environment with data in it: a connected site, a few finished runs covering
 * all three outcomes (created / already present / failed), and one long run
 * still going, so the status bar and the detail page can be seen in motion.
 *
 * Uses exactly the functions the interface uses (`createStore`, `checkStore`,
 * `applyOptions`, `enqueueImport`), so what it produces is real data rather
 * than a pretty fabrication.
 *
 * Run with:
 *   PLUGIN_URL=... PLUGIN_API_KEY=... PLUGIN_API_SECRET=... tsx tests/seed-ui.ts
 */

import { DEFAULT_IMPORT_OPTIONS } from "../lib/import-options";
import { enqueueImport, importQueue, listJobs } from "../lib/jobs";
import { redis } from "../lib/redis";
import { checkStore, createStore, listStores, storeLabel } from "../lib/stores";
import { savePreset } from "../lib/presets";
import { applyOptions } from "../lib/transform";
import type { Product } from "../lib/gop-client";
import { db } from "../db";
import { users } from "../db/schema";
import { eq } from "drizzle-orm";
import { makeAccount } from "./accounts";

// Vietnamese on purpose: this is product DATA, and the pipeline has to carry
// diacritics through the CSV reader, the slug builder and MySQL untouched.
const CATEGORIES = [
  "Quần áo > Áo thun > Nam",
  "Quần áo > Áo thun > Nữ",
  "Quần áo > Hoodie",
  "Phụ kiện > Mũ",
];

const TAGS = ["POD", "Bán chạy", "Hàng mới", "Giảm giá"];

function sampleProducts(count: number, prefix: string): Product[] {
  const products: Product[] = [];

  for (let index = 0; index < count; index++) {
    products.push({
      name: `${prefix} sample ${index + 1}`,
      slug: "",
      sku: `${prefix.toUpperCase().replace(/\s+/g, "-")}-${index + 1}`,
      description: `Description for product ${index + 1} of the ${prefix} batch.`,
      price: String(150_000 + (index % 12) * 25_000),
      instock: true,
      categories: [CATEGORIES[index % CATEGORIES.length]],
      tags: [TAGS[index % TAGS.length]],
      images: [`https://cdn.test/${prefix}-${index + 1}.jpg`],
      type: "simple",
    });
  }

  return products;
}

async function main(): Promise<void> {
  // Everything here belongs to one account now, so the seed needs one. Reuses
  // the account it made last time rather than piling up demo accounts.
  const owner =
    (await existingOwner()) ?? (await makeAccount("demo@seed.test", "admin")).id;

  console.log(`[seed] owner account: ${owner}`);

  const existing = await listStores(owner);

  const store =
    existing[0] ??
    (await createStore(owner, {
      url: process.env.PLUGIN_URL ?? "http://localhost:8080",
      pin: "",
      apiKey: process.env.PLUGIN_API_KEY ?? "",
      apiSecret: process.env.PLUGIN_API_SECRET ?? "",
      urlRewrite: false,
      // PHP's built-in server serves the plugin directory directly, without
      // the /wp-content/plugins/ prefix a real WordPress site has.
      baseUrlOverride: process.env.PLUGIN_URL ?? "http://localhost:8080",
      label: "Demo site",
    }));

  const check = await checkStore(store);
  console.log(`[seed] connection check: ${check.ok ? "OK" : "FAILED"} — ${check.message}`);

  if ((await listJobs(owner, 5)).length > 0) {
    console.log("[seed] runs already exist, skipping the data generation.");
    await importQueue.close();
    await redis.quit();
    return;
  }

  await savePreset("POD, original image links, 10 lanes", {
    ...DEFAULT_IMPORT_OPTIONS,
    flattenVariants: true,
    keepProductAttributes: false,
  }, owner);
  await savePreset("Generate SKUs for rows without one", {
    ...DEFAULT_IMPORT_OPTIONS,
    autoSku: true,
    addRandomSuffixToSlug: true,
  }, owner);

  const options = {
    ...DEFAULT_IMPORT_OPTIONS,
    storeId: store.id,
    threads: 4,
    batchSize: 25,
  };

  // Batch 1 carries a row with no name so the plugin rejects that row alone —
  // a run with both successes and failures is what the result filters need.
  const first = [
    ...sampleProducts(60, "T-shirt"),
    { name: "", sku: "BROKEN-1" } as Product,
    { name: "", sku: "BROKEN-2" } as Product,
  ];

  // Transformed ONCE and reused by both batches.
  //
  // Calling applyOptions twice would not do: it appends a random suffix to each
  // slug, the idempotency key is hashed from that slug, and two calls therefore
  // produce two different keys — the second batch would create 60 more products
  // instead of matching the first. Building once and reusing is also exactly
  // what the real wizard does, where one preview is staged and reused.
  const firstProducts = applyOptions(first, options, { sourceId: "seed-tshirts" });

  const firstJob = await enqueueImport({
    storeId: store.id,
    storeUrl: store.url,
    storeLabel: storeLabel(store),
    sourceLabel: "tshirts-august.csv",
    options,
    products: firstProducts,
    createdBy: owner,
  });
  console.log(`[seed] batch 1: ${firstJob.id} (${firstJob.total} products)`);

  // Batch 2 RESENDS exactly those rows, so the idempotency keys match and the
  // plugin answers `deduplicated: true` — the only way to see the "already
  // present" column carrying real data.
  const second = await enqueueImport({
    storeId: store.id,
    storeUrl: store.url,
    storeLabel: storeLabel(store),
    sourceLabel: "tshirts-august.csv (rerun)",
    options,
    products: firstProducts,
    createdBy: owner,
  });
  console.log(`[seed] batch 2: ${second.id} — will deduplicate against batch 1`);

  // Batch 3 is long and deliberately slow (one lane, five per batch) so the
  // running state is visible on the status bar and the detail page.
  const slowOptions = { ...options, threads: 1, batchSize: 5 };
  const third = await enqueueImport({
    storeId: store.id,
    storeUrl: store.url,
    storeLabel: storeLabel(store),
    sourceLabel: "hoodie-winter.csv",
    options: slowOptions,
    products: applyOptions(sampleProducts(400, "Hoodie"), slowOptions, {
      sourceId: "seed-hoodie",
    }),
    createdBy: owner,
  });
  console.log(`[seed] batch 3: ${third.id} (${third.total} products, running slowly)`);

  await importQueue.close();
  await redis.quit();
}

/** The account a previous seed created, so repeated runs do not pile them up. */
async function existingOwner(): Promise<string | null> {
  const [row] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, "demo@seed.test"))
    .limit(1);

  return row?.id ?? null;
}

void main().then(
  () => process.exit(0),
  (error) => {
    console.error("[seed] failed:", error);
    process.exit(1);
  },
);
