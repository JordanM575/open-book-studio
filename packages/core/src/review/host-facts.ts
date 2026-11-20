import { canonicalJson, digestJson, freeze, isReviewData, requireContract, timestampSchema } from "./contract";
import { findModel, type Catalogue } from "../providers/models";
import { CONTRIBUTOR_WARNING, isContributorModel } from "../providers/compatibility";
import { providerById } from "../providers/registry";
import { providerIdSchema, type ConnectionSummary, type ModelInfo, type ProviderId } from "../providers/types";

/** Exact attribution the disclosure shows. The endpoint identity is opaque and credential-free. */
export interface ReaderReviewConnection {
  readonly id: string;
  readonly label: string;
  readonly providerName: string;
  readonly modelName: string;
}

/** Known unit prices or an explicitly unknown price class. A null total is never a dollar cap. */
export interface ReaderReviewPriceFacts {
  readonly kind: "plan" | "metered" | "unknown";
  readonly inputPerMillion: number | null;
  readonly cachedInputPerMillion: number | null;
  readonly outputPerMillion: number | null;
  readonly asOf: string | null;
}

export interface ReaderReviewTerms {
  readonly bookId: string;
  readonly termsRevision: string;
  readonly dataUse: string;
  readonly training: string;
}

export interface ReaderHostFacts {
  readonly connection: ReaderReviewConnection;
  readonly priceFacts: ReaderReviewPriceFacts;
  readonly terms: ReaderReviewTerms;
  readonly destination: {
    readonly connectionId: string;
    readonly provider: string;
    readonly model: string;
    readonly endpointIdentity: string;
  };
  readonly environment: {
    readonly hostId: string;
    readonly hostSupported: boolean;
    readonly connectionAvailable: boolean;
    readonly modelSupported: boolean;
    readonly capabilityRevision: string;
    readonly estimatedCostUsd: null;
    readonly priceAsOf: string | null;
    readonly catalogContextTokens: number | null;
    readonly catalogAsOf: string | null;
    readonly contextFit: "unknown";
  };
  readonly book: {
    readonly consentSatisfied: boolean;
    readonly consentRevision: string;
    readonly termsRevision: string;
  };
}

export type ReaderHostResult =
  | { readonly kind: "blocked"; readonly reason: "unavailable" | "permission" | "no-model" }
  | { readonly kind: "ready"; readonly facts: ReaderHostFacts };

export interface ReaderHostInput {
  readonly hostSupported: boolean;
  readonly book: { readonly bookId: string; readonly title: string; readonly allowContributorTraining: boolean };
  readonly destination: { readonly connectionId: string; readonly model: string };
  readonly connections: readonly ConnectionSummary[];
  readonly catalogue: Catalogue;
}

const HOST_ID = "host-desktop";
const MAX_NAME = 200;

function boundedName(value: unknown): string {
  requireContract(typeof value === "string" && value.trim().length > 0 && value.length <= MAX_NAME, "invalid-host-fact");
  return value;
}

function finitePrice(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const price = typeof value === "number" ? value : Number.NaN;
  requireContract(Number.isFinite(price) && price >= 0, "invalid-host-fact");
  return price;
}

