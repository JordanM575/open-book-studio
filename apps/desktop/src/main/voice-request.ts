import { createHash } from "node:crypto";
import { ProviderError } from "@ai-book-studio/core/providers/types";
import type { StoredCredential } from "@ai-book-studio/core/providers/types";
import {
  speechCapability,
  speechModels,
  type SpeechCapability
} from "@ai-book-studio/core/providers/speech";
import {
  ttsCapability,
  ttsModels,
  type TtsCapability
} from "@ai-book-studio/core/providers/tts";
import type { VoiceOperationView } from "@ai-book-studio/core/ipc";
import { redact } from "@ai-book-studio/core/providers/redact";
import type { Route } from "../../../../packages/core/src/voice-session";
import { safeCounter } from "../../../../packages/core/src/voice-session";
import {
  VoiceCancelRegistry,
  type VoiceSettlement
} from "./voice-cancel-registry";
import type { SettingsStore } from "./settings";
import type { ProviderService } from "./providers";
import type { VoiceCancelReceipt } from "@ai-book-studio/core/ipc";

/*
 * Host-owned voice request identity (017 T016).
 *
 * The renderer may ask the studio to speak or transcribe; it may not choose the connection, the
 * model, the voice, the session or the revision. This module is the boundary: it mints one
 * public operation id per request, keeps the internal ledger id to itself, resolves and pins the
 * exact saved route, and refuses — before any fetch — when anything moved. It never reads audio,
 * text or secrets beyond what the request path needs, and it never persists anything.
 *
 * The renderer learns the id from the `voice:operation-event` starting view so it can cancel; it
 * can never use it as an authority for anything else.
 */

const MAX_RESERVATIONS = 8;
const MAX_RETIRED_VIEWS = 256;
const MAX_MESSAGE = 512;
const MAX_SAFE = Number.MAX_SAFE_INTEGER;

export const VOICE_BUSY_MESSAGE = "The studio is already starting another voice request. Wait for it to finish.";
export const VOICE_HISTORY_FULL_MESSAGE =
  "The studio's voice request history is full. Restart the studio before making another voice request; older receipts cannot be discarded.";
export const VOICE_BUSY_KIND_MESSAGE =
  "Another voice request of this kind is still settling. Wait for its receipt.";
export const VOICE_CHANGED_MID_REQUEST =
  "The voice settings changed while the request was starting. Nothing was sent.";
export const VOICE_WINDOW_CHANGED =
  "The studio window changed while the request was starting. Nothing was sent.";
export const VOICE_BEFORE_SEND =
  "Stopped before sending. No request was sent and there is no provider charge.";
export const VOICE_CANCELLED = "The request was cancelled before a reply arrived.";
export const VOICE_UNEXPECTED = "The voice request failed unexpectedly.";
const STT_MISSING = "Choose a transcription connection and model in Settings before using dictation.";
export const VOICE_STT_SELECTION_CHANGED =
  "The transcription selection changed during dictation. Record again with the current selection.";
const TTS_MISSING = "Choose a speaking connection, model and voice in Settings before asking the studio to speak.";

function bounded(text: string): string {
  const clean = redact(text).replace(/\s+/g, " ").trim();
  return clean.length > MAX_MESSAGE ? `${clean.slice(0, MAX_MESSAGE - 1)}…` : clean;
}

function destinationFor(endpoint: string): string {
  return `endpoint:${createHash("sha256").update(endpoint).digest("hex").slice(0, 16)}`;
}

/** The pinned route and everything the request is allowed to use. Main-process only. */
export interface ResolvedVoiceRoute {
  readonly route: Route;
  readonly connectionLabel: string;
  readonly capability: SpeechCapability | TtsCapability;
  /** Main-only. Never crosses to the renderer. */
  readonly credential: StoredCredential;
}

