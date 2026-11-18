/// <reference types="bun" />
import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from "bun:test";
import React from "react";
import { mountDom, unmountDom } from "./support/dom";
import { agentThreadSchema, type AgentThread } from "@ai-book-studio/core/agent/messages";
import type { AgentEvent } from "@ai-book-studio/core/agent";

let testing!: typeof import("@testing-library/react/pure");
let ChatPanel!: typeof import("@ai-book-studio/app/components/ChatPanel").ChatPanel;

beforeAll(async () => {
  testing = await mountDom();
  ({ ChatPanel } = await import("@ai-book-studio/app/components/ChatPanel"));
});
afterAll(async () => {
  await unmountDom();
});

afterEach(() => testing.cleanup());

/**
 * Chat composer behavior (spec 012 T012): the author types, sends with Enter,
 * keeps newlines with Shift+Enter, and sees exactly what the run will carry.
 */

const AT = "2026-01-01T00:00:00.000Z";
const BOOK = "book_cmp000001";
const CHAPTER = "ch_cmp000001";

interface ComposerMocks {
  start: ReturnType<typeof mock>;
  onTurnModelUsed: ReturnType<typeof mock>;
  onChanged: ReturnType<typeof mock>;
}

function emptyThread() {
  return agentThreadSchema.parse({
    schemaVersion: 1,
    id: "thread_cmp000001",
    bookId: BOOK,
    title: "A short conversation",
    createdAt: AT,
    updatedAt: AT,
    messages: [],
    checkpointTurns: []
  });
}

function renderComposer(
  turnModel: { connectionId: string; modelId: string } | null = null,
  startImpl: ((_request: unknown) => Promise<unknown>) | null = null,
  undoImpl: (() => Promise<unknown>) | null = null,
  seed: AgentThread | null = null
): ComposerMocks & {
  onChooseModel: ReturnType<typeof mock>;
  fire: (event: AgentEvent) => void;
  undoLast: ReturnType<typeof mock>;
  approve: ReturnType<typeof mock>;
} {
  const start = mock(
    startImpl ??
      ((_request: unknown) =>
        Promise.resolve({ ok: true, data: { turnId: "turn_cmp000001", threadId: "thread_cmp000001" } }))
  );
  const onTurnModelUsed = mock(() => {});
  const onChanged = mock(() => {});
  const onChooseModel = mock(() => {});
  const undoLast = mock(undoImpl ?? (() => Promise.resolve({ ok: true, data: null })));
  const approve = mock(() => Promise.resolve({ ok: true, data: null }));
  let emit: ((event: AgentEvent) => void) | null = null;
  const listed = seed
    ? [
        {
          id: seed.id,
          title: seed.title,
          createdAt: AT,
          updatedAt: AT,
          messageCount: seed.messages.length,
          preview: ""
        }
      ]
    : [
        {
          id: "thread_cmp000001",
          title: "A short conversation",
          createdAt: AT,
          updatedAt: AT,
          messageCount: 0,
          preview: ""
        }
      ];
  (globalThis as unknown as { window: { studio: unknown } }).window.studio = {
    platform: "darwin",
    agent: {
      threads: {
        list: mock(() => Promise.resolve({ ok: true, data: listed })),
        read: mock(() => Promise.resolve({ ok: true, data: { thread: seed ?? emptyThread(), planRuntime: null } })),
        fork: mock(() => Promise.resolve({ ok: true, data: emptyThread() })),
        remove: mock(() => Promise.resolve({ ok: true, data: null })),
        rename: mock(() => Promise.resolve({ ok: true, data: null }))
      },
      start,
      stop: mock(() => Promise.resolve({ ok: true, data: null })),
      approve,
      undoLast,
      onEvent: mock((handler: (event: AgentEvent) => void) => {
        emit = handler;
        return () => {
          emit = null;
        };
      })
    }
  };
  testing.render(
    React.createElement(ChatPanel, {
      bookId: BOOK,
      chapterId: CHAPTER,
      onClose: () => {},
      onBeforeSend: async () => {},
      onChanged,
      onReconnect: () => {},
      onChooseModel,
      onChooseTurnModel: () => {},
      turnModel,
      onTurnModelUsed,
      onNotice: () => {}
    })
  );
  const fire = (event: AgentEvent): void => {
    emit?.(event);
  };
  return { start, onTurnModelUsed, onChanged, onChooseModel, fire, undoLast, approve };
}

function composer(): { input: HTMLElement; view: ReturnType<typeof testing.within> } {
  const view = testing.within(document.body);
  return { input: view.getByTestId("chat-input"), view };
}

