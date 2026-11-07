/// <reference types="bun" />
import { afterAll, beforeAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import React from "react";
import { mountDom, unmountDom } from "./support/dom";

/**
 * The microphone, through the hook the buttons and the hands-free mode both use.
 *
 * Every branch here is a thing that has actually gone wrong for someone: a denied permission, a
 * recorder that produces nothing, a transcription that fails, a component unmounted while the
 * microphone is live. The recorder and the audio decoder are fakes, because the assertion is about
 * the lifecycle — that every track is stopped, that a cancel does not insert text, that nothing is
 * inserted twice.
 */

let testing!: typeof import("@testing-library/react/pure");
let useDictation!: typeof import("@ai-book-studio/app/hooks/use-dictation").useDictation;

beforeAll(async () => {
  testing = await mountDom();
  ({ useDictation } = await import("@ai-book-studio/app/hooks/use-dictation"));
});
afterAll(async () => {
  await unmountDom();
});



type Handler = (event: { data: Blob }) => void;

/** A MediaRecorder that does what the test says, including producing nothing. */
class FakeRecorder {
  static instances: FakeRecorder[] = [];
  state: "inactive" | "recording" = "inactive";
  mimeType = "audio/webm";
  deferStop = false;
  readonly listeners = new Map<string, Handler[]>();

  constructor(
    readonly stream: unknown,
    readonly options: { mimeType?: string } = {}
  ) {
    FakeRecorder.instances.push(this);
  }

  static isTypeSupported(type: string): boolean {
    return type === "audio/webm;codecs=opus";
  }

  addEventListener(type: string, handler: Handler): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), handler]);
  }

  start(ms: number): void {
    this.startedEvery = ms;
    this.state = "recording";
  }

  startedEvery = 0;

  /** The browser's own stop: whatever was buffered, then the stop event. */
  stop(): void {
    this.state = "inactive";
    if (this.deferStop) return;
    for (const handler of this.listeners.get("stop") ?? []) handler({ data: new Blob() });
  }

  /** Produce whatever the test wants, then fire stop the way a browser would. */
  emit(size: number, type = "audio/webm"): void {
    this.state = "inactive";
    this.mimeType = type;
    if (size > 0) {
      for (const handler of this.listeners.get("dataavailable") ?? []) {
        handler({ data: new Blob([new Uint8Array(size)], { type }) });
      }
    }
    for (const handler of this.listeners.get("stop") ?? []) handler({ data: new Blob() });
  }
}

/** Tracks that count how often they are stopped, so a leak is visible. */
function fakeStream() {
  const stopped: string[] = [];
  const stream = {
    getTracks: () => [
      { kind: "audio", stop: () => stopped.push("first") },
      { kind: "audio", stop: () => stopped.push("second") }
    ]
  };
  return { stream, stopped };
}

interface Harness {
  state: string;
  elapsedMs: number;
  start: () => Promise<void>;
  stop: () => void;
  cancel: () => void;
}

let harness: Harness = { state: "idle", elapsedMs: 0, start: async () => {}, stop: () => {}, cancel: () => {} };
let texts: string[] = [];
let errors: string[] = [];

function configuredVoice(transcribe: (input: unknown) => Promise<unknown> = async () => ({ ok: true, data: { text: "Words." } })) {
  return {
    settings: async () => ({ ok: true, data: {
      transcription: { connectionId: "conn_meta000001", model: "muse-voice-transcribe-1.0" },
      speaking: { connectionId: null, model: null, voice: null }
    } }),
    connections: async () => ({ ok: true, data: [{ id: "conn_meta000001", provider: "meta" }] }),
    transcribe
  };
}

function Probe({ maxMs }: { maxMs?: number }) {
  const dictation = useDictation({
    onText: (text) => texts.push(text),
    onError: (error) => errors.push(error.message),
    ...(maxMs ? { maxMs } : {})
  });
  harness = dictation as Harness;
  return React.createElement("div", { "data-state": dictation.state }, dictation.state);
}

function mount(maxMs?: number) {
  const view = testing.render(React.createElement(Probe, maxMs ? { maxMs } : {}));
  return view;
}

const realMediaRecorder = (globalThis as { MediaRecorder?: unknown }).MediaRecorder;
const realMediaDevices = navigator.mediaDevices;

