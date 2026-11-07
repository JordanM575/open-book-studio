/// <reference types="bun" />
import { afterAll, beforeAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import React from "react";
import { mountDom, unmountDom } from "./support/dom";
import type { AmbientStatus } from "@ai-book-studio/core/agent/ambient";
import type { Result, VoiceSpeakers } from "@ai-book-studio/core/ipc";

/**
 * The minimal mode, end to end through its own component.
 *
 * This is the hands-free loop the whole ambient design exists for: speak, hear what was heard,
 * watch the agent work, hear that it is done. The pieces are tested on their own elsewhere; what
 * this file checks is that they are wired to each other — that a transcript reaches the agent, that
 * the agent's answer is spoken only when the turn came from the microphone, and that a keyboard is
 * never required.
 */

let testing!: typeof import("@testing-library/react/pure");
let AmbientPanel!: typeof import("@ai-book-studio/app/components/AmbientPanel").AmbientPanel;

/** The globals this file replaces, so the next file finds the ones this file found. */
const realGlobals = {
  MediaRecorder: (globalThis as { MediaRecorder?: unknown }).MediaRecorder,
  AudioContext: (globalThis as { AudioContext?: unknown }).AudioContext,
  SpeechSynthesisUtterance: (globalThis as { SpeechSynthesisUtterance?: unknown }).SpeechSynthesisUtterance
};

beforeAll(async () => {
  testing = await mountDom();
  ({ AmbientPanel } = await import("@ai-book-studio/app/components/AmbientPanel"));
});
afterAll(async () => {
  await unmountDom();
});



const BOOK = "book_amb000001";

const status: AmbientStatus = {
  book: { id: BOOK, title: "The Salt Road", stage: "drafting" },
  chapter: { id: "ch_amb00000001", title: "The Light", order: 1, wordCount: 5 },
  progress: { chapters: 1, words: 5, lastOrder: 1 },
  lastChange: null,
  lastSaid: null,
  working: false,
  actions: [
    { id: "read_aloud", label: "Read it aloud", spoken: "read it aloud", available: true },
    { id: "where_am_i", label: "Where am I", spoken: "where am I", available: true },
    { id: "keep_going", label: "Keep going", spoken: "keep going", available: true }
  ],
  say: "You're in Chapter One, The Light, of The Salt Road. 5 words so far."
};

/** A recorder the test can drive, because the microphone is not available here. */
class FakeRecorder {
  static instances: FakeRecorder[] = [];
  state: "inactive" | "recording" = "inactive";
  mimeType = "audio/webm";
  readonly listeners = new Map<string, Array<(event: { data: Blob }) => void>>();

  constructor(readonly stream: unknown) {
    FakeRecorder.instances.push(this);
  }

  static isTypeSupported(): boolean {
    return true;
  }

  addEventListener(type: string, handler: (event: { data: Blob }) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), handler]);
  }

  start(): void {
    this.state = "recording";
  }

  stop(): void {
    this.state = "inactive";
    this.emit();
  }

  /** Finish the recording with a chunk, the way the browser would. */
  emit(): void {
    for (const handler of this.listeners.get("dataavailable") ?? []) {
      handler({ data: new Blob([new Uint8Array([1, 2, 3])]) });
    }
    for (const handler of this.listeners.get("stop") ?? []) handler({ data: new Blob() });
  }
}

class FakeAudioContext {
  async decodeAudioData(): Promise<unknown> {
    return {
      numberOfChannels: 1,
      length: 2,
      sampleRate: 16_000,
      getChannelData: () => new Float32Array([0.1, 0.2])
    };
  }
  async close(): Promise<void> {}
}

/**
 * What was said out loud.
 *
 * Most tests select no service and record the utterances spoken by the device. A selected service
 * never falls back to the device after a refusal or when the selection becomes unavailable.
 */
let spoken: string[] = [];
let started: Array<{ bookId: string; mode: string; prompt: string }> = [];
let transcript = "carry on with the next scene";
let transcribeFails = false;
let listeners: Array<(event: { turnId: string; type: string; delta?: string; message?: string }) => void> = [];
let turnId = "turn_amb000001";
let voiceSpoken: string[] = [];
let speakersAvailable = false;
let speakersSelected = false;
let startRefusal: string | null = null;
let speakFails = false;
/** When false, utterances stay open until a test ends them, which makes pausing observable. */
let utteranceAutoEnd = true;
let pendingEnds: Array<() => void> = [];
let pendingErrors: Array<() => void> = [];
let synthesisPauseCalls = 0;
let synthesisResumeCalls = 0;
/** The voice the room had before a test replaced it with the fake service reply. */
let nativeAudio: unknown;
let audioOverridden = false;

/** The voice service's reply, recorded rather than played. */
class FakeAudio {
  static instances: FakeAudio[] = [];
  static nextInitialPlay: Promise<void> | null = null;
  onended: (() => void) | null = null;
  onerror: (() => void) | null = null;
  playedCount = 0;
  pausedCount = 0;
  playResults: Array<Promise<void>> = [];

  constructor(readonly src: string) {
    FakeAudio.instances.push(this);
    if (FakeAudio.nextInitialPlay) {
      this.playResults.push(FakeAudio.nextInitialPlay);
      FakeAudio.nextInitialPlay = null;
    }
  }

  async play(): Promise<void> {
    this.playedCount += 1;
    return this.playResults.shift();
  }

  pause(): void {
    this.pausedCount += 1;
  }

  /** Finish the audio, the way the element would. */
  end(): void {
    this.onended?.();
  }