export interface VoiceRequestScope {
  readonly requestId: number;
  readonly kind: "stt" | "tts";
  /** The reservation's abort signal, shared with the owning ledger chunk. */
  readonly signal: AbortSignal;
  /** Re-resolve the saved route and compare it with the pinned one. Throws VoiceRefusal. */
  recheck(): Promise<ResolvedVoiceRoute>;
  /**
   * Allocate the next ledger chunk and pass the final gate. Returns the chunk id and the local
   * abort signal, or null when the ledger will not open the chunk (cancelled, refused or full).
   */
  chunk(): { chunkId: number; signal: AbortSignal } | null;
  /** Record the local outcome for a dispatched chunk. A no-op for unknown chunks. */
  settle(chunkId: number, settlement: VoiceSettlement): void;
  /** Refuse before any dispatch. Settled or dispatched chunks make this a no-op. */
  refuse(reason: string): void;
  /** The renderer-safe projection of this operation as it stands right now. */
  view(): VoiceOperationView | null;
  /** Close the ledger out after an unexpected internal failure; settles any open chunk. */
  failUnexpected(): VoiceOperationView | null;
}

/** A local, bounded refusal. The message is safe to show; it never carries a secret. */
export class VoiceRefusal extends Error {
  constructor(message: string) {
    super(bounded(message));
    this.name = "VoiceRefusal";
  }
}

export type VoiceBeginResult =
  | { ok: true; scope: VoiceRequestScope }
  | { ok: false; status: "refusal" | "cancellation"; message: string; receipt: VoiceOperationView | null };

export interface VoiceReservation {
  readonly publicId: number;
  readonly kind: "stt" | "tts";
  readonly planned: number;
  readonly ownerWindowId: number;
  readonly expectedSelection?: { connectionId: string; model: string };
  readonly controller: AbortController;
  state: "waiting" | "resolving" | "began" | "closed";
}

/**
 * Resolves and pins the exact saved route for one voice request, and re-resolves it on demand.
 * It never enumerates capable connections to pick one, never substitutes a model or voice, and
 * never reads a credential except on the first resolution.
 */
export class VoiceRouteAuthority {
  private revision = 1;

  constructor(
    private readonly settings: Pick<SettingsStore, "voicePreferences">,
    private readonly providers: Pick<ProviderService, "list" | "credential">
  ) {}

  current(): number {
    return this.revision;
  }

  canBump(): boolean {
    return this.revision < MAX_SAFE;
  }

  /** Bump on every voice-settings write and every connection removal, including A→B→A. */
  bump(): boolean {
    if (!this.canBump()) return false;
    this.revision += 1;
    return true;
  }

  async resolveInitial(
    kind: "stt" | "tts",
    expected: { connectionId: string; model: string } | undefined,
    signal: AbortSignal
  ): Promise<ResolvedVoiceRoute> {
    const prefs = this.settings.voicePreferences();
    const revision = this.revision;
    const pinned = async (capability: SpeechCapability | TtsCapability, credential: StoredCredential,
      connectionId: string, provider: string, model: string, voice: string | null, label: string): Promise<ResolvedVoiceRoute> => {
      if (this.revision !== revision) throw new VoiceRefusal(VOICE_CHANGED_MID_REQUEST);
      const destination = destinationFor(capability.endpoint);
      return {
        route: { connectionId, provider, model, destination, voice, revision },
        connectionLabel: label,
        capability,
        credential
      };
    };
    if (kind === "stt") {
      const selected = prefs.transcription;
      if (!selected.connectionId || !selected.model) throw new VoiceRefusal(STT_MISSING);
      if (expected && (expected.connectionId !== selected.connectionId || expected.model !== selected.model)) {
        throw new VoiceRefusal(VOICE_STT_SELECTION_CHANGED);
      }
      const connections = await this.providers.list();
      this.throwIfAborted(signal);
      if (this.revision !== revision) throw new VoiceRefusal(VOICE_CHANGED_MID_REQUEST);
      const connection = connections.find((entry) => entry.id === selected.connectionId);
      if (!connection) {
        throw new VoiceRefusal("That transcription connection is unavailable. Choose another in Settings.");
      }
      const credential = await this.providers.credential(connection.id);
      this.throwIfAborted(signal);
      if (this.revision !== revision) throw new VoiceRefusal(VOICE_CHANGED_MID_REQUEST);
      const capability = speechCapability(credential.provider, credential.metadata?.baseUrl, selected.model);
      if (!capability) {
        throw new VoiceRefusal("The saved transcription model does not match that connection. Choose a supported model in Settings.");
      }
      return pinned(capability, credential, connection.id, credential.provider, capability.model, null, bounded(connection.label));
    }
    const selected = prefs.speaking;
    if (!selected.connectionId || !selected.model || !selected.voice) throw new VoiceRefusal(TTS_MISSING);
    const connections = await this.providers.list();
    this.throwIfAborted(signal);
    if (this.revision !== revision) throw new VoiceRefusal(VOICE_CHANGED_MID_REQUEST);
    const connection = connections.find((entry) => entry.id === selected.connectionId);
    if (!connection) {
      throw new VoiceRefusal("That speaking connection is unavailable. Choose another in Settings.");
    }
    const credential = await this.providers.credential(connection.id);
    this.throwIfAborted(signal);
    if (this.revision !== revision) throw new VoiceRefusal(VOICE_CHANGED_MID_REQUEST);
    const capability = ttsCapability(credential.provider, credential.metadata?.baseUrl, selected.model);
    if (!capability) {
      throw new VoiceRefusal("The saved speaking model does not match that connection. Choose a supported model in Settings.");
    }
    if (!capability.voices.includes(selected.voice)) {
      throw new VoiceRefusal("The saved voice is not supported by that model. Choose a voice in Settings.");
    }
    return pinned(
      capability, credential, connection.id, credential.provider,
      capability.model, selected.voice, bounded(connection.label),
    );
  }

