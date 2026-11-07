import { afterAll, afterEach, beforeAll, describe, expect, mock, spyOn, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IPC, type Result } from "@ai-book-studio/core/ipc";
import { MATTER_LIMITS, matterHash, newMatterSection, readMatter } from "@ai-book-studio/core/matter";
import { agentMessageSchema } from "@ai-book-studio/core/agent/messages";
import { PROVIDER_LIST } from "@ai-book-studio/core/providers/registry";
import { DEFAULT_VOICE_PREFERENCES, type VoicePreferences } from "@ai-book-studio/core/providers/voice-preferences";
import { ProviderError } from "@ai-book-studio/core/providers/types";
import type { Chapter } from "@ai-book-studio/core/schema";
import { DraftBuffer } from "../src/main/drafts";
import { Library } from "../src/main/library/store";
import { MetricsStore } from "../src/main/metrics";
import { RecoveryStore } from "../src/main/recovery";
import { UsageStore } from "../src/main/usage";
import { mockElectron } from "./support/mock-electron";

/*
 * The main process's IPC surface, driven through `registerIpc` with a real library in a temporary
 * folder. Electron is the shared mock: handlers are recorded, the shell and the native dialogs are
 * answered by the test. Services that would reach a provider are stubs, because what is under test
 * is the boundary: what it refuses, what it hands on, and what lands on disk.
 */

type Handler = (event: unknown, payload: unknown) => Promise<unknown>;

const handlers = new Map<string, Handler>();
const shown: string[] = [];
const answers = {
  open: [] as Array<{ canceled: boolean; filePaths: string[] }>,
  save: [] as Array<{ canceled: boolean; filePath?: string }>,
  message: [] as Array<{ response: number }>
};
const asked = { open: [] as unknown[], save: [] as unknown[], message: [] as unknown[], windows: [] as unknown[] };

let registerIpc!: typeof import("../src/main/ipc").registerIpc;

beforeAll(async () => {
  mockElectron(tmpdir(), {
    handle: (channel, handler) => {
      handlers.set(channel, handler);
    },
    showItemInFolder: (path) => {
      shown.push(path);
    },
    showOpenDialog: async (options, window) => {
      asked.open.push(options);
      asked.windows.push(window);
      return answers.open.shift() ?? { canceled: true, filePaths: [] };
    },
    showSaveDialog: async (options, window) => {
      asked.save.push(options);
      asked.windows.push(window);
      return answers.save.shift() ?? { canceled: true };
    },
    showMessageBox: async (options, window) => {
      asked.message.push(options);
      asked.windows.push(window);
      return answers.message.shift() ?? { response: 1 };
    }
  });
  ({ registerIpc } = await import("../src/main/ipc"));
});

afterAll(() => {
  // Later files share the one Electron mock, so it goes back to its defaults.
  mockElectron(tmpdir());
});

const ENV = ["STUDIO_EXPORT_PATH", "STUDIO_IMPORT_PATH"] as const;
const savedEnv = new Map(ENV.map((key) => [key, process.env[key]]));
const platform = Object.getOwnPropertyDescriptor(process, "platform");
const cleanups: string[] = [];

afterEach(async () => {
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  if (platform) Object.defineProperty(process, "platform", platform);
  for (const list of [answers.open, answers.save, answers.message, asked.open, asked.save, asked.message, asked.windows, shown]) {
    list.length = 0;
  }
  await Promise.all(cleanups.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function temp(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  cleanups.push(dir);
  return dir;
}

function onPlatform(value: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", { value, configurable: true });
}

const NOW = "2026-11-03T12:00:00.000Z";
const BOOK = "book_ipc000001";
const CONNECTION = {
  id: "conn_ipc000001",
  provider: "openrouter" as const,
  label: "OpenRouter",
  kind: "api-key" as const,
  createdAt: NOW
};
// A key-shaped value, assembled at runtime so the repository's secret scan never sees one here.
const KEY = ["sk", "or", "v1", "0123456789abcdef0123456789abcdef"].join("-");
const PNG = new Uint8Array(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lK3Q6wAAAABJRU5ErkJggg==",
    "base64"
  )
);

async function setup(options: { open?: boolean; window?: object } = {}) {
  const root = await temp("studio-ipc-");
  const library = await Library.open(root);
  // The recovery store lives in the profile, which is never inside the library.
  const profile = await temp("studio-ipc-profile-");
  const studio = {
    library: options.open === false ? null : (library as Library | null),
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
    voicePreferences: () => (saved.voicePreferences as VoicePreferences | undefined) ?? DEFAULT_VOICE_PREFERENCES,
    update: async (patch: Record<string, unknown>) => {
      Object.assign(saved, patch);
    }
  };
  const providers = {
    list: mock(async () => [CONNECTION]),
    available: mock(async () => true),
    status: mock(async () => ({ available: true, backend: "Protected storage", detail: "", connections: 1 })),
    check: mock(async () => ({ available: false, backend: "Protected storage", detail: "Locked.", connections: 1 })),
    credential: mock(async (id: string) => ({ ...CONNECTION, id, secret: KEY })),
    remove: mock(async (_id: string) => {}),
    startOpenRouter: mock(async () => CONNECTION),
    cancelOpenRouter: mock(() => {}),
    addKey: mock(async (input: { provider: string }) => ({ ...CONNECTION, provider: input.provider })),
    models: mock(async (_id: string): Promise<unknown> => ({ models: [] })),
    test: mock(async (_id: string): Promise<unknown> => ({ message: "OpenRouter answered." }))
  };
  const agent = {
    start: mock(async (_input: unknown) => ({ turnId: "turn_ipc0001", threadId: "thread_ipc0001" })),
    stop: mock(async (_turnId: string) => null),
    undoLast: mock(async (_bookId: string, _turnId?: string) => ({ restored: 1 })),
    approve: mock(async (_turnId: string, _approvalId: string, _approved: boolean) => null)
  };
  const voice = {
    connections: mock(async () => [CONNECTION]),
    transcribe: mock(async (_input: unknown) => ({ text: "The tide was out." }))
  };
  const speech = {
    connections: mock(async (): Promise<unknown[]> => []),
    speak: mock(async (_input: unknown) => ({
      mimeType: "audio/wav",
      bytes: new Uint8Array([82, 73, 70, 70]),
      characters: 10,
      chunks: 1,
      connectionLabel: "OpenAI",
      model: "gpt-4o-mini-tts"
    }))
  };
  const images = {
    generate: mock(async (_input: unknown) => ({ bytes: PNG, model: "muse-image", size: "1024x1024", costUsd: 0.04 }))
  };
  const toolsBridge = {
    catalog: mock(async () => [
      { name: "read_chapter", description: "Read a chapter.", tier: "read" },
      { name: "delete_chapter", description: "Move a chapter to the trash.", tier: "destructive" }
    ])
  };
  const bridge = {
    status: null as null | { url: string; token: string; address: string },
    start: mock(async (_address: string) => {}),
    stop: mock(async () => {})
  };
  const backend = { glassesUrl: "http://127.0.0.1:4318/glasses?token=ipc" };
  const working = new Set<string>();
  registerIpc(
    studio as never,
    () => (options.window ?? null) as never,
    providers as never,
    agent as never,
    voice as never,
    images as never,
    toolsBridge as never,
    settings as never,
    speech as never,
    () => backend as never,
    bridge as never,
    (bookId) => working.has(bookId)
  );
  const services = [providers, agent, voice, speech, images];
  return { root, library, studio, saved, settings, providers, agent, voice, speech, images, bridge, working, services };
}

async function call(channel: string, payload?: unknown): Promise<Result<unknown>> {
  const handler = handlers.get(channel);
  if (!handler) throw new Error(`No handler registered for ${channel}.`);
  return (await handler({}, payload)) as Result<unknown>;
}

/** The data of a call that must succeed; a refusal fails the test with its message. */
async function data<T>(channel: string, payload?: unknown): Promise<T> {
  const result = await call(channel, payload);
  if (!result.ok) throw new Error(`${channel} refused: [${result.error.code}] ${result.error.message}`);
  return result.data as T;
}

/** Run a call that is expected to fail through the generic path, which logs before it answers. */
async function logged(channel: string, payload?: unknown): Promise<{ result: Result<unknown>; log: string }> {
  const error = spyOn(console, "error").mockImplementation(() => {});
  try {
    const result = await call(channel, payload);
    return { result, log: error.mock.calls.map((args) => args.join(" ")).join("\n") };
  } finally {
    error.mockRestore();
  }
}

async function book(library: Library, title = "The Salt Road") {
  const created = await library.createBook({ title, description: "A road that floods twice a day." });
  const one = await library.createChapter(created.id, { title: "The Tide", content: "The salt road was under water.\n" });
  const two = await library.createChapter(created.id, { title: "The Crossing", content: "Mara waited for the ebb.\n" });
  return { bookId: created.id, one, two };
}

function chapterFile(root: string, bookId: string, chapter: Chapter): string {
  return join(root, "books", bookId, "chapters", chapter.path);
}

async function filesUnder(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await filesUnder(path)));
    else files.push(path);
  }
  return files;
}

