import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryVault } from "@ai-book-studio/core/providers/credentials";
import { Library } from "../src/main/library/store";
import { ProviderService } from "../src/main/providers";
import { admitReaderReviewCheck, createReaderReviewCheck, readerReviewCheckRequested } from "../src/main/review/reader-review-check";
import sample from "../src/main/review/reader-review-sample.json";
import { treeFingerprint } from "./support/tree-fingerprint";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(scenario = sample.scenario) {
  const scratch = await mkdtemp(join(await realpath(tmpdir()), sample.scratchPrefix));
  roots.push(scratch);
  const profile = join(scratch, "profile");
  const libraryRoot = join(scratch, "library");
  const books = join(libraryRoot, "books");
  const book = join(books, sample.book.id);
  const chapters = join(book, "chapters");
  const appPath = join(scratch, "apps", "desktop");
  const entry = join(appPath, "out", "main", "index.cjs");
  await mkdir(join(appPath, "out", "main"), { recursive: true });
  await writeFile(entry, "");
  for (const path of [profile, libraryRoot, books, book, chapters]) await mkdir(path, { mode: 0o700 });
  const settings = join(profile, "studio.json");
  await writeFile(settings, JSON.stringify({ libraryRoot }) + "\n", { mode: 0o600 });
  await writeFile(join(book, "book.json"), JSON.stringify(sample.book) + "\n", { mode: 0o600 });
  for (const chapter of [sample.first, sample.selected]) {
    const raw = [
      "---", "id: " + chapter.id, "title: " + chapter.title, "order: " + chapter.order, "version: 1",
      "createdAt: " + sample.book.createdAt, "updatedAt: " + sample.book.updatedAt, "---", "", chapter.body
    ].join("\n");
    await writeFile(join(chapters, chapter.filename), raw, { mode: 0o600 });
  }
  const launch = {
    env: {
      STUDIO_READER_REVIEW_CHECK: scenario, STUDIO_TEST: "1", STUDIO_HEADLESS: "1",
      STUDIO_TEST_MEMORY_VAULT: "1", STUDIO_USER_DATA: profile, STUDIO_WINDOW_SIZE: "1440x900"
    },
    packaged: false, headless: true, appPath, entry
  };
  return { scratch, profile, libraryRoot, chapters, settings, launch };
}

async function preparedFixture(scenario = sample.scenario) {
  const { launch, libraryRoot } = await fixture(scenario);
  admitReaderReviewCheck(launch);
  const library = await Library.open(libraryRoot);
  const before = await treeFingerprint(libraryRoot);
  const check = createReaderReviewCheck();
  const vault = new MemoryVault();
  await check.seed(vault);
  const providers = new ProviderService(vault, async () => { throw new Error("Unexpected external link"); }, check.catalogueFetch);
  const reader = check.createReader(() => library, providers);
  const prepared = await reader.prepare({
    operation: "prepare", prepareId: "prepare-fixture", bookId: sample.book.id, profileId: "reader-alpha", prompt: "",
    chapters: [{ chapterId: sample.selected.id, ranges: [{ start: 0, end: sample.selected.body.length }] }]
  });
  expect(prepared.kind).toBe("ready");
  if (prepared.kind !== "ready") throw new Error("Expected synthetic disclosure");
  return { libraryRoot, before, check, reader, prepared };
}

describe("reader check launch admission", () => {
  test("detects presence even when the requested scenario is empty", () => {
    expect(readerReviewCheckRequested({})).toBe(false);
    expect(readerReviewCheckRequested({ STUDIO_READER_REVIEW_CHECK: "" })).toBe(true);
    expect(readerReviewCheckRequested({ STUDIO_READER_REVIEW_CHECK: undefined })).toBe(true);
  });

  test("admits the exact private checkout entry, profile settings and synthetic bytes", async () => {
    const { profile, launch } = await fixture();
    expect(admitReaderReviewCheck(launch)).toBe(profile);
  });

  test.each([
    { STUDIO_READER_REVIEW_CHECK: "" }, { STUDIO_READER_REVIEW_CHECK: "unknown" }, { STUDIO_TEST: "0" },
    { STUDIO_HEADLESS: "0" }, { STUDIO_TEST_MEMORY_VAULT: "" }, { STUDIO_VISIBLE: "0" },
    { STUDIO_LIVE_CHECK: "" }, { STUDIO_BACKEND: "1" }, { STUDIO_SMOKE: "1" },
    { ELECTRON_RENDERER_URL: "" }, { ELECTRON_RUN_AS_NODE: "1" }
  ])("rejects conflicting flags before touching even a missing profile", async (override) => {
    const { launch } = await fixture();
    expect(() => admitReaderReviewCheck({ ...launch, env: { ...launch.env, STUDIO_USER_DATA: "/unavailable", ...override } }))
      .toThrow("Invalid reader fixture launch flags");
  });

  test("rejects packaged, effective visible and non-build launches", async () => {
    const { launch } = await fixture();
    expect(() => admitReaderReviewCheck({ ...launch, packaged: true })).toThrow();
    expect(() => admitReaderReviewCheck({ ...launch, headless: false })).toThrow();
    expect(() => admitReaderReviewCheck({ ...launch, entry: join(launch.appPath, "src", "main", "index.ts") })).toThrow();
  });

  test("rejects loose permissions, other settings, unexpected inventory and symlinked files", async () => {
    const { launch, profile, scratch, settings, chapters } = await fixture();
    await chmod(profile, 0o755);
    expect(() => admitReaderReviewCheck(launch)).toThrow();
    await chmod(profile, 0o700);
    await writeFile(settings, JSON.stringify({ libraryRoot: join(scratch, "wrong") }) + "\n");
    expect(() => admitReaderReviewCheck(launch)).toThrow();
    await writeFile(settings, JSON.stringify({ libraryRoot: join(scratch, "library") }) + "\n");
    const unexpected = join(chapters, "unexpected.md");
    await writeFile(unexpected, "synthetic");
    expect(() => admitReaderReviewCheck(launch)).toThrow();
    await rm(unexpected);
    const relocated = join(scratch, "other-settings");
    await writeFile(relocated, JSON.stringify({ libraryRoot: join(scratch, "library") }) + "\n", { mode: 0o600 });
    await rm(settings);
    await symlink(relocated, settings);
    expect(() => admitReaderReviewCheck(launch)).toThrow();
  });
});

