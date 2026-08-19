"use client";

import { useMemo, useState } from "react";

import {
  Alert,
  AlertList,
  Badge,
  Button,
  Checkbox,
  Code,
  Field,
  FieldGroup,
  Icon,
  Input,
  Modal,
  Panel,
  RadioGroup,
  Select,
  TagInput,
  type ComboboxOption,
} from "@/components/ui";
import {
  ENCODINGS,
  ENCODING_LABELS,
  IMAGE_MODES,
  IMAGE_MODE_LABELS,
  IMPORT_MODES,
  IMPORT_MODE_LABELS,
  SKU_TOKENS,
  WRITE_MODES,
  WRITE_MODE_DESCRIPTIONS,
  WRITE_MODE_LABELS,
  warningsFor,
  writesOverExisting,
  type ImportOptions,
} from "@/lib/import-options";
import { IMAGE_UPLOAD_VERSION } from "@/lib/plugin-version";
import { UPDATE_NEVER_WRITES } from "@/lib/product-update";
import { CURRENCIES } from "@/lib/format";
import type { Preset } from "@/lib/presets";

import type { TermsState } from "./types";

/**
 * The options step.
 *
 * Every option is grouped by what it affects, rather than laid out as an
 * undifferentiated grid of checkboxes. Two things here are not merely cosmetic:
 *
 *  - Category and Tag are read from the site's REAL taxonomy via
 *    `client.terms()`, with search, hierarchy, product counts, and a clear mark
 *    on which entries would be created rather than matched.
 *  - "Skip repeated SKUs" actually does something (see `lib/build-products.ts`).
 */
