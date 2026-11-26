import { createHash, randomBytes } from "node:crypto";
import { channel } from "node:diagnostics_channel";
import { closeSync, constants, fstatSync, lstatSync, openSync, readdirSync, readSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { CredentialVault } from "@ai-book-studio/core/providers/credentials";
import { serializeProviderRequest, type ReviewEnvelope } from "@ai-book-studio/core/review/envelope";
import type {
  ReaderReviewFailure, ReaderReviewRefusal, ReaderReviewService as ReaderReviewServiceContract, ReaderReviewStartResult
} from "@ai-book-studio/core/review/reader-api";
import { modelFor } from "../agent/transport";
import { ReaderReviewService, type ReviewLibrary, type ReviewProviders } from "./service";
import { AiSdkReviewTransport } from "./transport";
import sample from "./reader-review-sample.json";

const SCENARIO_FLAG = "STUDIO_READER_REVIEW_CHECK";
const scenarios = [sample.scenario, sample.preStartScenario, sample.staleScenario, sample.stopScenario, sample.pairedScenario];
const launchFlags = new Set([
  SCENARIO_FLAG, "STUDIO_TEST", "STUDIO_HEADLESS", "STUDIO_TEST_MEMORY_VAULT",
  "STUDIO_USER_DATA", "STUDIO_WINDOW_SIZE"
]);

interface Launch {
  env: Readonly<Record<string, string | undefined>>;
  packaged: boolean;
  headless: boolean;
  appPath: string;
  entry: string;
}

function requirePrivateDirectory(path: string, uid: number): void {
  const info = lstatSync(path);
  if (!info.isDirectory() || info.uid !== uid || (info.mode & 0o777) !== 0o700 || realpathSync(path) !== path) {
    throw new Error("Invalid reader fixture directory.");
  }
}

function requireEntries(path: string, entries: string[]): void {
  if (!isDeepStrictEqual(readdirSync(path).sort(), entries.sort())) {
    throw new Error("Invalid reader fixture inventory.");
  }
}

function requireFixtureBytes(path: string, expected: string, uid: number): string {
  const bytes = Buffer.from(expected);
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = fstatSync(fd);
    if (!info.isFile() || info.uid !== uid || info.nlink !== 1 || (info.mode & 0o777) !== 0o600 ||
        info.size !== bytes.length) {
      throw new Error("Invalid reader fixture file.");
    }
    const actual = Buffer.alloc(bytes.length + 1);
    const read = readSync(fd, actual);
    if (read !== bytes.length || !bytes.equals(actual.subarray(0, read))) {
      throw new Error("Invalid reader fixture bytes.");
    }
    return createHash("sha256").update(bytes).digest("hex");
  } finally {
    closeSync(fd);
  }
}

function chapterFile(chapter: typeof sample.first): string {
  return [
    "---", "id: " + chapter.id, "title: " + chapter.title, "order: " + chapter.order, "version: 1",
    "createdAt: " + sample.book.createdAt, "updatedAt: " + sample.book.updatedAt, "---", "", chapter.body
  ].join("\n");
}

export function readerReviewCheckRequested(env: Launch["env"]): boolean {
  return Object.hasOwn(env, SCENARIO_FLAG);
}

