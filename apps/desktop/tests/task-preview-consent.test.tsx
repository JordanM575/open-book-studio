/// <reference types="bun" />
import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from "bun:test";
import React from "react";
import { CONTRIBUTOR_WARNING } from "@ai-book-studio/core/providers/compatibility";
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
    contextLength: 1048576,
    supportsTools: true,
    supportsImages: true,
    inputPricePerMillion: 0.1,
    outputPricePerMillion: 0.2,
    ...overrides
  };
}

function previewData(): TaskPreviewData {
  return {
    profiles: [
      { id: "drafting", name: "Drafting", purpose: "Turn notes into prose.", version: 1, requirements: { requiresTools: true, requiresKnownContext: true, minContextLength: 32000 } }
    ],
    catalogues: [
      {
        provider: "meta",
        catalogue: {
          models: [model({ id: "muse-spark-1.3-contributor", trainingOnData: true })],
          fetchedAt: FRESH_AT
        }
      }
    ],
    connections: [
      { id: "conn_test01", provider: "meta", label: "Meta key", kind: "api-key", createdAt: "2026-11-01T00:00:00.000Z" }
    ],
    build: "desktop"
  };
}

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

/**
 * Previewing a Contributor candidate must never write or infer the book-level training-consent
 * flag. The existing spec 022 warning stays visible, and the 022 picker guard and pre-request
 * refusal remain the only places consent can change — both outside this surface.
 */
describe("task preview consent", () => {
  test("a Contributor candidate shows the existing warning and touches neither consent nor bridge", async () => {
    const book = { id: "book_test0001", allowContributorTraining: false };
    const calls: string[] = [];
    const studio = (globalThis as unknown as { window: { studio: unknown } }).window;
    const savedStudio = studio.studio;
    studio.studio = throwingBridge(calls);
    try {
      const view = testing.render(
        React.createElement(TaskPreviewDialog, {
          open: true,
          data: previewData(),
          now: NOW,
          onClose: mock(() => {}),
          onOpenModelPicker: mock(() => {}),
          onUseForNextMessage: mock(() => {})
        })
      );
      await testing.within(document.body).findByTestId("task-preview");
      await testing.act(async () => {
        await testing.fireEvent.click(view.getByText("Drafting"));
      });
      expect(view.getByText(CONTRIBUTOR_WARNING)).toBeDefined();
      // The candidate is eligible, so the handoff action is offered — and only delegates.
      const action = view.getByTestId("task-preview-use-next");
      expect(action.textContent).toBe("Use for next message");
      expect(view.queryByRole("checkbox")).toBeNull();
      expect(view.queryByRole("switch")).toBeNull();
      expect(book.allowContributorTraining).toBe(false);
      expect(calls).toEqual([]);
    } finally {
      studio.studio = savedStudio;
    }
  });
});
