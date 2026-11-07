import { contextBridge, ipcRenderer } from "electron";
import {
  AGENT_EVENT_CHANNEL,
  DRAFT_FLUSH_CHANNEL,
  IPC,
  LIBRARY_EVENT_CHANNEL,
  OPEN_CONVERSATION_EVENT_CHANNEL,
  SECOND_INSTANCE_EVENT_CHANNEL,
  SYNC_EVENT_CHANNEL,
  type AgentEvent,
  type AgentTurnInput,
  type ChapterMetaPatch,
  type DraftFlushRequest,
  type DraftInput,
  type DriftEvent,
  type LibraryChangeEvent,
  type OpenConversationEvent,
  type SaveChapterInput,
  type StudioApi
} from "@ai-book-studio/core/ipc";
import type { BookMeta } from "@ai-book-studio/core/schema";
import type { ProviderId } from "@ai-book-studio/core/providers/types";
import type { AgentAnswerLength } from "@ai-book-studio/core/agent/settings";
import { createFlushRequests } from "./flush-requests";
import { createHeldSignal } from "./held-signal";

function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  return ipcRenderer.invoke(channel, ...args) as Promise<T>;
}

// A refused second copy can be reported while this page is still starting, before the shell listens.
const secondInstance = createHeldSignal();
ipcRenderer.on(SECOND_INSTANCE_EVENT_CHANNEL, () => secondInstance.emit());

// So can the conversation a window made after a background turn opens on.
const openConversation = createHeldSignal<OpenConversationEvent>();
ipcRenderer.on(OPEN_CONVERSATION_EVENT_CHANNEL, (_event, target: OpenConversationEvent) => openConversation.emit(target));

// A close or quit asks for the editor's newest text before it saves the drafts; always answered.
const flushRequests = createFlushRequests((requestId) => {
  void invoke(IPC.drafts.flushed, requestId).catch(() => {});
});
ipcRenderer.on(DRAFT_FLUSH_CHANNEL, (_event, request: DraftFlushRequest) => {
  void flushRequests.handle(request.requestId);
});

