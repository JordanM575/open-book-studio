/// <reference types="bun" />
import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from "bun:test";
import React from "react";
import { mountDom, unmountDom } from "./support/dom";
import { bookSchema, chapterMetaSchema } from "@ai-book-studio/core/schema";
import type { Chapter } from "@ai-book-studio/core/schema";
import { ambientStatus } from "@ai-book-studio/core/agent/ambient";

let testing!: typeof import("@testing-library/react/pure");
let WorkspaceView!: typeof import("@ai-book-studio/app/views/WorkspaceView").WorkspaceView;
let FormatDialog!: typeof import("@ai-book-studio/app/components/FormatDialog").FormatDialog;

beforeAll(async () => {
  testing = await mountDom();
  ({ WorkspaceView } = await import("@ai-book-studio/app/views/WorkspaceView"));
  ({ FormatDialog } = await import("@ai-book-studio/app/components/FormatDialog"));
});
afterAll(async () => {
  await unmountDom();
});

afterEach(() => testing.cleanup());

/**
 * Spec 035 with D-108: the Format dialog exports the chosen target. It saves the open chapter
 * first and never exports over a failed save, uses each target's own channel, names the saved
 * file the way the header does, and says plainly why an export did not happen. The browser build
 * explains that exporting is a desktop feature. Synthetic content only.
 */

const NOW = "2026-11-03T00:00:00.000Z";
const BOOK = "book_fx000002";
const OTHER_BOOK = "book_fx000003";

function chapter(id: string, title: string, order: number, content: string): Chapter {
  return {
    ...chapterMetaSchema.parse({ id, title, order, createdAt: NOW, updatedAt: NOW }),
    content,
    path: `000${order}-x.md`,
    wordCount: content.trim().split(/\s+/u).length,
    hash: "a".repeat(64)
  };
}

const CHAPTER = chapter("ch_fx000010", "First", 1, "First line.\n");

type Answer =
  | { ok: true; data: string | { path: string; warnings: string[] } | { status: "cancelled"; message: string } | null }
  | { ok: false; error: { code: string; message: string } };

interface Setup {
  platform?: string;
  save?: () => Promise<unknown>;
  edit?: () => Promise<unknown>;
  matter?: (input: Parameters<typeof window.studio.books.saveMatter>[0]) => Promise<unknown>;
  answers?: Partial<Record<"exportDocx" | "exportMarkdown" | "exportPdf" | "exportEpub", () => Promise<Answer>>>;
  cancel?: () => Promise<unknown>;
}

