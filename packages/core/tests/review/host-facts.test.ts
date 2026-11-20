import { describe, expect, test } from "bun:test";
import { CONTRIBUTOR_WARNING } from "../../src/providers/compatibility";
import type { Catalogue } from "../../src/providers/models";
import type { ConnectionSummary, ModelInfo } from "../../src/providers/types";
import { deriveReaderHostFacts } from "../../src/review/host-facts";

const fetchedAt = "2026-11-07T12:00:00Z";

function connection(overrides: Partial<ConnectionSummary> = {}): ConnectionSummary {
  return {
    id: "conn_123456", provider: "meta", label: "Work account", kind: "api-key", createdAt: fetchedAt, ...overrides
  };
}
function model(overrides: Partial<ModelInfo> = {}): ModelInfo {
  return {
    id: "muse-spark-1.3", name: "Muse Spark 1.3", contextLength: 1_048_576, supportsTools: true, supportsImages: true,
    inputPricePerMillion: 1.25, cachedInputPricePerMillion: 0.15, outputPricePerMillion: 4.25,
    trainingOnData: false, note: "Standard mode: prompts and completions are not used to train Meta models.", ...overrides
  };
}
function catalogue(models: ModelInfo[], at: string | null = fetchedAt): Catalogue {
  return { models, fetchedAt: at };
}
function input(overrides: {
  hostSupported?: boolean;
  book?: { bookId: string; title: string; allowContributorTraining: boolean };
  destination?: { connectionId: string; model: string };
  connections?: ConnectionSummary[];
  catalogue?: Catalogue;
} = {}) {
  return {
    hostSupported: overrides.hostSupported ?? true,
    book: overrides.book ?? { bookId: "book_123456", title: "Synthetic book", allowContributorTraining: false },
    destination: overrides.destination ?? { connectionId: "conn_123456", model: "muse-spark-1.3" },
    connections: overrides.connections ?? [connection()],
    catalogue: overrides.catalogue ?? catalogue([model()])
  };
}
async function facts(overrides: Parameters<typeof input>[0] = {}) {
  const result = await deriveReaderHostFacts(input(overrides));
  if (result.kind !== "ready") throw new Error(`Expected ready facts, got ${result.reason}`);
  return result.facts;
}

