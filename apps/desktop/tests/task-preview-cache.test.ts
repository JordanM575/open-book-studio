/// <reference types="bun" />
import { describe, expect, test } from "bun:test";
import { previewCatalogues, usableConnectionsFor } from "@ai-book-studio/app/lib/task-preview-cache";
import type { PreviewCatalogueCache } from "@ai-book-studio/app/lib/task-preview-cache";
import type { ConnectionSummary, ModelInfo, ProviderId } from "@ai-book-studio/core/providers/types";
import type { Catalogue } from "@ai-book-studio/core/providers/models";

const FRESH_AT = "2026-11-03T11:55:00.000Z";

function model(id: string): ModelInfo {
  return {
    id,
    name: id,
    contextLength: 128000,
    supportsTools: true,
    supportsImages: false,
    inputPricePerMillion: 1,
    outputPricePerMillion: 2
  };
}

function catalogue(...ids: string[]): Catalogue {
  return { models: ids.map(model), fetchedAt: FRESH_AT };
}

function connection(id: string, provider: ProviderId, planUsable?: boolean): ConnectionSummary {
  return {
    id,
    provider,
    label: id,
    kind: "api-key",
    createdAt: "2026-11-01T00:00:00.000Z",
    ...(planUsable === undefined ? {} : { planUsable })
  };
}

function cache(connections: ConnectionSummary[], loads: Array<{ connectionId: string; catalogue: Catalogue }>): PreviewCatalogueCache {
  return { connections, loads };
}

describe("previewCatalogues", () => {
  test("an empty snapshot yields no catalogues", () => {
    expect(previewCatalogues({ connections: [], loads: [] })).toEqual([]);
  });

  test("loads whose connection is not in the snapshot are skipped until the list arrives", () => {
    const snapshot = cache([], [{ connectionId: "conn_1", catalogue: catalogue("acme/a") }]);
    expect(previewCatalogues(snapshot)).toEqual([]);
  });

  test("each load maps to its connection's provider", () => {
    const snapshot = cache(
      [connection("conn_1", "openrouter"), connection("conn_2", "meta")],
      [
        { connectionId: "conn_1", catalogue: catalogue("acme/a") },
        { connectionId: "conn_2", catalogue: catalogue("acme/b") }
      ]
    );
    const result = previewCatalogues(snapshot);
    expect(result.map((entry) => entry.provider)).toEqual(["openrouter", "meta"]);
    expect(result[0]?.catalogue.models.map((m) => m.id)).toEqual(["acme/a"]);
    expect(result[1]?.catalogue.models.map((m) => m.id)).toEqual(["acme/b"]);
  });

  test("the last successful load per provider wins, in place, and models are never merged", () => {
    const snapshot = cache(
      [connection("conn_1", "openrouter"), connection("conn_2", "openrouter"), connection("conn_3", "meta")],
      [
        { connectionId: "conn_1", catalogue: catalogue("acme/first") },
        { connectionId: "conn_3", catalogue: catalogue("meta/only") },
        { connectionId: "conn_2", catalogue: catalogue("acme/second") }
      ]
    );
    const result = previewCatalogues(snapshot);
    // Provider order is first-seen; the later load replaced the earlier one in place.
    expect(result.map((entry) => entry.provider)).toEqual(["openrouter", "meta"]);
    expect(result[0]?.catalogue.models.map((m) => m.id)).toEqual(["acme/second"]);
    expect(result[1]?.catalogue.models.map((m) => m.id)).toEqual(["meta/only"]);
  });

  test("loads without a readable model list are skipped", () => {
    const snapshot = cache(
      [connection("conn_1", "openrouter")],
      [{ connectionId: "conn_1", catalogue: { fetchedAt: FRESH_AT } as unknown as Catalogue }]
    );
    expect(previewCatalogues(snapshot)).toEqual([]);
  });

  test("a provider whose catalogue holds zero models is still one entry", () => {
    const snapshot = cache(
      [connection("conn_1", "openrouter")],
      [{ connectionId: "conn_1", catalogue: { models: [], fetchedAt: FRESH_AT } }]
    );
    const result = previewCatalogues(snapshot);
    expect(result).toHaveLength(1);
    expect(result[0]?.catalogue.models).toEqual([]);
  });
});

describe("usableConnectionsFor", () => {
  test("returns only the provider's usable connections, in snapshot order", () => {
    const connections = [
      connection("conn_a", "openrouter"),
      connection("conn_b", "meta"),
      connection("conn_c", "openrouter", false),
      connection("conn_d", "openrouter", true)
    ];
    expect(usableConnectionsFor(connections, "openrouter").map((item) => item.id)).toEqual(["conn_a", "conn_d"]);
  });

  test("an unusable plan alone leaves nothing usable", () => {
    const connections = [connection("conn_c", "openrouter", false)];
    expect(usableConnectionsFor(connections, "openrouter")).toEqual([]);
  });

  test("an empty snapshot yields nothing", () => {
    expect(usableConnectionsFor([], "openrouter")).toEqual([]);
  });
});
