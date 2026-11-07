import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { chmod, cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent } from "@ai-book-studio/core/agent";
import { wrapPcmAsWav } from "@ai-book-studio/core/providers/tts";
import type { VoicePreferences } from "@ai-book-studio/core/providers/voice-preferences";
import { ProviderError } from "@ai-book-studio/core/providers/types";
import { AgentRuntime } from "../src/main/agent/runtime";
import { Library } from "../src/main/library/store";
import { runLiveChecks, type LiveResult } from "../src/main/live-checks";

/*
 * The live check proves what the studio can do with a real Meta key: the catalogue, a writing turn
 * that changes a file, dictation against a known phrase, speech and an image. Here every
 * provider is a fetch stub on `.invalid` hosts, and `say` and `afconvert` are stand-in scripts, so
 * the verdicts are checked without a key, a network or a sound. The library is a copy of the
 * committed sample, as in the real check.
 */

const SAMPLE = join(import.meta.dir, "..", "..", "..", "samples", "the-salt-road");
const PHRASE = "The lighthouse keeper counted the ships that never came.";
const KEY = ["live", "check", "fixture", "secret"].join("-");

const META = { id: "conn_livemeta01", provider: "meta" as const, label: "Meta", kind: "api-key" as const, createdAt: "2026-11-03T00:00:00.000Z" };
const OPENAI = { ...META, id: "conn_liveopenai1", provider: "openai" as const, label: "OpenAI" };
const OPENROUTER = { ...META, id: "conn_liverouter1", provider: "openrouter" as const, label: "OpenRouter" };
const LIVE_VOICE_PREFERENCES: VoicePreferences = {
  transcription: { connectionId: META.id, model: "muse-voice-transcribe-1.0" },
  speaking: { connectionId: OPENAI.id, model: "gpt-4o-mini-tts", voice: "nova" }
};
const PCM_VOICE_PREFERENCES: VoicePreferences = {
  ...LIVE_VOICE_PREFERENCES,
  speaking: { connectionId: OPENROUTER.id, model: "heygen/heygen-voice-1", voice: "weston" }
};
const BASES: Record<string, string> = {
  [META.id]: "https://meta.invalid/v1",
  [OPENAI.id]: "https://openai.invalid/v1",
  [OPENROUTER.id]: "https://openrouter.invalid/v1"
};

const realFetch = globalThis.fetch;
const realPath = process.env.PATH;
const cleanups: string[] = [];

afterEach(async () => {
  globalThis.fetch = realFetch;
  process.env.PATH = realPath;
  await Promise.all(cleanups.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function temp(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  cleanups.push(dir);
  return dir;
}

type Catalogue = { models: Array<{ id: string }> };

/** The provider service the check reads: connections, a catalogue and the secret for a request. */
function providers(options: { connections?: Array<typeof META | typeof OPENAI | typeof OPENROUTER>; models?: string[]; list?: () => Promise<never> } = {}) {
  const connections = options.connections ?? [META, OPENAI];
  return {
    list: options.list ?? (async () => connections),
    models: async (_id: string): Promise<Catalogue> => ({ models: (options.models ?? []).map((id) => ({ id })) }),
    credential: async (id: string) => {
      const connection = connections.find((entry) => entry.id === id);
      if (!connection) throw new ProviderError("not-found", "That connection is not in the studio.");
      return { ...connection, secret: KEY, metadata: { baseUrl: BASES[id] as string } };
    }
  };
}

type Route = (request: { url: URL; body: string }) => Response | Promise<Response>;

/** Answers only the routes given, on `.invalid` hosts; anything else would be a real request. */
function network(routes: Record<string, Route>) {
  const calls: Array<{ url: URL; body: string }> = [];
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const body = typeof init?.body === "string" ? init.body : "";
    calls.push({ url, body });
    const route = routes[`${url.host}${url.pathname}`];
    if (!url.hostname.endsWith(".invalid") || !route) throw new Error(`No network in checks: ${url.href}`);
    return route({ url, body });
  }) as typeof fetch;
  return calls;
}

const CHUNK = { id: "chatcmpl-live", object: "chat.completion.chunk", created: 0, model: "muse" };
const USAGE = { prompt_tokens: 120, completion_tokens: 12, total_tokens: 132 };

function stream(chunks: object[]): Response {
  const body = `${chunks.map((chunk) => `data: ${JSON.stringify({ ...CHUNK, ...chunk })}\n\n`).join("")}data: [DONE]\n\n`;
  return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

function reply(text: string): Response {
  return stream([
    { choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }] },
    { choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: USAGE }
  ]);
}