async function trashed(root: string): Promise<string[]> {
  return (await filesUnder(root)).filter((path) => path.includes(`${join(".studio", "trash")}`));
}

describe("ipc boundary", () => {
  test("malformed input is refused as invalid before it reaches the library or any service", async () => {
    const { library, services } = await setup();
    const id = "book_ipc000001";
    const chapterId = "ch_ipc0000001";
    const hash = "a".repeat(64);
    const refused: Array<[string, unknown]> = [
      [IPC.library.open, ""],
      [IPC.books.create, { title: "" }],
      [IPC.books.create, { title: "x".repeat(301) }],
      [IPC.books.open, "../outside"],
      [IPC.books.importManuscript, { bookTitle: "A", chapters: [{ title: "One", content: "x" }], path: "/etc" }],
      [IPC.books.delete, "book_../x"],
      [IPC.books.search, { bookId: id, query: "   " }],
      [IPC.books.update, { bookId: id, patch: "title" }],
      [IPC.books.exportDocx, 5],
      [IPC.books.exportMarkdown, null],
      [IPC.chapters.create, { bookId: "nope" }],
      [IPC.chapters.save, { bookId: id, chapterId, content: "x", baseVersion: -1, baseHash: hash }],
      [IPC.chapters.updateMeta, { bookId: id, chapterId, patch: { arc: "climax" }, expected: { baseVersion: 1, baseHash: hash } }],
      [IPC.chapters.reorder, { bookId: id, chapterId, direction: "sideways" }],
      [IPC.chapters.move, { bookId: id, chapterId, targetIndex: 10_001 }],
      [IPC.chapters.delete, { bookId: id }],
      [IPC.conflicts.list, 7],
      [IPC.conflicts.reveal, { bookId: id, savedAs: "" }],
      [IPC.drafts.set, { bookId: id, chapterId, content: "x", baseVersion: 1, baseHash: "z".repeat(64) }],
      [IPC.drafts.clear, {}],
      [IPC.recovery.list, "book_../x"],
      [IPC.recovery.restore, "../studio.json"],
      [IPC.recovery.discard, "rec_123"],
      [IPC.sync.accept, "books/one.md"],
      [IPC.sync.keepMine, {}],
      [IPC.sync.discardDraft, { bookId: id }],
      [IPC.sync.updateSettings, { checkIntervalMinutes: 0 }],
      [IPC.providers.models, "openrouter"],
      [IPC.connections.addKey, { provider: "acme", secret: "short" }],
      [IPC.connections.remove, "conn_!"],
      [IPC.connections.test, ""],
      [IPC.usage.summary, "book"],
      [IPC.agent.status, undefined],
      [IPC.agent.setSettings, { bookId: id, patch: { answerLength: "epic" } }],
      [IPC.agent.ambient, 1],
      [IPC.agent.setBridge, "yes"],
      [IPC.agent.setPluginFolder, 42],
      [IPC.agent.start, { bookId: id, prompt: "", mode: "edit" }],
      [IPC.agent.start, { bookId: id, prompt: "Go on.", mode: "rewrite" }],
      [IPC.agent.stop, ""],
      [IPC.agent.undoLast, "turn_1"],
      [IPC.agent.undoLast, { bookId: id, turnId: "" }],
      [IPC.agent.undoLast, { bookId: id, turnId: "t".repeat(81) }],
      [IPC.agent.approve, { turnId: "turn_1", approvalId: "call_1", approved: "yes" }],
      [IPC.agent.threads.list, 0],
      [IPC.agent.threads.read, { bookId: id }],
      [IPC.agent.threads.rename, { bookId: id, threadId: "thread_ipc0001", title: "   " }],
      [IPC.agent.threads.remove, {}],
      [IPC.agent.threads.fork, { bookId: id, threadId: "thread_ipc0001", turnId: "" }],
      [IPC.voice.transcribe, { audio: "UklGRg==" }],
      [IPC.voice.transcribe, { audio: new Uint8Array(), expectedSelection: { connectionId: "conn_!", model: "x" } }],
      [IPC.voice.transcribe, { audio: new Uint8Array() }],
      [IPC.voice.speak, { text: "Read this.", speed: 5 }],
      [IPC.images.list, "img_abcdef01"],
      [IPC.images.read, { bookId: id, imageId: "img_" }],
      [IPC.images.generate, { bookId: id, prompt: "A lighthouse.", size: "800x600" }],
      [IPC.images.attach, { bookId: id, imageId: "img_abcdef01", chapterId: "chapter" }],
      [IPC.images.remove, {}]
    ];
    for (const [channel, payload] of refused) {
      const result = await call(channel, payload);
      expect({ channel, ok: result.ok, code: result.ok ? null : result.error.code }).toEqual({
        channel,
        ok: false,
        code: "invalid"
      });
    }
    for (const service of services) {
      for (const method of Object.values(service)) expect(method).not.toHaveBeenCalled();
    }
    expect(await library.listBooks()).toEqual([]);
  });

  test("a refusal names the field that was wrong", async () => {
    await setup();
    expect(await call(IPC.books.create, { title: "" })).toEqual({
      ok: false,
      error: { code: "invalid", message: expect.stringMatching(/^title: /) }
    });
    expect(await call(IPC.books.open, 42)).toEqual({
      ok: false,
      error: { code: "invalid", message: expect.stringMatching(/^input: /) }
    });
  });

  test("a backup the importer refuses is invalid, and is not logged as an internal error", async () => {
    const { root } = await setup();
    const backup = join(root, "not-a-backup.json");
    await writeFile(backup, "this is not a backup");
    answers.open.push({ canceled: false, filePaths: [backup] });
    const error = spyOn(console, "error").mockImplementation(() => {});
    try {
      const result = await call(IPC.library.importLegacy);
      expect(result.ok ? null : result.error.code).toBe("invalid");
      expect(result.ok ? null : result.error.message).toContain("could not be read as a backup");
      expect(error).not.toHaveBeenCalled();
    } finally {
      error.mockRestore();
    }
  });

  test("with no library open, the library channels say so plainly and the log is redacted", async () => {
    await setup({ open: false });
    expect(await data(IPC.library.current)).toBeNull();
    const { result, log } = await logged(IPC.books.list);
    expect(result).toEqual({ ok: false, error: { code: "internal", message: "No library is open. Choose a folder first." } });
    expect(log).toContain("[ipc]");
    expect(await call(IPC.agent.status, BOOK)).toEqual({
      ok: false,
      error: { code: "invalid-request", message: "No library is open in the studio." }
    });
    expect(await data(IPC.sync.check)).toBeNull();
  });

  test("provider and system errors cross the boundary with any key redacted", async () => {
    const { providers } = await setup();
    providers.models.mockImplementation(async () => {
      throw new ProviderError("auth", `OpenRouter refused the key ${KEY}.`);
    });
    const refused = await call(IPC.providers.models, CONNECTION.id);
    expect(refused).toEqual({
      ok: false,
      error: { code: "auth", message: "OpenRouter refused the key sk-or-[redacted]." }
    });

    providers.test.mockImplementation(async () => {
      throw new Error(`ENOENT: no such file, open '/tmp/${KEY}.json'`);
    });
    const missing = await logged(IPC.connections.test, CONNECTION.id);
    expect(missing.result.ok ? null : missing.result.error.code).toBe("not-found");
    expect(JSON.stringify(missing.result)).not.toContain(KEY);
    expect(missing.log).not.toContain(KEY);

    providers.test.mockImplementation(async () => {
      throw new Error("EACCES: permission denied");
    });
    const denied = await logged(IPC.connections.test, CONNECTION.id);
    expect(denied.result).toEqual({ ok: false, error: { code: "io", message: "EACCES: permission denied" } });

    providers.test.mockImplementation(async () => {
      throw "a thrown string";
    });
    expect((await logged(IPC.connections.test, CONNECTION.id)).result).toEqual({
      ok: false,
      error: { code: "internal", message: "a thrown string" }
    });
  });
});