  fail(): void {
    this.onerror?.();
  }
}

function deferredPlay() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((accept, refuse) => { resolve = accept; reject = refuse; });
  return { promise, resolve, reject };
}

function studio() {
  return {
    agent: {
      ambient: async () => ({ ok: true, data: status }),
      start: async (input: { bookId: string; mode: string; prompt: string }) => {
        started.push(input);
        if (startRefusal) return { ok: false, error: { code: "invalid", message: startRefusal } };
        return { ok: true, data: { turnId, threadId: "thread_amb000001", text: "", changed: 0 } };
      },
      stop: async () => ({ ok: true, data: null }),
      undoLast: async () => ({ ok: true, data: { restored: 0, skipped: 0 } }),
      onEvent: (handler: (event: unknown) => void) => {
        listeners.push(handler as never);
        return () => {
          listeners = listeners.filter((entry) => entry !== handler);
        };
      }
    },
    voice: {
      settings: async () => ({ ok: true, data: {
        transcription: { connectionId: "conn_meta000001", model: "muse-voice-transcribe-1.0" },
        speaking: { connectionId: null, model: null, voice: null }
      } }),
      connections: async () => ({ ok: true, data: [{ id: "conn_meta000001", provider: "meta" }] }),
      transcribe: async () => {
        if (transcribeFails) return { ok: false, error: { code: "invalid", message: "The key was rejected." } };
        return { ok: true, data: { text: transcript } };
      },
      // No speaking connection unless a test asks for one, which is what most authors have on day one.
      speakers: async () => ({ ok: true, data: {
        available: speakersAvailable,
        selected: speakersSelected || speakersAvailable,
        unavailable: speakersSelected && !speakersAvailable,
        connectionLabel: null,
        model: null,
        voices: speakersAvailable ? ["alloy"] : []
      } }),
      speak: async (input: { text: string }) => {
        voiceSpoken.push(input.text);
        if (speakFails) return { ok: false, error: { code: "invalid", message: "The voice was rejected." } };
        return { ok: true, data: { dataUrl: "data:audio/mpeg;base64," } };
      }
    }
  };
}

beforeEach(() => {
  spoken = [];
  started = [];
  listeners = [];
  transcript = "carry on with the next scene";
  transcribeFails = false;
  voiceSpoken = [];
  speakersAvailable = false;
  speakersSelected = false;
  startRefusal = null;
  speakFails = false;
  utteranceAutoEnd = true;
  pendingEnds = [];
  pendingErrors = [];
  synthesisPauseCalls = 0;
  synthesisResumeCalls = 0;
  FakeAudio.instances = [];
  FakeAudio.nextInitialPlay = null;
  FakeRecorder.instances = [];
  (window as unknown as { studio: unknown }).studio = studio();
  (globalThis as { MediaRecorder?: unknown }).MediaRecorder = FakeRecorder;
  // The device's own voice, recorded rather than played. It ends each utterance at once
  // unless a test holds the ending back, which is what makes pausing observable.
  (globalThis as { SpeechSynthesisUtterance?: unknown }).SpeechSynthesisUtterance = class {
    lang = "en-US";
    onend: (() => void) | null = null;
    onerror: (() => void) | null = null;
    constructor(readonly text: string) {}
  };
  Object.defineProperty(window, "speechSynthesis", {
    value: {
      speak: (utterance: { text: string; onend?: (() => void) | null; onerror?: (() => void) | null }) => {
        spoken.push(utterance.text);
        if (utteranceAutoEnd) utterance.onend?.();
        else {
          pendingEnds.push(() => utterance.onend?.());
          pendingErrors.push(() => utterance.onerror?.());
        }
      },
      cancel: () => {},
      pause: () => {
        synthesisPauseCalls += 1;
      },
      resume: () => {
        synthesisResumeCalls += 1;
      }
    },
    configurable: true
  });
  (globalThis as { AudioContext?: unknown }).AudioContext = FakeAudioContext;
  Object.defineProperty(navigator, "mediaDevices", {
    value: {
      getUserMedia: async () => ({ getTracks: () => [{ stop: () => {} }] })
    },
    configurable: true
  });
});

afterEach(() => {
  testing.cleanup();
  delete (window as { studio?: unknown }).studio;
  Object.assign(globalThis, realGlobals);
  // Only the test that replaced the room's voice puts it back; the other globals are restored
  // by value above, but the voice is saved at replacement time because it arrives after import.
  if (audioOverridden) {
    (globalThis as { Audio?: unknown }).Audio = nativeAudio;
    if ((window as { Audio?: unknown }).Audio === (FakeAudio as unknown))
      (window as { Audio?: unknown }).Audio = nativeAudio;
    audioOverridden = false;
  }
});

function render(voiceStatusRevision = 0) {
  const onNotice = mock(() => {});
  const props = {
    bookId: BOOK,
    chapterId: null,
    chapterTitle: "The Light",
    chapterContent: "The storm came in low.",
    onNextChapter: () => {},
    onNotice
  };
  const view = testing.render(React.createElement(AmbientPanel, { ...props, voiceStatusRevision }));
  const reviseVoiceStatus = (revision: number) =>
    view.rerender(React.createElement(AmbientPanel, { ...props, voiceStatusRevision: revision }));
  return { view, onNotice, reviseVoiceStatus };
}

function installFakeAudio() {
  nativeAudio = (globalThis as { Audio?: unknown }).Audio;
  (globalThis as { Audio?: unknown }).Audio = FakeAudio;
  (window as { Audio?: unknown }).Audio = FakeAudio;
  audioOverridden = true;
}

