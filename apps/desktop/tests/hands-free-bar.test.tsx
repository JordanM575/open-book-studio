/// <reference types="bun" />
import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from "bun:test";
import React from "react";
import { mountDom, unmountDom } from "./support/dom";
import type { AgentEvent, AgentTurnInput } from "@ai-book-studio/core/agent";
import { validRoute } from "../../../packages/core/src/voice-session";
import type {
  HandsFreePort,
  HandsFreeSnapshot,
  HandsFreeTurn,
  HandsFreeHostOutcome,
  HandsFreeTranscript,
  HandsFreeAdmission,
} from "@ai-book-studio/app/lib/hands-free";
import type { HandsFreeSessionApi } from "@ai-book-studio/app/hooks/use-hands-free-session";

let testing!: typeof import("@testing-library/react/pure");
let HandsFreeBar!: typeof import("@ai-book-studio/app/components/HandsFreeBar").HandsFreeBar;
let ChatPanel!: typeof import("@ai-book-studio/app/components/ChatPanel").ChatPanel;
let useHandsFreeSession!: typeof import("@ai-book-studio/app/hooks/use-hands-free-session").useHandsFreeSession;

beforeAll(async () => {
  testing = await mountDom();
  ({ HandsFreeBar } = await import("@ai-book-studio/app/components/HandsFreeBar"));
  ({ ChatPanel } = await import("@ai-book-studio/app/components/ChatPanel"));
  ({ useHandsFreeSession } = await import("@ai-book-studio/app/hooks/use-hands-free-session"));
});
afterAll(async () => {
  await unmountDom();
});
afterEach(() => testing.cleanup());

/*
 * 017 T017: the mounted Discuss controls, driven by a synthetic host adapter.
 *
 * The adapter is a test double, not a capture implementation: it reports facts, opens and closes a
 * fake capture, and answers a segment with text. Nothing here touches the microphone, the OS, a
 * provider or the author's profile.
 */

const BOOK = "book_synthetic";
const CHAPTER = "chapter_synthetic";
const THREAD = "thread_synthetic";
const AT = "2026-01-01T00:00:00.000Z";

const IDENTITY = {
  hostId: "host_synthetic",
  windowId: "synthetic-window",
  frameId: "synthetic-frame",
  origin: "file://",
  libraryId: "library_synthetic",
} as const;

const ROUTE = {
  connectionId: "conn_synthetic",
  provider: "meta",
  model: "synthetic-transcribe",
  destination: "synthetic",
  voice: null,
  revision: 1,
} as const;

const GRANT = {
  grantId: "grant_synthetic",
  sessionId: "session_synthetic",
  generation: 1,
  hostId: IDENTITY.hostId,
  windowId: IDENTITY.windowId,
  frameId: IDENTITY.frameId,
  origin: IDENTITY.origin,
  active: true,
  audioOnly: true,
  expiresAt: 60_000,
} as const;

interface FakePort {
  port: HandsFreePort;
  startCapture: ReturnType<typeof mock>;
  stopCapture: ReturnType<typeof mock>;
  transcribeSegment: ReturnType<typeof mock>;
  emitSegment: (segmentId: number) => void;
  facts: () => HandsFreeSnapshot;
  change: (patch: Partial<HandsFreeSnapshot>, notify?: boolean) => void;
  notify: (revision: number) => void;
  setThread: (threadId: string) => void;
}

function makePort(options: {
  grant?: unknown;
  text?: string;
  startCapture?: () => Promise<{ ok: boolean; reason?: string }>;
  stopCapture?: () => Promise<{ ok: boolean; reason?: string }>;
  onFactChange?: () => void;
} = {}): FakePort {
  const grant = options.grant === undefined ? GRANT : options.grant;
  let listener: ((segment: { segmentId: number }) => void) | null = null;
  let authorizedThread: string = THREAD;
  const factListeners = new Set<(revision: number) => void>();
  let facts: HandsFreeSnapshot = {
    hostRevision: 1,
    identity: IDENTITY,
    routes: { stt: ROUTE, tts: null, agent: ROUTE },
    grant: grant as HandsFreeSnapshot["grant"],
    sourceDigest: "sha256:synthetic-source",
    available: true,
    visible: true,
    unlocked: true,
  };
  const startCapture = mock(options.startCapture ?? (() => Promise.resolve({ ok: true })));
  const stopCapture = mock(options.stopCapture ?? (() => Promise.resolve({ ok: true })));
  const transcribeSegment = mock(() => Promise.resolve({ ok: true as const, text: options.text ?? "The gate was open." }));
  const port: HandsFreePort = {
    qualification: "synthetic-in-process-v1",
    currentRevision: () => facts.hostRevision,
    onFactsChanged(next) { factListeners.add(next); return () => { factListeners.delete(next); }; },
    admit(input, start) {
      if (input.revision !== facts.hostRevision || !facts.available || !facts.visible || !facts.unlocked ||
          input.scope.bookId !== BOOK || input.scope.chapterId !== CHAPTER || input.scope.threadId !== authorizedThread ||
          input.scope.mode !== "discuss" || !facts.identity || !facts.routes || !validRoute(facts.routes.stt) ||
          !validRoute(facts.routes.agent) || !facts.sourceDigest || !facts.grant?.active || !facts.grant.audioOnly ||
          facts.grant.hostId !== facts.identity.hostId || facts.grant.windowId !== facts.identity.windowId ||
          facts.grant.frameId !== facts.identity.frameId || facts.grant.origin !== facts.identity.origin ||
          (port.now?.() ?? Date.now()) >= facts.grant.expiresAt) return { admitted: false };
      return { admitted: true, value: start() };
    },
    snapshot: async (): Promise<HandsFreeSnapshot> => facts,
    now: () => 1_000,
    startCapture,
    stopCapture,
    transcribeSegment,
    startAgent: (request) => window.studio.agent.start(request), // The Studio API in these tests is an in-process fake.
    onSegment(next) {
      listener = next;
      return () => {
        listener = null;
      };
    },
  };
  return {
    port,
    startCapture,
    stopCapture,
    transcribeSegment,
    emitSegment: (segmentId: number) => listener?.({ segmentId }),
    facts: () => facts,
    change: (patch, notify = true) => {
      facts = { ...facts, ...patch, hostRevision: facts.hostRevision + 1 };
      options.onFactChange?.(); // This fake host can independently close its synthetic resource.
      if (notify) for (const next of factListeners) next(facts.hostRevision);
    },
    notify: (value) => { for (const next of factListeners) next(value); },
    setThread: (threadId) => {
      authorizedThread = threadId;
      facts = { ...facts, hostRevision: facts.hostRevision + 1 };
      options.onFactChange?.();
      for (const next of factListeners) next(facts.hostRevision);
    },
  };
}

function renderBar(
  port: HandsFreePort | undefined,
  onSendTurn: (turn: HandsFreeTurn, admission: HandsFreeAdmission) => Promise<{ ok: boolean; reason?: string }> =
    mock((_turn: HandsFreeTurn) => Promise.resolve({ ok: true })),
  threadId: string | null = THREAD
): { view: ReturnType<typeof testing.within>; onSendTurn: typeof onSendTurn } {
  testing.render(
    React.createElement(HandsFreeBar, {
      bookId: BOOK,
      chapterId: CHAPTER,
      threadId,
      ...(port ? { port } : {}),
      onSendTurn,
      onNotice: () => {},
      disabled: false,
    })
  );
  return { view: testing.within(document.body), onSendTurn };
}