export function OptionsStep({
  options,
  onChange,
  terms,
  presets,
  s3Configured,
  sitesWithoutImageUpload,
  onSavePreset,
  onApplyPreset,
  onDeletePreset,
  disabled,
}: {
  options: ImportOptions;
  onChange: <K extends keyof ImportOptions>(key: K, value: ImportOptions[K]) => void;
  terms: TermsState;
  presets: Preset[];
  s3Configured: boolean;
  /**
   * Selected sites whose plugin is older than the build that accepts image bytes.
   *
   * Empty is the normal state. A non-empty list makes "Copy into the site's media
   * library" unselectable, because the worker refuses such a run outright rather
   * than publishing every product with its supplier's links.
   */
  sitesWithoutImageUpload: Array<{ id: string; label: string; pluginVersion: string | null }>;
  onSavePreset: (name: string) => Promise<void>;
  onApplyPreset: (preset: Preset) => void;
  onDeletePreset: (preset: Preset) => Promise<void>;
  disabled?: boolean;
}) {
  const warnings = useMemo(() => warningsFor(options), [options]);

  const imageUploadBlocked = sitesWithoutImageUpload.length > 0;

  const categoryOptions = useMemo(() => toOptions(terms.categories), [terms.categories]);
  const tagOptions = useMemo(() => toOptions(terms.tags), [terms.tags]);

  const [savingPreset, setSavingPreset] = useState(false);
  const [presetName, setPresetName] = useState("");
  const [presetBusy, setPresetBusy] = useState(false);

  const forcedCategories = splitList(options.forceCategory);
  const forcedTags = splitList(options.forceTag);

  return (
    <div className="space-y-5">
      {/* ----------------------------------------------------------- Presets */}
      <Panel
        title="Saved option sets"
        icon="save"
        description="Name a combination and reuse it next time"
        actions={
          <Button
            variant="secondary"
            size="sm"
            icon="plus"
            disabled={disabled}
            onClick={() => {
              setPresetName("");
              setSavingPreset(true);
            }}
          >
            Save these options
          </Button>
        }
      >
        {presets.length === 0 ? (
          <p className="text-xs text-ink-subtle">
            No presets yet. A preset does not carry the target site — the site is a per-run choice,
            while a preset is how the data gets handled.
          </p>
        ) : (
          <ul className="flex flex-wrap gap-2">
            {presets.map((preset) => (
              <li
                key={preset.id}
                className="inline-flex items-center gap-1 rounded-md border border-line bg-surface-sunken pr-1 pl-2.5"
              >
                <button
                  type="button"
                  disabled={disabled}
                  onClick={() => onApplyPreset(preset)}
                  className="py-1.5 text-xs font-medium text-ink transition-colors duration-fast hover:text-accent-fg"
                >
                  {preset.name}
                </button>
                <button
                  type="button"
                  aria-label={`Delete the preset ${preset.name}`}
                  disabled={disabled}
                  onClick={() => void onDeletePreset(preset)}
                  className="grid size-6 place-items-center rounded-sm text-ink-subtle transition-colors duration-fast hover:bg-surface hover:text-bad-fg"
                >
                  <Icon name="x" className="size-3" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      {/* --------------------------------------- What this run does to the site */}
      <Panel
        title="What this run does to the site"
        icon="refresh"
        description="Whether rows already on the site are left alone, updated, or the only ones touched"
      >
        <div className="space-y-4">
          <RadioGroup
            legend="Existing products"
            value={options.writeMode}
            disabled={disabled}
            onChange={(next) => onChange("writeMode", next)}
            options={WRITE_MODES.map((mode) => ({
              value: mode,
              label: WRITE_MODE_LABELS[mode],
              description: WRITE_MODE_DESCRIPTIONS[mode],
            }))}
          />

          {writesOverExisting(options.writeMode) ? (
            <Alert tone="warn" title="This run writes over products that are already on sale">
              <p>
                Rows matched by SKU are changed in place, keeping their product id, their reviews
                and their URL. Only the fields a row actually carries a value for are written — a
                blank cell is the file being silent, not an instruction to clear anything.
              </p>
              <p className="mt-2">
                The next step says how many rows are already on the site, before anything runs.
              </p>
              <ul className="mt-2 space-y-1">
                {UPDATE_NEVER_WRITES.map((entry) => (
                  <li key={entry.field} className="text-2xs text-ink-muted">
                    <strong className="text-ink">Never writes {entry.field.toLowerCase()}</strong> —{" "}
                    {entry.why}
                  </li>
                ))}
              </ul>
            </Alert>
          ) : null}
        </div>
      </Panel>

      {/* ------------------------------------------------------- Import mode */}
      <Panel title="Import mode" icon="zap">
        <RadioGroup
          legend="Import mode"
          value={options.mode}
          disabled={disabled}
          onChange={(next) => onChange("mode", next)}
          options={IMPORT_MODES.map((mode) => ({
            value: mode,
            label: IMPORT_MODE_LABELS[mode],
            description:
              mode === "standard"
                ? "Sends mode_import: full_data, so the plugin fills in WooCommerce's defaults (tax_status, backorders, manage_stock…)."
                : "Drops full_data: less meta, fewer INSERTs, and products without those fields.",
          }))}
        />
      </Panel>

      {/* ------------------------------------------------ Images and throughput */}
      <Panel title="Images and throughput" icon="image">
        <div className="grid gap-4 lg:grid-cols-3">
          <Field
            label="Image handling"
            htmlFor="imageMode"
            hint={
              options.imageMode === "keep_remote"
                ? "The plugin writes FIFU meta and downloads nothing. Fastest, but the images live or die with whoever hosts them."
                : options.imageMode === "upload_site"
                  ? "Pulls the images into the site's own uploads folder first, then creates the products with local URLs."
                  : "Copies the images into the configured bucket and publishes the bucket's public URLs."
            }
          >
            <Select
              id="imageMode"
              value={options.imageMode}
              disabled={disabled}
              onChange={(event) =>
                onChange("imageMode", event.target.value as ImportOptions["imageMode"])
              }
            >
              {IMAGE_MODES.map((mode) => (
                <option
                  key={mode}
                  value={mode}
                  disabled={
                    (mode === "s3" && !s3Configured) ||
                    (mode === "upload_site" && imageUploadBlocked)
                  }
                >
                  {IMAGE_MODE_LABELS[mode]}
                  {mode === "s3" && !s3Configured ? " — not configured" : ""}
                  {mode === "upload_site" && imageUploadBlocked ? " — needs a newer plugin" : ""}
                </option>
              ))}
            </Select>
          </Field>

          <Field
            label="Character encoding"
            htmlFor="encoding"
            hint="For files exported from a Vietnamese copy of Excel."
          >
            <Select
              id="encoding"
              value={options.encoding}
              disabled={disabled}
              onChange={(event) =>
                onChange("encoding", event.target.value as ImportOptions["encoding"])
              }
            >
              {ENCODINGS.map((encoding) => (
                <option key={encoding} value={encoding}>
                  {ENCODING_LABELS[encoding]}
                </option>
              ))}
            </Select>
          </Field>

          <div className="grid grid-cols-2 gap-3">
            <Field label="Parallel batches" htmlFor="threads" hint="Batches in flight at once">
              <Input
                id="threads"
                type="number"
                min={1}
                max={32}
                value={options.threads}
                disabled={disabled}
                onChange={(event) => onChange("threads", Number(event.target.value))}
                className="tnum"
              />
            </Field>

            <Field
              label="Products per batch"
              htmlFor="batchSize"
              hint="Capped at 50 by the plugin"
            >
              <Input
                id="batchSize"
                type="number"
                min={1}
                max={50}
                value={options.batchSize}
                disabled={disabled}
                onChange={(event) => onChange("batchSize", Number(event.target.value))}
                className="tnum"
              />
            </Field>

            {/*
              An override for THIS RUN, on top of the account setting. It affects
              only what is displayed — the preview, the review table and the
              results. Nothing here reaches the site: the plugin writes prices as
              plain numbers and each WooCommerce site renders them in its own
              currency, and stock WooCommerce has no per-product currency to set.
            */}
            <Field
              label="Show prices in"
              htmlFor="displayCurrency"
              hint="Display only — this does not change any site"
            >
              <Select
                id="displayCurrency"
                value={options.displayCurrency}
                disabled={disabled}
                onChange={(event) => onChange("displayCurrency", event.target.value)}
              >
                {CURRENCIES.map((currency) => (
                  <option key={currency.code} value={currency.code}>
                    {currency.label}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
        </div>

        {options.imageMode === "s3" && !s3Configured ? (
          <Alert tone="warn" title="No S3 bucket is configured">
            Fill in the bucket, region and keys on the Settings screen. Until then this run would
            fail on its first image.
          </Alert>
        ) : null}

        {imageUploadBlocked ? (
          <Alert
            tone="warn"
            title={`${sitesWithoutImageUpload.length} selected site(s) run a plugin too old to copy images`}
          >
            <p>
              Copying images into a site&rsquo;s media library needs plugin{" "}
              <strong>{IMAGE_UPLOAD_VERSION}</strong>. From that build this app downloads each image
              and sends the bytes to the site, instead of asking the site&rsquo;s own PHP to fetch
              them &mdash; which is what used to hold PHP processes open long enough to take a shop
              offline mid-import.
            </p>
            <ul className="mt-2 list-disc pl-5">
              {sitesWithoutImageUpload.map((site) => (
                <li key={site.id}>
                  {site.label} &mdash;{" "}
                  {site.pluginVersion === null || site.pluginVersion.trim() === ""
                    ? "version unknown, check the connection on the Sites screen"
                    : `plugin ${site.pluginVersion}`}
                </li>
              ))}
            </ul>
            <p className="mt-2">
              Update the plugin on those sites, or leave image handling on another mode.
            </p>
          </Alert>
        ) : null}
      </Panel>

      {/* --------------------------------------------------------- Data handling */}
      <Panel title="Data handling" icon="layers">
        <div className="grid gap-x-8 gap-y-4 md:grid-cols-2">
          <FieldGroup title="Products and variants">
            <div className="space-y-3">
              <Checkbox
                label="Flatten variants into one product"
                description="Drops every variation, takes the price of the cheapest one (the price shown on category pages), and folds the variation images into the gallery."
                checked={options.flattenVariants}
                disabled={disabled}
                onChange={(next) => onChange("flattenVariants", next)}
              />
              <Checkbox
                label="Make the first variant the default"
                description="Writes _default_attributes. Turns itself off once variants are flattened."
                checked={options.firstVariantAsDefault}
                disabled={disabled || options.flattenVariants}
                onChange={(next) => onChange("firstVariantAsDefault", next)}
              />
              <Checkbox
                label="Keep product-level attributes"
                description="Unticked, attributes at product level are dropped. Attributes on a variation are always kept — without them a variable product is broken."
                checked={options.keepProductAttributes}
                disabled={disabled}
                onChange={(next) => onChange("keepProductAttributes", next)}
              />
            </div>
          </FieldGroup>

          <FieldGroup title="Publishing and safety">
            <div className="space-y-3">
              <Checkbox
                label="Add a random suffix to the slug"
                description="Leave this on. The plugin writes straight to the database and so never runs wp_unique_post_slug(); two products with the same slug both exist and one is unreachable."
                checked={options.addRandomSuffixToSlug}
                disabled={disabled}
                onChange={(next) => onChange("addRandomSuffixToSlug", next)}
              />
              <Checkbox
                label="Skip repeated SKUs"
                description="Drops rows that repeat a SKU already seen further up the same file. The count appears in the preview."
                checked={options.skipRepeatedSku}
                disabled={disabled}
                onChange={(next) => onChange("skipRepeatedSku", next)}
              />
              <Checkbox
                label="Stop if the CSV has errors"
                description="Fails at the read step instead of publishing half a file and discovering the problem afterwards."
                checked={options.skipOnCsvError}
                disabled={disabled}
                onChange={(next) => onChange("skipOnCsvError", next)}
              />
            </div>
          </FieldGroup>
        </div>
      </Panel>

      {/* ------------------------------------------------------------ Auto SKU */}
      <Panel
        title="Generated SKUs"
        icon="key"
        description="For rows that arrive without one"
      >
        <div className="space-y-4">
          <Checkbox
            label="Generate a SKU when the row has none"
            description="Rows that already carry a SKU are left exactly as they are."
            checked={options.autoSku}
            disabled={disabled}
            onChange={(next) => onChange("autoSku", next)}
          />

          <Field
            label="Pattern"
            htmlFor="autoSkuPattern"
            hint="Nothing here comes from the clock or a random number: the same row of the same file always produces the same SKU, so re-running a file does not create a second product."
          >
            <Input
              id="autoSkuPattern"
              value={options.autoSkuPattern}
              disabled={disabled || !options.autoSku}
              placeholder="GOP-{seq}-{hash}"
              onChange={(event) => onChange("autoSkuPattern", event.target.value)}
            />
          </Field>

          <ul className="grid gap-1.5 text-xs text-ink-muted sm:grid-cols-2">
            {SKU_TOKENS.map((token) => (
              <li key={token.token} className="flex items-baseline gap-2">
                <Code>{token.token}</Code>
                <span>{token.meaning}</span>
              </li>
            ))}
          </ul>

          <p className="text-xs text-ink-subtle">
            Generated SKUs are marked in the preview table, so nothing is invented behind your back.
          </p>
        </div>
      </Panel>

      {/* ------------------------------------------------------ Category / Tag */}
      <Panel
        title="Force categories and tags"
        icon="tag"
        description="Replaces whatever the file said"
        actions={
          terms.status === "ready" ? (
            <Badge tone="ok" icon="check">
              {terms.categories.length} categories · {terms.tags.length} tags from the site
            </Badge>
          ) : terms.status === "loading" ? (
            <Badge tone="neutral" icon="refresh">
              Reading the site&rsquo;s taxonomy…
            </Badge>
          ) : terms.status === "error" ? (
            <Badge tone="warn" icon="alert-triangle">
              Taxonomy unavailable
            </Badge>
          ) : null
        }
      >
        <div className="space-y-4">
          {terms.status === "error" ? (
            <Alert tone="warn" title="Could not read the site's categories">
              <p>{terms.error}</p>
              <p className="mt-1">
                You can still type them, but without knowing which already exist — the plugin
                resolves terms by NAME, so one wrong capital letter quietly creates a second
                category.
              </p>
            </Alert>
          ) : null}

          <Field
            label="Force category"
            hint='Hierarchies use ">": "Clothing > T-shirts > Men". Leave empty to keep what the file said.'
          >
            <TagInput
              values={forcedCategories}
              suggestions={categoryOptions}
              loading={terms.status === "loading"}
              disabled={disabled}
              onChange={(next) => onChange("forceCategory", next.join(", "))}
              placeholder="Type to search the site's categories…"
            />
          </Field>

          <Field label="Force tag" hint="Leave empty to keep the tags from the file.">
            <TagInput
              values={forcedTags}
              suggestions={tagOptions}
              loading={terms.status === "loading"}
              disabled={disabled}
              onChange={(next) => onChange("forceTag", next.join(", "))}
              placeholder="Type to search the site's tags…"
            />
          </Field>
        </div>
      </Panel>

      {warnings.length > 0 ? (
        <Alert tone="warn" title={`${warnings.length} thing(s) worth checking about these options`}>
          <AlertList items={warnings} />
        </Alert>
      ) : null}

      <Modal
        open={savingPreset}
        onClose={() => setSavingPreset(false)}
        title="Save these options"
        description="An existing name is overwritten."
        size="sm"
        footer={
          <>
            <Button variant="ghost" onClick={() => setSavingPreset(false)} disabled={presetBusy}>
              Cancel
            </Button>
            <Button
              variant="primary"
              icon="save"
              loading={presetBusy}
              disabled={presetName.trim() === ""}
              onClick={async () => {
                setPresetBusy(true);
                try {
                  await onSavePreset(presetName.trim());
                  setSavingPreset(false);
                } finally {
                  setPresetBusy(false);
                }
              }}
            >
              Save preset
            </Button>
          </>
        }
      >
        <Field label="Preset name" htmlFor="preset-name" required>
          <Input
            id="preset-name"
            value={presetName}
            autoFocus
            placeholder="POD, original image links, 10 lanes"
            onChange={(event) => setPresetName(event.target.value)}
          />
        </Field>
      </Modal>
    </div>
  );
}

function toOptions(terms: TermsState["categories"]): ComboboxOption[] {
  return terms.map((term) => ({
    // The value sent to the plugin is the full hierarchical path, in the syntax
    // it understands — choosing "Men" under "T-shirts" has to produce
    // "Clothing > T-shirts > Men", not a bare "Men" that creates a new root.
    value: term.path,
    label: term.path,
    depth: term.depth,
    meta: `${term.count} products`,
  }));
}

function splitList(raw: string): string[] {
  return raw
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part !== "");
}

export { toOptions as termsToOptions };