async function openProviderRead() {
  speakersAvailable = true;
  installFakeAudio();
  const { view } = render();
  await testing.waitFor(() => expect(view.getByTestId("ambient-line").textContent).toContain("Chapter One"));
  await testing.fireEvent.click(view.getByTestId("ambient-toggle"));
  await testing.act(async () => { await testing.fireEvent.click(view.getByTestId("ambient-action-read_aloud")); });
  await testing.waitFor(() => expect(FakeAudio.instances).toHaveLength(1));
  await testing.waitFor(() => expect(view.getByTestId("ambient-pause").getAttribute("aria-label")).toBe("Pause reading"));
  return { view, reply: FakeAudio.instances[0] as FakeAudio };
}

describe("the status line", () => {
  test("says where the author is, in the studio's own words", async () => {
    const { view } = render();
    // The strip starts with a placeholder, because the status is a round trip.
    expect(view.getByTestId("ambient-line").textContent).toBe("Looking at your book…");
    await testing.waitFor(() =>
      expect(view.getByTestId("ambient-line").textContent).toContain("You're in Chapter One")
    );
  });

  test("asks about the chapter on screen, and asks again when the author switches chapters", async () => {
    const asked: Array<string | null | undefined> = [];
    (window as unknown as { studio: { agent: { ambient: unknown } } }).studio.agent.ambient = async (
      _bookId: string,
      chapterId?: string | null
    ) => {
      asked.push(chapterId);
      return { ok: true, data: status };
    };
    const props = {
      bookId: BOOK,
      chapterTitle: "The Light",
      chapterContent: "The storm came in low.",
      onNextChapter: () => {},
      onNotice: () => {}
    };
    const view = testing.render(React.createElement(AmbientPanel, { ...props, chapterId: "ch_amb000001" }));
    await testing.waitFor(() => expect(asked).toEqual(["ch_amb000001"]));
    view.rerender(React.createElement(AmbientPanel, { ...props, chapterId: "ch_amb000002", chapterTitle: "The Door" }));
    await testing.waitFor(() => expect(asked).toEqual(["ch_amb000001", "ch_amb000002"]));
  });

  test("a turn from the chat brings the line up to date, and where-am-I speaks the fresh line", async () => {
    let calls = 0;
    const later = { ...status, say: "You're in Chapter One, The Light, of The Salt Road. 9 words so far." };
    (window as unknown as { studio: { agent: { ambient: unknown } } }).studio.agent.ambient = async () => {
      calls += 1;
      return { ok: true, data: calls === 1 ? status : later };
    };
    const { view } = render();
    await testing.waitFor(() => expect(calls).toBe(1));
    // A turn the strip did not start, such as one from the chat panel, finishes.
    await testing.act(async () => {
      for (const listener of listeners) listener({ type: "done", turnId: "turn_chat000001" });
    });
    await testing.waitFor(() => expect(calls).toBe(2));
    await testing.fireEvent.click(view.getByTestId("ambient-toggle"));
    await testing.act(async () => {
      testing.fireEvent.click(view.getByTestId("ambient-action-where_am_i"));
    });
    await testing.waitFor(() => expect(spoken.at(-1)).toBe(later.say));
  });

  test("offers the actions the status offers, and only the ones available", async () => {
    const { view } = render();
    await testing.waitFor(() =>
      expect(view.getByTestId("ambient-line").textContent).toContain("Chapter One")
    );
    await testing.fireEvent.click(view.getByTestId("ambient-toggle"));
    expect(view.getByTestId("ambient-action-read_aloud")).toBeDefined();
    expect(view.getByTestId("ambient-action-where_am_i")).toBeDefined();
  });

  test("an undo that leaves a chapter changed since says so", async () => {
    const agent = (window as unknown as { studio: ReturnType<typeof studio> }).studio.agent;
    agent.ambient = async () => ({
      ok: true,
      data: { ...status, actions: [...status.actions, { id: "undo", label: "Undo", spoken: "undo", available: true }] }
    });
    const asked: unknown[][] = [];
    agent.undoLast = async (...args: unknown[]) => {
      asked.push(args);
      return { ok: true, data: { restored: 1, skipped: 1 } };
    };
    const { view } = render();
    await testing.waitFor(() =>
      expect(view.getByTestId("ambient-line").textContent).toContain("Chapter One")
    );
    await testing.fireEvent.click(view.getByTestId("ambient-toggle"));

    await testing.act(async () => {
      await testing.fireEvent.click(view.getByTestId("ambient-action-undo"));
    });
    await testing.waitFor(() =>
      expect(view.getByTestId("ambient-note").textContent).toBe(
        "Restored 1 chapter, but skipped 1. Review the remaining changes."
      )
    );
    // The strip undoes the book's newest turn on purpose, so it names none.
    expect(asked).toEqual([[BOOK]]);
  });
});