function mockWorkspace(setup: Setup = {}) {
  const order: string[] = [];
  const detail = (id = BOOK) => ({
    book: bookSchema.parse({ id, title: id === BOOK ? "Exported" : "Other export book", createdAt: NOW, updatedAt: NOW }),
    chapters: [id === BOOK ? CHAPTER : { ...CHAPTER, id: "ch_fx000011", title: "Other" }],
    chapterReadIssues: []
  });
  const exporter = (name: "exportDocx" | "exportMarkdown" | "exportPdf" | "exportEpub", file: string) =>
    mock((_bookId: string, _attemptId: string) => {
      order.push(name);
      return setup.answers?.[name]?.() ?? Promise.resolve<Answer>({ ok: true, data: `/tmp/exports/${file}` });
    });
  const exportCancel = mock(async (_input: { bookId: string; attemptId: string }) =>
    setup.cancel?.() ?? { ok: true, data: { status: "accepted", attemptId: "synthetic-attempt" } }
  );
  const exports = {
    exportDocx: exporter("exportDocx", "exported.docx"),
    exportMarkdown: exporter("exportMarkdown", "exported.md"),
    exportPdf: exporter("exportPdf", "exported.pdf"),
    exportEpub: exporter("exportEpub", "exported.epub"),
    exportCancel
  };
  const save = mock((_input: unknown) => {
    order.push("save");
    return setup.save?.() ?? Promise.resolve({ ok: true, data: { status: "saved", chapter: CHAPTER } });
  });
  const onNotice = mock((_error: unknown) => {});
  const saveMatter = mock((input: Parameters<typeof window.studio.books.saveMatter>[0]) => {
    order.push("matter");
    return setup.matter?.(input) ?? Promise.resolve({ ok: true, data: { status: "saved", book: { ...detail(input.bookId).book, matter: input.matter } } });
  });
  (globalThis as unknown as { window: { studio: unknown } }).window.studio = {
    platform: setup.platform ?? "darwin",
    books: {
      open: mock((id: string) => Promise.resolve({ ok: true, data: detail(id) })),
      update: mock(() => Promise.resolve({ ok: true, data: detail().book })),
      edit: mock(() => setup.edit?.() ?? Promise.resolve({ ok: true, data: { status: "saved", book: detail().book } })),
      saveMatter,
      ...exports
    },
    chapters: {
      create: mock(() => Promise.resolve({ ok: true, data: CHAPTER })),
      reorder: mock(() => Promise.resolve({ ok: true, data: { status: "saved", chapters: [CHAPTER] } })),
      move: mock(() => Promise.resolve({ ok: true, data: { status: "saved", chapters: [CHAPTER] } })),
      delete: mock(() => Promise.resolve({ ok: true, data: null })),
      save
    },
    conflicts: { list: mock(() => Promise.resolve({ ok: true, data: [] })), reveal: mock(() => Promise.resolve({ ok: true, data: null })) },
    drafts: { set: mock(() => Promise.resolve({ ok: true, data: null })), clear: mock(() => Promise.resolve({ ok: true, data: null })), onFlushRequest: mock(() => () => {}) },
    recovery: { list: mock(() => Promise.resolve({ ok: true, data: [] })) },
    images: { list: mock(() => Promise.resolve({ ok: true, data: { manifest: { images: [] } } })) },
    library: { onChange: mock(() => () => {}) },
    agent: {
      onEvent: mock(() => () => {}),
      ambient: mock(() =>
        Promise.resolve({
          ok: true,
          data: ambientStatus({
            book: { id: BOOK, title: "Exported", stage: "drafting" },
            chapters: [{ id: CHAPTER.id, title: "First", order: 1, wordCount: 2 }]
          })
        })
      )
    },
    voice: {
      connections: mock(async () => ({ ok: true, data: [] })),
      speakers: mock(async () => ({ ok: true, data: { available: false, connectionLabel: null, endpoint: null, model: null, voices: [] } }))
    }
  };
  const component = (bookId: string) =>
    React.createElement(WorkspaceView, {
      bookId,
      theme: { choice: "light" as const, set: () => {}, cycle: () => {} },
      libraryRoot: "/tmp/studio-library",
      libraryStorage: undefined,
      onBack: () => {},
      onNotice,
      onSchemaRefusal: () => {}
    });
  const mounted = testing.render(component(BOOK));
  return { order, save, saveMatter, onNotice, mounted, component, ...exports };
}

async function openFormat() {
  const view = testing.within(document.body);
  await testing.waitFor(() => {
    expect(view.getByTestId("manuscript-text")).toBeTruthy();
  });
  testing.fireEvent.click(view.getByTestId("format-book"));
  await testing.waitFor(() => {
    expect(view.getByTestId("format-preview")).toBeTruthy();
  });
  return view;
}

function choose(view: ReturnType<typeof testing.within>, target: string): void {
  testing.fireEvent.click(view.getByRole("radio", { name: target }));
}