describe("books and chapters", () => {
  test("a book is created, listed, opened and searched, and lands on disk", async () => {
    const { root, library } = await setup();
    const created = await data<{ id: string }>(IPC.books.create, { title: "The Salt Road", description: "A road." });
    expect(JSON.parse(await readFile(join(root, "books", created.id, "book.json"), "utf8")).title).toBe("The Salt Road");
    expect(await data(IPC.books.list)).toEqual([expect.objectContaining({ id: created.id, title: "The Salt Road", chapterCount: 0 })]);
    expect(await data(IPC.books.listWithIssues)).toEqual({
      books: [expect.objectContaining({ id: created.id, title: "The Salt Road" })],
      bookReadIssues: []
    });

    const chapter = await data<Chapter>(IPC.chapters.create, { bookId: created.id, title: "The Tide" });
    const saved = await data<{ status: string }>(IPC.chapters.save, {
      bookId: created.id,
      chapterId: chapter.id,
      content: "The salt road was under water.",
      baseVersion: chapter.version,
      baseHash: chapter.hash
    });
    expect(saved.status).toBe("saved");
    expect(await readFile(chapterFile(root, created.id, chapter), "utf8")).toContain("The salt road was under water.");

    const hits = await data<Array<{ chapterId: string; text: string }>>(IPC.books.search, { bookId: created.id, query: "  salt  " });
    expect(hits).toEqual([expect.objectContaining({ chapterId: chapter.id, text: "The salt road was under water." })]);
    const opened = await data<{ chapters: Chapter[] }>(IPC.books.open, created.id);
    expect(opened.chapters.map((entry) => entry.title)).toEqual(["The Tide"]);
    expect(await library.listBooks()).toHaveLength(1);
  });

  test("a book update keeps to the fields the studio allows", async () => {
    const { root, library } = await setup();
    const { bookId } = await book(library);
    const updated = await data<{ id: string; title: string }>(IPC.books.update, {
      bookId,
      patch: { title: "The Salt Road, Again", id: "book_hijacked1", root: "/etc", deviceSecret: "x" }
    });
    expect(updated.id).toBe(bookId);
    expect(updated.title).toBe("The Salt Road, Again");
    const raw = await readFile(join(root, "books", bookId, "book.json"), "utf8");
    expect(raw).toContain("The Salt Road, Again");
    expect(raw).not.toContain("hijacked");
    expect(raw).not.toContain("deviceSecret");
  });

  test("front and back matter saves only through its checked channel, within its limits", async () => {
    const { root, library } = await setup();
    const { bookId } = await book(library);
    const file = join(root, "books", bookId, "book.json");
    const section = newMatterSection("dedication", "mat_ipc000001", "For Ana.");
    const valid = { bookId, matter: { titlePage: true, author: "Ana Reyes", sections: [section] }, baseVersion: 0, baseHash: await matterHash(null) };
    const refused: unknown[] = [
      { ...valid, bookId: "../book" },
      { ...valid, matter: { sections: [{ ...section, id: "../../etc" }] } },
      { ...valid, matter: { sections: [{ ...section, kind: "foreword" }] } },
      { ...valid, matter: { sections: [{ ...section, title: "x".repeat(MATTER_LIMITS.title + 1) }] } },
      { ...valid, matter: { sections: [{ ...section, text: "x".repeat(MATTER_LIMITS.text + 1) }] } },
      { ...valid, matter: { author: "x".repeat(MATTER_LIMITS.name + 1) } },
      { ...valid, matter: { sections: Array.from({ length: MATTER_LIMITS.sections + 1 }, (_, index) => ({ ...section, id: `mat_ipc${String(index).padStart(6, "0")}` })) } },
      { ...valid, matter: { sections: [section, section] } },
      { ...valid, matter: { ...valid.matter, padding: "x".repeat(MATTER_LIMITS.bytes) } },
      { ...valid, baseVersion: -1 },
      { ...valid, baseHash: "z".repeat(64) },
      { bookId, matter: valid.matter }
    ];
    const before = await readFile(file, "utf8");
    for (const payload of refused) {
      const result = await call(IPC.books.saveMatter, payload);
      expect(result.ok ? null : result.error.code).toBe("invalid");
    }
    // The general book update never carries matter.
    await data(IPC.books.update, { bookId, patch: { matter: valid.matter } });
    expect(JSON.parse(await readFile(file, "utf8")).matter).toBeUndefined();
    expect(JSON.parse(before).matter).toBeUndefined();

    const saved = await data<{ status: string; book: { matter?: unknown } }>(IPC.books.saveMatter, valid);
    expect(saved.status).toBe("saved");
    expect(JSON.parse(await readFile(file, "utf8")).matter).toMatchObject({ version: 1, author: "Ana Reyes", sections: [section] });

    // The next save starts from the book as the renderer receives it, copied across the process
    // boundary, while the main process hashes what it reads back from disk: the two must agree.
    const received = readMatter(structuredClone(saved.book) as Parameters<typeof readMatter>[0]).matter;
    const second = await data<{ status: string }>(IPC.books.saveMatter, {
      bookId,
      matter: { ...received, subtitle: "A tidewater tale" },
      baseVersion: received?.version ?? -1,
      baseHash: await matterHash(received)
    });
    expect(second.status).toBe("saved");
    expect(JSON.parse(await readFile(file, "utf8")).matter).toMatchObject({ version: 2, subtitle: "A tidewater tale" });

    const stale = await data<{ status: string; savedAs: string }>(IPC.books.saveMatter, { ...valid, matter: { ...valid.matter, author: "Someone" } });
    expect(stale.status).toBe("conflict");
    expect(JSON.parse(await readFile(file, "utf8")).matter).toMatchObject({ version: 2, author: "Ana Reyes" });
    const copies = await readdir(join(root, "books", bookId, "conflicts"));
    expect(copies).toEqual([expect.stringMatching(/^front-and-back-matter\.conflict-newer-version\..+\.json$/)]);
  });

  test("the model picker's Contributor consent reaches the book", async () => {
    const { root, library } = await setup();
    const { bookId } = await book(library);
    await data(IPC.books.update, {
      bookId,
      patch: { defaultModelId: "muse-spark-1.3-contributor", allowContributorTraining: true }
    });
    const saved = JSON.parse(await readFile(join(root, "books", bookId, "book.json"), "utf8"));
    expect(saved.defaultModelId).toBe("muse-spark-1.3-contributor");
    expect(saved.allowContributorTraining).toBe(true);
  });

  test("a stale save becomes a conflict copy, and a save with a malformed hash writes nothing", async () => {
    const { root, library } = await setup();
    const { bookId, one } = await book(library);
    const base = { bookId, chapterId: one.id, baseVersion: one.version, baseHash: one.hash };
    expect((await data<{ status: string }>(IPC.chapters.save, { ...base, content: "Their tide." })).status).toBe("saved");

    const stale = await data<{ status: string; conflict: { savedAs: string } }>(IPC.chapters.save, { ...base, content: "My tide." });
    expect(stale.status).toBe("conflict");
    expect(await readFile(chapterFile(root, bookId, one), "utf8")).toContain("Their tide.");
    expect(await readFile(join(root, stale.conflict.savedAs), "utf8")).toContain("My tide.");
    expect(await data(IPC.conflicts.list, bookId)).toEqual([expect.objectContaining({ savedAs: stale.conflict.savedAs })]);

    const before = await readFile(chapterFile(root, bookId, one), "utf8");
    const malformed = await call(IPC.chapters.save, { ...base, content: "Overwrite.", baseHash: "not-a-hash" });
    expect(malformed.ok).toBe(false);
    expect(await readFile(chapterFile(root, bookId, one), "utf8")).toBe(before);
  });

  test("chapter details, order and deletion go through the checked paths", async () => {
    const { root, library, studio } = await setup();
    const { bookId, one, two } = await book(library);
    const meta = await data<{ status: string }>(IPC.chapters.updateMeta, {
      bookId,
      chapterId: one.id,
      patch: { title: "The Flood", arc: "middle", synopsis: "The road goes under." },
      expected: { baseVersion: one.version, baseHash: one.hash }
    });
    expect(meta.status).toBe("saved");
    const renamed = (await library.readBook(bookId)).chapters.find((chapter) => chapter.id === one.id);
    expect(renamed?.title).toBe("The Flood");
    expect(await readFile(chapterFile(root, bookId, renamed as Chapter), "utf8")).toContain("The road goes under.");

    expect((await data<{ status: string }>(IPC.chapters.reorder, { bookId, chapterId: two.id, direction: "up" })).status).toBe("saved");
    expect((await library.readBook(bookId)).chapters.map((chapter) => chapter.id)).toEqual([two.id, one.id]);
    expect((await data<{ status: string }>(IPC.chapters.move, { bookId, chapterId: two.id, targetIndex: 1 })).status).toBe("saved");
    expect((await library.readBook(bookId)).chapters.map((chapter) => chapter.id)).toEqual([one.id, two.id]);

    await data(IPC.drafts.set, { bookId, chapterId: two.id, content: "Unsaved.", baseVersion: two.version, baseHash: two.hash });
    expect(studio.drafts.size).toBe(1);
    expect(await data(IPC.chapters.delete, { bookId, chapterId: two.id })).toBeNull();
    expect(studio.drafts.size).toBe(0);
    expect((await library.readBook(bookId)).chapters.map((chapter) => chapter.id)).toEqual([one.id]);
    const inTrash = await Promise.all((await trashed(root)).map((path) => readFile(path, "utf8")));
    expect(inTrash.some((text) => text.includes("Mara waited for the ebb."))).toBe(true);
  });

  test("a book or chapter that is not in the library is reported as not found", async () => {
    const { library } = await setup();
    const { bookId } = await book(library);
    const book404 = await call(IPC.books.open, "book_missing0001");
    expect(book404.ok ? null : book404.error.code).toBe("not-found");
    const chapter404 = await call(IPC.chapters.reorder, { bookId, chapterId: "ch_missing0001", direction: "up" });
    expect(chapter404.ok ? null : chapter404.error.code).toBe("not-found");
  });

  test("a deleted book moves to the library trash", async () => {
    const { root, library } = await setup();
    const { bookId } = await book(library);
    await data(IPC.books.delete, bookId);
    expect(await library.listBooks()).toEqual([]);
    expect((await trashed(root)).some((path) => path.includes(bookId) && path.endsWith("book.json"))).toBe(true);
  });

  test("a reveal outside the library is refused", async () => {
    const { root, library } = await setup();
    const { bookId } = await book(library);
    expect(await data(IPC.conflicts.reveal, { bookId, savedAs: `books/${bookId}/conflicts/a.md` })).toBeNull();
    expect(shown).toEqual([join(root, "books", bookId, "conflicts", "a.md")]);
    expect((await call(IPC.conflicts.reveal, { bookId, savedAs: "../../etc/passwd" })).ok).toBe(false);
    expect(shown).toHaveLength(1);
  });

  test("an imported manuscript becomes a book with its chapters", async () => {
    const { root, library } = await setup();
    const detail = await data<{ book: { id: string }; chapters: Chapter[] }>(IPC.books.importManuscript, {
      bookTitle: "Letters",
      chapters: [
        { title: "First", content: "Dear Mara," },
        { title: "Second", content: "The light is out." }
      ]
    });
    expect(detail.chapters.map((chapter) => chapter.title)).toEqual(["First", "Second"]);
    const second = detail.chapters[1] as Chapter;
    expect(await readFile(chapterFile(root, detail.book.id, second), "utf8")).toContain("The light is out.");
    expect(await library.listBooks()).toHaveLength(1);
  });
});

