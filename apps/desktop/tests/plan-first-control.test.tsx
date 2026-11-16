/// <reference types="bun" />
import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from "bun:test";
import React from "react";
import { mountDom, unmountDom } from "./support/dom";
import { PLAN_GUIDANCE_LIMIT, type ManuscriptWriter } from "@ai-book-studio/core/agent/proposed-plan";
import type { AgentMode } from "@ai-book-studio/core/agent/messages";

let testing!: typeof import("@testing-library/react/pure");
let PlanFirstControl!: typeof import("@ai-book-studio/app/components/PlanFirstControl").PlanFirstControl;
let ChatPanel!: typeof import("@ai-book-studio/app/components/ChatPanel").ChatPanel;

beforeAll(async () => {
  testing = await mountDom();
  ({ PlanFirstControl } = await import("@ai-book-studio/app/components/PlanFirstControl"));
  ({ ChatPanel } = await import("@ai-book-studio/app/components/ChatPanel"));
});
afterAll(async () => {
  await unmountDom();
});
afterEach(() => testing.cleanup());

/**
 * Plan first is a visible Edit control over the pure proposal contract.
 * Create, refresh, and start intent must not call the supplied writer.
 */

function countingWriter(): { writer: ManuscriptWriter; write: ReturnType<typeof mock> } {
  const write = mock((request: unknown): never => {
    throw new Error(`writer called with ${JSON.stringify(request)}`);
  });
  return { writer: { write }, write };
}

function renderPlan(options?: {
  mode?: AgentMode;
  running?: boolean;
  modelLabel?: string;
  writer?: ManuscriptWriter;
}) {
  const pen = options?.writer ? null : countingWriter();
  const writer = options?.writer ?? pen?.writer;
  if (!writer) throw new Error("missing writer");
  const props = {
    mode: options?.mode ?? "edit" as AgentMode,
    running: options?.running ?? false,
    writer,
    modelLabel: options?.modelLabel ?? "Model: book default"
  };
  const view = testing.render(React.createElement(PlanFirstControl, props));
  return {
    ...view,
    write: pen?.write ?? null,
    rerenderWith(next: Partial<typeof props>) {
      view.rerender(React.createElement(PlanFirstControl, { ...props, ...next }));
    }
  };
}

function fillPlan(view: ReturnType<typeof testing.within>, purpose: string, steps: readonly string[], guidance?: string): void {
  testing.fireEvent.change(view.getByTestId("plan-purpose"), { target: { value: purpose } });
  const first = view.getAllByTestId("plan-step")[0];
  if (!first) throw new Error("missing step");
  testing.fireEvent.change(first, { target: { value: steps[0] ?? "" } });
  for (let index = 1; index < steps.length; index += 1) {
    testing.fireEvent.click(view.getByRole("button", { name: "Add step" }));
    const field = view.getAllByTestId("plan-step")[index];
    if (!field) throw new Error("missing added step");
    testing.fireEvent.change(field, { target: { value: steps[index] ?? "" } });
  }
  if (guidance !== undefined) {
    testing.fireEvent.change(view.getByTestId("plan-guidance"), { target: { value: guidance } });
  }
}

