import type {
  BookChanges,
  BookDetail,
  BookEditResult,
  BookListing,
  BookMeta,
  BookSummary,
  Chapter,
  ChapterConflict,
  ReorderChapterResult,
  ReorderDirection,
  SearchHit,
  SaveChapterResult
} from "./schema";
import type { Catalogue } from "./providers/models";
import type { ImageSize } from "./providers/images";
import type { ImageRecord } from "./images/schema";
import type { ImageList } from "./images/store";
import type { ConnectionSummary, CredentialStatus, ModelInfo, ProviderDescription, ProviderId } from "./providers/types";
import type { ExternalLink } from "./providers/links";
import type { UsageSummary } from "./providers/usage";
import type { VoiceTranscript } from "./providers/speech";
import type { AgentEvent, AgentTurnInput, AgentTurnStarted, AgentUndoResult } from "./agent";
import type { AgentThread } from "./agent/messages";
import type { AgentAnswerLength } from "./agent/settings";
import type { DriftReport } from "./sync/types";
import type { ThreadSummary } from "./agent/threads";
import type { AgentStatus, PluginStatus } from "./agent/metrics";
import type { AmbientStatus } from "./agent/ambient";
import type { ImportManuscriptInput, ImportSourcePick } from "./manuscript-import";
import type { LocationHealth } from "./sync/health";
import type { BookMatter, SaveMatterResult } from "./matter";
import type { VoicePreferences } from "./providers/voice-preferences";

export type { VoicePreferences } from "./providers/voice-preferences";

/** What the studio can speak with, and in which voices. */
export interface VoiceSpeakers {
  /** Whether any connection can speak at all. */
  available: boolean;
  /** Whether an explicit speaking selection exists in this profile. */
  selected?: boolean;
  /** Whether that saved connection is no longer available or capable. */
  unavailable?: boolean;
  /** The id is safe to expose and lets Settings show the selected connection. */
  connectionId?: string | null;
  /** The connection the voice would come from. */
  connectionLabel: string | null;
  /** Legacy field retained in the type for older renderer test fixtures; no longer populated. */
  endpoint?: string | null;
  /** The model that will read. */
  model: string | null;
  /** The model-specific selected voice. */
  voice?: string | null;
  /** The voices to offer. */
  voices: string[];
}

/** One spoken reply, ready to play. */
export interface SpokenReply {
  /** `data:audio/mpeg;base64,…` */
  dataUrl: string;
  mimeType: string;
  /** How many characters were spoken. */
  characters: number;
  /** How many requests it took. */
  chunks: number;
  connectionLabel: string;
  model: string;
  voice?: string;
}

/** The bridge to the phone, as the app's settings panel drives it. */
export interface BridgeControl {
  /** The running bridge's address, token and port, or null when it is off. */
  status: { url: string; token: string; address: string } | null;
  /** Start it on one named local address. */
  start(address: string): Promise<unknown>;
  /** Stop it. */
  stop(): Promise<void>;
}

/**
 * The bridge to the phone.
 *
 * The phone is on the local network and cannot reach the studio's loopback, so there is a second,
 * much smaller listener. It is off until the author turns it on.
 */
export interface BridgeStatus {
  /** Whether the bridge is listening. */
  running: boolean;
  /** The address a phone can reach, when it is running. */
  url: string | null;
  /** The token the phone must present. It is the control plane's own per-run token. */
  token: string | null;
  /** The local addresses the bridge could listen on. */
  addresses: string[];
  /** The address it is listening on. */
  address: string | null;
}
import type { StorageSummary } from "./library/storage";
import type { BuildMetadata } from "./build";
import type { LicenseReport } from "./licenses";

export type { AgentEvent, AgentTurnInput, AgentTurnStarted };
export type { AgentThread, ThreadSummary };

import type { LegacyImportReport } from "./legacy";