describe("drafts and drift", () => {
  test("held drafts are set, cleared, discarded or kept through the channels", async () => {
    const { root, library, studio } = await setup();
    const { bookId, one } = await book(library);
    const draft = { bookId, chapterId: one.id, content: "Typed before the window closed.", baseVersion: one.version, baseHash: one.hash };

    await data(IPC.drafts.set, draft);
    expect(studio.drafts.dirtyChapterIds()).toEqual([one.id]);
    await data(IPC.drafts.clear, { bookId, chapterId: one.id });
    expect(studio.drafts.size).toBe(0);

    await data(IPC.drafts.set, draft);
    await data(IPC.sync.discardDraft, { bookId, chapterId: one.id });
    expect(studio.drafts.size).toBe(0);

    await data(IPC.drafts.set, draft);
    expect((await data<{ status: string }>(IPC.sync.keepMine, { bookId, chapterId: one.id })).status).toBe("saved");
    expect(await readFile(chapterFile(root, bookId, one), "utf8")).toContain("Typed before the window closed.");
    expect(studio.drafts.size).toBe(0);
  });

  test("kept words are listed without their text, restored through the checked save, or discarded", async () => {
    const { root, library, studio } = await setup();
    const { bookId, one, two } = await book(library);
    const keep = (chapter: Chapter, content: string) =>
      studio.recovery.keep(
        { bookId, chapterId: chapter.id, content, baseVersion: chapter.version, baseHash: chapter.hash },
        "The disk is full. Nothing was replaced.",
        root
      );
    const first = await keep(one, "The salt road was under water, and the gulls had gone.\n");
    const stale = await keep(two, "Mara waited for the ebb, and then she ran.\n");
    const unwanted = await keep(two, "A line nobody wants.\n");

    const listed = await data<Array<Record<string, unknown>>>(IPC.recovery.list, bookId);
    expect(listed.map((entry) => entry.id).sort()).toEqual([first.id, stale.id, unwanted.id].sort());
    // The renderer is told what was kept and why, never handed the text itself.
    for (const entry of listed) {
      expect(entry).not.toHaveProperty("content");
      expect(entry.reason).toBe("The disk is full. Nothing was replaced.");
    }

    expect((await data<{ status: string }>(IPC.recovery.restore, first.id)).status).toBe("saved");
    expect(await readFile(chapterFile(root, bookId, one), "utf8")).toContain("and the gulls had gone.");

    // Another writer saved the second chapter after the words were kept: they become a conflict copy.
    await library.saveChapter(bookId, two.id, "Mara crossed at dawn.\n", { baseVersion: two.version, baseHash: two.hash });
    const conflict = await data<{ status: string; conflict: { savedAs: string } }>(IPC.recovery.restore, stale.id);
    expect(conflict.status).toBe("conflict");
    expect(await readFile(chapterFile(root, bookId, two), "utf8")).toContain("Mara crossed at dawn.");
    expect(await readFile(join(root, conflict.conflict.savedAs), "utf8")).toContain("and then she ran.");

    expect(await data(IPC.recovery.discard, unwanted.id)).toBeNull();
    expect(await data(IPC.recovery.list, bookId)).toEqual([]);
    const gone = await call(IPC.recovery.restore, first.id);
    expect(gone.ok ? null : gone.error.code).toBe("not-found");
  });

  test("the drift scan runs on the open library and remembers when it ran", async () => {
    const { library, saved } = await setup();
    await book(library);
    expect(await data(IPC.sync.settings)).toEqual({ checkIntervalMinutes: 15, lastScanAt: null });

    const report = await data<{ scannedAt: string }>(IPC.sync.check);
    expect(saved.lastSyncScanAt).toBe(report.scannedAt);
    expect(await data(IPC.sync.settings)).toEqual({ checkIntervalMinutes: 15, lastScanAt: report.scannedAt });
    expect(await data(IPC.sync.accept, [])).toEqual(expect.objectContaining({ scannedAt: expect.any(String) }));

    expect(await data(IPC.sync.updateSettings, { checkIntervalMinutes: 45 })).toEqual(
      expect.objectContaining({ checkIntervalMinutes: 45 })
    );
    expect(saved.syncCheckIntervalMinutes).toBe(45);
    expect(await data(IPC.sync.updateSettings, {})).toEqual(expect.objectContaining({ checkIntervalMinutes: 45 }));
    expect(await data(IPC.library.locationHealth)).toEqual(expect.objectContaining({ state: expect.any(String) }));
  });
});

describe("connections and usage", () => {
  test("connections are listed, added, tested and removed through the provider service only", async () => {
    const { providers } = await setup();
    expect(await data(IPC.providers.list)).toEqual(PROVIDER_LIST);
    expect(await data(IPC.connections.list)).toEqual([CONNECTION]);
    expect(await data(IPC.connections.available)).toBe(true);
    expect(await data(IPC.connections.status)).toEqual(expect.objectContaining({ available: true, connections: 1 }));
    expect(await data(IPC.connections.check)).toEqual(expect.objectContaining({ available: false, detail: "Locked." }));
    expect(await data(IPC.providers.models, CONNECTION.id)).toEqual({ models: [] });

    await data(IPC.connections.addKey, { provider: "openrouter", secret: KEY, label: "Mine", shown: true });
    // Anything the schema does not name is dropped before the provider service sees it.
    expect(providers.addKey).toHaveBeenCalledWith({ provider: "openrouter", secret: KEY, label: "Mine" });
    expect(await data(IPC.connections.test, CONNECTION.id)).toEqual({ message: "OpenRouter answered." });
    expect(await data(IPC.connections.remove, CONNECTION.id)).toBeNull();
    expect(providers.remove).toHaveBeenCalledWith(CONNECTION.id);
    expect(await data(IPC.connections.startOpenRouter)).toEqual(CONNECTION);
    expect(await data(IPC.connections.cancelOpenRouter)).toBeNull();
    expect(providers.cancelOpenRouter).toHaveBeenCalledTimes(1);
  });

  test("a book with no turns has an empty usage summary", async () => {
    const { library } = await setup();
    const { bookId } = await book(library);
    expect(await data(IPC.usage.summary, bookId)).toEqual(expect.objectContaining({ turns: 0 }));
  });
});

