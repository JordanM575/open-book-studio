/// <reference types="bun" />
import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from "bun:test";
import React from "react";
import type { RenderResult } from "@testing-library/react";
import type { ModelInfo } from "@ai-book-studio/core/providers/types";
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

function data(overrides: Partial<TaskPreviewData> = {}): TaskPreviewData {
  return {
    profiles: [
      { id: "drafting", name: "Drafting", purpose: "Turn notes into prose.", version: 1, requirements: { requiresTools: true, requiresKnownContext: true, minContextLength: 32000 } },
      { id: "notes", name: "Notes", purpose: "Sketch without tools.", version: 1, requirements: { requiresTools: false, requiresKnownContext: false } }
    ],
    catalogues: [
      {
        provider: "openrouter",
        catalogue: { models: [model({ id: "acme/large" })], fetchedAt: FRESH_AT }
      },
      {
        provider: "meta",
        catalogue: { models: [model({ id: "muse-spark-1.3", contextLength: 1048576 })], fetchedAt: STALE_AT }
      }
    ],
    connections: [
      { id: "conn_test01", provider: "openrouter", label: "Test key", kind: "api-key", createdAt: "2026-11-01T00:00:00.000Z" },
      { id: "conn_test02", provider: "meta", label: "Meta key", kind: "api-key", createdAt: "2026-11-01T00:00:00.000Z" }
    ],
    build: "desktop",
    ...overrides
  };
}

function openPreview(input: TaskPreviewData) {
  const onClose = mock(() => {});
  const onOpenModelPicker = mock(() => {});
  const view = testing.render(
    React.createElement(TaskPreviewDialog, { open: true, data: input, now: NOW, onClose, onOpenModelPicker })
  );
  return { view, onClose, onOpenModelPicker };
}

function manualFlowButtons(view: RenderResult): void {
  expect(view.getByText("Close")).toBeDefined();
  const picker = view.getByTestId("task-preview-open-picker");
  expect((picker as HTMLButtonElement).disabled).toBe(false);
}

describe("task preview states", () => {
  test("no catalogues say what is unknown and keep the manual flow", async () => {
    const { view } = openPreview(data({ catalogues: [] }));
    await testing.within(document.body).findByTestId("task-preview");
    // The refusal is visible before any profile is chosen.
    const immediate = await testing.within(document.body).findByTestId("task-preview-no-catalogues");
    expect(immediate.textContent).toContain("No model list is loaded yet.");
    await testing.act(async () => {
      await testing.fireEvent.click(view.getByText("Drafting"));
    });
    const panel = testing.within(document.body).findByTestId("task-preview-no-catalogues");
    expect((await panel).textContent).toContain("This preview uses only a model list the model picker has already loaded.");
    expect((await panel).textContent).toContain("It never fetches one.");
    manualFlowButtons(view);
    expect(view.queryByRole("button", { name: /refresh|retry|try again/i })).toBeNull();
  });

  test("a stale catalogue is labelled without blocking the matches", async () => {
    const { view } = openPreview(data());
    await testing.within(document.body).findByTestId("task-preview");
    await testing.act(async () => {
      await testing.fireEvent.click(view.getByText("Drafting"));
    });
    const banner = await testing.within(document.body).findByTestId("task-preview-stale");
    expect(banner.textContent).toContain("It is unknown whether newer data would change these matches.");
    expect(view.getByTestId("task-preview-candidates")).toBeDefined();
    manualFlowButtons(view);
  });

  test("unreadable catalogue data is malformed, not guessed", async () => {
    const broken = data({
      catalogues: [{ provider: "openrouter", catalogue: { models: "nope", fetchedAt: null } }] as unknown as TaskPreviewData["catalogues"]
    });
    const { view } = openPreview(broken);
    await testing.within(document.body).findByTestId("task-preview");
    await testing.act(async () => {
      await testing.fireEvent.click(view.getByText("Drafting"));
    });
    const panel = testing.within(document.body).findByTestId("task-preview-malformed");
    expect((await panel).textContent).toContain("The catalogue data could not be read.");
    manualFlowButtons(view);
    expect(view.queryByRole("button", { name: /refresh|retry|try again/i })).toBeNull();
  });

  test("empty catalogues are no candidates, not no suitable", async () => {
    const { view } = openPreview(
      data({ catalogues: [{ provider: "openrouter", catalogue: { models: [], fetchedAt: FRESH_AT } }] })
    );
    await testing.within(document.body).findByTestId("task-preview");
    await testing.act(async () => {
      await testing.fireEvent.click(view.getByText("Drafting"));
    });
    const panel = await testing.within(document.body).findByTestId("task-preview-no-candidates");
    expect(panel.textContent).toContain("The catalogues hold no models to evaluate");
    expect(view.queryByText("No suitable candidate known.")).toBeNull();
    manualFlowButtons(view);
  });

  test("an unreadable profile is an error, not a silent empty", async () => {
    const { view } = openPreview(
      data({
        profiles: [{ id: "bad", name: "", purpose: "Broken fixture.", version: 0, requirements: { requiresTools: true } }]
      })
    );
    await testing.within(document.body).findByTestId("task-preview");
    await testing.act(async () => {
      await testing.fireEvent.click(view.getByText("Broken fixture."));
    });
    const panel = await testing.within(document.body).findByTestId("task-preview-error");
    expect(panel.textContent).toContain("This task profile could not be read.");
    manualFlowButtons(view);
    expect(view.queryByRole("button", { name: /refresh|retry|try again|use this model/i })).toBeNull();
  });
});
