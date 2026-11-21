/// <reference types="bun" />
import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from "bun:test";
import React from "react";
import { mountDom, unmountDom } from "./support/dom";
import { bookSchema, chapterMetaSchema, type Chapter } from "@ai-book-studio/core/schema";

/**
 * Mounts the real workspace with a synthetic bridge: the preview's entry point, the no-cache
 * refusal, the explicit picker load that feeds the snapshot, and the handoff to the one-turn
 * picker. No bridge call happens unless the author opened the picker.
 */

let testing!: typeof import("@testing-library/react/pure");
let WorkspaceView!: typeof import("@ai-book-studio/app/views/WorkspaceView").WorkspaceView;

beforeAll(async () => {
  testing = await mountDom();
  ({ WorkspaceView } = await import("@ai-book-studio/app/views/WorkspaceView"));
});
afterAll(async () => {
  await unmountDom();
});
afterEach(() => testing.cleanup());

const NOW = "2026-11-16T00:00:00.000Z";
const BOOK_A = "book_mount0001";
const BOOK_B = "book_mount0002";
const LIBRARY = "/tmp/studio-library";

const ACME = {
  id: "acme/openrouter-large",
  name: "Acme Large",
  contextLength: 128000,
  supportsTools: true,
  supportsImages: false,
  inputPricePerMillion: 1.25,
  outputPricePerMillion: 5
};

function chapter(id: string, title: string, order: number): Chapter {
  return {
    ...chapterMetaSchema.parse({ id, title, order, createdAt: NOW, updatedAt: NOW }),
    content: `${title} line.\n`,
    path: `${String(order).padStart(4, "0")}-${title.toLowerCase()}.md`,
    wordCount: 2,
    hash: "a".repeat(64)
  };
}

const CHAPTER_A = chapter("ch_mount0001", "First", 1);
const CHAPTER_B = chapter("ch_mount0002", "Second", 1);

function studioMock() {
  const counts = {
    providersList: 0,
    providersModels: 0,
    connectionsList: 0,
    booksEdit: 0,
    agentStart: 0,
    threadsList: 0
  };
  const bookA = bookSchema.parse({ id: BOOK_A, title: "The Salt Road", outline: "Two sisters.", createdAt: NOW, updatedAt: NOW });
  const bookB = bookSchema.parse({ id: BOOK_B, title: "The Quiet Sea", outline: "A harbour town.", createdAt: NOW, updatedAt: NOW });
  const studio = {
    platform: "darwin",
    books: {
      open: mock(async (id: string) => {
        const book = id === BOOK_A ? bookA : bookB;
        const chapters = id === BOOK_A ? [CHAPTER_A] : [CHAPTER_B];
        return { ok: true, data: { book, chapters, chapterReadIssues: [] } };
      }),
      edit: mock(async () => {
        counts.booksEdit += 1;
        return { ok: true, data: bookA };
      })
    },
    chapters: {
      create: mock(async () => ({ ok: true, data: CHAPTER_A })),
      reorder: mock(async () => ({ ok: true, data: { status: "saved", chapters: [CHAPTER_A] } })),
      move: mock(async () => ({ ok: true, data: { status: "saved", chapters: [CHAPTER_A] } })),
      delete: mock(async () => ({ ok: true, data: null })),
      save: mock(async () => ({ ok: true, data: { status: "saved", chapter: { ...CHAPTER_A, content: CHAPTER_A.content, version: 1, hash: "b".repeat(64), updatedAt: NOW } } }))
    },
    conflicts: { list: mock(async () => ({ ok: true, data: [] })), reveal: mock(async () => ({ ok: true, data: null })) },
    drafts: { set: mock(async () => ({ ok: true, data: null })), clear: mock(async () => ({ ok: true, data: null })), onFlushRequest: mock(() => () => {}) },
    recovery: { list: mock(async () => ({ ok: true, data: [] })) },
    images: { list: mock(async () => ({ ok: true, data: { manifest: { images: [] } } })) },
    library: { onChange: mock(() => () => {}) },
    providers: {
      list: mock(async () => {
        counts.providersList += 1;
        return { ok: true, data: [{ id: "openrouter", name: "OpenRouter" }] };
      }),
      models: mock(async () => {
        counts.providersModels += 1;
        return { ok: true, data: { models: [ACME], fetchedAt: NOW } };
      })
    },
    connections: {
      list: mock(async () => {
        counts.connectionsList += 1;
        return {
          ok: true,
          data: [{ id: "conn_mount001", provider: "openrouter", label: "Test key", kind: "api-key", createdAt: NOW }]
        };
      })
    },
    agent: {
      onEvent: mock(() => () => {}),
      ambient: mock(async () => ({ ok: true, data: null })),
      start: mock(async () => {
        counts.agentStart += 1;
        return { ok: true, data: { turnId: "turn_mount0001", threadId: "thread_mount0001" } };
      }),
      stop: mock(async () => ({ ok: true, data: null })),
      approve: mock(async () => ({ ok: true, data: null })),
      undoLast: mock(async () => ({ ok: true, data: null })),
      threads: {
        list: mock(async () => {
          counts.threadsList += 1;
          return { ok: true, data: [] };
        }),
        read: mock(async () => ({ ok: true, data: null })),
        fork: mock(async () => ({ ok: true, data: null })),
        remove: mock(async () => ({ ok: true, data: null })),
        rename: mock(async () => ({ ok: true, data: null }))
      }
    },
    voice: {
      connections: mock(async () => ({ ok: true, data: [] })),
      speakers: mock(async () => ({ ok: true, data: { available: false, connectionLabel: null, endpoint: null, model: null, voices: [] } }))
    }
  };
  (globalThis as unknown as { window: { studio: unknown } }).window.studio = studio;
  return counts;
}