describe("the agent", () => {
  test("a book's agent settings are saved in its book file and read back in its status", async () => {
    const { root, library } = await setup();
    const { bookId } = await book(library);
    const before = await data<Record<string, unknown>>(IPC.agent.status, bookId);
    expect(before).toEqual(
      expect.objectContaining({
        tone: "",
        answerLength: "standard",
        skills: { present: false, enabled: true, characters: 0 },
        plugins: { folder: null, loaded: [], tools: [], failures: [] }
      })
    );
    expect((before.tools as Array<{ name: string; enabled: boolean; calls: number }>).map((tool) => [tool.name, tool.enabled, tool.calls])).toEqual([
      ["read_chapter", true, 0],
      ["delete_chapter", true, 0]
    ]);

    const after = await data<Record<string, unknown>>(IPC.agent.setSettings, {
      bookId,
      patch: {
        disabledTools: ["delete_chapter", "delete_chapter"],
        skillsEnabled: false,
        tone: "Warm and brief.",
        answerLength: "brief",
        perTurnCeilingUsd: 0.5,
        monthlyWarningUsd: 10,
        cachePrefixMode: "off"
      }
    });
    expect((after.tools as Array<{ name: string; enabled: boolean }>).map((tool) => [tool.name, tool.enabled])).toEqual([
      ["read_chapter", true],
      ["delete_chapter", false]
    ]);
    expect(after).toEqual(
      expect.objectContaining({
        tone: "Warm and brief.",
        answerLength: "brief",
        skills: expect.objectContaining({ enabled: false }),
        cache: expect.objectContaining({ mode: "off" }),
        spending: expect.objectContaining({ perTurnCeilingUsd: 0.5, monthlyWarningUsd: 10, monthToDateUsd: 0 })
      })
    );
    const saved = JSON.parse(await readFile(join(root, "books", bookId, "book.json"), "utf8"));
    expect(saved.settings.agent).toEqual(
      expect.objectContaining({ disabledTools: ["delete_chapter"], tone: "Warm and brief.", answerLength: "brief" })
    );
    expect(saved.settings.cache.prefixMode).toBe("off");
  });

  /** Another device writes `book.json` between the handler's read and its save. */
  // biome-ignore lint/suspicious/noExplicitAny: these checks reshape raw book.json the way another writer would
  function racingEdit(library: Library, root: string, bookId: string, change: (raw: Record<string, any>) => void): void {
    const edit = library.editBook.bind(library);
    let raced = false;
    library.editBook = async (...args: Parameters<Library["editBook"]>) => {
      if (!raced) {
        raced = true;
        const path = join(root, "books", bookId, "book.json");
        const raw = JSON.parse(await readFile(path, "utf8"));
        change(raw);
        await writeFile(path, `${JSON.stringify(raw, null, 2)}\n`);
      }
      return edit(...args);
    };
  }

  test("an agent setting another writer changed meanwhile is refused with a note, and the author's goes to a copy", async () => {
    const { root, library } = await setup();
    const { bookId } = await book(library);
    racingEdit(library, root, bookId, (raw) => {
      raw.settings.agent.tone = "Theirs.";
    });

    const result = await call(IPC.agent.setSettings, { bookId, patch: { tone: "Mine." } });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain("agent settings changed on disk while you were editing");
    expect(result.error.message).toContain("kept as a separate copy");
    const onDisk = JSON.parse(await readFile(join(root, "books", bookId, "book.json"), "utf8"));
    expect(onDisk.settings.agent.tone).toBe("Theirs.");
    const copies = await readdir(join(root, "books", bookId, "conflicts"));
    expect(copies).toHaveLength(1);
    expect(result.error.message).toContain(copies[0] ?? "no copy");
    const kept = JSON.parse(await readFile(join(root, "books", bookId, "conflicts", copies[0] ?? ""), "utf8"));
    expect(kept.settings.agent.tone).toBe("Mine.");
  });

  test("an agent setting saves beside a format change another writer made meanwhile", async () => {
    const { root, library } = await setup();
    const { bookId } = await book(library);
    racingEdit(library, root, bookId, (raw) => {
      raw.settings.manuscript = { ...raw.settings.manuscript, bodyFont: "Garamond" };
    });

    const after = await data<Record<string, unknown>>(IPC.agent.setSettings, { bookId, patch: { tone: "Mine." } });

    expect(after).toEqual(expect.objectContaining({ tone: "Mine." }));
    const onDisk = JSON.parse(await readFile(join(root, "books", bookId, "book.json"), "utf8"));
    expect(onDisk.settings.agent.tone).toBe("Mine.");
    expect(onDisk.settings.manuscript.bodyFont).toBe("Garamond");
    expect(await readdir(join(root, "books", bookId, "conflicts")).catch(() => [])).toEqual([]);
  });

  test("a book's spending and tool use come from its own logs, and warn past the author's limits", async () => {
    const { root, library } = await setup();
    const { bookId } = await book(library);
    const at = new Date().toISOString();
    await new UsageStore(() => root).append({
      at,
      bookId,
      provider: "openrouter",
      connectionId: CONNECTION.id,
      modelId: "openai/gpt-5-mini",
      inputTokens: 1000,
      outputTokens: 200,
      cachedInputTokens: 600,
      cacheReported: true,
      costUsd: 0.8,
      costBasis: "reported",
      steps: 1
    });
    const metrics = new MetricsStore(() => root);
    await metrics.append(bookId, { name: "read_chapter", ok: true, at });
    await metrics.append(bookId, { name: "read_chapter", ok: false, at });

    type Status = {
      tools: Array<{ name: string; calls: number; successes: number; failures: number }>;
      spending: { monthToDateUsd: number; lastTurnWarning: unknown; monthlyWarning: unknown };
    };
    const quiet = await data<Status>(IPC.agent.status, bookId);
    expect(quiet.spending).toEqual(expect.objectContaining({ monthToDateUsd: 0.8, lastTurnWarning: null, monthlyWarning: null }));
    expect(quiet.tools.find((tool) => tool.name === "read_chapter")).toEqual(
      expect.objectContaining({ calls: 2, successes: 1, failures: 1 })
    );

    const limited = await data<Status>(IPC.agent.setSettings, { bookId, patch: { perTurnCeilingUsd: 0.5, monthlyWarningUsd: 0.5 } });
    expect(limited.spending.lastTurnWarning).not.toBeNull();
    expect(limited.spending.monthlyWarning).not.toBeNull();
  });

  test("turns, approvals and undo reach the runtime as validated input", async () => {
    const { agent, library } = await setup();
    const { bookId, one } = await book(library);
    const started = await data(IPC.agent.start, {
      bookId,
      chapterId: one.id,
      prompt: "Tighten the opening.",
      mode: "edit",
      history: [{ role: "user", text: "Hello." }],
      apiKey: KEY
    });
    expect(started).toEqual({ turnId: "turn_ipc0001", threadId: "thread_ipc0001" });
    expect(agent.start).toHaveBeenCalledWith({
      bookId,
      chapterId: one.id,
      prompt: "Tighten the opening.",
      mode: "edit",
      history: [{ role: "user", text: "Hello." }]
    });
    await data(IPC.agent.stop, "turn_ipc0001");
    expect(agent.stop).toHaveBeenCalledWith("turn_ipc0001");
    // The strip names no turn and takes the newest; the chat names the turn it offered.
    expect(await data(IPC.agent.undoLast, { bookId })).toEqual({ restored: 1 });
    expect(agent.undoLast.mock.calls.at(-1)).toEqual([bookId]);
    expect(await data(IPC.agent.undoLast, { bookId, turnId: "turn_ipc0001" })).toEqual({ restored: 1 });
    expect(agent.undoLast.mock.calls.at(-1)).toEqual([bookId, "turn_ipc0001"]);
    await data(IPC.agent.approve, { turnId: "turn_ipc0001", approvalId: "call_1", approved: false });
    expect(agent.approve).toHaveBeenCalledWith("turn_ipc0001", "call_1", false);
  });

  test("conversations are listed, renamed, branched and removed in the book's thread files", async () => {
    const { library } = await setup();
    const { bookId } = await book(library);
    const messages = [
      agentMessageSchema.parse({ id: "msg_ipc0001", role: "user", turnId: "turn_ipc0001", parts: [{ type: "text", text: "Read it." }], createdAt: NOW }),
      agentMessageSchema.parse({ id: "msg_ipc0002", role: "assistant", turnId: "turn_ipc0001", parts: [{ type: "text", text: "I read it." }], createdAt: NOW })
    ];
    const thread = await library.threads.create(bookId, "Opening", messages);

    expect(await data(IPC.agent.threads.list, bookId)).toEqual([expect.objectContaining({ id: thread.id, title: "Opening" })]);
    expect(await data(IPC.agent.threads.read, { bookId, threadId: thread.id })).toEqual(expect.objectContaining({ id: thread.id }));
    expect(await data(IPC.agent.threads.rename, { bookId, threadId: thread.id, title: " The opening " })).toEqual(
      expect.objectContaining({ title: "The opening" })
    );
    const branch = await data<{ id: string; title: string }>(IPC.agent.threads.fork, { bookId, threadId: thread.id, turnId: "turn_ipc0001" });
    expect(branch.title).toBe("The opening (branch)");
    expect(await data<unknown[]>(IPC.agent.threads.list, bookId)).toHaveLength(2);

    const missing = await logged(IPC.agent.threads.fork, { bookId, threadId: thread.id, turnId: "turn_gone0001" });
    expect(missing.result).toEqual({ ok: false, error: expect.objectContaining({ message: "That turn is no longer in the conversation." }) });

    expect(await data(IPC.agent.threads.remove, { bookId, threadId: branch.id })).toBeNull();
    expect(await data(IPC.agent.threads.list, bookId)).toEqual([expect.objectContaining({ id: thread.id })]);
  });

  test("the glasses, the bridge, the ambient status and the plugin folder report their state", async () => {
    const { library, bridge, saved, working } = await setup();
    const { bookId } = await book(library);
    expect(await data(IPC.agent.glassesUrl)).toBe("http://127.0.0.1:4318/glasses?token=ipc");
    expect(await data(IPC.agent.bridge)).toEqual(
      expect.objectContaining({ running: false, url: null, token: null, address: null, addresses: expect.any(Array) })
    );
    expect(await data(IPC.agent.setBridge, false)).toEqual(expect.objectContaining({ running: false }));
    expect(bridge.stop).toHaveBeenCalledTimes(1);
    // Stop is offered only while the agent is working on the book.
    type Ambient = { working: boolean; actions: Array<{ id: string; available: boolean }> };
    const idle = await data<Ambient>(IPC.agent.ambient, bookId);
    expect(idle.working).toBe(false);
    expect(idle.actions.find((action) => action.id === "stop")?.available).toBe(false);
    working.add(bookId);
    const busy = await data<Ambient>(IPC.agent.ambient, bookId);
    expect(busy.working).toBe(true);
    expect(busy.actions.find((action) => action.id === "stop")?.available).toBe(true);

    expect(await data(IPC.agent.choosePluginFolder)).toBeNull();
    const folder = await temp("studio-plugins-empty-");
    answers.open.push({ canceled: false, filePaths: [folder] });
    expect(await data(IPC.agent.choosePluginFolder)).toBe(folder);

    expect(await call(IPC.agent.setPluginFolder, "plugins")).toEqual({
      ok: false,
      error: { code: "invalid-request", message: "The plugin folder must be an absolute path." }
    });
    expect(await data(IPC.agent.setPluginFolder, folder)).toEqual(expect.objectContaining({ folder, loaded: [], tools: [] }));
    expect(saved.pluginFolder).toBe(folder);
    expect(await data(IPC.agent.setPluginFolder, null)).toEqual(expect.objectContaining({ folder: null }));
    expect(saved.pluginFolder).toBeNull();
  });
});

