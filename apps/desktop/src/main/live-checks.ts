import { execFile } from "node:child_process";
import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { AgentEvent } from "@ai-book-studio/core/agent";
import { MUSE_SPARK_CONTRIBUTOR } from "@ai-book-studio/core/providers/compatibility";
import { ProviderError } from "@ai-book-studio/core/providers/types";
import { DEFAULT_VOICE_PREFERENCES, type VoicePreferences } from "@ai-book-studio/core/providers/voice-preferences";
import { AgentRuntime } from "./agent/runtime";
import { ImageService } from "./images";
import { VoiceService } from "./voice";
import { SpeechService } from "./speech";
import { Library } from "./library/store";
import type { ProviderService } from "./providers";
import type { Studio } from "./studio";

const run = promisify(execFile);

export type LiveOutcome = "ok" | "blocked" | "failed";

export interface LiveResult {
  name: string;
  outcome: LiveOutcome;
  detail: string;
}

/** The phrase the dictation check speaks, so the transcript has a ground truth. */
const PHRASE = "The lighthouse keeper counted the ships that never came.";

/**
 * What the studio can do with a real Meta key.
 *
 * Every one of these was a blocker until a key arrived, and each is worth proving rather than
 * asserting: the model catalogue, a real writing turn that changes a real file, dictation with a
 * recording whose words are known, and an image from Muse Image.
 *
 * The library it writes to is a copy of the committed sample, in a temporary folder, deleted
 * afterwards. The author's own book is never touched.
 */
