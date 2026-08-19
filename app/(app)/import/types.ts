import type { PreviewMeta, RowEdit } from "@/lib/preview";
import type { Estimate } from "@/lib/stats";
import type { KnownDialect } from "@/lib/sources/csv";

/** Types shared between the steps of the import wizard. */

export interface TermOption {
  term_id: number;
  name: string;
  slug: string;
  count: number;
  depth: number;
  path: string;
}

export interface TermsState {
  status: "idle" | "loading" | "ready" | "error";
  categories: TermOption[];
  tags: TermOption[];
  error: string | null;
}

export const EMPTY_TERMS: TermsState = {
  status: "idle",
  categories: [],
  tags: [],
  error: null,
};

export interface PreviewState {
  meta: PreviewMeta;
  estimate: Estimate;
}

export type { PreviewMeta, RowEdit, Estimate, KnownDialect };