describe("voice and illustrations", () => {
  test("transcription and speech receive only what the author chose", async () => {
    const { voice, speech, saved } = await setup();
    expect(await data(IPC.voice.connections)).toEqual([CONNECTION]);
    const audio = new Uint8Array([82, 73, 70, 70, 0, 0]);
    const expectedSelection = { connectionId: CONNECTION.id, model: "openai/whisper-1" };
    await data(IPC.voice.transcribe, { audio, expectedSelection, languageBias: [], keywords: ["Mara"] });
    expect(voice.transcribe).toHaveBeenLastCalledWith({ audio, expectedSelection, keywords: ["Mara"] });
    await data(IPC.voice.transcribe, { audio: audio.buffer, expectedSelection, languageBias: ["en"] });
    expect(voice.transcribe).toHaveBeenLastCalledWith({ audio, expectedSelection, languageBias: ["en"] });

    expect(await data(IPC.voice.settings)).toEqual(DEFAULT_VOICE_PREFERENCES);
    const preferences: VoicePreferences = {
      transcription: { connectionId: CONNECTION.id, model: "openai/whisper-1" },
      speaking: { connectionId: CONNECTION.id, model: "heygen/heygen-voice-1", voice: "nadine" }
    };
    await data(IPC.voice.updateSettings, preferences);
    expect(saved.voicePreferences).toEqual(preferences);
    const speakers = await data<{ available: boolean; selected: boolean; model: string | null; voice: string | null; voices: string[] }>(IPC.voice.speakers);
    expect(speakers).toMatchObject({
      available: true,
      selected: true,
      model: "heygen/heygen-voice-1",
      voice: "nadine",
      voices: expect.arrayContaining(["nadine", "vincent"])
    });

    const spoken = await data<{ dataUrl: string; chunks: number }>(IPC.voice.speak, { text: "Read this.", speed: 1.25 });
    expect(spoken.dataUrl).toBe(`data:audio/wav;base64,${Buffer.from([82, 73, 70, 70]).toString("base64")}`);
    expect(spoken.chunks).toBe(1);
    expect(speech.speak).toHaveBeenCalledWith({ text: "Read this.", speed: 1.25 });
  });

  test("voice preference IPC rejects mismatched models and unsupported voices", async () => {
    await setup();
    const invalidProvider: VoicePreferences = {
      ...DEFAULT_VOICE_PREFERENCES,
      transcription: { connectionId: CONNECTION.id, model: "muse-voice-transcribe-1.0" }
    };
    await expect(data(IPC.voice.updateSettings, invalidProvider)).rejects.toThrow(/does not support|supported transcription/i);
    const invalidVoice: VoicePreferences = {
      ...DEFAULT_VOICE_PREFERENCES,
      speaking: { connectionId: CONNECTION.id, model: "heygen/heygen-voice-1", voice: "custom-voice" }
    };
    await expect(data(IPC.voice.updateSettings, invalidVoice)).rejects.toThrow(/does not support|supported transcription model and speaking voice/i);
  });

  test("removed voice connections can be cleared one at a time in either order", async () => {
    const stale: VoicePreferences = {
      transcription: { connectionId: "conn_removed01", model: "openai/whisper-1" },
      speaking: { connectionId: "conn_removed02", model: "heygen/heygen-voice-1", voice: "nadine" }
    };
    for (const first of ["transcription", "speaking"] as const) {
      const { saved, providers } = await setup();
      saved.voicePreferences = stale;
      const intermediate: VoicePreferences = first === "transcription"
        ? { ...stale, transcription: DEFAULT_VOICE_PREFERENCES.transcription }
        : { ...stale, speaking: DEFAULT_VOICE_PREFERENCES.speaking };
      expect(await data(IPC.voice.updateSettings, intermediate)).toEqual(intermediate);
      expect(saved.voicePreferences).toEqual(intermediate);
      expect(await data(IPC.voice.updateSettings, DEFAULT_VOICE_PREFERENCES)).toEqual(DEFAULT_VOICE_PREFERENCES);
      expect(saved.voicePreferences).toEqual(DEFAULT_VOICE_PREFERENCES);
      expect(providers.credential).not.toHaveBeenCalled();
      expect(providers.test).not.toHaveBeenCalled();
    }
  });

  test("a stale choice can be kept unchanged, but not introduced or edited", async () => {
    const { saved } = await setup();
    const stale: VoicePreferences = {
      transcription: { connectionId: "conn_removed01", model: "openai/whisper-1" },
      speaking: { connectionId: "conn_removed02", model: "heygen/heygen-voice-1", voice: "nadine" }
    };
    saved.voicePreferences = stale;
    const replacement: VoicePreferences = {
      ...stale,
      transcription: { connectionId: CONNECTION.id, model: "openai/whisper-1" }
    };
    expect(await data(IPC.voice.updateSettings, replacement)).toEqual(replacement);
    for (const invalid of [
      { ...replacement, transcription: stale.transcription },
      { ...replacement, speaking: { ...stale.speaking, voice: "weston" } },
      { ...replacement, speaking: { ...stale.speaking, connectionId: "conn_removed03" } }
    ]) {
      await expect(data(IPC.voice.updateSettings, invalid)).rejects.toThrow(/no longer available/i);
      expect(saved.voicePreferences).toEqual(replacement);
    }
    const repaired = {
      ...replacement,
      speaking: { connectionId: CONNECTION.id, model: "heygen/heygen-voice-1", voice: "weston" }
    };
    expect(await data(IPC.voice.updateSettings, repaired)).toEqual(repaired);
  });

  test("an unchanged provider/model mismatch does not prevent repairing the other choice", async () => {
    const { saved, providers } = await setup();
    const mismatched: VoicePreferences = {
      transcription: { connectionId: CONNECTION.id, model: "muse-voice-transcribe-1.0" },
      speaking: { connectionId: "conn_removed02", model: "heygen/heygen-voice-1", voice: "nadine" }
    };
    saved.voicePreferences = mismatched;
    const clearSpeaking = { ...mismatched, speaking: DEFAULT_VOICE_PREFERENCES.speaking };
    expect(await data(IPC.voice.updateSettings, clearSpeaking)).toEqual(clearSpeaking);
    expect(providers.credential).not.toHaveBeenCalled();
    const changedMismatch = { ...clearSpeaking, transcription: { ...mismatched.transcription, model: "muse-voice-transcribe-1.0" } };
    // A valid saved branch may be retained, not changed to a mismatched provider/model pair.
    saved.voicePreferences = DEFAULT_VOICE_PREFERENCES;
    await expect(data(IPC.voice.updateSettings, changedMismatch)).rejects.toThrow(/does not support/i);
  });

  test("retired model and voice choices stay unavailable and can be repaired separately", async () => {
    for (const first of ["transcription", "speaking"] as const) {
      const { saved, providers } = await setup();
      const retired: VoicePreferences = {
        transcription: { connectionId: CONNECTION.id, model: "retired/transcription" },
        speaking: { connectionId: CONNECTION.id, model: "retired/speaking", voice: "retired-voice" }
      };
      saved.voicePreferences = retired;
      const status = await data<{ available: boolean; selected: boolean; unavailable: boolean }>(IPC.voice.speakers);
      expect(status).toMatchObject({ available: false, selected: true, unavailable: true });
      const intermediate = first === "transcription"
        ? { ...retired, transcription: DEFAULT_VOICE_PREFERENCES.transcription }
        : { ...retired, speaking: DEFAULT_VOICE_PREFERENCES.speaking };
      expect(await data(IPC.voice.updateSettings, intermediate)).toEqual(intermediate);
      expect(saved.voicePreferences).toEqual(intermediate);
      const changed = first === "transcription"
        ? { ...intermediate, speaking: { ...retired.speaking, voice: "another-retired-voice" } }
        : { ...intermediate, transcription: { ...retired.transcription, model: "retired/another-model" } };
      await expect(data(IPC.voice.updateSettings, changed)).rejects.toThrow(/does not support/i);
      expect(saved.voicePreferences).toEqual(intermediate);
      expect(await data(IPC.voice.updateSettings, DEFAULT_VOICE_PREFERENCES)).toEqual(DEFAULT_VOICE_PREFERENCES);
      expect(providers.credential).not.toHaveBeenCalled();
      expect(providers.test).not.toHaveBeenCalled();
    }
  });

  test("retired selections can be replaced with supported choices in either order", async () => {
    for (const first of ["transcription", "speaking"] as const) {
      const { saved } = await setup();
      const retired: VoicePreferences = {
        transcription: { connectionId: CONNECTION.id, model: "retired/transcription" },
        speaking: { connectionId: CONNECTION.id, model: "retired/speaking", voice: "retired-voice" }
      };
      const supported: VoicePreferences = {
        transcription: { connectionId: CONNECTION.id, model: "openai/whisper-1" },
        speaking: { connectionId: CONNECTION.id, model: "heygen/heygen-voice-1", voice: "weston" }
      };
      saved.voicePreferences = retired;
      const intermediate = first === "transcription"
        ? { ...retired, transcription: supported.transcription }
        : { ...retired, speaking: supported.speaking };
      expect(await data(IPC.voice.updateSettings, intermediate)).toEqual(intermediate);
      expect(await data(IPC.voice.updateSettings, supported)).toEqual(supported);
    }
  });

  test("overlapping voice saves cannot reintroduce a stale choice cleared by an earlier save", async () => {
    const { saved, settings } = await setup();
    const stale: VoicePreferences = {
      transcription: { connectionId: "conn_removed01", model: "openai/whisper-1" },
      speaking: { connectionId: "conn_removed02", model: "heygen/heygen-voice-1", voice: "nadine" }
    };
    saved.voicePreferences = stale;
    let entered!: () => void;
    let release!: () => void;
    const writing = new Promise<void>((resolve) => { entered = resolve; });
    const held = new Promise<void>((resolve) => { release = resolve; });
    let calls = 0;
    settings.update = async (patch) => {
      if (++calls === 1) {
        entered();
        await held;
      }
      Object.assign(saved, patch);
    };
    const first = data(IPC.voice.updateSettings, { ...stale, transcription: DEFAULT_VOICE_PREFERENCES.transcription });
    await writing;
    const second = call(IPC.voice.updateSettings, { ...stale, speaking: DEFAULT_VOICE_PREFERENCES.speaking });
    await Promise.resolve();
    await Promise.resolve();
    release();
    await first;
    expect(await second).toMatchObject({ ok: false, error: { code: "not-found" } });
    expect(saved.voicePreferences).toEqual({ ...stale, transcription: DEFAULT_VOICE_PREFERENCES.transcription });
  });

  test("a failed voice settings write does not block the next save", async () => {
    const { saved, settings } = await setup();
    let writes = 0;
    settings.update = async (patch) => {
      if (++writes === 1) throw new ProviderError("invalid-request", "The settings write failed.");
      Object.assign(saved, patch);
    };
    const selected: VoicePreferences = {
      ...DEFAULT_VOICE_PREFERENCES,
      speaking: { connectionId: CONNECTION.id, model: "heygen/heygen-voice-1", voice: "weston" }
    };
    await expect(data(IPC.voice.updateSettings, selected)).rejects.toThrow(/write failed/i);
    expect(saved.voicePreferences).toBeUndefined();
    expect(await data(IPC.voice.updateSettings, selected)).toEqual(selected);
    expect(saved.voicePreferences).toEqual(selected);
  });

  test("an illustration is generated into the book, read back, attached and removed", async () => {
    const { root, library, images } = await setup();
    const { bookId, one, two } = await book(library);
    const generated = await data<{ id: string; chapterId: string | null; fileName: string }>(IPC.images.generate, {
      bookId,
      chapterId: one.id,
      prompt: "A lighthouse at low tide.",
      size: "1024x1024"
    });
    expect(images.generate).toHaveBeenCalledWith({ prompt: "A lighthouse at low tide.", size: "1024x1024" });
    expect(generated.chapterId).toBe(one.id);
    expect(await stat(join(root, "books", bookId, "images", generated.fileName))).toBeTruthy();
    const loose = await data<{ id: string; chapterId: string | null }>(IPC.images.generate, { bookId, prompt: "The road." });
    expect(loose.chapterId).toBeNull();

    const read = await data<{ dataUrl: string }>(IPC.images.read, { bookId, imageId: generated.id });
    expect(read.dataUrl).toBe(`data:image/png;base64,${Buffer.from(PNG).toString("base64")}`);
    expect(await data(IPC.images.read, { bookId, imageId: "img_missing01" })).toBeNull();

    expect(await data(IPC.images.attach, { bookId, imageId: generated.id, chapterId: two.id })).toEqual(
      expect.objectContaining({ chapterId: two.id })
    );
    expect(await data(IPC.images.remove, { bookId, imageId: loose.id })).toBeNull();
    const listed = await data<{ manifest: { images: Array<{ id: string }> } }>(IPC.images.list, bookId);
    expect(listed.manifest.images.map((image) => image.id)).toEqual([generated.id]);
    // The SAM cutout was removed from the build (D-158): no channel can segment an image or save a cutout.
    for (const channel of ["segmentation:segment", "images:saveCutout", "images:attachCharacter"]) {
      expect(handlers.has(channel)).toBe(false);
    }
  });
});

