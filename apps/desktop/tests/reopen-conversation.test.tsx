/// <reference types="bun" />
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import React from "react";
import type { OpenConversationEvent } from "@ai-book-studio/core/ipc";
import type { AgentThread } from "@ai-book-studio/core/agent/messages";
import { bookSchema, chapterMetaSchema } from "@ai-book-studio/core/schema";
import { locationHealth } from "@ai-book-studio/core/sync/health";
import { mountDom, unmountDom } from "./support/dom";

let testing!: typeof import("@testing-library/react/pure");
let App!: typeof import("@ai-book-studio/app").default;

beforeAll(async () => {
  testing = await mountDom();
  ({ default: App } = await import("@ai-book-studio/app"));
});
afterAll(async () => {
  await unmountDom();
});

afterEach(() => testing.cleanup());

/*
 * A window the studio makes after a background turn opens on that turn's conversation (spec 017
 * FR-012, filmed at 1:29): the book's workspace, with the writing agent open on the thread the turn
 * finished in, not on the newest one and not on the library. Without that signal the window opens on
 * the library, as it always did.
 */

const NOW = "2026-11-04T06:00:00.000Z";
const BOOK = "book_reopen0001";
const FINISHED = "thread_reopen0001";
const NEWER = "thread_reopen0002";
const PAUSED = "thread_reopen0003";
const REPLY = "The scene is ready. I added one line to “The Light”.";

function thread(id: string, prompt: string, reply: string): AgentThread {
  return {
    schemaVersion: 1,
    id,
    bookId: BOOK,
    title: prompt,
    createdAt: NOW,
    updatedAt: NOW,
    messages: [
      { id: `msg_${id.slice(7)}u`, role: "user", parts: [{ type: "text", text: prompt }], createdAt: NOW },
      { id: `msg_${id.slice(7)}a`, role: "assistant", parts: [{ type: "text", text: reply }], turnId: `turn_${id.slice(7)}`, createdAt: NOW }
    ],
    plans: [],
    checkpointTurns: []
  } as AgentThread;
}

/** The bridge the shell needs to reach the library and open the book, with the reopen signal in hand. */
function mockStudio() {
  const listeners = new Set<(target: OpenConversationEvent) => void>();
  const read: string[] = [];
  const paused = thread(PAUSED, "Replace the opening with the short version", "I can replace the opening.");
  paused.messages[1]?.parts.push({
    type: "approval",
    approvalId: "appr_reopen0003",
    turnId: "turn_reopen0003",
    name: "overwrite_chapter",
    input: { chapterId: "ch_reopen0001" },
    status: "pending",
    requestedAt: NOW
  });
  const threads: Record<string, AgentThread> = {
    [FINISHED]: thread(FINISHED, "Draft the next scene", REPLY),
    [NEWER]: thread(NEWER, "Tighten this paragraph", "I tightened the paragraph."),
    [PAUSED]: paused
  };
  const approved: Array<[turnId: string, approvalId: string, approved: boolean]> = [];
  const book = bookSchema.parse({ id: BOOK, title: "The Salt Road", createdAt: NOW, updatedAt: NOW });
  const chapter = {
    ...chapterMetaSchema.parse({ id: "ch_reopen0001", title: "The Light", order: 1, createdAt: NOW, updatedAt: NOW }),
    content: "The keeper counted the gulls.\n",
    path: "0001-the-light.md",
    wordCount: 5,
    hash: "a".repeat(64)
  };
  const openChapter = {
    ...chapterMetaSchema.parse({ id: "ch_reopen0002", title: "The Crossing", order: 2, createdAt: NOW, updatedAt: NOW }),
    content: "The ferry left at dawn.\n",
    path: "0002-the-crossing.md",
    wordCount: 5,
    hash: "b".repeat(64)
  };
  const ok = <T,>(data: T) => Promise.resolve({ ok: true as const, data });
  (globalThis as unknown as { window: { studio: unknown } }).window.studio = {
    platform: "darwin",
    app: {
      onSecondInstance: () => () => {},
      onOpenConversation: (callback: (target: OpenConversationEvent) => void) => {
        listeners.add(callback);
        return () => {
          listeners.delete(callback);
        };
      }
    },
    library: {
      current: () => ok({ root: "/tmp/studio-library", deviceId: "device_reopen0001", deviceName: "Studio Mac" }),
      onChange: () => () => {},
      locationHealth: () => ok(locationHealth([], null))
    },
    sync: { onDrift: () => () => {}, check: () => ok(null) },
    menu: { onOpenLibrary: () => () => {} },
    books: {
      list: () =>
        ok([{ id: BOOK, title: "The Salt Road", description: "", stage: "drafting", chapterCount: 1, wordCount: 5, updatedAt: NOW }]),
      open: () => ok({ book, chapters: [chapter, openChapter], chapterReadIssues: [] })
    },
    chapters: { save: () => ok({ status: "saved", chapter }), updateMeta: () => ok({ status: "saved", chapter }) },
    conflicts: { list: () => ok([]) },
    drafts: { set: () => ok(null), clear: () => ok(null), onFlushRequest: () => () => {} },
    images: { list: () => ok({ manifest: { images: [] } }) },
    agent: {
      onEvent: () => () => {},
      approve: (turnId: string, approvalId: string, answer: boolean) => {
        approved.push([turnId, approvalId, answer]);
        return ok(null);
      },
      threads: {
        // Newest first, as the store lists them: the turn's conversation is not the newest.
        list: () =>
          ok([NEWER, FINISHED].map((id) => ({ id, title: threads[id]?.title ?? "", createdAt: NOW, updatedAt: NOW, messageCount: 2, preview: "" }))),
        read: (_bookId: string, id: string) => {
          read.push(id);
          return ok({ thread: threads[id] ?? null, planRuntime: null });
        }
      }
    },
    voice: {
      connections: () => ok([]),
      speakers: () => ok({ available: false, connectionLabel: null, endpoint: null, model: null, voices: [] })
    }
  };
  return {
    read,
    approved,
    reopen: (target: OpenConversationEvent) => {
      for (const listener of [...listeners]) listener(target);
    },
    listening: () => listeners.size
  };
}