describe("plan first control", () => {
  test("proposes, refreshes, and names a start intent without calling the writer", () => {
    const { write, ...rendered } = renderPlan();
    const view = testing.within(document.body);
    fillPlan(view, "Revise the opening chapter", ["Name the chapter", "Revise the opening"], "Keep the names");
    testing.fireEvent.click(view.getByTestId("plan-propose"));

    const created = testing.within(view.getByTestId("plan-current"));
    expect(created.getByTestId("plan-revision").textContent).toBe("Revision 1");
    expect(created.getByTestId("plan-mode").textContent).toBe("Edit");
    expect(created.getByTestId("plan-model").textContent).toBe("Model: book default");
    expect(created.getByTestId("plan-purpose-text").textContent).toBe("Revise the opening chapter");
    expect(created.getAllByTestId("plan-step-text").map((node) => node.textContent)).toEqual([
      "Name the chapter",
      "Revise the opening"
    ]);
    expect(created.getAllByTestId("plan-step-state").map((node) => node.getAttribute("data-state"))).toEqual([
      "pending",
      "pending"
    ]);
    expect(created.getByTestId("plan-guidance-text").textContent).toBe("Keep the names");
    expect(created.getByTestId("plan-start")).toBeDefined();
    expect(view.queryByTestId("plan-previous")).toBeNull();
    expect(view.queryByRole("button", { name: "Pause" })).toBeNull();
    expect(view.queryByRole("button", { name: "Resume" })).toBeNull();
    expect(view.queryByRole("button", { name: "Cancel" })).toBeNull();

    rendered.rerenderWith({ modelLabel: "This turn: other-model" });
    testing.fireEvent.change(view.getByTestId("plan-guidance"), { target: { value: "Shorter sentences" } });
    testing.fireEvent.click(view.getByTestId("plan-refresh"));

    const previous = testing.within(view.getByTestId("plan-previous"));
    const refreshed = testing.within(view.getByTestId("plan-current"));
    expect(previous.getByTestId("plan-revision").textContent).toBe("Revision 1");
    expect(previous.getByTestId("plan-guidance-text").textContent).toBe("Keep the names");
    expect(previous.getByTestId("plan-model").textContent).toBe("Model: book default");
    expect(previous.getByTestId("plan-purpose-text").textContent).toBe("Revise the opening chapter");
    expect(previous.queryByTestId("plan-start")).toBeNull();
    expect(previous.queryByTestId("plan-refresh")).toBeNull();
    expect(refreshed.getByTestId("plan-revision").textContent).toBe("Revision 2");
    expect(refreshed.getByTestId("plan-guidance-text").textContent).toBe("Shorter sentences");
    expect(refreshed.getByTestId("plan-model").textContent).toBe("Model: book default");
    expect(refreshed.getByTestId("plan-mode").textContent).toBe("Edit");
    expect(view.getByTestId("plan-turn-model").textContent).toBe("This turn: other-model");
    expect(view.getAllByTestId("plan-start")).toHaveLength(1);

    testing.fireEvent.click(refreshed.getByTestId("plan-start"));
    expect(view.getByTestId("plan-intent-turn").textContent).toBe("new");
    expect(view.getByTestId("plan-intent-proposal").textContent).toBe(refreshed.getByTestId("plan-id").textContent);
    expect(view.getByTestId("plan-intent-proposal").textContent).toBe(previous.getByTestId("plan-id").textContent);
    expect(view.getByTestId("plan-intent-revision").textContent).toBe("2");
    expect(view.getByTestId("plan-intent-approval").textContent).toBe("no");
    expect(write).not.toHaveBeenCalled();
  });

  test("omits blank guidance and keeps over-long guidance without a write", () => {
    const { write } = renderPlan();
    const view = testing.within(document.body);
    fillPlan(view, "Revise the opening chapter", ["Name the chapter"], " \n\t ");
    testing.fireEvent.click(view.getByTestId("plan-propose"));
    const created = testing.within(view.getByTestId("plan-current"));
    expect(created.getByTestId("plan-guidance-omitted").textContent).toBe("No guidance");
    expect(view.getByTestId("plan-guidance")).toHaveProperty("value", " \n\t ");

    const tooLong = "g".repeat(PLAN_GUIDANCE_LIMIT + 1);
    testing.fireEvent.change(view.getByTestId("plan-guidance"), { target: { value: tooLong } });
    testing.fireEvent.click(view.getByTestId("plan-refresh"));
    expect(view.getByTestId("plan-refusal").textContent).toBe("Shorten guidance to 2,000 characters. Your text is kept.");
    expect(view.getByTestId("plan-guidance")).toHaveProperty("value", tooLong);
    expect(tooLong.length).toBe(PLAN_GUIDANCE_LIMIT + 1);
    expect(created.getByTestId("plan-revision").textContent).toBe("Revision 1");
    expect(created.queryByTestId("plan-guidance-text")).toBeNull();
    expect(view.queryByTestId("plan-previous")).toBeNull();
    expect(view.queryByTestId("plan-start-intent")).toBeNull();
    expect(write).not.toHaveBeenCalled();
  });

  test("refuses Discuss and does not refresh a running turn", () => {
    const discuss = renderPlan({ mode: "discuss" });
    const view = testing.within(document.body);
    fillPlan(view, "Revise the opening chapter", ["Name the chapter"], "Keep the names");
    testing.fireEvent.click(view.getByTestId("plan-propose"));
    expect(view.getByTestId("plan-refusal").textContent).toBe("Plan first is only available for an Edit turn.");
    expect(view.queryByTestId("plan-current")).toBeNull();
    expect(discuss.write).not.toHaveBeenCalled();
    testing.cleanup();

    const running = renderPlan();
    const again = testing.within(document.body);
    fillPlan(again, "Revise the opening chapter", ["Name the chapter"]);
    testing.fireEvent.click(again.getByTestId("plan-propose"));
    running.rerenderWith({ running: true, modelLabel: "This turn: other-model" });
    expect(again.getByTestId("plan-guidance")).toHaveProperty("disabled", true);
    expect(again.getByTestId("plan-refresh")).toHaveProperty("disabled", true);
    expect(again.getByTestId("plan-propose")).toHaveProperty("disabled", true);
    expect(again.getByTestId("plan-start")).toHaveProperty("disabled", true);
    testing.fireEvent.change(again.getByTestId("plan-guidance"), { target: { value: "Do not apply" } });
    testing.fireEvent.click(again.getByTestId("plan-refresh"));
    const current = testing.within(again.getByTestId("plan-current"));
    expect(current.getByTestId("plan-revision").textContent).toBe("Revision 1");
    expect(current.getByTestId("plan-guidance-omitted")).toBeDefined();
    expect(current.getByTestId("plan-model").textContent).toBe("Model: book default");
    expect(again.queryByTestId("plan-previous")).toBeNull();
    expect(running.write).not.toHaveBeenCalled();
  });

  test("the composer mounts Plan first only for Edit and does not start a turn", async () => {
    const start = mock(() => Promise.resolve({ ok: true, data: { turnId: "turn_plan", threadId: "thread_plan" } }));
    (globalThis as unknown as { window: { studio: unknown } }).window.studio = {
      platform: "darwin",
      agent: {
        threads: {
          list: mock(() => Promise.resolve({ ok: true, data: [] })),
          read: mock(() => Promise.resolve({ ok: true, data: null })),
          fork: mock(() => Promise.resolve({ ok: true, data: null })),
          remove: mock(() => Promise.resolve({ ok: true, data: null })),
          rename: mock(() => Promise.resolve({ ok: true, data: null }))
        },
        start,
        stop: mock(() => Promise.resolve({ ok: true, data: null })),
        approve: mock(() => Promise.resolve({ ok: true, data: null })),
        undoLast: mock(() => Promise.resolve({ ok: true, data: null })),
        onEvent: mock(() => () => {})
      }
    };
    testing.render(React.createElement(ChatPanel, {
      bookId: "book_plan000001",
      chapterId: "ch_plan000001",
      onClose: () => {},
      onBeforeSend: async () => {},
      onChanged: () => {},
      onReconnect: () => {},
      onChooseModel: () => {},
      onChooseTurnModel: () => {},
      turnModel: null,
      onTurnModelUsed: () => {},
      onNotice: () => {}
    }));
    const view = testing.within(document.body);
    expect(view.queryByTestId("plan-first")).toBeNull();
    testing.fireEvent.change(view.getByTestId("agent-mode"), { target: { value: "edit" } });
    const plan = testing.within(view.getByTestId("plan-first"));
    expect(plan.getByTestId("plan-turn-model").textContent).toBe("Model: book default");
    fillPlan(plan, "Revise the opening chapter", ["Name the chapter"], "Keep the names");
    expect(view.getByTestId("agent-guidance")).toHaveProperty("value", "");
    testing.fireEvent.click(plan.getByTestId("plan-propose"));
    testing.fireEvent.change(plan.getByTestId("plan-guidance"), { target: { value: "Shorter sentences" } });
    testing.fireEvent.click(plan.getByTestId("plan-refresh"));
    testing.fireEvent.click(plan.getByTestId("plan-start"));
    expect(plan.getByTestId("plan-intent-turn").textContent).toBe("new");
    expect(plan.getByTestId("plan-intent-approval").textContent).toBe("no");
    expect(view.getByTestId("agent-guidance")).toHaveProperty("value", "");
    expect(start).not.toHaveBeenCalled();
  });
});
