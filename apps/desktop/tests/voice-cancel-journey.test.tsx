/// <reference types="bun" />
import { afterAll, beforeAll, beforeEach, afterEach, describe, expect, mock, test } from "bun:test";
import React from "react";
import { mountDom, unmountDom } from "./support/dom";
import { DEFAULT_VOICE_PREFERENCES, type VoicePreferences } from "@ai-book-studio/core/providers/voice-preferences";
import type { ConnectionSummary, StoredCredential } from "@ai-book-studio/core/providers/types";
import type { ProviderService } from "../src/main/providers";
import { hostFor } from "./support/voice-request-host";
import { SpeechService } from "../src/main/speech";
import { chunkForSpeech } from "@ai-book-studio/core/providers/tts";
import type { VoiceOperationView } from "@ai-book-studio/core/ipc";

/*
 * The author-facing journey for a host-owned voice request, start to stop.
 *
 * Everything here is synthetic: a fake microphone, a fake recorder, a fake audio element, an
 * in-memory vault and a fetch that never leaves the process. What is real is the wiring under
 * test: the hooks, the host, the ledger and the receipt line an author would actually read.
 */

let testing!: typeof import("@testing-library/react/pure");
let VoiceButton!: typeof import("@ai-book-studio/app/components/VoiceButton").VoiceButton;
let AmbientPanel!: typeof import("@ai-book-studio/app/components/AmbientPanel").AmbientPanel;

beforeAll(async () => {
  testing = await mountDom();
  ({ VoiceButton } = await import("@ai-book-studio/app/components/VoiceButton"));
  ({ AmbientPanel } = await import("@ai-book-studio/app/components/AmbientPanel"));
});
afterAll(async () => {
  await unmountDom();
});

/* ------------------------------------------------------------------ fakes */

class FakeRecorder {
  static instances: FakeRecorder[] = [];
  state: "inactive" | "recording" = "inactive";
  mimeType = "audio/webm";
  readonly listeners = new Map<string, Array<(event: { data: Blob }) => void>>();

  constructor(readonly stream: unknown, readonly options: { mimeType?: string } = {}) {
    FakeRecorder.instances.push(this);
  }

  static isTypeSupported(type: string): boolean {
    return type === "audio/webm;codecs=opus";
  }

  addEventListener(type: string, handler: (event: { data: Blob }) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), handler]);
  }

  start(): void {
    this.state = "recording";
  }

  stop(): void {
    this.state = "inactive";
    for (const handler of this.listeners.get("stop") ?? []) handler({ data: new Blob() });
  }

  emit(size: number): void {
    this.state = "inactive";
    if (size > 0) {
      for (const handler of this.listeners.get("dataavailable") ?? []) {
        handler({ data: new Blob([new Uint8Array(size)], { type: "audio/webm" }) });
      }
    }
    for (const handler of this.listeners.get("stop") ?? []) handler({ data: new Blob() });
  }
}

function fakeStream() {
  return {
    getTracks: () => [{ kind: "audio", stop: () => {} }]
  };
}

class FakeAudioContext {
  async decodeAudioData(): Promise<{
    numberOfChannels: number;
    length: number;
    sampleRate: number;
    getChannelData: () => Float32Array;
  }> {
    return {
      numberOfChannels: 1,
      length: 4,
      sampleRate: 16_000,
      getChannelData: () => new Float32Array([0.1, 0.2, 0.3, 0.4])
    };
  }

  async close(): Promise<void> {}
}