function isoOrNull(value: unknown): string | null {
  const parsed = timestampSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function priceFacts(connection: ConnectionSummary, model: ModelInfo, fetchedAt: string | null): ReaderReviewPriceFacts {
  if (connection.kind === "chatgpt-plan") {
    return { kind: "plan", inputPerMillion: null, cachedInputPerMillion: null, outputPerMillion: null, asOf: null };
  }
  if (model.manual === true) {
    return { kind: "unknown", inputPerMillion: null, cachedInputPerMillion: null, outputPerMillion: null, asOf: null };
  }
  return {
    kind: "metered",
    inputPerMillion: finitePrice(model.inputPricePerMillion),
    cachedInputPerMillion: finitePrice(model.cachedInputPricePerMillion),
    outputPerMillion: finitePrice(model.outputPricePerMillion),
    asOf: isoOrNull(fetchedAt)
  };
}

function termsFor(providerName: string, connection: ConnectionSummary, model: ModelInfo): { dataUse: string; training: string } {
  const plan = connection.kind === "chatgpt-plan";
  const dataUse = `Selected text is sent to ${providerName} for this one review.` +
    (plan ? " This connection uses your ChatGPT plan; plan usage applies." : "");
  const training = model.trainingOnData === true
    ? (model.note === CONTRIBUTOR_WARNING
        ? CONTRIBUTOR_WARNING
        : "The provider marks this model as training-eligible. Prompts and completions may be used to train its models.")
    : model.trainingOnData === false
      ? "The provider reports that this model does not train on prompts and completions."
      : "The provider does not report whether prompts and completions are used for training. Treat this as unknown.";
  return { dataUse, training };
}

/**
 * Pure 011/022 derivation from already-read host facts. It reads no credential, library, file or
 * network resource. A missing connection or unusable plan blocks preparation; a missing model is
 * its own refusal; absent 022 book consent makes a ready disclosure with Start denied.
 */
export async function deriveReaderHostFacts(input: ReaderHostInput): Promise<ReaderHostResult> {
  requireContract(isReviewData(input), "invalid-host-fact");
  const { hostSupported, destination } = input;
  if (!hostSupported) return { kind: "blocked", reason: "unavailable" };

  const matches = input.connections.filter((connection) => connection.id === destination.connectionId);
  const connection = matches[0];
  if (matches.length !== 1 || !connection) return { kind: "blocked", reason: "unavailable" };
  const parsedProvider = providerIdSchema.safeParse(connection.provider);
  if (!parsedProvider.success) return { kind: "blocked", reason: "unavailable" };
  const provider: ProviderId = parsedProvider.data;
  const providerName = providerById(provider).name;

  const connectionAvailable = connection.kind !== "chatgpt-plan" || connection.planUsable !== false;
  if (!connectionAvailable) return { kind: "blocked", reason: "permission" };

  const model = findModel(input.catalogue, destination.model);
  if (!model) return { kind: "blocked", reason: "no-model" };

  const label = boundedName(connection.label);
  const modelName = boundedName(model.name || model.id);
  const modelId = boundedName(model.id);
  const bookId = boundedName(input.book.bookId);
  const catalogueAsOf = isoOrNull(input.catalogue.fetchedAt);
  const facts = priceFacts(connection, model, input.catalogue.fetchedAt);
  const terms = termsFor(providerName, connection, model);
  const consentSatisfied = !isContributorModel(model) || input.book.allowContributorTraining === true;
  const endpointIdentity = await digestJson({ connectionId: connection.id, provider, model: modelId });
  const termsRevision = await digestJson({
    dataUse: terms.dataUse, training: terms.training, provider: providerName, providerId: provider,
    model: modelId, trainingOnData: model.trainingOnData ?? null, modelNote: model.note ?? null
  });
  const consentRevision = await digestJson({
    hostSupported, connectionId: connection.id, provider, connectionKind: connection.kind,
    planUsable: connection.planUsable ?? null, model: modelId, trainingOnData: model.trainingOnData ?? null,
    contributor: isContributorModel(model), allowContributorTraining: input.book.allowContributorTraining === true
  });
  const capabilityRevision = await digestJson({
    hostId: HOST_ID, hostSupported, connection: { id: connection.id, label, provider, kind: connection.kind,
      planUsable: connection.planUsable ?? null }, model: { id: modelId, name: modelName,
      contextLength: model.contextLength, supportsTools: model.supportsTools ?? null,
      supportsImages: model.supportsImages ?? null, trainingOnData: model.trainingOnData ?? null,
      note: model.note ?? null, manual: model.manual === true },
    catalogue: { fetchedAt: catalogueAsOf, count: input.catalogue.models.length },
    priceFacts: facts
  });

  return {
    kind: "ready",
    facts: freeze({
      connection: { id: connection.id, label: boundedName(label), providerName: boundedName(providerName), modelName },
      priceFacts: facts,
      terms: { bookId, termsRevision, dataUse: terms.dataUse, training: terms.training },
      destination: { connectionId: connection.id, provider: providerName, model: modelId, endpointIdentity },
      environment: {
        hostId: HOST_ID, hostSupported, connectionAvailable, modelSupported: true, capabilityRevision,
        estimatedCostUsd: null, priceAsOf: facts.kind === "metered" ? facts.asOf : null,
        catalogContextTokens: model.contextLength, catalogAsOf: catalogueAsOf, contextFit: "unknown"
      },
      book: { consentSatisfied, consentRevision, termsRevision }
    })
  };
}

/** Stable public shape for tests and the disclosure; no credential-bearing field is present. */
export function readerHostFactDigest(facts: ReaderHostFacts): string {
  return canonicalJson({
    destination: facts.destination, environment: facts.environment, book: facts.book,
    connection: facts.connection, priceFacts: facts.priceFacts, terms: facts.terms
  });
}