function toolCall(name: string, input: object): Response {
  return stream([
    {
      choices: [
        {
          index: 0,
          delta: {
            role: "assistant",
            tool_calls: [{ index: 0, id: "call_live01", type: "function", function: { name, arguments: JSON.stringify(input) } }]
          },
          finish_reason: null
        }
      ]
    },
    { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage: USAGE }
  ]);
}

/** Half a second of 16 kHz mono samples: a tone, or silence. */
function pcm(loud: boolean): Uint8Array {
  const samples = new Int16Array(8_000);
  if (loud) for (let index = 0; index < samples.length; index += 1) samples[index] = index % 2 === 0 ? 8_000 : -8_000;
  return new Uint8Array(samples.buffer);
}

/**
 * A copy of the committed sample, and `say` and `afconvert` stand-ins that put a known recording
 * where the check expects its converted phrase. `say -o <aiff> <phrase>` and
 * `afconvert -f WAVE -d LEI16@16000 -c 1 <aiff> <wav>` are the calls the check makes.
 */
async function bench() {
  const work = await temp("studio-live-bench-");
  const sampleRoot = join(work, "sample");
  await cp(SAMPLE, sampleRoot, { recursive: true });
  const library = await Library.open(sampleRoot);
  const book = (await library.listBooks())[0];
  if (!book) throw new Error("the committed sample has no book");
  const chapter = (await library.readBook(book.id)).chapters[0] as { id: string };

  const bin = join(work, "bin");
  await mkdir(bin);
  const recording = join(work, "phrase.wav");
  await writeFile(recording, wrapPcmAsWav(pcm(true), { sampleRate: 16_000, channels: 1, bitsPerSample: 16 }));
  await writeFile(join(bin, "say"), '#!/bin/sh\n: > "$2"\n');
  await writeFile(join(bin, "afconvert"), `#!/bin/sh\ncp "${recording}" "$8"\n`);
  await chmod(join(bin, "say"), 0o755);
  await chmod(join(bin, "afconvert"), 0o755);
  process.env.PATH = `${bin}:${realPath ?? ""}`;

  const png = new Uint8Array(await readFile(join(SAMPLE, "books", book.id, "images", "img_7d70206f04da45ea.png")));
  return { sampleRoot, bookId: book.id, chapterId: chapter.id, png };
}

function verdicts(results: LiveResult[]): Record<string, string> {
  return Object.fromEntries(results.map((result) => [result.name, result.outcome]));
}

function detail(results: LiveResult[], name: string): string {
  return results.find((result) => result.name === name)?.detail ?? "(not run)";
}

async function leftovers(): Promise<string[]> {
  return (await readdir(tmpdir())).filter((name) => /^studio-live-(agent|voice)-/.test(name));
}

type Listener = (event: AgentEvent) => void;

/**
 * The runtime with `start` replaced, and who is still listening to it. A rejection nobody handles
 * fails the running bun test, so `start` and the tests wait briefly to let one surface in time.
 */
