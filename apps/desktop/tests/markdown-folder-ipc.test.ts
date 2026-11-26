import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IPC, type MarkdownFolderCaptureResult, type MarkdownFolderPublishOutcome, type Result } from "@ai-book-studio/core/ipc";
import { MARKDOWN_FOLDER_CONSENT_DISCLOSURE } from "../src/main/markdown-folder";
import { DraftBuffer } from "../src/main/drafts";
import { Library } from "../src/main/library/store";
import { RecoveryStore } from "../src/main/recovery";
import { mockElectron } from "./support/mock-electron";
import { treeFingerprint } from "./support/tree-fingerprint";

/*
 * Spec 035 T014-U transport: the Markdown folder channels through `registerIpc` with a real
 * library in a temporary folder. The destination comes from the main process picker, a
 * renderer-supplied destination or publication override is refused, and picker cancel
 * writes nothing. Synthetic fixtures only.
 */

type Handler = (event: unknown, payload: unknown) => Promise<unknown>;
const handlers = new Map<string, Handler>();
const answers = { open: [] as Array<{ canceled: boolean; filePaths: string[] }> };
const askedOpen: unknown[] = [];
let registerIpc!: typeof import("../src/main/ipc").registerIpc;

beforeAll(async () => {
  mockElectron(tmpdir(), {
    handle: (channel, handler) => {
      handlers.set(channel, handler);
    },
    showOpenDialog: async (options) => {
      askedOpen.push(options);
      return answers.open.shift() ?? { canceled: true, filePaths: [] };
    },
    showSaveDialog: async () => ({ canceled: true }),
    showMessageBox: async () => ({ response: 1 })
  });
  ({ registerIpc } = await import("../src/main/ipc"));
});
afterAll(() => {
  mockElectron(tmpdir());
});