describe("the hands-free loop", () => {
  test("a spoken sentence reaches the agent, and what was heard is shown", async () => {
    const { view } = render();
    await testing.waitFor(() =>
      expect(view.getByTestId("ambient-line").textContent).toContain("Chapter One")
    );
    await testing.fireEvent.click(view.getByTestId("ambient-toggle"));

    await testing.act(async () => {
      await testing.fireEvent.click(view.getByTestId("ambient-mic"));
    });
    await testing.act(async () => {
      FakeRecorder.instances.at(-1)?.stop();
    });

    await testing.waitFor(() => expect(started).toEqual([{ bookId: BOOK, mode: "edit", prompt: transcript }]));
    await testing.waitFor(() => expect(view.getByTestId("ambient-heard").textContent).toContain(transcript));
  });

  test("the microphone is a button, not a keyboard, and says whether it is live", async () => {
    const { view } = render();
    await testing.waitFor(() =>
      expect(view.getByTestId("ambient-line").textContent).toContain("Chapter One")
    );
    await testing.fireEvent.click(view.getByTestId("ambient-toggle"));

    const mic = view.getByTestId("ambient-mic");
    expect(mic.getAttribute("aria-label")).toBe("Speak to the agent");
    expect(mic.getAttribute("aria-pressed")).toBe("false");

    await testing.act(async () => {
      await testing.fireEvent.click(mic);
    });
    expect(view.getByTestId("ambient-mic").getAttribute("aria-pressed")).toBe("true");
    expect(view.getByTestId("ambient-dictation").textContent).toContain("Listening");
  });

  test("the answer to a spoken request is spoken back", async () => {
    const { view } = render();
    await testing.waitFor(() =>
      expect(view.getByTestId("ambient-line").textContent).toContain("Chapter One")
    );
    await testing.fireEvent.click(view.getByTestId("ambient-toggle"));

    await testing.act(async () => {
      await testing.fireEvent.click(view.getByTestId("ambient-mic"));
    });
    await testing.act(async () => {
      FakeRecorder.instances.at(-1)?.stop();
    });
    await testing.waitFor(() => expect(started).toHaveLength(1));

    await testing.act(async () => {
      for (const listener of listeners) listener({ turnId, type: "text", delta: "The storm is quieter now." });
      for (const listener of listeners) listener({ turnId, type: "done" });
    });
    await testing.waitFor(() => expect(spoken).toEqual(["The storm is quieter now."]));
  });

  test("the answer is spoken as words, without its markup", async () => {
    const { view } = render();
    await testing.waitFor(() =>
      expect(view.getByTestId("ambient-line").textContent).toContain("Chapter One")
    );
    await testing.fireEvent.click(view.getByTestId("ambient-toggle"));

    await testing.act(async () => {
      await testing.fireEvent.click(view.getByTestId("ambient-mic"));
    });
    await testing.act(async () => {
      FakeRecorder.instances.at(-1)?.stop();
    });
    await testing.waitFor(() => expect(started).toHaveLength(1));

    await testing.act(async () => {
      for (const listener of listeners) {
        listener({ turnId, type: "text", delta: "## Reply\n\n**The storm** is quieter, see [the chapter](x)." });
      }
      for (const listener of listeners) listener({ turnId, type: "done" });
    });
    await testing.waitFor(() => expect(spoken).toEqual(["Reply.\n\nThe storm is quieter, see the chapter."]));
  });

  test("the answer goes to the voice service once one is connected", async () => {
    // The status and the voice service both arrive after the first render. A handler that kept the
    // first render's voice would speak through the device although the service is there now.
    speakersAvailable = true;
    const { view } = render();
    await testing.waitFor(() =>
      expect(view.getByTestId("ambient-line").textContent).toContain("Chapter One")
    );
    await testing.fireEvent.click(view.getByTestId("ambient-toggle"));

    await testing.act(async () => {
      await testing.fireEvent.click(view.getByTestId("ambient-mic"));
    });
    await testing.act(async () => {
      FakeRecorder.instances.at(-1)?.stop();
    });
    await testing.waitFor(() => expect(started).toHaveLength(1));

    await testing.act(async () => {
      for (const listener of listeners) listener({ turnId, type: "text", delta: "The storm is quieter now." });
      for (const listener of listeners) listener({ turnId, type: "done" });
    });
    await testing.waitFor(() => expect(voiceSpoken).toEqual(["The storm is quieter now."]));
    expect(spoken).toEqual([]);
  });

  test("a turn the agent refused to start is not spoken when a later turn finishes", async () => {
    // The microphone asked for a spoken answer, but no turn started. The next turn is a button press,
    // and its answer must stay on the screen.
    startRefusal = "The agent is not ready.";
    const { view } = render();
    await testing.waitFor(() =>
      expect(view.getByTestId("ambient-line").textContent).toContain("Chapter One")
    );
    await testing.fireEvent.click(view.getByTestId("ambient-toggle"));

    await testing.act(async () => {
      await testing.fireEvent.click(view.getByTestId("ambient-mic"));
    });
    await testing.act(async () => {
      FakeRecorder.instances.at(-1)?.stop();
    });
    await testing.waitFor(() =>
      expect(view.getByTestId("ambient-note").textContent).toContain("The agent is not ready.")
    );

    startRefusal = null;
    await testing.act(async () => {
      await testing.fireEvent.click(view.getByTestId("ambient-action-keep_going"));
    });
    await testing.waitFor(() => expect(started).toHaveLength(2));

    await testing.act(async () => {
      for (const listener of listeners) listener({ turnId, type: "text", delta: "Carrying on." });
      for (const listener of listeners) listener({ turnId, type: "done" });
    });
    await testing.act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(spoken).toEqual([]);
    expect(voiceSpoken).toEqual([]);
  });

  test("a typed request is answered on the screen and not out loud", async () => {
    // Someone at a desk with a keyboard has not asked to be read to.
    const { view } = render();
    await testing.waitFor(() =>
      expect(view.getByTestId("ambient-line").textContent).toContain("Chapter One")
    );
    await testing.fireEvent.click(view.getByTestId("ambient-toggle"));

    await testing.act(async () => {
      await testing.fireEvent.change(view.getByTestId("ambient-input"), { target: { value: "tighten the opening" } });
    });
    await testing.act(async () => {
      await testing.fireEvent.click(view.getByTestId("ambient-send"));
    });
    await testing.waitFor(() => expect(started).toEqual([{ bookId: BOOK, mode: "edit", prompt: "tighten the opening" }]));

    await testing.act(async () => {
      for (const listener of listeners) listener({ turnId, type: "done" });
    });
    expect(spoken).toEqual([]);
  });

  test("a transcription that fails says why, and does not start a turn", async () => {
    transcribeFails = true;
    const { view } = render();
    await testing.waitFor(() =>
      expect(view.getByTestId("ambient-line").textContent).toContain("Chapter One")
    );
    await testing.fireEvent.click(view.getByTestId("ambient-toggle"));

    await testing.act(async () => {
      await testing.fireEvent.click(view.getByTestId("ambient-mic"));
    });
    await testing.act(async () => {
      FakeRecorder.instances.at(-1)?.stop();
    });

    await testing.waitFor(() => expect(view.getByTestId("ambient-note").textContent).toContain("The key was rejected."));
    // Nothing was asked, so nothing can have changed in the book.
    expect(started).toEqual([]);
  });
});