describe("011/022 host facts for a disclosed reader review", () => {
  test("metered prices and attribution are exact, while total cost and context fit stay unknown", async () => {
    const value = await facts();
    expect(value.connection).toEqual({ id: "conn_123456", label: "Work account", providerName: "Meta", modelName: "Muse Spark 1.3" });
    expect(value.destination).toMatchObject({ connectionId: "conn_123456", provider: "Meta", model: "muse-spark-1.3" });
    expect(value.destination.endpointIdentity).toMatch(/^[a-f0-9]{64}$/);
    expect(value.priceFacts).toEqual({ kind: "metered", inputPerMillion: 1.25, cachedInputPerMillion: 0.15, outputPerMillion: 4.25, asOf: fetchedAt });
    expect(value.environment).toMatchObject({ estimatedCostUsd: null, priceAsOf: fetchedAt, catalogContextTokens: 1_048_576, catalogAsOf: fetchedAt, contextFit: "unknown" });
    expect(value.terms.dataUse).toBe("Selected text is sent to Meta for this one review.");
    expect(value.terms.training).toBe("The provider reports that this model does not train on prompts and completions.");
    expect(value.book.consentSatisfied).toBe(true);
  });

  test("a ChatGPT plan discloses plan usage without a per-token price", async () => {
    const value = await facts({ connections: [connection({ kind: "chatgpt-plan", planUsable: true, provider: "openai" })], catalogue: catalogue([model({ id: "gpt-plan", name: "GPT Plan" })]) ,
      destination: { connectionId: "conn_123456", model: "gpt-plan" } });
    expect(value.priceFacts).toEqual({ kind: "plan", inputPerMillion: null, cachedInputPerMillion: null, outputPerMillion: null, asOf: null });
    expect(value.environment.priceAsOf).toBeNull();
    expect(value.terms.dataUse).toContain("This connection uses your ChatGPT plan; plan usage applies.");
    expect(value.environment.connectionAvailable).toBe(true);
  });

  test("manual, missing and partially reported prices stay explicit rather than inferred", async () => {
    const manual = await facts({ catalogue: catalogue([model({ manual: true })]) });
    expect(manual.priceFacts).toEqual({ kind: "unknown", inputPerMillion: null, cachedInputPerMillion: null, outputPerMillion: null, asOf: null });
    const missing = await facts({ catalogue: catalogue([model({ inputPricePerMillion: null, outputPricePerMillion: null, cachedInputPricePerMillion: null })]) });
    expect(missing.priceFacts).toMatchObject({ kind: "metered", inputPerMillion: null, cachedInputPerMillion: null, outputPerMillion: null, asOf: fetchedAt });
    const subset = await facts({ catalogue: catalogue([model({ cachedInputPricePerMillion: null })]) });
    expect(subset.priceFacts).toEqual({ kind: "metered", inputPerMillion: 1.25, cachedInputPerMillion: null, outputPerMillion: 4.25, asOf: fetchedAt });
    expect((await facts({ catalogue: catalogue([model()], null) })).environment.catalogAsOf).toBeNull();
  });

  test("training terms distinguish published no-training, contributor and unknown", async () => {
    const contributor = await facts({ catalogue: catalogue([model({ id: "muse-spark-1.3-contributor", name: "Muse Spark 1.3 Contributor", trainingOnData: true, note: CONTRIBUTOR_WARNING })]) ,
      destination: { connectionId: "conn_123456", model: "muse-spark-1.3-contributor" } });
    expect(contributor.terms.training).toBe(CONTRIBUTOR_WARNING);
    expect(contributor.book.consentSatisfied).toBe(false);
    const marked = await facts({ catalogue: catalogue([model({ trainingOnData: true, note: "A general note." })]) });
    expect(marked.terms.training).toBe("The provider marks this model as training-eligible. Prompts and completions may be used to train its models.");
    expect(marked.book.consentSatisfied).toBe(false);
    const unknown = await facts({ catalogue: catalogue([model({ trainingOnData: null, note: null })]) });
    expect(unknown.terms.training).toBe("The provider does not report whether prompts and completions are used for training. Treat this as unknown.");
    expect(unknown.book.consentSatisfied).toBe(true);
  });

  test("contributor consent is book-scoped and default-off; enabling it changes only consent facts", async () => {
    const contributor = model({ id: "muse-spark-1.3-contributor", name: "Muse Spark 1.3 Contributor", trainingOnData: true, note: CONTRIBUTOR_WARNING });
    const destination = { connectionId: "conn_123456", model: contributor.id };
    const before = await facts({ catalogue: catalogue([contributor]), destination });
    const after = await facts({ book: { bookId: "book_123456", title: "Synthetic book", allowContributorTraining: true },
      catalogue: catalogue([contributor]), destination });
    expect(before.book.consentSatisfied).toBe(false);
    expect(after.book.consentSatisfied).toBe(true);
    expect(after.book.termsRevision).toBe(before.book.termsRevision);
    expect(after.book.consentRevision).not.toBe(before.book.consentRevision);
  });

  test("revisions are stable for the same facts and change with their own inputs", async () => {
    const first = await facts();
    const second = await facts();
    expect(first.book.consentRevision).toBe(second.book.consentRevision);
    expect(first.book.termsRevision).toBe(second.book.termsRevision);
    expect(first.environment.capabilityRevision).toBe(second.environment.capabilityRevision);
    const label = await facts({ connections: [connection({ label: "Another label" })] });
    expect(label.environment.capabilityRevision).not.toBe(first.environment.capabilityRevision);
    expect(label.book.consentRevision).toBe(first.book.consentRevision);
    const price = await facts({ catalogue: catalogue([model({ inputPricePerMillion: 2 })]) });
    expect(price.environment.capabilityRevision).not.toBe(first.environment.capabilityRevision);
    expect(price.book.termsRevision).toBe(first.book.termsRevision);
    const note = await facts({ catalogue: catalogue([model({ note: "Changed note." })]) });
    expect(note.book.termsRevision).not.toBe(first.book.termsRevision);
    const training = await facts({ catalogue: catalogue([model({ trainingOnData: true })]) });
    expect(training.book.termsRevision).not.toBe(first.book.termsRevision);
    expect(training.book.consentRevision).not.toBe(first.book.consentRevision);
  });

  test("missing connection, unusable plan, unsupported provider and missing model refuse before preparation", async () => {
    expect(await deriveReaderHostFacts(input({ connections: [] }))).toEqual({ kind: "blocked", reason: "unavailable" });
    expect(await deriveReaderHostFacts(input({ connections: [connection({ kind: "chatgpt-plan", planUsable: false })] }))).toEqual({ kind: "blocked", reason: "permission" });
    expect(await deriveReaderHostFacts(input({ connections: [connection({ provider: "not-a-provider" as never })] }))).toEqual({ kind: "blocked", reason: "unavailable" });
    expect(await deriveReaderHostFacts(input({ catalogue: catalogue([]) }))).toEqual({ kind: "blocked", reason: "no-model" });
    expect(await deriveReaderHostFacts(input({ hostSupported: false }))).toEqual({ kind: "blocked", reason: "unavailable" });
  });

  test("malformed attribution is refused, never displayed", async () => {
    await expect(deriveReaderHostFacts(input({ connections: [connection({ label: " " })] }))).rejects.toThrow("invalid-host-fact");
    await expect(deriveReaderHostFacts(input({ connections: [connection({ label: "x".repeat(201) })] }))).rejects.toThrow("invalid-host-fact");
    await expect(deriveReaderHostFacts(input({ catalogue: catalogue([model({ name: "x".repeat(201) })]) }))).rejects.toThrow("invalid-host-fact");
  });
});