describe("chat composer", () => {
  test("ordinary typed retry preserves the request and its words remain eligible for the next history", async () => {
    const { start } = renderComposer(null, async () => ({ ok: false, error: { code: "offline", message: "Synthetic offline" } }));
    const { input, view } = composer();
    await testing.act(async () => {
      testing.fireEvent.change(input, { target: { value: "Deliberately typed first request." } });
      testing.fireEvent.keyDown(input, { key: "Enter" });
    });
    await view.findByTestId("agent-retry-request");
    const first = start.mock.calls[0]?.[0];
    await testing.act(async () => testing.fireEvent.click(view.getByTestId("agent-retry-request")));
    expect(start).toHaveBeenCalledTimes(2);
    expect(start.mock.calls[1]?.[0]).toEqual(first);
    await view.findByTestId("chat-send");
    await testing.act(async () => {
      testing.fireEvent.change(input, { target: { value: "Separate typed request." } });
      testing.fireEvent.keyDown(input, { key: "Enter" });
    });
    await testing.waitFor(() => expect(start).toHaveBeenCalledTimes(3));
    expect(start.mock.calls[2]?.[0]).toMatchObject({ prompt: "Separate typed request.",
      history: [{ role: "user", text: "Deliberately typed first request." }] });
  });

  test("stop return keeps the composer stopping until the terminal receipt and shows persistence failure", async () => {
    const { start, fire } = renderComposer();
    const { input, view } = composer();
    testing.fireEvent.change(input, { target: { value: "Make a change" } });
    testing.fireEvent.keyDown(input, { key: "Enter" });
    await testing.waitFor(() => expect(view.getByTestId("chat-stop")).toBeDefined());
    await testing.act(async () => { testing.fireEvent.click(view.getByTestId("chat-stop")); });
    expect(view.getByText("Stopping… Waiting for in-flight work to settle.")).toBeDefined();
    expect(view.queryByTestId("chat-send")).toBeNull();
    testing.fireEvent.change(input, { target: { value: "Do not send yet" } });
    testing.fireEvent.keyDown(input, { key: "Enter" });
    expect(start).toHaveBeenCalledTimes(1);
    await testing.act(async () => {
      fire({ type: "stopped", turnId: "turn_cmp000001", changed: 1, undoAvailable: false,
        persistenceError: "The conversation outcome could not be fully saved. Changes to the book remain." });
    });
    expect(view.getByTestId("chat-send")).toBeDefined();
    expect(view.getByText(/Stopped · 1 chapter changed · no undo checkpoint/).textContent).toContain("could not be fully saved");
    expect(view.queryByText("Stopping… Waiting for in-flight work to settle.")).toBeNull();
  });

  test("Discuss is the default; Edit is explicit, fixed on retry, and reset for the next turn", async () => {
    const { start } = renderComposer(null, () => Promise.resolve({ ok: false, error: { code: "offline", message: "Synthetic offline" } }));
    const { input, view } = composer();
    const select = view.getByRole("combobox", { name: "Mode for next turn" }) as HTMLSelectElement;
    expect(select.value).toBe("discuss");
    select.focus();
    expect(document.activeElement).toBe(select);
    testing.fireEvent.change(select, { target: { value: "edit" } });
    testing.fireEvent.change(input, { target: { value: "Append a line" } });
    testing.fireEvent.change(view.getByTestId("agent-guidance"), { target: { value: "Plain words only" } });
    testing.fireEvent.keyDown(input, { key: "Enter" });
    await testing.waitFor(() => expect(view.getByTestId("agent-retry-request")).toBeDefined());
    expect(start.mock.calls[0]?.[0]).toMatchObject({ mode: "edit", guidance: "Plain words only" });
    expect(select.value).toBe("discuss");
    expect(view.getByTestId("agent-guidance")).toHaveProperty("value", "");
    expect(view.getAllByTestId("agent-message-mode").map((node: HTMLElement) => node.textContent)).toEqual(["Edit", "Edit"]);
    testing.fireEvent.click(view.getByTestId("agent-retry-request"));
    await testing.waitFor(() => expect(start).toHaveBeenCalledTimes(2));
    expect(start.mock.calls[1]?.[0]).toMatchObject({ mode: "edit", guidance: "Plain words only" });
    await testing.waitFor(() => expect(view.getByTestId("chat-send")).toBeDefined());
    testing.fireEvent.change(input, { target: { value: "Explain instead" } });
    testing.fireEvent.keyDown(input, { key: "Enter" });
    await testing.waitFor(() => expect(start).toHaveBeenCalledTimes(3));
    expect(start.mock.calls[2]?.[0]).toMatchObject({ mode: "discuss" });
    expect(start.mock.calls[2]?.[0]).not.toHaveProperty("guidance");
  });

  test("oversized guidance blocks both button and Enter without truncation, and exact limit sends", async () => {
    const { start } = renderComposer();
    const { input, view } = composer();
    const guidance = view.getByRole("textbox", { name: "Guidance for next turn", hidden: true });
    testing.fireEvent.change(input, { target: { value: "Read the opening" } });
    testing.fireEvent.change(guidance, { target: { value: "g".repeat(2001) } });
    expect(guidance).toHaveProperty("value", "g".repeat(2001));
    expect(guidance.getAttribute("aria-invalid")).toBe("true");
    expect(view.getByRole("alert").textContent).toContain("Your text is kept");
    expect(view.getByTestId("chat-send")).toHaveProperty("disabled", true);
    testing.fireEvent.keyDown(input, { key: "Enter" });
    expect(start).not.toHaveBeenCalled();
    testing.fireEvent.change(guidance, { target: { value: "g".repeat(2000) } });
    testing.fireEvent.keyDown(input, { key: "Enter" });
    await testing.waitFor(() => expect(start).toHaveBeenCalledTimes(1));
    expect(start.mock.calls[0]?.[0]).toMatchObject({ mode: "discuss", guidance: "g".repeat(2000) });
    expect(view.getByTestId("agent-mode")).toHaveProperty("disabled", true);
    expect(guidance).toHaveProperty("disabled", true);
  });

  test("stored modes and guidance remain inspectable and legacy turns are unrecorded", async () => {
    const seed = emptyThread();
    seed.messages = [
      { id: "msg_legacy01", role: "assistant", parts: [{ type: "text", text: "Old answer" }], createdAt: AT },
      { id: "msg_request1", role: "user", mode: "edit", parts: [{ type: "text", text: "Write" }, { type: "guidance", text: "Only that turn" }], createdAt: AT },
      { id: "msg_answer01", role: "assistant", mode: "edit", parts: [{ type: "text", text: "Written" }], createdAt: AT }
    ];
    renderComposer(null, null, null, seed);
    const { view } = composer();
    await testing.waitFor(() => expect(view.getByText("Old answer")).toBeDefined());
    expect(view.getAllByTestId("agent-message-mode").map((node: HTMLElement) => node.textContent)).toEqual(["Mode unrecorded", "Edit", "Edit"]);
    expect(view.getByText("Only that turn")).toBeDefined();
    expect(view.getByTestId("agent-guidance")).toHaveProperty("value", "");
    testing.fireEvent.change(view.getByTestId("agent-mode"), { target: { value: "edit" } });
    expect(view.getByText("Mode unrecorded")).toBeDefined();
    testing.fireEvent.change(view.getByTestId("agent-mode"), { target: { value: "discuss" } });
    expect(view.getAllByTestId("agent-message-mode").map((node: HTMLElement) => node.textContent)).toEqual(["Mode unrecorded", "Edit", "Edit"]);
  });

  test("send stays disabled until there is a prompt", async () => {
    renderComposer();
    const { input, view } = composer();
    await testing.waitFor(() => {
      expect(input).toBeTruthy();
    });
    expect(view.getByTestId("chat-send")).toHaveProperty("disabled", true);
    testing.fireEvent.change(input, { target: { value: "  " } });
    expect(view.getByTestId("chat-send")).toHaveProperty("disabled", true);
    testing.fireEvent.change(input, { target: { value: "Trim the opening." } });
    expect(view.getByTestId("chat-send")).toHaveProperty("disabled", false);
  });

  test("Enter sends the prompt, clears the box and shows the message", async () => {
    const { start } = renderComposer();
    const { input, view } = composer();
    await testing.waitFor(() => {
      expect(input).toBeTruthy();
    });
    testing.fireEvent.change(input, { target: { value: "Trim the opening." } });
    testing.fireEvent.keyDown(input, { key: "Enter", shiftKey: false });
    await testing.waitFor(() => {
      expect(start).toHaveBeenCalledTimes(1);
    });
    const request = start.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(request).toMatchObject({ bookId: BOOK, chapterId: CHAPTER, prompt: "Trim the opening.", history: [] });
    expect("model" in request).toBe(false);
    // The mounted panel reloaded the listed conversation, so the turn continues it.
    expect(request.threadId).toBe("thread_cmp000001");
    expect((input as HTMLTextAreaElement).value).toBe("");
    expect(view.getByText("Trim the opening.")).toBeTruthy();
  });

  test("a refused turn names the refusal and offers another model", async () => {
    const { onChooseModel } = renderComposer(null, () =>
      Promise.resolve({
        ok: false,
        error: { code: "refusal", message: "The provider's content policy declined this request." }
      })
    );
    const { input, view } = composer();
    testing.fireEvent.change(input, { target: { value: "Write something daring." } });
    testing.fireEvent.keyDown(input, { key: "Enter", shiftKey: false });

    await testing.waitFor(() =>
      expect(view.getByText("The provider's content policy declined this request.")).toBeDefined()
    );
    const hint = view.getByTestId("agent-try-another-model");
    expect(hint.textContent).toBe("Try another model");
    testing.fireEvent.click(hint);
    expect(onChooseModel).toHaveBeenCalledTimes(1);
  });

  test("an offline failure says the studio still works and keeps the composer live", async () => {
    const { start } = renderComposer(null, () =>
      Promise.resolve({
        ok: false,
        error: { code: "offline", message: "The provider could not be reached. Check your connection." }
      })
    );
    const { input, view } = composer();
    testing.fireEvent.change(input, { target: { value: "Keep going." } });
    testing.fireEvent.keyDown(input, { key: "Enter", shiftKey: false });

    await testing.waitFor(() => expect(view.getByTestId("agent-offline-note")).toBeDefined());
    expect(view.getByTestId("agent-offline-note").textContent).toContain("still work");
    expect(view.getByTestId("agent-retry-request")).toBeDefined();

    // The studio stays usable: the next prompt sends as a new turn.
    testing.fireEvent.change(input, { target: { value: "I will write on my own." } });
    testing.fireEvent.keyDown(input, { key: "Enter", shiftKey: false });
    await testing.waitFor(() => expect(start).toHaveBeenCalledTimes(2));
    expect(view.getByText("I will write on my own.")).toBeDefined();
  });

  test.each([90, 172_800])("a %s-second rate limit names the wait and releases the composer", async (retryAfterSeconds) => {
    const { start, fire } = renderComposer();
    const { input, view } = composer();
    testing.fireEvent.change(input, { target: { value: "Keep going." } });
    testing.fireEvent.keyDown(input, { key: "Enter", shiftKey: false });
    await testing.waitFor(() => expect(start).toHaveBeenCalledTimes(1));
    // Let the started turn register itself before its failure arrives.
    await testing.act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });

    await testing.act(async () => {
      fire({
        type: "error",
        turnId: "turn_cmp000001",
        code: "rate-limit",
        message: "The provider asked us to slow down. Try again shortly.",
        retryAfterSeconds
      });
    });
    await testing.waitFor(() => expect(view.getByTestId("agent-rate-note")).toBeDefined());
    expect(view.getByTestId("agent-rate-note").textContent).toBe(
      `The provider asked to wait. Try again in about ${Math.round(retryAfterSeconds / 60)} minutes.`
    );
    expect(view.getByTestId("agent-retry-request")).toBeDefined();
    expect(view.getByTestId("agent-mode")).toHaveProperty("disabled", false);
    expect(view.getByTestId("agent-guidance")).toHaveProperty("disabled", false);
    testing.fireEvent.change(input, { target: { value: "A new request." } });
    testing.fireEvent.keyDown(input, { key: "Enter", shiftKey: false });
    await testing.waitFor(() => expect(start).toHaveBeenCalledTimes(2));
  });

  async function failAfterChange(
    fire: (event: AgentEvent) => void,
    start: ReturnType<typeof mock>,
    event: AgentEvent
  ): Promise<void> {
    const { input } = composer();
    testing.fireEvent.change(testing.within(document.body).getByTestId("agent-mode"), { target: { value: "edit" } });
    testing.fireEvent.change(input, { target: { value: "Replace the opening." } });
    testing.fireEvent.keyDown(input, { key: "Enter", shiftKey: false });
    await testing.waitFor(() => expect(start).toHaveBeenCalledTimes(1));
    // Let the started turn register itself before its failure arrives.
    await testing.act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    await testing.act(async () => {
      fire(event);
    });
  }

  test("withholds retry until the changed chapters are undone", async () => {
    const { start, fire, undoLast, onChanged } = renderComposer(
      null,
      null,
      () => Promise.resolve({ ok: true, data: { restored: 1, skipped: 0 } })
    );
    const { view } = composer();
    await failAfterChange(fire, start, {
      type: "error",
      turnId: "turn_cmp000001",
      code: "unknown",
      message: "The model stopped mid-reply.",
      changed: 1,
      undoAvailable: true
    });

    await testing.waitFor(() => expect(view.getByText(/Undo it before retrying\./)).toBeDefined());
    expect(view.queryByTestId("agent-retry-request")).toBeNull();
    expect(view.getByTestId("agent-undo-turn")).toBeDefined();

    await testing.act(async () => {
      testing.fireEvent.click(view.getByTestId("agent-undo-turn"));
    });
    expect(undoLast).toHaveBeenCalledWith(BOOK, "turn_cmp000001");
    await testing.waitFor(() => expect(view.getByText("Restored 1 chapter.")).toBeDefined());
    expect(view.getByTestId("agent-retry-request")).toBeDefined();
    expect(onChanged).toHaveBeenCalled();
  });

  test("an undo that kept a copy of words written during the turn says where they are", async () => {
    const note = "“The Gate” was edited during the turn, so undo kept its text from before the undo at books/b/conflicts/0002-the-gate.conflict-undo.md.";
    const { start, fire } = renderComposer(null, null, () =>
      Promise.resolve({
        ok: true,
        data: {
          restored: 1,
          skipped: 0,
          kept: [{ chapterId: "ch_cmp000002", title: "The Gate", savedAs: "books/b/conflicts/0002-the-gate.conflict-undo.md" }],
          notes: [note]
        }
      })
    );
    const { view } = composer();
    await failAfterChange(fire, start, {
      type: "error",
      turnId: "turn_cmp000001",
      code: "unknown",
      message: "The model stopped mid-reply.",
      changed: 1,
      undoAvailable: true
    });

    await testing.waitFor(() => expect(view.getByTestId("agent-undo-turn")).toBeDefined());
    await testing.act(async () => {
      testing.fireEvent.click(view.getByTestId("agent-undo-turn"));
    });
    await testing.waitFor(() => expect(view.getByText(`Restored 1 chapter. ${note}`)).toBeDefined());
  });

  test("an undo that skips a chapter edited since says so and still withholds retry", async () => {
    const { start, fire, undoLast } = renderComposer(
      null,
      null,
      () => Promise.resolve({ ok: true, data: { restored: 1, skipped: 1 } })
    );
    const { view } = composer();
    await failAfterChange(fire, start, {
      type: "error",
      turnId: "turn_cmp000001",
      code: "unknown",
      message: "The model stopped mid-reply.",
      changed: 2,
      undoAvailable: true
    });

    await testing.waitFor(() => expect(view.getByTestId("agent-undo-turn")).toBeDefined());
    await testing.act(async () => {
      testing.fireEvent.click(view.getByTestId("agent-undo-turn"));
    });
    expect(undoLast).toHaveBeenCalledWith(BOOK, "turn_cmp000001");
    await testing.waitFor(() =>
      expect(
        view.getByText("Restored 1 chapter, but skipped 1. Review the remaining changes before retrying.")
      ).toBeDefined()
    );
    // The skipped chapter still differs from before the turn, so a retry is not offered yet.
    expect(view.getByText(/This attempt changed 1 chapter\. Review the affected chapters before retrying\./))
      .toBeDefined();
    expect(view.queryByText(/Undo it before retrying\./)).toBeNull();
    expect(view.queryByTestId("agent-retry-request")).toBeNull();
    expect(view.queryByTestId("agent-undo-turn")).toBeNull();
  });

  test("withholds retry and undo when no checkpoint could be saved", async () => {
    const { start, fire } = renderComposer();
    const { view } = composer();
    await failAfterChange(fire, start, {
      type: "error",
      turnId: "turn_cmp000001",
      code: "unknown",
      message: "Boom. The turn changed the book, but its undo checkpoint could not be saved. Review the affected chapters before continuing.",
      changed: 1,
      undoAvailable: false
    });

    await testing.waitFor(() =>
      expect(view.getByText(/This attempt changed 1 chapter\. Review the affected chapters before retrying\./))
        .toBeDefined()
    );
    expect(view.queryByText(/Undo it before retrying\./)).toBeNull();
    expect(view.getByText(/Review the affected chapters before continuing\./)).toBeDefined();
    expect(view.queryByTestId("agent-retry-request")).toBeNull();
    expect(view.queryByTestId("agent-undo-turn")).toBeNull();
  });

  test("names a mid-conversation model change in plain words", async () => {
    const seed = agentThreadSchema.parse({
      schemaVersion: 1,
      id: "thread_cmp000002",
      bookId: BOOK,
      title: "Two models",
      createdAt: AT,
      updatedAt: AT,
      messages: [
        { id: "msg_cmp000010", role: "user", parts: [{ type: "text", text: "Write." }], createdAt: AT },
        {
          id: "msg_cmp000011",
          role: "assistant",
          parts: [{ type: "text", text: "First." }],
          model: { provider: "openrouter", modelId: "test-model-a", connectionLabel: "OpenRouter", name: "Model A" },
          turnId: "turn_cmp000010",
          createdAt: AT
        },
        { id: "msg_cmp000012", role: "user", parts: [{ type: "text", text: "And more." }], createdAt: AT },
        {
          id: "msg_cmp000013",
          role: "assistant",
          parts: [{ type: "text", text: "Second." }],
          model: { provider: "openrouter", modelId: "test-model-b", connectionLabel: "OpenRouter", name: "Model B" },
          turnId: "turn_cmp000011",
          createdAt: AT
        }
      ],
      checkpointTurns: []
    });
    renderComposer(null, null, null, seed);
    const view = testing.within(document.body);

    await testing.waitFor(() => expect(view.getAllByTestId("model-change")).toHaveLength(2));
    expect(view.getAllByTestId("model-change").map((mark) => mark.textContent)).toEqual([
      "Now answering with OpenRouter · Model A",
      "Now answering with OpenRouter · Model B"
    ]);
  });

  test("shows the turn's usage line when the answer lands", async () => {
    const { start, fire } = renderComposer();
    const { input, view } = composer();
    testing.fireEvent.change(input, { target: { value: "Tighten this." } });
    testing.fireEvent.keyDown(input, { key: "Enter", shiftKey: false });
    await testing.waitFor(() => expect(start).toHaveBeenCalledTimes(1));
    // Let the started turn register itself before its answer arrives.
    await testing.act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });

    await testing.act(async () => {
      fire({
        type: "done",
        turnId: "turn_cmp000001",
        text: "Tightened.",
        model: { provider: "openrouter", modelId: "test-model", connectionLabel: "Test connection", name: "Test Model" },
        inputTokens: 100,
        outputTokens: 12,
        costUsd: 0.0012,
        costBasis: "reported",
        contextLength: 1000,
        context: {
          estimated: true as const,
          sections: [{ id: "chapters", label: "Chapters", characters: 400, estimatedTokens: 100 }],
          conversationTokens: 0,
          totalTokens: 100
        },
        changed: 0,
        undoAvailable: false
      });
    });

    await testing.waitFor(() => expect(view.getByText("Tightened.")).toBeDefined());
    expect(view.getByText("100 in · 12 out · $0.0012 · 10% of 1,000 context")).toBeDefined();
    expect(view.getAllByTestId("model-change").map((mark: HTMLElement) => mark.textContent)).toEqual([
      "Now answering with Test connection · Test Model"
    ]);
    expect(view.getByTestId("agent-context")).toBeDefined();
  });

  test("Shift+Enter keeps a newline and never sends", async () => {
    const { start } = renderComposer();
    const { input } = composer();
    await testing.waitFor(() => {
      expect(input).toBeTruthy();
    });
    testing.fireEvent.change(input, { target: { value: "First line" } });
    testing.fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
    await testing.act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(start).not.toHaveBeenCalled();
  });

  test("a chosen turn model rides along and is marked used", async () => {
    const { start, onTurnModelUsed } = renderComposer({ connectionId: "conn_test000001", modelId: "test/model" });
    const { input, view } = composer();
    await testing.waitFor(() => {
      expect(input).toBeTruthy();
    });
    testing.fireEvent.change(input, { target: { value: "Continue." } });
    testing.fireEvent.keyDown(input, { key: "Enter", shiftKey: false });
    await testing.waitFor(() => {
      expect(start).toHaveBeenCalledTimes(1);
    });
    const request = start.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(request.model).toEqual({ connectionId: "conn_test000001", modelId: "test/model" });
    expect(view.getByText("This turn: model")).toBeTruthy();
    expect(onTurnModelUsed).toHaveBeenCalledTimes(1);
  });

  test("while a turn runs the composer offers Stop, not a second send", async () => {
    const { start } = renderComposer();
    const { input, view } = composer();
    await testing.waitFor(() => {
      expect(input).toBeTruthy();
    });
    testing.fireEvent.change(input, { target: { value: "Continue." } });
    testing.fireEvent.keyDown(input, { key: "Enter", shiftKey: false });
    await testing.waitFor(() => {
      expect(view.getByTestId("chat-stop")).toBeTruthy();
    });
    testing.fireEvent.keyDown(view.getByTestId("chat-input"), { key: "Enter", shiftKey: false });
    await testing.act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(start).toHaveBeenCalledTimes(1);
  });

  test("a suggestion fills the composer and never sends by itself", async () => {
    const { start } = renderComposer();
    const view = testing.within(document.body);
    await testing.waitFor(() => expect(view.getAllByTestId("agent-suggestion")).toHaveLength(3));
    expect(view.getAllByTestId("agent-suggestion").map((chip: HTMLElement) => chip.textContent)).toEqual([
      "Draft the next scene",
      "Tighten this paragraph",
      "Check what happened earlier"
    ]);

    const [first] = view.getAllByTestId("agent-suggestion");
    testing.fireEvent.click(first as HTMLElement);
    const input = view.getByTestId("chat-input") as HTMLTextAreaElement;
    expect(input.value).toBe("Draft the next scene");
    expect(document.activeElement).toBe(input);
    expect(view.getByTestId("chat-send")).toHaveProperty("disabled", false);
    await testing.act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(start).not.toHaveBeenCalled();
  });

  test("a destructive tool waits behind Allow and Deny", async () => {
    const { start, fire, approve } = renderComposer();
    const { input, view } = composer();
    testing.fireEvent.change(view.getByTestId("agent-mode"), { target: { value: "edit" } });
    testing.fireEvent.change(input, { target: { value: "Replace the opening." } });
    testing.fireEvent.keyDown(input, { key: "Enter", shiftKey: false });
    await testing.waitFor(() => expect(start).toHaveBeenCalledTimes(1));
    // Let the started turn register itself before its approval arrives.
    await testing.act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });

    await testing.act(async () => {
      fire({
        type: "approval",
        turnId: "turn_cmp000001",
        approvalId: "approval_cmp000001",
        name: "overwrite_chapter",
        input: { chapterId: CHAPTER }
      });
    });
    const gate = await testing.waitFor(() => view.getByTestId("agent-approval"));
    expect(testing.within(gate).getByText("Replace a chapter's text?")).toBeDefined();
    expect(testing.within(gate).getByText("The agent will wait for your answer before changing anything.")).toBeDefined();
    expect(view.getByText("Waiting for your approval.")).toBeDefined();

    await testing.act(async () => {
      testing.fireEvent.click(view.getByTestId("agent-approve"));
    });
    expect(approve).toHaveBeenCalledWith("turn_cmp000001", "approval_cmp000001", true);
    await testing.waitFor(() => expect(view.getByText("Allowed")).toBeDefined());
    expect(view.queryByTestId("agent-approve")).toBeNull();
    expect(view.queryByTestId("agent-deny")).toBeNull();
  });

  /** Send a prompt and let the turn pause on a destructive tool. Returns the waiting card. */
  async function pauseForApproval(
    fire: (event: AgentEvent) => void,
    start: ReturnType<typeof mock>
  ): Promise<{ view: ReturnType<typeof testing.within>; gate: HTMLElement }> {
    const { input, view } = composer();
    testing.fireEvent.change(view.getByTestId("agent-mode"), { target: { value: "edit" } });
    testing.fireEvent.change(input, { target: { value: "Replace the opening." } });
    testing.fireEvent.keyDown(input, { key: "Enter", shiftKey: false });
    await testing.waitFor(() => expect(start).toHaveBeenCalledTimes(1));
    await testing.act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    await testing.act(async () => {
      fire({ type: "tool", turnId: "turn_cmp000001", id: "call_1", name: "overwrite_chapter", status: "start" });
      fire({
        type: "approval",
        turnId: "turn_cmp000001",
        approvalId: "approval_cmp000001",
        name: "overwrite_chapter",
        input: { chapterId: CHAPTER }
      });
    });
    return { view, gate: await testing.waitFor(() => view.getByTestId("agent-approval")) };
  }

  /** The approved turn writes, replies and finishes. */
  async function finishAfterApproval(fire: (event: AgentEvent) => void, reply: string): Promise<void> {
    await testing.act(async () => {
      fire({ type: "tool", turnId: "turn_cmp000001", id: "call_1", name: "overwrite_chapter", status: "end", output: { ok: true } });
      fire({ type: "text", turnId: "turn_cmp000001", delta: reply });
      fire({
        type: "done",
        turnId: "turn_cmp000001",
        text: reply,
        model: { provider: "openrouter", modelId: "test-model", connectionLabel: "Test connection", name: "Test Model" },
        inputTokens: 100,
        outputTokens: 12,
        costUsd: null,
        costBasis: "unknown",
        contextLength: null,
        context: { estimated: true as const, sections: [], conversationTokens: 0, totalTokens: 100 },
        changed: 1,
        undoAvailable: true
      });
    });
  }

  test("a late approval reply cannot replace stopping or resurrect a terminal turn", async () => {
    const { start, fire, approve } = renderComposer();
    let release!: () => void;
    approve.mockImplementation(() => new Promise((resolve) => { release = () => resolve({ ok: true, data: null }); }));
    const { view } = await pauseForApproval(fire, start);
    testing.fireEvent.click(view.getByTestId("agent-approve"));
    await testing.waitFor(() => expect(approve).toHaveBeenCalledTimes(1));
    await testing.act(async () => {
      fire({ type: "stopping", turnId: "turn_cmp000001" });
    });
    expect(view.getByText("Stopping… Waiting for in-flight work to settle.")).toBeDefined();
    await testing.act(async () => {
      fire({ type: "stopped", turnId: "turn_cmp000001", changed: 0, undoAvailable: true });
      release();
    });
    expect(view.getByText("Stopped · 0 chapters changed")).toBeDefined();
    expect(view.getByText("Allowed")).toBeDefined();
    expect(view.queryByText("Approved. Working…")).toBeNull();
    expect(view.getByTestId("chat-send")).toBeDefined();
  });

  test("stop before Allow refuses the stale approval in the composer", async () => {
    const { start, fire, approve } = renderComposer();
    const { view } = await pauseForApproval(fire, start);
    await testing.act(async () => { testing.fireEvent.click(view.getByTestId("chat-stop")); });
    testing.fireEvent.click(view.getByTestId("agent-approve"));
    expect(approve).not.toHaveBeenCalled();
    expect(view.getByText("Stopping… Waiting for in-flight work to settle.")).toBeDefined();
  });

  // QA B13: a branch copies the conversation, and a waiting approval cannot be answered from a copy.
  test("a turn waiting for approval offers no branch until it is answered", async () => {
    const { start, fire } = renderComposer();
    const { view } = await pauseForApproval(fire, start);
    expect(view.getByText("Waiting for your approval.")).toBeDefined();
    expect(view.queryByTestId("agent-branch-turn")).toBeNull();

    await testing.act(async () => {
      testing.fireEvent.click(view.getByTestId("agent-approve"));
    });
    await finishAfterApproval(fire, "I replaced the opening.");
    await testing.waitFor(() => expect(view.getByTestId("agent-branch-turn")).toBeDefined());
  });

  test("a reopened turn still waiting for approval offers no branch", async () => {
    const seed = agentThreadSchema.parse({
      schemaVersion: 1,
      id: "thread_cmp000003",
      bookId: BOOK,
      title: "Waiting",
      createdAt: AT,
      updatedAt: AT,
      messages: [
        { id: "msg_cmp000020", role: "user", parts: [{ type: "text", text: "Replace the opening." }], createdAt: AT },
        {
          id: "msg_cmp000021",
          role: "assistant",
          parts: [
            { type: "tool-call", id: "call_1", name: "overwrite_chapter", input: { chapterId: CHAPTER } },
            {
              type: "approval",
              approvalId: "approval_cmp000002",
              turnId: "turn_cmp000020",
              name: "overwrite_chapter",
              input: { chapterId: CHAPTER },
              status: "pending",
              requestedAt: AT
            }
          ],
          turnId: "turn_cmp000020",
          createdAt: AT
        }
      ],
      checkpointTurns: []
    });
    renderComposer(null, null, null, seed);
    const view = testing.within(document.body);
    await testing.waitFor(() => expect(view.getByTestId("agent-approval")).toBeDefined());
    expect(view.getByTestId("agent-approve")).toBeDefined();
    expect(view.queryByTestId("agent-branch-turn")).toBeNull();
  });

  // QA B12: the answer buttons leave with the question, so focus goes to the card they were on.
  for (const [button, answer] of [
    ["agent-approve", "Allowed"],
    ["agent-deny", "Denied"]
  ] as const) {
    test(`answering ${answer.toLowerCase()} from the keyboard keeps focus on the answered card`, async () => {
      const { start, fire, approve } = renderComposer();
      const { view, gate } = await pauseForApproval(fire, start);
      const pressed = view.getByTestId(button);
      pressed.focus();
      expect(document.activeElement === pressed).toBe(true);

      await testing.act(async () => {
        testing.fireEvent.click(pressed);
      });
      expect(approve).toHaveBeenCalledWith("turn_cmp000001", "approval_cmp000001", button === "agent-approve");
      await testing.waitFor(() => expect(testing.within(gate).getByText(answer)).toBeDefined());
      expect(pressed.isConnected).toBe(false);
      expect(gate.isConnected).toBe(true);
      expect(document.activeElement?.getAttribute("data-testid")).toBe("agent-approval");
      expect(document.activeElement === gate).toBe(true);
    });
  }

  // QA B11: the turn reads in the order it happened, so the answered card comes before the reply.
  test("an answered card stays before the reply that followed it", async () => {
    const { start, fire } = renderComposer();
    const { view, gate } = await pauseForApproval(fire, start);
    await testing.act(async () => {
      testing.fireEvent.click(view.getByTestId("agent-approve"));
    });
    await finishAfterApproval(fire, "I replaced the opening.");

    const reply = await testing.waitFor(() => view.getByText("I replaced the opening."));
    expect(testing.within(gate).getByText("Allowed")).toBeDefined();
    expect(gate.compareDocumentPosition(reply) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  test("a reopened turn shows its answered card before its reply", async () => {
    const seed = agentThreadSchema.parse({
      schemaVersion: 1,
      id: "thread_cmp000004",
      bookId: BOOK,
      title: "Answered",
      createdAt: AT,
      updatedAt: AT,
      messages: [
        { id: "msg_cmp000030", role: "user", parts: [{ type: "text", text: "Replace the opening." }], createdAt: AT },
        {
          id: "msg_cmp000031",
          role: "assistant",
          parts: [
            { type: "tool-call", id: "call_1", name: "overwrite_chapter", input: { chapterId: CHAPTER } },
            { type: "tool-result", id: "call_1", name: "overwrite_chapter", output: { ok: true } },
            { type: "text", text: "I replaced the opening." },
            {
              type: "approval",
              approvalId: "approval_cmp000003",
              turnId: "turn_cmp000030",
              name: "overwrite_chapter",
              input: { chapterId: CHAPTER },
              status: "approved",
              requestedAt: AT,
              resolvedAt: AT
            }
          ],
          turnId: "turn_cmp000030",
          createdAt: AT
        }
      ],
      checkpointTurns: []
    });
    renderComposer(null, null, null, seed);
    const view = testing.within(document.body);
    const gate = await testing.waitFor(() => view.getByTestId("agent-approval"));
    const reply = view.getByText("I replaced the opening.");
    expect(gate.compareDocumentPosition(reply) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  test("the context share opens on a tap as well as a hover", async () => {
    const { start, fire } = renderComposer();
    const { input, view } = composer();
    testing.fireEvent.change(input, { target: { value: "Tighten this." } });
    testing.fireEvent.keyDown(input, { key: "Enter", shiftKey: false });
    await testing.waitFor(() => expect(start).toHaveBeenCalledTimes(1));
    await testing.act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    await testing.act(async () => {
      fire({
        type: "done",
        turnId: "turn_cmp000001",
        text: "Tightened.",
        model: { provider: "openrouter", modelId: "test-model", connectionLabel: "Test connection", name: "Test Model" },
        inputTokens: 250,
        outputTokens: 12,
        costUsd: 0.0012,
        costBasis: "reported",
        contextLength: 1000,
        context: {
          estimated: true as const,
          sections: [{ id: "chapters", label: "Chapters", characters: 800, estimatedTokens: 200 }],
          conversationTokens: 40,
          totalTokens: 240
        },
        changed: 0,
        undoAvailable: false
      });
    });

    const trigger = await testing.waitFor(() => view.getByTestId("agent-context"));
    expect(trigger.textContent).toBe("Context · ~240 tokens");
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    await testing.act(async () => {
      testing.fireEvent.click(trigger);
    });
    await testing.waitFor(() => expect(view.getByRole("progressbar", { name: "Context used" })).toBeDefined());
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(view.getByText("250 / 1,000")).toBeDefined();
    expect(view.getByText("Chapters")).toBeDefined();
    expect(view.getByText("Estimated from characters. The provider's reported usage is authoritative.")).toBeDefined();
  });

  test("the input and send are keyboard-focusable", async () => {
    renderComposer();
    const { input, view } = composer();
    await testing.waitFor(() => {
      expect(input).toBeTruthy();
    });
    (input as HTMLElement).focus();
    expect(document.activeElement).toBe(input);
    // Send stays disabled — and unfocusable — until there is a prompt.
    expect(view.getByTestId("chat-send")).toHaveProperty("disabled", true);
    testing.fireEvent.change(input, { target: { value: "Trim the opening." } });
    const send = view.getByTestId("chat-send");
    (send as HTMLElement).focus();
    expect(document.activeElement).toBe(send);
  });
});