/** Runs before userData or the instance lock changes. Only the generated synthetic tree is admitted. */
export function admitReaderReviewCheck({ env, packaged, headless, appPath, entry }: Launch): string {
  const profile = env.STUDIO_USER_DATA;
  const uid = process.getuid?.();
  if (packaged || !headless || !scenarios.some(scenario => env[SCENARIO_FLAG] === scenario) ||
      env.STUDIO_TEST !== "1" || env.STUDIO_HEADLESS !== "1" || env.STUDIO_TEST_MEMORY_VAULT !== "1" ||
      env.STUDIO_WINDOW_SIZE !== "1440x900" || !profile || uid === undefined ||
      Object.keys(env).some((flag) => flag.startsWith("STUDIO_") && !launchFlags.has(flag)) ||
      Object.hasOwn(env, "ELECTRON_RENDERER_URL") || Object.hasOwn(env, "ELECTRON_RUN_AS_NODE")) {
    throw new Error("Invalid reader fixture launch flags.");
  }
  if (basename(appPath) !== "desktop" || basename(dirname(appPath)) !== "apps" ||
      resolve(entry) !== resolve(appPath, "out/main/index.cjs") || !lstatSync(entry).isFile()) {
    throw new Error("The reader fixture requires the built desktop entry.");
  }
  const scratch = dirname(profile);
  if (basename(profile) !== "profile" || dirname(scratch) !== realpathSync(tmpdir()) ||
      !basename(scratch).startsWith(sample.scratchPrefix)) {
    throw new Error("Invalid reader fixture scratch path.");
  }
  requirePrivateDirectory(scratch, uid);
  requirePrivateDirectory(profile, uid);
  requireEntries(profile, ["studio.json"]);
  const libraryRoot = join(scratch, "library");
  requireFixtureBytes(join(profile, "studio.json"), JSON.stringify({ libraryRoot }) + "\n", uid);
  const books = join(libraryRoot, "books");
  const book = join(books, sample.book.id);
  const chapters = join(book, "chapters");
  for (const directory of [libraryRoot, books, book, chapters]) requirePrivateDirectory(directory, uid);
  requireEntries(libraryRoot, ["books"]);
  requireEntries(books, [sample.book.id]);
  requireEntries(book, ["book.json", "chapters"]);
  requireEntries(chapters, [sample.first.filename, sample.selected.filename]);
  requireFixtureBytes(join(book, "book.json"), JSON.stringify(sample.book) + "\n", uid);
  requireFixtureBytes(join(chapters, sample.first.filename), chapterFile(sample.first), uid);
  const hash = requireFixtureBytes(join(chapters, sample.selected.filename), chapterFile(sample.selected), uid);
  if (hash !== sample.selected.hash) throw new Error("The reader fixture chapter has an unexpected revision.");
  return profile;
}

const observationKey = Symbol.for("studio.reader-review-check");

