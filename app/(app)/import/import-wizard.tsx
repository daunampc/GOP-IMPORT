"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { StoreHealthPill } from "@/components/domain/store-health";
import { useJobs } from "@/components/shell/jobs-provider";
import {
  Alert,
  Badge,
  Button,
  ButtonLink,
  Card,
  CardBody,
  Checkbox,
  EmptyState,
  ErrorState,
  FileDropzone,
  Icon,
  Panel,
  cn,
  useToast,
  type ComboboxOption,
} from "@/components/ui";
import { DEFAULT_IMPORT_OPTIONS, type ImportOptions } from "@/lib/import-options";
import type { Preset } from "@/lib/presets";
import type { PreviewMeta, PreviewRow, RowEdit } from "@/lib/preview";
import type { AppSettings } from "@/lib/settings";
/*
 * From `lib/sources/csv-dialect`, NOT `lib/sources/csv`.
 *
 * The dialect module imports nothing at all; `csv.ts` carries papaparse and every
 * parser, none of which the browser needs to identify a file from its header line.
 */
import {
  DIALECT_META,
  DIALECT_ORDER,
  detectDialect,
  guessColumnMap,
  parseHeaderLine,
  type CsvDialect,
  type KnownDialect,
} from "@/lib/sources/csv-dialect";
import type { Estimate } from "@/lib/stats";
import { supportsImageUpload } from "@/lib/plugin-version";
import { storeLabel } from "@/lib/store-links";
import type { PublicStore } from "@/lib/stores";

import { ColumnMapper } from "./column-mapper";
import { OptionsStep, termsToOptions } from "./options-step";
import { ProductDrawer } from "./product-drawer";
import { ReviewStep } from "./review-step";
import type { ExistingAnswer } from "./existing-check";
import { EMPTY_TERMS, type TermsState } from "./types";

/**
 * The multi-step import wizard.
 *
 * Four steps, ordered by what depends on what rather than by taste:
 *
 *  1. File    — the columns to map are not known until a file is chosen.
 *  2. Sites   — chosen before options, because step 3's category suggestions
 *               come from the first selected site.
 *  3. Options.
 *  4. Preview and run.
 *
 * The preview is built ONCE on the server and stored in Postgres; step 4 only
 * points at its id. That is what makes pushing one batch to five sites a single
 * file read, and what makes the preview literally what gets published.
 */

const STEPS = [
  { key: "source", label: "Source file", icon: "file" },
  { key: "stores", label: "Target sites", icon: "store" },
  { key: "options", label: "Options", icon: "settings" },
  { key: "review", label: "Preview and run", icon: "play" },
] as const;

type StepKey = (typeof STEPS)[number]["key"];

