import { describe, expect, test } from "bun:test";
import { evaluateCandidates, taskProfileSchema, WRITING_TASK_PROFILES } from "../../src/routing/index";
import type { ProviderCatalogue, TaskProfile } from "../../src/routing/index";
import type { ConnectionSummary, ModelInfo } from "../../src/providers/types";
import { canRunAgent } from "../../src/providers/models";

const NOW = Date.parse("2026-11-03T12:00:00.000Z");
const FRESH_AT = new Date(NOW - 60 * 60 * 1000).toISOString();
const STALE_AT = new Date(NOW - 25 * 60 * 60 * 1000).toISOString();

/** Local fixture only. Shipped fixtures live in WRITING_TASK_PROFILES; this one keeps the schema explicit. */
function profile(overrides: Partial<TaskProfile> = {}): TaskProfile {
  return {
    id: "drafting",
    name: "Drafting",
    purpose: "Fixture profile: turn notes into new prose with the writing agent.",
    version: 1,
    requirements: { requiresTools: true, requiresKnownContext: true, minContextLength: 32000 },
    ...overrides
  };
}

function model(overrides: Partial<ModelInfo> & { id: string }): ModelInfo {
  return {
    name: overrides.id,
    contextLength: 128000,
    supportsTools: true,
    supportsImages: true,
    inputPricePerMillion: 1.25,
    outputPricePerMillion: 5,
    ...overrides
  };
}

function connection(overrides: Partial<ConnectionSummary> = {}): ConnectionSummary {
  return {
    id: "conn_test01",
    provider: "openrouter",
    label: "Test key",
    kind: "api-key",
    createdAt: "2026-11-01T00:00:00.000Z",
    ...overrides
  };
}

