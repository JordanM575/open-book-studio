/// <reference types="bun" />
import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from "bun:test";
import React from "react";
import type { BookMeta } from "@ai-book-studio/core/schema";
import type { ModelInfo } from "@ai-book-studio/core/providers/types";
import type { TaskPreviewData } from "@ai-book-studio/app/components/TaskPreviewDialog";
import { mountDom, unmountDom } from "./support/dom";

const NOW = Date.parse("2026-11-03T12:00:00.000Z");
const FRESH_AT = new Date(NOW - 5 * 60_000).toISOString();

let testing!: typeof import("@testing-library/react/pure");
let TaskPreviewDialog!: typeof import("@ai-book-studio/app/components/TaskPreviewDialog").TaskPreviewDialog;
let ModelPickerDialog!: typeof import("@ai-book-studio/app/components/ModelPickerDialog").ModelPickerDialog;

beforeAll(async () => {
  testing = await mountDom();
  ({ TaskPreviewDialog } = await import("@ai-book-studio/app/components/TaskPreviewDialog"));
  ({ ModelPickerDialog } = await import("@ai-book-studio/app/components/ModelPickerDialog"));
});
afterAll(async () => {
  await unmountDom();
});
afterEach(() => testing.cleanup());

function model(overrides: Partial<ModelInfo> & { id: string }): ModelInfo {
  return {
    name: overrides.id,
    contextLength: 128000,
    supportsTools: true,
    supportsImages: false,
    inputPricePerMillion: 1.25,
    outputPricePerMillion: 5,
    ...overrides
  };
}

function previewData(): TaskPreviewData {
  return {
    profiles: [
      { id: "drafting", name: "Drafting", purpose: "Turn notes into prose.", version: 1, requirements: { requiresTools: true, requiresKnownContext: true, minContextLength: 32000 } },
      { id: "notes", name: "Notes", purpose: "Sketch without tools.", version: 1, requirements: { requiresTools: false, requiresKnownContext: false } }
    ],
    catalogues: [
      { provider: "openrouter", catalogue: { models: [model({ id: "acme/large" })], fetchedAt: FRESH_AT } }
    ],
    connections: [
      { id: "conn_test01", provider: "openrouter", label: "Test key", kind: "api-key", createdAt: "2026-11-01T00:00:00.000Z" }
    ],
    build: "desktop"
  };
}

/** Records every bridge path touched. Any touch throws, so a silent component stays silent. */
function throwingBridge(log: string[], path = "window.studio"): unknown {
  const target = (): void => {};
  return new Proxy(target, {
    get(_t, prop) {
      if (typeof prop !== "string") return undefined;
      if (prop === "then") return undefined;
      const next = `${path}.${prop}`;
      log.push(next);
      return throwingBridge(log, next);
    },
    apply() {
      log.push(`${path}()`);
      throw new Error(`preview must not call ${path}`);
    }
  });
}