  /**
   * Re-resolve against the pinned route. The credential is not read again; the catalog checks
   * are local. Any drift refuses before the caller may dispatch.
   */
  async recheck(
    kind: "stt" | "tts",
    pinned: ResolvedVoiceRoute,
    expected: { connectionId: string; model: string } | undefined,
    signal: AbortSignal
  ): Promise<ResolvedVoiceRoute> {
    this.throwIfAborted(signal);
    const prefs = this.settings.voicePreferences();
    const connections = await this.providers.list();
    this.throwIfAborted(signal);
    const revisionNow = this.revision;
    if (revisionNow !== pinned.route.revision) throw new VoiceRefusal(VOICE_CHANGED_MID_REQUEST);
    if (kind === "stt") {
      const selected = prefs.transcription;
      if (!selected.connectionId || !selected.model) throw new VoiceRefusal(STT_MISSING);
      if (expected && (expected.connectionId !== selected.connectionId || expected.model !== selected.model)) {
        throw new VoiceRefusal(VOICE_STT_SELECTION_CHANGED);
      }
      if (selected.connectionId !== pinned.route.connectionId || selected.model !== pinned.route.model) {
        throw new VoiceRefusal(VOICE_STT_SELECTION_CHANGED);
      }
      const connection = connections.find((entry) => entry.id === selected.connectionId);
      if (!connection) {
        throw new VoiceRefusal("That transcription connection is unavailable. Choose another in Settings.");
      }
      if (connection.provider !== pinned.route.provider) {
        throw new VoiceRefusal(VOICE_CHANGED_MID_REQUEST);
      }
      if (!speechModels(connection.provider).some((choice) => choice.id === selected.model)) {
        throw new VoiceRefusal("The saved transcription model does not match that connection. Choose a supported model in Settings.");
      }
      return { ...pinned, route: { ...pinned.route, revision: revisionNow } };
    }
    const selected = prefs.speaking;
    if (!selected.connectionId || !selected.model || !selected.voice) throw new VoiceRefusal(TTS_MISSING);
    if (selected.connectionId !== pinned.route.connectionId ||
        selected.model !== pinned.route.model ||
        selected.voice !== pinned.route.voice) {
      throw new VoiceRefusal("The speaking selection or connection changed before the next part. Nothing more was sent.");
    }
    const connection = connections.find((entry) => entry.id === selected.connectionId);
    if (!connection) {
      throw new VoiceRefusal("That speaking connection is unavailable. Choose another in Settings.");
    }
    if (connection.provider !== pinned.route.provider) {
      throw new VoiceRefusal(VOICE_CHANGED_MID_REQUEST);
    }
    const model = ttsModels(connection.provider).find((choice) => choice.id === selected.model);
    if (!model) {
      throw new VoiceRefusal("The saved speaking model does not match that connection. Choose a supported model in Settings.");
    }
    if (!model.voices.includes(selected.voice)) {
      throw new VoiceRefusal("The saved voice is not supported by that model. Choose a voice in Settings.");
    }
    return { ...pinned, route: { ...pinned.route, revision: revisionNow } };
  }