function withMicrophone(options: { recorder?: boolean } = {}) {
  const { stream, stopped } = fakeStream();
  if (options.recorder === false) {
    Reflect.deleteProperty(globalThis, "MediaRecorder");
  } else {
    (globalThis as { MediaRecorder?: unknown }).MediaRecorder = FakeRecorder;
  }
  Object.defineProperty(navigator, "mediaDevices", {
    value: { getUserMedia: async () => stream },
    configurable: true
  });
  return { stream, stopped };
}

/**
 * The decoder the hook asks for when a recording finishes.
 *
 * happy-dom has no Web Audio, and the hook's contract does not depend on what the decoder returns:
 * it needs *a* WAV buffer to send. What the buffer looks like is `packages/app/tests/audio.test.ts`.
 */
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

(globalThis as { AudioContext?: unknown }).AudioContext = FakeAudioContext;

beforeEach(() => {
  FakeRecorder.instances = [];
  texts = [];
  errors = [];
  harness = { state: "idle", elapsedMs: 0, start: async () => {}, stop: () => {}, cancel: () => {} };
  (window as { studio?: unknown }).studio = { voice: configuredVoice() };
});

afterEach(() => {
  testing.cleanup();
  // The stubs are installed at module scope, so they are restored here rather than at the end.
  (globalThis as { MediaRecorder?: unknown }).MediaRecorder = realMediaRecorder;
  (globalThis as { AudioContext?: unknown }).AudioContext = FakeAudioContext;
  Object.defineProperty(navigator, "mediaDevices", { value: realMediaDevices, configurable: true });
  // The hook's fake for the transcription service must not leak into the next test.
  delete (window as { studio?: unknown }).studio;
});

describe("a build that cannot record", () => {
  test("says so in one sentence rather than failing silently", async () => {
    withMicrophone({ recorder: false });
    mount();
    await testing.act(async () => {
      await harness.start();
    });
    expect(errors).toEqual(["This build cannot record audio. Voice dictation needs the desktop app."]);
    expect(harness.state).toBe("idle");
  });
});

describe("asking for the microphone", () => {
  test("an absent, removed or retired selection is explained before the microphone opens", async () => {
    const getUserMedia = mock(async () => fakeStream().stream);
    withMicrophone();
    Object.defineProperty(navigator, "mediaDevices", { value: { getUserMedia }, configurable: true });
    const voice = configuredVoice();
    (window as { studio?: unknown }).studio = { voice };
    mount();

    const settings = [
      { connectionId: null, model: null },
      { connectionId: "conn_removed01", model: "muse-voice-transcribe-1.0" },
      { connectionId: "conn_meta000001", model: "retired-model" }
    ];
    for (const transcription of settings) {
      voice.settings = async () => ({ ok: true, data: { transcription, speaking: { connectionId: null, model: null, voice: null } } }) as never;
      await testing.act(async () => { await harness.start(); });
      expect(harness.state).toBe("idle");
    }
    expect(errors[0]).toContain("Choose a transcription connection and model");
    expect(errors[1]).toContain("unavailable");
    expect(errors[2]).toContain("unavailable");
    expect(getUserMedia).not.toHaveBeenCalled();
    expect(FakeRecorder.instances).toHaveLength(0);
  });

  test("records once permission is given", async () => {
    const { stream } = withMicrophone();
    mount();
    await testing.act(async () => {
      await harness.start();
    });
    expect(harness.state).toBe("recording");
    const recorder = FakeRecorder.instances.at(-1);
    expect(recorder?.stream).toBe(stream);
    // The hook asks for the narrowest stream it can: one channel, processed.
    expect(recorder?.options.mimeType).toBe("audio/webm;codecs=opus");
  });

  test("an OpenRouter selection can open the microphone without a Meta connection", async () => {
    const { stream } = withMicrophone();
    const voice = configuredVoice();
    voice.settings = (async () => ({ ok: true, data: {
      transcription: { connectionId: "conn_openrouter01", model: "openai/whisper-1" },
      speaking: { connectionId: null, model: null, voice: null }
    } })) as never;
    voice.connections = (async () => ({ ok: true, data: [{ id: "conn_openrouter01", provider: "openrouter" }] })) as never;
    (window as { studio?: unknown }).studio = { voice };
    mount();
    await testing.act(async () => { await harness.start(); });
    expect(harness.state).toBe("recording");
    expect(FakeRecorder.instances.at(-1)?.stream).toBe(stream);
  });

  test("a recorder that cannot start releases the microphone and reports the failure", async () => {
    const { stopped } = withMicrophone();
    (globalThis as { MediaRecorder?: unknown }).MediaRecorder = class extends FakeRecorder {
      override start(): void { throw new Error("recorder failed"); }
    };
    mount();
    await testing.act(async () => { await harness.start(); });
    expect(stopped).toEqual(["first", "second"]);
    expect(errors).toEqual(["The microphone could not start recording. Try again."]);
    expect(harness.state).toBe("idle");
  });

  test("a second start while recording does nothing, so one press is one recording", async () => {
    withMicrophone();
    mount();
    await testing.act(async () => {
      await harness.start();
    });
    await testing.act(async () => {
      await harness.start();
    });
    expect(FakeRecorder.instances).toHaveLength(1);
  });

  test("a denied permission explains where to allow it", async () => {
    withMicrophone();
    Object.defineProperty(navigator, "mediaDevices", {
      value: {
        getUserMedia: async () => {
          throw Object.assign(new Error("denied"), { name: "NotAllowedError" });
        }
      },
      configurable: true
    });
    mount();
    await testing.act(async () => {
      await harness.start();
    });
    expect(errors[0]).toContain("Microphone access was denied");
    expect(harness.state).toBe("idle");
  });

  test("a microphone that cannot be opened says that instead", async () => {
    withMicrophone();
    Object.defineProperty(navigator, "mediaDevices", {
      value: {
        getUserMedia: async () => {
          throw new Error("device busy");
        }
      },
      configurable: true
    });
    mount();
    await testing.act(async () => {
      await harness.start();
    });
    expect(errors[0]).toContain("could not be opened");
  });
});