export function createReaderReviewCheck(scenario = sample.scenario) {
  const secret = sample.sentinelPrefix + randomBytes(24).toString("hex");
  const counts = {
    catalogues: 0, preparations: 0, cancelledPreparations: 0, starts: 0, readerLists: 0, readerModels: 0, readerCredentialReads: 0,
    completionPosts: 0, stoppedRuns: 0, lateResponses: 0, fixtureRefusals: 0, outboundAttempts: 0, permissionAttempts: 0,
    protectedStorageAttempts: 0, guardedStorageMethods: 0
  };
  let prepared: ReviewEnvelope | null = null;
  let completedDigest: string | null = null;
  let requestHash: string | null = null;
  let lastStart: { kind: ReaderReviewStartResult["kind"]; reason: ReaderReviewRefusal | ReaderReviewFailure | null } | null = null;
  let heldResponse: { signal: AbortSignal; release: () => void } | null = null;
  const snapshot = () => ({
    ...counts, requestId: prepared?.requestId ?? null, preparedDigest: prepared?.scopeDigest ?? null,
    completedDigest, requestHash, lastStart
  });
  function releaseStoppedResponse(): boolean {
    if (!heldResponse || counts.stoppedRuns !== 1 || !heldResponse.signal.aborted) return false;
    const { release } = heldResponse;
    heldResponse = null;
    release();
    return true;
  }
  function refuseFixture(): never {
    counts.fixtureRefusals++;
    throw new Error("Unexpected reader fixture request.");
  }
  function noteOutbound(): void {
    counts.outboundAttempts++;
  }
  function refuseOutbound(): never {
    noteOutbound();
    throw new Error("External requests are blocked during the reader check.");
  }
  function refusePermission(): false {
    counts.permissionAttempts++;
    return false;
  }
  function fixtureRequest(input: string | URL | Request, init?: RequestInit): Request {
    try {
      return input instanceof Request ? new Request(input, init) : new Request(String(input), init);
    } catch {
      return refuseFixture();
    }
  }
  function guardHost(safeStorage: object, shell: object): void {
    for (const method of [
      "isEncryptionAvailable", "isAsyncEncryptionAvailable", "encryptString", "decryptString",
      "encryptStringAsync", "decryptStringAsync"
    ]) {
      const refuse = () => {
        counts.protectedStorageAttempts++;
        throw new Error("Protected storage is blocked during the reader check.");
      };
      if (typeof Reflect.get(safeStorage, method) !== "function" || !Reflect.set(safeStorage, method, refuse) ||
          Reflect.get(safeStorage, method) !== refuse) {
        throw new Error("Could not guard protected storage for the reader check.");
      }
      counts.guardedStorageMethods++;
    }
    const openExternal = async () => refuseOutbound();
    if (!Reflect.set(shell, "openExternal", openExternal) || Reflect.get(shell, "openExternal") !== openExternal) {
      throw new Error("Could not guard external app links for the reader check.");
    }
    globalThis.fetch = Object.assign(async () => refuseOutbound(), { preconnect: refuseOutbound });
    channel("undici:request:create").subscribe(noteOutbound);
    channel("http.client.request.start").subscribe(noteOutbound);
    Object.defineProperty(globalThis, observationKey, { value: Object.freeze({ snapshot, releaseStoppedResponse }) });
  }

  async function seed(vault: CredentialVault): Promise<void> {
    await vault.set({
      id: sample.book.defaultConnectionId, provider: "meta", label: sample.connectionLabel, kind: "api-key",
      createdAt: sample.book.createdAt, secret, metadata: { baseUrl: sample.baseUrl }
    });
  }

  const catalogueFetch: typeof fetch = Object.assign(async (input: string | URL | Request, init?: RequestInit) => {
    const request = fixtureRequest(input, init);
    if (request.method !== "GET" || request.url !== sample.baseUrl + "/models" ||
        request.headers.get("authorization") !== "Bearer " + secret || counts.catalogues !== 0 ||
        counts.readerModels !== 1 || prepared !== null) {
      return refuseFixture();
    }
    counts.catalogues++;
    return Response.json({ data: [{ id: sample.book.defaultModelId, name: sample.modelName }] });
  }, { preconnect: refuseFixture });

  function observePreparation(envelope: ReviewEnvelope): void {
    const source = envelope.sources[0];
    const segment = source?.kind === "chapter" ? source.segments[0] : undefined;
    const rerun = prepared !== null;
    const expectedVersion = rerun ? 2 : 1;
    const expectedBody = rerun ? sample.revisedBody : sample.selected.body;
    const expectedProfile = rerun ? "reader-beta" : "reader-alpha";
    if ((rerun && (scenario !== sample.pairedScenario || counts.preparations !== 1 || counts.completionPosts !== 1 ||
         lastStart?.kind !== "completed" || envelope.requestId === prepared?.requestId)) ||
        envelope.kind !== "reader-review" || envelope.books.length !== 1 ||
        envelope.books[0]?.bookId !== sample.book.id || envelope.books[0].enabledTools.length !== 0 ||
        envelope.destination.provider !== sample.providerName || envelope.destination.connectionId !== sample.book.defaultConnectionId ||
        envelope.destination.model !== sample.book.defaultModelId || envelope.profile?.id !== expectedProfile ||
        envelope.priorFeedback.length !== 0 || envelope.prompt !== "" || envelope.sources.length !== 1 ||
        source?.kind !== "chapter" || source.identity.bookId !== sample.book.id ||
        source.identity.chapterId !== sample.selected.id || source.identity.version !== expectedVersion ||
        (rerun ? source.identity.hash === sample.selected.hash : source.identity.hash !== sample.selected.hash) ||
        source.segments.length !== 1 || segment?.start !== 0 || segment.end !== expectedBody.length || segment.text !== expectedBody) {
      refuseFixture();
    }
    prepared = envelope;
    counts.preparations++;
  }

  function createReader(library: () => ReviewLibrary, providers: ReviewProviders): ReaderReviewServiceContract {
    const sdk = new AiSdkReviewTransport(undefined, (credential, modelId) => modelFor(credential, modelId, completionFetch));
    const service = new ReaderReviewService({
      library,
      providers: {
        list: () => { counts.readerLists++; return providers.list(); },
        models: (id) => { counts.readerModels++; return providers.models(id); },
        credential: (id) => { counts.readerCredentialReads++; return providers.credential(id); }
      },
      transport: {
        async run(input) {
          if (input.envelope !== prepared || counts.completionPosts + 1 !== counts.preparations) return refuseFixture();
          return sdk.run(input);
        }
      }
    });
    return {
      support: () => service.support(),
      async prepare(request) {
        const result = await service.prepare(request);
        if (result.kind === "ready") observePreparation(result.envelope);
        return result;
      },
      async start(request) {
        counts.starts++;
        const result = await service.start(request);
        lastStart = {
          kind: result.kind,
          reason: result.kind === "blocked" || result.kind === "failed" ? result.reason : null
        };
        return result;
      },
      async stop(request) {
        const result = await service.stop(request);
        if (result === "stopped") counts.stoppedRuns++;
        return result;
      },
      async cancelPrepare(request) {
        const result = await service.cancelPrepare(request);
        if (result === "cancelled") counts.cancelledPreparations++;
        return result;
      }
    };
  }

  const completionFetch: typeof fetch = Object.assign(async (input: string | URL | Request, init?: RequestInit) => {
    const request = fixtureRequest(input, init);
    const envelope = prepared;
    const source = envelope?.sources[0];
    const profile = envelope?.profile;
    if (!envelope || !profile || source?.kind !== "chapter" || counts.completionPosts + 1 !== counts.preparations ||
        counts.readerCredentialReads !== counts.preparations || request.method !== "POST" ||
        request.url !== sample.baseUrl + "/chat/completions" ||
        request.headers.get("authorization") !== "Bearer " + secret || request.signal.aborted) {
      return refuseFixture();
    }
    const wire = JSON.parse(serializeProviderRequest(envelope)) as { messages: unknown };
    let raw: string;
    let data: unknown;
    try {
      raw = await request.text();
      data = JSON.parse(raw);
    } catch {
      return refuseFixture();
    }
    if (!isDeepStrictEqual(data, { model: sample.book.defaultModelId, messages: wire.messages }) ||
        envelope !== prepared || counts.completionPosts + 1 !== counts.preparations || request.signal.aborted) {
      return refuseFixture();
    }
    counts.completionPosts++;
    // Record the admitted POST even if Stop later discards its reply.
    completedDigest = envelope.scopeDigest;
    requestHash = createHash("sha256").update(raw).digest("hex");
    const identity = { runId: envelope.requestId, readerId: profile.id, readerVersion: profile.version };
    const quote = {
      kind: "chapter", sourceId: source.sourceId, identity: source.identity,
      start: sample.quote.start, end: sample.quote.end, quote: sample.quote.text
    };
    const content = JSON.stringify({
      ...identity,
      findings: [{
        ...identity, findingId: "finding-1", category: "clarity", claim: "observation",
        interpretation: source.identity.version === 2 ? sample.revisedFinding : sample.finding,
        evidence: [quote, { ...quote, quote: "A mismatched quote" }, { ...quote, identity: { ...quote.identity, version: source.identity.version + 1 } }]
      }]
    });
    const response = Response.json({
      id: "chatcmpl-reader-fixture-" + counts.completionPosts, model: sample.book.defaultModelId, object: "chat.completion",
      created: 1_795_564_800,
      choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
      usage: { prompt_tokens: 100, completion_tokens: 40, total_tokens: 140 }
    });
    if (scenario === sample.stopScenario) {
      // Simulate the provider delivering a response after the request was aborted.
      await new Promise<void>(release => { heldResponse = { signal: request.signal, release }; });
      counts.lateResponses++;
    }
    return response;
  }, { preconnect: refuseFixture });

  return { snapshot, guardHost, seed, catalogueFetch, createReader, noteOutbound, refusePermission, releaseStoppedResponse };
}