  private throwIfAborted(signal: AbortSignal): void {
    if (signal.aborted) throw new VoiceRefusal(VOICE_CANCELLED);
  }
}

/** One in flight reservation, before the ledger slot exists. */
interface ReservationInternal extends VoiceReservation {
  closedView: VoiceOperationView | null;
}

const NOOP_RECEIPT = (operationId: number): VoiceCancelReceipt => ({
  operationId, accepted: false, abortedLocally: false, released: false
});

export class VoiceRequestHost {
  private readonly reservations = new Map<number, ReservationInternal>();
  private readonly retired = new Map<number, VoiceOperationView>();
  /** Ids whose settled view was already emitted, so a cancel plus a late settle cannot double-fire. */
  private readonly settledEmitted = new Set<number>();
  private nextRequestId = 1;

  constructor(
    readonly deps: {
      registry: VoiceCancelRegistry;
      routes: VoiceRouteAuthority;
      /** Emit to the owning window only; the window may be gone, in which case this is a no-op. */
      emit: (ownerWindowId: number, view: VoiceOperationView) => void;
      /** True while the owning window is still the current studio window. */
      isOwnerCurrent: (ownerWindowId: number) => boolean;
      now?: () => number;
    }
  ) {}

  /**
   * Reserve a public id before any await so the renderer can cancel while the route is still
   * resolving. Refuses at capacity without minting anything.
   */
  reserve(
    kind: "stt" | "tts",
    planned: number,
    ownerWindowId: number,
    expectedSelection?: { connectionId: string; model: string }
  ): VoiceReservation | null {
    let pending = 0;
    for (const entry of this.reservations.values()) {
      if (entry.state !== "began") pending += 1;
      if (pending >= MAX_RESERVATIONS) return null;
    }
    if (!safeCounter(planned) || planned < 1) return null;
    const publicId = this.nextRequestId;
    this.nextRequestId += 1;
    if (this.nextRequestId > MAX_SAFE) this.nextRequestId = 1; // wraps only after 2^53 mints; ids stay unique per process
    const reservation: ReservationInternal = {
      publicId, kind, planned, ownerWindowId,
      ...(expectedSelection ? { expectedSelection } : {}),
      controller: new AbortController(),
      state: "waiting",
      closedView: null
    };
    this.reservations.set(publicId, reservation);
    this.emit(ownerWindowId, this.transientView(reservation, "starting", null));
    return reservation;
  }

  /**
   * Live read of the reservation state. TypeScript narrows `reservation.state` on the
   * fall-through of the pre-await guard, but a concurrent cancel may close the reservation
   * during the await — always re-read through this helper after one.
   */
  private stateOf(reservation: VoiceReservation): VoiceReservation["state"] {
    return (reservation as ReservationInternal).state;
  }