describe("format dialog export", () => {
  for (const [target, channel] of [
    ["DOCX", "exportDocx"], ["PDF", "exportPdf"], ["EPUB", "exportEpub"], ["Markdown", "exportMarkdown"]
  ] as const) {
    for (const phase of ["chapter", "matter"] as const) {
      test.each(["switch", "switch-back", "unmount"] as const)(`${target} ignores a delayed ${phase} save after %s`, async (leave) => {
        let finish!: () => void;
        const held = new Promise<void>((resolve) => { finish = resolve; });
        const setup = mockWorkspace(phase === "chapter" ? {
          save: async () => { await held; return { ok: true, data: { status: "saved", chapter: CHAPTER } }; }
        } : {
          matter: async (input) => {
            await held;
            return { ok: true, data: { status: "saved", book: bookSchema.parse({
              id: BOOK, title: "Exported", createdAt: NOW, updatedAt: NOW, matter: input.matter
            }) } };
          }
        });
        const view = await openFormat();
        if (phase === "chapter") {
          testing.fireEvent.change(view.getByTestId("manuscript-text"), { target: { value: "Pending synthetic edit." } });
        } else {
          testing.fireEvent.change(view.getByLabelText("Author"), { target: { value: "Synthetic author" } });
        }
        choose(view, target);
        testing.fireEvent.click(view.getByTestId("format-export"));
        await testing.waitFor(() => expect(phase === "chapter" ? setup.save : setup.saveMatter).toHaveBeenCalledTimes(1));
        expect(setup[channel]).not.toHaveBeenCalled();
        if (leave === "unmount") setup.mounted.unmount();
        else {
          setup.mounted.rerender(setup.component(OTHER_BOOK));
          await testing.waitFor(() => expect(view.getByTestId("workspace-view").querySelector("header h1")?.textContent).toBe("Other export book"));
          if (leave === "switch-back") {
            setup.mounted.rerender(setup.component(BOOK));
            await testing.waitFor(() => expect(view.getByTestId("workspace-view").querySelector("header h1")?.textContent).toBe("Exported"));
          }
        }
        await testing.act(async () => { finish(); await held; });
        expect(setup[channel]).not.toHaveBeenCalled();
        expect(setup.onNotice).not.toHaveBeenCalled();
      });
    }
  }

  const entrypoints = [
    { target: "DOCX", channel: "exportDocx", header: "export-docx" },
    { target: "Markdown", channel: "exportMarkdown", header: "export-markdown" },
    { target: "DOCX", channel: "exportDocx" },
    { target: "PDF", channel: "exportPdf" },
    { target: "EPUB", channel: "exportEpub" },
    { target: "Markdown", channel: "exportMarkdown" }
  ] as const;

  for (const entry of entrypoints) {
    const header = "header" in entry ? entry.header : null;
    test(`${header ?? "Format"} ${entry.target} shows returned warning and snapshot destination`, async () => {
      const warning = "Skipped synthetic.png (First): the image file could not be read.";
      const path = `/synthetic/output.${entry.target.toLowerCase()}`;
      mockWorkspace({ answers: { [entry.channel]: async () => ({ ok: true, data: { path, warnings: [warning] } }) } });
      const view = testing.within(document.body);
      await testing.waitFor(() => expect(view.getByTestId("manuscript-text")).toBeTruthy());
      if (!header) { await openFormat(); choose(view, entry.target); }
      testing.fireEvent.click(view.getByTestId(header ?? "format-export"));
      await testing.waitFor(() => expect(view.getByText(warning)).toBeTruthy());
      expect(view.getByText(/Saved version captured when export began/).textContent).toContain(path);
      expect(view.queryByTestId("format-export-error")).toBeNull();
    });

    for (const outcome of ["error", "conflict"] as const) {
      test(`${header ?? "Format"} ${entry.target} waits for save and refuses ${outcome} with draft intact`, async () => {
        let finish!: (value: unknown) => void;
        const mocks = mockWorkspace({ save: () => new Promise((resolve) => { finish = resolve; }) });
        const view = testing.within(document.body);
        await testing.waitFor(() => expect(view.getByTestId("manuscript-text")).toBeTruthy());
        testing.fireEvent.change(view.getByTestId("manuscript-text"), { target: { value: "SYNTHETIC_UNSAVED_WORDS\n" } });
        if (!header) { await openFormat(); choose(view, entry.target); }
        testing.fireEvent.click(view.getByTestId(header ?? "format-export"));
        await testing.waitFor(() => expect(mocks.save).toHaveBeenCalledTimes(1));
        expect(mocks[entry.channel]).not.toHaveBeenCalled();
        await testing.act(async () => finish(outcome === "error"
          ? { ok: false, error: { code: "io", message: "Synthetic disk full" } }
          : { ok: true, data: { status: "conflict", conflict: {
            bookId: BOOK, chapterId: CHAPTER.id, chapterTitle: CHAPTER.title,
            savedAs: "conflicts/synthetic.md", reason: "newer-version", diskVersion: 2, localVersion: 1
          } } }));
        if (header) {
          await testing.waitFor(() => expect(mocks.onNotice).toHaveBeenCalled());
          expect((mocks.onNotice.mock.calls.at(-1)?.[0] as Error | undefined)?.message).toContain("nothing was exported");
        } else {
          await testing.waitFor(() => expect(view.getByTestId("format-export-error").textContent).toContain("nothing was exported"));
        }
        expect(mocks[entry.channel]).not.toHaveBeenCalled();
        expect((view.getByTestId("manuscript-text") as HTMLTextAreaElement).value).toBe("SYNTHETIC_UNSAVED_WORDS\n");
      });
    }
  }

  test("closing Format does not let the header bypass a pending or failed settings save", async () => {
    let finish!: (value: unknown) => void;
    const mocks = mockWorkspace({ edit: () => new Promise((resolve) => { finish = resolve; }) });
    const view = await openFormat();
    testing.fireEvent.change(view.getByLabelText("Size"), { target: { value: "14" } });
    await testing.act(async () => {});
    testing.fireEvent.keyDown(document, { key: "Escape" });
    await testing.waitFor(() => expect(view.queryByTestId("format-preview")).toBeNull());
    testing.fireEvent.click(view.getByTestId("export-docx"));
    await testing.waitFor(() => expect(mocks.onNotice).toHaveBeenCalled());
    expect((mocks.onNotice.mock.calls.at(-1)?.[0] as Error | undefined)?.message).toContain("finish saving");
    expect(mocks.exportDocx).not.toHaveBeenCalled();
    await testing.act(async () => finish({ ok: false, error: { code: "io", message: "Synthetic settings failure" } }));
    testing.fireEvent.click(view.getByTestId("export-markdown"));
    await testing.waitFor(() => expect((mocks.onNotice.mock.calls.at(-1)?.[0] as Error | undefined)?.message).toContain("Nothing was exported"));
    expect(mocks.exportMarkdown).not.toHaveBeenCalled();
  });

  test("pending and rejected typography saves stop export until another edit saves", async () => {
    let reject!: (error: Error) => void;
    const book = bookSchema.parse({ id: BOOK, title: "Synthetic", createdAt: NOW, updatedAt: NOW });
    const exportDocx = mock(async () => ({ ok: true, data: "/synthetic/out.docx" }));
    window.studio = { platform: "darwin", books: { exportDocx } } as unknown as typeof window.studio;
    const save = mock(() => new Promise<void>((_resolve, fail) => { reject = fail; }));
    const view = testing.render(React.createElement(FormatDialog, {
      open: true, onClose: () => {}, bookId: BOOK, bookTitle: book.title, book,
      onBookSaved: () => {}, onNotice: () => {}, settings: book.settings.manuscript,
      chapters: [CHAPTER], onSaveSettings: save, onFlush: async () => null
    }));
    testing.fireEvent.change(view.getByLabelText("Size"), { target: { value: "14" } });
    testing.fireEvent.click(view.getByTestId("format-export"));
    await testing.waitFor(() => expect(view.getByTestId("format-export-error").textContent).toContain("format settings"));
    expect(exportDocx).not.toHaveBeenCalled();
    reject(new Error("Synthetic disk full"));
    await testing.act(async () => {});
    testing.fireEvent.click(view.getByTestId("format-export"));
    await testing.waitFor(() => expect(view.getByTestId("format-export-error").textContent).toContain("Synthetic disk full"));
    expect(exportDocx).not.toHaveBeenCalled();
    save.mockImplementation(async () => {});
    testing.fireEvent.change(view.getByLabelText("Size"), { target: { value: "13" } });
    await testing.act(async () => {});
    testing.fireEvent.click(view.getByTestId("format-export"));
    await testing.waitFor(() => expect(exportDocx).toHaveBeenCalledTimes(1));
  });

  test("PDF saves the open chapter first, then exports and names the saved file", async () => {
    const mocks = mockWorkspace();
    const view = testing.within(document.body);
    await testing.waitFor(() => {
      expect(view.getByTestId("manuscript-text")).toBeTruthy();
    });
    testing.fireEvent.change(view.getByTestId("manuscript-text"), { target: { value: "First line, edited.\n" } });
    testing.fireEvent.click(view.getByTestId("format-book"));
    await testing.waitFor(() => {
      expect(view.getByTestId("format-preview")).toBeTruthy();
    });

    choose(view, "PDF");
    expect(view.getByTestId("format-export").textContent).toBe("Export PDF");
    expect(view.getByTestId("format-target-note").textContent).toContain("each chapter on a new page");
    testing.fireEvent.click(view.getByTestId("format-export"));

    await testing.waitFor(() => {
      expect(view.getByTestId("format-export-note").textContent).toBe("Saved exported.pdf");
    });
    // The note reads like the header's; the full destination is on the note itself.
    expect(view.getByTestId("format-export-note").getAttribute("title")).toBe("/tmp/exports/exported.pdf");
    expect(mocks.exportPdf).toHaveBeenCalledTimes(1);
    expect(mocks.exportPdf.mock.calls[0]?.[0]).toBe(BOOK);
    expect(mocks.order.indexOf("save")).toBeGreaterThan(-1);
    expect(mocks.order.indexOf("save")).toBeLessThan(mocks.order.indexOf("exportPdf"));
    expect(mocks.exportDocx).not.toHaveBeenCalled();
    expect(mocks.onNotice).not.toHaveBeenCalled();
  });

  test("each target exports through its own channel", async () => {
    const mocks = mockWorkspace();
    const view = await openFormat();
    const cases = [
      { target: "EPUB", label: "Export EPUB", note: "Saved exported.epub", call: mocks.exportEpub },
      { target: "DOCX", label: "Export Word document", note: "Saved exported.docx", call: mocks.exportDocx },
      { target: "Markdown", label: "Export Markdown", note: "Saved exported.md", call: mocks.exportMarkdown }
    ];
    for (const { target, label, note, call } of cases) {
      choose(view, target);
      expect(view.getByTestId("format-export").textContent).toBe(label);
      testing.fireEvent.click(view.getByTestId("format-export"));
      await testing.waitFor(() => {
        expect(view.getByTestId("format-export-note").textContent).toBe(note);
      });
      expect(call).toHaveBeenCalledTimes(1);
    }
    expect(mocks.exportPdf).not.toHaveBeenCalled();
  });

  test("a cancelled picker says nothing and the action is ready again", async () => {
    const mocks = mockWorkspace({ answers: { exportEpub: () => Promise.resolve({ ok: true, data: null }) } });
    const view = await openFormat();
    choose(view, "EPUB");
    testing.fireEvent.click(view.getByTestId("format-export"));
    await testing.waitFor(() => {
      expect(mocks.exportEpub).toHaveBeenCalledTimes(1);
      expect((view.getByTestId("format-export") as HTMLButtonElement).disabled).toBe(false);
    });
    expect(view.getByTestId("format-export-note").textContent).toBe("");
    expect(view.queryByTestId("format-export-error")).toBeNull();
  });

  test("a refused export says why in the dialog and claims nothing was saved", async () => {
    const refusal =
      "That location is inside the open library. Choose another folder so the export cannot overwrite the book's own files.";
    const mocks = mockWorkspace({
      answers: { exportPdf: () => Promise.resolve({ ok: false, error: { code: "invalid", message: refusal } }) }
    });
    const view = await openFormat();
    choose(view, "PDF");
    testing.fireEvent.click(view.getByTestId("format-export"));
    await testing.waitFor(() => {
      expect(view.getByTestId("format-export-error").textContent).toBe(refusal);
    });
    expect(view.getByTestId("format-export-error").getAttribute("role")).toBe("alert");
    expect(view.getByTestId("format-export-note").textContent).toBe("");
    expect(mocks.onNotice).not.toHaveBeenCalled();
  });

  test("a chapter that cannot be saved stops the export before it starts", async () => {
    const mocks = mockWorkspace({
      save: () => Promise.resolve({ ok: false, error: { code: "io", message: "The disk is full." } })
    });
    const view = testing.within(document.body);
    await testing.waitFor(() => {
      expect(view.getByTestId("manuscript-text")).toBeTruthy();
    });
    testing.fireEvent.change(view.getByTestId("manuscript-text"), { target: { value: "Unsaved words.\n" } });
    testing.fireEvent.click(view.getByTestId("format-book"));
    await testing.waitFor(() => {
      expect(view.getByTestId("format-preview")).toBeTruthy();
    });
    choose(view, "PDF");
    testing.fireEvent.click(view.getByTestId("format-export"));
    await testing.waitFor(() => {
      // The same words the workspace header export uses for the same failed save.
      expect(view.getByTestId("format-export-error").textContent).toBe(
        "Your latest change couldn't be saved, so nothing was exported. The disk is full."
      );
    });
    expect(mocks.save).toHaveBeenCalled();
    expect(mocks.exportPdf).not.toHaveBeenCalled();
  });

  test("the dialog stays open until a running export finishes", async () => {
    let finish!: (answer: Answer) => void;
    const mocks = mockWorkspace({
      answers: { exportPdf: () => new Promise<Answer>((resolve) => (finish = resolve)) }
    });
    const view = await openFormat();
    choose(view, "PDF");
    testing.fireEvent.click(view.getByTestId("format-export"));
    await testing.waitFor(() => {
      expect(mocks.exportPdf).toHaveBeenCalledTimes(1);
    });
    expect(view.getByTestId("format-export").textContent).toBe("Exporting…");
    expect((view.getByTestId("format-export") as HTMLButtonElement).disabled).toBe(true);
    testing.fireEvent.keyDown(document, { key: "Escape" });
    expect(view.getByTestId("format-preview")).toBeTruthy();

    finish({ ok: true, data: "/tmp/exports/exported.pdf" });
    await testing.waitFor(() => {
      expect(view.getByTestId("format-export-note").textContent).toBe("Saved exported.pdf");
    });
    testing.fireEvent.keyDown(document, { key: "Escape" });
    await testing.waitFor(() => {
      expect(view.queryByTestId("format-preview")).toBeNull();
    });
  });

  test("reopening the dialog starts again at DOCX with no old note", async () => {
    mockWorkspace();
    const view = await openFormat();
    choose(view, "EPUB");
    testing.fireEvent.click(view.getByTestId("format-export"));
    await testing.waitFor(() => {
      expect(view.getByTestId("format-export-note").textContent).toBe("Saved exported.epub");
    });
    testing.fireEvent.keyDown(document, { key: "Escape" });
    await testing.waitFor(() => {
      expect(view.queryByTestId("format-preview")).toBeNull();
    });
    testing.fireEvent.click(view.getByTestId("format-book"));
    await testing.waitFor(() => {
      expect(view.getByTestId("format-preview")).toBeTruthy();
    });
    expect((view.getByRole("radio", { name: "DOCX" }) as HTMLInputElement).checked).toBe(true);
    expect(view.getByTestId("format-export").textContent).toBe("Export Word document");
    expect(view.getByTestId("format-export-note").textContent).toBe("");
  });

  test("the browser build explains that exporting is a desktop feature", async () => {
    const mocks = mockWorkspace({ platform: "web" });
    const view = await openFormat();
    const action = view.getByTestId("format-export") as HTMLButtonElement;
    expect(action.disabled).toBe(true);
    expect(view.getByTestId("format-export-note").textContent).toBe("Exporting is available in the desktop app.");
    testing.fireEvent.click(action);
    expect(mocks.exportDocx).not.toHaveBeenCalled();
  });

  for (const [target, channel] of [
    ["DOCX", "exportDocx"], ["PDF", "exportPdf"], ["EPUB", "exportEpub"], ["Markdown", "exportMarkdown"]
  ] as const) {
    test(`${target} shows Cancel export while running, sends the attempt id and settles cancelled`, async () => {
      let finish!: (value: Answer) => void;
      const pending = new Promise<Answer>((resolve) => { finish = resolve; });
      const mocks = mockWorkspace({ answers: { [channel]: () => pending } });
      const view = await openFormat();
      choose(view, target);
      testing.fireEvent.click(view.getByTestId("format-export"));
      await testing.waitFor(() => expect(view.getByTestId("format-export-cancel")).toBeTruthy());
      const exporter = mocks[channel] as ReturnType<typeof mock>;
      const attemptId = exporter.mock.calls[0]?.[1];
      expect(typeof attemptId).toBe("string");
      testing.fireEvent.click(view.getByTestId("format-export-cancel"));
      await testing.waitFor(() => expect(mocks.exportCancel).toHaveBeenCalledTimes(1));
      expect(mocks.exportCancel.mock.calls[0]?.[0]).toEqual({ bookId: BOOK, attemptId });
      await testing.act(async () =>
        finish({ ok: true, data: { status: "cancelled", message: "The export was cancelled before it was published. Nothing was written." } })
      );
      await testing.waitFor(() => expect(view.getByTestId("format-export-cancelled")).toBeTruthy());
      expect(view.getByTestId("format-export-cancelled").textContent).toContain("cancelled before it was published");
      expect((view.getByTestId("format-export") as HTMLButtonElement).disabled).toBe(false);
      expect(view.queryByTestId("format-export-cancel")).toBeNull();
    });
  }

  test("a too-late cancel lets the published receipt replace the line and never claims cancellation", async () => {
    let finish!: (value: Answer) => void;
    const pending = new Promise<Answer>((resolve) => { finish = resolve; });
    const mocks = mockWorkspace({
      answers: { exportPdf: () => pending },
      cancel: async () => ({ ok: true, data: { status: "too-late", attemptId: "synthetic-attempt" } })
    });
    const view = await openFormat();
    choose(view, "PDF");
    testing.fireEvent.click(view.getByTestId("format-export"));
    await testing.waitFor(() => expect(view.getByTestId("format-export-cancel")).toBeTruthy());
    testing.fireEvent.click(view.getByTestId("format-export-cancel"));
    await testing.waitFor(() => expect(view.getByTestId("format-export-status")).toBeTruthy());
    expect(view.getByTestId("format-export-status").textContent).toContain("The export is finishing");
    await testing.act(async () => finish({ ok: true, data: { path: "/tmp/exports/exported.pdf", warnings: [] } }));
    await testing.waitFor(() => expect(view.getByTestId("format-export-note").textContent).toBe("Saved exported.pdf"));
    expect(view.queryByTestId("format-export-cancelled")).toBeNull();
    expect(mocks.exportCancel).toHaveBeenCalledTimes(1);
  });

  test("the header export shows Cancel export and settles a cancelled outcome", async () => {
    let finish!: (value: Answer) => void;
    const pending = new Promise<Answer>((resolve) => { finish = resolve; });
    const mocks = mockWorkspace({ answers: { exportDocx: () => pending } });
    const view = testing.within(document.body);
    await testing.waitFor(() => expect(view.getByTestId("manuscript-text")).toBeTruthy());
    testing.fireEvent.click(view.getByTestId("export-docx"));
    await testing.waitFor(() => expect(view.getByTestId("workspace-export-cancel")).toBeTruthy());
    const attemptId = mocks.exportDocx.mock.calls[0]?.[1];
    expect(typeof attemptId).toBe("string");
    testing.fireEvent.click(view.getByTestId("workspace-export-cancel"));
    await testing.waitFor(() => expect(mocks.exportCancel).toHaveBeenCalledWith({ bookId: BOOK, attemptId }));
    await testing.act(async () =>
      finish({ ok: true, data: { status: "cancelled", message: "The export was cancelled before it was published. Nothing was written." } })
    );
    await testing.waitFor(() => expect(view.getByTestId("workspace-export-note")).toBeTruthy());
    expect(view.getByTestId("workspace-export-note").textContent).toContain("cancelled before it was published");
    expect((view.getByTestId("export-docx") as HTMLButtonElement).disabled).toBe(false);
    expect(view.queryByTestId("workspace-export-cancel")).toBeNull();
  });

  test("the Markdown folder target keeps its own cancel control only", async () => {
    mockWorkspace();
    const view = await openFormat();
    choose(view, "Markdown folder");
    expect(view.queryByTestId("format-export-cancel")).toBeNull();
  });
});