describe("task preview calls", () => {
  test("the no-cache state renders without touching the bridge or fetch", async () => {
    const calls: string[] = [];
    const studio = (globalThis as unknown as { window: { studio: unknown } }).window;
    const savedStudio = studio.studio;
    const savedFetch = globalThis.fetch;
    const fetched: string[] = [];
    studio.studio = throwingBridge(calls);
    (globalThis as unknown as { fetch: unknown }).fetch = (...args: unknown[]) => {
      fetched.push(String(args[0]));
      throw new Error("preview must not fetch");
    };
    try {
      const view = testing.render(
        React.createElement(TaskPreviewDialog, {
          open: true,
          data: { ...previewData(), catalogues: [] },
          now: NOW,
          onClose: mock(() => {}),
          onOpenModelPicker: mock(() => {})
        })
      );
      await testing.within(document.body).findByTestId("task-preview-no-catalogues");
      expect(view.getByText("No model list is loaded yet.")).toBeDefined();
      expect(calls).toEqual([]);
      expect(fetched).toEqual([]);
    } finally {
      studio.studio = savedStudio;
      globalThis.fetch = savedFetch;
    }
  });

  test("the per-candidate action fires once with the provider and model id and nothing else", async () => {
    const calls: string[] = [];
    const studio = (globalThis as unknown as { window: { studio: unknown } }).window;
    const savedStudio = studio.studio;
    const savedFetch = globalThis.fetch;
    const fetched: string[] = [];
    studio.studio = throwingBridge(calls);
    (globalThis as unknown as { fetch: unknown }).fetch = (...args: unknown[]) => {
      fetched.push(String(args[0]));
      throw new Error("preview must not fetch");
    };
    const received: Array<{ provider: string; modelId: string }> = [];
    try {
      const view = testing.render(
        React.createElement(TaskPreviewDialog, {
          open: true,
          data: previewData(),
          now: NOW,
          onClose: mock(() => {}),
          onOpenModelPicker: mock(() => {}),
          onUseForNextMessage: (candidate: { provider: string; modelId: string }) => received.push(candidate)
        })
      );
      await testing.within(document.body).findByTestId("task-preview");
      await testing.act(async () => {
        await testing.fireEvent.click(view.getByText("Drafting"));
      });
      await testing.act(async () => {
        await testing.fireEvent.click(view.getByTestId("task-preview-use-next"));
      });
      expect(received).toEqual([{ provider: "openrouter", modelId: "acme/large" }]);
      expect(Object.keys(received[0] ?? {}).sort()).toEqual(["modelId", "provider"]);
      expect(calls).toEqual([]);
      expect(fetched).toEqual([]);
    } finally {
      studio.studio = savedStudio;
      globalThis.fetch = savedFetch;
    }
  });

  test("open, change, picker path and close touch no bridge surface and fetch nothing", async () => {
    const calls: string[] = [];
    const studio = (globalThis as unknown as { window: { studio: unknown } }).window;
    const savedStudio = studio.studio;
    const savedFetch = globalThis.fetch;
    const fetched: string[] = [];
    studio.studio = throwingBridge(calls);
    (globalThis as unknown as { fetch: unknown }).fetch = (...args: unknown[]) => {
      fetched.push(String(args[0]));
      throw new Error("preview must not fetch");
    };
    try {
      const onClose = mock(() => {});
      const onOpenModelPicker = mock(() => {});
      const view = testing.render(
        React.createElement(TaskPreviewDialog, { open: true, data: previewData(), now: NOW, onClose, onOpenModelPicker })
      );
      await testing.within(document.body).findByTestId("task-preview");
      await testing.act(async () => {
        await testing.fireEvent.click(view.getByText("Drafting"));
      });
      await testing.act(async () => {
        await testing.fireEvent.click(view.getByText("Notes"));
      });
      await testing.act(async () => {
        await testing.fireEvent.click(view.getByTestId("task-preview-open-picker"));
      });
      await testing.act(async () => {
        await testing.fireEvent.click(view.getByText("Close"));
      });
      expect(onClose).toHaveBeenCalledTimes(1);
      expect(onOpenModelPicker).toHaveBeenCalledTimes(1);
      expect(calls).toEqual([]);
      expect(fetched).toEqual([]);
    } finally {
      studio.studio = savedStudio;
      globalThis.fetch = savedFetch;
    }
  });

  test("the spy observes real bridge traffic: the existing picker lists providers", async () => {
    const calls: string[] = [];
    const studio = (globalThis as unknown as { window: { studio: unknown } }).window;
    const savedStudio = studio.studio;
    studio.studio = {
      providers: {
        list: mock(async () => {
          calls.push("providers.list");
          return { ok: true, data: [] };
        }),
        models: mock(async () => ({ ok: true, data: { models: [], fetchedAt: null } }))
      },
      connections: {
        list: mock(async () => {
          calls.push("connections.list");
          return { ok: true, data: [] };
        })
      }
    };
    try {
      const book = {
        id: "book_test0001",
        defaultConnectionId: null,
        defaultModelId: null,
        allowContributorTraining: false
      } as unknown as BookMeta;
      testing.render(
        React.createElement(ModelPickerDialog, { open: true, book, onClose: () => {} })
      );
      await testing.within(document.body).findByText("Model for this book");
      expect(calls).toContain("providers.list");
      expect(calls).toContain("connections.list");
    } finally {
      studio.studio = savedStudio;
    }
  });
});