  /**
   * Resolve the exact saved route, then hand the reservation to the ledger. On any failure the
   * ledger slot is never created; on cancellation the reservation closes as a local cancellation.
   */
  async begin(reservation: VoiceReservation, expected?: { connectionId: string; model: string }): Promise<VoiceBeginResult> {
    const internal = reservation as ReservationInternal;
    // A cancel may have closed this reservation before begin() ran; do not resurrect it.
    if (reservation.state === "closed" || reservation.controller.signal.aborted || !this.reservations.has(reservation.publicId)) {
      const view = reservation.state === "closed"
        ? internal.closedView ?? this.fallbackView(reservation, "cancellation", VOICE_BEFORE_SEND)
        : this.closeReservation(reservation, "cancellation", VOICE_BEFORE_SEND, false);
      return { ok: false, status: "cancellation", message: view.message ?? VOICE_BEFORE_SEND, receipt: view };
    }
    internal.state = "resolving";
    const expectedSelection = expected ?? reservation.expectedSelection;
    let pinned: ResolvedVoiceRoute | null = null;
    try {
      pinned = await this.deps.routes.resolveInitial(reservation.kind, expectedSelection, reservation.controller.signal);
    } catch (error) {
      if (reservation.controller.signal.aborted || this.stateOf(reservation) === "closed") {
        // Closed by a concurrent cancel; nothing was sent.
        const view = this.stateOf(reservation) === "closed"
          ? internal.closedView ?? this.fallbackView(reservation, "cancellation", VOICE_BEFORE_SEND)
          : this.closeReservation(reservation, "cancellation", VOICE_BEFORE_SEND, false);
        return { ok: false, status: "cancellation", message: view.message ?? VOICE_BEFORE_SEND, receipt: view };
      }
      const message = error instanceof VoiceRefusal
        ? error.message
        : error instanceof ProviderError
          ? error.message
          : VOICE_UNEXPECTED;
      const view = this.closeReservation(reservation, "refusal", message, true);
      return { ok: false, status: "refusal", message: view.message ?? message, receipt: view };
    }
    if (reservation.controller.signal.aborted || !this.reservations.has(reservation.publicId)) {
      const view = this.closeReservation(reservation, "cancellation", VOICE_BEFORE_SEND, false);
      return { ok: false, status: "cancellation", message: view.message ?? VOICE_BEFORE_SEND, receipt: view };
    }
    if (!this.deps.isOwnerCurrent(reservation.ownerWindowId)) {
      const view = this.closeReservation(reservation, "cancellation", VOICE_WINDOW_CHANGED, false);
      return { ok: false, status: "cancellation", message: view.message ?? VOICE_WINDOW_CHANGED, receipt: view };
    }
    const publicId = reservation.publicId;
    const facts = this.factsFor(publicId, reservation.ownerWindowId, reservation.controller.signal, pinned);
    const internalId = this.deps.registry.begin(reservation.kind, reservation.planned, facts);
    if (internalId === null) {
      const reason = this.deps.registry.beginRefusal() ?? "";
      const message = reason.includes("history is full")
        ? VOICE_HISTORY_FULL_MESSAGE
        : reason.includes("Another operation of this kind")
          ? VOICE_BUSY_KIND_MESSAGE
          : "The voice request could not start. Try again.";
      const view = this.closeReservation(reservation, "refusal", message, true);
      return { ok: false, status: "refusal", message: view.message ?? message, receipt: view };
    }
    internal.state = "began";
    this.deps.registry.bind(publicId, internalId, {
      ownerWindowId: reservation.ownerWindowId,
      kind: reservation.kind,
      connectionLabel: pinned.connectionLabel,
      model: pinned.route.model,
      voice: pinned.route.voice
    });
    const scope = new RequestScope(
      this, reservation, internalId, pinned, expectedSelection
    );
    return { ok: true, scope };
  }

  /** Cancel by public id. A foreign or unknown id is an honest no-op. */
  cancel(ownerWindowId: number, operationId: number, reason?: string): VoiceCancelReceipt {
    const reservation = this.reservations.get(operationId);
    if (reservation) {
      if (reservation.ownerWindowId !== ownerWindowId) return NOOP_RECEIPT(operationId);
      reservation.controller.abort(reason ?? "Cancelled.");
      if (reservation.state !== "began") {
        // Never reached the ledger: a purely local stop. Nothing was sent.
        this.closeReservation(reservation, "cancellation", VOICE_BEFORE_SEND, false);
        return { operationId, accepted: true, abortedLocally: false, released: true };
      }
      // Began: abort the local chunk via the ledger and let the operation close there.
      const receipt = this.deps.registry.cancelRequest(operationId, ownerWindowId, reason);
      this.emitViewIfAny(ownerWindowId, operationId);
      return receipt;
    }
    const owner = this.deps.registry.ownerOf(operationId);
    if (owner === null || owner !== ownerWindowId) return NOOP_RECEIPT(operationId);
    const receipt = this.deps.registry.cancelRequest(operationId, ownerWindowId, reason);
    if (receipt.accepted) this.emitViewIfAny(ownerWindowId, operationId);
    return receipt;
  }