describe("finishing a recording", () => {
  function stubVoice(result: unknown) {
    (window as { studio?: unknown }).studio = {
      voice: configuredVoice(mock(() => Promise.resolve(result)))
    };
  }

  test("a transcript reaches the caller and the state goes back to idle", async () => {
    withMicrophone();
    stubVoice({ ok: true, data: { text: "The lamp would not turn." } });
    mount();
    await testing.act(async () => {
      await harness.start();
    });
    await testing.act(async () => {
      FakeRecorder.instances.at(-1)?.emit(8);
    });
    await testing.waitFor(() => expect(texts).toEqual(["The lamp would not turn."]));
    expect(harness.state).toBe("idle");
  });

  test("binds the recording to the transcription choice read before opening the microphone", async () => {
    withMicrophone();
    const transcribe = mock(async (_input: unknown) => ({ ok: true, data: { text: "Words." } }));
    const voice = configuredVoice(transcribe);
    (window as { studio?: unknown }).studio = { voice };
    mount();
    await testing.act(async () => { await harness.start(); });
    voice.settings = (async () => ({ ok: true, data: {
      transcription: { connectionId: "conn_openrouter01", model: "openai/whisper-1" },
      speaking: { connectionId: null, model: null, voice: null }
    } })) as never;
    await testing.act(async () => { FakeRecorder.instances.at(-1)?.emit(8); });
    await testing.waitFor(() => expect(transcribe).toHaveBeenCalledTimes(1));
    expect(transcribe.mock.calls[0]?.[0]).toMatchObject({
      expectedSelection: { connectionId: "conn_meta000001", model: "muse-voice-transcribe-1.0" }
    });
  });

  test("every track is stopped when the recording ends, so the light goes out", async () => {
    const { stopped } = withMicrophone();
    stubVoice({ ok: true, data: { text: "Words." } });
    mount();
    await testing.act(async () => {
      await harness.start();
    });
    await testing.act(async () => {
      FakeRecorder.instances.at(-1)?.emit(8);
    });
    expect(stopped).toEqual(["first", "second"]);
  });

  test("a recording that produced nothing says so rather than sending silence", async () => {
    withMicrophone();
    stubVoice({ ok: true, data: { text: "should not be asked" } });
    mount();
    await testing.act(async () => {
      await harness.start();
    });
    await testing.act(async () => {
      FakeRecorder.instances.at(-1)?.emit(0);
    });
    expect(errors[0]).toContain("The recording was empty");
    expect(texts).toEqual([]);
  });

  test("a transcript with no speech in it is explained, not inserted", async () => {
    withMicrophone();
    stubVoice({ ok: true, data: { text: "" } });
    mount();
    await testing.act(async () => {
      await harness.start();
    });
    await testing.act(async () => {
      FakeRecorder.instances.at(-1)?.emit(8);
    });
    await testing.waitFor(() => expect(errors[0]).toContain("No speech was detected"));
    expect(texts).toEqual([]);
  });

  test("the service's refusal is passed on in its own words", async () => {
    withMicrophone();
    stubVoice({ ok: false, error: { message: "The key was rejected." } });
    mount();
    await testing.act(async () => {
      await harness.start();
    });
    await testing.act(async () => {
      FakeRecorder.instances.at(-1)?.emit(8);
    });
    await testing.waitFor(() => expect(errors).toEqual(["The key was rejected."]));
    expect(harness.state).toBe("idle");
  });

  test("a build with no voice service says where dictation lives", async () => {
    withMicrophone();
    (window as { studio?: unknown }).studio = {};
    mount();
    await testing.act(async () => {
      await harness.start();
    });
    await testing.waitFor(() => expect(errors[0]).toContain("desktop app"));
    expect(FakeRecorder.instances).toHaveLength(0);
  });
});

