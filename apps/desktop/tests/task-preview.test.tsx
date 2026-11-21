/// <reference types="bun" />
import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from "bun:test";
import React from "react";
import type { ConnectionSummary, ModelInfo, ProviderId } from "@ai-book-studio/core/providers/types";
import type { TaskProfile } from "@ai-book-studio/core/routing";
import type { TaskPreviewData } from "@ai-book-studio/app/components/TaskPreviewDialog";
import { mountDom, unmountDom } from "./support/dom";

const NOW = Date.parse("2026-11-03T12:00:00.000Z");
const FRESH_AT = new Date(NOW - 5 * 60_000).toISOString();
const STALE_AT = new Date(NOW - 25 * 3_600_000).toISOString();

let testing!: typeof import("@testing-library/react/pure");
let TaskPreviewDialog!: typeof import("@ai-book-studio/app/components/TaskPreviewDialog").TaskPreviewDialog;

beforeAll(async () => {
  testing = await mountDom();
  ({ TaskPreviewDialog } = await import("@ai-book-studio/app/components/TaskPreviewDialog"));
});
afterAll(async () => {
  await unmountDom();
});
afterEach(() => testing.cleanup());

function profile(overrides: Partial<TaskProfile> & { id: string }): TaskProfile {
  return {
    name: overrides.id,
    purpose: "Fixture profile.",
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
    supportsImages: false,
    inputPricePerMillion: 1.25,
    outputPricePerMillion: 5,
    ...overrides
  };
}

function data(): TaskPreviewData {
  return {
    profiles: [
      profile({ id: "drafting", name: "Drafting" }),
      profile({ id: "art", name: "Art notes", requirements: { requiresTools: false, requiresImages: true, requiresKnownContext: false } })
    ],
    catalogues: [
      {
        provider: "openrouter",
        catalogue: {
          models: [
            model({ id: "acme/large" }),
            model({ id: "acme/chat", supportsTools: false, contextLength: 64000 }),
            model({ id: "acme/mystery", supportsTools: null, contextLength: null, inputPricePerMillion: null, outputPricePerMillion: null })
          ],
          fetchedAt: FRESH_AT
        }
      },
      {
        provider: "meta",
        catalogue: {
          models: [model({ id: "muse-spark-1.3-contributor", trainingOnData: true, contextLength: 1048576 })],
          fetchedAt: STALE_AT
        }
      }
    ],
    connections: [
      { id: "conn_test01", provider: "openrouter", label: "Test key", kind: "api-key", createdAt: "2026-11-01T00:00:00.000Z" },
      { id: "conn_test02", provider: "meta", label: "Meta key", kind: "api-key", createdAt: "2026-11-01T00:00:00.000Z" }
    ] as ConnectionSummary[],
    build: "desktop"
  };
}

function renderPreview(
  extra: {
    now?: number;
    onOpenModelPicker?: () => void;
    open?: boolean;
    onUseForNextMessage?: (candidate: { provider: ProviderId; modelId: string }) => void;
  } = {}
) {
  const onClose = mock(() => {});
  const onOpenModelPicker = mock(extra.onOpenModelPicker ?? (() => {}));
  const onUseForNextMessage = extra.onUseForNextMessage ? mock(extra.onUseForNextMessage) : undefined;
  const view = testing.render(
    React.createElement(TaskPreviewDialog, {
      open: extra.open ?? true,
      data: data(),
      now: extra.now ?? NOW,
      onClose,
      onOpenModelPicker,
      ...(onUseForNextMessage ? { onUseForNextMessage } : {})
    })
  );
  return { view, onClose, onOpenModelPicker, onUseForNextMessage };
}