  /** The renderer-safe view for one public id, or null when it is unknown. */
  operation(ownerWindowId: number, operationId: number): VoiceOperationView | null {
    const reservation = this.reservations.get(operationId);
    if (reservation && reservation.state !== "began") {
      if (reservation.ownerWindowId !== ownerWindowId) return null;
      return this.transientView(reservation, "starting", null);
    }
    const owner = this.deps.registry.ownerOf(operationId);
    if (owner !== null && owner !== ownerWindowId) return null;
    const live = this.deps.registry.view(operationId);
    if (live) {
      if (live.phase === "settled") this.reservations.delete(operationId);
      return live;
    }
    const retired = this.retired.get(operationId);
    if (retired) {
      // Refresh the revision so a stale renderer copy does not win.
      return { ...retired, viewRevision: this.deps.registry.mintViewRevision() };
    }
    return null;
  }

  /** Emit the settled view for a view whose record just became terminal, if any. */
  private emitViewIfAny(ownerWindowId: number, operationId: number): void {
    const view = this.deps.registry.view(operationId);
    if (!view) return;
    if (view.phase === "settled") {
      this.emitSettled(ownerWindowId, view);
      return;
    }
    this.emit(ownerWindowId, view);
  }

  /** Emit a settled view for a finished operation. Called after a service resolves. */
  emitSettled(ownerWindowId: number, view: VoiceOperationView): void {
    if (view.status === null) return;
    if (this.settledEmitted.has(view.operationId)) return;
    if (this.settledEmitted.size >= 1024) {
      const oldest = this.settledEmitted.values().next().value;
      if (oldest !== undefined) this.settledEmitted.delete(oldest);
    }
    this.settledEmitted.add(view.operationId);
    this.reservations.delete(view.operationId);
    this.emit(ownerWindowId, view);
  }

  /** Bump the route revision; used after voice-settings writes and connection removals. */
  bumpRoutes(): void {
    if (!this.deps.routes.bump()) {
      throw new ProviderError(
        "invalid-request",
        "The studio cannot safely change voice settings again in this session. Restart the studio to continue."
      );
    }
  }

  mintViewRevision(): number {
    return this.deps.registry.mintViewRevision();
  }

  emit(ownerWindowId: number, view: VoiceOperationView): void {
    this.deps.emit(ownerWindowId, view);
  }

  /** Facts the ledger rechecks before every dispatch. */
  factsFor(
    publicId: number,
    ownerWindowId: number,
    signal: AbortSignal,
    pinned: ResolvedVoiceRoute
  ) {
    return {
      now: this.now(),
      session: { sessionId: `voice-req-${publicId}`, generation: 1 },
      route: { ...pinned.route, revision: this.deps.routes.current() },
      permitted: this.deps.isOwnerCurrent(ownerWindowId) && !signal.aborted
    };
  }

  /** Internal: close a reservation that never reached the ledger. */
  closeReservation(
    reservation: VoiceReservation,
    status: "refusal" | "cancellation",
    message: string,
    store: boolean
  ): VoiceOperationView {
    const internal = reservation as ReservationInternal;
    if (internal.state === "closed" && internal.closedView) return internal.closedView;
    internal.state = "closed";
    this.reservations.delete(internal.publicId);
    const view: VoiceOperationView = {
      operationId: internal.publicId,
      viewRevision: this.mintViewRevision(),
      kind: internal.kind,
      phase: "settled",
      status,
      cancelled: status === "cancellation",
      connectionLabel: "",
      model: "",
      voice: null,
      plannedChunks: internal.planned,
      dispatchedChunks: 0,
      settledChunks: 0,
      unsentChunks: internal.planned,
      charge: { state: "none" },
      message: bounded(message),
      finalChunkOutcome: null
    };
    internal.closedView = view;
    if (store) this.storeRetired(view);
    this.emit(internal.ownerWindowId, view);
    return view;
  }

  transientView(
    reservation: VoiceReservation,
    phase: "starting" | "cancelling",
    pinned: ResolvedVoiceRoute | null
  ): VoiceOperationView {
    return {
      operationId: reservation.publicId,
      viewRevision: this.mintViewRevision(),
      kind: reservation.kind,
      phase,
      status: null,
      cancelled: phase === "cancelling",
      connectionLabel: pinned?.connectionLabel ?? "",
      model: pinned?.route.model ?? "",
      voice: pinned?.route.voice ?? null,
      plannedChunks: reservation.planned,
      dispatchedChunks: 0,
      settledChunks: 0,
      unsentChunks: 0,
      charge: { state: "pending" },
      message: null,
      finalChunkOutcome: null
    };
  }

