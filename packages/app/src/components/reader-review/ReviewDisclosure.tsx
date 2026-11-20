import { reviewResourceUsage, type ReviewEnvelope } from "@ai-book-studio/core/review/envelope";
import type { ReaderProfile } from "@ai-book-studio/core/review/profiles";
import type { PreparedReaderReview } from "./contracts";

export const reviewActionClass = "min-h-11 whitespace-normal focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ring)]";
export const reviewTextClass = "whitespace-pre-wrap break-words text-(length:--text-subheadline-size)";

function count(value: number): string {
  return value.toLocaleString("en-US");
}

function price(value: number): string {
  return `$${value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 6 })}`;
}

function priceFactsCopy(prepared: PreparedReaderReview): string {
  const facts = prepared.priceFacts;
  if (facts.kind === "plan") return "Price facts: ChatGPT plan usage · No per-token price is shown for this connection.";
  if (facts.kind === "unknown") return "Price facts: Unknown · The provider does not report a price for this model.";
  const fields = [
    `Input ${facts.inputPerMillion === null ? "not reported" : `${price(facts.inputPerMillion)} per million tokens`}`,
    `Output ${facts.outputPerMillion === null ? "not reported" : `${price(facts.outputPerMillion)} per million tokens`}`,
    `Cached input ${facts.cachedInputPerMillion === null ? "not reported" : `${price(facts.cachedInputPerMillion)} per million tokens`}`
  ];
  if (facts.asOf) fields.push(`As of ${facts.asOf}`);
  return `Price facts: ${fields.join(" · ")}`;
}

export function ProfileAttribution({ profile }: { profile: ReaderProfile }) {
  return <div className="space-y-2">
    <p className="font-semibold">{profile.name} · Version {profile.version} · {profile.origin === "builtin" ? "Fictional built-in lens" : "Author profile"}</p>
    <p className="text-muted-foreground">Profile identity: {profile.id}</p>
    <p className={reviewTextClass}>{profile.purpose}</p>
    <p>Focus: {profile.focus.map((category) => category.replaceAll("-", " ")).join(" · ")}</p>
    <details><summary className={reviewActionClass}>Read profile guidance</summary><p className={reviewTextClass}>{profile.guidance || "No additional guidance."}</p></details>
  </div>;
}

export function SelectedScope({ envelope }: { envelope: ReviewEnvelope }) {
  return <ul className="space-y-4" aria-label="Exact selected saved scope">
    {envelope.sources.map((source) => <li key={source.sourceId} className="space-y-2">
      {source.kind === "chapter" ? <>
        <p className="font-semibold">{source.bookTitle} · Chapter {source.position}: {source.title}</p>
        <p className="text-muted-foreground">Saved version {source.identity.version} · Captured {source.capturedAt}</p>
        {source.segments.map((segment) => <div key={segment.start}>
          <p>Lines {segment.startLine}–{segment.startLine + segment.text.slice(0, -1).split("\n").length - 1} · UTF-16 range [{segment.start}, {segment.end})</p>
          <pre className={reviewTextClass}>{segment.text}</pre>
        </div>)}
      </> : <>
        <p className="font-semibold">{source.bookTitle} · Story Bible · {source.label}</p>
        <p className="text-muted-foreground">Selected field · Captured {source.capturedAt}</p>
        <pre className={reviewTextClass}>{source.text}</pre>
      </>}
    </li>)}
  </ul>;
}

export function ReviewDisclosure({ prepared }: { prepared: PreparedReaderReview }) {
  const { envelope, terms, connection, priceFacts } = prepared;
  const { environment } = envelope;
  const usage = reviewResourceUsage(envelope);
  const ready = environment.hostSupported && environment.connectionAvailable && environment.modelSupported;
  const cost = priceFacts.kind === "plan"
    ? "Estimated cost: Plan usage · No dollar cost shown · Not a spending cap"
    : environment.estimatedCostUsd === null
      ? "Estimated cost: Unknown · Not a spending cap"
      : `Estimated cost: USD ${environment.estimatedCostUsd} · Not a spending cap`;
  return <section aria-label="Outgoing review disclosure" className="space-y-4">
    <h4 className="font-semibold">Inspect what will be sent</h4>
    <p>Provider: {connection.providerName} · Model: {connection.modelName}</p>
    <p>Connection: {connection.label}</p>
    <details>
      <summary className={reviewActionClass}>Exact destination details</summary>
      <p>Model id: {envelope.destination.model}</p>
      <p>Connection id: {envelope.destination.connectionId}</p>
      <p>Endpoint identity: {envelope.destination.endpointIdentity}</p>
    </details>
    <p>{cost}</p>
    <p className="text-muted-foreground">{priceFactsCopy(prepared)}</p>
    <p>Context fit: Unknown · The selected scope is counted in bytes, not tokens.</p>
    <p>Catalog context: {environment.catalogContextTokens === null ? "Unknown" : `${environment.catalogContextTokens} tokens`} · Catalog facts: {environment.catalogAsOf ?? "Unknown"}</p>
    <p>Destination readiness: {ready ? "Available" : "Unavailable"}</p>
    <p>Tools: None offered; the selected text is included up front.</p>
    <p>Selected scope: {count(usage.books)} book · {count(usage.items)} source {usage.items === 1 ? "item" : "items"} · {count(usage.sourceBytes)} of {count(usage.limits.sourceBytes)} source-text bytes · {count(usage.combinedBytes)} of {count(usage.limits.contentBytes)} combined bytes · {count(usage.requestBytes)} of {count(usage.limits.requestBytes)} request bytes.</p>
    {envelope.profile ? <ProfileAttribution profile={envelope.profile} /> : null}
    <SelectedScope envelope={envelope} />
    <div><h4 className="font-semibold">Review request</h4><p className={reviewTextClass}>{envelope.prompt || "No additional request."}</p></div>
    <div><h4 className="font-semibold">Selected prior feedback</h4>
      {envelope.priorFeedback.length === 0 ? <p>None selected.</p> : envelope.priorFeedback.map((feedback) =>
        <div key={feedback.id}><p>{feedback.label} · Run {feedback.runId}</p><p className={reviewTextClass}>{feedback.text}</p></div>)}
    </div>
    {terms.map((term) => <div key={term.bookId} className="space-y-2">
      <h4 className="font-semibold">{envelope.books.find((book) => book.bookId === term.bookId)?.title} · Provider terms</h4>
      <p className={reviewTextClass}>Data use: {term.dataUse}</p>
      <p className={reviewTextClass}>Training: {term.training}</p>
      <p>Terms revision: {term.termsRevision} · Required consent: {envelope.books.find((book) => book.bookId === term.bookId)?.consentSatisfied ? "Satisfied" : "Missing"}</p>
    </div>)}
    <p className="text-muted-foreground">Only this selected saved text, profile, request and selected feedback are included. Starting may incur cost. No automatic retry or model fallback. The studio cannot promise a maximum charge for this request. Terms are shown as the provider publishes them; this is not a legal guarantee.</p>
  </section>;
}