export async function runLiveChecks(
  providers: ProviderService,
  options: { sampleRoot: string; voicePreferences?: VoicePreferences }
): Promise<LiveResult[]> {
  const results: LiveResult[] = [];
  const voicePreferences = options.voicePreferences ?? DEFAULT_VOICE_PREFERENCES;
  const record = (name: string, outcome: LiveOutcome, detail: string): void => {
    results.push({ name, outcome, detail });
  };

  /* ------------------------------------------------------------- the models */

  let contributorModelId: string | null = null;
  try {
    const connections = await providers.list();
    const meta = connections.find((entry: { provider: string }) => entry.provider === "meta");
    if (!meta) {
      record("the model catalogue", "blocked", "There is no Meta connection in the studio.");
    } else {
      const catalogue = await providers.models(meta.id);
      const ids = catalogue.models.map((model: { id: string }) => model.id);
      if (ids.length === 0) {
        record("the model catalogue", "failed", "Meta answered, but with no models in it.");
      } else {
        contributorModelId = contributorFrom(ids);
        record(
          "the model catalogue",
          "ok",
          `${ids.length} model${ids.length === 1 ? "" : "s"}: ${ids.slice(0, 6).join(", ")}${
            ids.length > 6 ? ", …" : ""
          }`
        );
      }
    }
  } catch (error) {
    record("the model catalogue", "failed", message(error));
  }

  /* ------------------------------------------------------------- a real turn */

  if (contributorModelId) {
    const temp = await mkdtemp(join(tmpdir(), "studio-live-agent-"));
    try {
      const libraryRoot = join(temp, "library");
      await cp(options.sampleRoot, libraryRoot, { recursive: true });
      const library = await Library.open(libraryRoot);
      const books = await library.listBooks();
      const book = books[0];
      if (!book) {
        record("a real writing turn", "failed", "The sample library has no book.");
      } else {
        const connection = (await providers.list()).find(
          (entry: { provider: string }) => entry.provider === "meta"
        );
        await library.updateBook(book.id, {
          // The sample is the project's own synthetic work, so the Contributor consent is safe here.
          allowContributorTraining: true,
          defaultConnectionId: connection?.id ?? null,
          defaultModelId: contributorModelId
        });
        const chapters = (await library.readBook(book.id)).chapters;
        const before = chapters[0]?.content ?? "";
        const studio = { library, requireLibrary: () => library } as unknown as Studio;
        const runtime = new AgentRuntime(studio, providers, () => {}, undefined, () => {});
        if (process.env.STUDIO_LIVE_CHECK === "1" && process.env.STUDIO_LIVE_VERBOSE === "1") {
          const seen = await providers.credential(connection?.id ?? "");
          console.error(
            `[live] turn: connection ${connection?.id} · model ${contributorModelId} · base ${seen.metadata?.baseUrl} · key ${seen.secret.length} chars`
          );
        }

        // Every way out — done, error, timeout or a start that throws — clears the timer and the
        // listener, so a turn that never started cannot keep the check alive or reject unheard.
        let stop = (): void => {};
        const done = new Promise<Extract<AgentEvent, { type: "done" }>>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error("The turn did not finish in time.")), 240_000);
          const unsubscribe = runtime.onEvent((event) => {
            if (event.type === "done") resolve(event);
            else if (event.type === "error") reject(new Error(event.message));
          });
          stop = () => {
            clearTimeout(timer);
            unsubscribe();
          };
        });
        done.catch(() => {});

        let result: Extract<AgentEvent, { type: "done" }>;
        try {
          await runtime.start({
            bookId: book.id,
            chapterId: chapters[0]?.id ?? null,
            mode: "edit",
            prompt:
              "Read the first chapter, then add one short paragraph at the end of it in the same voice. Do not change anything else."
          });
          result = await done;
        } finally {
          stop();
        }
        const after = (await library.readChapter(book.id, chapters[0]!.id)).content;
        const changed = after !== before;
        record(
          "a real writing turn",
          changed ? "ok" : "failed",
          changed
            ? `the agent replied (${result.text.length} characters) and the file on disk changed`
            : "the agent replied, but the file did not change."
        );
      }
    } catch (error) {
      record("a real writing turn", "failed", message(error));
      if (error instanceof Error && error.stack) console.error("[live] turn failed:", error.stack.slice(0, 1200));
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  }

  /* ------------------------------------------------------------- dictation */

  if (!voicePreferences.transcription.connectionId || !voicePreferences.transcription.model) {
    record("dictation", "blocked", "Choose a transcription connection and model in Settings to run the dictation check.");
  } else {
    const expectedSelection = {
      connectionId: voicePreferences.transcription.connectionId,
      model: voicePreferences.transcription.model
    };
    const temp = await mkdtemp(join(tmpdir(), "studio-live-voice-"));
    try {
      const aiff = join(temp, "phrase.aiff");
      const wav = join(temp, "phrase.wav");
      // macOS speaks the phrase in its own format, and the converter puts it in the one Meta
      // accepts. `say --data-format` refuses to open the output file on this macOS, so the
      // conversion is left to afconvert, which reads whatever `say` wrote.
      await run("say", ["-o", aiff, PHRASE]);
      await run("afconvert", ["-f", "WAVE", "-d", "LEI16@16000", "-c", "1", aiff, wav]);
      const audio = new Uint8Array(await readFile(wav));
      const transcript = await new VoiceService(providers, fetch, () => voicePreferences).transcribe({ audio, expectedSelection });
      const said = transcript.text.toLowerCase().replace(/[^a-z ]/g, "").trim();
      const words = PHRASE.toLowerCase().replace(/[^a-z ]/g, "").trim().split(" ");
      const heard = words.filter((word) => said.includes(word)).length;
      const score = Math.round((heard / words.length) * 100);
      record(
        "dictation",
        score >= 60 ? "ok" : "failed",
        `“${transcript.text}” — ${score}% of the words (${heard} of ${words.length}), ${transcript.durationMs}ms of audio`
      );
    } catch (error) {
      record("dictation", "failed", message(error));
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  }

  /* ------------------------------------------------------------- speaking */

  if (!voicePreferences.speaking.connectionId || !voicePreferences.speaking.model || !voicePreferences.speaking.voice) {
    record("speaking", "blocked", "Choose a speaking connection, model and voice in Settings to run the speaking check.");
  } else {
    try {
      const speech = new SpeechService(providers, fetch, () => voicePreferences);
      const speakers = await speech.connections();
      if (speakers.length === 0) {
        record("speaking", "blocked", "No voice service is connected, so there is nothing to speak with.");
      } else {
        const spoken = await speech.speak({
          text: "The lighthouse keeper counted the ships that never came. Shall I read it to you?"
        });
        const level = loudness(spoken.bytes, spoken.mimeType);
        // A file of the right size can still be silence. PCM can be measured; a compressed stream
        // cannot, cheaply, so for those the size is the only signal and the check says so.
        const plausible = spoken.bytes.byteLength > 2_000 && (level === null || level > 100);
        const measured = level === null ? "compressed, size checked" : `level ${Math.round(level)}`;
        record(
          "speaking",
          plausible ? "ok" : "failed",
          plausible
            ? `${spoken.bytes.byteLength} bytes of ${spoken.mimeType} in ${spoken.chunks} request${
                spoken.chunks === 1 ? "" : "s"
              }, ${spoken.model}, ${measured}`
            : `The voice service returned ${spoken.bytes.byteLength} bytes (${measured}), which is not audible speech.`
        );
      }
    } catch (error) {
      record("speaking", "failed", message(error));
    }
  }

  /* ------------------------------------------------------------- an image */

  try {
    const image = await new ImageService(providers).generate({
      prompt: "A black and white photograph of a lighthouse keeper's ledger on a wooden table.",
      size: "1024x1024"
    });
    const bytes = image.bytes?.length ?? 0;
    record(
      "Muse Image",
      bytes > 1000 ? "ok" : "failed",
      bytes > 1000
        ? `${bytes} bytes of ${image.inspection.mimeType}, model ${image.model}, ${image.size}`
        : "Meta answered, but with no image in it."
    );
  } catch (error) {
    record("Muse Image", "failed", message(error));
  }

  return results;
}