  private storeRetired(view: VoiceOperationView): void {
    if (this.retired.size >= MAX_RETIRED_VIEWS) {
      const oldest = this.retired.keys().next().value;
      if (oldest !== undefined) this.retired.delete(oldest);
    }
    this.retired.set(view.operationId, view);
  }

  private fallbackView(
    reservation: VoiceReservation,
    status: "refusal" | "cancellation",
    message: string
  ): VoiceOperationView {
    return {
      operationId: reservation.publicId,
      viewRevision: this.mintViewRevision(),
      kind: reservation.kind,
      phase: "settled",
      status,
      cancelled: status === "cancellation",
      connectionLabel: "",
      model: "",
      voice: null,
      plannedChunks: reservation.planned,
      dispatchedChunks: 0,
      settledChunks: 0,
      unsentChunks: reservation.planned,
      charge: { state: "none" },
      message: bounded(message),
      finalChunkOutcome: null
    };
  }

  private now(): number {
    return Math.floor(this.deps.now?.() ?? Date.now());
  }
}

/** One in-flight request. Handed to the provider services; never leaves the main process. */
class RequestScope implements VoiceRequestScope {
  readonly requestId: number;
  readonly kind: "stt" | "tts";
  readonly signal: AbortSignal;
  private pinned: ResolvedVoiceRoute;
  private openChunkId: number | null = null;
  private readonly ownerWindowId: number;

  constructor(
    private readonly host: VoiceRequestHost,
    reservation: VoiceReservation,
    private readonly internalId: number,
    pinned: ResolvedVoiceRoute,
    private readonly expectedSelection: { connectionId: string; model: string } | undefined
  ) {
    this.requestId = reservation.publicId;
    this.kind = reservation.kind;
    this.ownerWindowId = reservation.ownerWindowId;
    this.signal = reservation.controller.signal;
    this.pinned = pinned;
  }

  async recheck(): Promise<ResolvedVoiceRoute> {
    if (this.signal.aborted) {
      this.host.deps.registry.cancel(this.internalId, "Cancelled.");
      throw new VoiceRefusal(VOICE_CANCELLED);
    }
    const fresh = await this.host.deps.routes.recheck(this.kind, this.pinned, this.expectedSelection, this.signal);
    this.pinned = fresh;
    return fresh;
  }

  chunk(): { chunkId: number; signal: AbortSignal } | null {
    const chunkId = this.host.deps.registry.queue(this.internalId);
    if (chunkId === null) return null;
    const facts = this.host.factsFor(this.requestId, this.ownerWindowId, this.signal, this.pinned);
    const dispatch = this.host.deps.registry.dispatch(this.internalId, chunkId, facts);
    if (!dispatch.sent || !dispatch.signal) return null;
    this.openChunkId = chunkId;
    const view = this.view();
    if (view && view.dispatchedChunks === 1) this.host.emit(this.ownerWindowId, { ...view, phase: "in-flight" });
    return { chunkId, signal: dispatch.signal };
  }

  settle(chunkId: number, settlement: VoiceSettlement): void {
    const redacted: VoiceSettlement = settlement.failure === undefined
      ? settlement
      : { ...settlement, failure: redact(settlement.failure) };
    this.host.deps.registry.settle(this.internalId, chunkId, redacted);
    if (this.openChunkId === chunkId) this.openChunkId = null;
  }

  refuse(reason: string): void {
    this.host.deps.registry.refuse(this.internalId, redact(reason));
  }

  view(): VoiceOperationView | null {
    return this.host.deps.registry.view(this.requestId);
  }

  failUnexpected(): VoiceOperationView | null {
    if (this.openChunkId !== null) {
      this.settle(this.openChunkId, { outcome: "failure", failure: VOICE_UNEXPECTED });
    } else {
      this.refuse(VOICE_UNEXPECTED);
    }
    return this.view();
  }

}