describe("routing evaluation", () => {
  test("a known match is eligible with no reasons", () => {
    const result = evaluateCandidates({
      profile: profile(),
      catalogues: [
        { provider: "openrouter", catalogue: { models: [model({ id: "acme/large" })], fetchedAt: FRESH_AT } }
      ],
      connections: [connection()],
      build: "desktop",
      now: NOW
    });
    expect(result.profileId).toBe("drafting");
    expect(result.candidates).toHaveLength(1);
    const [candidate] = result.candidates;
    expect(candidate?.status).toBe("eligible");
    expect(candidate?.reasons).toEqual([]);
    expect(candidate?.source.freshness).toBe("fresh");
  });

  test("a model without tools is excluded with the existing reason", () => {
    const result = evaluateCandidates({
      profile: profile(),
      catalogues: [
        { provider: "openrouter", catalogue: { models: [model({ id: "acme/chat", supportsTools: false })], fetchedAt: FRESH_AT } }
      ],
      connections: [connection()],
      build: "desktop",
      now: NOW
    });
    const [candidate] = result.candidates;
    expect(candidate?.status).toBe("excluded");
    expect(candidate?.reasons).toContain("This model cannot use tools, which the writing agent needs.");
  });

  test("a model below the context minimum is excluded with its numbers", () => {
    const result = evaluateCandidates({
      profile: profile(),
      catalogues: [
        { provider: "openrouter", catalogue: { models: [model({ id: "acme/small", contextLength: 8000 })], fetchedAt: FRESH_AT } }
      ],
      connections: [connection()],
      build: "desktop",
      now: NOW
    });
    const [candidate] = result.candidates;
    expect(candidate?.status).toBe("excluded");
    expect(candidate?.reasons).toContain("This model holds 8000 tokens of context, below the 32000 this task needs.");
  });

  test("a model without images is excluded only when the task needs them", () => {
    const catalogues: ProviderCatalogue[] = [
      { provider: "openrouter", catalogue: { models: [model({ id: "acme/text", supportsImages: false })], fetchedAt: FRESH_AT } }
    ];
    const withoutImages = evaluateCandidates({
      profile: profile({ requirements: { requiresTools: false, requiresImages: true, requiresKnownContext: false } }),
      catalogues,
      connections: [connection()],
      build: "desktop",
      now: NOW
    });
    expect(withoutImages.candidates[0]?.status).toBe("excluded");
    expect(withoutImages.candidates[0]?.reasons).toContain("This model cannot use images, which this task needs.");

    const toolsOnly = evaluateCandidates({
      profile: profile({ requirements: { requiresTools: true, requiresKnownContext: true } }),
      catalogues,
      connections: [connection()],
      build: "desktop",
      now: NOW
    });
    expect(toolsOnly.candidates[0]?.status).toBe("eligible");
  });

  test("unknown facts stay unknown and never qualify the model", () => {
    const result = evaluateCandidates({
      profile: profile(),
      catalogues: [
        {
          provider: "openrouter",
          catalogue: { models: [model({ id: "acme/mystery", supportsTools: null, contextLength: null })], fetchedAt: FRESH_AT }
        }
      ],
      connections: [connection()],
      build: "desktop",
      now: NOW
    });
    const [candidate] = result.candidates;
    expect(candidate?.status).toBe("unknown");
    expect(candidate?.reasons).toContain("This provider does not say whether the model supports tools.");
    expect(candidate?.reasons).toContain("This provider does not report the model's context size.");
  });

  test("a provider without a connection is unavailable", () => {
    const result = evaluateCandidates({
      profile: profile(),
      catalogues: [
        { provider: "openrouter", catalogue: { models: [model({ id: "acme/large" })], fetchedAt: FRESH_AT } }
      ],
      connections: [],
      build: "desktop",
      now: NOW
    });
    const [candidate] = result.candidates;
    expect(candidate?.status).toBe("unavailable");
    expect(candidate?.reasons).toContain("No connection for OpenRouter yet.");
  });

  test("a plan that cannot be used leaves no usable connection", () => {
    const result = evaluateCandidates({
      profile: profile(),
      catalogues: [
        { provider: "openrouter", catalogue: { models: [model({ id: "acme/large" })], fetchedAt: FRESH_AT } }
      ],
      connections: [connection({ kind: "chatgpt-plan", planUsable: false })],
      build: "desktop",
      now: NOW
    });
    const [candidate] = result.candidates;
    expect(candidate?.status).toBe("unavailable");
    expect(candidate?.reasons).toContain("The saved plan cannot be used right now.");
  });

  test("a retired model id is unavailable with the existing reason", () => {
    const result = evaluateCandidates({
      profile: profile(),
      catalogues: [
        { provider: "openrouter", catalogue: { models: [model({ id: "acme/large" })], fetchedAt: FRESH_AT } }
      ],
      connections: [connection()],
      build: "desktop",
      extraModelIds: [{ provider: "openrouter", id: "acme/retired" }],
      now: NOW
    });
    expect(result.candidates).toHaveLength(2);
    const retired = result.candidates.find((candidate) => candidate.modelId === "acme/retired");
    expect(retired?.status).toBe("unavailable");
    expect(retired?.reasons).toContain("This model is no longer in the provider's list.");
  });

  test("an extra id already in the catalogue is assessed once", () => {
    const result = evaluateCandidates({
      profile: profile(),
      catalogues: [
        { provider: "openrouter", catalogue: { models: [model({ id: "acme/large" })], fetchedAt: FRESH_AT } }
      ],
      connections: [connection()],
      build: "desktop",
      extraModelIds: [{ provider: "openrouter", id: "acme/large" }],
      now: NOW
    });
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]?.status).toBe("eligible");
  });

  test("a stale catalogue is labelled stale and still evaluated", () => {
    const result = evaluateCandidates({
      profile: profile(),
      catalogues: [
        { provider: "openrouter", catalogue: { models: [model({ id: "acme/large" })], fetchedAt: STALE_AT } }
      ],
      connections: [connection()],
      build: "desktop",
      now: NOW
    });
    const [candidate] = result.candidates;
    expect(candidate?.source).toEqual({ fetchedAt: STALE_AT, freshness: "stale" });
    expect(candidate?.status).toBe("eligible");
  });

  test("an absent catalogue timestamp is reported as absent", () => {
    const result = evaluateCandidates({
      profile: profile(),
      catalogues: [{ provider: "openrouter", catalogue: { models: [model({ id: "acme/large" })], fetchedAt: null } }],
      connections: [connection()],
      build: "desktop",
      now: NOW
    });
    expect(result.candidates[0]?.source.freshness).toBe("absent");
  });

  test("candidates keep catalogue order and are never ranked", () => {
    const result = evaluateCandidates({
      profile: profile({ requirements: { requiresTools: false, requiresKnownContext: false } }),
      catalogues: [
        {
          provider: "openrouter",
          catalogue: {
            models: [model({ id: "acme/zebra" }), model({ id: "acme/alpha" })],
            fetchedAt: FRESH_AT
          }
        }
      ],
      connections: [connection()],
      build: "desktop",
      now: NOW
    });
    expect(result.candidates.map((candidate) => candidate.modelId)).toEqual(["acme/zebra", "acme/alpha"]);
  });

  test("a Contributor model keeps its warning without changing the verdict", () => {
    const result = evaluateCandidates({
      profile: profile(),
      catalogues: [
        {
          provider: "meta",
          catalogue: { models: [model({ id: "muse-spark-1.3-contributor", trainingOnData: true })], fetchedAt: FRESH_AT }
        }
      ],
      connections: [connection({ provider: "meta" })],
      build: "desktop",
      now: NOW
    });
    const [candidate] = result.candidates;
    expect(candidate?.status).toBe("eligible");
    expect(candidate?.facts.contributor).toBe(true);
    expect(candidate?.reasons.some((reason) => reason.includes("Contributor mode"))).toBe(true);
  });

  test("facts carry every unit price, including cached", () => {
    const result = evaluateCandidates({
      profile: profile(),
      catalogues: [
        { provider: "openrouter", catalogue: { models: [model({ id: "acme/large", cachedInputPricePerMillion: 0.002 })], fetchedAt: FRESH_AT } }
      ],
      connections: [connection()],
      build: "desktop",
      now: NOW
    });
    expect(result.candidates[0]?.facts.cachedInputPricePerMillion).toBe(0.002);
  });

  test("an unknown price stays unknown in the facts", () => {
    const result = evaluateCandidates({
      profile: profile(),
      catalogues: [
        {
          provider: "openrouter",
          catalogue: { models: [model({ id: "acme/freeish", inputPricePerMillion: null, outputPricePerMillion: null })], fetchedAt: FRESH_AT }
        }
      ],
      connections: [connection()],
      build: "desktop",
      now: NOW
    });
    expect(result.candidates[0]?.facts.inputPricePerMillion).toBeNull();
    expect(result.candidates[0]?.facts.outputPricePerMillion).toBeNull();
  });

  test("a desktop-only provider is unavailable in the web build", () => {
    const catalogues: ProviderCatalogue[] = [
      { provider: "openai", catalogue: { models: [model({ id: "gpt-x" })], fetchedAt: FRESH_AT } }
    ];
    const web = evaluateCandidates({
      profile: profile(),
      catalogues,
      connections: [connection({ provider: "openai" })],
      build: "web",
      now: NOW
    });
    expect(web.candidates[0]?.status).toBe("unavailable");
    expect(web.candidates[0]?.reasons).toContain("Desktop app only");

    const desktop = evaluateCandidates({
      profile: profile(),
      catalogues,
      connections: [connection({ provider: "openai" })],
      build: "desktop",
      now: NOW
    });
    expect(desktop.candidates[0]?.status).toBe("eligible");
  });

  test("a profile schema accepts versioned data and rejects blanks and negatives", () => {
    expect(taskProfileSchema.safeParse(profile()).success).toBe(true);
    expect(taskProfileSchema.safeParse(profile({ name: "" })).success).toBe(false);
    expect(taskProfileSchema.safeParse(profile({ version: 0 })).success).toBe(false);
    expect(
      taskProfileSchema.safeParse(profile({ requirements: { requiresTools: true, requiresKnownContext: true, minContextLength: -4 } })).success
    ).toBe(false);
  });

  test("the shipped taxonomy is exactly three version-1 profiles with the accepted requirements", () => {
    expect(WRITING_TASK_PROFILES.map((entry) => entry.id)).toEqual(["discuss-book", "draft-prose", "revise-prose"]);
    expect(WRITING_TASK_PROFILES.map((entry) => entry.name)).toEqual(["Discuss the book", "Draft new prose", "Revise existing prose"]);
    expect(Object.isFrozen(WRITING_TASK_PROFILES)).toBe(true);
    for (const shipped of WRITING_TASK_PROFILES) {
      expect(shipped.version).toBe(1);
      expect(shipped.requirements).toEqual({ requiresTools: true, requiresKnownContext: true });
      expect(shipped.requirements).not.toHaveProperty("requiresImages");
      expect(shipped.requirements).not.toHaveProperty("minContextLength");
      expect(shipped.purpose.length).toBeGreaterThan(0);
    }
  });

  test("a shipped profile with a null context is unknown with the exact reason, never eligible", () => {
    for (const shipped of WRITING_TASK_PROFILES) {
      const result = evaluateCandidates({
        profile: shipped,
        catalogues: [
          { provider: "openrouter", catalogue: { models: [model({ id: "acme/mystery", supportsTools: true, contextLength: null })], fetchedAt: FRESH_AT } }
        ],
        connections: [connection()],
        build: "desktop",
        now: NOW
      });
      const [candidate] = result.candidates;
      expect(candidate?.status).toBe("unknown");
      expect(candidate?.reasons).toContain("This provider does not report the model's context size.");
    }
  });

  test("a shipped profile with unknown tool support is unknown with the exact reason", () => {
    for (const shipped of WRITING_TASK_PROFILES) {
      const result = evaluateCandidates({
        profile: shipped,
        catalogues: [
          { provider: "openrouter", catalogue: { models: [model({ id: "acme/mystery-tools", supportsTools: null, contextLength: 128000 })], fetchedAt: FRESH_AT } }
        ],
        connections: [connection()],
        build: "desktop",
        now: NOW
      });
      const [candidate] = result.candidates;
      expect(candidate?.status).toBe("unknown");
      expect(candidate?.reasons).toContain("This provider does not say whether the model supports tools.");
    }
  });

  test("a shipped profile with tools unsupported is excluded with the exact reason", () => {
    for (const shipped of WRITING_TASK_PROFILES) {
      const result = evaluateCandidates({
        profile: shipped,
        catalogues: [
          { provider: "openrouter", catalogue: { models: [model({ id: "acme/chat", supportsTools: false, contextLength: 128000 })], fetchedAt: FRESH_AT } }
        ],
        connections: [connection()],
        build: "desktop",
        now: NOW
      });
      const [candidate] = result.candidates;
      expect(candidate?.status).toBe("excluded");
      expect(candidate?.reasons).toContain("This model cannot use tools, which the writing agent needs.");
    }
  });

  test("a null context with both context requirements reports the context reason exactly once", () => {
    const result = evaluateCandidates({
      profile: profile({ requirements: { requiresTools: true, requiresKnownContext: true, minContextLength: 32000 } }),
      catalogues: [
        { provider: "openrouter", catalogue: { models: [model({ id: "acme/mystery", supportsTools: true, contextLength: null })], fetchedAt: FRESH_AT } }
      ],
      connections: [connection()],
      build: "desktop",
      now: NOW
    });
    const [candidate] = result.candidates;
    expect(candidate?.status).toBe("unknown");
    expect(
      (candidate?.reasons ?? []).filter((reason) => reason === "This provider does not report the model's context size.")
    ).toHaveLength(1);
  });

  test("for every shipped profile, eligible is exactly the canRunAgent gate on this path", () => {
    const toolsOptions: Array<boolean | null> = [true, false, null];
    const contextOptions: Array<number | null> = [null, 128000];
    for (const shipped of WRITING_TASK_PROFILES) {
      for (const supportsTools of toolsOptions) {
        for (const contextLength of contextOptions) {
          const fixture = model({ id: `acme/m-${String(supportsTools)}-${String(contextLength)}`, supportsTools, contextLength });
          const result = evaluateCandidates({
            profile: shipped,
            catalogues: [
              { provider: "openrouter", catalogue: { models: [fixture], fetchedAt: FRESH_AT } }
            ],
            connections: [connection()],
            build: "desktop",
            now: NOW
          });
          const [candidate] = result.candidates;
          expect(candidate?.status === "eligible").toBe(canRunAgent(fixture));
        }
      }
    }
  });

  test("candidate order equals catalogue order and carries no rank-shaped fields", () => {
    const firstShipped = WRITING_TASK_PROFILES[0];
    if (!firstShipped) throw new Error("expected the shipped taxonomy");
    const shuffled = [
      model({ id: "zulu-last-alphabetically" }),
      model({ id: "acme/alpha" }),
      model({ id: "mango/mid" })
    ];
    const result = evaluateCandidates({
      profile: firstShipped,
      catalogues: [{ provider: "openrouter", catalogue: { models: shuffled, fetchedAt: FRESH_AT } }],
      connections: [connection()],
      build: "desktop",
      now: NOW
    });
    expect(result.candidates.map((candidate) => candidate.modelId)).toEqual([
      "zulu-last-alphabetically",
      "acme/alpha",
      "mango/mid"
    ]);
    for (const candidate of result.candidates) {
      expect(Object.keys(candidate).some((key) => /rank|score|position|weight|tier/i.test(key))).toBe(false);
    }
  });

  test("shipped profiles stay unavailable on the web build and without a usable plan", () => {
    for (const shipped of WRITING_TASK_PROFILES) {
      const web = evaluateCandidates({
        profile: shipped,
        catalogues: [
          { provider: "openai", catalogue: { models: [model({ id: "gpt-x" })], fetchedAt: FRESH_AT } }
        ],
        connections: [connection({ provider: "openai" })],
        build: "web",
        now: NOW
      });
      expect(web.candidates[0]?.status).toBe("unavailable");
      expect(web.candidates[0]?.reasons).toContain("Desktop app only");

      const planRefused = evaluateCandidates({
        profile: shipped,
        catalogues: [
          { provider: "openrouter", catalogue: { models: [model({ id: "acme/large" })], fetchedAt: FRESH_AT } }
        ],
        connections: [connection({ kind: "chatgpt-plan", planUsable: false })],
        build: "desktop",
        now: NOW
      });
      expect(planRefused.candidates[0]?.status).toBe("unavailable");
      expect(planRefused.candidates[0]?.reasons).toContain("The saved plan cannot be used right now.");

      const missing = evaluateCandidates({
        profile: shipped,
        catalogues: [
          { provider: "openrouter", catalogue: { models: [model({ id: "acme/large" })], fetchedAt: FRESH_AT } }
        ],
        connections: [],
        build: "desktop",
        now: NOW
      });
      expect(missing.candidates[0]?.status).toBe("unavailable");
      expect(missing.candidates[0]?.reasons).toContain("No connection for OpenRouter yet.");
    }
  });

  test("a Contributor candidate keeps its verdict and only adds the warning", () => {
    for (const shipped of WRITING_TASK_PROFILES) {
      const plain = evaluateCandidates({
        profile: shipped,
        catalogues: [
          { provider: "meta", catalogue: { models: [model({ id: "muse-plain" })], fetchedAt: FRESH_AT } }
        ],
        connections: [connection({ provider: "meta" })],
        build: "desktop",
        now: NOW
      });
      const contributor = evaluateCandidates({
        profile: shipped,
        catalogues: [
          { provider: "meta", catalogue: { models: [model({ id: "muse-contributor", trainingOnData: true })], fetchedAt: FRESH_AT } }
        ],
        connections: [connection({ provider: "meta" })],
        build: "desktop",
        now: NOW
      });
      expect(contributor.candidates[0]?.status).toBe(plain.candidates[0]?.status);
      expect(contributor.candidates[0]?.reasons.some((reason) => reason.includes("Contributor mode"))).toBe(true);
      expect(plain.candidates[0]?.reasons.some((reason) => reason.includes("Contributor mode"))).toBe(false);
    }
  });
});