function status(view: ReturnType<typeof testing.within>): string {
  return view.getByTestId("hands-free-status").textContent ?? "";
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

async function beginSession(view: ReturnType<typeof testing.within>): Promise<void> {
  await testing.waitFor(() => expect((view.getByTestId("hands-free-start") as HTMLButtonElement).disabled).toBe(false));
  await testing.act(async () => {
    testing.fireEvent.click(view.getByTestId("hands-free-start"));
  });
  await testing.waitFor(() => expect(status(view)).toContain("Listening"));
}

async function speak(view: ReturnType<typeof testing.within>, fake: FakePort, text?: string): Promise<void> {
  await testing.act(async () => {
    fake.emitSegment(1);
  });
  await testing.waitFor(() => expect((view.getByTestId("hands-free-draft") as HTMLTextAreaElement).value).toBe(text ?? "The gate was open."));
}

describe("mounted hands-free controls", () => {
  test("without a host adapter the reason is shown and Start is disabled", async () => {
    const { view } = renderBar(undefined);
    await testing.waitFor(() =>
      expect(status(view)).toBe("Hands-free audio is not connected in this build, so nothing is recorded or sent.")
    );
    expect((view.getByTestId("hands-free-start") as HTMLButtonElement).disabled).toBe(true);
    expect(view.queryByTestId("hands-free-draft")).toBeNull();
  });

  test("a host without an audio grant refuses by name and records nothing", async () => {
    const fake = makePort({ grant: null });
    const { view } = renderBar(fake.port);
    await testing.waitFor(() =>
      expect(status(view)).toBe("No audio grant is active for this conversation.")
    );
    expect((view.getByTestId("hands-free-start") as HTMLButtonElement).disabled).toBe(true);
    expect(fake.startCapture).not.toHaveBeenCalled();
  });

  test("grant then start opens capture once and shows the listening state", async () => {
    const fake = makePort();
    const { view } = renderBar(fake.port);
    await beginSession(view);
    expect(fake.startCapture).toHaveBeenCalledTimes(1);
    expect(view.getByTestId("hands-free-stop")).toBeDefined();
    expect(view.queryByTestId("hands-free-confirm")).toBeNull();
  });

  test("the transcript is editable and a correction never sends by itself", async () => {
    const fake = makePort();
    const { view, onSendTurn } = renderBar(fake.port);
    await beginSession(view);
    await speak(view, fake);
    expect(status(view)).toContain("Correct the words");

    const draft = view.getByTestId("hands-free-draft") as HTMLTextAreaElement;
    await testing.act(async () => {
      testing.fireEvent.change(draft, { target: { value: "The gate was locked." } });
    });
    await testing.waitFor(() =>
      expect((view.getByTestId("hands-free-draft") as HTMLTextAreaElement).value).toBe("The gate was locked.")
    );
    expect(onSendTurn).not.toHaveBeenCalled();
  });

  test("clearing and retyping keeps the same focused editor, even while host facts are pending", async () => {
    const fake = makePort();
    const { view, onSendTurn } = renderBar(fake.port);
    await beginSession(view);
    await speak(view, fake);
    const snapshot = await fake.port.snapshot({ bookId: BOOK, chapterId: CHAPTER, threadId: THREAD, mode: "discuss" });
    const pending = deferred<HandsFreeSnapshot | null>();
    fake.port.snapshot = () => pending.promise;
    const draft = view.getByTestId("hands-free-draft") as HTMLTextAreaElement;
    draft.focus();
    testing.fireEvent.change(draft, { target: { value: "" } });
    expect(view.getByTestId("hands-free-draft")).toBe(draft);
    expect(draft.value).toBe("");
    expect(document.activeElement).toBe(draft);
    expect((view.getByTestId("hands-free-confirm") as HTMLButtonElement).disabled).toBe(true);
    testing.fireEvent.change(draft, { target: { value: "Replacement words." } });
    expect(view.getByTestId("hands-free-draft")).toBe(draft);
    expect(draft.value).toBe("Replacement words.");
    expect(document.activeElement).toBe(draft);
    expect((view.getByTestId("hands-free-confirm") as HTMLButtonElement).disabled).toBe(false);
    expect(onSendTurn).not.toHaveBeenCalled();
    await testing.act(async () => { pending.resolve(snapshot); });
  });

  test("one confirm sends one Discuss turn to the exact bound thread", async () => {
    const fake = makePort();
    let release!: () => void;
    fake.port.startAgent = () => new Promise((resolve) => {
      release = () => resolve({ ok: true, data: { turnId: "synthetic", threadId: THREAD, mode: "discuss" } });
    });
    const onSendTurn = mock(async (turn: HandsFreeTurn, admission: HandsFreeAdmission) => {
      const result = await admission.dispatch({ bookId: turn.bookId, chapterId: turn.chapterId,
        threadId: turn.threadId, prompt: turn.text, mode: turn.mode });
      return { ok: result?.ok === true };
    });
    const { view } = renderBar(fake.port, onSendTurn);
    await beginSession(view);
    await speak(view, fake);

    const confirm = view.getByTestId("hands-free-confirm");
    confirm.focus();
    expect(document.activeElement).toBe(confirm);
    await testing.act(async () => {
      testing.fireEvent.click(confirm);
      testing.fireEvent.click(confirm);
    });
    await testing.waitFor(() => expect(onSendTurn).toHaveBeenCalledTimes(1));
    expect(onSendTurn.mock.calls[0]?.[0]).toEqual({
      text: "The gate was open.",
      bookId: BOOK,
      chapterId: CHAPTER,
      threadId: THREAD,
      mode: "discuss",
    });
    expect(status(view)).toContain("Sending your turn");
    await testing.act(async () => {
      release();
    });
    await testing.waitFor(() => expect(view.getByTestId("hands-free-note").textContent).toContain("Sent to this conversation."));
  });

  test("a different conversation ends the session and keeps the words unsent", async () => {
    const fake = makePort();
    const onSendTurn = mock((_turn: HandsFreeTurn) => Promise.resolve({ ok: true }));
    const view = testing.within(document.body);
    const props = {
      bookId: BOOK,
      chapterId: CHAPTER,
      port: fake.port,
      onSendTurn,
      onNotice: () => {},
      disabled: false,
    };
    const rendered = testing.render(React.createElement(HandsFreeBar, { ...props, threadId: THREAD }));
    await beginSession(view);
    await speak(view, fake);

    await testing.act(async () => {
      rendered.rerender(React.createElement(HandsFreeBar, { ...props, threadId: "thread_other" }));
    });
    await testing.waitFor(() => expect(view.getByTestId("hands-free-preserved").textContent).toContain("The gate was open."));
    expect(status(view)).not.toContain("Correct the words");
    expect(view.queryByTestId("hands-free-confirm")).toBeNull();
    expect(onSendTurn).not.toHaveBeenCalled();
  });

  test("stop waits for the host result before it says stopped, and late words cannot send", async () => {
    let holdStop = false;
    let releaseStop!: () => void;
    const fake = makePort({
      stopCapture: () => {
        if (!holdStop) return Promise.resolve({ ok: true });
        return new Promise<{ ok: boolean }>((resolve) => {
          releaseStop = () => resolve({ ok: true });
        });
      },
    });
    const onSendTurn = mock((_turn: HandsFreeTurn) => Promise.resolve({ ok: true }));
    const { view } = renderBar(fake.port, onSendTurn);
    await beginSession(view);
    holdStop = true;

    await testing.act(async () => {
      testing.fireEvent.click(view.getByTestId("hands-free-stop"));
    });
    await testing.waitFor(() => expect(status(view)).toContain("Stopping"));
    expect(status(view)).not.toContain("Stopped");

    await testing.act(async () => {
      releaseStop();
    });
    await testing.waitFor(() => expect(status(view)).toBe("Stopped."));

    await testing.act(async () => {
      fake.emitSegment(2);
    });
    await testing.act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(view.queryByTestId("hands-free-draft")).toBeNull();
    expect(view.queryByTestId("hands-free-confirm")).toBeNull();
    expect(onSendTurn).not.toHaveBeenCalled();
  });

  test("a stop the host does not confirm is never reported as stopped", async () => {
    const fake = makePort({
      stopCapture: () => Promise.resolve({ ok: false, reason: "Track stop failed." }),
    });
    const { view } = renderBar(fake.port);
    await beginSession(view);
    await testing.act(async () => {
      testing.fireEvent.click(view.getByTestId("hands-free-stop"));
    });
    await testing.waitFor(() => expect(view.getByTestId("hands-free-status").getAttribute("role")).toBe("alert"));
    expect(status(view)).toContain("Stop was not confirmed");
    expect(status(view)).not.toContain("Stopped");
    expect(view.queryByTestId("hands-free-confirm")).toBeNull();
  });

  test("Stop revokes a transcription queued behind a pending capture close", async () => {
    const close = deferred<{ ok: boolean }>();
    let closes = 0;
    const fake = makePort({ stopCapture: () => ++closes === 1 ? close.promise : Promise.resolve({ ok: true }) });
    const { view, onSendTurn } = renderBar(fake.port);
    await beginSession(view);
    await testing.act(async () => { fake.emitSegment(1); });
    await testing.waitFor(() => expect(fake.stopCapture).toHaveBeenCalledTimes(1));
    expect(fake.transcribeSegment).not.toHaveBeenCalled();
    await testing.act(async () => { testing.fireEvent.click(view.getByTestId("hands-free-stop")); });
    expect(status(view)).toContain("Stopping");
    expect(fake.stopCapture).toHaveBeenCalledTimes(1);
    await testing.act(async () => { close.resolve({ ok: true }); });
    expect(status(view)).toBe("Stopped.");
    expect(fake.transcribeSegment).not.toHaveBeenCalled();
    expect(onSendTurn).not.toHaveBeenCalled();
    expect(view.queryByTestId("hands-free-draft")).toBeNull();
  });

  test("Stop takes effect while an earlier segment is still reading host facts", async () => {
    const fake = makePort();
    const { view } = renderBar(fake.port);
    await beginSession(view);
    const originalSnapshot = fake.port.snapshot;
    const snapshot = await originalSnapshot({ bookId: BOOK, chapterId: CHAPTER, threadId: THREAD, mode: "discuss" });
    const pending = deferred<HandsFreeSnapshot | null>();
    fake.port.snapshot = () => pending.promise;
    await testing.act(async () => { fake.emitSegment(1); });
    await testing.act(async () => { testing.fireEvent.click(view.getByTestId("hands-free-stop")); });
    expect(status(view)).toBe("Stopped.");
    expect(fake.stopCapture).toHaveBeenCalledTimes(1);
    fake.port.snapshot = originalSnapshot;
    await testing.act(async () => { pending.resolve(snapshot); });
    await testing.waitFor(() => expect(status(view)).toBe("Stopped."));
    expect(fake.transcribeSegment).not.toHaveBeenCalled();
    expect(view.queryByTestId("hands-free-draft")).toBeNull();
  });

  test.each([
    ["revoked permission", { grant: null }],
    ["changed route", { routes: { stt: { ...ROUTE, revision: 2 }, tts: null, agent: ROUTE } }],
    ["hidden host", { visible: false }],
  ] satisfies [string, Partial<HandsFreeSnapshot>][])('%s while capture closes prevents adapter dispatch', async (_label, changed) => {
    const close = deferred<{ ok: boolean }>();
    const fake = makePort({ stopCapture: () => close.promise });
    const { view } = renderBar(fake.port);
    await beginSession(view);
    await testing.act(async () => { fake.emitSegment(1); });
    await testing.waitFor(() => expect(fake.stopCapture).toHaveBeenCalledTimes(1));
    const originalSnapshot = fake.port.snapshot;
    fake.port.snapshot = async (scope) => ({ ...await originalSnapshot(scope) as HandsFreeSnapshot, ...changed });
    await testing.act(async () => { close.resolve({ ok: true }); });
    expect(fake.transcribeSegment).not.toHaveBeenCalled();
    expect(view.queryByTestId("hands-free-draft")).toBeNull();
  });

  test("a conversation change or unmount while capture closes never dispatches old audio", async () => {
    for (const leave of ["switch", "unmount"]) {
      const close = deferred<{ ok: boolean }>();
      const fake = makePort({ stopCapture: () => close.promise });
      const onSendTurn = mock(() => Promise.resolve({ ok: true }));
      const props = { bookId: BOOK, chapterId: CHAPTER, threadId: THREAD, port: fake.port, onSendTurn };
      const rendered = testing.render(React.createElement(HandsFreeBar, props));
      const view = testing.within(document.body);
      await beginSession(view);
      await testing.act(async () => { fake.emitSegment(1); });
      await testing.waitFor(() => expect(fake.stopCapture).toHaveBeenCalledTimes(1));
      await testing.act(async () => {
        if (leave === "switch") rendered.rerender(React.createElement(HandsFreeBar, { ...props, threadId: "thread_other" }));
        else rendered.unmount();
      });
      await testing.act(async () => { close.resolve({ ok: true }); });
      expect(fake.transcribeSegment).not.toHaveBeenCalled();
      expect(onSendTurn).not.toHaveBeenCalled();
      rendered.unmount();
    }
  });

  test("a failed capture close cannot admit queued transcription", async () => {
    const fake = makePort({ stopCapture: async () => ({ ok: false, reason: "Capture did not close." }) });
    const { view } = renderBar(fake.port);
    await beginSession(view);
    await testing.act(async () => { fake.emitSegment(1); });
    await testing.waitFor(() => expect(view.getByTestId("hands-free-note").textContent).toContain("Nothing was sent"));
    expect(status(view)).toContain("Capture closure was not confirmed");
    expect(fake.transcribeSegment).not.toHaveBeenCalled();
    expect(view.queryByTestId("hands-free-draft")).toBeNull();
  });

  test("the status is announced and every control is keyboard reachable", async () => {
    const fake = makePort();
    const { view, onSendTurn } = renderBar(fake.port);
    const line = view.getByTestId("hands-free-status");
    expect(line.getAttribute("role")).toBe("status");
    expect(line.getAttribute("aria-live")).toBe("polite");
    const start = view.getByTestId("hands-free-start") as HTMLButtonElement;
    expect(start.tagName).toBe("BUTTON");
    await testing.waitFor(() => expect(start.disabled).toBe(false));
    start.focus();
    expect(document.activeElement).toBe(start);

    await beginSession(view);
    await speak(view, fake);
    const draft = view.getByTestId("hands-free-draft") as HTMLTextAreaElement;
    expect(draft.tagName).toBe("TEXTAREA");
    draft.focus();
    expect(document.activeElement).toBe(draft);
    const confirm = view.getByTestId("hands-free-confirm") as HTMLButtonElement;
    confirm.focus();
    expect(document.activeElement).toBe(confirm);
    await testing.act(async () => {
      testing.fireEvent.click(confirm);
    });
    await testing.waitFor(() => expect(onSendTurn).toHaveBeenCalledTimes(1));
  });
});

describe("Discuss panel binding", () => {
  test("a confirmed turn reuses the checked agent start with the loaded thread", async () => {
    const fake = makePort();
    const start = mock((_request: unknown) =>
      Promise.resolve({ ok: true, data: { turnId: "turn_voice", threadId: THREAD } })
    );
    let emit: ((event: AgentEvent) => void) | null = null;
    (globalThis as unknown as { window: { studio: unknown } }).window.studio = {
      platform: "darwin",
      agent: {
        threads: {
          list: mock(() =>
            Promise.resolve({
              ok: true,
              data: [{ id: THREAD, title: "A conversation", createdAt: AT, updatedAt: AT, messageCount: 0, preview: "" }],
            })
          ),
          read: mock(() =>
            Promise.resolve({
              ok: true,
              data: {
                thread: {
                  schemaVersion: 1,
                  id: THREAD,
                  bookId: BOOK,
                  title: "A conversation",
                  createdAt: AT,
                  updatedAt: AT,
                  messages: [],
                  checkpointTurns: [],
                },
                planRuntime: null,
              },
            })
          ),
          fork: mock(() => Promise.resolve({ ok: true, data: null })),
          remove: mock(() => Promise.resolve({ ok: true, data: null })),
          rename: mock(() => Promise.resolve({ ok: true, data: null })),
        },
        start,
        stop: mock(() => Promise.resolve({ ok: true, data: null })),
        approve: mock(() => Promise.resolve({ ok: true, data: null })),
        undoLast: mock(() => Promise.resolve({ ok: true, data: null })),
        onEvent: mock((handler: (event: AgentEvent) => void) => {
          emit = handler;
          return () => {
            emit = null;
          };
        }),
      },
    };
    testing.render(
      React.createElement(ChatPanel, {
        bookId: BOOK,
        chapterId: CHAPTER,
        onClose: () => {},
        onBeforeSend: async () => {},
        onChanged: () => {},
        onReconnect: () => {},
        onChooseModel: () => {},
        onChooseTurnModel: () => {},
        onTurnModelUsed: () => {},
        onNotice: () => {},
        handsFreePort: fake.port,
      })
    );
    const view = testing.within(document.body);
    await beginSession(view);
    await speak(view, fake);
    await testing.act(async () => {
      testing.fireEvent.click(view.getByTestId("hands-free-confirm"));
    });
    await testing.waitFor(() => expect(start).toHaveBeenCalledTimes(1));
    expect(start.mock.calls[0]?.[0]).toMatchObject({
      bookId: BOOK,
      chapterId: CHAPTER,
      threadId: THREAD,
      prompt: "The gate was open.",
      mode: "discuss",
    });
    // The one send path records the author's message in the conversation too.
    expect(view.getByText("The gate was open.")).toBeDefined();
    expect(emit).not.toBeNull();
  });
});

describe("StrictMode mount", () => {
  test("a development double-effect does not leave the store disposed", async () => {
    const fake = makePort();
    testing.render(
      React.createElement(
        React.StrictMode,
        null,
        React.createElement(HandsFreeBar, {
          bookId: BOOK,
          chapterId: CHAPTER,
          threadId: THREAD,
          port: fake.port,
          onSendTurn: mock(() => Promise.resolve({ ok: true })),
          onNotice: () => {},
          disabled: false,
        }),
      ),
    );
    const view = testing.within(document.body);
    await testing.waitFor(() =>
      expect((view.getByTestId("hands-free-start") as HTMLButtonElement).disabled).toBe(false));
    await testing.act(async () => {
      testing.fireEvent.click(view.getByTestId("hands-free-start"));
    });
    await testing.waitFor(() => expect(fake.startCapture).toHaveBeenCalledTimes(1));
    await testing.waitFor(() => expect(status(view)).toContain("Listening"));
  });
});

const TARGET = { bookId: BOOK, chapterId: CHAPTER, threadId: THREAD };

function SessionProbe({ port, receive }: { port: HandsFreePort; receive: (api: HandsFreeSessionApi) => void }) {
  const api = useHandsFreeSession({ scope: TARGET, port, onSendTurn: async () => ({ ok: true }) });
  receive(api);
  return null;
}

async function changingHost(options: Parameters<typeof makePort>[0] = {}) {
  return makePort(options);
}

function lifetimeBar(fake: FakePort, send = mock((_turn: HandsFreeTurn) => Promise.resolve({ ok: true }))) {
  const props = { ...TARGET, port: fake.port, onSendTurn: send };
  const rendered = testing.render(React.createElement(HandsFreeBar, props));
  return { props, rendered, view: testing.within(document.body), send };
}

describe("R1–R4 capture ownership and committed epochs", () => {
  test.each(["stop", "scope", "permission"])("R1: fresh capture admission rejects %s after initial Start facts", async (loss) => {
    const fake = await changingHost();
    const b = lifetimeBar(fake);
    await testing.waitFor(() => expect((b.view.getByTestId("hands-free-start") as HTMLButtonElement).disabled).toBe(false));
    const pending = deferred<HandsFreeSnapshot | null>();
    let reads = 0;
    fake.port.snapshot = () => ++reads === 1 ? Promise.resolve(fake.facts()) : pending.promise;
    await testing.act(async () => testing.fireEvent.click(b.view.getByTestId("hands-free-start")));
    expect(reads).toBe(2);
    expect(fake.startCapture).not.toHaveBeenCalled();
    await testing.act(async () => {
      if (loss === "stop") testing.fireEvent.click(b.view.getByTestId("hands-free-stop"));
      if (loss === "scope") b.rendered.rerender(React.createElement(HandsFreeBar, { ...b.props, threadId: "B" }));
      if (loss === "permission") fake.change({ grant: null });
      pending.resolve(fake.facts());
    });
    expect(fake.startCapture).not.toHaveBeenCalled();
    expect(fake.stopCapture).not.toHaveBeenCalled();
  });

  test.each(["stop", "scope", "permission", "route", "source", "hide"])(
    "R1: deferred send cannot reopen capture after %s", async (loss) => {
      const fake = await changingHost();
      const pending = deferred<HandsFreeHostOutcome>();
      const b = lifetimeBar(fake, mock(() => pending.promise));
      await beginSession(b.view);
      await speak(b.view, fake);
      await testing.act(async () => testing.fireEvent.click(b.view.getByTestId("hands-free-confirm")));
      expect((b.view.getByTestId("hands-free-stop") as HTMLButtonElement).disabled).toBe(false);
      await testing.act(async () => {
        if (loss === "stop") testing.fireEvent.click(b.view.getByTestId("hands-free-stop"));
        if (loss === "scope") b.rendered.rerender(React.createElement(HandsFreeBar, { ...b.props, threadId: "other" }));
        if (loss === "permission") fake.change({ grant: null });
        if (loss === "route") fake.change({ routes: { stt: ROUTE, tts: null, agent: { ...ROUTE, revision: 2 } } });
        if (loss === "source") fake.change({ sourceDigest: "changed" });
        if (loss === "hide") fake.change({ visible: false });
        pending.resolve({ ok: true });
      });
      expect(fake.startCapture).toHaveBeenCalledTimes(1);
      expect(fake.stopCapture).toHaveBeenCalledTimes(1);
      expect(b.view.queryByTestId("hands-free-confirm")).toBeNull();
    });

  test.each(["stop", "unmount", "port"])("R2: late acquisition after %s closes through its original owner", async (loss) => {
    const pending = deferred<HandsFreeHostOutcome>();
    let recording = false;
    const fake = makePort({ startCapture: async () => { const outcome = await pending.promise; recording = outcome.ok; return outcome; },
      stopCapture: async () => { recording = false; return { ok: true }; } });
    const other = makePort();
    const b = lifetimeBar(fake);
    await testing.waitFor(() => expect((b.view.getByTestId("hands-free-start") as HTMLButtonElement).disabled).toBe(false));
    await testing.act(async () => testing.fireEvent.click(b.view.getByTestId("hands-free-start")));
    expect(fake.startCapture).toHaveBeenCalledTimes(1);
    await testing.act(async () => {
      if (loss === "stop") testing.fireEvent.click(b.view.getByTestId("hands-free-stop"));
      if (loss === "unmount") b.rendered.unmount();
      if (loss === "port") b.rendered.rerender(React.createElement(HandsFreeBar, { ...b.props, port: other.port }));
    });
    expect(fake.stopCapture).not.toHaveBeenCalled();
    if (loss !== "unmount") expect(status(b.view)).toContain("Stopping");
    await testing.act(async () => pending.resolve({ ok: true }));
    expect(recording).toBe(false);
    expect(fake.stopCapture).toHaveBeenCalledTimes(1);
    expect(other.stopCapture).not.toHaveBeenCalled();
    if (loss !== "unmount") expect(status(b.view)).toBe("Stopped.");
  });

  test("R2: failed late-acquisition close stays unconfirmed and an explicit Stop retries", async () => {
    const pending = deferred<HandsFreeHostOutcome>();
    let closed = false;
    const fake = makePort({ startCapture: () => pending.promise,
      stopCapture: async () => ({ ok: closed, reason: "Track still open." }) });
    const b = lifetimeBar(fake);
    await testing.waitFor(() => expect((b.view.getByTestId("hands-free-start") as HTMLButtonElement).disabled).toBe(false));
    await testing.act(async () => testing.fireEvent.click(b.view.getByTestId("hands-free-start")));
    await testing.act(async () => testing.fireEvent.click(b.view.getByTestId("hands-free-stop")));
    expect(status(b.view)).toContain("Stopping");
    await testing.act(async () => pending.resolve({ ok: true }));
    expect(status(b.view)).toContain("Stop was not confirmed");
    expect(fake.stopCapture).toHaveBeenCalledTimes(1);
    expect(b.view.queryByTestId("hands-free-start")).toBeNull();
    closed = true;
    await testing.act(async () => testing.fireEvent.click(b.view.getByTestId("hands-free-stop")));
    expect(fake.stopCapture).toHaveBeenCalledTimes(2);
    expect(status(b.view)).toBe("Stopped.");
  });

  test("R2: remount with reused port/token waits for old ownership before opening a new track", async () => {
    const pending = deferred<HandsFreeHostOutcome>();
    let opens = 0;
    let recording = false;
    const fake = makePort({ startCapture: async () => {
      if (++opens === 1) await pending.promise;
      recording = true;
      return { ok: true };
    }, stopCapture: async () => { recording = false; return { ok: true }; } });
    const first = lifetimeBar(fake);
    await testing.waitFor(() => expect((first.view.getByTestId("hands-free-start") as HTMLButtonElement).disabled).toBe(false));
    await testing.act(async () => testing.fireEvent.click(first.view.getByTestId("hands-free-start")));
    first.rendered.unmount();
    const second = lifetimeBar(fake);
    await testing.waitFor(() => expect((second.view.getByTestId("hands-free-start") as HTMLButtonElement).disabled).toBe(false));
    await testing.act(async () => testing.fireEvent.click(second.view.getByTestId("hands-free-start")));
    expect(opens).toBe(1);
    await testing.act(async () => pending.resolve({ ok: true }));
    expect(opens).toBe(2);
    expect(fake.stopCapture).toHaveBeenCalledTimes(1);
    expect(recording).toBe(true);
    expect(status(second.view)).toContain("Listening");
  });

  test("R2: failed disposal cleanup remains unconfirmed on port reuse until explicit Stop succeeds", async () => {
    let closeOk = false;
    const fake = makePort({ stopCapture: async () => ({ ok: closeOk, reason: "Old track is still open." }) });
    const first = lifetimeBar(fake);
    await beginSession(first.view);
    await testing.act(async () => first.rendered.unmount());
    const second = lifetimeBar(fake);
    await testing.waitFor(() => expect((second.view.getByTestId("hands-free-start") as HTMLButtonElement).disabled).toBe(false));
    await testing.act(async () => testing.fireEvent.click(second.view.getByTestId("hands-free-start")));
    expect(status(second.view)).toContain("Stop was not confirmed");
    expect(fake.startCapture).toHaveBeenCalledTimes(1);
    expect(fake.stopCapture).toHaveBeenCalledTimes(1);
    closeOk = true;
    await testing.act(async () => testing.fireEvent.click(second.view.getByTestId("hands-free-stop")));
    expect(status(second.view)).toBe("Stopped.");
    await beginSession(second.view);
    expect(fake.startCapture).toHaveBeenCalledTimes(2);
    expect(fake.stopCapture).toHaveBeenCalledTimes(2);
  });

  test.each([true, false])("R3: Stop joins a pending hold close (ok=%s); no overlapping native close", async (ok) => {
    const pending = deferred<HandsFreeHostOutcome>();
    const fake = await changingHost({ stopCapture: () => pending.promise });
    const b = lifetimeBar(fake);
    await beginSession(b.view);
    await testing.act(async () => fake.emitSegment(1));
    await testing.act(async () => testing.fireEvent.click(b.view.getByTestId("hands-free-stop")));
    expect(fake.stopCapture).toHaveBeenCalledTimes(1);
    expect(status(b.view)).toContain("Stopping");
    expect((b.view.getByTestId("hands-free-start") as HTMLButtonElement).disabled).toBe(true);
    await testing.act(async () => pending.resolve({ ok, reason: "Track remains open." }));
    expect(status(b.view)).toContain(ok ? "Stopped." : "Stop was not confirmed");
    expect(fake.stopCapture).toHaveBeenCalledTimes(1);
    expect(fake.transcribeSegment).not.toHaveBeenCalled();
  });

  test.each(["listening", "start", "confirm", "stt", "corrected"].flatMap((stage) =>
    ["scope", "port"].map((kind) => [stage, kind] as const)))(
    "R4: committed A-B-A revokes %s through %s while snapshots await", async (stage, kind) => {
      const fake = await changingHost();
      const b = lifetimeBar(fake);
      await testing.waitFor(() => expect((b.view.getByTestId("hands-free-start") as HTMLButtonElement).disabled).toBe(false));
      if (stage !== "start") await beginSession(b.view);
      if (stage === "confirm" || stage === "corrected") await speak(b.view, fake);
      if (stage === "corrected") await testing.act(async () => testing.fireEvent.change(b.view.getByTestId("hands-free-draft"),
        { target: { value: "Corrected before leaving." } }));
      const pending = deferred<HandsFreeSnapshot | null>();
      const original = fake.port.snapshot;
      fake.port.snapshot = () => pending.promise;
      await testing.act(async () => {
        if (stage === "start") testing.fireEvent.click(b.view.getByTestId("hands-free-start"));
        if (stage === "confirm") testing.fireEvent.click(b.view.getByTestId("hands-free-confirm"));
        if (stage === "stt") fake.emitSegment(1);
      });
      await testing.act(async () => b.rendered.rerender(React.createElement(HandsFreeBar,
        kind === "scope" ? { ...b.props, threadId: "B" } : { ...b.props, port: makePort().port })));
      await testing.act(async () => b.rendered.rerender(React.createElement(HandsFreeBar, b.props)));
      expect(b.view.queryByTestId("hands-free-draft")).toBeNull();
      fake.port.snapshot = original;
      await testing.act(async () => pending.resolve(fake.facts()));
      expect(b.send).not.toHaveBeenCalled();
      expect(fake.startCapture).toHaveBeenCalledTimes(stage === "start" ? 0 : 1);
      expect(b.view.queryByTestId("hands-free-confirm")).toBeNull();
      if (stage === "stt") expect(fake.transcribeSegment).not.toHaveBeenCalled();
    });

  test("status descriptions resolve to stable, unique mounted IDs", async () => {
    const first = lifetimeBar(makePort());
    const second = lifetimeBar(makePort());
    const statuses = first.view.getAllByTestId("hands-free-status");
    expect(statuses[0]?.id).not.toBe(statuses[1]?.id);
    for (const start of first.view.getAllByTestId("hands-free-start")) {
      const id = start.getAttribute("aria-describedby");
      expect(id).toBeTruthy();
      expect(document.getElementById(id ?? "")?.dataset.testid).toBe("hands-free-status");
    }
    const id = statuses[0]?.id;
    await testing.act(async () => first.rendered.rerender(React.createElement(HandsFreeBar, first.props)));
    expect(first.view.getAllByTestId("hands-free-status")[0]?.id).toBe(id);
    second.rendered.unmount();
  });

  test("R4: a retained old segment callback cannot revive after scope ABA and fresh Start", async () => {
    const fake = await changingHost();
    const callbacks: Array<(segment: { segmentId: number }) => void> = [];
    fake.port.onSegment = (listener) => { callbacks.push(listener); return () => {}; };
    const b = lifetimeBar(fake);
    await beginSession(b.view);
    const old = callbacks.at(-1);
    await testing.act(async () => b.rendered.rerender(React.createElement(HandsFreeBar, { ...b.props, threadId: "B" })));
    await testing.act(async () => b.rendered.rerender(React.createElement(HandsFreeBar, b.props)));
    fake.change({ grant: { ...GRANT, generation: 2 } });
    await beginSession(b.view);
    await testing.act(async () => old?.({ segmentId: 1 }));
    expect(fake.transcribeSegment).not.toHaveBeenCalled();
    await testing.act(async () => callbacks.at(-1)?.({ segmentId: 1 }));
    expect(fake.transcribeSegment).toHaveBeenCalledTimes(1);
  });
});

describe("R5 attributable transcript receipts release revoked core requests", () => {
  test("Stop releases an arrived receipt even while its delivery snapshot never resolves", async () => {
    const fake = await changingHost();
    const result = deferred<HandsFreeTranscript>();
    const snapshot = deferred<HandsFreeSnapshot | null>();
    fake.port.transcribeSegment = () => result.promise;
    let api!: HandsFreeSessionApi;
    testing.render(React.createElement(SessionProbe, { port: fake.port, receive: (next) => { api = next; } }));
    await testing.act(async () => api.start());
    await testing.act(async () => fake.emitSegment(1));
    fake.port.snapshot = () => snapshot.promise;
    await testing.act(async () => result.resolve({ ok: true, text: "Already returned words." }));
    expect(api.state.transport.slots.stt).not.toBeNull();
    await testing.act(async () => api.stop());
    expect(api.state.transport.slots.stt).toBeNull();
    expect(api.state.session.requests.stt).toBeNull();
    expect(api.state.session.draft).toBe("");
    expect(api.state.lastReceipt?.unknownChunks).toBe(1);
    expect(api.phase).toBe("stopped");
  });

  for (const outcome of ["success", "failure"] as const) {
    test.each([
      ["permission", { grant: null }], ["hide", { visible: false }],
      ["source", { sourceDigest: "changed" }],
      ["route", { routes: { stt: { ...ROUTE, revision: 2 }, tts: null, agent: ROUTE } }],
    ] satisfies [string, Partial<HandsFreeSnapshot>][])(`${outcome} during %s loss permits fresh recovery`, async (_loss, patch) => {
      const fake = await changingHost();
      const original = fake.facts();
      const pending = deferred<HandsFreeTranscript>();
      fake.port.transcribeSegment = () => pending.promise;
      let api!: HandsFreeSessionApi;
      testing.render(React.createElement(SessionProbe, { port: fake.port, receive: (next) => { api = next; } }));
      await testing.act(async () => api.start());
      await testing.act(async () => fake.emitSegment(1));
      expect(api.state.transport.slots.stt?.chunks[0]?.state).toBe("dispatched");
      fake.change(patch);
      await testing.act(async () => pending.resolve(outcome === "success"
        ? { ok: true, text: "Revoked words." } : { ok: false, reason: "Revoked failure." }));
      expect(api.state.transport.slots.stt).toBeNull();
      expect(api.state.session.requests.stt).toBeNull();
      expect(api.state.session.failures.stt).toBeNull();
      expect(api.state.session.draft).toBe("");
      expect(api.state.session.active).toBe(false);
      expect(api.state.lastReceipt?.unknownChunks).toBe(1);
      fake.change({ ...original, grant: { ...GRANT, generation: 2 } });
      await testing.act(async () => api.start());
      await testing.act(async () => api.continueSession());
      expect(fake.startCapture).toHaveBeenCalledTimes(2);
      expect(api.phase).toBe("recording");
    });
  }
});

describe("R6 real ChatPanel post-flush voice admission", () => {
  test.each(["none", "unmount", "stop", "scope", "scope-aba", "port", "permission", "route", "source", "hide",
    "admission-stop", "admission-unmount", "admission-scope-aba", "host-refusal", "dispatched-stop", "dispatched-stop-failure",
    "dispatched-scope", "dispatched-hide", "dispatched-permission", "dispatched-hide-failure",
    "dispatched-permission-failure", "flush-failure", ...["permission", "visibility", "source", "route"].flatMap((fact) =>
      [`aba-${fact}`, `admission-aba-${fact}`, `dispatched-aba-${fact}`, `dispatched-delayed-aba-${fact}`])])(
    "deferred draft flush followed by %s", async (loss) => {
      const fake = await changingHost();
      if (loss === "host-refusal") {
        const guard = fake.port.admit;
        fake.port.admit = (input, start) => input.kind === "agent" ? { admitted: false } : guard(input, start);
      }
      const originalFacts = fake.facts();
      const flush = deferred<void>();
      const startResult = deferred<{ ok: true; data: { turnId: string; threadId: string } } |
        { ok: false; error: { code: string; message: string } }>();
      const before = mock(async () => { await flush.promise; if (loss === "flush-failure") throw new Error("Draft flush failed."); });
      const start = mock(async (_request: unknown) => loss.startsWith("dispatched-") ? startResult.promise
        : { ok: true, data: { turnId: "synthetic", threadId: THREAD } });
      (window as unknown as { studio: unknown }).studio = { platform: "darwin", agent: {
        threads: { list: async () => ({ ok: true, data: [{ id: THREAD }] }),
          read: async (_book: string, id: string) => ({ ok: true, data: { thread: { schemaVersion: 1, id, bookId: BOOK, title: "Synthetic",
            createdAt: AT, updatedAt: AT, messages: [], checkpointTurns: [] }, planRuntime: null } }) },
        start, onEvent: () => () => {}, stop: async () => ({ ok: true, data: null }),
      } };
      const props = { bookId: BOOK, chapterId: CHAPTER, handsFreePort: fake.port, onBeforeSend: before,
        onClose: () => {}, onChanged: () => {}, onReconnect: () => {}, onChooseModel: () => {},
        onChooseTurnModel: () => {}, onTurnModelUsed: () => {}, onNotice: () => {} };
      const rendered = testing.render(React.createElement(ChatPanel, props));
      const view = testing.within(document.body);
      await beginSession(view);
      await speak(view, fake);
      await testing.act(async () => testing.fireEvent.click(view.getByTestId("hands-free-confirm")));
      expect(before).toHaveBeenCalledTimes(1);
      expect(start).not.toHaveBeenCalled();
      expect((view.getByTestId("hands-free-stop") as HTMLButtonElement).disabled).toBe(false);
      const admissionFacts = deferred<HandsFreeSnapshot | null>();
      if (loss.startsWith("admission-")) {
        fake.port.snapshot = () => admissionFacts.promise;
        await testing.act(async () => flush.resolve());
        expect(start).not.toHaveBeenCalled();
      }
      if (loss.startsWith("dispatched-")) {
        await testing.act(async () => flush.resolve());
        expect(start).toHaveBeenCalledTimes(1);
      }
      await testing.act(async () => {
        if (loss === "unmount" || loss === "admission-unmount") rendered.unmount();
        if (loss === "stop" || loss === "admission-stop" || loss.startsWith("dispatched-stop")) testing.fireEvent.click(view.getByTestId("hands-free-stop"));
        if (loss === "dispatched-scope") rendered.rerender(React.createElement(ChatPanel, { ...props, openThreadId: "thread_other" }));
        if (loss === "scope" || loss === "scope-aba" || loss === "admission-scope-aba") rendered.rerender(React.createElement(ChatPanel, { ...props, chapterId: "B" }));
        if (loss === "port") rendered.rerender(React.createElement(ChatPanel, { ...props, handsFreePort: makePort().port }));
        if (loss === "permission") fake.change({ grant: null });
        if (loss === "route") fake.change({ routes: { stt: ROUTE, tts: null, agent: { ...ROUTE, revision: 2 } } });
        if (loss === "source") fake.change({ sourceDigest: "changed" });
        if (loss === "hide") fake.change({ visible: false });
        if (loss.startsWith("dispatched-permission")) fake.change({ grant: null });
        if (loss.startsWith("dispatched-hide")) fake.change({ visible: false });
        if (loss.includes("aba-") && !loss.includes("scope-aba")) {
          const name = loss.slice(loss.lastIndexOf("aba-") + 4);
          const patch = FACT_LOSSES.find(([key]) => key === name)?.[1];
          if (patch) {
            const notify = !loss.startsWith("dispatched-delayed-");
            fake.change(patch, notify);
            fake.change(originalFacts, notify);
          }
        }
      });
      if (loss === "scope-aba" || loss === "admission-scope-aba") await testing.act(async () => rendered.rerender(React.createElement(ChatPanel, props)));
      await testing.act(async () => {
        flush.resolve();
        admissionFacts.resolve(fake.facts());
        startResult.resolve(loss.startsWith("dispatched-") && loss.endsWith("-failure")
          ? { ok: false, error: { code: "synthetic", message: "Start failed after dispatch." } }
          : { ok: true, data: { turnId: "synthetic", threadId: THREAD } });
      });
      expect(start).toHaveBeenCalledTimes(loss === "none" || loss.startsWith("dispatched-") ? 1 : 0);
      expect(before).toHaveBeenCalledTimes(1);
      if (loss === "none") expect(start.mock.calls[0]?.[0]).toMatchObject({ bookId: BOOK, chapterId: CHAPTER,
        threadId: THREAD, prompt: "The gate was open.", mode: "discuss" });
      else if (!loss.includes("unmount") && loss !== "host-refusal") expect(view.queryByTestId("hands-free-confirm")).toBeNull();
      if (loss === "host-refusal") expect(view.getByTestId("hands-free-note").textContent).toContain("Nothing was sent");
      if (loss === "dispatched-stop") {
        expect(status(view)).toBe("Stopped.");
        expect(view.getByTestId("hands-free-note").textContent).toBe("Sent to this conversation.");
        expect(fake.startCapture).toHaveBeenCalledTimes(1);
      }
      if (loss.startsWith("dispatched-aba-")) {
        expect(view.getByTestId("hands-free-note").textContent).toBe("Sent to this conversation.");
        expect(fake.startCapture).toHaveBeenCalledTimes(1);
      }
      if (loss.startsWith("dispatched-delayed-aba-")) {
        expect(status(view)).toBe("Stopped.");
        expect(view.getByTestId("hands-free-note").textContent).toBe("Sent to this conversation.");
        expect(fake.startCapture).toHaveBeenCalledTimes(1);
        await testing.act(async () => fake.notify(fake.facts().hostRevision));
      }
      if (loss.startsWith("dispatched-hide") || loss.startsWith("dispatched-permission")) {
        expect(view.getByTestId("hands-free-note").textContent).toBe(loss.endsWith("-failure")
          ? "Start failed after dispatch." : "Sent to this conversation.");
        expect(status(view)).not.toContain("Nothing was recorded");
        expect(fake.startCapture).toHaveBeenCalledTimes(1);
      }
      if (loss === "dispatched-stop-failure") {
        expect(status(view)).toBe("Stopped.");
        expect(view.getByTestId("hands-free-note").textContent).toBe("Start failed after dispatch.");
        expect(view.getByTestId("hands-free-preserved").textContent).toContain("Retained words");
        expect(fake.startCapture).toHaveBeenCalledTimes(1);
      }
      if (loss === "flush-failure") expect(view.queryByTestId("agent-retry-request")).toBeNull();
      if (loss === "dispatched-scope") {
        expect(view.getByTestId("hands-free-note").textContent).toContain("original conversation");
        await testing.act(async () => {
          fake.setThread("thread_other");
          fake.change({ grant: { ...GRANT, generation: 2 } });
        });
        await beginSession(view);
        await speak(view, fake);
        await testing.act(async () => testing.fireEvent.click(view.getByTestId("hands-free-confirm")));
        expect(start).toHaveBeenCalledTimes(2);
        expect(start.mock.calls[1]?.[0]).toMatchObject({ threadId: "thread_other" });
      }
    });
});

describe("real ChatPanel voice history eligibility", () => {
  for (const next of ["typed", "voice"] as const) {
    test.each(["stop", "host-refusal", "flush-failure", "dispatched-success", "dispatched-failure", "dispatched-rejection"] as const)(
      `%s keeps only admitted words in the next ${next} request`, async (outcome) => {
        const firstWords = "Private synthetic voice words.";
        const nextWords = "A separate deliberately submitted turn.";
        const fake = makePort({ text: firstWords });
        const guard = fake.port.admit;
        if (outcome === "host-refusal") fake.port.admit = (input, start) => input.kind === "agent"
          ? { admitted: false } : guard(input, start);
        const flush = deferred<void>();
        let flushes = 0;
        const before = async () => {
          if (++flushes !== 1) return;
          await flush.promise;
          if (outcome === "flush-failure") throw new Error("Synthetic flush failure.");
        };
        const dispatched = outcome.startsWith("dispatched-");
        const start = mock(async (request: AgentTurnInput) => {
          if (request.prompt === firstWords) {
            if (outcome === "dispatched-rejection") throw new Error("Synthetic rejected start.");
            if (outcome === "dispatched-failure") return { ok: false, error: { code: "offline", message: "Synthetic failed start." } };
          }
          return { ok: true, data: { turnId: "history_turn", threadId: THREAD } };
        });
        let emit: ((event: AgentEvent) => void) | undefined;
        const legitimate: NonNullable<AgentTurnInput["history"]> = [
          { role: "user", text: "Earlier submitted words." },
          { role: "assistant", text: "Earlier answer." },
        ];
        (window as unknown as { studio: unknown }).studio = { platform: "darwin", agent: {
          threads: { list: async () => ({ ok: true, data: [{ id: THREAD }] }),
            read: async () => ({ ok: true, data: { thread: { schemaVersion: 1, id: THREAD, bookId: BOOK, title: "Synthetic",
              createdAt: AT, updatedAt: AT, checkpointTurns: [], messages: legitimate.map((entry, index) => ({
                id: `earlier_${index}`, role: entry.role, parts: [{ type: "text", text: entry.text }], createdAt: AT,
              })) }, planRuntime: null } }) },
          start, onEvent: (handler: (event: AgentEvent) => void) => { emit = handler; return () => { emit = undefined; }; },
          stop: async () => ({ ok: true, data: null }),
        } };
        testing.render(React.createElement(ChatPanel, { bookId: BOOK, chapterId: CHAPTER, handsFreePort: fake.port,
          onBeforeSend: before, onClose: () => {}, onChanged: () => {}, onReconnect: () => {},
          onChooseModel: () => {}, onChooseTurnModel: () => {}, onTurnModelUsed: () => {}, onNotice: () => {} }));
        const view = testing.within(document.body);
        await beginSession(view);
        await speak(view, fake, firstWords);
        await testing.act(async () => testing.fireEvent.click(view.getByTestId("hands-free-confirm")));
        expect(flushes).toBe(1);
        expect(start).not.toHaveBeenCalled();
        if (outcome === "stop") await testing.act(async () => testing.fireEvent.click(view.getByTestId("hands-free-stop")));
        await testing.act(async () => flush.resolve());
        if (outcome === "dispatched-success") {
          await testing.waitFor(() => expect(view.getByTestId("hands-free-note").textContent).toBe("Sent to this conversation."));
          await testing.act(async () => emit?.({ type: "stopped", turnId: "history_turn", changed: 0 }));
        }
        await testing.waitFor(() => expect(view.getByTestId("chat-send")).toBeDefined());
        expect(start).toHaveBeenCalledTimes(dispatched ? 1 : 0);
        // The local displayed words survive both refusals and dispatched errors.
        expect(view.getAllByText(firstWords).length).toBeGreaterThan(0);
        if (!dispatched) expect(view.queryByTestId("agent-retry-request")).toBeNull();
        if (outcome === "stop" || outcome === "host-refusal") expect(view.getAllByText(/Nothing was sent\./).length).toBeGreaterThan(0);
        if (next === "voice") {
          await testing.act(async () => {
            const stop = view.queryByTestId("hands-free-stop");
            if (stop) testing.fireEvent.click(stop);
          });
          await testing.waitFor(() => expect(status(view)).toBe("Stopped."));
          await testing.act(async () => {
            const acknowledge = view.queryByTestId("hands-free-acknowledge");
            if (acknowledge) testing.fireEvent.click(acknowledge);
          });
          fake.port.admit = guard;
          await testing.act(async () => fake.change({ grant: { ...GRANT, sessionId: "session_history_next", generation: 2 } }));
          fake.transcribeSegment.mockImplementation(async () => ({ ok: true, text: nextWords }));
          await beginSession(view);
          await speak(view, fake, nextWords);
          await testing.act(async () => testing.fireEvent.click(view.getByTestId("hands-free-confirm")));
        } else {
          await testing.act(async () => {
            testing.fireEvent.change(view.getByTestId("chat-input"), { target: { value: nextWords } });
            testing.fireEvent.keyDown(view.getByTestId("chat-input"), { key: "Enter", shiftKey: false });
          });
        }
        await testing.waitFor(() => expect(start).toHaveBeenCalledTimes(dispatched ? 2 : 1));
        const request = start.mock.calls.at(-1)?.[0];
        expect(request?.prompt).toBe(nextWords);
        expect(request?.history).toEqual(dispatched ? [...legitimate, { role: "user", text: firstWords }] : legitimate);
      });
  }
});

const FACT_LOSSES: [string, Partial<HandsFreeSnapshot>][] = [
  ["permission", { grant: null }],
  ["visibility", { visible: false }],
  ["source", { sourceDigest: "sha256:other" }],
  ["route", { routes: { stt: { ...ROUTE, revision: 2 }, tts: null, agent: ROUTE } }],
];

describe("qualified synthetic host lifetime (F1–F5)", () => {
  test("the synthetic admission boundary refuses foreign scope and invalid current routes", () => {
    const fake = makePort();
    const start = mock(() => true);
    const scope = { ...TARGET, mode: "discuss" as const };
    for (const foreign of [{ ...scope, bookId: "other" }, { ...scope, chapterId: "other" },
      { ...scope, threadId: "other" }]) {
      expect(fake.port.admit({ revision: fake.facts().hostRevision, scope: foreign, kind: "capture" }, start))
        .toEqual({ admitted: false });
    }
    fake.change({ routes: { stt: { ...ROUTE, revision: -1 }, tts: null, agent: ROUTE } });
    expect(fake.port.admit({ revision: fake.facts().hostRevision, scope, kind: "stt" }, start))
      .toEqual({ admitted: false });
    expect(start).not.toHaveBeenCalled();
  });

  for (const [label, loss] of FACT_LOSSES) {
    test(`ABA ${label} while STT waits for capture close remains unsent`, async () => {
      const close = deferred<HandsFreeHostOutcome>();
      const fake = makePort({ stopCapture: () => close.promise });
      const old = fake.facts();
      let api!: HandsFreeSessionApi;
      testing.render(React.createElement(SessionProbe, { port: fake.port, receive: (next) => { api = next; } }));
      await testing.act(async () => api.start());
      await testing.act(async () => fake.emitSegment(1));
      expect(fake.stopCapture).toHaveBeenCalledTimes(1);
      await testing.act(async () => { fake.change(loss); fake.change(old); close.resolve({ ok: true }); });
      expect(fake.transcribeSegment).not.toHaveBeenCalled();
      expect(api.state.session.active).toBe(false);
      expect(api.state.lastReceipt?.unsentChunks).toBe(1);
    });

    test(`ABA ${label} while Start joins the old owner requires a new activation`, async () => {
      const close = deferred<HandsFreeHostOutcome>();
      const fake = makePort({ stopCapture: () => close.promise });
      const old = fake.facts();
      let api!: HandsFreeSessionApi;
      const first = testing.render(React.createElement(SessionProbe, { port: fake.port, receive: (next) => { api = next; } }));
      await testing.act(async () => api.start());
      await testing.act(async () => first.unmount());
      testing.render(React.createElement(SessionProbe, { port: fake.port, receive: (next) => { api = next; } }));
      await testing.act(async () => api.start());
      expect(fake.startCapture).toHaveBeenCalledTimes(1);
      await testing.act(async () => { fake.change(loss); fake.change(old); close.resolve({ ok: true }); });
      expect(fake.startCapture).toHaveBeenCalledTimes(1);
      expect(api.state.session.active).toBe(false);
    });
  }

  test.each(["success", "failure"] as const)("same-port remount preserves outstanding STT and %s receipt", async (outcome) => {
    const firstResult = deferred<HandsFreeTranscript>();
    const fake = makePort();
    let firstSignal: AbortSignal | undefined;
    const transcribe = mock((input: { requestId: number; segmentId: number; signal: AbortSignal }) => {
      if (!firstSignal) { firstSignal = input.signal; return firstResult.promise; }
      return Promise.resolve({ ok: true as const, text: "New words." });
    });
    fake.port.transcribeSegment = transcribe;
    let api!: HandsFreeSessionApi;
    const first = testing.render(React.createElement(SessionProbe, { port: fake.port, receive: (next) => { api = next; } }));
    await testing.act(async () => api.start());
    await testing.act(async () => fake.emitSegment(1));
    const oldOperation = api.state.transport.slots.stt?.operationId;
    const oldRequest = transcribe.mock.calls[0]?.[0].requestId;
    expect(oldOperation).toBeDefined();
    await testing.act(async () => first.unmount());
    expect(firstSignal?.aborted).toBe(true);
    testing.render(React.createElement(SessionProbe, { port: fake.port, receive: (next) => { api = next; } }));
    await testing.act(async () => api.start());
    expect(api.state.transport.slots.stt?.operationId).toBe(oldOperation);
    await testing.act(async () => fake.emitSegment(1));
    expect(transcribe).toHaveBeenCalledTimes(1);
    expect(api.state.transport.slots.stt?.operationId).toBe(oldOperation);
    await testing.act(async () => firstResult.resolve(outcome === "success"
      ? { ok: true, text: "Old words." } : { ok: false, reason: "Old failure." }));
    expect(api.state.transport.slots.stt).toBeNull();
    expect(api.state.transport.receipts).toHaveLength(1);
    expect(api.state.lastReceipt?.operation.operationId).toBe(oldOperation);
    expect(api.state.lastReceipt?.unknownChunks).toBe(1);
    expect(api.state.lastReceipt?.finalChunkOutcome).toBe(outcome);
    expect(api.state.lastReceipt?.finalChunkFailure).toBe(outcome === "failure" ? "Old failure." : null);
    expect(api.state.session.draft).toBe("");
    await testing.act(async () => api.acknowledge());
    await testing.act(async () => api.continueSession());
    await testing.act(async () => fake.emitSegment(2));
    expect(transcribe).toHaveBeenCalledTimes(2);
    expect(transcribe.mock.calls[1]?.[0].requestId).not.toBe(oldRequest);
    expect(api.state.transport.receipts).toHaveLength(2);
    expect(api.state.transport.receipts[1]?.operation.operationId).not.toBe(oldOperation);
    expect(api.state.transport.receipts[0]?.unknownChunks).toBe(1);
    expect(api.state.session.draft).toBe("New words.");
  });

  test("a second consumer cannot cancel another consumer's outstanding STT", async () => {
    const result = deferred<HandsFreeTranscript>();
    const fake = makePort();
    let signal: AbortSignal | undefined;
    fake.port.transcribeSegment = (input) => { signal = input.signal; return result.promise; };
    let first!: HandsFreeSessionApi;
    let second!: HandsFreeSessionApi;
    testing.render(React.createElement(SessionProbe, { port: fake.port, receive: (api) => { first = api; } }));
    await testing.act(async () => first.start());
    await testing.act(async () => fake.emitSegment(1));
    expect(first.state.transport.slots.stt?.cancelled).toBe(false);
    testing.render(React.createElement(SessionProbe, { port: fake.port, receive: (api) => { second = api; } }));
    await testing.act(async () => second.start());
    await testing.act(async () => second.stop());
    expect(first.state.transport.slots.stt?.cancelled).toBe(false);
    expect(signal?.aborted).toBe(false);
    await testing.act(async () => result.resolve({ ok: true, text: "First owner's words." }));
    expect(first.state.session.draft).toBe("First owner's words.");
    expect(second.state.session.draft).toBe("");
  });

  test("a late receipt on a replaced port cannot remove the new port's abort handle", async () => {
    const oldResult = deferred<HandsFreeTranscript>();
    const newResult = deferred<HandsFreeTranscript>();
    const old = makePort();
    const next = makePort({ grant: { ...GRANT, generation: 2 } });
    let newSignal: AbortSignal | undefined;
    old.port.transcribeSegment = () => oldResult.promise;
    next.port.transcribeSegment = (input) => { newSignal = input.signal; return newResult.promise; };
    let api!: HandsFreeSessionApi;
    const receive = (value: HandsFreeSessionApi) => { api = value; };
    const mounted = testing.render(React.createElement(SessionProbe, { port: old.port, receive }));
    await testing.act(async () => api.start());
    await testing.act(async () => old.emitSegment(1));
    expect(api.state.transport.slots.stt?.operationId).toBe(1);
    await testing.act(async () => mounted.rerender(React.createElement(SessionProbe, { port: next.port, receive })));
    await testing.act(async () => api.start());
    await testing.act(async () => next.emitSegment(1));
    expect(api.state.transport.slots.stt?.operationId).toBe(1);
    await testing.act(async () => oldResult.resolve({ ok: true, text: "Old words." }));
    expect(api.state.transport.slots.stt?.operationId).toBe(1);
    expect(api.state.session.draft).toBe("");
    await testing.act(async () => api.stop());
    expect(newSignal?.aborted).toBe(true);
    await testing.act(async () => newResult.resolve({ ok: false, reason: "New failure." }));
    expect(api.state.lastReceipt?.finalChunkFailure).toBe("New failure.");
    let oldView!: HandsFreeSessionApi;
    testing.render(React.createElement(SessionProbe, { port: old.port, receive: (value) => { oldView = value; } }));
    expect(oldView.state.transport.receipts[0]?.finalChunkOutcome).toBe("success");
    expect(oldView.state.transport.receipts[0]?.unknownChunks).toBe(1);
  });

  test("an old queued effect cannot cancel an equal operation ID on a different port", async () => {
    const oldClose = deferred<HandsFreeHostOutcome>();
    const newClose = deferred<HandsFreeHostOutcome>();
    const old = makePort({ stopCapture: () => oldClose.promise });
    const next = makePort({ stopCapture: () => newClose.promise });
    let oldApi!: HandsFreeSessionApi;
    let newApi!: HandsFreeSessionApi;
    const receive = (value: HandsFreeSessionApi) => { oldApi = value; };
    const mounted = testing.render(React.createElement(SessionProbe, { port: old.port, receive }));
    await testing.act(async () => oldApi.start());
    await testing.act(async () => old.emitSegment(1));
    expect(oldApi.state.transport.slots.stt?.chunks[0]?.state).toBe("queued");
    await testing.act(async () => mounted.rerender(React.createElement(SessionProbe, { port: next.port, receive })));
    testing.render(React.createElement(SessionProbe, { port: next.port, receive: (value) => { newApi = value; } }));
    await testing.act(async () => newApi.start());
    await testing.act(async () => next.emitSegment(1));
    expect(newApi.state.transport.slots.stt?.operationId).toBe(1);
    expect(newApi.state.transport.slots.stt?.chunks[0]?.state).toBe("queued");
    await testing.act(async () => oldClose.resolve({ ok: true }));
    expect(newApi.state.transport.slots.stt?.chunks[0]?.state).toBe("queued");
    await testing.act(async () => newClose.resolve({ ok: true }));
    expect(next.transcribeSegment).toHaveBeenCalledTimes(1);
    expect(newApi.state.session.draft).toBe("The gate was open.");
  });

  test.each(["capture", "stt"] as const)("host refusal at the actual %s boundary sends nothing", async (kind) => {
    const fake = makePort();
    const guard = fake.port.admit;
    fake.port.admit = (input, start) => input.kind === kind ? { admitted: false } : guard(input, start);
    let api!: HandsFreeSessionApi;
    testing.render(React.createElement(SessionProbe, { port: fake.port, receive: (value) => { api = value; } }));
    await testing.act(async () => api.start());
    if (kind === "capture") {
      expect(fake.startCapture).not.toHaveBeenCalled();
      expect(fake.stopCapture).not.toHaveBeenCalled();
    } else {
      await testing.act(async () => fake.emitSegment(1));
      expect(fake.transcribeSegment).not.toHaveBeenCalled();
      expect(api.state.lastReceipt).toMatchObject({ unsentChunks: 1, unknownChunks: 0 });
    }
  });

  test.each([...FACT_LOSSES, ["lock", { unlocked: false }] as [string, Partial<HandsFreeSnapshot>]])(
    "silent %s loss closes the owned synthetic capture", async (_label, loss) => {
      let recording = false;
      const fake = makePort({ startCapture: async () => { recording = true; return { ok: true }; },
        stopCapture: async () => { recording = false; return { ok: true }; },
        onFactChange: () => { recording = false; } });
      const b = lifetimeBar(fake);
      await beginSession(b.view);
      expect(recording).toBe(true);
      await testing.act(async () => fake.change(loss));
      expect(recording).toBe(false);
      expect(fake.stopCapture).toHaveBeenCalledTimes(1);
      expect(status(b.view)).not.toContain("Listening");
    });

  test("expiry ends silent capture without an author action", async () => {
    let recording = false;
    const fake = makePort({ grant: { ...GRANT, expiresAt: Date.now() + 80 },
      startCapture: async () => { recording = true; return { ok: true }; },
      stopCapture: async () => { recording = false; return { ok: true }; } });
    fake.port.now = () => Date.now();
    const b = lifetimeBar(fake);
    await beginSession(b.view);
    expect(recording).toBe(true);
    await testing.waitFor(() => expect(recording).toBe(false));
    expect(fake.stopCapture).toHaveBeenCalledTimes(1);
    expect(status(b.view)).not.toContain("Listening");
  });

  test("a synthetic host expires its own capture without a mounted renderer", async () => {
    let recording = false;
    const expiresAt = Date.now() + 80;
    const fake = makePort({ grant: { ...GRANT, expiresAt },
      startCapture: async () => { recording = true; return { ok: true }; },
      onFactChange: () => { recording = false; } });
    fake.port.now = () => Date.now();
    const timeout = setTimeout(() => fake.change({ grant: null }), Math.max(0, expiresAt - Date.now()));
    const admission = fake.port.admit({ revision: fake.facts().hostRevision, scope: { ...TARGET, mode: "discuss" },
      kind: "capture" }, () => fake.port.startCapture({ sessionId: GRANT.sessionId, generation: GRANT.generation }));
    expect(admission.admitted).toBe(true);
    if (admission.admitted) await admission.value;
    expect(recording).toBe(true);
    await testing.waitFor(() => expect(recording).toBe(false));
    clearTimeout(timeout);
    expect(fake.facts().hostRevision).toBe(2);
    expect(fake.stopCapture).not.toHaveBeenCalled();
  });

  test("a notified loss during acquisition is independently closed and joined", async () => {
    const pending = deferred<void>();
    let revoked = false;
    let recording = false;
    let closedBeforeController = false;
    const fake = makePort({ startCapture: async () => {
      await pending.promise;
      recording = true;
      if (revoked) { recording = false; closedBeforeController = true; }
      return { ok: true };
    }, stopCapture: async () => ({ ok: !recording }), onFactChange: () => { revoked = true; recording = false; } });
    const b = lifetimeBar(fake);
    await testing.waitFor(() => expect((b.view.getByTestId("hands-free-start") as HTMLButtonElement).disabled).toBe(false));
    await testing.act(async () => testing.fireEvent.click(b.view.getByTestId("hands-free-start")));
    await testing.act(async () => fake.change({ visible: false }));
    expect(status(b.view)).toContain("Stopping");
    await testing.act(async () => pending.resolve());
    expect(closedBeforeController).toBe(true);
    expect(recording).toBe(false);
    expect(fake.stopCapture).toHaveBeenCalledTimes(1);
    expect(status(b.view)).not.toContain("Listening");
  });

  for (const [label, loss] of FACT_LOSSES) for (const stage of ["start-facts", "capture-facts", "acquisition",
    "post-open-facts", "stt-facts", "stt-result", "receipt-facts"] as const) {
    test(`ABA ${label} during ${stage} revokes the original lifetime`, async () => {
      const fake = makePort();
      const old = fake.facts();
      const heldFacts = deferred<HandsFreeSnapshot | null>();
      const heldCapture = deferred<HandsFreeHostOutcome>();
      const heldStt = deferred<HandsFreeTranscript>();
      let reads = 0;
      let api!: HandsFreeSessionApi;
      testing.render(React.createElement(SessionProbe, { port: fake.port, receive: (next) => { api = next; } }));
      await testing.waitFor(() => expect(api.state.availability.ready).toBe(true));
      if (stage === "start-facts" || stage === "capture-facts" || stage === "post-open-facts") {
        const heldRead = stage === "start-facts" ? 1 : stage === "capture-facts" ? 2 : 3;
        fake.port.snapshot = async () => ++reads === heldRead ? heldFacts.promise : fake.facts();
      }
      if (stage === "acquisition") fake.port.startCapture = mock(() => heldCapture.promise);
      if (stage === "stt-result" || stage === "receipt-facts") fake.port.transcribeSegment = mock(() => heldStt.promise);
      await testing.act(async () => api.start());
      if (stage === "stt-facts" || stage === "stt-result" || stage === "receipt-facts") {
        expect(api.phase).toBe("recording");
        if (stage === "stt-facts") fake.port.snapshot = async () => ++reads === 2 ? heldFacts.promise : fake.facts();
        await testing.act(async () => fake.emitSegment(1));
        if (stage === "receipt-facts") {
          fake.port.snapshot = () => heldFacts.promise;
          await testing.act(async () => heldStt.resolve({ ok: true, text: "Revoked words." }));
        }
      }
      await testing.act(async () => { fake.change(loss); fake.change(old); });
      await testing.act(async () => {
        heldFacts.resolve(old);
        heldCapture.resolve({ ok: true });
        heldStt.resolve({ ok: true, text: "Revoked words." });
      });
      expect(api.state.session.active).toBe(false);
      expect(api.state.session.draft).toBe("");
      if (stage === "start-facts" || stage === "capture-facts") expect(fake.startCapture).not.toHaveBeenCalled();
      if (stage === "stt-facts") expect(fake.transcribeSegment).not.toHaveBeenCalled();
      if (stage === "stt-result" || stage === "receipt-facts") expect(api.state.lastReceipt?.unknownChunks).toBe(1);
    });
  }

  test("a stale snapshot and delayed notification cannot authorize an old Start", async () => {
    const fake = makePort();
    const old = fake.facts();
    const pending = deferred<HandsFreeSnapshot | null>();
    let api!: HandsFreeSessionApi;
    testing.render(React.createElement(SessionProbe, { port: fake.port, receive: (next) => { api = next; } }));
    await testing.waitFor(() => expect(api.state.availability.ready).toBe(true));
    fake.port.snapshot = () => pending.promise;
    await testing.act(async () => api.start());
    await testing.act(async () => { fake.change({ grant: null }, false); pending.resolve(old); });
    expect(fake.startCapture).not.toHaveBeenCalled();
    expect(api.state.session.active).toBe(false);
    await testing.act(async () => fake.notify(fake.facts().hostRevision));
    expect(fake.startCapture).not.toHaveBeenCalled();
  });

  test.each(["result", "receipt-facts"] as const)(
    "a delayed host notification cannot admit an old transcript during %s", async (stage) => {
      const fake = makePort();
      const old = fake.facts();
      const result = deferred<HandsFreeTranscript>();
      const facts = deferred<HandsFreeSnapshot | null>();
      fake.port.transcribeSegment = () => result.promise;
      let api!: HandsFreeSessionApi;
      testing.render(React.createElement(SessionProbe, { port: fake.port, receive: (value) => { api = value; } }));
      await testing.act(async () => api.start());
      await testing.act(async () => fake.emitSegment(1));
      expect(api.state.transport.slots.stt?.chunks[0]?.state).toBe("dispatched");
      if (stage === "receipt-facts") {
        fake.port.snapshot = () => facts.promise;
        await testing.act(async () => result.resolve({ ok: true, text: "Revoked words." }));
      }
      await testing.act(async () => {
        fake.change({ grant: null }, false);
        fake.change(old, false);
        result.resolve({ ok: true, text: "Revoked words." });
        facts.resolve(old);
      });
      expect(api.state.session.active).toBe(false);
      expect(api.state.session.draft).toBe("");
      expect(api.state.lastReceipt).toMatchObject({ finalChunkOutcome: "success", unknownChunks: 1 });
      await testing.act(async () => fake.notify(fake.facts().hostRevision));
      expect(api.state.session.draft).toBe("");
    });

  test("an old STT receipt does not revoke a newer session on the same port", async () => {
    const fake = makePort();
    const result = deferred<HandsFreeTranscript>();
    fake.port.transcribeSegment = () => result.promise;
    let api!: HandsFreeSessionApi;
    testing.render(React.createElement(SessionProbe, { port: fake.port, receive: (value) => { api = value; } }));
    await testing.act(async () => api.start());
    await testing.act(async () => fake.emitSegment(1));
    await testing.act(async () => api.stop());
    await testing.act(async () => fake.change({ grant: { ...GRANT, generation: 2 } }));
    await testing.act(async () => api.start());
    expect(api.state.session.active).toBe(true);
    await testing.act(async () => result.resolve({ ok: true, text: "Old words." }));
    expect(api.state.session.active).toBe(true);
    expect(api.state.session.draft).toBe("");
    expect(api.state.lastReceipt).toMatchObject({ finalChunkOutcome: "success", unknownChunks: 1 });
  });

  test("a delayed old notification does not revoke a fresh session", async () => {
    const fake = makePort();
    const b = lifetimeBar(fake);
    await beginSession(b.view);
    await testing.act(async () => fake.change({ grant: null }));
    await testing.act(async () => fake.change({ grant: { ...GRANT, generation: 2 } }));
    await beginSession(b.view);
    await testing.act(async () => fake.notify(2));
    expect(status(b.view)).toContain("Listening");
    expect(fake.startCapture).toHaveBeenCalledTimes(2);
  });

  test("a nonqualified adapter cannot activate", async () => {
    const fake = makePort();
    const incomplete = { ...fake.port, qualification: "unqualified" } as unknown as HandsFreePort;
    const { view } = renderBar(incomplete);
    expect((view.getByTestId("hands-free-start") as HTMLButtonElement).disabled).toBe(true);
    expect(fake.startCapture).not.toHaveBeenCalled();
  });

  test("replacing a qualified port with an unsupported one clears ready availability", async () => {
    const fake = makePort();
    const b = lifetimeBar(fake);
    await testing.waitFor(() => expect((b.view.getByTestId("hands-free-start") as HTMLButtonElement).disabled).toBe(false));
    const incomplete = { ...fake.port, qualification: "unqualified" } as unknown as HandsFreePort;
    await testing.act(async () => b.rendered.rerender(React.createElement(HandsFreeBar, { ...b.props, port: incomplete })));
    expect((b.view.getByTestId("hands-free-start") as HTMLButtonElement).disabled).toBe(true);
    expect(status(b.view)).toContain("not connected");
    expect(fake.startCapture).not.toHaveBeenCalled();
  });

  test.each(["throws", "invalid-unsubscribe"] as const)("a %s lifecycle subscription cannot activate", async (failure) => {
    const fake = makePort();
    fake.port.onFactsChanged = failure === "throws" ? () => { throw new Error("No subscription."); }
      : () => undefined as unknown as () => void;
    const { view } = renderBar(fake.port);
    await testing.act(async () => {});
    expect((view.getByTestId("hands-free-start") as HTMLButtonElement).disabled).toBe(true);
    expect(fake.startCapture).not.toHaveBeenCalled();
  });

  test.each(["failure", "rejection"] as const)("partial acquisition %s after Stop is compensated", async (kind) => {
    const pending = deferred<void>();
    let recording = false;
    const fake = makePort({ startCapture: async () => {
      await pending.promise; recording = true;
      if (kind === "rejection") throw new Error("Synthetic partial acquisition");
      return { ok: false, reason: "Synthetic partial acquisition" };
    }, stopCapture: async () => { recording = false; return { ok: true }; } });
    const b = lifetimeBar(fake);
    await testing.waitFor(() => expect((b.view.getByTestId("hands-free-start") as HTMLButtonElement).disabled).toBe(false));
    await testing.act(async () => testing.fireEvent.click(b.view.getByTestId("hands-free-start")));
    await testing.act(async () => testing.fireEvent.click(b.view.getByTestId("hands-free-stop")));
    expect(status(b.view)).toContain("Stopping");
    await testing.act(async () => pending.resolve());
    expect(recording).toBe(false);
    expect(fake.stopCapture).toHaveBeenCalledTimes(1);
    expect(status(b.view)).toBe("Stopped.");
  });

  test.each(["failure", "rejection"] as const)("partial acquisition %s after disposal joins failed cleanup on remount", async (kind) => {
    const pending = deferred<void>();
    let recording = false;
    let closeOk = false;
    const fake = makePort({ startCapture: async () => {
      await pending.promise; recording = true;
      if (kind === "rejection") throw new Error("Partial acquisition.");
      return { ok: false, reason: "Partial acquisition." };
    }, stopCapture: async () => { if (closeOk) recording = false; return { ok: closeOk, reason: "Still open." }; } });
    const first = lifetimeBar(fake);
    await testing.waitFor(() => expect((first.view.getByTestId("hands-free-start") as HTMLButtonElement).disabled).toBe(false));
    await testing.act(async () => testing.fireEvent.click(first.view.getByTestId("hands-free-start")));
    await testing.act(async () => first.rendered.unmount());
    const second = lifetimeBar(fake);
    await testing.waitFor(() => expect((second.view.getByTestId("hands-free-start") as HTMLButtonElement).disabled).toBe(false));
    await testing.act(async () => testing.fireEvent.click(second.view.getByTestId("hands-free-start")));
    expect(fake.startCapture).toHaveBeenCalledTimes(1);
    await testing.act(async () => pending.resolve());
    expect(recording).toBe(true);
    expect(status(second.view)).toContain("Stop was not confirmed");
    closeOk = true;
    await testing.act(async () => testing.fireEvent.click(second.view.getByTestId("hands-free-stop")));
    expect(recording).toBe(false);
    expect(status(second.view)).toBe("Stopped.");
  });

  test("failed compensation remains unconfirmed and blocks replacement until explicit retry", async () => {
    let recording = false;
    let closeOk = false;
    const fake = makePort({ startCapture: async () => { recording = true; return { ok: false }; },
      stopCapture: async () => { if (closeOk) recording = false; return { ok: closeOk, reason: "Still open." }; } });
    const b = lifetimeBar(fake);
    await testing.waitFor(() => expect((b.view.getByTestId("hands-free-start") as HTMLButtonElement).disabled).toBe(false));
    await testing.act(async () => testing.fireEvent.click(b.view.getByTestId("hands-free-start")));
    expect(recording).toBe(true);
    expect(status(b.view)).toContain("Stop was not confirmed");
    expect(fake.stopCapture).toHaveBeenCalledTimes(1);
    closeOk = true;
    await testing.act(async () => testing.fireEvent.click(b.view.getByTestId("hands-free-stop")));
    expect(recording).toBe(false);
    expect(status(b.view)).toBe("Stopped.");
  });

  test("Starting makes no claim of closure after acquisition while verification waits", async () => {
    const fake = makePort();
    const pending = deferred<HandsFreeSnapshot | null>();
    let reads = 0;
    const b = lifetimeBar(fake);
    await testing.waitFor(() => expect((b.view.getByTestId("hands-free-start") as HTMLButtonElement).disabled).toBe(false));
    fake.port.snapshot = async () => ++reads === 3 ? pending.promise : fake.facts();
    await testing.act(async () => testing.fireEvent.click(b.view.getByTestId("hands-free-start")));
    expect(fake.startCapture).toHaveBeenCalledTimes(1);
    expect(status(b.view)).toContain("Capture may be active");
    expect(status(b.view)).not.toContain("Nothing is being recorded");
    await testing.act(async () => pending.resolve(fake.facts()));
  });
});