export const IPC = {
  app: {
    info: "app:info",
    /** The open-source licenses this build ships, read-only (D-186). */
    licenses: "app:licenses",
    /** Open one allow-listed page in the author's browser. Any other address is refused. */
    openLink: "app:openLink"
  },
  library: {
    choose: "library:choose",
    open: "library:open",
    current: "library:current",
    reveal: "library:reveal",
    importLegacy: "library:importLegacy",
    exportArchive: "library:exportArchive",
    importArchive: "library:importArchive",
    locationHealth: "library:locationHealth"
  },
  books: {
    list: "books:list",
    /** The grid's read: the books that open and the book folders that do not, with the reason. */
    listWithIssues: "books:listWithIssues",
    /** Show one book folder in the file manager, by its folder name under `books/`. */
    reveal: "books:reveal",
    create: "books:create",
    importManuscript: "books:importManuscript",
    pickImportSource: "books:pickImportSource",
    update: "books:update",
    edit: "books:edit",
    saveMatter: "books:saveMatter",
    delete: "books:delete",
    open: "books:open",
    exportDocx: "books:exportDocx",
    exportMarkdown: "books:exportMarkdown",
    exportPdf: "books:exportPdf",
    exportEpub: "books:exportEpub",
    exportImages: "books:exportImages",
    search: "books:search"
  },
  chapters: {
    create: "chapters:create",
    save: "chapters:save",
    updateMeta: "chapters:updateMeta",
    reorder: "chapters:reorder",
    move: "chapters:move",
    delete: "chapters:delete"
  },
  conflicts: {
    list: "conflicts:list",
    reveal: "conflicts:reveal"
  },
  drafts: {
    set: "drafts:set",
    clear: "drafts:clear",
    /** The window's answer to a flush request. Sent by the preload bridge itself, never by the page. */
    flushed: "drafts:flushed"
  },
  recovery: {
    /** The words a close or quit could not save to one book, kept in the studio's profile. */
    list: "recovery:list",
    /** Save kept words through the checked save; a chapter that changed keeps them as a conflict copy. */
    restore: "recovery:restore",
    /** Let kept words go. Only the author's explicit choice sends this. */
    discard: "recovery:discard"
  },
  sync: {
    /** Run a read-only drift scan now and remember when it ran. */
    check: "sync:check",
    /** Fold reviewed paths into the baseline and return the fresh report. */
    accept: "sync:accept",
    /** Save one chapter's draft through the normal checked path ("keep mine"). */
    keepMine: "sync:keepMine",
    /** Discard one chapter's unsent draft ("keep the disk version" for unsaved text). */
    discardDraft: "sync:discardDraft",
    /** The sync reminder settings: focus-scan interval and the last scan time. */
    settings: "sync:settings",
    /** Change the focus-scan interval, in minutes. */
    updateSettings: "sync:updateSettings"
  },
  providers: {
    list: "providers:list",
    models: "providers:models",
    /** Check a model id the connection does not list with one short request, then keep it. */
    addModel: "providers:addModel"
  },
  connections: {
    list: "connections:list",
    available: "connections:available",
    status: "connections:status",
    addKey: "connections:addKey",
    startOpenRouter: "connections:startOpenRouter",
    cancelOpenRouter: "connections:cancelOpenRouter",
    remove: "connections:remove",
    /** Explicit protected-storage round-trip behind the keychain Check control. Never called on open. */
    check: "connections:check",
    test: "connections:test"
  },
  usage: {
    summary: "usage:summary"
  },
  voice: {
    settings: "voice:settings",
    updateSettings: "voice:updateSettings",
    connections: "voice:connections",
    transcribe: "voice:transcribe",
    /** Connections that can speak, and the voices they offer. */
    speakers: "voice:speakers",
    /** Speak text and return the audio, so the renderer can play it. */
    speak: "voice:speak"
  },
  images: {
    list: "images:list",
    read: "images:read",
    generate: "images:generate",
    attach: "images:attach",
    remove: "images:remove"
  },
  agent: {
    start: "agent:start",
    stop: "agent:stop",
    undoLast: "agent:undoLast",
    approve: "agent:approve",
    /** Everything the app shows about a book's agent. */
    status: "agent:status",
    /** Change this book's agent settings. */
    setSettings: "agent:setSettings",
    /**
     * The address of the glasses page, with the per-run token in its fragment.
     *
     * `null` when the control plane is not running.
     */
    glassesUrl: "agent:glassesUrl",
    /**
     * The ambient agent's status of a book: where the author is, what changed, and what can be
     * said or done next.
     */
    ambient: "agent:ambient",
    /** The bridge to the phone: its address, its token and whether it is running. */
    bridge: "agent:bridge",
    /** Turn the bridge to the phone on or off. */
    setBridge: "agent:setBridge",
    /** Choose a folder of TypeScript tools. Returns null when the author cancels. */
    choosePluginFolder: "agent:choosePluginFolder",
    /** Point the app at a folder of TypeScript tools, or clear it with null. */
    setPluginFolder: "agent:setPluginFolder",
    threads: {
      list: "agent:threads:list",
      read: "agent:threads:read",
      rename: "agent:threads:rename",
      remove: "agent:threads:remove",
      fork: "agent:threads:fork"
    }
  }
} as const;