let savedExportPath: string | undefined;
const cleanups: string[] = [];
beforeEach(() => {
  savedExportPath = process.env.STUDIO_EXPORT_PATH;
  delete process.env.STUDIO_EXPORT_PATH;
});
afterEach(async () => {
  if (savedExportPath === undefined) delete process.env.STUDIO_EXPORT_PATH;
  else process.env.STUDIO_EXPORT_PATH = savedExportPath;
  answers.open.length = 0;
  askedOpen.length = 0;
  await Promise.all(cleanups.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function temp(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  cleanups.push(dir);
  return dir;
}

async function call(channel: string, payload?: unknown): Promise<Result<unknown>> {
  const handler = handlers.get(channel);
  if (!handler) throw new Error(`No handler registered for ${channel}.`);
  return (await handler({}, payload)) as Result<unknown>;
}
async function data<T>(channel: string, payload?: unknown): Promise<T> {
  const result = await call(channel, payload);
  if (!result.ok) throw new Error(`${channel} refused: [${result.error.code}] ${result.error.message}`);
  return result.data as T;
}

async function setup() {
  const root = await temp("studio-md-folder-ipc-");
  const library = await Library.open(root);
  const profile = await temp("studio-md-folder-ipc-profile-");
  const studio = {
    library: library as Library | null,
    drafts: new DraftBuffer(),
    recovery: new RecoveryStore(join(profile, "recovery")),
    current() {
      return this.library
        ? { root: this.library.root, deviceId: this.library.deviceId, deviceName: this.library.deviceName }
        : null;
    },
    requireLibrary() {
      if (!this.library) throw new Error("No library is open. Choose a folder first.");
      return this.library;
    },
    async openLibrary(folder: string) {
      this.library = await Library.open(folder);
      return this.current();
    }
  };
  const saved: Record<string, unknown> = {};
  const settings = {
    get: () => saved,
    voicePreferences: () => saved.voicePreferences,
    update: async (patch: Record<string, unknown>) => {
      Object.assign(saved, patch);
    }
  };
  const stub = mock(async () => null);
  registerIpc(
    studio as never,
    () => null as never,
    { list: stub, available: stub, status: stub, check: stub, remove: stub, startOpenRouter: stub, cancelOpenRouter: stub, addKey: stub, models: stub, test: stub } as never,
    { start: stub, stop: stub, undoLast: stub, approve: stub } as never,
    { connections: stub, transcribe: stub } as never,
    { generate: stub } as never,
    { catalog: mock(async () => []) } as never,
    settings as never,
    { connections: stub, speak: stub } as never,
    () => null,
    { status: null, start: stub, stop: stub } as never,
    () => false
  );
  return { root, library };
}

async function bookWithLegacy(library: Library) {
  const created = await library.createBook({ title: "The Salt Road", description: "A road that floods twice a day." });
  await library.createChapter(created.id, { title: "The Tide", content: "The salt road was under water.\n" });
  // Add a legacy entry no included section represents, so consent has something to exclude.
  const { book } = await library.readBook(created.id);
  await library.updateBook(created.id, { frontMatter: { notes: "synthetic legacy text" } });
  void book;
  return created.id;
}

describe("markdown folder IPC journey", () => {
  test("capture returns the frozen consent with the exact disclosure and no legacy values", async () => {
    const { library } = await setup();
    const bookId = await bookWithLegacy(library);
    const capture = await data<MarkdownFolderCaptureResult>(IPC.books.exportMarkdownFolderCapture, bookId);
    expect(capture.status).toBe("ready");
    if (capture.status !== "ready") throw new Error("expected ready capture");
    expect(capture.consentDisclosure).toBe(MARKDOWN_FOLDER_CONSENT_DISCLOSURE);
    expect(capture.bookId).toBe(bookId);
    expect(capture.captureSequence).toBe(1);
    expect(capture.policyLabel).toBe("Q0 production policy v1");
    expect(capture.excludedLegacy).toEqual([{ position: 1, key: "notes", keyIsFallback: false, reason: "not-represented" }]);
    expect(JSON.stringify(capture)).not.toContain("synthetic legacy text");
    expect(capture.files).toContain("README.md");
    expect(capture.attemptId).toMatch(/^[0-9a-f-]{36}$/);
  });

  test("picker cancel is a clean no-op and the same consent can still publish", async () => {
    const { library } = await setup();
    const bookId = await bookWithLegacy(library);
    const capture = await data<MarkdownFolderCaptureResult>(IPC.books.exportMarkdownFolderCapture, bookId);
    if (capture.status !== "ready") throw new Error("expected ready capture");
    const parent = await temp("studio-md-folder-ipc-out-");
    answers.open.push({ canceled: true, filePaths: [] });
    expect(await data(IPC.books.exportMarkdownFolderPublish, { bookId, attemptId: capture.attemptId, folderName: "the-salt-road-markdown" })).toBeNull();
    expect(await readdir(parent)).toEqual([]);
    answers.open.push({ canceled: false, filePaths: [parent] });
    const outcome = await data<MarkdownFolderPublishOutcome>(IPC.books.exportMarkdownFolderPublish, {
      bookId,
      attemptId: capture.attemptId,
      folderName: "the-salt-road-markdown"
    });
    expect(outcome.status).toBe("published");
    if (outcome.status !== "published") throw new Error("expected published outcome");
    expect(outcome.destinationPath).toBe(join(await realpath(parent), "the-salt-road-markdown"));
    expect(outcome.files).toContain("README.md");
    expect(await readFile(join(outcome.destinationPath, "README.md"), "utf8")).toContain("Reading order");
    expect(askedOpen[0]).toEqual(expect.objectContaining({ title: "Choose where to put the Markdown folder" }));
  });

  test("publishing an image-free Markdown folder preserves the whole source tree", async () => {
    const { root, library } = await setup();
    const bookId = await bookWithLegacy(library);
    const before = await treeFingerprint(root);
    const capture = await data<MarkdownFolderCaptureResult>(IPC.books.exportMarkdownFolderCapture, bookId);
    if (capture.status !== "ready") throw new Error("expected ready capture");
    const parent = await temp("studio-md-folder-ipc-image-free-");
    const folderName = capture.suggestedFolderName;
    const destinationPath = join(await realpath(parent), folderName);
    const chapterFile = "0002-chapter.md";
    answers.open.push({ canceled: false, filePaths: [parent] });
    const outcome = await data<MarkdownFolderPublishOutcome>(IPC.books.exportMarkdownFolderPublish, {
      bookId,
      attemptId: capture.attemptId,
      folderName
    });

    expect(outcome).toEqual({
      status: "published",
      destinationPath,
      files: ["README.md", "0001-title.md", chapterFile],
      warnings: []
    });
    expect(await readFile(join(destinationPath, chapterFile), "utf8")).toBe("# The Tide\n\nThe salt road was under water.\n");
    expect(await readdir(join(destinationPath, "images"))).toEqual([]);
    expect(await readdir(parent)).toEqual([folderName]);
    expect(await treeFingerprint(root)).toEqual(before);
  });

  test("a renderer-supplied destination or override is refused and publishes nothing", async () => {
    const { library } = await setup();
    const bookId = await bookWithLegacy(library);
    const capture = await data<MarkdownFolderCaptureResult>(IPC.books.exportMarkdownFolderCapture, bookId);
    if (capture.status !== "ready") throw new Error("expected ready capture");
    const parent = await temp("studio-md-folder-ipc-refused-");
    for (const payload of [
      { bookId, attemptId: capture.attemptId, folderName: "renderer-name", destinationPath: join(parent, "chosen-by-renderer") },
      { bookId, attemptId: capture.attemptId, folderName: "renderer-name", overrides: { writeFile: "fault" } },
      { bookId, attemptId: "not-a-uuid", folderName: "renderer-name" },
      { bookId: "../outside", attemptId: capture.attemptId, folderName: "renderer-name" }
    ]) {
      expect(await call(IPC.books.exportMarkdownFolderPublish, payload)).toMatchObject({ ok: false, error: { code: "invalid" } });
    }
    expect(await readdir(parent)).toEqual([]);
    await expect(stat(join(parent, "chosen-by-renderer"))).rejects.toThrow();
  });

  test("cancelling the consent prevents publication, and a new capture supersedes the old attempt", async () => {
    const { library } = await setup();
    const bookId = await bookWithLegacy(library);
    const first = await data<MarkdownFolderCaptureResult>(IPC.books.exportMarkdownFolderCapture, bookId);
    if (first.status !== "ready") throw new Error("expected ready capture");
    expect(
      await data(IPC.books.exportMarkdownFolderCancel, { bookId, attemptId: first.attemptId })
    ).toEqual({ status: "accepted", attemptId: first.attemptId });
    const parent = await temp("studio-md-folder-ipc-cancel-");
    answers.open.push({ canceled: false, filePaths: [parent] });
    expect(await call(IPC.books.exportMarkdownFolderPublish, { bookId, attemptId: first.attemptId, folderName: "the-salt-road-markdown" })).toMatchObject({
      ok: false,
      error: { code: "attempt-cancelled" }
    });
    expect(await readdir(parent)).toEqual([]);

    const stale = await data<MarkdownFolderCaptureResult>(IPC.books.exportMarkdownFolderCapture, bookId);
    if (stale.status !== "ready") throw new Error("expected ready capture");
    await data(IPC.books.exportMarkdownFolderCapture, bookId);
    answers.open.push({ canceled: false, filePaths: [parent] });
    expect(await call(IPC.books.exportMarkdownFolderPublish, { bookId, attemptId: stale.attemptId, folderName: "the-salt-road-markdown" })).toMatchObject({
      ok: false,
      error: { code: "consent-superseded" }
    });
    expect(await readdir(parent)).toEqual([]);
  });

  test("a destination inside the library is refused before anything is written", async () => {
    const { root, library } = await setup();
    const bookId = await bookWithLegacy(library);
    const capture = await data<MarkdownFolderCaptureResult>(IPC.books.exportMarkdownFolderCapture, bookId);
    if (capture.status !== "ready") throw new Error("expected ready capture");
    answers.open.push({ canceled: false, filePaths: [root] });
    const result = await call(IPC.books.exportMarkdownFolderPublish, { bookId, attemptId: capture.attemptId, folderName: "the-salt-road-markdown" });
    expect(result).toMatchObject({ ok: false, error: { code: "destination-aliases-source" } });
    expect(await readdir(join(root, "the-salt-road-markdown")).catch(() => null)).toBeNull();
    await writeFile(join(root, "probe.txt"), "probe");
    await rm(join(root, "probe.txt"));
  });

  test("a validated folder name creates exactly that name under the chosen parent", async () => {
    const { library } = await setup();
    const bookId = await bookWithLegacy(library);
    const capture = await data<MarkdownFolderCaptureResult>(IPC.books.exportMarkdownFolderCapture, bookId);
    if (capture.status !== "ready") throw new Error("expected ready capture");
    expect(capture.suggestedFolderName).toBe("the-salt-road-markdown");
    const parent = await temp("studio-md-folder-ipc-name-");
    answers.open.push({ canceled: false, filePaths: [parent] });
    const outcome = await data<MarkdownFolderPublishOutcome>(IPC.books.exportMarkdownFolderPublish, {
      bookId,
      attemptId: capture.attemptId,
      folderName: "Second Crossing"
    });
    expect(outcome.status).toBe("published");
    if (outcome.status !== "published") throw new Error("expected published outcome");
    expect(outcome.destinationPath).toBe(join(await realpath(parent), "Second Crossing"));
    expect(askedOpen.at(-1)).toEqual(
      expect.objectContaining({ message: "The folder “Second Crossing” will be created in the folder you choose." })
    );
    expect(await readdir(parent)).toEqual(["Second Crossing"]);
  });

  test("the same name twice is a name conflict, and a different name publishes beside the first", async () => {
    const { library } = await setup();
    const bookId = await bookWithLegacy(library);
    const parent = await temp("studio-md-folder-ipc-repeat-");
    const first = await data<MarkdownFolderCaptureResult>(IPC.books.exportMarkdownFolderCapture, bookId);
    if (first.status !== "ready") throw new Error("expected ready capture");
    answers.open.push({ canceled: false, filePaths: [parent] });
    const published = await data<MarkdownFolderPublishOutcome>(IPC.books.exportMarkdownFolderPublish, {
      bookId,
      attemptId: first.attemptId,
      folderName: "repeat-folder"
    });
    expect(published.status).toBe("published");
    const firstReadme = await readFile(join(parent, "repeat-folder", "README.md"), "utf8");

    const second = await data<MarkdownFolderCaptureResult>(IPC.books.exportMarkdownFolderCapture, bookId);
    if (second.status !== "ready") throw new Error("expected ready capture");
    answers.open.push({ canceled: false, filePaths: [parent] });
    const conflict = await data<MarkdownFolderPublishOutcome>(IPC.books.exportMarkdownFolderPublish, {
      bookId,
      attemptId: second.attemptId,
      folderName: "repeat-folder"
    });
    expect(conflict).toEqual({
      status: "name-conflict",
      message:
        "That folder already exists. This export creates a new folder and does not replace one. Nothing was published. Choose another folder name or another parent folder."
    });
    expect(await readFile(join(parent, "repeat-folder", "README.md"), "utf8")).toBe(firstReadme);
    expect((await readdir(parent)).sort()).toEqual(["repeat-folder"]);

    answers.open.push({ canceled: false, filePaths: [parent] });
    const secondPublish = await data<MarkdownFolderPublishOutcome>(IPC.books.exportMarkdownFolderPublish, {
      bookId,
      attemptId: second.attemptId,
      folderName: "repeat-folder-two"
    });
    expect(secondPublish.status).toBe("published");
    expect((await readdir(parent)).sort()).toEqual(["repeat-folder", "repeat-folder-two"]);
  });

  test("a path-like, reserved or empty name is refused before the picker", async () => {
    const { library } = await setup();
    const bookId = await bookWithLegacy(library);
    const capture = await data<MarkdownFolderCaptureResult>(IPC.books.exportMarkdownFolderCapture, bookId);
    if (capture.status !== "ready") throw new Error("expected ready capture");
    const parent = await temp("studio-md-folder-ipc-invalid-");
    for (const folderName of ["../outside", "CON", "", "bad/name", ".hidden"]) {
      const outcome = await data<MarkdownFolderPublishOutcome>(IPC.books.exportMarkdownFolderPublish, {
        bookId,
        attemptId: capture.attemptId,
        folderName
      });
      expect(outcome.status).toBe("name-invalid");
      if (outcome.status !== "name-invalid") throw new Error("expected name-invalid outcome");
      expect(outcome.message.length).toBeGreaterThan(0);
    }
    expect(askedOpen).toHaveLength(0);
    expect(await readdir(parent)).toEqual([]);
  });
});