describe("synthetic catalogue and completion boundaries", () => {
  test("refuses unrelated, early or malformed fixture fetches and counts every refusal", async () => {
    const check = createReaderReviewCheck();
    for (const url of ["https://unrelated.invalid", sample.baseUrl + "/models", "bad url"]) {
      await expect(check.catalogueFetch(url)).rejects.toThrow("Unexpected reader fixture request");
    }
    expect(check.snapshot()).toMatchObject({ catalogues: 0, completionPosts: 0, fixtureRefusals: 3, outboundAttempts: 0 });
  });

  test("real service and SDK bind one admitted POST to the exact prepared source", async () => {
    const { libraryRoot, before, check, reader, prepared } = await preparedFixture();
    expect(prepared.usage).toMatchObject({ books: 1, items: 1, sourceBytes: 124 });
    expect(prepared.priceFacts).toMatchObject({ inputPerMillion: 1.25, outputPerMillion: 4.25, cachedInputPerMillion: 0.15 });
    expect(prepared.envelope.environment.estimatedCostUsd).toBeNull();
    expect(check.snapshot()).toMatchObject({ catalogues: 1, preparations: 1, starts: 0, lastStart: null, readerCredentialReads: 0, completionPosts: 0 });
    const start = { operation: "start" as const, requestId: prepared.requestId, scopeDigest: prepared.scopeDigest };
    expect(await reader.start({ ...start, scopeDigest: "0".repeat(64) })).toMatchObject({ kind: "blocked", reason: "changed" });
    expect(check.snapshot()).toMatchObject({ starts: 1, lastStart: { kind: "blocked", reason: "changed" }, completionPosts: 0 });
    const completed = await reader.start(start);
    expect(completed.kind).toBe("completed");
    if (completed.kind !== "completed") throw new Error("Expected synthetic reader finding");
    expect(completed.run.findings).toHaveLength(1);
    const finding = completed.run.findings[0];
    expect(finding?.evidence).toHaveLength(1);
    expect(finding?.invalidEvidence).toHaveLength(2);
    expect(finding?.evidence[0]?.citation).toMatchObject({
      start: sample.quote.start, end: sample.quote.end, quote: sample.quote.text,
      identity: { chapterId: sample.selected.id, version: 1, hash: sample.selected.hash }
    });
    expect(sample.selected.body.indexOf(sample.quote.text)).toBe(13);
    expect(sample.selected.body.lastIndexOf(sample.quote.text)).toBe(sample.quote.start);
    expect(check.snapshot()).toMatchObject({ starts: 2, lastStart: { kind: "completed", reason: null } });
    expect(await reader.start(start)).toMatchObject({ kind: "blocked", reason: "changed" });
    expect(check.snapshot()).toMatchObject({
      catalogues: 1, preparations: 1, starts: 3, lastStart: { kind: "blocked", reason: "changed" },
      readerLists: 2, readerModels: 2, readerCredentialReads: 1,
      completionPosts: 1, fixtureRefusals: 0, outboundAttempts: 0,
      preparedDigest: prepared.scopeDigest, completedDigest: prepared.scopeDigest
    });
    expect(await treeFingerprint(libraryRoot)).toEqual(before);
  });

  test("a cancelled synthetic disclosure blocks its exact Start with no credential or completion", async () => {
    const { libraryRoot, before, check, reader, prepared } = await preparedFixture(sample.preStartScenario);
    expect(check.snapshot()).toMatchObject({ preparations: 1, cancelledPreparations: 0, completionPosts: 0 });
    expect(await reader.cancelPrepare({ operation: "cancelPrepare", prepareId: prepared.prepareId })).toBe("cancelled");
    expect(await reader.start({ operation: "start", requestId: prepared.requestId, scopeDigest: prepared.scopeDigest }))
      .toEqual({ kind: "blocked", reason: "changed" });
    expect(check.snapshot()).toMatchObject({
      catalogues: 1, preparations: 1, cancelledPreparations: 1, starts: 1, readerLists: 1, readerModels: 1,
      readerCredentialReads: 0, completionPosts: 0, fixtureRefusals: 0, outboundAttempts: 0,
      preparedDigest: prepared.scopeDigest, completedDigest: null, requestHash: null,
      lastStart: { kind: "blocked", reason: "changed" }
    });
    expect(await treeFingerprint(libraryRoot)).toEqual(before);
  });
});
