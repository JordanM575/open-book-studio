import { contributorWarning, isContributorModel } from "../providers/compatibility";
import type { ConnectionSummary, ModelInfo, ProviderId } from "../providers/types";
import { catalogueFreshness, unavailableReason, type Catalogue, type CatalogueFreshness } from "../providers/models";
import { browserAvailable, browserAvailabilityCopy, providerById } from "../providers/registry";
import type { TaskProfile } from "./profiles";
import { UNKNOWN_CONTEXT_NOTE } from "./presentation";

export type RoutingBuild = "desktop" | "web";

/** Worst first: unavailable beats excluded beats unknown beats eligible. */
export type CandidateStatus = "eligible" | "excluded" | "unknown" | "unavailable";

export interface CandidateFacts {
  contextLength: number | null;
  supportsTools: boolean | null;
  supportsImages: boolean | null;
  /** Null means unknown, never zero or free. Presentation stays with a later task. */
  inputPricePerMillion: number | null;
  outputPricePerMillion: number | null;
  cachedInputPricePerMillion: number | null;
  contributor: boolean;
}

export interface CandidateSource {
  fetchedAt: string | null;
  freshness: CatalogueFreshness;
}

export interface CandidateAssessment {
  provider: ProviderId;
  modelId: string;
  name: string;
  status: CandidateStatus;
  /** Plain-language reasons, worst first. Contributor consent stays a warning, never a verdict. */
  reasons: string[];
  facts: CandidateFacts;
  source: CandidateSource;
}

export interface PreviewEvaluation {
  profileId: string;
  /** Catalogue order is preserved. Candidates are never ranked, scored or ordered by price. */
  candidates: CandidateAssessment[];
}

export interface ProviderCatalogue {
  provider: ProviderId;
  catalogue: Catalogue;
}

export interface ExtraModelId {
  provider: ProviderId;
  id: string;
}

export interface RoutingInput {
  profile: TaskProfile;
  catalogues: ProviderCatalogue[];
  connections: ConnectionSummary[];
  build: RoutingBuild;
  /** Model ids worth assessing even when absent from the catalogue, such as a saved default. */
  extraModelIds?: ExtraModelId[];
  now?: number;
}

function buildAvailable(provider: ProviderId, build: RoutingBuild): boolean {
  if (build === "desktop") return true;
  return browserAvailable(providerById(provider).browserAccess);
}

function connectionUsable(connections: ConnectionSummary[], provider: ProviderId): boolean {
  return connections.some((connection) => connection.provider === provider && connection.planUsable !== false);
}

/** A provider the book connects to only through an unusable plan has no usable connection. */
function hasUnusablePlanOnly(connections: ConnectionSummary[], provider: ProviderId): boolean {
  const forProvider = connections.filter((connection) => connection.provider === provider);
  return forProvider.length > 0 && forProvider.every((connection) => connection.planUsable === false);
}

function assess(
  provider: ProviderId,
  model: ModelInfo | null,
  modelId: string,
  input: RoutingInput,
  fetchedAt: string | null,
  now: number
): CandidateAssessment {
  const requirements = input.profile.requirements;
  const reasons: string[] = [];
  let status: CandidateStatus = "eligible";
  const worsen = (next: CandidateStatus) => {
    const rank = { eligible: 0, unknown: 1, excluded: 2, unavailable: 3 } as const;
    if (rank[next] > rank[status]) status = next;
  };

  if (model === null) {
    return {
      provider,
      modelId,
      name: modelId,
      status: "unavailable",
      reasons: [unavailableReason(null) ?? "This model is no longer in the provider's list."],
      facts: {
        contextLength: null,
        supportsTools: null,
        supportsImages: null,
        inputPricePerMillion: null,
        outputPricePerMillion: null,
        cachedInputPricePerMillion: null,
        contributor: false
      },
      source: { fetchedAt, freshness: catalogueFreshness({ models: [], fetchedAt }, now) }
    };
  }

  if (!buildAvailable(provider, input.build)) {
    worsen("unavailable");
    reasons.push(browserAvailabilityCopy(providerById(provider).browserAccess));
  }
  if (!connectionUsable(input.connections, provider)) {
    worsen("unavailable");
    reasons.push(
      hasUnusablePlanOnly(input.connections, provider)
        ? "The saved plan cannot be used right now."
        : `No connection for ${providerById(provider).name} yet.`
    );
  }

  if (requirements.requiresTools) {
    if (model.supportsTools === true) {
      // Known match: nothing to report.
    } else if (model.supportsTools === false) {
      worsen("excluded");
      reasons.push(unavailableReason(model) ?? "This model cannot use tools, which the writing agent needs.");
    } else {
      worsen("unknown");
      reasons.push("This provider does not say whether the model supports tools.");
    }
  }
  if (requirements.requiresImages === true) {
    if (model.supportsImages === true) {
      // Known match: nothing to report.
    } else if (model.supportsImages === false) {
      worsen("excluded");
      reasons.push("This model cannot use images, which this task needs.");
    } else {
      worsen("unknown");
      reasons.push("This provider does not say whether the model supports images.");
    }
  }
  const minimum = requirements.minContextLength ?? null;
  if (model.contextLength === null && (minimum !== null || requirements.requiresKnownContext === true)) {
    worsen("unknown");
    reasons.push(UNKNOWN_CONTEXT_NOTE);
  } else if (minimum !== null && model.contextLength !== null && model.contextLength < minimum) {
    worsen("excluded");
    reasons.push(`This model holds ${model.contextLength} tokens of context, below the ${minimum} this task needs.`);
  }

  if (isContributorModel(model)) {
    reasons.push(contributorWarning(model) ?? "Contributor mode may use this book for training.");
  }

  return {
    provider,
    modelId: model.id,
    name: model.name,
    status,
    reasons,
    facts: {
      contextLength: model.contextLength,
      supportsTools: model.supportsTools,
      supportsImages: model.supportsImages,
      inputPricePerMillion: model.inputPricePerMillion,
      outputPricePerMillion: model.outputPricePerMillion,
      cachedInputPricePerMillion: model.cachedInputPricePerMillion ?? null,
      contributor: isContributorModel(model)
    },
    source: { fetchedAt, freshness: catalogueFreshness({ models: [], fetchedAt }, now) }
  };
}

export function evaluateCandidates(input: RoutingInput): PreviewEvaluation {
  const now = input.now ?? Date.now();
  const candidates: CandidateAssessment[] = [];
  const seen = new Set<string>();
  for (const { provider, catalogue } of input.catalogues) {
    for (const model of catalogue.models) {
      seen.add(`${provider} ${model.id}`);
      candidates.push(assess(provider, model, model.id, input, catalogue.fetchedAt, now));
    }
  }
  for (const extra of input.extraModelIds ?? []) {
    if (seen.has(`${extra.provider} ${extra.id}`)) continue;
    seen.add(`${extra.provider} ${extra.id}`);
    const catalogue = input.catalogues.find((entry) => entry.provider === extra.provider)?.catalogue ?? null;
    const model = catalogue?.models.find((entry) => entry.id === extra.id) ?? null;
    candidates.push(assess(extra.provider, model, extra.id, input, catalogue?.fetchedAt ?? null, now));
  }
  return { profileId: input.profile.id, candidates };
}