function renderWorkspace(bookId: string) {
  return testing.render(
    React.createElement(WorkspaceView, {
      bookId,
      theme: { choice: "light" as const, set: () => {}, cycle: () => {} },
      libraryRoot: LIBRARY,
      libraryStorage: undefined,
      onBack: () => {},
      onNotice: () => {},
      onSchemaRefusal: () => {}
    })
  );
}

async function openBook(view: ReturnType<typeof renderWorkspace>) {
  await testing.waitFor(() => expect(view.getByTestId("manuscript-text")).toBeTruthy(), { timeout: 5000 });
}

describe("task preview mount", () => {
  test("the composer previews without touching the bridge, then the picker load feeds the preview", async () => {
    const counts = studioMock();
    const view = renderWorkspace(BOOK_A);
    await openBook(view);

    // Open the writing agent; only its own mount-time calls have happened.
    await testing.act(async () => {
      await testing.fireEvent.click(view.getByTestId("toggle-chat"));
    });
    expect(counts.providersList).toBe(0);
    expect(counts.providersModels).toBe(0);
    expect(counts.connectionsList).toBe(0);

    // M1: the entry opens the preview with the no-cache refusal; still no bridge or fetch.
    await testing.act(async () => {
      await testing.fireEvent.click(view.getByTestId("open-task-preview"));
    });
    expect(view.getByTestId("task-preview")).toBeTruthy();
    expect(view.getByTestId("task-preview-no-catalogues")).toBeTruthy();
    expect(view.getByText("No model list is loaded yet.")).toBeTruthy();
    expect(counts.providersList).toBe(0);
    expect(counts.providersModels).toBe(0);
    expect(counts.connectionsList).toBe(0);

    // Choosing a profile behind the refusal still makes no call.
    await testing.act(async () => {
      await testing.fireEvent.click(view.getByText("Discuss the book"));
    });
    expect(counts.providersModels).toBe(0);

    // M2: the explicit book-picker load fills the snapshot; the preview reuses it.
    await testing.act(async () => {
      await testing.fireEvent.click(view.getByTestId("task-preview-open-picker"));
    });
    await testing.waitFor(() => expect(view.getAllByText("Acme Large").length).toBeGreaterThan(0), { timeout: 5000 });
    expect(counts.providersModels).toBe(1);
    expect(counts.connectionsList).toBe(1);
    await testing.act(async () => {
      await testing.fireEvent.click(view.getByRole("button", { name: "Cancel" }));
    });
    // The chosen profile now shows candidates with zero new bridge calls.
    await testing.waitFor(() => expect(view.getByTestId("task-preview-candidates")).toBeTruthy(), { timeout: 5000 });
    expect(counts.providersModels).toBe(1);
    expect(view.getByTestId("task-preview-order-note").textContent).toBe("Listed in catalogue order; this is not a ranking.");
    expect(view.getByTestId("task-preview-use-next")).toBeTruthy();
  }, 20000);

  test("an eligible candidate hands off to the one-turn picker and back", async () => {
    const counts = studioMock();
    const view = renderWorkspace(BOOK_A);
    await openBook(view);

    await testing.act(async () => {
      await testing.fireEvent.click(view.getByTestId("toggle-chat"));
    });
    await testing.act(async () => {
      await testing.fireEvent.click(view.getByTestId("open-task-preview"));
    });
    await testing.act(async () => {
      await testing.fireEvent.click(view.getByTestId("task-preview-open-picker"));
    });
    await testing.waitFor(() => expect(view.getAllByText("Acme Large").length).toBeGreaterThan(0), { timeout: 5000 });
    await testing.act(async () => {
      await testing.fireEvent.click(view.getByRole("button", { name: "Cancel" }));
    });

    // Choose the profile; the candidate appears with the action.
    await testing.act(async () => {
      await testing.fireEvent.click(view.getByText("Discuss the book"));
    });
    await testing.waitFor(() => expect(view.getByTestId("task-preview-candidates")).toBeTruthy(), { timeout: 5000 });

    // M3: hand off and cancel — nothing changes.
    await testing.act(async () => {
      await testing.fireEvent.click(view.getByTestId("task-preview-use-next"));
    });
    expect(view.getByText("Model for this turn")).toBeTruthy();
    expect(view.getByTestId("task-preview")).toBeTruthy();
    await testing.act(async () => {
      await testing.fireEvent.click(view.getByRole("button", { name: "Cancel" }));
    });
    expect(view.getByTestId("task-preview-status").textContent).toBe("No model was chosen. Nothing changed.");
    expect(view.getByTestId("agent-turn-model").textContent).toContain("Model: book default");
    expect(view.getByTestId("task-preview")).toBeTruthy();

    // M4: hand off and confirm — only the one-turn choice is set.
    await testing.act(async () => {
      await testing.fireEvent.click(view.getByTestId("task-preview-use-next"));
    });
    expect(view.getByText("Model for this turn")).toBeTruthy();
    await testing.waitFor(
      () => expect((view.getByRole("button", { name: "Use for this turn" }) as HTMLButtonElement).disabled).toBe(false),
      { timeout: 5000 }
    );
    await testing.act(async () => {
      await testing.fireEvent.click(view.getByRole("button", { name: "Use for this turn" }));
    });
    expect(view.getByTestId("task-preview-status").textContent).toBe("Model set for the next message.");
    expect(view.getByTestId("agent-turn-model").textContent).toContain("This turn: openrouter-large");
    expect(view.getByTestId("task-preview")).toBeTruthy();

    // M6: nothing was written, dispatched or persisted.
    expect(counts.booksEdit).toBe(0);
    expect(counts.agentStart).toBe(0);
    expect(counts.providersModels).toBe(3); // one for the book picker, one per handoff open

    // Close the preview; the one-turn choice stays.
    await testing.act(async () => {
      await testing.fireEvent.click(view.getByText("Close"));
    });
    expect(view.queryByTestId("task-preview")).toBeNull();
    expect(view.getByTestId("agent-turn-model").textContent).toContain("This turn: openrouter-large");
  }, 20000);

  test("switching books clears the one-turn choice and closes the picker", async () => {
    const counts = studioMock();
    const view = renderWorkspace(BOOK_A);
    await openBook(view);
    await testing.act(async () => {
      await testing.fireEvent.click(view.getByTestId("toggle-chat"));
    });
    // Confirm a handoff so there is a one-turn choice to clear.
    await testing.act(async () => {
      await testing.fireEvent.click(view.getByTestId("open-task-preview"));
    });
    await testing.act(async () => {
      await testing.fireEvent.click(view.getByTestId("task-preview-open-picker"));
    });
    await testing.waitFor(() => expect(view.getAllByText("Acme Large").length).toBeGreaterThan(0), { timeout: 5000 });
    await testing.act(async () => {
      await testing.fireEvent.click(view.getByRole("button", { name: "Cancel" }));
    });
    await testing.act(async () => {
      await testing.fireEvent.click(view.getByText("Discuss the book"));
    });
    await testing.waitFor(() => expect(view.getByTestId("task-preview-use-next")).toBeTruthy(), { timeout: 5000 });
    await testing.act(async () => {
      await testing.fireEvent.click(view.getByTestId("task-preview-use-next"));
    });
    await testing.waitFor(
      () => expect((view.getByRole("button", { name: "Use for this turn" }) as HTMLButtonElement).disabled).toBe(false),
      { timeout: 5000 }
    );
    await testing.act(async () => {
      await testing.fireEvent.click(view.getByRole("button", { name: "Use for this turn" }));
    });
    expect(view.getByTestId("agent-turn-model").textContent).toContain("This turn: openrouter-large");

    // M5: switching books clears the override and closes the picker with no stale write.
    view.rerender(
      React.createElement(WorkspaceView, {
        bookId: BOOK_B,
        theme: { choice: "light" as const, set: () => {}, cycle: () => {} },
        libraryRoot: LIBRARY,
        libraryStorage: undefined,
        onBack: () => {},
        onNotice: () => {},
        onSchemaRefusal: () => {}
      })
    );
    await testing.waitFor(() => expect(view.getByTestId("manuscript-text")).toBeTruthy(), { timeout: 5000 });
    expect(view.getByTestId("agent-turn-model").textContent).toContain("Model: book default");
    expect(view.queryByText("Model for this turn")).toBeNull();
    expect(counts.booksEdit).toBe(0);
  }, 20000);
});
