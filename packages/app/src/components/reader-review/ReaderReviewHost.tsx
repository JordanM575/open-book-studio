import { useEffect, useId, useRef, useState } from "react";
import type { BookDetail } from "@ai-book-studio/core/schema";
import { validateReviewEnvelope, type CurrentSource, type ReviewEnvelope } from "@ai-book-studio/core/review/envelope";
import type { ReaderReviewApi, ReaderReviewStopResult } from "@ai-book-studio/core/review/reader-api";
import { Button } from "@ai-book-studio/ui/button";
import {
  acceptPreparation, type PreparationOutcome, type StartOutcome
} from "./contracts";
import { ReaderReviewPanel } from "./ReaderReviewPanel";
import { reviewActionClass } from "./ReviewDisclosure";

const LOAD_FAILED = "The saved chapters could not be read. Close and reopen the review to try again. No provider request started.";

export interface ReaderReviewHostProps {
  bookId: string;
  /** Injected in focused tests; the workspace uses the preload `readerReview` surface. */
  api?: ReaderReviewApi;
  /** Injected in focused tests; the workspace reads through the existing book read channel. */
  loadBook?: (bookId: string) => Promise<BookDetail>;
}

type Surface = "closed" | "checking" | "ready" | "unsupported" | "error";

function newViewKey(): string {
  return globalThis.crypto.randomUUID();
}

/**
 * The author-facing entry and picker. It opens no provider path on mount or on rerender: only
 * Prepare and the provider-named Start in the leaf call the host service.
 */