export function ImportWizard({
  stores,
  presets: initialPresets,
  settings,
  s3Configured,
}: {
  stores: PublicStore[];
  presets: Preset[];
  settings: AppSettings;
  s3Configured: boolean;
}) {
  const router = useRouter();
  const toast = useToast();
  const { refresh } = useJobs();

  const [step, setStep] = useState<StepKey>("source");
  const [presets, setPresets] = useState(initialPresets);

  const [options, setOptions] = useState<ImportOptions>(() => ({
    ...DEFAULT_IMPORT_OPTIONS,
    threads: settings.defaultThreads,
    batchSize: settings.defaultBatchSize,
    mode: settings.defaultMode,
    // A default of "s3" saved before the bucket was removed would otherwise
    // start every run on a mode that cannot work.
    imageMode:
      settings.defaultImageMode === "s3" && !s3Configured ? "keep_remote" : settings.defaultImageMode,
    // Seeded from the account's setting so the run CARRIES the currency it was
    // reviewed under. Stored on the run rather than read back from settings at
    // display time, otherwise changing the account setting would silently
    // relabel every price in the history.
    displayCurrency: settings.displayCurrency,
    storeId: "",
  }));

  const [storeIds, setStoreIds] = useState<string[]>([]);
  const [file, setFile] = useState<File | null>(null);

  /**
   * The chosen format, or `"auto"` to let the server decide from the columns.
   *
   * `"auto"` IS THE DEFAULT AND THIS MATTERS. It used to be `useState("shopify")`
   * — the type had no value meaning "work it out", so the state was forced to name
   * a format and the first one won. Every preview then sent `dialect: shopify`,
   * which meant `detectDialect()` never ran in practice and a perfectly valid
   * WooCommerce file was read by the Shopify parser and reported 24 errors about a
   * missing Handle column.
   */
  const [dialect, setDialect] = useState<KnownDialect | "auto">("auto");
  /** What the columns look like, decided in the browser the moment a file is chosen. */
  const [detected, setDetected] = useState<CsvDialect | null>(null);
  const [columns, setColumns] = useState<string[]>([]);
  const [columnMap, setColumnMap] = useState<Record<string, string>>({});
  const [signature, setSignature] = useState<string | null>(null);
  const [mapSavedAt, setMapSavedAt] = useState<string | null>(null);
  const [rememberMap, setRememberMap] = useState(true);
  const [showMapper, setShowMapper] = useState(false);

  const [termsData, setTermsData] = useState<{
    storeId: string;
    categories: TermsState["categories"];
    tags: TermsState["tags"];
    error: string | null;
  } | null>(null);

  const [preview, setPreview] = useState<PreviewMeta | null>(null);
  const [estimate, setEstimate] = useState<Estimate | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);

  const [dropped, setDropped] = useState<Set<number>>(new Set());
  const [edits, setEdits] = useState<Record<string, RowEdit>>({});

  /**
   * What each selected site already has, from `/api/import/exists`.
   *
   * Held here rather than inside the review step so that stepping back to change
   * an option and returning does not silently keep a stale answer — every reset
   * below clears it, for the same reason the preview itself is thrown away: an
   * answer about a different set of rows is worse than no answer.
   */
  const [existing, setExisting] = useState<Record<string, ExistingAnswer>>({});
  const [openRow, setOpenRow] = useState<PreviewRow | null>(null);

  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);

  const selectedStores = useMemo(
    () => stores.filter((store) => storeIds.includes(store.id)),
    [stores, storeIds],
  );

  /*
   * Selected sites whose plugin cannot accept image bytes.
   *
   * "Copy into the site's media library" needs 3.9.0, which is the build that took
   * image downloading off the site. The worker refuses such a run outright, so
   * showing it here is not belt-and-braces — it is the difference between finding
   * out now and finding out after pressing Start. A run fans out to every selected
   * site, so ONE old site is enough to matter.
   */
  const sitesWithoutImageUpload = useMemo(
    () => selectedStores.filter((store) => !supportsImageUpload(store.pluginVersion)),
    [selectedStores],
  );

  /**
   * Work out what a freshly chosen file is, without uploading it.
   *
   * Reads the first 64KB — enough for any header line — takes the column names and
   * asks `detectDialect`. Costs one slice of a local file and no network at all,
   * which is why it can run on selection rather than being deferred to the preview.
   *
   * The 64KB is decoded as UTF-8 because the encoding is not chosen until the
   * Options step. That is safe for the DECISION — `detectDialect` only compares
   * ASCII column names, which survive windows-1258 and latin1 unchanged — but the
   * column LIST shown for mapping can carry mangled accents until the real parse
   * happens with the chosen encoding. The mapper says so rather than pretending.
   */
  const identify = useCallback(async (next: File | null) => {
    if (next === null) {
      return;
    }

    try {
      const head = await next.slice(0, 65_536).text();
      const headers = parseHeaderLine(head);

      if (headers.length === 0) {
        return;
      }

      const guess = detectDialect(headers);

      setColumns(headers);
      setDetected(guess);

      /*
       * An unrecognised file goes straight to `custom` with a guessed mapping, and
       * the mapper opens. This is the request: read any CSV and map the columns in,
       * without a failed preview first. A guess that is wrong costs a click; no
       * guess at all costs the operator the whole job of describing their file.
       */
      if (guess === "unknown") {
        setDialect("custom");
        setColumnMap(guessColumnMap("custom", headers));
        setShowMapper(true);
      }
    } catch {
      // Unreadable slice: leave it to the server's own parse to report properly.
    }
  }, []);

  /** Anything that changes the data makes the existing preview worthless. */
  const invalidatePreview = useCallback(() => {
    setPreview(null);
    setEstimate(null);
    setDropped(new Set());
    setEdits({});
    setExisting({});
    setPreviewError(null);
  }, []);

  function set<K extends keyof ImportOptions>(key: K, value: ImportOptions[K]) {
    setOptions((current) => ({ ...current, [key]: value }));
    invalidatePreview();
  }

  // ------------------------------------------------------------ Taxonomy
  // Category and tag suggestions come from the FIRST selected site. Five sites
  // can have five different trees; taking the first one is a simple rule stated
  // plainly, whereas merging five trees would suggest more wrong than right.
  const termsStoreId = storeIds[0];

  useEffect(() => {
    if (termsStoreId === undefined) {
      return;
    }

    let cancelled = false;

    void (async () => {
      try {
        const [categories, tags] = await Promise.all([
          fetch(`/api/stores/${termsStoreId}/terms?taxonomy=product_cat`),
          fetch(`/api/stores/${termsStoreId}/terms?taxonomy=product_tag`),
        ]);

        const categoryPayload = (await categories.json()) as {
          tree?: TermsState["categories"];
          error?: string;
        };
        const tagPayload = (await tags.json()) as {
          tree?: TermsState["tags"];
          error?: string;
        };

        if (cancelled) {
          return;
        }

        setTermsData({
          storeId: termsStoreId,
          categories: categoryPayload.tree ?? [],
          tags: tagPayload.tree ?? [],
          error:
            !categories.ok || !tags.ok
              ? (categoryPayload.error ?? tagPayload.error ?? "Could not read the site's taxonomy.")
              : null,
        });
      } catch (caught) {
        if (!cancelled) {
          setTermsData({
            storeId: termsStoreId,
            categories: [],
            tags: [],
            error: caught instanceof Error ? caught.message : String(caught),
          });
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [termsStoreId]);

  // "Loading" is derived from which site the data in hand belongs to, rather
  // than kept as a second piece of state to keep in sync — switching sites is
  // correct immediately, with no frame showing the previous site's categories.
  const terms = useMemo<TermsState>(() => {
    if (termsStoreId === undefined) {
      return EMPTY_TERMS;
    }
    if (termsData === null || termsData.storeId !== termsStoreId) {
      return { ...EMPTY_TERMS, status: "loading" };
    }
    if (termsData.error !== null) {
      return { status: "error", categories: [], tags: [], error: termsData.error };
    }
    return {
      status: "ready",
      categories: termsData.categories,
      tags: termsData.tags,
      error: null,
    };
  }, [termsStoreId, termsData]);

  // ---------------------------------------------------- Remembered mapping
  const loadedSignature = useRef<string | null>(null);

  useEffect(() => {
    if (signature === null || loadedSignature.current === signature) {
      return;
    }
    loadedSignature.current = signature;

    void (async () => {
      try {
        const response = await fetch(
          `/api/import/csv-map?signature=${encodeURIComponent(signature)}`,
        );
        const payload = (await response.json()) as {
          map: { dialect: KnownDialect; columnMap: Record<string, string>; savedAt: string } | null;
        };

        if (payload.map) {
          setDialect(payload.map.dialect);
          setColumnMap(payload.map.columnMap);
          setMapSavedAt(payload.map.savedAt);
          toast.info(
            "Reapplied a saved column mapping",
            "This file has the same column set as one you mapped before.",
          );
        }
      } catch {
        // No saved mapping means auto-detection, which is the normal path —
        // nothing worth interrupting anyone over.
      }
    })();
  }, [signature, toast]);

  // -------------------------------------------------------------- Preview
  const runPreview = useCallback(async () => {
    setPreviewing(true);
    setPreviewError(null);

    try {
      if (!file) {
        setPreviewError("No CSV file chosen.");
        return;
      }

      const form = new FormData();
      form.set("options", JSON.stringify({ ...options, storeId: storeIds[0] ?? "" }));
      form.set("file", file);
      // Only send it when the operator chose one. Sending "auto" — or worse, a
      // default — is what stopped detection from ever running.
      if (dialect !== "auto") {
        form.set("dialect", dialect);
      }
      if (Object.keys(columnMap).length > 0) {
        form.set("columnMap", JSON.stringify(columnMap));
      }

      const response = await fetch("/api/import/preview", { method: "POST", body: form });
      const payload = (await response.json()) as {
        preview?: PreviewMeta;
        estimate?: Estimate;
        error?: string;
        columns?: string[];
      };

      if (!response.ok || !payload.preview || !payload.estimate) {
        setPreviewError(payload.error ?? "Could not read the file.");
        // A format-detection failure opens the mapper with the real column list
        // rather than leaving someone to guess.
        if (payload.columns && payload.columns.length > 0) {
          setColumns(payload.columns);
          setShowMapper(true);
        }
        return;
      }

      setPreview(payload.preview);
      setEstimate(payload.estimate);
      setColumns(payload.preview.columns);
      setSignature(payload.preview.signature);
      setDropped(new Set());
      setEdits({});
      // A fresh preview is a fresh set of rows, so any earlier answer about what
      // the site already had is about a different question now.
      setExisting({});
      setStep("review");

      if (rememberMap && payload.preview.signature && Object.keys(columnMap).length > 0) {
        void fetch("/api/import/csv-map", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            signature: payload.preview.signature,
            dialect: dialect === "auto" ? payload.preview.dialect : dialect,
            columnMap,
          }),
        });
      }
    } catch (caught) {
      setPreviewError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setPreviewing(false);
    }
  }, [options, storeIds, file, dialect, columnMap, rememberMap]);

  // ------------------------------------------------------------------ Run
  /**
   * Start now, or at a chosen time.
   *
   * `scheduledFor` is only sent when there is one — the route treats its absence
   * as "now", so an immediate run takes exactly the path it always did.
   */
  /**
   * Start, schedule, or set up a series — §6 C2.
   *
   * A repeat goes to a DIFFERENT route, and that is the honest shape rather than a
   * flag on the import: a series is not a run, it is a thing that makes runs. It
   * also cannot be a multi-site press — one series belongs to one site, exactly as
   * one run does — so it takes the first selected site and the button says so.
   */
  async function start(scheduledFor: string | null, everyMinutes?: number) {
    if (preview === null) {
      return;
    }

    if (everyMinutes !== undefined) {
      return startSeries(everyMinutes, scheduledFor);
    }

    setStarting(true);
    setStartError(null);

    try {
      const response = await fetch("/api/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          previewId: preview.id,
          storeIds,
          changes: { dropped: [...dropped], edits },
          ...(scheduledFor === null ? {} : { scheduledFor }),
        }),
      });

      const payload = (await response.json()) as {
        jobs?: Array<{ id: string }>;
        error?: string;
      };

      if (!response.ok || !payload.jobs) {
        setStartError(payload.error ?? "Unknown error.");
        return;
      }

      await refresh();

      const count = payload.jobs.length;

      toast.success(
        scheduledFor === null
          ? `Queued ${count} run${count === 1 ? "" : "s"}`
          : `Scheduled ${count} run${count === 1 ? "" : "s"}`,
        scheduledFor === null
          ? "Close the tab if you like — the worker carries on without it."
          : // Worth saying explicitly: the natural worry about scheduling is that
            // the preview expires in an hour, and the products are staged now.
            "The products are staged now, so this does not depend on the preview or on this tab. " +
            "It will run whether or not anyone is here.",
      );

      // One site goes straight to its detail screen; several sites are only
      // legible as a list.
      router.push(count === 1 ? `/process/${payload.jobs[0].id}` : "/process");
    } catch (caught) {
      setStartError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setStarting(false);
    }
  }

  async function startSeries(everyMinutes: number, firstRunAt: string | null) {
    if (preview === null) {
      return;
    }

    setStarting(true);
    setStartError(null);

    try {
      const response = await fetch("/api/schedules", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          previewId: preview.id,
          storeId: storeIds[0],
          everyMinutes,
          ...(firstRunAt === null ? {} : { firstRunAt }),
        }),
      });

      const payload = (await response.json()) as {
        schedule?: { id: string };
        first?: { id: string };
        error?: string;
      };

      if (!response.ok || !payload.schedule) {
        setStartError(payload.error ?? "Unknown error.");
        return;
      }

      await refresh();

      toast.success(
        "Repeating run set up",
        "The products are staged with the series, so it does not depend on this preview or this " +
          "tab. It publishes the same data every time — it does not re-read the file.",
      );

      router.push("/process");
    } catch (caught) {
      setStartError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setStarting(false);
    }
  }

  // -------------------------------------------------------------- Preset
  async function savePreset(name: string) {
    const { storeId: _ignored, ...rest } = options;

    const response = await fetch("/api/presets", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, options: rest }),
    });

    const payload = (await response.json()) as { preset?: Preset; error?: string };

    if (!response.ok || !payload.preset) {
      toast.error("Could not save the preset", payload.error);
      return;
    }

    setPresets((current) => [
      ...current.filter((preset) => preset.id !== payload.preset?.id),
      payload.preset as Preset,
    ]);
    toast.success(`Saved the preset “${payload.preset.name}”`);
  }

  async function deletePreset(preset: Preset) {
    const response = await fetch(`/api/presets/${preset.id}`, { method: "DELETE" });
    if (response.ok) {
      setPresets((current) => current.filter((entry) => entry.id !== preset.id));
      toast.success(`Deleted the preset “${preset.name}”`);
    }
  }

  function applyPreset(preset: Preset) {
    // A preset carries every option EXCEPT the site, so merge it over the
    // current state rather than replacing it — replacing would drop storeId
    // and every field a future release adds.
    setOptions((current) => ({
      ...current,
      ...(preset.options as Partial<ImportOptions>),
      storeId: current.storeId,
    }));
    invalidatePreview();
    toast.info(`Applied the preset “${preset.name}”`);
  }

  // -------------------------------------------------------- Step readiness
  const sourceReady = file !== null;
  const storesReady = storeIds.length > 0;

  const canGo: Record<StepKey, boolean> = {
    source: true,
    stores: sourceReady,
    options: sourceReady && storesReady,
    review: sourceReady && storesReady && preview !== null,
  };

  const categoryOptions: ComboboxOption[] = useMemo(
    () => termsToOptions(terms.categories),
    [terms.categories],
  );
  const tagOptions: ComboboxOption[] = useMemo(() => termsToOptions(terms.tags), [terms.tags]);

  if (stores.length === 0) {
    return (
      <Panel title="Import" icon="upload">
        <EmptyState
          icon="store"
          title="No sites to publish to yet"
          description="Run setup.php on the site, or open GOP_IMPORT → Connection in wp-admin to get its API key and secret, then add the site here."
          action={
            <ButtonLink href="/stores" variant="primary" icon="plus">
              Add a site
            </ButtonLink>
          }
        />
      </Panel>
    );
  }

  return (
    <div className="space-y-5">
      <StepBar current={step} canGo={canGo} onGo={setStep} />

      {step === "source" ? (
        <SourceStep
          file={file}
          onFile={(next) => {
            setFile(next);
            setColumns([]);
            setSignature(null);
            setColumnMap({});
            setShowMapper(false);
            setDetected(null);
            setDialect("auto");
            invalidatePreview();
            // Identify the file NOW, in the browser, from its header line alone —
            // no upload and no full parse. This is what removes the old
            // preview-fail-then-come-back-to-step-one loop.
            void identify(next);
          }}
          columns={columns}
          showMapper={showMapper}
          onShowMapper={setShowMapper}
          dialect={dialect}
          detected={detected}
          onDialect={(next) => {
            setDialect(next);
            invalidatePreview();

            /*
             * Choosing Custom by hand gets the same head start as falling into it
             * automatically: a guessed mapping and the mapper already open. Landing
             * on twenty-one empty dropdowns is how somebody decides this feature is
             * not worth it.
             *
             * Only when nothing has been mapped yet — re-picking Custom must not
             * throw away work already done by hand.
             */
            if (next === "custom" && columns.length > 0 && Object.keys(columnMap).length === 0) {
              setColumnMap(guessColumnMap("custom", columns));
              setShowMapper(true);
            }
          }}
          columnMap={columnMap}
          onColumnMap={(next) => {
            setColumnMap(next);
            invalidatePreview();
          }}
          rememberMap={rememberMap}
          onRememberMap={setRememberMap}
          mapSavedAt={mapSavedAt}
          onNext={() => setStep("stores")}
          canNext={sourceReady}
        />
      ) : null}

      {step === "stores" ? (
        <StoresStep
          stores={stores}
          selected={storeIds}
          onChange={(next) => {
            setStoreIds(next);
            setOptions((current) => ({ ...current, storeId: next[0] ?? "" }));
            invalidatePreview();
          }}
          onBack={() => setStep("source")}
          onNext={() => setStep("options")}
        />
      ) : null}

      {step === "options" ? (
        <>
          <OptionsStep
            options={options}
            onChange={set}
            terms={terms}
            presets={presets}
            s3Configured={s3Configured}
            sitesWithoutImageUpload={sitesWithoutImageUpload.map((store) => ({
              id: store.id,
              label: storeLabel(store),
              pluginVersion: store.pluginVersion,
            }))}
            onSavePreset={savePreset}
            onApplyPreset={applyPreset}
            onDeletePreset={deletePreset}
            disabled={previewing}
          />

          {previewError ? (
            <ErrorState
              title="Could not read the file"
              message={previewError}
              hint="If the format was detected wrongly, go back to Source file and open the column mapper."
              onRetry={() => void runPreview()}
              extra={
                <Button
                  variant="secondary"
                  size="sm"
                  icon="link"
                  onClick={() => {
                    setShowMapper(true);
                    setStep("source");
                  }}
                >
                  Open the column mapper
                </Button>
              }
            />
          ) : null}

          <div className="flex flex-wrap items-center justify-between gap-3">
            <Button variant="ghost" icon="arrow-left" onClick={() => setStep("stores")}>
              Back to sites
            </Button>
            <Button
              variant="primary"
              size="lg"
              iconAfter="arrow-right"
              loading={previewing}
              onClick={() => void runPreview()}
            >
              Read the file and preview
            </Button>
          </div>
        </>
      ) : null}

      {step === "review" && preview && estimate ? (
        <>
          <ReviewStep
            preview={preview}
            estimate={estimate}
            stores={selectedStores}
            dropped={dropped}
            edits={edits}
            onOpenRow={setOpenRow}
            onDrop={(index, isDropped) =>
              setDropped((current) => {
                const next = new Set(current);
                if (isDropped) {
                  next.add(index);
                } else {
                  next.delete(index);
                }
                return next;
              })
            }
            onStart={(scheduledFor, everyMinutes) => void start(scheduledFor, everyMinutes)}
            starting={starting}
            startError={startError}
            // Carried on the run's own options, seeded from the account setting
            // and overridable for this run. Display only — see `formatMoney`.
            currency={options.displayCurrency}
            existing={existing}
            onExisting={setExisting}
          />

          <div className="flex flex-wrap items-center gap-3">
            <Button variant="ghost" icon="arrow-left" onClick={() => setStep("options")}>
              Change options
            </Button>
            <Button
              variant="secondary"
              icon="refresh"
              loading={previewing}
              onClick={() => void runPreview()}
            >
              Read the file again
            </Button>
          </div>

          {openRow ? (
            <ProductDrawer
              // Remounted per row: the loading state and the product data belong
              // to exactly one row, so there is nothing to clean up on a switch.
              key={openRow.index}
              previewId={preview.id}
              row={openRow}
              edit={edits[String(openRow.index)]}
              dropped={dropped.has(openRow.index)}
              categoryOptions={categoryOptions}
              tagOptions={tagOptions}
              currency={options.displayCurrency}
              onEditChange={(index, edit) =>
                setEdits((current) => {
                  const next = { ...current };
                  if (edit === undefined) {
                    delete next[String(index)];
                  } else {
                    next[String(index)] = edit;
                  }
                  return next;
                })
              }
              onDrop={(index, isDropped) =>
                setDropped((current) => {
                  const next = new Set(current);
                  if (isDropped) {
                    next.add(index);
                  } else {
                    next.delete(index);
                  }
                  return next;
                })
              }
              onClose={() => setOpenRow(null)}
            />
          ) : null}
        </>
      ) : null}
    </div>
  );
}