describe("task preview dialog", () => {
  test("asks for a task before showing candidates", async () => {
    const { view } = renderPreview();
    await testing.within(document.body).findByTestId("task-preview");
    expect(view.getByText("Choose a task to preview.")).toBeDefined();
    expect(view.queryByTestId("task-preview-candidates")).toBeNull();
  });

  test("a chosen profile shows unranked candidates with statuses and reasons", async () => {
    const { view } = renderPreview();
    await testing.within(document.body).findByTestId("task-preview");
    await testing.act(async () => {
      await testing.fireEvent.click(view.getByText("Drafting"));
    });
    const list = view.getByTestId("task-preview-candidates");
    const text = list.textContent ?? "";
    const order = ["acme/large", "acme/chat", "acme/mystery", "muse-spark-1.3-contributor"];
    const indices = order.map((name) => text.indexOf(name));
    expect(indices.every((index) => index >= 0)).toBe(true);
    expect([...indices].sort((a, b) => a - b)).toEqual(indices);
    expect(view.getAllByText("Known capability match")).toHaveLength(2);
    expect(view.getByText("Does not meet known requirements")).toBeDefined();
    expect(view.getAllByText("Unknown")).toHaveLength(1);
    expect(view.getByText(/Unknown · Input: Unknown/)).toBeDefined();
    expect(view.getByText("This model cannot use tools, which the writing agent needs.")).toBeDefined();
    expect(view.getByText("This provider does not say whether the model supports tools.")).toBeDefined();
  });

  test("candidates show catalogue facts and freshness", async () => {
    const { view } = renderPreview();
    await testing.within(document.body).findByTestId("task-preview");
    await testing.act(async () => {
      await testing.fireEvent.click(view.getByText("Drafting"));
    });
    expect(view.getByText(/128,000 tokens \(catalogue\)/)).toBeDefined();
    expect(view.getAllByText(/Input: USD 1\.25 per million tokens/)).toHaveLength(3);
    expect(view.getAllByText("Checked 5 minutes ago.").length).toBeGreaterThan(0);
    expect(view.getByText(/This catalogue may be out of date\./)).toBeDefined();
    expect(view.getByText(/Contributor mode/)).toBeDefined();
  });

  test("no eligible candidate says so without hiding the reasons", async () => {
    const { view } = renderPreview();
    await testing.within(document.body).findByTestId("task-preview");
    await testing.act(async () => {
      await testing.fireEvent.click(view.getByText("Art notes"));
    });
    expect(view.getByText("No suitable candidate known.")).toBeDefined();
    expect(view.getAllByText("This model cannot use images, which this task needs.")).toHaveLength(4);
  });

  test("the candidates are labelled as an unranked catalogue order", async () => {
    const { view } = renderPreview();
    await testing.within(document.body).findByTestId("task-preview");
    await testing.act(async () => {
      await testing.fireEvent.click(view.getByText("Drafting"));
    });
    expect(await testing.within(document.body).findByTestId("task-preview-order-note")).toBeDefined();
    expect(view.getByText("Listed in catalogue order; this is not a ranking.")).toBeDefined();
    expect(view.getByTestId("task-preview-no-total").textContent).toContain("No total is shown because the request size is unknown.");
  });

  test("only eligible candidates offer the handoff action, with only provider and model id", async () => {
    const received: Array<{ provider: string; modelId: string }> = [];
    const { view } = renderPreview({ onUseForNextMessage: (candidate) => received.push(candidate) });
    await testing.within(document.body).findByTestId("task-preview");
    await testing.act(async () => {
      await testing.fireEvent.click(view.getByText("Drafting"));
    });
    const actions = view.getAllByTestId("task-preview-use-next");
    // acme/large (openrouter) and muse-spark-1.3-contributor (meta) are the eligible ones.
    expect(actions).toHaveLength(2);
    const first = actions[0];
    expect(first).toBeDefined();
    await testing.act(async () => {
      await testing.fireEvent.click(first as HTMLElement);
    });
    expect(received).toEqual([{ provider: "openrouter", modelId: "acme/large" }]);
    expect(Object.keys(received[0] ?? {}).sort()).toEqual(["modelId", "provider"]);
  });

  test("no action is offered when the host does not wire the handoff", async () => {
    const { view } = renderPreview();
    await testing.within(document.body).findByTestId("task-preview");
    await testing.act(async () => {
      await testing.fireEvent.click(view.getByText("Drafting"));
    });
    expect(view.queryByTestId("task-preview-use-next")).toBeNull();
  });

  test("the picker path calls back without choosing anything", async () => {
    const { view, onOpenModelPicker } = renderPreview();
    await testing.within(document.body).findByTestId("task-preview");
    await testing.act(async () => {
      await testing.fireEvent.click(view.getByText("Drafting"));
    });
    await testing.act(async () => {
      await testing.fireEvent.click(view.getByTestId("task-preview-open-picker"));
    });
    expect(onOpenModelPicker).toHaveBeenCalledTimes(1);
    expect(view.getByTestId("task-preview")).toBeDefined();
  });

  test("reopening forgets the chosen profile", async () => {
    const rendered = testing.render(
      React.createElement(TaskPreviewDialog, {
        open: true,
        data: data(),
        now: NOW,
        onClose: () => {},
        onOpenModelPicker: () => {}
      })
    );
    await testing.within(document.body).findByTestId("task-preview");
    await testing.act(async () => {
      await testing.fireEvent.click(rendered.getByText("Drafting"));
    });
    expect(rendered.getByTestId("task-preview-candidates")).toBeDefined();
    rendered.rerender(
      React.createElement(TaskPreviewDialog, {
        open: false,
        data: data(),
        now: NOW,
        onClose: () => {},
        onOpenModelPicker: () => {}
      })
    );
    rendered.rerender(
      React.createElement(TaskPreviewDialog, {
        open: true,
        data: data(),
        now: NOW,
        onClose: () => {},
        onOpenModelPicker: () => {}
      })
    );
    await testing.within(document.body).findByTestId("task-preview");
    expect(rendered.getByText("Choose a task to preview.")).toBeDefined();
    expect(rendered.queryByTestId("task-preview-candidates")).toBeNull();
  });

  test("no profiles says so honestly", async () => {
    const view = testing.render(
      React.createElement(TaskPreviewDialog, {
        open: true,
        data: { ...data(), profiles: [] },
        now: NOW,
        onClose: () => {},
        onOpenModelPicker: () => {}
      })
    );
    await testing.within(document.body).findByTestId("task-preview");
    expect(view.getByText("No task profiles are available yet.")).toBeDefined();
  });
});