export function ReaderReviewHost(props: ReaderReviewHostProps) {
  const headingId = useId();
  const contentId = useId();
  const [open, setOpen] = useState(false);
  const [surface, setSurface] = useState<Surface>("closed");
  const [detail, setDetail] = useState<BookDetail | null>(null);
  const [lens, setLens] = useState<"reader-alpha" | "reader-beta">("reader-alpha");
  const [selected, setSelected] = useState<readonly string[]>([]);
  const [prompt, setPrompt] = useState("");
  const [viewKey, setViewKey] = useState(newViewKey);
  const [currentSources, setCurrentSources] = useState<readonly CurrentSource[]>([]);
  const opener = useRef<HTMLButtonElement>(null);
  const pendingPrepare = useRef<string | null>(null);
  const hasOpened = useRef(false);

  const api = props.api ?? (typeof window !== "undefined" ? window.studio.readerReview : undefined);
  const loadBook = props.loadBook ?? (async (bookId: string) => {
    if (typeof window === "undefined") throw new Error("No book reader");
    const result = await window.studio.books.open(bookId);
    if (!result.ok) throw new Error(result.error.message);
    return result.data;
  });
  const apiRef = useRef(api);
  const loadRef = useRef(loadBook);
  apiRef.current = api;
  loadRef.current = loadBook;

  useEffect(() => {
    if (!open) {
      if (hasOpened.current) opener.current?.focus();
      return;
    }
    hasOpened.current = true;
    let live = true;
    setSurface("checking");
    setDetail(null);
    setSelected([]);
    setLens("reader-alpha");
    setPrompt("");
    setCurrentSources([]);
    const client = apiRef.current;
    if (!client) {
      setSurface("unsupported");
      return;
    }
    void (async () => {
      try {
        const support = await client.support();
        if (!live) return;
        if (!support.ok || !support.data.supported) {
          setSurface("unsupported");
          return;
        }
        const book = await loadRef.current(props.bookId);
        if (!live) return;
        setDetail(book);
        setSurface("ready");
      } catch {
        if (live) setSurface("error");
      }
    })();
    return () => { live = false; };
  }, [open, props.bookId]);

  useEffect(() => {
    if (!open) return;
    if (surface !== "ready" && surface !== "unsupported") return;
    document.querySelector<HTMLElement>("[data-reader-review-heading]")?.focus();
  }, [open, surface]);

  const disclosureRevision = JSON.stringify([props.bookId, lens, selected, prompt]);
  useEffect(() => {
    // This effect is the explicit revision-change boundary, not a read of the string itself.
    void disclosureRevision;
    const prepareId = pendingPrepare.current;
    pendingPrepare.current = null;
    setCurrentSources([]);
    if (prepareId) void apiRef.current?.cancelPrepare({ prepareId }).catch(() => undefined);
  }, [disclosureRevision]);

  function openReview() {
    setViewKey(newViewKey());
    setOpen(true);
  }

  function closeReview() {
    const prepareId = pendingPrepare.current;
    pendingPrepare.current = null;
    if (prepareId) void apiRef.current?.cancelPrepare({ prepareId }).catch(() => undefined);
    setOpen(false);
    setSurface("closed");
    setDetail(null);
    setCurrentSources([]);
  }

  function toggleChapter(chapterId: string) {
    setSelected((previous) => previous.includes(chapterId)
      ? previous.filter((id) => id !== chapterId)
      : [...previous, chapterId]);
  }

  async function prepare(): Promise<PreparationOutcome> {
    const client = apiRef.current;
    if (!client || !detail) throw new Error("Reader review is unavailable");
    if (pendingPrepare.current) {
      await client.cancelPrepare({ prepareId: pendingPrepare.current });
      pendingPrepare.current = null;
    }
    const prepareId = globalThis.crypto.randomUUID();
    const chapters = selected.map((chapterId) => {
      const chapter = detail.chapters.find((candidate) => candidate.id === chapterId);
      if (!chapter) throw new Error("The selected chapter is unavailable");
      return { chapterId, ranges: [{ start: 0, end: chapter.content.length }] };
    });
    const result = await client.prepare({ prepareId, bookId: props.bookId, profileId: lens, chapters, prompt });
    if (!result.ok) throw new Error(result.error.message);
    if (result.data.kind === "blocked") {
      return { kind: "blocked", reason: result.data.reason, ...(result.data.detail ? { detail: result.data.detail } : {}) };
    }
    pendingPrepare.current = result.data.prepareId;
    const envelope = await validateReviewEnvelope(result.data.envelope);
    const prepared = acceptPreparation({
      envelope, terms: result.data.terms, connection: result.data.connection, priceFacts: result.data.priceFacts
    }, props.bookId);
    setCurrentSources(envelope.sources.map((source) => ({ sourceId: source.sourceId, status: "available" as const, source })));
    return { kind: "ready", prepared };
  }

  async function startReview(envelope: ReviewEnvelope): Promise<StartOutcome> {
    const client = apiRef.current;
    if (!client) return { kind: "blocked", reason: "unavailable" };
    const result = await client.start({ requestId: envelope.requestId, scopeDigest: envelope.scopeDigest });
    pendingPrepare.current = null;
    if (!result.ok) throw new Error(result.error.message);
    if (result.data.kind === "completed") return { kind: "completed", run: result.data.run };
    if (result.data.kind === "blocked") {
      return { kind: "blocked", reason: result.data.reason, ...(result.data.detail ? { detail: result.data.detail } : {}) };
    }
    if (result.data.kind === "failed") return { kind: "failed", reason: result.data.reason };
    return { kind: "stopped" };
  }

  async function stopReview(requestId: string | null): Promise<ReaderReviewStopResult> {
    const client = apiRef.current;
    if (!client) return "unconfirmed";
    if (requestId) {
      const result = await client.stop({ requestId });
      return result.ok ? result.data : "unconfirmed";
    }
    const prepareId = pendingPrepare.current;
    pendingPrepare.current = null;
    if (!prepareId) return "not-started";
    const result = await client.cancelPrepare({ prepareId });
    // `cancelled` and `not-found` both mean no provider request started from this view.
    return result.ok ? "not-started" : "unconfirmed";
  }

  const busy = surface === "checking";
  return <section aria-labelledby={headingId} className="glass mb-4 rounded-[var(--corner-lg)] p-4 text-(length:--text-body-size)">
    <h2 id={headingId} className="text-(length:--text-title-3-size) font-semibold">Reader review</h2>
    {!open ? <>
      <p className="mt-1 text-muted-foreground">Suggestion-only feedback from a fictional reader lens, using only the saved chapters you select. Nothing starts automatically.</p>
      <Button ref={opener} className={`${reviewActionClass} mt-3`} aria-expanded={false} aria-controls={contentId} onClick={openReview}>Open reader review</Button>
    </> : <div id={contentId} className="mt-3 space-y-4">
      {surface === "unsupported" ? <ReaderReviewPanel open bookId={props.bookId} viewKey={viewKey} disclosureRevision={disclosureRevision}
        supported={false} prepareDisabled currentSources={[]} onPrepare={prepare} onStart={(input) => startReview(input.envelope)}
        onStop={(input) => stopReview(input.requestId)} onNavigate={async () => "unavailable"} onClose={closeReview} /> : null}
      {surface === "error" ? <p role="status" className="text-muted-foreground">{LOAD_FAILED}</p> : null}
      {surface === "checking" ? <p className="text-muted-foreground">Reading the saved chapter list…</p> : null}
      {surface === "ready" && detail ? <>
        <fieldset className="space-y-2">
          <legend className="font-semibold">Reader lens</legend>
          <label className="flex gap-2"><input type="radio" name="reader-lens" value="reader-alpha" checked={lens === "reader-alpha"} onChange={() => setLens("reader-alpha")} />
            <span>Alpha reader · structure, motivation and clarity</span></label>
          <label className="flex gap-2"><input type="radio" name="reader-lens" value="reader-beta" checked={lens === "reader-beta"} onChange={() => setLens("reader-beta")} />
            <span>Beta reader · reading experience, pacing and confusion</span></label>
        </fieldset>
        <fieldset className="space-y-2">
          <legend className="font-semibold">Saved chapters</legend>
          {detail.chapters.map((chapter) => <label key={chapter.id} className="flex gap-2">
            <input type="checkbox" checked={selected.includes(chapter.id)} onChange={() => toggleChapter(chapter.id)} />
            <span>Chapter {chapter.order}: {chapter.title} <span className="text-muted-foreground">Saved version {chapter.version} · {chapter.wordCount.toLocaleString("en-US")} words</span></span>
          </label>)}
          {detail.chapterReadIssues.map((issue) => <p key={issue.fileName} className="text-muted-foreground">Unavailable · {issue.fileName} · This file could not be read. It is not included.</p>)}
        </fieldset>
        <label className="block">
          <span className="font-semibold">Review request (optional)</span>
          <textarea className="field mt-1 w-full" rows={3} value={prompt} onChange={(event) => setPrompt(event.target.value)} />
          <span className="block text-muted-foreground">This text is sent with the selected chapters. It cannot change the selected scope or tools.</span>
        </label>
        <ReaderReviewPanel open bookId={props.bookId} viewKey={viewKey} disclosureRevision={disclosureRevision}
          supported={!busy} prepareDisabled={busy || selected.length === 0} currentSources={currentSources}
          onPrepare={prepare} onStart={(input) => startReview(input.envelope)} onStop={(input) => stopReview(input.requestId)}
          onNavigate={async () => "unavailable"} onClose={closeReview} />
      </> : null}
    </div>}
  </section>;
}
