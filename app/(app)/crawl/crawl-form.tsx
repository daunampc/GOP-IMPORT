"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { Alert, Button, Field, FieldGroup, Input, Panel, Segmented } from "@/components/ui";
import {
  CRAWL_PLATFORMS,
  CRAWL_PLATFORM_LABELS,
  DEFAULT_CRAWL_OPTIONS,
} from "@/lib/crawl-options";

/**
 * Starting a crawl.
 *
 * Deliberately NOT a wizard. A crawl produces products; deciding what to do with
 * them is the import wizard's four steps, and duplicating any of them here would
 * mean two screens that have to agree about SKU generation and category rules.
 * This screen asks only the questions the crawl itself needs.
 *
 * `transport` is not exposed here at all: reading through the customer's own
 * Chrome is a later build (see `lib/crawl-options.ts`), so every run this
 * screen starts is `"server"`, and the route refuses anything else with a
 * clear message rather than the form ever offering a dead option.
 */
export function CrawlForm() {
  const router = useRouter();

  const [shopUrl, setShopUrl] = useState("");
  const [platform, setPlatform] = useState<(typeof CRAWL_PLATFORMS)[number]>(
    DEFAULT_CRAWL_OPTIONS.platform,
  );
  const [limit, setLimit] = useState(DEFAULT_CRAWL_OPTIONS.limit);
  const [imagesPerProduct, setImagesPerProduct] = useState(
    DEFAULT_CRAWL_OPTIONS.imagesPerProduct,
  );
  const [sourceCurrency, setSourceCurrency] = useState(DEFAULT_CRAWL_OPTIONS.sourceCurrency);
  // Kept as text, not a number: the meaningful states are "empty" (publish the
  // shop's own prices) and "a rate", and a numeric field cannot represent the
  // first one without either a fake zero or a separate checkbox.
  const [fxRate, setFxRate] = useState("");
  const [fxTarget, setFxTarget] = useState(DEFAULT_CRAWL_OPTIONS.fxTarget);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function start(): Promise<void> {
    setBusy(true);
    setError(null);

    try {
      const response = await fetch("/api/crawl", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          shopUrl,
          platform,
          transport: "server",
          limit,
          imagesPerProduct,
          sourceCurrency,
          fxRate: fxRate.trim() === "" ? null : fxRate,
          fxTarget,
        }),
      });

      const payload = (await response.json()) as { jobId?: string; error?: string };

      if (!response.ok || payload.jobId === undefined) {
        setError(payload.error ?? "The crawl could not be started.");
        return;
      }

      // Straight to the run screen, which already streams the log.
      router.push(`/process/${payload.jobId}`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-5">
      <Panel
        title="Crawl a shop"
        icon="download"
        description="Read products from a store, then import them"
      >
        <div className="space-y-5">
          <FieldGroup title="Shop" description="What to read, and how much of it">
            <Field
              label="Shop address"
              htmlFor="shopUrl"
              hint="For example https://example.myshopify.com"
            >
              <Input
                id="shopUrl"
                value={shopUrl}
                onChange={(event) => setShopUrl(event.target.value)}
                placeholder="https://example.myshopify.com"
                autoFocus
              />
            </Field>

            <Field label="Platform" hint="Only Shopify is readable in this build.">
              <Segmented
                label="Platform"
                value={platform}
                onChange={setPlatform}
                options={CRAWL_PLATFORMS.map((name) => ({
                  value: name,
                  label: CRAWL_PLATFORM_LABELS[name],
                  disabled: name !== "shopify",
                  // With a single adapter, an "auto" detector could only ever
                  // answer "shopify" — an automatic answer that is really a
                  // constant is worse than a question. See lib/crawl-options.ts.
                  hint: name === "shopify" ? undefined : "Not in this build yet",
                }))}
              />
            </Field>

            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Stop after" htmlFor="limit" hint="However many products, at most.">
                <Input
                  id="limit"
                  type="number"
                  min={1}
                  max={10_000}
                  value={limit}
                  onChange={(event) => setLimit(Number(event.target.value))}
                  className="tnum"
                />
              </Field>

              <Field
                label="Images per product"
                htmlFor="imagesPerProduct"
                hint="The rest are left behind."
              >
                <Input
                  id="imagesPerProduct"
                  type="number"
                  min={0}
                  max={50}
                  value={imagesPerProduct}
                  onChange={(event) => setImagesPerProduct(Number(event.target.value))}
                  className="tnum"
                />
              </Field>
            </div>
          </FieldGroup>

          <FieldGroup
            title="Currency"
            description="Decides how many decimals a price has, and whether it is converted"
          >
            <div className="grid gap-4 sm:grid-cols-3">
              <Field
                label="Shop currency"
                htmlFor="sourceCurrency"
                hint="VND and JPY have no decimals."
              >
                <Input
                  id="sourceCurrency"
                  value={sourceCurrency}
                  onChange={(event) => setSourceCurrency(event.target.value.toUpperCase())}
                  maxLength={3}
                  className="uppercase"
                />
              </Field>

              <Field
                label="Exchange rate"
                htmlFor="fxRate"
                optional
                hint="Leave empty to publish the shop's own numbers. Nothing is looked up here: the rate you type is the rate that is used, and it is recorded on the run."
              >
                <Input
                  id="fxRate"
                  value={fxRate}
                  onChange={(event) => setFxRate(event.target.value)}
                  inputMode="decimal"
                  placeholder="1.00"
                />
              </Field>

              <Field label="Convert to" htmlFor="fxTarget" optional hint="A label for the log only.">
                <Input
                  id="fxTarget"
                  value={fxTarget}
                  onChange={(event) => setFxTarget(event.target.value.toUpperCase())}
                  maxLength={3}
                  className="uppercase"
                />
              </Field>
            </div>
          </FieldGroup>

          {error === null ? null : (
            <Alert tone="bad" title="Could not start">
              <p>{error}</p>
            </Alert>
          )}

          <div className="flex justify-end">
            <Button
              variant="primary"
              icon="download"
              loading={busy}
              disabled={shopUrl.trim() === ""}
              onClick={() => void start()}
            >
              Start crawl
            </Button>
          </div>
        </div>
      </Panel>
    </div>
  );
}