describe("a window reopened after a background turn", () => {
  test("opens the book's workspace with the agent on the conversation the turn finished in", async () => {
    const bridge = mockStudio();
    testing.render(React.createElement(App));
    const body = testing.within(document.body);
    await body.findByTestId("library-view");

    testing.act(() => bridge.reopen({ bookId: BOOK, threadId: FINISHED }));
    await body.findByTestId("workspace-view");
    const chat = await body.findByTestId("chat-panel");
    await testing.waitFor(() => expect(testing.within(chat).getByText(REPLY)).toBeTruthy());
    expect(testing.within(chat).queryByText("I tightened the paragraph.")).toBeNull();
    expect(bridge.read).toEqual([FINISHED]);
    expect(body.queryByTestId("library-view")).toBeNull();
  });

  test("opens on the chapter that was open when the window closed, not on the first chapter", async () => {
    const bridge = mockStudio();
    testing.render(React.createElement(App));
    const body = testing.within(document.body);
    await body.findByTestId("library-view");

    testing.act(() => bridge.reopen({ bookId: BOOK, threadId: FINISHED, chapterId: "ch_reopen0002" }));
    await body.findByTestId("workspace-view");
    await testing.waitFor(() =>
      expect((body.getByTestId("manuscript-text") as HTMLTextAreaElement).value).toBe("The ferry left at dawn.\n")
    );
    const chat = await body.findByTestId("chat-panel");
    await testing.waitFor(() => expect(testing.within(chat).getByText(REPLY)).toBeTruthy());
  });

  test("a turn that paused for approval reopens on its request, and Allow answers that turn", async () => {
    const bridge = mockStudio();
    testing.render(React.createElement(App));
    const body = testing.within(document.body);
    await body.findByTestId("library-view");

    testing.act(() => bridge.reopen({ bookId: BOOK, threadId: PAUSED }));
    const chat = await body.findByTestId("chat-panel");
    const request = await testing.within(chat).findByTestId("agent-approval");
    testing.fireEvent.click(testing.within(request).getByTestId("agent-approve"));
    await testing.waitFor(() => expect(bridge.approved).toEqual([["turn_reopen0003", "appr_reopen0003", true]]));
    expect(bridge.read).toEqual([PAUSED]);
  });

  test("a signal that arrives while the library is still opening lands once it has opened", async () => {
    const bridge = mockStudio();
    let open!: () => void;
    const opened = new Promise<void>((resolve) => {
      open = resolve;
    });
    const studio = (globalThis as unknown as { window: { studio: { library: { current: () => Promise<unknown> } } } }).window.studio;
    const current = studio.library.current;
    studio.library.current = async () => {
      await opened;
      return current();
    };
    testing.render(React.createElement(App));
    const body = testing.within(document.body);
    await body.findByText("Opening your library…");

    testing.act(() => bridge.reopen({ bookId: BOOK, threadId: FINISHED }));
    await testing.act(async () => open());
    const chat = await body.findByTestId("chat-panel");
    await testing.waitFor(() => expect(testing.within(chat).getByText(REPLY)).toBeTruthy());
  });

  test("without the signal the window opens on the library, as before, and reads no conversation", async () => {
    const bridge = mockStudio();
    testing.render(React.createElement(App));
    const body = testing.within(document.body);
    await body.findByTestId("library-view");
    expect(body.queryByTestId("workspace-view")).toBeNull();
    expect(bridge.read).toEqual([]);
    expect(bridge.listening()).toBe(1);
    testing.cleanup();
    expect(bridge.listening()).toBe(0);
  });
});