function failingStart(start: (listening: Set<Listener>) => Promise<never>) {
  const listening = new Set<Listener>();
  const subscribe = AgentRuntime.prototype.onEvent;
  const spies = [
    spyOn(AgentRuntime.prototype, "onEvent").mockImplementation(function (this: AgentRuntime, listener: Listener) {
      const unsubscribe = subscribe.call(this, listener);
      listening.add(listener);
      return () => {
        listening.delete(listener);
        unsubscribe();
      };
    }),
    spyOn(AgentRuntime.prototype, "start").mockImplementation(() => start(listening)),
    spyOn(console, "error").mockImplementation(() => {})
  ];
  return {
    listening,
    restore: () => {
      for (const spy of spies) spy.mockRestore();
    }
  };
}

const LATE_ERROR: AgentEvent = { type: "error", turnId: "turn_late0001", code: "unknown", message: "The turn ended late." };

describe("live checks", () => {
  test(
    "with a Meta key every check proves its result, against a copy of the sample",
    async () => {
      const { sampleRoot, chapterId, png } = await bench();
      const before = await leftovers();
      const turns = [
        toolCall("append_to_chapter", { chapterId, text: "The keeper wrote the tide down, as she did every night." }),
        reply("I added one paragraph at the end of the chapter.")
      ];
      const calls = network({
        "meta.invalid/v1/chat/completions": () => turns.shift() ?? reply("Done."),
        "meta.invalid/v1/asr/transcribe": () => Response.json({ transcript: PHRASE, audioDurationMs: 2400 }),
        "openrouter.invalid/v1/audio/speech": () => new Response(pcm(true), { headers: { "content-type": "audio/pcm; rate=44100; channels=1" } }),
        "meta.invalid/v1/images/generations": () =>
          Response.json({ data: [{ b64_json: Buffer.from(png).toString("base64") }], output_format: "png" })
      });

      const models = ["muse-spark-1.2-contributor", "muse-spark-1.3-contributor", "muse-spark-1.3"];
      const results = await runLiveChecks(providers({ models, connections: [META, OPENROUTER] }) as never, { sampleRoot, voicePreferences: PCM_VOICE_PREFERENCES });

      expect(verdicts(results)).toEqual({
        "the model catalogue": "ok",
        "a real writing turn": "ok",
        dictation: "ok",
        speaking: "ok",
        "Muse Image": "ok"
      });
      expect(detail(results, "the model catalogue")).toBe(`3 models: ${models.join(", ")}`);
      expect(detail(results, "a real writing turn")).toMatch(/^the agent replied \(\d+ characters\) and the file on disk changed$/);
      expect(detail(results, "dictation")).toBe(`“${PHRASE}” — 100% of the words (9 of 9), 2400ms of audio`);
      expect(detail(results, "speaking")).toMatch(/^\d+ bytes of audio\/wav in 1 request, .+, level 8000$/);
      expect(detail(results, "Muse Image")).toMatch(new RegExp(`^${png.byteLength} bytes of image/png, model .+, 1024x1024$`));

      // The turn ran on the Contributor model the spec names, not the first one listed.
      const turn = calls.find((call) => call.url.pathname.endsWith("/chat/completions"));
      expect(JSON.parse(turn?.body ?? "{}").model).toBe("muse-spark-1.3-contributor");
      const speaking = calls.find((call) => call.url.pathname.endsWith("/audio/speech"));
      expect(JSON.parse(speaking?.body ?? "{}")).toMatchObject({
        model: "heygen/heygen-voice-1", voice: "weston", response_format: "pcm"
      });
      expect(calls.every((call) => call.url.hostname.endsWith(".invalid"))).toBe(true);
      // The library it wrote to was a temporary copy, and it is gone.
      expect(await leftovers()).toEqual(before);
    },
    30_000
  );

  test(
    "a turn that changes nothing, a missed phrase, silence and a tiny image fail",
    async () => {
      const { sampleRoot } = await bench();
      network({
        "meta.invalid/v1/chat/completions": () => reply("I read the chapter and left it as it was."),
        "meta.invalid/v1/asr/transcribe": () => Response.json({ transcript: "Something else entirely." }),
        "openrouter.invalid/v1/audio/speech": () => new Response(pcm(false), { headers: { "content-type": "audio/pcm" } }),
        "meta.invalid/v1/images/generations": () =>
          Response.json({
            data: [
              {
                b64_json:
                  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lK3Q6wAAAABJRU5ErkJggg=="
              }
            ],
            output_format: "png"
          })
      });

      const results = await runLiveChecks(providers({ models: ["muse-spark-1.3-contributor"], connections: [META, OPENROUTER] }) as never, { sampleRoot, voicePreferences: PCM_VOICE_PREFERENCES });

      expect(verdicts(results)).toEqual({
        "the model catalogue": "ok",
        "a real writing turn": "failed",
        dictation: "failed",
        speaking: "failed",
        "Muse Image": "failed"
      });
      expect(detail(results, "the model catalogue")).toBe("1 model: muse-spark-1.3-contributor");
      expect(detail(results, "a real writing turn")).toBe("the agent replied, but the file did not change.");
      expect(detail(results, "dictation")).toMatch(/^“Something else entirely\.” — 0% of the words \(0 of 9\), \d+ms of audio$/);
      expect(detail(results, "speaking")).toMatch(/^The voice service returned \d+ bytes \(level 0\), which is not audible speech\.$/);
      expect(detail(results, "Muse Image")).toBe("Meta answered, but with no image in it.");
    },
    30_000
  );

  test(
    "a model that refuses the turn is a failed turn with its reason, and compressed speech is judged by size",
    async () => {
      const { sampleRoot, png } = await bench();
      network({
        "meta.invalid/v1/chat/completions": () =>
          new Response(JSON.stringify({ error: { message: "This key cannot use the Contributor model." } }), {
            status: 401,
            headers: { "content-type": "application/json" }
          }),
        "meta.invalid/v1/asr/transcribe": () => Response.json({ transcript: PHRASE }),
        "openai.invalid/v1/audio/speech": () => new Response(new Uint8Array(6_000).fill(7), { headers: { "content-type": "audio/mpeg" } }),
        "meta.invalid/v1/images/generations": () => new Response("upstream timeout", { status: 400 })
      });

      const logged = spyOn(console, "error").mockImplementation(() => {});
      let results: LiveResult[];
      try {
        results = await runLiveChecks(providers({ models: ["muse-spark-1.3-contributor"] }) as never, { sampleRoot, voicePreferences: LIVE_VOICE_PREFERENCES });
      } finally {
        logged.mockRestore();
      }

      expect(verdicts(results)).toEqual({
        "the model catalogue": "ok",
        "a real writing turn": "failed",
        dictation: "ok",
        speaking: "ok",
        "Muse Image": "failed"
      });
      expect(detail(results, "a real writing turn")).not.toContain(KEY);
      expect(detail(results, "a real writing turn").length).toBeGreaterThan(0);
      expect(detail(results, "speaking")).toMatch(/^6000 bytes of audio\/mpeg in 1 request, .+, compressed, size checked$/);
      expect(detail(results, "Muse Image")).toMatch(/^\[[a-z-]+\] /);
      expect(png.byteLength).toBeGreaterThan(1000);
    },
    30_000
  );

  test("without a Meta connection nothing is called, and each check says what is missing", async () => {
    const { sampleRoot } = await bench();
    const calls = network({});
    const results = await runLiveChecks(providers({ connections: [] }) as never, { sampleRoot });

    expect(verdicts(results)).toEqual({
      "the model catalogue": "blocked",
      dictation: "blocked",
      speaking: "blocked",
      "Muse Image": "failed"
    });
    expect(detail(results, "the model catalogue")).toBe("There is no Meta connection in the studio.");
    expect(detail(results, "dictation")).toBe("Choose a transcription connection and model in Settings to run the dictation check.");
    expect(detail(results, "speaking")).toBe("Choose a speaking connection, model and voice in Settings to run the speaking check.");
    expect(detail(results, "Muse Image")).toBe("[invalid-request] Connect Meta in Settings before generating an illustration.");
    expect(calls).toEqual([]);
  });

  test("an empty catalogue fails without a turn, and an unreadable studio names the cause", async () => {
    const { sampleRoot } = await bench();
    network({});
    const empty = await runLiveChecks(providers({ connections: [META], models: [] }) as never, { sampleRoot });
    expect(detail(empty, "the model catalogue")).toBe("Meta answered, but with no models in it.");
    expect(empty.some((result) => result.name === "a real writing turn")).toBe(false);

    const unreadable = providers({
      list: async () => {
        throw new ProviderError("offline", "The studio could not list its connections.", {
          cause: new Error("ECONNRESET")
        });
      }
    });
    const results = await runLiveChecks(unreadable as never, { sampleRoot, voicePreferences: LIVE_VOICE_PREFERENCES });
    expect(detail(results, "the model catalogue")).toBe(
      "[offline] The studio could not list its connections. — cause: ECONNRESET"
    );
    expect(results.every((result) => result.outcome === "failed")).toBe(true);
  });

  test("a turn that fails to start is a failed turn with its reason, and leaves no timer or listener behind", async () => {
    const { sampleRoot } = await bench();
    network({});
    // The turn's four-minute timer, armed through the real clock so a leak would show.
    const realSetTimeout = globalThis.setTimeout;
    const realClearTimeout = globalThis.clearTimeout;
    const armed: unknown[] = [];
    const cleared = new Set<unknown>();
    const timers = spyOn(globalThis, "setTimeout").mockImplementation(((
      handler: (...args: unknown[]) => void,
      delay?: number,
      ...rest: unknown[]
    ) => {
      const timer = realSetTimeout(handler, delay, ...rest);
      if (delay === 240_000) armed.push(timer);
      return timer;
    }) as unknown as typeof setTimeout);
    const clears = spyOn(globalThis, "clearTimeout").mockImplementation(((timer?: unknown) => {
      cleared.add(timer);
      realClearTimeout(timer as Parameters<typeof clearTimeout>[0]);
    }) as unknown as typeof clearTimeout);
    // A start that throws, as it does when the connection's key cannot be read.
    const runtime = failingStart(async () => {
      throw new Error("This connection could not be read. Remove it and connect again.");
    });

    let results: LiveResult[];
    let left: { pending: number; listening: number };
    try {
      results = await runLiveChecks(providers({ models: ["muse-spark-1.3-contributor"] }) as never, { sampleRoot });
      left = { pending: armed.filter((timer) => !cleared.has(timer)).length, listening: runtime.listening.size };
      // An error the runtime reports after the failed start reaches nothing that can reject unheard.
      for (const listener of [...runtime.listening]) listener(LATE_ERROR);
      await new Promise((resolve) => realSetTimeout(resolve, 20));
    } finally {
      runtime.restore();
      timers.mockRestore();
      clears.mockRestore();
      for (const timer of armed) realClearTimeout(timer as Parameters<typeof clearTimeout>[0]);
    }

    expect(verdicts(results)["a real writing turn"]).toBe("failed");
    expect(detail(results, "a real writing turn")).toBe(
      "[Error] This connection could not be read. Remove it and connect again."
    );
    expect(armed).toHaveLength(1);
    expect(left).toEqual({ pending: 0, listening: 0 });
  });

  test("an error reported while the turn is still starting is not left to reject unheard", async () => {
    const { sampleRoot } = await bench();
    network({});
    const runtime = failingStart(async (listening) => {
      for (const listener of [...listening]) listener(LATE_ERROR);
      await new Promise((resolve) => setTimeout(resolve, 20));
      throw new Error("The turn could not start.");
    });

    let results: LiveResult[];
    try {
      results = await runLiveChecks(providers({ models: ["muse-spark-1.3-contributor"] }) as never, { sampleRoot });
    } finally {
      runtime.restore();
    }

    expect(detail(results, "a real writing turn")).toBe("[Error] The turn could not start.");
    expect(runtime.listening.size).toBe(0);
  });
});