describe("cancelling", () => {
  test("a cancel stops the microphone and inserts nothing", async () => {
    const { stopped } = withMicrophone();
    const transcribe = mock(() => Promise.resolve({ ok: true, data: { text: "never" } }));
    (window as { studio?: unknown }).studio = { voice: configuredVoice(transcribe) };
    mount();
    await testing.act(async () => {
      await harness.start();
    });
    await testing.act(async () => {
      harness.cancel();
    });
    expect(stopped).toEqual(["first", "second"]);
    // The browser's stop event lands after the cancel, and it still must not insert text.
    await testing.act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(transcribe).not.toHaveBeenCalled();
    expect(texts).toEqual([]);
    expect(harness.state).toBe("idle");
  });

  test("a cancel before the microphone opens stops the tracks it later receives", async () => {
    withMicrophone();
    const late = fakeStream();
    const slow = deferred();
    const getUserMedia = mock(() => slow.promise);
    Object.defineProperty(navigator, "mediaDevices", {
      value: { getUserMedia },
      configurable: true
    });
    mount();
    const starting = harness.start();
    await testing.waitFor(() => expect(getUserMedia).toHaveBeenCalledTimes(1));
    // The author changes their mind while the permission prompt is still up.
    await testing.act(async () => {
      harness.cancel();
    });
    slow.resolve(late.stream);
    await testing.act(async () => {
      await starting;
    });
    // Nothing is recording, and the stream that arrived late was released rather than left live.
    expect(FakeRecorder.instances).toHaveLength(0);
    expect(late.stopped).toEqual(["first", "second"]);
  });

  test("a cancel during the settings check never opens the microphone", async () => {
    withMicrophone();
    const getUserMedia = mock(async () => fakeStream().stream);
    Object.defineProperty(navigator, "mediaDevices", { value: { getUserMedia }, configurable: true });
    const slow = deferred();
    const voice = configuredVoice();
    voice.settings = (() => slow.promise) as never;
    (window as { studio?: unknown }).studio = { voice };
    mount();
    const starting = harness.start();
    await testing.act(async () => { harness.cancel(); });
    slow.resolve({ ok: true, data: { transcription: { connectionId: "conn_meta000001", model: "muse-voice-transcribe-1.0" } } });
    await testing.act(async () => { await starting; });
    expect(getUserMedia).not.toHaveBeenCalled();
    expect(FakeRecorder.instances).toHaveLength(0);
    expect(harness.state).toBe("idle");
  });

  test("a cancelled recorder's late events cannot stop or submit a newer recording", async () => {
    withMicrophone();
    const first = fakeStream();
    const second = fakeStream();
    let opens = 0;
    Object.defineProperty(navigator, "mediaDevices", {
      value: { getUserMedia: async () => (++opens === 1 ? first.stream : second.stream) },
      configurable: true
    });
    const transcribe = mock(async () => ({ ok: true, data: { text: "New words." } }));
    (window as { studio?: unknown }).studio = { voice: configuredVoice(transcribe) };
    mount();
    await testing.act(async () => { await harness.start(); });
    const old = FakeRecorder.instances[0];
    if (!old) throw new Error("missing first recorder");
    old.deferStop = true;
    await testing.act(async () => { harness.cancel(); });
    await testing.act(async () => { await harness.start(); });
    const current = FakeRecorder.instances[1];
    if (!current) throw new Error("missing second recorder");
    await testing.act(async () => { old.emit(8); });
    expect(first.stopped).toEqual(["first", "second"]);
    expect(second.stopped).toEqual([]);
    expect(harness.state).toBe("recording");
    expect(transcribe).not.toHaveBeenCalled();
    await testing.act(async () => { current.emit(8); });
    await testing.waitFor(() => expect(texts).toEqual(["New words."]));
    expect(transcribe).toHaveBeenCalledTimes(1);
    expect(second.stopped).toEqual(["first", "second"]);
  });

  test("cancelling during audio conversion prevents sending", async () => {
    withMicrophone();
    const slow = deferred();
    const decode = mock(() => slow.promise);
    (globalThis as { AudioContext?: unknown }).AudioContext = class {
      decodeAudioData = decode;
      async close() {}
    };
    const transcribe = mock(async () => ({ ok: true, data: { text: "never" } }));
    (window as { studio?: unknown }).studio = { voice: configuredVoice(transcribe) };
    mount();
    await testing.act(async () => { await harness.start(); });
    await testing.act(async () => { FakeRecorder.instances.at(-1)?.emit(8); });
    await testing.waitFor(() => expect(decode).toHaveBeenCalledTimes(1));
    await testing.act(async () => { harness.cancel(); });
    slow.resolve({ numberOfChannels: 1, length: 4, sampleRate: 16_000, getChannelData: () => new Float32Array(4) });
    await testing.act(async () => { await slow.promise; });
    expect(transcribe).not.toHaveBeenCalled();
    expect(texts).toEqual([]);
    expect(errors).toEqual([]);
    expect(harness.state).toBe("idle");
  });

  test("cancelling a pending transcription ignores its later result without disturbing a restart", async () => {
    withMicrophone();
    const slow = deferred();
    const transcribe = mock(() => slow.promise);
    (window as { studio?: unknown }).studio = { voice: configuredVoice(transcribe) };
    mount();
    await testing.act(async () => { await harness.start(); });
    await testing.act(async () => { FakeRecorder.instances.at(-1)?.emit(8); });
    await testing.waitFor(() => expect(transcribe).toHaveBeenCalledTimes(1));
    await testing.act(async () => { harness.cancel(); });
    await testing.act(async () => { await harness.start(); });
    await testing.act(async () => {
      slow.resolve({ ok: true, data: { text: "Old words." } });
      await slow.promise;
    });
    expect(texts).toEqual([]);
    expect(errors).toEqual([]);
    expect(harness.state).toBe("recording");
    expect(FakeRecorder.instances.at(-1)?.state).toBe("recording");
  });
});

describe("the clock", () => {
  test("counts up while recording, and stops itself at the provider's limit", async () => {
    withMicrophone();
    const realNow = Date.now;
    let now = realNow();
    Date.now = () => now;
    try {
      mount(50);
      await testing.act(async () => {
        await harness.start();
      });
      now += 30;
      await new Promise((resolve) => setTimeout(resolve, 300));
      // The elapsed time tracks the clock rather than the tick count.
      expect(harness.elapsedMs).toBeGreaterThanOrEqual(0);
      now += 60;
      await new Promise((resolve) => setTimeout(resolve, 400));
      // Past the limit the recorder was asked to stop, because Meta refuses longer audio.
      expect(FakeRecorder.instances.at(-1)?.state).toBe("inactive");
    } finally {
      Date.now = realNow;
    }
  });
});

function deferred() {
  let resolve: (value: unknown) => void = () => {};
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