const api: StudioApi = {
  app: {
    info: () => invoke(IPC.app.info),
    licenses: () => invoke(IPC.app.licenses),
    onSecondInstance: (callback) => secondInstance.subscribe(callback),
    onOpenConversation: (callback) => openConversation.subscribe(callback),
    openLink: (url) => invoke(IPC.app.openLink, url)
  },
  library: {
    choose: () => invoke(IPC.library.choose),
    open: (folder) => invoke(IPC.library.open, folder),
    current: () => invoke(IPC.library.current),
    reveal: () => invoke(IPC.library.reveal),
    importLegacy: () => invoke(IPC.library.importLegacy),
    exportArchive: () => invoke(IPC.library.exportArchive),
    importArchive: () => invoke(IPC.library.importArchive),
    locationHealth: () => invoke(IPC.library.locationHealth),
    onChange: (callback) => {
      const listener = (_event: unknown, change: LibraryChangeEvent) => callback(change);
      ipcRenderer.on(LIBRARY_EVENT_CHANNEL, listener);
      return () => ipcRenderer.removeListener(LIBRARY_EVENT_CHANNEL, listener);
    }
  },
  books: {
    list: () => invoke(IPC.books.list),
    listWithIssues: () => invoke(IPC.books.listWithIssues),
    reveal: (folder: string) => invoke(IPC.books.reveal, folder),
    create: (input) => invoke(IPC.books.create, input),
    update: (bookId: string, patch: Partial<BookMeta>) => invoke(IPC.books.update, { bookId, patch }),
    edit: (bookId, changes) => invoke(IPC.books.edit, { bookId, changes }),
    saveMatter: (input) => invoke(IPC.books.saveMatter, input),
    delete: (bookId: string) => invoke(IPC.books.delete, bookId),
    open: (bookId) => invoke(IPC.books.open, bookId),
    search: (bookId: string, query: string) => invoke(IPC.books.search, { bookId, query }),
    exportDocx: (bookId) => invoke(IPC.books.exportDocx, bookId),
    exportMarkdown: (bookId) => invoke(IPC.books.exportMarkdown, bookId),
    exportPdf: (bookId) => invoke(IPC.books.exportPdf, bookId),
    exportEpub: (bookId) => invoke(IPC.books.exportEpub, bookId),
    exportImages: (bookId) => invoke(IPC.books.exportImages, bookId),
    importManuscript: (input) => invoke(IPC.books.importManuscript, input),
    pickImportSource: () => invoke(IPC.books.pickImportSource)
  },
  chapters: {
    create: (bookId, input) => invoke(IPC.chapters.create, { bookId, ...input }),
    save: (input: SaveChapterInput) => invoke(IPC.chapters.save, input),
    updateMeta: (bookId, chapterId, patch: ChapterMetaPatch, expected) =>
      invoke(IPC.chapters.updateMeta, { bookId, chapterId, patch, expected }),
    reorder: (bookId, chapterId, direction) =>
      invoke(IPC.chapters.reorder, { bookId, chapterId, direction }),
    move: (bookId, chapterId, targetIndex) =>
      invoke(IPC.chapters.move, { bookId, chapterId, targetIndex }),
    delete: (bookId, chapterId) => invoke(IPC.chapters.delete, { bookId, chapterId })
  },
  conflicts: {
    list: (bookId) => invoke(IPC.conflicts.list, bookId),
    reveal: (bookId, savedAs) => invoke(IPC.conflicts.reveal, { bookId, savedAs })
  },
  drafts: {
    set: (input: DraftInput) => invoke(IPC.drafts.set, input),
    clear: (bookId, chapterId) => invoke(IPC.drafts.clear, { bookId, chapterId }),
    onFlushRequest: (handler) => flushRequests.subscribe(handler)
  },
  recovery: {
    list: (bookId) => invoke(IPC.recovery.list, bookId),
    restore: (id) => invoke(IPC.recovery.restore, id),
    discard: (id) => invoke(IPC.recovery.discard, id)
  },
  sync: {
    check: () => invoke(IPC.sync.check),
    accept: (paths) => invoke(IPC.sync.accept, paths),
    keepMine: (bookId, chapterId) => invoke(IPC.sync.keepMine, { bookId, chapterId }),
    discardDraft: (bookId, chapterId) => invoke(IPC.sync.discardDraft, { bookId, chapterId }),
    settings: () => invoke(IPC.sync.settings),
    updateSettings: (patch) => invoke(IPC.sync.updateSettings, patch),
    onDrift: (callback) => {
      const listener = (_event: unknown, drift: DriftEvent) => callback(drift);
      ipcRenderer.on(SYNC_EVENT_CHANNEL, listener);
      return () => ipcRenderer.removeListener(SYNC_EVENT_CHANNEL, listener);
    }
  },
  usage: {
    summary: (bookId) => invoke(IPC.usage.summary, bookId)
  },
  voice: {
    settings: () => invoke(IPC.voice.settings),
    updateSettings: (preferences) => invoke(IPC.voice.updateSettings, preferences),
    connections: () => invoke(IPC.voice.connections),
    transcribe: (input) => invoke(IPC.voice.transcribe, input),
    speakers: () => invoke(IPC.voice.speakers),
    speak: (input) => invoke(IPC.voice.speak, input)
  },
  images: {
    list: (bookId) => invoke(IPC.images.list, bookId),
    read: (bookId, imageId) => invoke(IPC.images.read, { bookId, imageId }),
    generate: (input) => invoke(IPC.images.generate, input),
    attach: (bookId, imageId, chapterId) => invoke(IPC.images.attach, { bookId, imageId, chapterId }),
    remove: (bookId, imageId) => invoke(IPC.images.remove, { bookId, imageId })
  },
  providers: {
    list: () => invoke(IPC.providers.list),
    models: (connectionId) => invoke(IPC.providers.models, connectionId),
    addModel: (connectionId, modelId) => invoke(IPC.providers.addModel, { connectionId, modelId })
  },
  connections: {
    list: () => invoke(IPC.connections.list),
    available: () => invoke(IPC.connections.available),
    status: () => invoke(IPC.connections.status),
    check: () => invoke(IPC.connections.check),
    addKey: (input: { provider: ProviderId; secret: string; label?: string; baseUrl?: string }) =>
      invoke(IPC.connections.addKey, input),
    startOpenRouter: () => invoke(IPC.connections.startOpenRouter),
    cancelOpenRouter: () => invoke(IPC.connections.cancelOpenRouter),
    remove: (connectionId) => invoke(IPC.connections.remove, connectionId),
    test: (connectionId) => invoke(IPC.connections.test, connectionId)
  },
  agent: {
    start: (input: AgentTurnInput) => invoke(IPC.agent.start, input),
    stop: (turnId: string) => invoke(IPC.agent.stop, turnId),
    undoLast: (bookId: string, turnId?: string) =>
      invoke(IPC.agent.undoLast, turnId ? { bookId, turnId } : { bookId }),
    approve: (turnId: string, approvalId: string, approved: boolean) =>
      invoke(IPC.agent.approve, { turnId, approvalId, approved }),
    status: (bookId: string) => invoke(IPC.agent.status, bookId),
    setSettings: (bookId: string, patch: {
      disabledTools?: string[];
      skillsEnabled?: boolean;
      tone?: string;
      answerLength?: AgentAnswerLength;
      perTurnCeilingUsd?: number | null;
      monthlyWarningUsd?: number | null;
      cachePrefixMode?: "off" | "auto";
    }) => invoke(IPC.agent.setSettings, { bookId, patch }),
    glassesUrl: () => invoke(IPC.agent.glassesUrl),
    ambient: (bookId: string, chapterId?: string | null) =>
      invoke(IPC.agent.ambient, chapterId ? { bookId, chapterId } : bookId),
    bridge: () => invoke(IPC.agent.bridge),
    setBridge: (enabled: boolean) => invoke(IPC.agent.setBridge, enabled),
    choosePluginFolder: () => invoke(IPC.agent.choosePluginFolder),
    setPluginFolder: (folder: string | null) => invoke(IPC.agent.setPluginFolder, folder),
    threads: {
      list: (bookId: string) => invoke(IPC.agent.threads.list, bookId),
      read: (bookId: string, threadId: string) => invoke(IPC.agent.threads.read, { bookId, threadId }),
      rename: (bookId: string, threadId: string, title: string) =>
        invoke(IPC.agent.threads.rename, { bookId, threadId, title }),
      remove: (bookId: string, threadId: string) =>
        invoke(IPC.agent.threads.remove, { bookId, threadId }),
      fork: (bookId: string, threadId: string, turnId: string) =>
        invoke(IPC.agent.threads.fork, { bookId, threadId, turnId })
    },
    onEvent: (callback: (event: AgentEvent) => void) => {
      const listener = (_event: unknown, payload: AgentEvent): void => callback(payload);
      ipcRenderer.on(AGENT_EVENT_CHANNEL, listener);
      return () => ipcRenderer.removeListener(AGENT_EVENT_CHANNEL, listener);
    }
  },
  menu: {
    onOpenLibrary: (callback) => {
      const listener = (): void => callback();
      ipcRenderer.on("menu:open-library", listener);
      return () => ipcRenderer.removeListener("menu:open-library", listener);
    }
  },
  platform: process.platform
};

contextBridge.exposeInMainWorld("studio", api);
