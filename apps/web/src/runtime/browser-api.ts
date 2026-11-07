import type { DraftInput, Result, StudioApi, StudioError } from "@ai-book-studio/core/ipc";
import { normalizeBody } from "@ai-book-studio/core/markdown";
import { ArchiveError } from "@ai-book-studio/core/archive/errors";
import { LibraryError, LibraryPortError } from "@ai-book-studio/core/library/errors";
import { buildMetadata } from "@ai-book-studio/core/build";
import { PROVIDER_LIST } from "@ai-book-studio/core/providers/registry";
import { EXTERNAL_LINKS } from "@ai-book-studio/core/providers/links";
import type { UsageSummary } from "@ai-book-studio/core/providers/usage";
import { exportBrowserArchive, importBrowserArchive, pickArchiveFile } from "../storage/archive-io";
import { BrowserCredentialVault } from "../storage/credentials";
import { BrowserDraftBuffer, flushDraftsOnHide } from "../storage/drafts";
import { BrowserLibraries, browserRuntime } from "./browser-libraries";
import { cancelOpenRouterFlow, startOpenRouterFlow } from "./openrouter";
import { fetchLicenses } from "./licenses";
import { ambientStatus } from "@ai-book-studio/core/agent/ambient";

/**
 * Staged publication needs the desktop atomic rename, and only the desktop app converts Word
 * documents, so the browser and mobile builds refuse both import channels (spec 029 T016).
 */
export const MANUSCRIPT_IMPORT_DESKTOP_ONLY =
  "Importing a manuscript (Word .docx, text or Markdown) is available in the desktop app.";

const EMPTY_USAGE: UsageSummary = {
  turns: 0,
  inputTokens: 0,
  outputTokens: 0,
  cachedInputTokens: 0,
  costUsd: 0,
  unknownCostTurns: 0,
  estimatedCostTurns: 0
};

/**
 * The renderer's `window.studio` contract over browser storage.
 *
 * Library, book, chapter, conflict, draft and archive operations are real. Desktop-only features
 * (Word export, the agent, provider connections and revealing a folder) return a specific,
 * author-readable refusal instead of pretending to work.
 */
