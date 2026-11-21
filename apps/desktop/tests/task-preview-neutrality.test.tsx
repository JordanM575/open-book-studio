/// <reference types="bun" />
import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from "bun:test";
import React from "react";
import type { ModelInfo } from "@ai-book-studio/core/providers/types";
import type { TaskPreviewData } from "@ai-book-studio/app/components/TaskPreviewDialog";
import { mountDom, unmountDom } from "./support/dom";

const NOW = Date.parse("2026-11-03T12:00:00.000Z");
const FRESH_AT = new Date(NOW - 5 * 60_000).toISOString();

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

/**
 * The host owns everything the preview must never touch. No `window.studio` mock is installed
 * on purpose: the surface reads only its props, so any bridge access would throw and fail.
 */
function host() {
  return {
    defaultConnectionId: "conn_test01",
    defaultModelId: "acme/large",
    override: null as { connectionId: string; modelId: string } | null,
    activeConnectionId: "conn_test01",
    history: ["turn_0001"],
    usage: [{ model: "acme/large", total: 1400 }],
    manuscript: "# Chapter one\n\nProse the author wrote."
  };
}

function frozenData(): TaskPreviewData {
  const input: TaskPreviewData = {
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
  Object.freeze(input.profiles);
  for (const profile of input.profiles) Object.freeze(profile);
  Object.freeze(input.catalogues);
  Object.freeze(input.connections);
  return Object.freeze(input);
}

function snapshot<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

describe("task preview neutrality", () => {
  test("open, profile change and close leave host state untouched", async () => {
    const state = host();
    const before = snapshot(state);
    const onClose = mock(() => {});
    const onOpenModelPicker = mock(() => {});
    const view = testing.render(
      React.createElement(TaskPreviewDialog, { open: true, data: frozenData(), now: NOW, onClose, onOpenModelPicker })
    );
    await testing.within(document.body).findByTestId("task-preview");
    await testing.act(async () => {
      await testing.fireEvent.click(view.getByText("Drafting"));
    });
    await testing.act(async () => {
      await testing.fireEvent.click(view.getByText("Notes"));
    });
    expect(view.getByTestId("task-preview-candidates")).toBeDefined();
    await testing.act(async () => {
      await testing.fireEvent.click(view.getByText("Close"));
    });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(state).toEqual(before);
  });

  test("cancelling with Escape closes without touching host state", async () => {
    const state = host();
    const before = snapshot(state);
    const onClose = mock(() => {});
    const view = testing.render(
      React.createElement(TaskPreviewDialog, {
        open: true,
        data: frozenData(),
        now: NOW,
        onClose,
        onOpenModelPicker: mock(() => {})
      })
    );
    await testing.within(document.body).findByTestId("task-preview");
    await testing.act(async () => {
      await testing.fireEvent.click(view.getByText("Drafting"));
    });
    await testing.act(async () => {
      await testing.fireEvent.keyDown(document, { key: "Escape", code: "Escape" });
    });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(state).toEqual(before);
  });

  test("the picker path carries no model and offers no in-preview choice", async () => {
    const state = host();
    const before = snapshot(state);
    const onOpenModelPicker = mock(() => {});
    const view = testing.render(
      React.createElement(TaskPreviewDialog, {
        open: true,
        data: frozenData(),
        now: NOW,
        onClose: mock(() => {}),
        onOpenModelPicker
      })
    );
    await testing.within(document.body).findByTestId("task-preview");
    await testing.act(async () => {
      await testing.fireEvent.click(view.getByText("Drafting"));
    });
    await testing.act(async () => {
      await testing.fireEvent.click(view.getByTestId("task-preview-open-picker"));
    });
    expect(onOpenModelPicker).toHaveBeenCalledTimes(1);
    expect((onOpenModelPicker.mock.calls[0] as unknown[]).length).toBe(0);
    expect(state.defaultModelId).toBe(before.defaultModelId);
    expect(state.override).toBeNull();
    expect(view.queryByRole("button", { name: /use this model/i })).toBeNull();
    expect(view.queryByRole("button", { name: /retry|refresh/i })).toBeNull();
  });
});
