import type { ModelInfo } from "../providers/types";
import type { CatalogueFreshness } from "../providers/models";

/**
 * Honest catalogue cost/context presentation rules. Unit prices and context limits come from the
 * provider catalogue with their provenance; a missing or unusable value stays unknown, never zero
 * or free. Totals are intentionally absent: any total estimate is blocked on the unresolved request
 * size decision (T003). No ceiling, budget or request rejection lives here.
 */

export type UnitPriceField = "input" | "output" | "cached-input";

export interface UnitPriceView {
  field: UnitPriceField;
  /** Sentence-case label for the interface. */
  label: string;
  state: "known" | "unknown";
  /** Null when unknown. Zero is a known published price, never a stand-in for unknown. */
  valuePerMillionUsd: number | null;
  text: string;
  note: string;
}

const PRICE_FIELDS: Array<{
  field: UnitPriceField;
  label: string;
  read: (model: ModelInfo) => number | null | undefined;
}> = [
  { field: "input", label: "Input", read: (model) => model.inputPricePerMillion },
  { field: "output", label: "Output", read: (model) => model.outputPricePerMillion },
  { field: "cached-input", label: "Cached input", read: (model) => model.cachedInputPricePerMillion }
];

function usablePrice(value: number | null | undefined): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
  return Math.round(value * 1_000_000) / 1_000_000;
}

function formatUsdPerMillion(value: number): string {
  return `USD ${value} per million tokens`;
}

export function unitPriceViews(model: ModelInfo): UnitPriceView[] {
  return PRICE_FIELDS.map(({ field, label, read }) => {
    const price = usablePrice(read(model));
    if (price === null) {
      return {
        field,
        label,
        state: "unknown",
        valuePerMillionUsd: null,
        text: "Unknown",
        note: "The provider does not publish this price."
      } as const;
    }
    return {
      field,
      label,
      state: "known",
      valuePerMillionUsd: price,
      text: formatUsdPerMillion(price),
      note: "Published in the provider catalogue, in USD per million tokens."
    } as const;
  });
}

export interface ContextView {
  state: "known" | "unknown";
  tokens: number | null;
  text: string;
  note: string;
  /** Actual request fit stays unknown until a tested estimator provides the request size (T003). */
  fit: "unknown";
  fitNote: string;
}

function groupTokens(value: number): string {
  return Math.floor(value)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** Twin wording lives in `unavailableReason` (`providers/models.ts`); both tests pin the sentence. */
export const UNKNOWN_CONTEXT_NOTE = "This provider does not report the model's context size.";

export interface CatalogueAgeSource {
  fetchedAt: string | null;
  freshness: CatalogueFreshness;
}

/**
 * One honest freshness line per provider catalogue, from the evaluation source. A stale catalogue
 * is labelled with its age; a missing or unparseable timestamp is unknown, never guessed.
 */
export function catalogueAgeLine(source: CatalogueAgeSource, now: number = Date.now()): string {
  const checked = source.fetchedAt === null ? NaN : Date.parse(source.fetchedAt);
  const staleSuffix = source.freshness === "stale" ? " This catalogue may be out of date." : "";
  if (Number.isNaN(checked) || checked > now) return "Check time unknown.";
  const ageMs = now - checked;
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (ageMs < minute) return `Checked just now.${staleSuffix ? ` ${staleSuffix.trim()}` : ""}`;
  const amount = (whole: number, unit: string): string =>
    `Checked ${whole} ${unit}${whole === 1 ? "" : "s"} ago.${staleSuffix}`;
  if (ageMs < hour) return amount(Math.floor(ageMs / minute), "minute");
  if (ageMs < day) return amount(Math.floor(ageMs / hour), "hour");
  return amount(Math.floor(ageMs / day), "day");
}

export function contextView(model: Pick<ModelInfo, "contextLength">): ContextView {
  const tokens = model.contextLength;
  if (typeof tokens === "number" && Number.isFinite(tokens) && tokens > 0) {
    return {
      state: "known",
      tokens: Math.floor(tokens),
      text: `${groupTokens(tokens)} tokens (catalogue)`,
      note: "Catalogue context limit. It does not say whether a particular request fits.",
      fit: "unknown",
      fitNote: "Request fit is unknown. No tested estimator provides the request size."
    };
  }
  return {
    state: "unknown",
    tokens: null,
    text: "Unknown",
    note: UNKNOWN_CONTEXT_NOTE,
    fit: "unknown",
    fitNote: "Request fit is unknown. No tested estimator provides the request size."
  };
}