/* ========================================================================== */

function StepBar({
  current,
  canGo,
  onGo,
}: {
  current: StepKey;
  canGo: Record<StepKey, boolean>;
  onGo: (step: StepKey) => void;
}) {
  const currentIndex = STEPS.findIndex((step) => step.key === current);

  return (
    <ol className="scroll-frame flex items-center gap-1 rounded-lg border border-line bg-surface p-1.5">
      {STEPS.map((step, index) => {
        const active = step.key === current;
        const done = index < currentIndex;
        const reachable = canGo[step.key];

        return (
          <li key={step.key} className="flex min-w-0 flex-1 items-center gap-1">
            <button
              type="button"
              disabled={!reachable}
              aria-current={active ? "step" : undefined}
              onClick={() => onGo(step.key)}
              className={cn(
                "flex min-w-0 flex-1 items-center gap-2 rounded-md px-3 py-2 text-left transition-colors duration-fast disabled:cursor-not-allowed disabled:opacity-40",
                active
                  ? "bg-accent-soft text-accent-fg"
                  : "text-ink-muted hover:bg-surface-sunken hover:text-ink",
              )}
            >
              <span
                className={cn(
                  "grid size-6 shrink-0 place-items-center rounded-full text-2xs font-semibold",
                  active
                    ? "bg-accent text-on-accent"
                    : done
                      ? "bg-ok text-on-ok"
                      : "bg-surface-sunken text-ink-subtle",
                )}
              >
                {done ? <Icon name="check" className="size-3" /> : index + 1}
              </span>
              <span className="min-w-0">
                <span className="block truncate text-sm font-medium">{step.label}</span>
              </span>
            </button>

            {index < STEPS.length - 1 ? (
              <Icon name="chevron-right" className="size-3.5 shrink-0 text-ink-subtle" />
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}

/* ========================================================================== */

function SourceStep({
  file,
  onFile,
  columns,
  showMapper,
  onShowMapper,
  dialect,
  onDialect,
  detected,
  columnMap,
  onColumnMap,
  rememberMap,
  onRememberMap,
  mapSavedAt,
  onNext,
  canNext,
}: {
  file: File | null;
  onFile: (file: File | null) => void;
  columns: string[];
  showMapper: boolean;
  onShowMapper: (show: boolean) => void;
  dialect: KnownDialect | "auto";
  onDialect: (next: KnownDialect | "auto") => void;
  /** What the header line looked like. `unknown` means it could not be placed. */
  detected: CsvDialect | null;
  columnMap: Record<string, string>;
  onColumnMap: (next: Record<string, string>) => void;
  rememberMap: boolean;
  onRememberMap: (next: boolean) => void;
  mapSavedAt: string | null;
  onNext: () => void;
  canNext: boolean;
}) {
  return (
    <div className="space-y-5">
      <Panel
        title="Source file"
        icon="file"
        description="A product export in CSV form — Shopify, Shopbase or WooCommerce"
      >
        <div className="space-y-4">
          <FileDropzone file={file} onFile={onFile} hint="Drop a CSV here, or click to choose one" />

          {/*
            The format is chosen HERE, at step one, with the detected answer already
            selected. It used to be decided invisibly and wrongly: the wizard always
            claimed Shopify, so the only way to correct it was to run a preview, watch
            it fail, and come back — which is precisely the loop this replaces.
          */}
          {file !== null ? (
            <div className="space-y-3 border-t border-line pt-4">
              <FormatChooser
                dialect={dialect}
                onDialect={onDialect}
                detected={detected}
                columns={columns}
              />

              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-xs text-ink-subtle">
                  {columns.length > 0
                    ? `${columns.length} column(s) read from the file's first line.`
                    : "Reading the file's first line…"}
                </p>
                <Button
                  variant="secondary"
                  size="sm"
                  icon="link"
                  disabled={columns.length === 0}
                  onClick={() => onShowMapper(!showMapper)}
                >
                  {showMapper ? "Hide the column mapper" : "Map columns"}
                </Button>
              </div>
            </div>
          ) : null}
        </div>
      </Panel>

      {showMapper && columns.length > 0 ? (
        <Panel
          title="Column mapping"
          icon="link"
          description={`${columns.length} columns in the file`}
        >
          <ColumnMapper
            columns={columns}
            // The mapper needs a real format to show fields for. "auto" has no field
            // list, so an operator who opens the mapper without choosing is shown
            // the custom fields — the only set that fits any file.
            dialect={dialect === "auto" ? (detected === "unknown" || detected === null ? "custom" : detected) : dialect}
            onDialectChange={onDialect}
            columnMap={columnMap}
            onColumnMapChange={onColumnMap}
            remember={rememberMap}
            onRememberChange={onRememberMap}
            savedAt={mapSavedAt}
          />
        </Panel>
      ) : null}

      <div className="flex justify-end">
        <Button variant="primary" iconAfter="arrow-right" disabled={!canNext} onClick={onNext}>
          Choose target sites
        </Button>
      </div>
    </div>
  );
}

/* ========================================================================== */

function StoresStep({
  stores,
  selected,
  onChange,
  onBack,
  onNext,
}: {
  stores: PublicStore[];
  selected: string[];
  onChange: (next: string[]) => void;
  onBack: () => void;
  onNext: () => void;
}) {
  const broken = stores.filter((store) => store.lastCheckOk === false);

  return (
    <div className="space-y-5">
      <Panel
        title="Target sites"
        icon="store"
        description="Pick one or several — each site gets its own run"
        actions={
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="ghost"
              onClick={() => onChange(stores.map((store) => store.id))}
            >
              Select all
            </Button>
            <Button size="sm" variant="ghost" onClick={() => onChange([])}>
              Clear
            </Button>
          </div>
        }
      >
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {stores.map((store) => {
            const checked = selected.includes(store.id);

            return (
              <Card
                key={store.id}
                tone={checked ? "accent" : "default"}
                interactive={!checked}
                className={cn("transition-colors duration-fast", checked && "border-accent")}
              >
                <CardBody className="space-y-2">
                  <Checkbox
                    checked={checked}
                    onChange={(next) =>
                      onChange(
                        next
                          ? [...selected, store.id]
                          : selected.filter((id) => id !== store.id),
                      )
                    }
                    label={
                      <span className="block truncate font-medium">
                        {store.label || store.url}
                      </span>
                    }
                    description={<span className="block truncate">{store.url}</span>}
                  />

                  <div className="flex flex-wrap items-center gap-2 pl-7">
                    <StoreHealthPill store={store} expectedVersion={null} />
                    {store.pluginVersion ? (
                      <Badge tone="neutral">plugin {store.pluginVersion}</Badge>
                    ) : null}
                    {store.pin ? <Badge tone="neutral">Pin {store.pin}</Badge> : null}
                  </div>
                </CardBody>
              </Card>
            );
          })}
        </div>
      </Panel>

      {broken.some((store) => selected.includes(store.id)) ? (
        <Alert tone="warn" title="One of the selected sites is failing its connection check">
          The run will still queue, but the worker will report an error for every row when it calls
          that site. Check the connection on the Sites screen first.
        </Alert>
      ) : null}

      {selected.length > 1 ? (
        <Alert tone="info" title={`${selected.length} runs from a single file read`}>
          The same data, one run per site — cancel or resend each independently. Category
          suggestions on the next step come from the first site in the list.
        </Alert>
      ) : null}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <Button variant="ghost" icon="arrow-left" onClick={onBack}>
          Back to the source file
        </Button>
        <Button
          variant="primary"
          iconAfter="arrow-right"
          disabled={selected.length === 0}
          onClick={onNext}
        >
          Continue with {selected.length} site{selected.length === 1 ? "" : "s"}
        </Button>
      </div>
    </div>
  );
}

/**
 * Which format this file is, chosen at step one.
 *
 * Shows the detected answer as already-selected and says where it came from, so
 * the common case is one glance and no clicks — while every other format stays one
 * click away. The old arrangement had neither: the choice was invisible, always
 * wrong for WooCommerce files, and only correctable after a failed preview.
 *
 * "Not recognised" is stated rather than papered over. Guessing Shopify at that
 * point is what produced 24 errors about a missing Handle column on a file that
 * never had one.
 */
function FormatChooser({
  dialect,
  onDialect,
  detected,
  columns,
}: {
  dialect: KnownDialect | "auto";
  onDialect: (next: KnownDialect | "auto") => void;
  detected: CsvDialect | null;
  columns: string[];
}) {
  const unrecognised = detected === "unknown";
  // "auto" means "whatever was detected", so that is what to highlight.
  const effective = dialect === "auto" ? detected : dialect;

  return (
    <div className="space-y-2">
      <p className="text-2xs font-medium uppercase tracking-wide text-ink-subtle">File format</p>

      <div className="flex flex-wrap gap-2">
        {DIALECT_ORDER.map((option) => {
          const active = effective === option;
          const isDetected = detected === option;

          return (
            <button
              key={option}
              type="button"
              onClick={() => onDialect(option)}
              aria-pressed={active}
              className={cn(
                "flex min-w-0 flex-col items-start gap-0.5 rounded-md border px-3 py-2 text-left transition-colors duration-fast",
                // Hover also brightens the border, so the selected one needs more
                // than a border to be told apart — a ring and a tick, below.
                active
                  ? "border-accent-border bg-accent-soft ring-1 ring-accent-border"
                  : "border-line bg-surface hover:border-accent-border",
              )}
            >
              <span className="flex items-center gap-1.5">
                {active ? (
                  <Icon name="check" className="size-3.5 shrink-0 text-accent-fg" />
                ) : null}
                <span
                  className={cn(
                    "text-xs font-medium",
                    active ? "text-accent-fg" : "text-ink",
                  )}
                >
                  {DIALECT_META[option].label}
                </span>
                {isDetected ? <Badge tone="ok">detected</Badge> : null}
              </span>
              <span className="max-w-56 text-2xs text-ink-subtle">
                {DIALECT_META[option].hint}
              </span>
            </button>
          );
        })}
      </div>

      {unrecognised ? (
        <Alert tone="warn" title="These columns do not match any known export">
          <p>
            Nothing here recognises {columns.length} column(s) starting with{" "}
            <span className="font-mono text-2xs">{columns.slice(0, 4).join(", ")}</span>. That is not
            a problem — <strong>Custom</strong> has been selected and the columns matched up as far as
            their names allowed.
          </p>
          <p className="mt-1">
            Check the mapping below. Only <strong>Product name</strong> has to be filled in; anything
            else left blank is simply not imported.
          </p>
        </Alert>
      ) : null}

      {dialect !== "auto" && detected !== null && detected !== dialect && detected !== "unknown" ? (
        <Alert tone="info" title="You have overridden the detected format">
          The columns look like <strong>{DIALECT_META[detected].label}</strong>, but the file will be
          read as <strong>{DIALECT_META[dialect].label}</strong>. Your choice wins — this is only here
          so a mis-click does not become a confusing import.
        </Alert>
      ) : null}
    </div>
  );
}