class FakeAudio {
  static instances: FakeAudio[] = [];
  played = 0;
  onended: (() => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(readonly src: string) {
    FakeAudio.instances.push(this);
  }

  async play(): Promise<void> {
    this.played += 1;
  }

  pause(): void {}
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

const realFetch = globalThis.fetch;
const realMediaRecorder = (globalThis as { MediaRecorder?: unknown }).MediaRecorder;
const realMediaDevices = navigator.mediaDevices;
const realAudio = (globalThis as { Audio?: unknown }).Audio;
const realAudioContext = (globalThis as { AudioContext?: unknown }).AudioContext;

beforeEach(() => {
  FakeRecorder.instances = [];
  FakeAudio.instances = [];
  (globalThis as { MediaRecorder?: unknown }).MediaRecorder = FakeRecorder;
  (globalThis as { AudioContext?: unknown }).AudioContext = FakeAudioContext;
  Object.defineProperty(navigator, "mediaDevices", {
    value: { getUserMedia: async () => fakeStream() },
    configurable: true
  });
});

afterEach(() => {
  testing.cleanup();
  delete (window as { studio?: unknown }).studio;
  (globalThis as { MediaRecorder?: unknown }).MediaRecorder = realMediaRecorder;
  Object.defineProperty(navigator, "mediaDevices", { value: realMediaDevices, configurable: true });
  (globalThis as { Audio?: unknown }).Audio = realAudio;
  (globalThis as { AudioContext?: unknown }).AudioContext = realAudioContext;
  globalThis.fetch = realFetch;
});

/* ------------------------------------------------------- shared stubs */

type OperationListener = (view: VoiceOperationView) => void;

function voiceOperationView(overrides: Partial<VoiceOperationView> = {}): VoiceOperationView {
  return {
    operationId: 1,
    viewRevision: 1,
    kind: "stt",
    phase: "starting",
    status: null,
    cancelled: false,
    connectionLabel: "Meta",
    model: "muse-voice-transcribe-1.0",
    voice: null,
    plannedChunks: 1,
    dispatchedChunks: 0,
    settledChunks: 0,
    unsentChunks: 0,
    charge: { state: "pending" },
    message: null,
    finalChunkOutcome: null,
    ...overrides
  };
}

const SPEAKING_PREFERENCES: VoicePreferences = {
  ...DEFAULT_VOICE_PREFERENCES,
  speaking: { connectionId: "conn_openai01", model: "gpt-4o-mini-tts", voice: "nova" }
};

const OPENAI_CONNECTION: ConnectionSummary = {
  id: "conn_openai01",
  provider: "openai",
  label: "OpenAI",
  kind: "api-key",
  createdAt: "2026-10-26T12:00:00.000Z"
};
const OPENAI_CREDENTIAL: StoredCredential = {
  ...OPENAI_CONNECTION,
  secret: "synthetic-openai-key"
};

const agentStub = {
  ambient: async () => ({
    ok: true as const,
    data: {
      say: "Chapter One. The storm is quieter now.",
      chapterTitle: "Chapter One",
      working: false,
      actions: [{ id: "read_aloud", label: "Read it aloud", spoken: "Read it aloud", available: true, why: "Read the open chapter aloud." }]
    }
  }),
  onEvent: () => () => {},
  start: async () => ({ ok: true as const, data: { turnId: "turn_1", threadId: "thread_1" } }),
  stop: async () => ({ ok: true as const, data: null }),
  undoLast: async () => ({ ok: true as const, data: { restored: 0, skipped: 0 } })
};

function ttsProviderFacts(): ProviderService {
  return {
    list: async () => [OPENAI_CONNECTION],
    credential: async (id: string) => {
      if (id !== OPENAI_CONNECTION.id) throw new Error("no such connection");
      return OPENAI_CREDENTIAL;
    }
  } as unknown as ProviderService;
}

/* -------------------------------------------------- the dictation journey */

describe("the dictation journey", () => {
  test("stop during transcription calls cancel once and keeps the receipt", async () => {
    const listeners: OperationListener[] = [];
    const transcribeGate = deferred<unknown>();
    const cancel = mock(async (input: { operationId: number }) => ({
      ok: true as const,
      data: { operationId: input.operationId, accepted: true, abortedLocally: true, released: false }
    }));
    const texts: string[] = [];
    const errors: string[] = [];
    (window as { studio?: unknown }).studio = {
      voice: {
        settings: async () => ({ ok: true, data: {
          transcription: { connectionId: "conn_meta000001", model: "muse-voice-transcribe-1.0" },
          speaking: { connectionId: null, model: null, voice: null }
        } }),
        connections: async () => ({ ok: true, data: [{ id: "conn_meta000001", provider: "meta" }] }),
        transcribe: mock(() => transcribeGate.promise),
        speak: async () => ({ ok: false, error: { message: "unavailable" } }),
        cancel,
        operation: async () => ({ ok: true, data: null }),
        onOperation: (callback: OperationListener) => {
          listeners.push(callback);
          return () => { listeners.splice(listeners.indexOf(callback), 1); };
        }
      }
    };

    const view = testing.render(
      React.createElement(VoiceButton, {
        onText: (text: string) => texts.push(text),
        onError: (error: Error) => errors.push(error.message)
      })
    );

    await testing.waitFor(() => expect(view.getByRole("button", { name: "Start dictation" })).toBeTruthy());
    await testing.act(async () => {
      await testing.fireEvent.click(view.getByRole("button", { name: "Start dictation" }));
    });
    expect(FakeRecorder.instances).toHaveLength(1);
    await testing.act(async () => {
      FakeRecorder.instances[0]?.emit(8);
    });
    // The host announces the operation; the button becomes a Stop control.
    await testing.act(async () => {
      for (const listener of [...listeners]) {
        listener(voiceOperationView({ operationId: 42, viewRevision: 1, phase: "starting" }));
      }
    });
    const stop = view.getByRole("button", { name: "Stop transcription" });
    await testing.act(async () => {
      await testing.fireEvent.click(stop);
    });
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(cancel).toHaveBeenCalledWith({ operationId: 42 });

    // The host closes the operation; the receipt arrives via the settled event.
    await testing.act(async () => {
      for (const listener of [...listeners]) {
        listener(voiceOperationView({
          operationId: 42,
          viewRevision: 3,
          phase: "settled",
          status: "cancellation",
          cancelled: true,
          dispatchedChunks: 1,
          settledChunks: 1,
          charge: { state: "unknown" }
        }));
      }
    });
    // The reply arrives after the stop. Nothing is inserted.
    await testing.act(async () => {
      transcribeGate.resolve({
        ok: true,
        data: {
          status: "cancellation",
          message: "The transcription request was cancelled.",
          receipt: voiceOperationView({
            operationId: 42,
            viewRevision: 3,
            phase: "settled",
            status: "cancellation",
            cancelled: true,
            dispatchedChunks: 1,
            settledChunks: 1,
            charge: { state: "unknown" }
          })
        }
      });
      await transcribeGate.promise;
    });
    expect(texts).toEqual([]);
    expect(errors).toEqual([]);
    expect(view.getByTestId("voice-receipt").textContent).toBe(
      "Stopped after the request was sent. The local request was aborted, but the provider may still have received it. Whether it cost anything is unknown."
    );
  });

  test("a successful dictation shows the provider-reported cost", async () => {
    const listeners: OperationListener[] = [];
    const texts: string[] = [];
    (window as { studio?: unknown }).studio = {
      voice: {
        settings: async () => ({ ok: true, data: {
          transcription: { connectionId: "conn_meta000001", model: "muse-voice-transcribe-1.0" },
          speaking: { connectionId: null, model: null, voice: null }
        } }),
        connections: async () => ({ ok: true, data: [{ id: "conn_meta000001", provider: "meta" }] }),
        transcribe: mock(async () => ({
          ok: true,
          data: {
            status: "success",
            transcript: { text: "The lighthouse keeper counted the ships.", provider: "meta", connectionLabel: "Meta", model: "muse-voice-transcribe-1.0", durationMs: 1500, costUsd: 0.5, turns: [] },
            receipt: voiceOperationView({
              operationId: 43,
              viewRevision: 3,
              phase: "settled",
              status: "success",
              dispatchedChunks: 1,
              settledChunks: 1,
              charge: { state: "reported", usd: 0.5 }
            })
          }
        })),
        speak: async () => ({ ok: false, error: { message: "unavailable" } }),
        cancel: mock(async () => ({ ok: true, data: { operationId: 43, accepted: false, abortedLocally: false, released: false } })),
        operation: async () => ({ ok: true, data: null }),
        onOperation: (callback: OperationListener) => {
          listeners.push(callback);
          return () => { listeners.splice(listeners.indexOf(callback), 1); };
        }
      }
    };
    const view = testing.render(
      React.createElement(VoiceButton, {
        onText: (text: string) => texts.push(text),
        onError: () => {}
      })
    );
    await testing.waitFor(() => expect(view.getByLabelText("Start dictation")).toBeTruthy());
    await testing.act(async () => {
      await testing.fireEvent.click(view.getByRole("button", { name: "Start dictation" }));
    });
    await testing.act(async () => {
      FakeRecorder.instances[0]?.emit(8);
    });
    await testing.waitFor(() => expect(texts).toEqual(["The lighthouse keeper counted the ships."]));
    expect(view.getByTestId("voice-receipt").textContent).toBe("Provider-reported cost: $0.500.");
  });
});

/* ----------------------------------------------------- the speaking journey */

describe("the speaking journey", () => {
  test("a voice change between chunks refuses the rest, plays nothing and keeps the unsent count honest", async () => {
    // Wire the real host, authority and speech service into the panel through the studio bridge.
    const emitted: VoiceOperationView[] = [];
    const preferences: VoicePreferences = {
      ...SPEAKING_PREFERENCES,
      speaking: { ...SPEAKING_PREFERENCES.speaking }
    };
    const providers = ttsProviderFacts();
    const fixture = hostFor(providers, preferences, (_owner, view) => {
      emitted.push(view);
      for (const listener of [...panelListeners]) listener(view);
    });
    const panelListeners: OperationListener[] = [];
    let fetchCalls = 0;
    const chapter = "The storm came in low and the lamp would not turn. ".repeat(150);
    const chunkCount = chunkForSpeech(chapter).length;
    expect(chunkCount).toBeGreaterThanOrEqual(2);
    const tts = new SpeechService(
      providers,
      (async () => {
        fetchCalls += 1;
        // The author re-saves the speaking voice while the first chunk is in flight.
        preferences.speaking = { ...preferences.speaking, voice: "onyx" };
        fixture.routes.bump();
        return new Response(new Uint8Array([7, 7]), {
          status: 200,
          headers: { "content-type": "audio/mpeg" }
        });
      }) as unknown as typeof fetch
    );

    (window as { studio?: unknown }).studio = {
      agent: agentStub,
      voice: {
        settings: async () => ({ ok: true, data: {
          transcription: { connectionId: null, model: null },
          speaking: preferences.speaking
        } }),
        connections: async () => ({ ok: true, data: [] }),
        transcribe: async () => ({ ok: true, data: { status: "refusal", message: "unused", receipt: null } }),
        speakers: async () => ({ ok: true, data: {
          available: true,
          selected: true,
          connectionId: "conn_openai01",
          connectionLabel: "OpenAI",
          model: "gpt-4o-mini-tts",
          voice: "nova",
          voices: ["nova", "onyx"]
        } }),
        speak: async (input: { text: string }) => {
          const planned = chunkForSpeech(input.text).length;
          const reservation = fixture.host.reserve("tts", planned, 1);
          if (!reservation) return { ok: true, data: { status: "refusal", message: "busy", receipt: null } };
          const begun = await fixture.host.begin(reservation);
          if (!begun.ok) return { ok: true, data: { status: begun.status, message: begun.message, receipt: begun.receipt } };
          const outcome = await tts.speak({ text: input.text }, begun.scope);
          if (outcome.receipt) fixture.host.emitSettled(1, outcome.receipt);
          return { ok: true, data: outcome };
        },
        cancel: async (input: { operationId: number }) => ({ ok: true, data: { operationId: input.operationId, accepted: false, abortedLocally: false, released: false } }),
        operation: async (input: { operationId: number }) => ({ ok: true, data: fixture.host.operation(1, input.operationId) }),
        onOperation: (callback: OperationListener) => {
          panelListeners.push(callback);
          return () => { panelListeners.splice(panelListeners.indexOf(callback), 1); };
        }
      }
    };
    (globalThis as { Audio?: unknown }).Audio = FakeAudio;
    (window as { Audio?: unknown }).Audio = FakeAudio;

    const view = testing.render(
      React.createElement(AmbientPanel, {
        bookId: "book_000001",
        chapterId: "chapter_0001",
        chapterTitle: "The Light",
        chapterContent: chapter,
        onNextChapter: () => {},
        onNotice: () => {}
      })
    );
    await testing.waitFor(() => expect(view.getByTestId("ambient-line").textContent).toContain("Chapter One"));
    await testing.fireEvent.click(view.getByTestId("ambient-toggle"));
    await testing.act(async () => {
      await testing.fireEvent.click(view.getByTestId("ambient-action-read_aloud"));
    });

    // The refusal settled before the second chunk was dispatched.
    await testing.waitFor(() => expect(fetchCalls).toBe(1));
    expect(FakeAudio.instances).toHaveLength(0);
    await testing.waitFor(() => expect(view.getByTestId("ambient-voice-receipt").textContent).toContain("The parts already made were not played."));
    expect(view.getByTestId("ambient-voice-receipt").textContent).toContain("1 requests were not sent.");
    expect(emitted.some((event) => event.phase === "settled" && event.status === "refusal")).toBe(true);
  });
});