describe("library folders and archives", () => {
  test("a library folder is opened by path or chosen in a dialog", async () => {
    const { studio } = await setup();
    const folder = await temp("studio-ipc-open-");
    const opened = await data<{ root: string }>(IPC.library.open, folder);
    expect(opened.root).toBe(studio.library?.root as string);
    expect((await readdir(folder)).length).toBeGreaterThan(0);

    expect(await data(IPC.library.choose)).toBeNull();
    expect(asked.open[0]).toEqual(expect.objectContaining({ title: "Choose a library folder" }));
    const chosen = await temp("studio-ipc-chosen-");
    answers.open.push({ canceled: false, filePaths: [chosen] });
    expect(await data(IPC.library.choose)).toEqual(expect.objectContaining({ root: studio.library?.root }));
    expect(await data(IPC.library.current)).toEqual(expect.objectContaining({ root: studio.library?.root }));
  });

  test("the whole library is exported as an archive and imported into an empty folder", async () => {
    const { library, studio } = await setup();
    await book(library);
    const exports = await temp("studio-ipc-export-");

    process.env.STUDIO_EXPORT_PATH = exports;
    const forced = await data<{ path: string; entryCount: number }>(IPC.library.exportArchive);
    expect(forced.path).toBe(join(exports, "library.zip"));
    expect((await readFile(forced.path)).subarray(0, 2).toString()).toBe("PK");
    delete process.env.STUDIO_EXPORT_PATH;

    expect(await data(IPC.library.exportArchive)).toBeNull();
    const chosen = join(exports, "chosen.zip");
    answers.save.push({ canceled: false, filePath: chosen });
    expect(await data(IPC.library.exportArchive)).toEqual(expect.objectContaining({ path: chosen }));

    expect(await data(IPC.library.importArchive)).toBeNull();
    answers.open.push({ canceled: false, filePaths: [chosen] });
    expect(await data(IPC.library.importArchive)).toBeNull();

    const destination = join(await temp("studio-ipc-import-"), "imported");
    await mkdir(destination);
    answers.open.push({ canceled: false, filePaths: [chosen] }, { canceled: false, filePaths: [destination] });
    const imported = await data<{ bookCount: number; library: { root: string } }>(IPC.library.importArchive);
    expect(imported.bookCount).toBe(1);
    expect(studio.library?.root).toBe(imported.library.root);
    expect(await studio.library?.listBooks()).toEqual([expect.objectContaining({ title: "The Salt Road" })]);

    const garbage = join(exports, "garbage.zip");
    await writeFile(garbage, "this is not a zip archive");
    answers.open.push({ canceled: false, filePaths: [garbage] }, { canceled: false, filePaths: [await temp("studio-ipc-empty-")] });
    const refused = await call(IPC.library.importArchive);
    expect(refused.ok ? null : refused.error.code).toBe("io");
  });

  /*
   * The old-backup import as the author reaches it: the dialog names a file, the handler reads its
   * text and the importer parses it. `legacy-import.test.ts` passes parsed objects to the importer,
   * so only these prove that a backup on disk imports at all.
   */
  const legacyBackup = {
    app: "moms-ai-book-studio",
    version: 1,
    exportedAt: "2026-01-02T03:04:05.000Z",
    books: [
      {
        title: "The Salt Road",
        description: "A crossing at low tide.",
        stage: "drafting",
        characters: [{ name: "Mara", role: "Keeper" }],
        memories: [{ text: "The sea is grey.", importance: "high" }],
        scenes: [
          { title: "The Door", draftContent: "The hall was cold.", arc: "beginning" },
          { title: "The Gate", draftContent: "Morning came slowly." }
        ]
      }
    ]
  };

  test("choosing no backup changes nothing, and a backup that vanished is reported as not found", async () => {
    const { library } = await setup();
    expect(await data(IPC.library.importLegacy)).toBeNull();
    expect(asked.open[0]).toEqual(expect.objectContaining({ title: "Import an old backup", buttonLabel: "Import backup" }));

    const backups = await temp("studio-ipc-legacy-");
    answers.open.push({ canceled: false, filePaths: [join(backups, "gone.json")] });
    const { result } = await logged(IPC.library.importLegacy);
    expect(result.ok ? null : result.error.code).toBe("not-found");
    expect(await library.listBooks()).toEqual([]);
  });

  test("a backup file on disk imports as a book with its chapters, and the file is left as it was", async () => {
    const { library } = await setup();
    const file = join(await temp("studio-ipc-legacy-"), "backup.json");
    await writeFile(file, `${JSON.stringify(legacyBackup, null, 2)}\n`);
    const bytes = await readFile(file);

    answers.open.push({ canceled: false, filePaths: [file] });
    const report = await data<{ imported: number; books: Array<{ title: string; chapters: number }> }>(
      IPC.library.importLegacy
    );
    expect(report.imported).toBe(1);
    expect(report.books).toEqual([expect.objectContaining({ title: "The Salt Road", chapters: 2, characters: 1, memories: 1 })]);

    const [summary] = await library.listBooks();
    expect(summary?.title).toBe("The Salt Road");
    const { chapters } = await library.readBook(summary?.id ?? "");
    expect(chapters.map((chapter) => [chapter.title, chapter.content.trim()])).toEqual([
      ["The Door", "The hall was cold."],
      ["The Gate", "Morning came slowly."]
    ]);
    expect(await readFile(file)).toEqual(bytes);
  });

  test("a damaged backup is refused in plain words and nothing in the library changes", async () => {
    const { root, library } = await setup();
    const file = join(await temp("studio-ipc-legacy-"), "backup.json");
    // The same export cut off partway, as an interrupted copy leaves it.
    await writeFile(file, JSON.stringify(legacyBackup).slice(0, 120));
    const snapshot = async () =>
      Promise.all((await filesUnder(root)).sort().map(async (path) => [path, await readFile(path, "utf8")]));
    const before = await snapshot();

    answers.open.push({ canceled: false, filePaths: [file] });
    const { result } = await logged(IPC.library.importLegacy);
    const message = result.ok ? "" : result.error.message;
    expect(message).toBe(
      "This file could not be read as a backup, so nothing was imported. It may be damaged or incomplete; export it again from the old app, then choose the new file."
    );
    expect(message).not.toMatch(/SyntaxError|JSON|Unexpected|token/);
    expect(await snapshot()).toEqual(before);
    expect(await library.listBooks()).toEqual([]);
  });
});