/** Main process to renderer. Not invoked; the preload bridge subscribes. */
export const AGENT_EVENT_CHANNEL = "agent:event";

/** Main process to renderer: a watched library path changed on disk. */
export const LIBRARY_EVENT_CHANNEL = "library:event";

export interface LibraryChangeEvent {
  /** Library-relative paths, already debounced into one batch. */
  paths: string[];
  at: string;
}

/** Main process to renderer: a drift scan found changes to review. */
export const SYNC_EVENT_CHANNEL = "sync:event";

export interface DriftEvent {
  report: DriftReport;
}

/**
 * Main process to renderer: a second copy of the studio started on this profile and was refused
 * before it opened the library (spec 002 FR-069). It carries nothing.
 */
export const SECOND_INSTANCE_EVENT_CHANNEL = "app:second-instance";

/**
 * Main process to renderer: a window the studio made after a background turn's window closed
 * opens on that turn's conversation, whether the turn is still running or has ended (spec 017
 * FR-012). The main process checks the ids with `agentConversationRefSchema` before it sends them.
 */
export const OPEN_CONVERSATION_EVENT_CHANNEL = "app:open-conversation";

export interface OpenConversationEvent {
  bookId: string;
  threadId: string;
  /** The chapter that was open when the turn's window closed, when the shell knows it. */
  chapterId?: string | undefined;
}

/**
 * Main process to renderer: a close or quit is about to save the drafts, so the open editor saves
 * its newest text first. The preload bridge answers on `IPC.drafts.flushed` with the same id.
 */
export const DRAFT_FLUSH_CHANNEL = "drafts:flush-request";

export interface DraftFlushRequest {
  requestId: string;
}

/** The sync reminder settings the Settings section shows. */
export interface SyncSettings {
  /** Minutes between drift scans when the window regains focus. */
  checkIntervalMinutes: number;
  /** When the drift scan last ran, as an ISO timestamp, or null when never. */
  lastScanAt: string | null;
}

export interface LibraryInfo {
  root: string;
  deviceId: string;
  deviceName: string;
  /**
   * Browser builds disclose durability; desktop folders omit it. `| undefined` so a build that has
   * a library but no summary yet can say so explicitly rather than omit the key.
   */
  storage?: StorageSummary | undefined;
}

export interface StudioError {
  code: string;
  message: string;
}

export type Result<T> = { ok: true; data: T } | { ok: false; error: StudioError };

export interface DraftInput {
  bookId: string;
  chapterId: string;
  content: string;
  baseVersion: number;
  baseHash: string;
}

/**
 * Words a close or quit could not save to the library, kept in the studio's own profile until the
 * author restores or discards them (`docs/FORMAT.md`, "Kept words"). The renderer gets this summary;
 * the text itself stays in the main process until it is restored.
 */
export interface RecoveredDraft {
  id: string;
  bookId: string;
  chapterId: string;
  /** When the words were kept, as an ISO timestamp. */
  keptAt: string;
  /** Why the save failed, in the main process's words. */
  reason: string;
  wordCount: number;
  /** The last words of the kept text, so two kept copies of one chapter can be told apart. */
  ending: string;
}

export interface SaveChapterInput {
  bookId: string;
  chapterId: string;
  content: string;
  baseVersion: number;
  baseHash: string;
}

export interface SaveMatterInput {
  bookId: string;
  matter: BookMatter;
  /** The `version` of the matter the author edited; 0 when the book had none. */
  baseVersion: number;
  /** `matterHash` of the matter the author edited. */
  baseHash: string;
}

export interface ChapterMetaPatch {
  title?: string;
  synopsis?: string;
  purpose?: string;
  notes?: string;
  arc?: "beginning" | "middle" | "end";
  order?: number;
  isPrologue?: boolean;
  color?: string | null;
}

/** The only bridge between the renderer and the filesystem. Nothing here takes a raw path. */
export interface ArchiveExportSummary {
  path: string;
  entryCount: number;
  expandedBytes: number;
}