describe("reading the prose", () => {
  test("refreshes speaking status after a Settings change and never falls back from an unavailable selection", async () => {
    const { view, reviseVoiceStatus } = render();
    await testing.fireEvent.click(view.getByTestId("ambient-toggle"));
    await testing.waitFor(() => expect(view.getByText(/Speaking with this computer/)).toBeDefined());

    speakersSelected = true;
    reviseVoiceStatus(1);
    await testing.waitFor(() => expect(view.getByText(/selected speaking connection is unavailable/)).toBeDefined());
    expect(view.queryByText(/Speaking with this computer/)).toBeNull();
    expect(view.queryByText(/This device cannot speak/)).toBeNull();
    await testing.act(async () => {
      await testing.fireEvent.click(view.getByTestId("ambient-action-read_aloud"));
    });
    await testing.waitFor(() => expect(view.getByTestId("ambient-note").textContent).toContain("unavailable"));
    expect(spoken).toEqual([]);
    expect(voiceSpoken).toEqual([]);

    speakersSelected = false;
    reviseVoiceStatus(2);
    await testing.waitFor(() => expect(view.getByText(/Speaking with this computer/)).toBeDefined());
  });

  test("an old speaking-status response cannot overwrite a newer Settings change", async () => {
    let finishFirst!: (result: Result<VoiceSpeakers>) => void;
    let reads = 0;
    const voice = (window as unknown as { studio: { voice: { speakers: () => Promise<Result<VoiceSpeakers>> } } }).studio.voice;
    voice.speakers = async () => {
      reads += 1;
      if (reads === 1) return new Promise((resolve) => { finishFirst = resolve; });
      return { ok: true, data: { available: false, selected: true, unavailable: true, connectionLabel: null, model: null, voices: [] } };
    };
    const { view, reviseVoiceStatus } = render();
    await testing.fireEvent.click(view.getByTestId("ambient-toggle"));
    await testing.waitFor(() => expect(reads).toBe(1));
    reviseVoiceStatus(1);
    await testing.waitFor(() => expect(view.getByText(/selected speaking connection is unavailable/)).toBeDefined());
    await testing.act(async () => {
      finishFirst({ ok: true, data: { available: false, selected: false, unavailable: false, connectionLabel: null, model: null, voices: [] } });
    });
    expect(view.getByText(/selected speaking connection is unavailable/)).toBeDefined();
    expect(view.queryByText(/Speaking with this computer/)).toBeNull();
  });

  test("a stale status read cannot start device speech after Settings changes", async () => {
    let finishSpeechRead!: (result: Result<VoiceSpeakers>) => void;
    let reads = 0;
    const voice = (window as unknown as { studio: { voice: { speakers: () => Promise<Result<VoiceSpeakers>> } } }).studio.voice;
    voice.speakers = async () => {
      reads += 1;
      if (reads === 2) return new Promise((resolve) => { finishSpeechRead = resolve; });
      return { ok: true, data: {
        available: false, selected: reads > 2, unavailable: reads > 2,
        connectionLabel: null, model: null, voices: []
      } };
    };
    const { view, reviseVoiceStatus } = render();
    await testing.fireEvent.click(view.getByTestId("ambient-toggle"));
    await testing.waitFor(() => expect(view.getByText(/Speaking with this computer/)).toBeDefined());
    await testing.fireEvent.click(view.getByTestId("ambient-action-read_aloud"));
    await testing.waitFor(() => expect(reads).toBe(2));

    reviseVoiceStatus(1);
    await testing.waitFor(() => expect(view.getByText(/selected speaking connection is unavailable/)).toBeDefined());
    await testing.act(async () => {
      finishSpeechRead({ ok: true, data: {
        available: false, selected: false, unavailable: false,
        connectionLabel: null, model: null, voices: []
      } });
    });
    await testing.waitFor(() => expect(view.getByTestId("ambient-note").textContent).toContain("Speaking settings changed"));
    expect(spoken).toEqual([]);
    expect(voiceSpoken).toEqual([]);
  });

  test("a failed status read does not claim the device cannot speak", async () => {
    const voice = (window as unknown as { studio: { voice: { speakers: () => Promise<Result<VoiceSpeakers>> } } }).studio.voice;
    voice.speakers = async () => ({ ok: false, error: { code: "unknown", message: "Unavailable." } });
    const { view } = render();
    await testing.fireEvent.click(view.getByTestId("ambient-toggle"));
    await testing.waitFor(() => expect(view.getByText(/Speaking settings could not be read/)).toBeDefined());
    expect(view.queryByText(/This device cannot speak/)).toBeNull();
  });

  test("offers to read the chapter, and reads it when asked", async () => {
    const { view } = render();
    await testing.waitFor(() =>
      expect(view.getByTestId("ambient-line").textContent).toContain("Chapter One")
    );
    await testing.fireEvent.click(view.getByTestId("ambient-toggle"));
    await testing.act(async () => {
      await testing.fireEvent.click(view.getByTestId("ambient-action-read_aloud"));
    });
    await testing.waitFor(() => expect(spoken[0] ?? "").toContain("The Light. The storm came in low."));
  });

  test("a refused selected voice service does not fall back to another voice", async () => {
    speakersAvailable = true;
    speakFails = true;
    const { view } = render();
    await testing.waitFor(() =>
      expect(view.getByTestId("ambient-line").textContent).toContain("Chapter One")
    );
    await testing.fireEvent.click(view.getByTestId("ambient-toggle"));
    await testing.act(async () => {
      await testing.fireEvent.click(view.getByTestId("ambient-action-read_aloud"));
    });
    await testing.waitFor(() => expect(view.getByTestId("ambient-note").textContent).toContain("The voice was rejected."));
    expect(spoken).toEqual([]);
    expect(voiceSpoken).toEqual(["The Light. The storm came in low."]);
  });

  test("says where you are out loud, from the same status the line shows", async () => {
    const { view } = render();
    // The button is off until the status has arrived, which is what stops it saying nothing.
    await testing.waitFor(
      () => expect(view.getByTestId("ambient-where").hasAttribute("disabled")).toBe(false),
      { timeout: 3000 }
    );
    await testing.act(async () => {
      await testing.fireEvent.click(view.getByTestId("ambient-where"));
    });
    await testing.waitFor(() => expect(spoken[0] ?? "").toContain("You're in Chapter One"));
  });

  test("holds the chapter being read and goes on when asked", async () => {
    // The utterance stays open so the panel has something to hold.
    utteranceAutoEnd = false;
    const { view } = render();
    await testing.waitFor(() =>
      expect(view.getByTestId("ambient-line").textContent).toContain("Chapter One")
    );
    await testing.fireEvent.click(view.getByTestId("ambient-toggle"));
    await testing.act(async () => {
      await testing.fireEvent.click(view.getByTestId("ambient-action-read_aloud"));
    });
    await testing.waitFor(() => expect(view.getByTestId("ambient-pause")).toBeDefined());
    expect(view.getByTestId("ambient-pause").getAttribute("aria-label")).toBe("Pause reading");

    await testing.act(async () => {
      await testing.fireEvent.click(view.getByTestId("ambient-pause"));
    });
    expect(synthesisPauseCalls).toBe(1);
    expect(synthesisResumeCalls).toBe(0);
    await testing.waitFor(() =>
      expect(view.getByTestId("ambient-pause").getAttribute("aria-label")).toBe("Resume reading")
    );

    await testing.act(async () => {
      await testing.fireEvent.click(view.getByTestId("ambient-pause"));
    });
    expect(synthesisResumeCalls).toBe(1);
    await testing.waitFor(() =>
      expect(view.getByTestId("ambient-pause").getAttribute("aria-label")).toBe("Pause reading")
    );

    await testing.act(async () => {
      for (const end of pendingEnds) end();
    });
    await testing.waitFor(() => expect(view.queryByTestId("ambient-pause")).toBeNull());
  });

  test("a fresh read starts unpaused after a held one", async () => {
    utteranceAutoEnd = false;
    const { view } = render();
    await testing.waitFor(() =>
      expect(view.getByTestId("ambient-line").textContent).toContain("Chapter One")
    );
    await testing.fireEvent.click(view.getByTestId("ambient-toggle"));
    await testing.act(async () => {
      await testing.fireEvent.click(view.getByTestId("ambient-action-read_aloud"));
    });
    await testing.waitFor(() => expect(view.getByTestId("ambient-pause")).toBeDefined());
    await testing.act(async () => {
      await testing.fireEvent.click(view.getByTestId("ambient-pause"));
    });
    await testing.waitFor(() =>
      expect(view.getByTestId("ambient-pause").getAttribute("aria-label")).toBe("Resume reading")
    );

    await testing.act(async () => {
      await testing.fireEvent.click(view.getByTestId("ambient-action-read_aloud"));
    });
    await testing.waitFor(() =>
      expect(view.getByTestId("ambient-pause").getAttribute("aria-label")).toBe("Pause reading")
    );
    expect(synthesisPauseCalls).toBe(1);
  });

  for (const outcome of ["resolve", "reject"] as const) {
    test(`an old resume ${outcome} cannot change a newer paused provider utterance`, async () => {
      const { view, reply } = await openProviderRead();
      await testing.fireEvent.click(view.getByTestId("ambient-pause"));
      await testing.waitFor(() => expect(view.getByTestId("ambient-pause").getAttribute("aria-label")).toBe("Resume reading"));
      const pending = deferredPlay();
      reply.playResults.push(pending.promise);
      await testing.fireEvent.click(view.getByTestId("ambient-pause"));
      expect(reply.playedCount).toBe(2);

      await testing.fireEvent.click(view.getByTestId("ambient-action-read_aloud"));
      await testing.waitFor(() => expect(FakeAudio.instances).toHaveLength(2));
      const newer = FakeAudio.instances[1] as FakeAudio;
      await testing.waitFor(() => expect(view.getByTestId("ambient-pause").getAttribute("aria-label")).toBe("Pause reading"));
      await testing.fireEvent.click(view.getByTestId("ambient-pause"));
      await testing.waitFor(() => expect(view.getByTestId("ambient-pause").getAttribute("aria-label")).toBe("Resume reading"));
      await testing.act(async () => {
        if (outcome === "resolve") pending.resolve();
        else pending.reject(new Error("old playback failure"));
      });
      expect(view.getByTestId("ambient-pause").getAttribute("aria-label")).toBe("Resume reading");
      expect(view.queryByTestId("ambient-note")).toBeNull();
      await testing.fireEvent.click(view.getByTestId("ambient-pause"));
      await testing.waitFor(() => expect(newer.playedCount).toBe(2));
      await testing.waitFor(() => expect(view.getByTestId("ambient-pause").getAttribute("aria-label")).toBe("Pause reading"));
      expect(spoken).toEqual([]);
    });
  }

  test("a failed resume reports playback failure without switching voice", async () => {
    const { view, reply } = await openProviderRead();
    await testing.fireEvent.click(view.getByTestId("ambient-pause"));
    const pending = deferredPlay();
    reply.playResults.push(pending.promise);
    await testing.fireEvent.click(view.getByTestId("ambient-pause"));
    await testing.act(async () => { pending.reject(new Error("private playback detail")); });
    await testing.waitFor(() => expect(view.getByTestId("ambient-note").textContent)
      .toBe("The selected speaking service returned audio, but playback was blocked. Try reading again."));
    expect(view.queryByTestId("ambient-pause")).toBeNull();
    expect(view.getByTestId("ambient-line").textContent).toContain("Chapter One");
    expect(voiceSpoken).toEqual(["The Light. The storm came in low."]);
    expect(spoken).toEqual([]);
  });

  test("repeated resume presses do not start overlapping play attempts", async () => {
    const { view, reply } = await openProviderRead();
    await testing.fireEvent.click(view.getByTestId("ambient-pause"));
    const pending = deferredPlay();
    reply.playResults.push(pending.promise);
    await testing.fireEvent.click(view.getByTestId("ambient-pause"));
    await testing.fireEvent.click(view.getByTestId("ambient-pause"));
    expect(reply.playedCount).toBe(2);
    await testing.act(async () => { pending.resolve(); });
    await testing.waitFor(() => expect(view.getByTestId("ambient-pause").getAttribute("aria-label")).toBe("Pause reading"));
  });

  for (const rejectAfterResume of [false, true]) {
    test(`an interrupted initial play rejection cannot end the utterance ${rejectAfterResume ? "after resume" : "while paused"}`, async () => {
      const pending = deferredPlay();
      FakeAudio.nextInitialPlay = pending.promise;
      const { view, reply } = await openProviderRead();
      await testing.fireEvent.click(view.getByTestId("ambient-pause"));
      if (!rejectAfterResume) {
        await testing.act(async () => { pending.reject(new Error("play interrupted by pause")); });
        expect(view.getByTestId("ambient-pause").getAttribute("aria-label")).toBe("Resume reading");
      }
      await testing.fireEvent.click(view.getByTestId("ambient-pause"));
      await testing.waitFor(() => expect(reply.playedCount).toBe(2));
      await testing.waitFor(() => expect(view.getByTestId("ambient-pause").getAttribute("aria-label")).toBe("Pause reading"));
      if (rejectAfterResume) {
        await testing.act(async () => { pending.reject(new Error("play interrupted by pause")); });
        expect(view.getByTestId("ambient-pause").getAttribute("aria-label")).toBe("Pause reading");
      }
      expect(view.queryByTestId("ambient-note")).toBeNull();
    });
  }

  for (const event of ["end", "fail"] as const) {
    test(`an old provider ${event} callback cannot change a newer utterance`, async () => {
      const { view, reply } = await openProviderRead();
      await testing.fireEvent.click(view.getByTestId("ambient-action-read_aloud"));
      await testing.waitFor(() => expect(FakeAudio.instances).toHaveLength(2));
      const newer = FakeAudio.instances[1] as FakeAudio;
      await testing.waitFor(() => expect(view.getByTestId("ambient-pause").getAttribute("aria-label")).toBe("Pause reading"));
      await testing.fireEvent.click(view.getByTestId("ambient-pause"));
      await testing.act(async () => { reply[event](); });
      expect(view.getByTestId("ambient-pause").getAttribute("aria-label")).toBe("Resume reading");
      expect(view.queryByTestId("ambient-note")).toBeNull();
      await testing.fireEvent.click(view.getByTestId("ambient-pause"));
      await testing.waitFor(() => expect(newer.playedCount).toBe(2));
      await testing.act(async () => { newer.end(); });
      await testing.waitFor(() => expect(view.queryByTestId("ambient-pause")).toBeNull());
    });
  }

  for (const event of ["end", "error"] as const) {
    test(`an old device ${event} callback cannot change a newer utterance`, async () => {
      utteranceAutoEnd = false;
      const { view } = render();
      await testing.waitFor(() => expect(view.getByTestId("ambient-line").textContent).toContain("Chapter One"));
      await testing.fireEvent.click(view.getByTestId("ambient-toggle"));
      await testing.fireEvent.click(view.getByTestId("ambient-action-read_aloud"));
      await testing.waitFor(() => expect(pendingEnds).toHaveLength(1));
      await testing.fireEvent.click(view.getByTestId("ambient-action-read_aloud"));
      await testing.waitFor(() => expect(pendingEnds).toHaveLength(2));
      await testing.fireEvent.click(view.getByTestId("ambient-pause"));
      await testing.act(async () => { (event === "end" ? pendingEnds[0] : pendingErrors[0])?.(); });
      expect(view.getByTestId("ambient-pause").getAttribute("aria-label")).toBe("Resume reading");
      expect(view.queryByTestId("ambient-note")).toBeNull();
      await testing.fireEvent.click(view.getByTestId("ambient-pause"));
      expect(synthesisResumeCalls).toBe(1);
      await testing.act(async () => { pendingEnds[1]?.(); });
      await testing.waitFor(() => expect(view.queryByTestId("ambient-pause")).toBeNull());
    });
  }

  test("an old provider failure cannot interrupt a newer device utterance", async () => {
    utteranceAutoEnd = false;
    const { view, reply } = await openProviderRead();
    speakersAvailable = false;
    await testing.fireEvent.click(view.getByTestId("ambient-action-read_aloud"));
    await testing.waitFor(() => expect(pendingEnds).toHaveLength(1));
    await testing.fireEvent.click(view.getByTestId("ambient-pause"));
    await testing.act(async () => { reply.fail(); });
    expect(view.getByTestId("ambient-pause").getAttribute("aria-label")).toBe("Resume reading");
    expect(view.queryByTestId("ambient-note")).toBeNull();
    await testing.fireEvent.click(view.getByTestId("ambient-pause"));
    expect(synthesisResumeCalls).toBe(1);
  });

  test("an old device failure cannot interrupt a newer provider utterance", async () => {
    utteranceAutoEnd = false;
    installFakeAudio();
    const { view } = render();
    await testing.waitFor(() => expect(view.getByTestId("ambient-line").textContent).toContain("Chapter One"));
    await testing.fireEvent.click(view.getByTestId("ambient-toggle"));
    await testing.fireEvent.click(view.getByTestId("ambient-action-read_aloud"));
    await testing.waitFor(() => expect(pendingEnds).toHaveLength(1));
    speakersAvailable = true;
    await testing.fireEvent.click(view.getByTestId("ambient-action-read_aloud"));
    await testing.waitFor(() => expect(FakeAudio.instances).toHaveLength(1));
    const reply = FakeAudio.instances[0] as FakeAudio;
    await testing.fireEvent.click(view.getByTestId("ambient-pause"));
    await testing.act(async () => { pendingErrors[0]?.(); });
    expect(view.getByTestId("ambient-pause").getAttribute("aria-label")).toBe("Resume reading");
    expect(view.queryByTestId("ambient-note")).toBeNull();
    await testing.fireEvent.click(view.getByTestId("ambient-pause"));
    await testing.waitFor(() => expect(reply.playedCount).toBe(2));
    expect(spoken).toEqual(["The Light. The storm came in low."]);
  });

  test("a current provider audio failure is visible", async () => {
    const { view, reply } = await openProviderRead();
    await testing.act(async () => { reply.fail(); });
    await testing.waitFor(() => expect(view.getByTestId("ambient-note").textContent)
      .toBe("The selected speaking service returned audio that could not be played."));
    expect(view.queryByTestId("ambient-pause")).toBeNull();
    expect(spoken).toEqual([]);
  });

  test("a current device speech failure is visible", async () => {
    utteranceAutoEnd = false;
    const { view } = render();
    await testing.waitFor(() => expect(view.getByTestId("ambient-line").textContent).toContain("Chapter One"));
    await testing.fireEvent.click(view.getByTestId("ambient-toggle"));
    await testing.fireEvent.click(view.getByTestId("ambient-action-read_aloud"));
    await testing.waitFor(() => expect(pendingErrors).toHaveLength(1));
    await testing.act(async () => { pendingErrors[0]?.(); });
    await testing.waitFor(() => expect(view.getByTestId("ambient-note").textContent)
      .toBe("This device could not play the speech. Try reading again."));
    expect(view.queryByTestId("ambient-pause")).toBeNull();
    expect(voiceSpoken).toEqual([]);
  });

  test("holds and goes on with the voice service's reply the same way", async () => {
    speakersAvailable = true;
    installFakeAudio();
    const { view } = render();
    await testing.waitFor(() =>
      expect(view.getByTestId("ambient-line").textContent).toContain("Chapter One")
    );
    await testing.fireEvent.click(view.getByTestId("ambient-toggle"));
    await testing.act(async () => {
      await testing.fireEvent.click(view.getByTestId("ambient-action-read_aloud"));
    });
    await testing.waitFor(() => expect(FakeAudio.instances.length).toBe(1));
    const reply = FakeAudio.instances[0] as FakeAudio;
    expect(reply.playedCount).toBe(1);
    await testing.waitFor(() => expect(view.getByTestId("ambient-pause")).toBeDefined());

    await testing.act(async () => {
      await testing.fireEvent.click(view.getByTestId("ambient-pause"));
    });
    expect(reply.pausedCount).toBe(1);
    await testing.waitFor(() =>
      expect(view.getByTestId("ambient-pause").getAttribute("aria-label")).toBe("Resume reading")
    );

    await testing.act(async () => {
      await testing.fireEvent.click(view.getByTestId("ambient-pause"));
    });
    await testing.waitFor(() => expect(reply.playedCount).toBe(2));
    await testing.waitFor(() =>
      expect(view.getByTestId("ambient-pause").getAttribute("aria-label")).toBe("Pause reading")
    );

    await testing.act(async () => {
      reply.end();
    });
    await testing.waitFor(() => expect(view.queryByTestId("ambient-pause")).toBeNull());
  });
});