describe("exports", () => {
  test("a manuscript is written as Markdown or Word to the named folder in a headless run", async () => {
    const { library } = await setup();
    const { bookId } = await book(library);
    const exports = await temp("studio-ipc-manuscript-");
    process.env.STUDIO_EXPORT_PATH = exports;

    const markdown = await data<string>(IPC.books.exportMarkdown, bookId);
    expect(markdown).toBe(join(exports, "the-salt-road.md"));
    const text = await readFile(markdown, "utf8");
    expect(text).toContain("# The Salt Road");
    expect(text).toContain("## The Crossing");
    expect(text).toContain("Mara waited for the ebb.");

    const docx = await data<string>(IPC.books.exportDocx, bookId);
    expect(docx).toBe(join(exports, "the-salt-road.docx"));
    expect((await readFile(docx)).subarray(0, 2).toString()).toBe("PK");
  });

  test("an export never lands inside the library, and replacing a file asks first", async () => {
    const { root, library } = await setup();
    const { bookId } = await book(library);
    expect(await data(IPC.books.exportMarkdown, bookId)).toBeNull();
    expect(await data(IPC.books.exportDocx, bookId)).toBeNull();

    answers.save.push({ canceled: false, filePath: join(root, "books", "inside.md") });
    expect(await call(IPC.books.exportMarkdown, bookId)).toEqual({
      ok: false,
      error: {
        code: "invalid",
        message: "That location is inside the open library. Choose another folder so the export cannot overwrite the book's own files."
      }
    });
    await expect(stat(join(root, "books", "inside.md"))).rejects.toThrow();

    const target = join(await temp("studio-ipc-replace-"), "manuscript.md");
    await writeFile(target, "Someone else's notes.");
    answers.save.push({ canceled: false, filePath: target });
    answers.message.push({ response: 1 });
    expect(await data(IPC.books.exportMarkdown, bookId)).toBeNull();
    expect(asked.message[0]).toEqual(expect.objectContaining({ message: "“manuscript.md” already exists. Replace it?" }));
    expect(await readFile(target, "utf8")).toBe("Someone else's notes.");

    answers.save.push({ canceled: false, filePath: target });
    answers.message.push({ response: 0 });
    expect(await data(IPC.books.exportMarkdown, bookId)).toBe(target);
    expect(await readFile(target, "utf8")).toContain("# The Salt Road");

    const word = join(await temp("studio-ipc-word-"), "manuscript.docx");
    await writeFile(word, "old");
    answers.save.push({ canceled: false, filePath: word });
    answers.message.push({ response: 1 });
    expect(await data(IPC.books.exportDocx, bookId)).toBeNull();
    expect(await readFile(word, "utf8")).toBe("old");
    answers.save.push({ canceled: false, filePath: word });
    answers.message.push({ response: 0 });
    expect(await data(IPC.books.exportDocx, bookId)).toBe(word);
    expect((await readFile(word)).subarray(0, 2).toString()).toBe("PK");
  });

  test("a manuscript to import is read from the named file headless, or chosen in a dialog on macOS", async () => {
    await setup();
    const sources = await temp("studio-ipc-sources-");
    const text = join(sources, "letters.txt");
    await writeFile(text, "Dear Mara,\n\nThe light is out.\n");
    const pdf = join(sources, "letters.pdf");
    await writeFile(pdf, "%PDF-1.7");

    process.env.STUDIO_IMPORT_PATH = text;
    expect(await data(IPC.books.pickImportSource)).toEqual({
      status: "ready",
      source: expect.objectContaining({ status: "validated", fileName: "letters.txt", proposedTitle: "letters" })
    });
    process.env.STUDIO_IMPORT_PATH = pdf;
    expect(await data(IPC.books.pickImportSource)).toEqual(expect.objectContaining({ status: "refused" }));
    delete process.env.STUDIO_IMPORT_PATH;

    onPlatform("linux");
    expect(await data(IPC.books.pickImportSource)).toEqual(expect.objectContaining({ status: "refused", reason: "unsupported-platform" }));
    expect(asked.open).toHaveLength(0);

    onPlatform("darwin");
    expect(await data(IPC.books.pickImportSource)).toEqual({ status: "cancelled" });
    expect(asked.open[0]).toEqual(expect.objectContaining({ title: "Choose a manuscript", buttonLabel: "Choose manuscript" }));
    answers.open.push({ canceled: false, filePaths: [text] });
    expect(await data(IPC.books.pickImportSource)).toEqual(expect.objectContaining({ status: "ready" }));
    answers.open.push({ canceled: false, filePaths: [join(sources, "gone.txt")] });
    expect(await data(IPC.books.pickImportSource)).toEqual(expect.objectContaining({ status: "refused", reason: "not-found" }));
  });
});

describe("dialogs", () => {
  test("with the studio window open, every dialog is attached to it", async () => {
    const window = { id: 7 };
    const { library } = await setup({ window });
    const { bookId } = await book(library);
    onPlatform("darwin");
    await data(IPC.library.choose);
    await data(IPC.library.importLegacy);
    await data(IPC.library.exportArchive);
    answers.open.push({ canceled: false, filePaths: [join(tmpdir(), "library.zip")] });
    await data(IPC.library.importArchive);
    await data(IPC.agent.choosePluginFolder);
    await data(IPC.books.pickImportSource);

    const exports = await temp("studio-ipc-window-");
    for (const [channel, name] of [
      [IPC.books.exportMarkdown, "manuscript.md"],
      [IPC.books.exportDocx, "manuscript.docx"]
    ] as const) {
      const target = join(exports, name);
      await writeFile(target, "existing");
      answers.save.push({ canceled: false, filePath: target });
      expect(await data(channel, bookId)).toBeNull();
      expect(await readFile(target, "utf8")).toBe("existing");
    }

    // Six open dialogs (two for the archive), three save dialogs and two replace prompts.
    expect(asked.windows).toHaveLength(11);
    expect(asked.windows.every((attached) => attached === window)).toBe(true);
  });
});

describe("the app", () => {
  test("reports its build, and says plainly when the license list was never generated", async () => {
    await setup();
    expect(await data(IPC.app.info)).toEqual(
      expect.objectContaining({ target: "desktop", platform: process.platform, arch: process.arch })
    );
    const { result } = await logged(IPC.app.licenses);
    expect(result).toEqual({
      ok: false,
      error: {
        code: "internal",
        message: "This build has no list of open-source licenses. The list is written when the app is built."
      }
    });
  });
});