export interface ArchiveImportSummary {
  library: LibraryInfo;
  bookCount: number;
}

/** An image the image export left out, and why. */
export interface ImageExportNote {
  /** The file name it would have had, such as `01-the-door.jpg`. */
  name: string;
  reason: string;
}

/**
 * What exporting a book's images as JPEG files did.
 *
 * `empty`, `cancelled` and `unconverted` wrote nothing; `unconverted` means the book has images
 * but none could become a JPEG. `saved` names the new folder and every file written into it.
 */
export type ImageExportResult =
  | { status: "empty" }
  | { status: "cancelled" }
  | { status: "unconverted"; skipped: ImageExportNote[] }
  | { status: "saved"; folder: string; files: string[]; skipped: ImageExportNote[] };

export interface StudioApi {
  app: {
    info(): Promise<Result<BuildMetadata>>;
    /** The packages this build ships with their licenses, generated by the build (D-186). */
    licenses(): Promise<Result<LicenseReport>>;
    /**
     * Notifies when a second copy of the studio started on this profile and closed without opening
     * the library. Returns an unsubscribe.
     */
    onSecondInstance(callback: () => void): () => void;
    /**
     * Notifies when this window should open a book's conversation: a background turn's window
     * closed, and the turn is still running or has since finished, failed or paused. Returns an
     * unsubscribe.
     */
    onOpenConversation(callback: (target: OpenConversationEvent) => void): () => void;
    /** Opens an allow-listed page in the system browser. The main process refuses any other address. */
    openLink(url: ExternalLink): Promise<Result<null>>;
  };
  library: {
    choose(): Promise<Result<LibraryInfo | null>>;
    open(folder: string): Promise<Result<LibraryInfo>>;
    current(): Promise<Result<LibraryInfo | null>>;
    reveal(): Promise<Result<null>>;
    importLegacy(): Promise<Result<LegacyImportReport | null>>;
    exportArchive(): Promise<Result<ArchiveExportSummary | null>>;
    importArchive(): Promise<Result<ArchiveImportSummary | null>>;
    /** Read-only location health from a fresh scan: state, count and author copy. */
    locationHealth(): Promise<Result<LocationHealth>>;
    /** Notifies when a book or trash file changed outside the studio. Returns an unsubscribe. */
    onChange(callback: (event: LibraryChangeEvent) => void): () => void;
  };
  books: {
    list(): Promise<Result<BookSummary[]>>;
    /** The books that open and the book folders that do not, so the grid never hides a book. */
    listWithIssues(): Promise<Result<BookListing>>;
    /** Show a book folder in the file manager. `folder` is its name under `books/`. */
    reveal(folder: string): Promise<Result<null>>;
    create(input: { title: string; description?: string }): Promise<Result<BookMeta>>;
    /** Publish a complete imported manuscript staged from the author's confirmed preview mapping. */
    importManuscript(input: ImportManuscriptInput): Promise<Result<BookDetail>>;
    /** Choose a manuscript file and read it in the main process. Nothing is written. */
    pickImportSource(): Promise<Result<ImportSourcePick>>;
    update(bookId: string, patch: Partial<BookMeta>): Promise<Result<BookMeta>>;
    /**
     * Save the fields an editor changed, each with the value it started from, merged onto the file as
     * it is now. Where another writer changed the same field, theirs stays and the editor's goes to a
     * conflict copy.
     */
    edit(bookId: string, changes: BookChanges): Promise<Result<BookEditResult>>;
    /**
     * Save the front and back matter (spec 035). Carries the version and hash of the matter the
     * author edited; a mismatch keeps their version in `conflicts/` and returns the newer one.
     */
    saveMatter(input: SaveMatterInput): Promise<Result<SaveMatterResult>>;
    delete(bookId: string): Promise<Result<{ trashedAt: string }>>;
    open(bookId: string): Promise<Result<BookDetail>>;
    exportDocx(bookId: string): Promise<Result<string | null>>;
    exportMarkdown(bookId: string): Promise<Result<string | null>>;
    /** Save the manuscript as a PDF where the author chooses; null when they cancel. */
    exportPdf(bookId: string): Promise<Result<string | null>>;
    /** Save the manuscript as an EPUB 3 e-book where the author chooses; null when they cancel. */
    exportEpub(bookId: string): Promise<Result<string | null>>;
    /** Save every image in the book as a JPEG in a new folder the author chooses. */
    exportImages(bookId: string): Promise<Result<ImageExportResult>>;
    search(bookId: string, query: string): Promise<Result<SearchHit[]>>;
  };
  chapters: {
    create(bookId: string, input: { title?: string }): Promise<Result<Chapter>>;
    save(input: SaveChapterInput): Promise<Result<SaveChapterResult>>;
    updateMeta(bookId: string, chapterId: string, patch: ChapterMetaPatch, expected: { baseVersion: number; baseHash: string }): Promise<Result<SaveChapterResult>>;
    reorder(bookId: string, chapterId: string, direction: ReorderDirection): Promise<Result<ReorderChapterResult>>;
    /** Move one chapter to a position in the current order (the drag path). */
    move(bookId: string, chapterId: string, targetIndex: number): Promise<Result<ReorderChapterResult>>;
    delete(bookId: string, chapterId: string): Promise<Result<null>>;
  };
  conflicts: {
    list(bookId: string): Promise<Result<ChapterConflict[]>>;
    reveal(bookId: string, savedAs: string): Promise<Result<null>>;
  };
  drafts: {
    set(input: DraftInput): Promise<Result<null>>;
    clear(bookId: string, chapterId: string): Promise<Result<null>>;
    /**
     * Runs `handler` when a close or quit asks for the newest text, and answers once it settles.
     * Returns an unsubscribe.
     */
    onFlushRequest(handler: () => Promise<unknown>): () => void;
  };
  recovery: {
    /** The words kept for this book after a close or quit could not save them, newest first. */
    list(bookId: string): Promise<Result<RecoveredDraft[]>>;
    /** Save kept words through the checked save. A chapter that changed keeps them as a conflict copy. */
    restore(id: string): Promise<Result<SaveChapterResult>>;
    /** Let kept words go. Only the author's explicit choice calls this. */
    discard(id: string): Promise<Result<null>>;
  };
  sync: {
    check(): Promise<Result<DriftReport | null>>;
    accept(paths: string[]): Promise<Result<DriftReport | null>>;
    keepMine(bookId: string, chapterId: string): Promise<Result<SaveChapterResult | null>>;
    discardDraft(bookId: string, chapterId: string): Promise<Result<null>>;
    settings(): Promise<Result<SyncSettings>>;
    updateSettings(patch: { checkIntervalMinutes?: number }): Promise<Result<SyncSettings>>;
    onDrift(callback: (drift: DriftEvent) => void): () => void;
  };
  providers: {
    list(): Promise<Result<ProviderDescription[]>>;
    models(connectionId: string): Promise<Result<Catalogue>>;
    /**
     * Keep a model id this connection does not list (FR-007). The main process sends the model one
     * short request on the connection's own endpoint first and saves nothing unless it answers.
     */
    addModel(connectionId: string, modelId: string): Promise<Result<ModelInfo>>;
  };
  connections: {
    list(): Promise<Result<ConnectionSummary[]>>;
    /** False when the operating system's protected storage cannot encrypt a secret. */
    available(): Promise<Result<boolean>>;
    /** Non-secret health check: protected storage, backend label, connection count. */
    status(): Promise<Result<CredentialStatus>>;
    /** Explicit round-trip probe for the keychain Check control. Never called on view open. */
    check(): Promise<Result<CredentialStatus>>;
    /** Validate a key with the provider before saving it. Rejected keys are never stored. */
    addKey(input: {
      provider: ProviderId;
      secret: string;
      label?: string | undefined;
      baseUrl?: string | undefined;
    }): Promise<Result<ConnectionSummary>>;
    /** Opens the system browser and resolves when the author finishes signing in. */
    startOpenRouter(): Promise<Result<ConnectionSummary>>;
    cancelOpenRouter(): Promise<Result<null>>;
    remove(connectionId: string): Promise<Result<null>>;
    test(connectionId: string): Promise<Result<{ message: string }>>;
  };
  usage: {
    summary(bookId: string): Promise<Result<UsageSummary>>;
  };
  voice: {
    /** The current profile-local choices; this read never contacts a provider. */
    settings(): Promise<Result<VoicePreferences>>;
    /** Validate and atomically save the complete voice preference object. */
    updateSettings(preferences: VoicePreferences): Promise<Result<VoicePreferences>>;
    /** Connections that can accept audio. Empty means dictation is not configured. */
    connections(): Promise<Result<ConnectionSummary[]>>;
    transcribe(input: {
      /** Mono 16-bit PCM WAV at 16 kHz or 24 kHz. The main process validates it. */
      audio: ArrayBuffer;
      /** Choice read before recording; main refuses if the saved choice no longer matches. */
      expectedSelection: { connectionId: string; model: string };
      languageBias?: string[];
      keywords?: string[];
    }): Promise<Result<VoiceTranscript>>;
    /** The connections that can speak, and the voices they offer. */
    speakers(): Promise<Result<VoiceSpeakers>>;
    /**
     * Speak text and return the audio as a data URL.
     *
     * A chapter is more than one request; the main process splits it at sentence boundaries and
     * joins the audio back into one sound, so the caller plays one thing and stops one thing.
     */
    speak(input: {
      text: string;
      speed?: number;
    }): Promise<Result<SpokenReply>>;
  };
  images: {
    list(bookId: string): Promise<Result<ImageList>>;
    /** The record plus a data URL for a preview. No secret or host path is included. */
    read(bookId: string, imageId: string): Promise<Result<{ record: ImageRecord; dataUrl: string } | null>>;
    generate(input: {
      bookId: string;
      chapterId?: string;
      connectionId?: string;
      prompt: string;
      size?: ImageSize;
    }): Promise<Result<ImageRecord>>;
    attach(bookId: string, imageId: string, chapterId: string): Promise<Result<ImageRecord>>;
    remove(bookId: string, imageId: string): Promise<Result<null>>;
  };
  agent: {
    start(input: AgentTurnInput): Promise<Result<AgentTurnStarted>>;
    stop(turnId: string): Promise<Result<null>>;
    /**
     * Undo the book's newest agent turn. With `turnId`, only while that turn owns the newest checkpoint:
     * otherwise nothing changes and the error says what is newest. The chat names the turn it offers;
     * the strip names none.
     */
    undoLast(bookId: string, turnId?: string): Promise<Result<AgentUndoResult>>;
    approve(turnId: string, approvalId: string, approved: boolean): Promise<Result<null>>;
    /** Everything the app shows about a book's agent: tools, skills, cache and plugins. */
    status(bookId: string): Promise<Result<AgentStatus>>;
    /**
     * Change this book's agent settings.
     *
     * The main process merges the patch into the book's current settings, so a change never drops
     * a setting the app did not send.
     */
    setSettings(
      bookId: string,
      patch: {
        disabledTools?: string[];
        skillsEnabled?: boolean;
        tone?: string;
        answerLength?: AgentAnswerLength;
        perTurnCeilingUsd?: number | null;
        monthlyWarningUsd?: number | null;
        cachePrefixMode?: "off" | "auto";
      }
    ): Promise<Result<AgentStatus>>;
    /**
     * The address of the glasses page, with the per-run token in its fragment.
     *
     * `null` when the control plane is not running.
     */
    glassesUrl(): Promise<Result<string | null>>;
    /**
     * The ambient agent's status of a book: where the author is, what changed, and what can be
     * said or done next.
     */
    ambient(bookId: string, chapterId?: string | null): Promise<Result<AmbientStatus>>;
    /**
     * The bridge to the phone.
     *
     * It is off until the author turns it on, and it listens on one named local address.
     */
    bridge(): Promise<Result<BridgeStatus>>;
    /** Turn the bridge to the phone on or off. */
    setBridge(enabled: boolean): Promise<Result<BridgeStatus>>;
    /** Choose a folder of TypeScript tools. Returns null when the author cancels. */
    choosePluginFolder(): Promise<Result<string | null>>;
    /** Point the app at a folder of TypeScript tools, or clear it with null. */
    setPluginFolder(folder: string | null): Promise<Result<PluginStatus>>;
    threads: {
      list(bookId: string): Promise<Result<ThreadSummary[]>>;
      read(bookId: string, threadId: string): Promise<Result<AgentThread | null>>;
      rename(bookId: string, threadId: string, title: string): Promise<Result<AgentThread>>;
      remove(bookId: string, threadId: string): Promise<Result<null>>;
      fork(bookId: string, threadId: string, turnId: string): Promise<Result<AgentThread>>;
    };
    onEvent(callback: (event: AgentEvent) => void): () => void;
  };
  menu: {
    onOpenLibrary(callback: () => void): () => void;
  };
  platform: string;
}