/**
 * How loud the audio is, as the root mean square of its 16-bit samples.
 *
 * A file of the right size proves nothing: a service that returns silence returns a file. This
 * reads past the header and measures what is actually in it.
 */
function loudness(audio: Uint8Array, mimeType: string): number | null {
  // MP3 is compressed; there is nothing cheap to measure without a decoder.
  if (!mimeType.includes("wav") || audio.byteLength <= 44) return null;
  const view = new DataView(audio.buffer, audio.byteOffset, audio.byteLength);
  let sum = 0;
  let count = 0;
  for (let offset = 44; offset + 1 < audio.byteLength; offset += 2) {
    const sample = view.getInt16(offset, true);
    sum += sample * sample;
    count += 1;
  }
  return count === 0 ? 0 : Math.sqrt(sum / count);
}

/** The error, with the detail that makes it actionable. A bare message hides the cause. */
function message(error: unknown): string {
  if (error instanceof ProviderError) {
    const cause = error.options?.cause;
    const extra = cause instanceof Error ? ` — cause: ${cause.message}` : "";
    return `[${error.code}] ${error.message}${extra}`;
  }
  if (error instanceof Error) return `[${error.name}] ${error.message}`;
  return String(error);
}

/**
 * The Contributor model the check should use.
 *
 * The catalogue lists more than one — `muse-spark-1.2-contributor` and `muse-spark-1.3-contributor`
 * on the key this was written against — and taking the first one silently ran the check on 1.2
 * while spec 022 described 1.3. The check therefore prefers the model the spec names, then the
 * highest version the key offers, and records which one it used so the evidence can say.
 */
export function contributorFrom(ids: string[]): string {
  const exact = ids.find((id) => id === MUSE_SPARK_CONTRIBUTOR);
  if (exact) return exact;
  const rated = ids
    .map((id) => ({ id, version: /muse-spark-(\d+)\.(\d+)-contributor/.exec(id) }))
    .filter((entry) => entry.version !== null)
    .sort((a, b) => Number(b.version![1]) - Number(a.version![1]) || Number(b.version![2]) - Number(a.version![2]));
  const best = rated[0]?.id;
  if (best) return best;
  return ids.find((id) => id.includes("contributor")) ?? ids.find((id) => /muse|spark/i.test(id)) ?? ids[0] ?? "";
}