export function createBrowserStudioApi(libraries: BrowserLibraries): StudioApi {
  const drafts = new BrowserDraftBuffer();
  const credentials = new BrowserCredentialVault();
  const markCommitted = (): void => {
    if (libraries.summary) libraries.summary.lastCommittedAt = new Date().toISOString();
  };
  const flush = async (draft: DraftInput) => {
    const result = await libraries.require().saveChapter(draft.bookId, draft.chapterId, draft.content, {
      baseVersion: draft.baseVersion,
      baseHash: draft.baseHash
    });
    if (result.status === "saved") markCommitted();
    return result;
  };

  if (typeof window !== "undefined") {
    // Best effort only: the browser may terminate the page before the write lands, so this never
    // upgrades the save status. `drafts.needsAttention` is the honest "not confirmed saved" state.
    flushDraftsOnHide(drafts, flush, window);
  }

  return {
    app: {
      // The browser reports its own platform channel as "web"; CPU architecture is
      // not reliably detectable there, so it stays honestly unknown.
      info: () => safe(async () => buildMetadata("web", { platform: "web", arch: "unknown" })),
      licenses: () => safe(() => fetchLicenses()),
      // A browser build has no second copy to refuse; tabs take turns through a storage lock.
      onSecondInstance: () => () => {},
      // Nor a window to reopen: a background turn is a desktop capability (spec 017 FR-015).
      onOpenConversation: () => () => {},
      // The browser is the shell here: the same allow-list, opened in a new tab that cannot reach back.
      openLink: (url) =>
        safe(async (): Promise<null> => {
          if (!(EXTERNAL_LINKS as readonly string[]).includes(url)) {
            throw new Error("The studio does not open that page.");
          }
          window.open(url, "_blank", "noopener,noreferrer");
          return null;
        })
    },
    library: {
      choose: () => safe(() => libraries.chooseFolder()),
      open: () =>
        Promise.resolve(
          failure(
            "invalid",
            "The browser build opens folders with the folder picker. Choose a folder from the welcome screen."
          )
        ),
      current: () => safe(async () => libraries.info()),
      reveal: () =>
        Promise.resolve(
          failure(
            "invalid",
            "Browser storage has no folder window. Export an archive to keep or move this library."
          )
        ),
      importLegacy: () =>
        Promise.resolve(
          failure("invalid", "Old backup import is available in the desktop app. Use Import archive in this build.")
        ),
      exportArchive: () =>
        safe(async () => {
          const result = await exportBrowserArchive(
            { storage: libraries.requirePort(), runtime: browserRuntime },
            { appVersion: "web" }
          );
          return {
            path: result.fileName,
            entryCount: result.manifest.entryCount,
            expandedBytes: result.manifest.expandedBytes
          };
        }),
      importArchive: () =>
        safe(async () => {
          const file = await pickArchiveFile();
          if (!file) return null;
          const destination = await libraries.createImportDestination();
          try {
            await importBrowserArchive(file, destination.port, browserRuntime);
            const info = await libraries.activateImport(destination);
            const books = await libraries.require().listBooks();
            return { library: info, bookCount: books.length };
          } catch (error) {
            await libraries.discardImport(destination);
            throw error;
          }
        }),
      locationHealth: () => safe(() => libraries.require().locationHealth()),
      // Browser storage has no cross-tab change event; the lock and hash checks remain the guard.
      onChange: () => () => {}
    },

    books: {
      list: () => safe(() => libraries.require().listBooks()),
      listWithIssues: () => safe(() => libraries.require().listBooksWithIssues()),
      reveal: () =>
        Promise.resolve(
          failure("invalid", "Browser storage has no folder window. Export an archive to keep or move this library.")
        ),
      create: (input) => safe(() => libraries.require().createBook(input)),
      update: (bookId, patch) => safe(() => libraries.require().updateBook(bookId, patch)),
      edit: (bookId, changes) => safe(() => libraries.require().editBook(bookId, changes)),
      saveMatter: (input) =>
        safe(() =>
          libraries.require().saveMatter(input.bookId, input.matter, {
            baseVersion: input.baseVersion,
            baseHash: input.baseHash
          })
        ),
      delete: (bookId) => safe(() => libraries.require().deleteBook(bookId)),
      open: (bookId) => safe(() => libraries.require().readBook(bookId)),
      exportDocx: () =>
        Promise.resolve(
          failure("invalid", "Word export is available in the desktop app. Export the library archive instead.")
        ),
      exportMarkdown: () =>
        Promise.resolve(
          failure("invalid", "Markdown export is available in the desktop app. Export the library archive instead.")
        ),
      exportPdf: () =>
        Promise.resolve(failure("invalid", "PDF export is available in the desktop app. Export the library archive instead.")),
      exportEpub: () =>
        Promise.resolve(
          failure("invalid", "EPUB export is available in the desktop app. Export the library archive instead.")
        ),
      exportImages: () =>
        Promise.resolve(
          failure("invalid", "Image export is available in the desktop app. Export the library archive instead.")
        ),
      // Staged publication needs the desktop atomic rename; the browser profile stays read-only for imports (T016).
      importManuscript: () => Promise.resolve(failure("invalid", MANUSCRIPT_IMPORT_DESKTOP_ONLY)),
      pickImportSource: () => Promise.resolve(failure("invalid", MANUSCRIPT_IMPORT_DESKTOP_ONLY)),
      search: (bookId, query) => safe(() => libraries.require().search(bookId, query))
    },

    chapters: {
      create: (bookId, input) => safe(() => libraries.require().createChapter(bookId, input)),
      save: (input) =>
        safe(async () => {
          const result = await libraries.require().saveChapter(input.bookId, input.chapterId, input.content, {
            baseVersion: input.baseVersion,
            baseHash: input.baseHash
          });
          if (result.status === "saved") {
            drafts.confirm(input.bookId, input.chapterId, input.content);
            markCommitted();
          }
          return result;
        }),
      updateMeta: (bookId, chapterId, patch, expected) =>
        safe(() => libraries.require().updateChapterMeta(bookId, chapterId, patch, expected)),
      reorder: (bookId, chapterId, direction) =>
        safe(() => libraries.require().reorderChapter(bookId, chapterId, direction)),
      move: (bookId, chapterId, targetIndex) =>
        safe(() => libraries.require().moveChapterTo(bookId, chapterId, targetIndex)),
      delete: (bookId, chapterId) =>
        safe(async () => {
          await libraries.require().deleteChapter(bookId, chapterId);
          drafts.clear(bookId, chapterId);
          return null;
        })
    },

    conflicts: {
      list: (bookId) => safe(() => libraries.require().listConflicts(bookId)),
      reveal: () =>
        Promise.resolve(
          failure("invalid", "Browser storage has no folder window. Open the archive or use the desktop app to inspect a conflict file.")
        )
    },

    drafts: {
      set: (input) =>
        safe(async () => {
          drafts.set(input);
          return null;
        }),
      clear: (bookId, chapterId) =>
        safe(async () => {
          drafts.clear(bookId, chapterId);
          return null;
        }),
      // A browser tab is never asked before it closes; `flushDraftsOnHide` is its safety net.
      onFlushRequest: () => () => {}
    },
    // Only the desktop app keeps words a close could not save; a tab has no profile folder for them.
    recovery: {
      list: () => safe(async () => []),
      restore: () => Promise.resolve(failure("not-found", "The browser build keeps no words outside the library.")),
      discard: () => safe(async () => null)
    },
    sync: {
      check: () =>
        safe(async () => {
          const service = libraries.require();
          await service.establishBaseline();
          return service.checkDrift(drafts.chapterIds());
        }),
      accept: (paths) => safe(() => libraries.require().acceptDrift(paths)),
      keepMine: (bookId, chapterId) =>
        safe(async () => {
          const held = drafts.get({ bookId, chapterId });
          if (!held) return null;
          const service = libraries.require();
          const disk = await service.readChapter(bookId, chapterId);
          if (disk.content === normalizeBody(held.content)) {
            drafts.clear(bookId, chapterId);
            return { status: "saved", chapter: disk } as const;
          }
          const result = await service.saveChapter(bookId, chapterId, held.content, {
            baseVersion: held.baseVersion,
            baseHash: held.baseHash
          });
          drafts.clear(bookId, chapterId);
          return result;
        }),
      discardDraft: (bookId, chapterId) =>
        safe(async () => {
          drafts.clear(bookId, chapterId);
          return null;
        }),
      settings: () =>
        Promise.resolve(
          failure(
            "invalid",
            "The scan interval lives in the desktop app. This build scans when it opens a folder."
          )
        ),
      updateSettings: () =>
        Promise.resolve(
          failure(
            "invalid",
            "The scan interval lives in the desktop app. This build scans when it opens a folder."
          )
        ),
      // Browser storage has no cross-tab change event; scans run when a folder opens.
      onDrift: () => () => {}
    },

    providers: {
      list: () => safe(async () => PROVIDER_LIST),
      models: () => safe(async () => ({ models: [], fetchedAt: null })),
      // A model id is only useful to the writing agent, which the browser build does not run yet.
      addModel: () =>
        Promise.resolve(
          failure("invalid", "Entering a model id is available in the desktop app. The browser build cannot run the writing agent yet.")
        )
    },

    connections: {
      list: () => safe(() => credentials.list()),
      available: () => safe(() => credentials.isAvailable()),
      status: () =>
        safe(async () => {
          const state = (await credentials.status?.()) ?? {
            available: await credentials.isAvailable(),
            backend: "Browser origin storage",
            detail: ""
          };
          return { ...state, connections: (await credentials.list()).length };
        }),
      check: () =>
        safe(async () => {
          const state = (await credentials.check?.()) ?? {
            available: await credentials.isAvailable(),
            backend: "Browser origin storage",
            detail: ""
          };
          return { ...state, connections: (await credentials.list()).length };
        }),
      addKey: () =>
        Promise.resolve(
          failure(
            "invalid",
            "Manual provider keys are not available in the browser build yet. Use Sign in with OpenRouter, or the desktop app."
          )
        ),
      startOpenRouter: () => safe(() => startOpenRouterFlow()),
      cancelOpenRouter: () =>
        safe(async (): Promise<null> => {
          cancelOpenRouterFlow();
          return null;
        }),
      remove: (connectionId) =>
        safe(async (): Promise<null> => {
          await credentials.remove(connectionId);
          return null;
        }),
      test: () =>
        Promise.resolve(
          failure("invalid", "Connection testing is not available in the browser build yet.")
        )
    },

    usage: {
      summary: () => safe(async () => EMPTY_USAGE)
    },
    voice: {
      connections: () => safe(async () => []),
      settings: () =>
        Promise.resolve(
          failure("unsupported", "Voice provider preferences are available in the desktop app only.")
        ),
      updateSettings: () =>
        Promise.resolve(
          failure("unsupported", "Voice provider preferences are available in the desktop app only.")
        ),
      transcribe: () =>
        Promise.resolve(
          failure(
            "invalid",
            "Voice dictation is available in the desktop app. Meta browser access is not verified yet."
          )
        ),
      speakers: () => safe(async () => ({
        available: false,
        selected: false,
        unavailable: false,
        connectionId: null,
        connectionLabel: null,
        model: null,
        voice: null,
        voices: []
      })),
      speak: () =>
        Promise.resolve(
          failure(
            "invalid",
            "Speaking is available in the desktop app. The browser uses the device's own voice."
          )
        )
    },
    images: {
      list: () => safe(async () => ({ manifest: { schemaVersion: 1, images: [] }, warning: null })),
      read: () => safe(async () => null),
      generate: () =>
        Promise.resolve(
          failure(
            "invalid",
            "Illustration generation is available in the desktop app. Meta browser access is not verified yet."
          )
        ),
      attach: () =>
        Promise.resolve(failure("invalid", "Illustrations are available in the desktop app.")),
      remove: () =>
        Promise.resolve(failure("invalid", "Illustrations are available in the desktop app."))
    },

    agent: {
      start: () =>
        Promise.resolve(
          failure("invalid", "The writing agent is not available in the browser build yet. Use the desktop app.")
        ),
      stop: () => safe(async () => null),
      undoLast: () =>
        Promise.resolve(
          failure("invalid", "The writing agent is not available in the browser build yet. Use the desktop app.")
        ),
      approve: () =>
        Promise.resolve(
          failure("invalid", "The writing agent is not available in the browser build yet. Use the desktop app.")
        ),
      status: () =>
        Promise.resolve(
          failure("invalid", "The writing agent is not available in the browser build yet. Use the desktop app.")
        ),
      setSettings: () =>
        Promise.resolve(
          failure("invalid", "The writing agent is not available in the browser build yet. Use the desktop app.")
        ),
      glassesUrl: () =>
        Promise.resolve(
          failure("invalid", "The writing agent is not available in the browser build yet. Use the desktop app.")
        ),
      /*
       * The ambient status is computed here, from the library this build already has.
       *
       * It is a pure function over the book and its chapters, so there is no reason for the
       * minimal mode to be broken in a browser: it knows where the author is, what the book holds
       * and what can be said, even though the writing agent itself needs the desktop.
       */
      ambient: (bookId, chapterId) =>
        safe(async () => {
          const detail = await libraries.require().readBook(bookId);
          return ambientStatus({
            book: {
              id: detail.book.id,
              title: detail.book.title || detail.book.workingTitle || "Untitled book",
              stage: detail.book.stage
            },
            chapters: detail.chapters.map((chapter) => ({
              id: chapter.id,
              title: chapter.title,
              order: chapter.order,
              wordCount: chapter.wordCount
            })),
            activeChapterId: chapterId ?? null,
            // There is no agent in this build, so nothing is running and nothing can be undone.
            working: false,
            canUndo: false,
            canKeepGoing: false,
            now: new Date()
          });
        }),
      bridge: () =>
        Promise.resolve(
          failure("invalid", "The writing agent is not available in the browser build yet. Use the desktop app.")
        ),
      setBridge: () =>
        Promise.resolve(
          failure("invalid", "The writing agent is not available in the browser build yet. Use the desktop app.")
        ),
      choosePluginFolder: () =>
        Promise.resolve(
          failure("invalid", "The writing agent is not available in the browser build yet. Use the desktop app.")
        ),
      setPluginFolder: () =>
        Promise.resolve(
          failure("invalid", "The writing agent is not available in the browser build yet. Use the desktop app.")
        ),
      threads: {
        list: () =>
          Promise.resolve(
            failure("invalid", "The writing agent is not available in the browser build yet. Use the desktop app.")
          ),
        read: () =>
          Promise.resolve(
            failure("invalid", "The writing agent is not available in the browser build yet. Use the desktop app.")
          ),
        rename: () =>
          Promise.resolve(
            failure("invalid", "The writing agent is not available in the browser build yet. Use the desktop app.")
          ),
        remove: () =>
          Promise.resolve(
            failure("invalid", "The writing agent is not available in the browser build yet. Use the desktop app.")
          ),
        fork: () =>
          Promise.resolve(
            failure("invalid", "The writing agent is not available in the browser build yet. Use the desktop app.")
          )
      },
      onEvent: () => () => {}
    },

    menu: {
      onOpenLibrary: () => () => {}
    },

    platform: "web"
  };
}

async function safe<T>(work: () => Promise<T>): Promise<Result<T>> {
  try {
    return { ok: true, data: await work() };
  } catch (error) {
    return failureFrom(error);
  }
}

function failure(code: StudioError["code"], message: string): Result<never> {
  return { ok: false, error: { code, message } };
}

function failureFrom(error: unknown): Result<never> {
  if (error instanceof LibraryError) {
    return failure(error.code, error.message);
  }
  if (error instanceof LibraryPortError) {
    const code: StudioError["code"] =
      error.code === "not-found" ? "not-found" : error.code === "invalid-path" ? "invalid" : "io";
    return failure(code, error.message);
  }
  if (error instanceof ArchiveError) {
    return failure("io", error.message);
  }
  return failure("io", error instanceof Error ? error.message : String(error));
}
