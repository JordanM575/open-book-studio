import {
  APICallError,
  ToolLoopAgent,
  isStepCount,
  type LanguageModel,
  type ModelMessage,
  type ToolApprovalResponse,
  type ToolSet
} from "ai";
import {
  AGENT_TURN_REFUSAL_MESSAGES,
  AgentTurnRefusedError,
  agentPlanTurnRefSchema,
  agentTurnRefused,
  effectivePlanTurnGuidance,
  type AgentEvent,
  type AgentPlanTurnRef,
  type AgentTurnInput,
  type AgentTurnResult,
  type AgentTurnStarted,
  type AgentUndoResult
} from "@ai-book-studio/core/agent";
import {
  AGENT_ERROR_LIMITS,
  agentMessageSchema,
  agentModeSchema,
  agentGuidanceTextSchema,
  agentPlanSchema,
  messageText,
  type AgentApprovalPart,
  type AgentApprovalStatus,
  type AgentErrorPart,
  type AgentMessage,
  type AgentPart,
  type AgentPlan,
  type AgentThread,
  type AgentUsage
} from "@ai-book-studio/core/agent/messages";
import { compactHistory } from "@ai-book-studio/core/agent/history";
import { contextBreakdown, type ContextBreakdown } from "@ai-book-studio/core/agent/context";
import { agentPlanBoundsRefusal } from "@ai-book-studio/core/agent/plan-state";
import { isPlanControlTool } from "@ai-book-studio/core/agent/plan-tools";
import { ThreadStoreError, type ThreadStore } from "@ai-book-studio/core/agent/threads";
import { findModel, unavailableReason } from "@ai-book-studio/core/providers/models";
import { isContributorModelId } from "@ai-book-studio/core/providers/compatibility";
import { reportedCost } from "@ai-book-studio/core/providers/openrouter";
import { normalizeProviderError, parseRetryAfter } from "@ai-book-studio/core/providers/errors";
import { redact } from "@ai-book-studio/core/providers/redact";
import type { ProviderId, StoredCredential } from "@ai-book-studio/core/providers/types";
import type { Chapter } from "@ai-book-studio/core/schema";
import { LibraryError } from "@ai-book-studio/core/library/errors";
import { ProviderError } from "@ai-book-studio/core/providers/types";
import type { Studio } from "../studio";
import type { ProviderService } from "../providers";
import { UsageStore } from "../usage";
import { newId } from "../library/paths";
import type { Library } from "../library/store";
import { modelFor } from "./transport";
import {
  CheckpointStore,
  bodyHash,
  checkpointMeta,
  metaHash,
  recordChange,
  type CheckpointEntry,
  type TurnCheckpoint
} from "./checkpoints";
import { DESTRUCTIVE_TOOL_NAMES, ProposedBases } from "./tools";
import { buildToolSet } from "./tool-set";
import {
  PlanProgress,
  PlanProposalDraft,
  PlanWriteError,
  planStepTool,
  proposePlanTool
} from "./plan-tools";
import { buildPrompt } from "./prompt";
import { readBookSkills } from "./skills";
import { cachePrefixFor } from "./cache";
import { loadPlugins, pluginTools, type LoadedPlugins } from "./plugins";
import type { PluginTool } from "@ai-book-studio/core/agent/plugins";
import type { MetricsStore } from "../metrics";
import { agentSettingsSchema } from "@ai-book-studio/core/agent/settings";
import { DISCUSS_NEXT_STEP, modeAllowsTool } from "./mode";

interface PendingApproval {
  approvalId: string;
  resume: (approved: boolean | null) => void;
}

interface ActiveTurn {
  controller: AbortController;
  bookId: string;
  bookTitle: string;
  threadId: string;
  messageId: string;
  background: boolean;
  /** The stored plan this turn continues, for same-process reattach. Never a persisted message field. */
  planId?: string | undefined;
  planRevision?: number | undefined;
  /** The chapter the author was looking at when the turn started, so a reopened window can return to it. */
  chapterId?: string | undefined;
  state: TurnState;
  pending?: PendingApproval | undefined;
  /** Retained through tool, approval and outcome persistence settlement. */
  completion: Promise<void>;
}

export type AgentOutcomeKind = "done" | "error" | "stopped" | "approval";

/** What the main process needs for a notification. It carries no key and no full manuscript. */
export interface AgentOutcome {
  kind: AgentOutcomeKind;
  turnId: string;
  bookId: string;
  bookTitle: string;
  threadId: string;
  /** The chapter that was open for the turn, or the last one it changed, for a window reopening on it. */
  chapterId?: string;
  background: boolean;
  text: string;
  changed: number;
  undoAvailable?: boolean;
  /** Orthogonal to the model/tool outcome: a local outcome or usage write failed. */
  persistenceError?: string;
  message?: string;
  approvalName?: string;
}

interface TurnState {
  phase: "active" | "stopping" | "settled";
  persistenceError?: string;
  text: string;
  reasoning: string;
  toolParts: AgentPart[];
  approvals: AgentApprovalPart[];
  changes: CheckpointEntry[];
  /** The catalogue's display name for the turn's model, when the catalogue named one. */
  modelName: string | null;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  /** Whether the provider reported its cache at all. A measured zero is not the same thing. */
  cacheReported: boolean;
  costUsd: number | null;
  contextLength: number | null;
  context: ContextBreakdown;
  steps: number;
  /** Stable for the whole turn so the paused and finished messages share one id. */
  createdAt: string;
  checkpoint: CheckpointProgress;
  /** What each paused destructive call was proposed against, noted before the author is asked. */
  proposed: ProposedBases;
  /** Tool calls still running. A stop or a failure waits for them before it reports. */
  running: Set<Promise<void>>;
  /** Executed calls get their receipt from the wrapper, never an early SDK abort result. */
  executions: Set<string>;
  /** The live step controller on a Start or Resume turn. Absent on ordinary and proposal turns. */
  plan?: PlanProgress | undefined;
  /** The read-only proposal draft on a proposal turn. Absent on every other turn. */
  proposal?: PlanProposalDraft | undefined;
}

/** How far the turn's one checkpoint file has caught up with the chapters the turn changed. */
interface CheckpointProgress {
  /** Moves on each time the turn records a change. */
  revision: number;
  /** The revision the file on disk holds. */
  saved: number;
  /** Set by the first save and kept, so every later save rewrites the same file. */
  at: string | null;
  file: string | null;
  /** Saves run one at a time, because the tool calls of one step can finish together. */
  queue: Promise<unknown>;
}

/**
 * Existing SDK loop cap. A plan longer than this fails honestly instead of completing in one turn;
 * raising it or continuing a plan across turns is later lifecycle work, not a completion claim.
 */
const MAX_STEPS = 20;

// Fixed, public-safe warnings. Multiple failed writes must not replace one another, and repeated
// attempts to save the same outcome must not grow its warning without bound.
const PERSISTENCE_WARNINGS = {
  approval: "The approval could not be saved. Its action was not started.",
  conversation: "The conversation outcome could not be fully saved. Changes to the book remain.",
  usage: "The turn's usage could not be saved. Local usage and spend history may be incomplete.",
  planPause: "The plan's pause could not be saved. The plan remains at its last confirmed state."
} as const;

function recordPersistenceError(state: TurnState, kind: keyof typeof PERSISTENCE_WARNINGS): void {
  const warning = PERSISTENCE_WARNINGS[kind];
  if (!state.persistenceError?.includes(warning)) {
    state.persistenceError = [state.persistenceError, warning].filter(Boolean).join(" ");
  }
}

/** Replaceable at the edge so tests and future provider adapters do not need a network. */
export type AgentModelFactory = (credential: StoredCredential, modelId: string) => LanguageModel;

/**
 * Runs one author turn at a time per turn id, in the main process. The model and tools live here;
 * the renderer only receives text, tool names and a final usage line. Every turn is written to the
 * book's thread store, so a reload resumes the conversation instead of losing it.
 */
export class AgentRuntime {
  private readonly active = new Map<string, ActiveTurn>();
  private readonly listeners = new Set<(event: AgentEvent) => void>();

  constructor(
    private readonly studio: Studio,
    private readonly providers: ProviderService,
    private readonly emit: (event: AgentEvent) => void,
    private readonly makeModel: AgentModelFactory = modelFor,
    private readonly onOutcome: (outcome: AgentOutcome) => void = () => {},
    /** The library-level plugin folder, if the author pointed at one. */
    private readonly pluginFolder: () => string | null = () => null,
    /** Where the per-book tool metrics are kept. */
    private readonly metrics: MetricsStore | null = null
  ) {}

  /** True while a turn the author explicitly marked as background is still alive. */
  hasActiveBackgroundTurns(): boolean {
    return [...this.active.values()].some((turn) => turn.background);
  }

  /**
   * The background turns still running, oldest first, with the chapter each was open on. The shell
   * remembers the newest when the window closes, so the next window opens on its conversation
   * while it still runs, not only once it has ended.
   */
  activeBackgroundTurns(): Array<{ bookId: string; threadId: string; chapterId?: string }> {
    return [...this.active.values()]
      .filter((turn) => turn.background)
      .map((turn) => {
        const chapterId = turn.chapterId ?? turn.state.changes.at(-1)?.chapterId;
        return { bookId: turn.bookId, threadId: turn.threadId, ...(chapterId ? { chapterId } : {}) };
      });
  }

  /**
   * Whether the agent is working on a book right now.
   *
   * The ambient status reports it, so the panel's Stop is offered only when there is something to
   * stop, and a phone can stop a turn it did not start.
   */
  isWorking(bookId: string): boolean {
    return [...this.active.values()].some((turn) => turn.bookId === bookId);
  }

  /** Request stop for every running turn in a book; terminal events acknowledge settlement. */
  async stopBook(bookId: string): Promise<number> {
    const turns = [...this.active.entries()]
      .filter(([, turn]) => turn.bookId === bookId)
      .map(([turnId]) => turnId);
    for (const turnId of turns) await this.stop(turnId);
    return turns.length;
  }

  /**
   * The plugin tools for a book.
   *
   * A folder that fails to load is reported to the caller and the turn carries on with the built-in
   * tools (FR-010).
   */
  private async pluginToolsFor(): Promise<PluginTool[]> {
    const loaded = await loadPlugins(this.pluginFolder());
    this.lastPluginLoad = loaded;
    return pluginTools(loaded.plugins);
  }

  /** What the last plugin load found, so the app can show it. */
  lastPluginLoad: LoadedPlugins | null = null;

  /** Record one tool call's outcome for the book's metrics (FR-003). */
  private async recordToolCall(bookId: string, name: string, ok: boolean): Promise<void> {
    if (!this.metrics) return;
    try {
      await this.metrics.append(bookId, { name, ok, at: new Date().toISOString() });
    } catch (error) {
      console.warn("[agent] Could not record the tool metric:", redact((error as Error).message));
    }
  }

  private recordToolStart(turnId: string, state: TurnState, id: string, name: string, input: unknown): void {
    if (state.toolParts.some((part) => part.type === "tool-call" && part.id === id)) return;
    state.toolParts.push({ type: "tool-call", id, name, input });
    this.publish({ type: "tool", turnId, id, name, status: "start", input });
  }

  private async recordToolResult(turnId: string, bookId: string, state: TurnState, id: string, name: string, output: unknown): Promise<void> {
    if (state.toolParts.some((part) => part.type === "tool-result" && part.id === id)) return;
    const result = output as { ok?: boolean; message?: string } | undefined;
    state.toolParts.push({ type: "tool-result", id, name, output, ...(result?.ok === false ? { isError: true } : {}) });
    this.publish({ type: "tool", turnId, id, name, status: "end", output, ...(result?.message ? { detail: result.message } : {}) });
    // Plan progress is recorded before the model receives the result, so a failed tool cannot be
    // followed by another ordinary call. The control tools are not observations.
    await state.plan?.recordResult(name, output);
    if (isPlanControlTool(name)) return;
    await this.recordToolCall(bookId, name, result?.ok !== false);
  }

  private terminal(turnId: string, state: TurnState, event: Extract<AgentEvent, { type: "done" | "error" | "stopped" }>): void {
    if (state.phase === "settled") return;
    state.phase = "settled";
    this.reportOutcome(turnId, event.type, state, event.type === "error" ? { message: event.message } : {});
    this.active.delete(turnId);
    this.publish({ ...event, ...(state.persistenceError ? { persistenceError: state.persistenceError } : {}) });
  }

  /**
   * Tell the shell what happened so it can notify when the window is hidden. The callback is
   * best-effort: a failed notification must never fail a turn or lose its saved message.
   */
  private reportOutcome(
    turnId: string,
    kind: AgentOutcomeKind,
    state: TurnState,
    extra: { message?: string; approvalName?: string } = {}
  ): void {
    const turn = this.active.get(turnId);
    if (!turn) return;
    const chapterId = turn.chapterId ?? state.changes.at(-1)?.chapterId;
    try {
      this.onOutcome({
        kind,
        turnId,
        bookId: turn.bookId,
        bookTitle: turn.bookTitle,
        threadId: turn.threadId,
        ...(chapterId ? { chapterId } : {}),
        background: turn.background,
        text: state.text,
        changed: state.changes.length,
        ...(kind !== "approval" ? { undoAvailable: checkpointCovers(state) } : {}),
        ...(state.persistenceError ? { persistenceError: state.persistenceError } : {}),
        ...(extra.message ? { message: extra.message } : {}),
        ...(extra.approvalName ? { approvalName: extra.approvalName } : {})
      });
    } catch (error) {
      console.warn("[agent] Could not report the turn outcome:", redact((error as Error).message));
    }
  }

  /**
   * Listen to a turn's events.
   *
   * The renderer watches them through the app's own channel. This is for the callers that want
   * the same events without a window: the control plane, and anything reaching the studio over
   * it.
   */
  onEvent(listener: (event: AgentEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Send an event to the window and to every listener. */
  private publish(event: AgentEvent): void {
    try {
      this.emit(event);
    } catch (error) {
      console.warn("[agent] Could not report an event:", redact((error as Error).message));
    }
    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch (error) {
        console.warn("[agent] Could not deliver an event:", redact((error as Error).message));
      }
    }
  }

  /**
   * Run a turn and wait for its answer.
   *
   * The renderer wants the stream, so it watches the events. A caller on the control plane wants
   * the answer, so it waits for the turn to finish. It is the same turn, with the same rules,
   * the same checkpoints and the same approvals.
   */
  async runToCompletion(input: AgentTurnInput): Promise<AgentTurnResult> {
    const started = await this.start(input);
    return new Promise<AgentTurnResult>((resolve, reject) => {
      const unsubscribe = this.onEvent((event) => {
        if (event.turnId !== started.turnId) return;
        if (event.type === "done") {
          unsubscribe();
          resolve({
            turnId: started.turnId,
            threadId: started.threadId,
            text: event.text,
            changed: event.changed ?? 0,
            costUsd: event.costUsd,
            ...(event.undoAvailable !== undefined ? { undoAvailable: event.undoAvailable } : {}),
            ...(event.persistenceError ? { persistenceError: event.persistenceError } : {})
          });
        } else if (event.type === "error") {
          unsubscribe();
          // Existing HTTP/bridge error envelopes carry the message, so retain both facts there
          // as well as the orthogonal fields for in-process callers. Never replace the failure.
          reject(Object.assign(new ProviderError("unknown",
            [event.message, event.persistenceError].filter(Boolean).join(" ")), {
            changed: event.changed ?? 0,
            ...(event.undoAvailable !== undefined ? { undoAvailable: event.undoAvailable } : {}),
            ...(event.persistenceError ? { persistenceError: event.persistenceError } : {})
          }));
        } else if (event.type === "stopped") {
          unsubscribe();
          resolve({
            turnId: started.turnId,
            threadId: started.threadId,
            text: "",
            changed: event.changed ?? 0,
            stopped: true,
            ...(event.undoAvailable !== undefined ? { undoAvailable: event.undoAvailable } : {}),
            ...(event.persistenceError ? { persistenceError: event.persistenceError } : {})
          });
        } else if (event.type === "approval") {
          /*
           * The turn is waiting for the author, and the author can only approve in the app. The
           * turn stays paused; the caller is told why it is not finished.
           */
          unsubscribe();
          reject(
            new ProviderError(
              "invalid-request",
              `The agent needs your approval for ${event.name} in the app before it can carry on.`
            )
          );
        }
      });
    });
  }

  async start(input: AgentTurnInput): Promise<AgentTurnStarted> {
    // Capture caller-owned objects before the first await. A live turn cannot be steered by mutation.
    input = structuredClone(input);
    this.assertNotStopping(input.bookId);
    if (!agentModeSchema.safeParse(input.mode).success) {
      throw agentTurnRefused("invalid-mode");
    }
    if (input.planProposal !== undefined && typeof input.planProposal !== "boolean") {
      throw agentTurnRefused("invalid-plan");
    }
    if (input.planProposal === true) {
      // The proposal turn is a read-only Edit turn. It never carries a plan reference, because
      // that would mix a new proposal with a continuation of a stored plan.
      if (input.plan !== undefined) throw agentTurnRefused("invalid-plan");
      if (input.mode !== "edit") throw agentTurnRefused("plan-in-discuss");
    }

    let planRef: AgentPlanTurnRef | undefined;
    if (input.plan !== undefined) {
      const parsed = agentPlanTurnRefSchema.safeParse(input.plan);
      if (!parsed.success) throw agentTurnRefused("invalid-plan", { cause: parsed.error });
      planRef = parsed.data;
      if (input.mode !== "edit") throw agentTurnRefused("plan-in-discuss");
      if (input.threadId === null || input.threadId === undefined) {
        throw agentTurnRefused("plan-without-thread");
      }
      // A plan always appends an explicit author turn; an empty request cannot start one.
      if (!input.prompt.trim()) {
        throw new ProviderError("invalid-request", EMPTY_PROMPT_MESSAGE);
      }
    } else if (input.guidance !== undefined && (
      !agentGuidanceTextSchema.safeParse(input.guidance).success || input.guidance.trim().length === 0
    )) {
      throw agentTurnRefused("invalid-guidance");
    }

    const library = this.studio.requireLibrary();
    const { book, chapters } = await library.readBook(input.bookId).catch((error: unknown) => {
      if (error instanceof LibraryError && error.code === "format" && /settings\.agent\.(tone|answerLength)/.test(error.message)) {
        throw new ProviderError("invalid-request", "The saved book guidance is invalid and has been kept. Shorten tone to 500 characters and choose Brief, Standard or Detailed before sending.");
      }
      throw error;
    });
    if (!agentSettingsSchema.safeParse(book.settings?.agent).success) {
      throw new ProviderError("invalid-request", "The book's agent guidance is invalid. Shorten tone to 500 characters and choose Brief, Standard or Detailed before sending.");
    }

    // A proposal never joins or replaces a live plan. Refuse before the provider read and before
    // the model is constructed, so no assistant message is written.
    if (input.planProposal === true && input.threadId) {
      let thread: AgentThread | null;
      try {
        thread = await library.threads.read(input.bookId, input.threadId);
      } catch (error) {
        throw planReadRefusal(error);
      }
      if (!thread) {
        throw new ProviderError("not-found", "That conversation no longer exists. Start a new one.");
      }
      if (thread.plans.some((plan) => !isTerminalPlan(plan))) {
        throw new AgentTurnRefusedError(
          "plan-state",
          "Finish or cancel the current plan before proposing another."
        );
      }
    }

    // Resolve the stored plan before any provider read, model construction or write. Every plan
    // refusal is decided here; the plan's own guidance is the only guidance a continuation uses.
    let storedPlan: AgentPlan | null = null;
    let effectiveGuidance = input.guidance;
    if (planRef) {
      const thread = await readPlanThread(library.threads, input.bookId, input.threadId!);
      const found = thread.plans.find((plan) => plan.id === planRef!.id);
      if (!found) throw agentTurnRefused("plan-not-found");
      const parsedPlan = agentPlanSchema.safeParse(found);
      if (!parsedPlan.success) throw agentTurnRefused("plan-invalid", { cause: parsedPlan.error });
      const plan = parsedPlan.data;
      if (plan.revision !== planRef.revision) throw agentTurnRefused("plan-stale-revision");
      if (planRef.action === "start" && plan.status !== "proposed") {
        throw agentTurnRefused("plan-not-startable");
      }
      if (planRef.action === "resume" && plan.status !== "paused") {
        throw agentTurnRefused("plan-not-resumable");
      }
      // Step 9: the submitted guidance is the author's one-turn field; an invalid value is not
      // allowed to hide behind an over-bound stored plan.
      if (input.guidance !== undefined && (
        !agentGuidanceTextSchema.safeParse(input.guidance).success || input.guidance.trim().length === 0
      )) {
        throw agentTurnRefused("invalid-guidance");
      }
      // Step 10: defense in depth for a plan that reached the runtime through a seam. The store's
      // schema normally refuses an over-bound document at read as `corrupt` (`plan-invalid`).
      if (agentPlanBoundsRefusal(plan) !== null) throw agentTurnRefused("plan-bounds");
      // Step 11: only the reviewed proposal guidance may be used for this one turn.
      const guidance = effectivePlanTurnGuidance(input.guidance, plan.guidance);
      if (!guidance.ok) throw agentTurnRefused(guidance.refusal);
      effectiveGuidance = guidance.guidance;
      storedPlan = plan;
    }

    const connectionId = input.model?.connectionId ?? book.defaultConnectionId;
    const modelId = input.model?.modelId ?? book.defaultModelId;
    if (!connectionId || !modelId) {
      throw new ProviderError("invalid-request", "Choose a model for this book before asking the agent to write.");
    }
    if (isContributorModelId(modelId) && !book.allowContributorTraining) {
      throw new ProviderError(
        "invalid-request",
        "Muse Spark Contributor may use this book's content to train Meta's models. Allow Contributor training for this book in the model picker, or choose the Standard model."
      );
    }
    const credential = await this.providers.credential(connectionId);
    let contextLength: number | null = null;
    let modelName: string | null = null;
    try {
      const catalogue = await this.providers.models(connectionId);
      const selected = findModel(catalogue, modelId);
      if (input.model) {
        if (!selected) {
          throw new ProviderError("not-found", "That model is no longer offered on this connection.");
        }
        const reason = unavailableReason(selected);
        if (reason) throw new ProviderError("unsupported", reason);
      }
      contextLength = selected?.contextLength ?? null;
      modelName = selected?.name ?? null;
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      console.warn("[agent] Could not read the model's context length:", redact((error as Error).message));
    }
    const model = this.makeModel(credential, modelId);
    this.assertNotStopping(input.bookId);

    // The first thread write is the confirmed Start/Resume. A caller creates a turn only on
    // `applied`; `unchanged` is a duplicate or concurrent move, never success.
    let planWrite: { thread: AgentThread; outcome: "applied" | "unchanged" } | null = null;
    if (planRef && storedPlan) {
      planWrite = await applyPlanTurn(
        library.threads,
        input.bookId,
        input.threadId!,
        storedPlan,
        planRef.action
      );
      if (planWrite.outcome !== "applied") {
        throw agentTurnRefused(planRef.action === "start" ? "plan-not-startable" : "plan-not-resumable");
      }
    }

    try {
      const startedPlan = planWrite && storedPlan
        ? confirmedStartedPlan(planWrite.thread, storedPlan)
        : undefined;
      const runningPlan = startedPlan && planWrite
        ? planWrite.thread.plans.find((plan) => plan.id === startedPlan.id) ?? null
        : null;
      const proposalDraft = input.planProposal === true ? new PlanProposalDraft() : undefined;
      const prepared = await prepareThread(
        library.threads,
        {
          bookId: input.bookId,
          threadId: input.threadId,
          prompt: input.prompt,
          history: input.history,
          mode: input.mode,
          guidance: effectiveGuidance
        },
        undefined,
        { forceNew: planRef !== undefined }
      );
      await this.expireStaleApprovals(input.bookId, prepared.thread);
      const activeChapter = input.chapterId ? (chapters.find((chapter) => chapter.id === input.chapterId) ?? null) : null;
      const skills = await readBookSkills(
        library.root,
        input.bookId,
        book.settings?.agent?.skillsEnabled !== false
      );
      const built = buildPrompt({
        book,
        chapters,
        activeChapter,
        skills: skills?.text ?? null,
        mode: input.mode,
        ...(proposalDraft ? { planProposal: true } : {}),
        ...(startedPlan ? { planTurn: true } : {})
      });
      const compacted = compactHistory(prepared.thread).messages;
      const messages = modelMessagesFor(compacted, effectiveGuidance);
      const context = contextBreakdown(
        built.sections,
        messages.map((message) => typeof message.content === "string" ? message.content : "").join("\n")
      );
      const messageId = newId("msg");
      const turnId = newId("turn");
      const controller = new AbortController();
      const state: TurnState = {
        phase: "active",
        text: "",
        reasoning: "",
        toolParts: [],
        approvals: [],
        changes: [],
        modelName,
        inputTokens: 0,
        outputTokens: 0,
        cachedInputTokens: 0,
        cacheReported: false,
        costUsd: null,
        contextLength,
        context,
        steps: 0,
        createdAt: new Date().toISOString(),
        checkpoint: { revision: 0, saved: 0, at: null, file: null, queue: Promise.resolve() },
        proposed: new ProposedBases(library, input.bookId),
        running: new Set(),
        executions: new Set()
      };
      if (proposalDraft) state.proposal = proposalDraft;
      if (startedPlan && runningPlan) {
        state.plan = new PlanProgress({
          store: library.threads,
          bookId: input.bookId,
          threadId: prepared.thread.id,
          turnId,
          plan: runningPlan,
          publish: (notice) => this.publish(notice),
          // Ordinary step and outcome writes stop with the author's stop. The request-pause and
          // confirm-pause writes use their own explicit pause path in this controller.
          canWrite: () => !controller.signal.aborted
        });
      }
      const cache = cachePrefixFor(
        credential.provider,
        book.settings?.cache?.prefixMode !== "off"
      );
      const tools = buildToolSet(library, input.bookId, {
        mode: input.mode,
        disabledTools: book.settings?.agent?.disabledTools ?? [],
        pluginTools: input.mode === "edit" && !proposalDraft ? await this.pluginToolsFor() : [],
        ...(cache.toolProviderOptions ? { toolProviderOptions: cache.toolProviderOptions } : {}),
        proposed: state.proposed,
        ...(state.plan ? {
          plan: {
            stepTool: planStepTool(state.plan),
            gate: () => state.plan?.gateRefusal() ?? null
          }
        } : {}),
        ...(proposalDraft ? { planProposal: { proposeTool: proposePlanTool(proposalDraft) } } : {}),
        // Every change goes into the checkpoint as it is made, before the tool answers the model, so
        // a change after a pause or a resume is as undoable as one before it.
        onBeforeChange: async (change) => {
          recordChange(state.changes, change);
          state.checkpoint.revision += 1;
          await this.saveCheckpoint(turnId, input, state);
        }
      });
      trackRunningCalls(tools, state, (id, name, toolInput) => this.recordToolStart(turnId, state, id, name, toolInput),
        (id, name, output) => this.recordToolResult(turnId, input.bookId, state, id, name, output));
      const agent = new ToolLoopAgent({
        id: "chapter-writer",
        model,
        instructions: cache.systemProviderOptions
          ? ({ role: "system", content: built.system, providerOptions: cache.systemProviderOptions } as const)
          : built.system,
        tools,
        // The destructive tools are the ones the toolkit also keeps behind an explicit opt-in. A
        // tool the author withdrew is not in the set, so it is not listed here either.
        toolApproval: Object.fromEntries(
          DESTRUCTIVE_TOOL_NAMES.filter((name) => name in tools).map((name) => [name, "user-approval"])
        ) as Record<string, "user-approval">,
        // A failed request is the author's to retry, not the loop's: the SDK must not hide a
        // rate limit behind its own backoff and replays.
        maxRetries: 0,
        stopWhen: isStepCount(MAX_STEPS)
      });

      this.assertNotStopping(input.bookId);
      const active: ActiveTurn = {
        controller,
        bookId: input.bookId,
        bookTitle: book.title,
        threadId: prepared.thread.id,
        messageId,
        background: input.background === true,
        ...(startedPlan ? { planId: startedPlan.id, planRevision: startedPlan.revision } : {}),
        chapterId: activeChapter?.id,
        state,
        completion: Promise.resolve()
      };
      this.active.set(turnId, active);

      active.completion = this.run(
        turnId,
        input,
        agent,
        messages,
        controller,
        prepared.thread.id,
        library.threads,
        credential.provider,
        connectionId,
        credential.label,
        modelId,
        messageId,
        state
      );
      return {
        turnId,
        threadId: prepared.thread.id,
        mode: input.mode,
        ...(startedPlan ? { plan: startedPlan } : {})
      };
    } catch (error) {
      // The plan start/resume write already happened. A setup failure before the provider request
      // attempts one fail transition so a running plan is not left without a turn; no user message
      // is deleted and no automatic retry is made.
      if (!planWrite || !storedPlan) throw error;
      const failed = await this.failPlanAfterSetupFailure(input.bookId, input.threadId!, storedPlan.id);
      throw new ProviderError(
        "invalid-request",
        failed
          ? "The turn did not start. Its plan was marked failed; review the conversation before continuing."
          : "The turn did not start, and its plan could not be marked failed. Reload the conversation before continuing.",
        { cause: error }
      );
    }
  }

  /**
   * Store the proposal after its assistant message. Nothing is written before the message exists;
   * a failed or refused addPlan leaves no plan and no proposed notice.
   */
  private async finishProposalTurn(
    turnId: string,
    input: AgentTurnInput,
    threadId: string,
    messageId: string,
    state: TurnState,
    messageStored: boolean
  ): Promise<string | null> {
    if (!messageStored) return PROPOSAL_PERSISTENCE_MESSAGE;
    const draft = state.proposal?.proposal;
    if (!draft) return PROPOSAL_MISSING_MESSAGE;
    const planId = newId("plan");
    try {
      const thread = await this.studio.requireLibrary().threads.addPlan(input.bookId, threadId, {
        id: planId,
        purpose: draft.purpose,
        steps: draft.steps,
        parent: { messageId, turnId }
      });
      const plan = thread.plans.find((entry) => entry.id === planId);
      if (!plan) return PROPOSAL_STORE_MESSAGE;
      this.publish({
        type: "plan",
        turnId,
        planId: plan.id,
        revision: plan.revision,
        status: "proposed",
        change: "proposed"
      });
      return null;
    } catch (error) {
      if (error instanceof ThreadStoreError && error.message.trim()) return error.message.trim();
      return PROPOSAL_STORE_MESSAGE;
    }
  }

  /** One start-path compensation; `unchanged` means the plan was already failed. */
  private async failPlanAfterSetupFailure(bookId: string, threadId: string, planId: string): Promise<boolean> {
    try {
      const { outcome } = await this.studio.requireLibrary().threads.applyPlanEvent(bookId, threadId, planId, {
        type: "fail"
      });
      return outcome === "applied" || outcome === "unchanged";
    } catch {
      return false;
    }
  }

  private assertNotStopping(bookId: string): void {
    if ([...this.active.values()].some((turn) => turn.bookId === bookId && turn.state.phase === "stopping")) {
      throw new ProviderError("invalid-request", "The previous turn is still stopping. Wait for its outcome before starting another turn.");
    }
  }

  /** Request stop synchronously. Only the run's settlement barrier can acknowledge it. */
  async stop(turnId: string): Promise<null> {
    const turn = this.active.get(turnId);
    if (!turn || turn.state.phase === "settled") return null;
    turn.state.phase = "stopping";
    const pending = turn.pending;
    turn.pending = undefined;
    expirePendingApprovals(turn.state);
    const firstStop = !turn.controller.signal.aborted;
    turn.controller.abort();
    if (firstStop) {
      this.publish({ type: "stopping", turnId });
      // Exactly one request-pause write per stop. It never rejects; the terminal stopped event
      // still waits for settlement, the checkpoint and the confirm attempt.
      void turn.state.plan?.requestPause();
    }
    pending?.resume(null);
    return null;
  }

  /** Continue a turn that paused on a destructive tool call. */
  async approve(turnId: string, approvalId: string, approved: boolean): Promise<null> {
    const turn = this.active.get(turnId);
    if (!turn?.pending || turn.state.phase !== "active" || turn.pending.approvalId !== approvalId) {
      throw new ProviderError("not-found", "That approval is no longer waiting. The turn may have stopped.");
    }
    // Consume ownership before persistence yields. Stop cannot expire an already consumed answer.
    const pending = turn.pending;
    turn.pending = undefined;
    const part = turn.state.approvals.find((entry) => entry.approvalId === approvalId);
    if (part) {
      part.status = approved ? "approved" : "denied";
      part.resolvedAt = new Date().toISOString();
    }
    try {
      await this.setApprovalStatus(turn, approvalId, approved ? "approved" : "denied");
    } catch {
      recordPersistenceError(turn.state, "approval");
      void this.stop(turnId);
      pending.resume(null);
      throw new ProviderError("invalid-request", PERSISTENCE_WARNINGS.approval);
    }
    // The plan's approval wait is settled only after the approval part was written, and only an
    // applied plan write may resume the action. A failed plan write stops the turn without running
    // the tool and leaves the plan at its last confirmed waiting state.
    const planSettled = turn.state.plan ? await turn.state.plan.approvalSettled() : { ok: true as const };
    if (!planSettled.ok) {
      recordPersistenceError(turn.state, "approval");
      void this.stop(turnId);
      pending.resume(null);
      throw new ProviderError("invalid-request", planSettled.message);
    }
    pending.resume(turn.controller.signal.aborted ? null : approved);
    return null;
  }

  /**
   * Expire approvals no live turn can still answer. A previous run's pending approval — left
   * behind by a closed app or a killed process — is persisted as expired the next time any turn
   * starts on the thread, so it can never resume and never shows as waiting again. Approvals
   * held by a live turn are untouched.
   */
  private async expireStaleApprovals(bookId: string, thread: AgentThread): Promise<void> {
    const library = this.studio.requireLibrary();
    for (const message of thread.messages) {
      for (const part of message.parts) {
        if (part.type !== "approval" || part.status !== "pending") continue;
        if (this.active.has(part.turnId)) continue;
        await library.threads.updateApproval(bookId, thread.id, message.id, part.approvalId, "expired");
      }
    }
  }

  private async setApprovalStatus(
    turn: ActiveTurn,
    approvalId: string,
    status: AgentApprovalStatus
  ): Promise<void> {
    await this.studio.requireLibrary().threads.updateApproval(
      turn.bookId,
      turn.threadId,
      turn.messageId,
      approvalId,
      status
    );
  }

  /**
   * Put every chapter the newest turn changed back the way the turn found it.
   *
   * The entries are undone newest first, so the turn's structural changes come apart in the reverse
   * of the order they were made. A chapter whose text or details changed during or after the turn is
   * left as it is and counted as skipped: undo never writes over someone else's words. A chapter someone
   * else wrote in between two of the turn's own changes is restored too, but its file is kept as a
   * conflict copy first, and the result names the chapter and the copy.
   *
   * With `turnId`, as the chat sends for the turn it offered, undo goes ahead only while that turn owns
   * the book's newest checkpoint. Otherwise it changes nothing and says what is newest. The strip, the
   * CLI and the phone name no turn and take the newest on purpose.
   */
  async undoLast(bookId: string, turnId?: string): Promise<AgentUndoResult> {
    const library = this.studio.requireLibrary();
    const store = new CheckpointStore(() => this.studio.library);
    const checkpoint = await store.latest(bookId);
    if (turnId !== undefined && checkpoint?.turnId !== turnId) {
      throw new ProviderError("not-found", staleUndoMessage(checkpoint));
    }
    if (!checkpoint) {
      throw new ProviderError("not-found", "There is no agent turn to undo in this book.");
    }
    let restored = 0;
    let skipped = 0;
    const kept: NonNullable<AgentUndoResult["kept"]> = [];
    const notes: string[] = [];
    for (const entry of [...checkpoint.entries].reverse()) {
      const undone = await undoEntry(library, bookId, entry);
      if (undone.restored) restored += 1;
      else skipped += 1;
      if (undone.kept) kept.push(undone.kept);
      if (undone.note) notes.push(undone.note);
    }
    await store.remove(bookId, checkpoint.file);
    try {
      // The turn is used up, so no conversation may offer its undo again, even after a reload.
      await library.threads.forgetCheckpointTurn(bookId, checkpoint.turnId);
    } catch (error) {
      // The chapters are already back; a conversation that could not be updated must not hide that.
      console.warn("[agent] Could not update the conversation after undo:", redact((error as Error).message));
    }
    return { restored, skipped, ...(kept.length > 0 ? { kept } : {}), ...(notes.length > 0 ? { notes } : {}) };
  }

  /**
   * Write the turn's checkpoint with every chapter the turn has changed so far.
   *
   * A turn has one checkpoint file. Each save rewrites it whole and atomically, so the file always
   * holds what every changed chapter was before the turn first wrote it, however many pauses and
   * approvals came between. A failed save is logged and tried again by the next one; it never fails
   * the tool that made the change. Resolves true when the file holds every change.
   */
  private saveCheckpoint(turnId: string, input: AgentTurnInput, state: TurnState): Promise<boolean> {
    const progress = state.checkpoint;
    const saving = progress.queue.then(async () => {
      if (progress.saved === progress.revision) return checkpointCovers(state);
      const revision = progress.revision;
      const store = new CheckpointStore(() => this.studio.library);
      try {
        if (state.changes.length === 0) {
          // The turn's changes cancelled out, such as a chapter it created and then deleted.
          if (progress.file) await store.remove(input.bookId, progress.file);
          progress.at = null;
          progress.file = null;
        } else {
          progress.at ??= new Date().toISOString();
          progress.file = await store.save({
            turnId,
            bookId: input.bookId,
            at: progress.at,
            prompt: input.prompt,
            entries: state.changes
          });
        }
        progress.saved = revision;
      } catch (error) {
        console.warn("[agent] Could not save the turn checkpoint:", redact((error as Error).message));
      }
      return checkpointCovers(state);
    });
    progress.queue = saving.catch(() => {});
    return saving;
  }

  private async run<TOOLS extends ToolSet>(
    turnId: string,
    input: AgentTurnInput,
    agent: ToolLoopAgent<never, TOOLS>,
    messages: ModelMessage[],
    controller: AbortController,
    threadId: string,
    threadStore: ThreadStore,
    provider: ProviderId,
    connectionId: string,
    connectionLabel: string,
    modelId: string,
    messageId: string,
    state: TurnState
  ): Promise<void> {
    let waiting = false;
    let approval: { approvalId: string; toolCallId: string; name: string; input: unknown } | null = null;

    // Each change saved the checkpoint as it was made. This catches up after a save that failed.
    const saveCheckpoint = (): Promise<boolean> => this.saveCheckpoint(turnId, input, state);

    const writeMessage = async (
      parts: AgentPart[],
      options: { usage?: AgentUsage; checkpoint?: boolean } = {}
    ): Promise<boolean> => {
      try {
        // Validation is part of best-effort persistence too. An invalid provider part must
        // never suppress the terminal event that releases the author-facing controls.
        const message = agentMessageSchema.parse({
          id: messageId,
          role: "assistant",
          mode: input.mode,
          parts,
          model: {
            provider,
            modelId,
            connectionLabel,
            ...(state.modelName ? { name: state.modelName } : {})
          },
          ...(options.usage ? { usage: options.usage } : {}),
          context: state.context,
          turnId,
          createdAt: state.createdAt
        });
        await threadStore.upsertMessage(input.bookId, threadId, message);
        if (options.checkpoint) {
          // A field change goes through the checked mutate path; a whole-document save now needs
          // the exact base hash from a read, which this turn no longer holds.
          await threadStore.addCheckpointTurn(input.bookId, threadId, turnId);
        }
        return true;
      } catch (error) {
        recordPersistenceError(state, "conversation");
        console.warn("[agent] Could not save the conversation:",
          error instanceof Error ? redact(error.message) : "The conversation write failed.");
        return false;
      }
    };

    try {
      controller.signal.throwIfAborted();
      const stream = await agent.stream({ messages, abortSignal: controller.signal });
      for await (const part of stream.fullStream) {
        if (part.type === "text-delta") {
          state.text += part.text;
          this.publish({ type: "text", turnId, delta: part.text });
        } else if (part.type === "reasoning-delta") {
          state.reasoning += part.text;
          this.publish({ type: "reasoning", turnId, delta: part.text });
        } else if (part.type === "tool-call") {
          this.recordToolStart(turnId, state, part.toolCallId, part.toolName, part.input);
        } else if (part.type === "tool-result") {
          if (state.executions.has(part.toolCallId)) continue;
          await this.recordToolResult(turnId, input.bookId, state, part.toolCallId, part.toolName, part.output);
        } else if (part.type === "tool-error") {
          if (state.executions.has(part.toolCallId)) continue;
          // A tool that throws ends like one that answered `ok: false`: a failed step in the chat and
          // the thread, and a failed call in the metrics. Without this it would stay running forever.
          const output = { ok: false, message: input.mode === "discuss" && !modeAllowsTool(input.mode, part.toolName)
            ? DISCUSS_NEXT_STEP : toolErrorMessage(part.error) };
          await this.recordToolResult(turnId, input.bookId, state, part.toolCallId, part.toolName, output);
        } else if (part.type === "tool-output-denied") {
          // A denied destructive call executes nothing. It is an observed failure for the active
          // step, never a success and never a plan write by the model.
          await state.plan?.recordResult(part.toolName, { type: "execution-denied" });
        } else if (part.type === "tool-approval-request") {
          waiting = true;
          approval = {
            approvalId: part.approvalId,
            toolCallId: part.toolCall.toolCallId,
            name: part.toolCall.toolName,
            input: part.toolCall.input
          };
        } else if (part.type === "error") {
          throw part.error;
        }
      }

      controller.signal.throwIfAborted();
      const usage = await stream.totalUsage;
      state.inputTokens += usage.inputTokens ?? 0;
      state.outputTokens += usage.outputTokens ?? 0;
      // The provider reports its cache as an optional count. A missing count means the provider
      // measures no cache, which is not the same as a measured zero (D-147).
      const cacheRead = usage.inputTokenDetails.cacheReadTokens;
      state.cachedInputTokens += cacheRead ?? 0;
      if (cacheRead !== undefined) state.cacheReported = true;
      const steps = await stream.steps;
      state.steps += Math.max(1, steps.length);
      // Every step reports its own price, so the turn's price is the sum of the steps, not the
      // last step's alone.
      let stepCost: number | null = null;
      for (const step of steps) {
        const part = reportedCost(provider, step.providerMetadata);
        if (part !== null) stepCost = (stepCost ?? 0) + part;
      }
      if (stepCost !== null) state.costUsd = (state.costUsd ?? 0) + stepCost;
      const costBasis = state.costUsd === null ? "unknown" : "reported";

      if (waiting && approval) {
        // The call's chapters as they are now, before the author sees the request. Once approved,
        // the call writes against them, so words saved while it waits are a conflict, never lost.
        await state.proposed.note(approval);
        // The plan's wait is written before the approval is published. If it cannot be saved, no
        // approval is offered and the action never starts.
        if (state.plan) {
          const requested = await state.plan.requestApproval();
          if (!requested.ok) throw new PlanWriteError(requested.message, "request-approval");
        }
        await saveCheckpoint();
        const responseMessages = await stream.responseMessages;
        state.approvals.push({
          type: "approval",
          approvalId: approval.approvalId,
          turnId,
          name: approval.name,
          input: approval.input,
          status: "pending",
          requestedAt: new Date().toISOString()
        });
        await writeMessage([...assistantParts(state.reasoning, state.toolParts, state.text), ...state.approvals]);
        controller.signal.throwIfAborted();
        if (state.persistenceError) throw new Error("The approval request could not be saved. The proposed action was not started.");
        const active = this.active.get(turnId);
        if (active) {
          const captured = approval;
          const answer = new Promise<boolean | null>((resolve) => {
            active.pending = { approvalId: captured.approvalId, resume: resolve };
          });
          this.publish({
            type: "approval",
            turnId,
            approvalId: captured.approvalId,
            name: captured.name,
            input: captured.input,
            ...(state.plan
              ? { planId: state.plan.planId, planRevision: state.plan.revision }
              : {})
          });
          this.reportOutcome(turnId, "approval", state, { approvalName: captured.name });
          const approved = await answer;
          controller.signal.throwIfAborted();
          if (approved !== null) {
            const responses: ToolApprovalResponse[] = [
              {
                type: "tool-approval-response",
                approvalId: captured.approvalId,
                approved,
                reason: approved ? "Approved by the author." : "Denied by the author."
              }
            ];
            // Only this live destructive approval continues the SDK conversation. This is not
            // a stopped-turn or plan resume, and the host gate still controls every invocation.
            const resumed: ModelMessage[] = [
              ...messages,
              ...responseMessages,
              { role: "tool", content: responses }
            ];
            await this.run(
              turnId,
              input,
              agent,
              resumed,
              controller,
              threadId,
              threadStore,
              provider,
              connectionId,
              connectionLabel,
              modelId,
              messageId,
              state
            );
          }
        }
        return;
      }

      // Close dispatch even on ordinary completion before draining the execution receipts.
      state.phase = "stopping";
      await settleRunningCalls(state.running);
      const undoAvailable = await saveCheckpoint();
      const usageRecord: AgentUsage = {
        inputTokens: state.inputTokens,
        outputTokens: state.outputTokens,
        cachedInputTokens: state.cachedInputTokens,
        cacheReported: state.cacheReported,
        costUsd: state.costUsd,
        costBasis,
        contextLength: state.contextLength
      };
      const messageStored = await writeMessage([...assistantParts(state.reasoning, state.toolParts, state.text), ...state.approvals], {
        usage: usageRecord,
        checkpoint: state.changes.length > 0 && undoAvailable
      });
      controller.signal.throwIfAborted();

      // A proposal turn stores its plan only after the assistant message that proposed it, and
      // only from the reviewed proposal tool call. No plan notice appears before addPlan applies.
      if (state.proposal) {
        const failure = await this.finishProposalTurn(turnId, input, threadId, messageId, state, messageStored);
        controller.signal.throwIfAborted();
        if (failure) {
          this.terminal(turnId, state, {
            type: "error",
            turnId,
            code: "plan-state",
            message: failure,
            changed: state.changes.length,
            undoAvailable
          });
          return;
        }
      }

      // The terminal plan write precedes the terminal turn event. A failure here is an error turn
      // and never a completed plan.
      const planEnd = state.plan ? await state.plan.endTurn() : { ok: true as const };
      controller.signal.throwIfAborted();
      if (!planEnd.ok) {
        this.terminal(turnId, state, {
          type: "error",
          turnId,
          code: "plan-state",
          message: planEnd.message,
          changed: state.changes.length,
          undoAvailable
        });
        return;
      }
      const done: Extract<AgentEvent, { type: "done" }> = {
        type: "done",
        turnId,
        text: state.text,
        model: {
          provider,
          modelId,
          connectionLabel,
          ...(state.modelName ? { name: state.modelName } : {})
        },
        inputTokens: state.inputTokens,
        outputTokens: state.outputTokens,
        costUsd: state.costUsd,
        costBasis,
        contextLength: state.contextLength,
        context: state.context,
        changed: state.changes.length,
        undoAvailable
      };

      try {
        await new UsageStore(() => this.studio.library?.root ?? null).append({
          at: new Date().toISOString(),
          bookId: input.bookId,
          provider,
          connectionId,
          connectionLabel,
          modelId,
          inputTokens: state.inputTokens,
          outputTokens: state.outputTokens,
          cachedInputTokens: state.cachedInputTokens,
          cacheReported: state.cacheReported,
          costUsd: state.costUsd,
          costBasis,
          contextLength: state.contextLength,
          steps: state.steps
        });
      } catch (error) {
        recordPersistenceError(state, "usage");
        console.warn("[agent] Could not record usage:",
          error instanceof Error ? redact(error.message) : "The usage write failed.");
      }
      controller.signal.throwIfAborted();
      this.terminal(turnId, state, done);
    } catch (error) {
      // A tool call that was still writing finishes first, so the changes this reports, and the
      // checkpoint it leaves, include that write.
      state.phase = "stopping";
      await settleRunningCalls(state.running);
      // Provider/tool failure: close the active step by the observation rule, then fail the plan.
      // A stop writes no plan transition.
      if (!controller.signal.aborted) await state.plan?.settleOnFailure();
      const undoAvailable = await saveCheckpoint();
      expirePendingApprovals(state);
      if (controller.signal.aborted) {
        const stopped: AgentErrorPart = { type: "error", code: "stopped", message: state.persistenceError ?? "Stopped by the author." };
        await writeMessage([...assistantParts(state.reasoning, state.toolParts, state.text, stopped), ...state.approvals], {
          checkpoint: state.changes.length > 0 && undoAvailable
        });
        // The pause is confirmed only after the in-flight work, checkpoint and stopped message are
        // written. A failed confirm never claims Paused and leaves the last confirmed state.
        const pause = state.plan ? await state.plan.confirmPause() : null;
        if (pause && !pause.ok) recordPersistenceError(state, "planPause");
        this.terminal(turnId, state, { type: "stopped", turnId, changed: state.changes.length, undoAvailable });
      } else {
        // A plan-write failure is already reported as `plan-error` by the controller. Its fixed
        // sentence becomes the terminal plan-state error, never a provider guess.
        const planFailure = error instanceof PlanWriteError ? error : null;
        // A provider transport failure arrives as an API error carrying its status, body and
        // headers. Anything else is only words, and the normalizer treats it that way.
        const apiError = planFailure || !APICallError.isInstance(error) ? null : error;
        const retryAfter = planFailure ? undefined : parseRetryAfter(
          apiError?.responseHeaders?.["retry-after"] ?? apiError?.responseHeaders?.["Retry-After"]
        );
        const normalized = planFailure
          ? { code: "plan-state", message: planFailure.message, options: {} as { retryAfterSeconds?: number } }
          : normalizeProviderError({
              provider,
              message: error instanceof Error ? error.message : String(error),
              ...(apiError?.statusCode !== undefined ? { status: apiError.statusCode } : {}),
              ...(apiError?.responseBody ? { body: apiError.responseBody } : {}),
              ...(retryAfter !== undefined ? { retryAfterSeconds: retryAfter } : {})
            });
        const wait = normalized.options.retryAfterSeconds;
        const contextNote =
          normalized.code === "context" && state.contextLength
            ? ` This model's context is ${state.contextLength.toLocaleString()} tokens.`
            : "";
        const base = `${redact(normalized.message) || "The provider returned an unexpected response."}${contextNote}`;
        const checkpointNote =
          state.changes.length > 0 && !undoAvailable
            ? " The turn changed the book, but its undo checkpoint could not be saved. Review the affected chapters before continuing."
            : "";
        const message = `${base}${checkpointNote}`;
        // Even an attempt that failed before producing text records its mode and outcome.
        // Retry reuses the matching user request, never deletes or relabels this failed attempt.
        const failure = storedFailure(normalized.code, base, checkpointNote, wait);
        await writeMessage([...assistantParts(state.reasoning, state.toolParts, state.text, failure), ...state.approvals], {
          checkpoint: state.changes.length > 0 && undoAvailable
        });
        if (controller.signal.aborted) {
          const stopped: AgentErrorPart = { type: "error", code: "stopped", message: "Stopped by the author." };
          await writeMessage([...assistantParts(state.reasoning, state.toolParts, state.text, stopped), ...state.approvals], {
            checkpoint: state.changes.length > 0 && undoAvailable
          });
          // Same confirm-and-warning sequence as the early abort path: after the stopped message,
          // before the one terminal event.
          const pause = state.plan ? await state.plan.confirmPause() : null;
          if (pause && !pause.ok) recordPersistenceError(state, "planPause");
        }
        this.terminal(turnId, state, {
          type: controller.signal.aborted ? "stopped" : "error",
          turnId,
          code: normalized.code,
          message,
          changed: state.changes.length,
          undoAvailable,
          ...(wait !== undefined ? { retryAfterSeconds: wait } : {})
        });
      }
    }
  }
}

/** Fixed text shared by the early plan-turn prompt check and `prepareThread`'s ordinary check. */
const EMPTY_PROMPT_MESSAGE = "Write a message before asking the agent to work.";

const PROPOSAL_PERSISTENCE_MESSAGE =
  "The plan proposal could not be saved. Nothing was started.";
const PROPOSAL_MISSING_MESSAGE = "The model did not propose a plan. Nothing was saved.";
const PROPOSAL_STORE_MESSAGE =
  "The plan proposal could not be stored. Nothing was started.";

/** A terminal plan is retained and immutable; it never blocks a new proposal. */
function isTerminalPlan(plan: AgentPlan): boolean {
  return plan.status === "completed" ||
    plan.status === "cancelled" ||
    plan.status === "failed" ||
    plan.status === "expired";
}

/** Read the named conversation only; a plan id is never looked up in another thread or book. */
async function readPlanThread(store: ThreadStore, bookId: string, threadId: string): Promise<AgentThread> {
  try {
    const thread = await store.read(bookId, threadId);
    if (!thread) throw agentTurnRefused("plan-not-found");
    return thread;
  } catch (error) {
    if (error instanceof AgentTurnRefusedError) throw error;
    throw planReadRefusal(error);
  }
}

/** Apply exactly one Start or Resume through the checked store mutation. */
function applyPlanTurn(
  store: ThreadStore,
  bookId: string,
  threadId: string,
  plan: AgentPlan,
  action: "start" | "resume"
): Promise<{ thread: AgentThread; outcome: "applied" | "unchanged" }> {
  return store
    .applyPlanEvent(
      bookId,
      threadId,
      plan.id,
      action === "start" ? { type: "start", revision: plan.revision } : { type: "resume" }
    )
    .catch((error: unknown) => {
      throw planEventRefusal(error);
    });
}

/** The confirmed `running` snapshot returned only after the Start/Resume write applied. */
function confirmedStartedPlan(
  thread: AgentThread,
  plan: AgentPlan
): { id: string; revision: number; status: "running" } {
  const stored = thread.plans.find((entry) => entry.id === plan.id);
  const parsed = agentPlanSchema.safeParse(stored);
  if (!parsed.success || parsed.data.status !== "running") {
    throw new Error("The conversation store did not confirm the plan's running state.");
  }
  return { id: parsed.data.id, revision: parsed.data.revision, status: "running" };
}

/** A missing conversation is `plan-not-found`; an unreadable one keeps the store's safe sentence. */
function planReadRefusal(error: unknown): AgentTurnRefusedError {
  if (error instanceof ThreadStoreError) {
    if (error.code === "not-found") return agentTurnRefused("plan-not-found", { cause: error });
    return new AgentTurnRefusedError(
      "plan-invalid",
      error.message.trim() || AGENT_TURN_REFUSAL_MESSAGES["plan-invalid"],
      { cause: error }
    );
  }
  return agentTurnRefused("plan-invalid", { cause: error });
}

/** A refused, conflicted, uncertain or failed Start/Resume is `plan-state`, never applied. */
function planEventRefusal(error: unknown): AgentTurnRefusedError {
  if (error instanceof ThreadStoreError) {
    if (error.code === "not-found") return agentTurnRefused("plan-not-found", { cause: error });
    if (
      error.code === "corrupt" ||
      error.code === "unsupported" ||
      error.code === "newer" ||
      error.code === "too-large"
    ) {
      return new AgentTurnRefusedError(
        "plan-invalid",
        error.message.trim() || AGENT_TURN_REFUSAL_MESSAGES["plan-invalid"],
        { cause: error }
      );
    }
    return new AgentTurnRefusedError(
      "plan-state",
      error.message.trim() || AGENT_TURN_REFUSAL_MESSAGES["plan-state"],
      { cause: error }
    );
  }
  return agentTurnRefused("plan-state", { cause: error });
}

/** Keep the existing on-disk bounds without shortening a provider's requested wait. */
function storedFailure(code: string, detail: string, checkpointNote: string, wait: number | undefined): AgentErrorPart {
  const numericWait = wait !== undefined && wait <= AGENT_ERROR_LIMITS.retryAfterSeconds;
  const waitNote = wait !== undefined && !numericWait
    ? ` The provider requested a retry wait of ${wait} seconds.` : "";
  const suffix = `${waitNote}${checkpointNote}`;
  if (detail.length + suffix.length > AGENT_ERROR_LIMITS.message) {
    const marker = "… [Error detail shortened for this conversation.]";
    detail = detail.slice(0, AGENT_ERROR_LIMITS.message - suffix.length - marker.length)
      .replace(/[\uD800-\uDBFF]$/, "") + marker;
  }
  return {
    type: "error", code, message: `${detail}${suffix}`,
    ...(numericWait ? { retryAfterSeconds: wait } : {})
  };
}

/**
 * Reuse an unchanged request after failure, retaining every failed assistant attempt. A changed
 * mode or guidance is a new request even when its prompt is identical. Legacy mode stays absent.
 */
export async function prepareThread(
  store: ThreadStore,
  input: Pick<AgentTurnInput, "bookId" | "threadId" | "prompt" | "history"> & Partial<Pick<AgentTurnInput, "mode" | "guidance">>,
  now: () => string = () => new Date().toISOString(),
  options: { forceNew?: boolean } = {}
): Promise<{ thread: AgentThread; reused: boolean }> {
  const prompt = input.prompt.trim();
  if (!prompt) {
    throw new ProviderError("invalid-request", EMPTY_PROMPT_MESSAGE);
  }
  const at = now();
  const userMessage = agentMessageSchema.parse({
    id: newId("msg"),
    role: "user",
    mode: input.mode,
    parts: [{ type: "text", text: prompt }, ...(input.guidance !== undefined ? [{ type: "guidance", text: input.guidance }] : [])],
    createdAt: at
  });

  let thread: AgentThread;
  if (input.threadId) {
    const existing = await store.read(input.bookId, input.threadId);
    if (!existing) {
      throw new ProviderError("not-found", "That conversation no longer exists. Start a new one.");
    }
    thread = existing;
  } else {
    thread = await store.create(input.bookId, titleFromPrompt(prompt), seedMessages(input.history, at));
  }

  const lastUserIndex = thread.messages.findLastIndex((message) => message.role === "user");
  const last = thread.messages[lastUserIndex];
  const failedAttempts = thread.messages.slice(lastUserIndex + 1);
  if (!options.forceNew && last && messageText(last) === prompt && last.mode === input.mode &&
    last.parts.find((part) => part.type === "guidance")?.text === input.guidance &&
    failedAttempts.every((message) => message.role === "assistant" &&
      message.parts.some((part) => part.type === "error" && part.code !== "stopped"))) {
    return { thread, reused: true };
  }
  thread = await store.appendMessage(input.bookId, thread.id, userMessage);
  return { thread, reused: false };
}

function seedMessages(history: AgentTurnInput["history"], at: string): AgentMessage[] {
  const messages: AgentMessage[] = [];
  for (const turn of history ?? []) {
    const text = turn.text.trim();
    if (!text) continue;
    messages.push(
      agentMessageSchema.parse({
        id: newId("msg"),
        role: turn.role,
        parts: [{ type: "text", text }],
        createdAt: at
      })
    );
  }
  return messages;
}

function modelMessagesFor(history: AgentMessage[], guidance?: string): ModelMessage[] {
  const messages: ModelMessage[] = [];
  const currentRequest = history.findLast((message) => message.role === "user");
  for (const message of history) {
    const text = messageText(message);
    if (!text) continue;
    // Stored guidance is inspectable history, never a standing instruction. Only this submission's
    // guidance joins the current user request, including when the SDK resumes its approval step.
    const currentGuidance = message === currentRequest ? guidance : undefined;
    messages.push({ role: message.role, content: currentGuidance === undefined
      ? text : `${text}\n\nAuthor guidance for this turn only:\n${currentGuidance}` });
  }
  return messages;
}

function expirePendingApprovals(state: TurnState): void {
  const at = new Date().toISOString();
  for (const part of state.approvals) {
    if (part.status !== "pending") continue;
    part.status = "expired";
    part.resolvedAt = at;
  }
}

/** Whether one undo can put back everything the turn has changed so far. */
function checkpointCovers(state: TurnState): boolean {
  return state.changes.length === 0 || state.checkpoint.saved === state.checkpoint.revision;
}

/** Host-owned dispatch gate and receipts survive an SDK stream abort. */
function trackRunningCalls(
  tools: ToolSet,
  state: TurnState,
  started: (id: string, name: string, input: unknown) => void,
  finished: (id: string, name: string, output: unknown) => Promise<void>
): void {
  for (const [name, definition] of Object.entries(tools)) {
    const execute = definition.execute;
    if (!execute) continue;
    definition.execute = (toolInput, options) => {
      // No await between the gate and invoking the tool. Already executing checked effects
      // may finish; no queued invocation gains permission from an old SDK call or approval.
      if (state.phase !== "active") throw new Error("The turn is stopping. No new tool can start.");
      state.executions.add(options.toolCallId);
      const result = (async () => {
        started(options.toolCallId, name, toolInput);
        try {
          if (state.phase !== "active") throw new Error("The turn is stopping. No new tool can start.");
          const output = await execute(toolInput, options);
          await finished(options.toolCallId, name, output);
          return output;
        } catch (error) {
          await finished(options.toolCallId, name, { ok: false, message: toolErrorMessage(error) });
          throw error;
        }
      })();
      const settled = result.then(() => undefined, () => undefined);
      state.running.add(settled);
      void settled.then(() => state.running.delete(settled));
      return result;
    };
  }
}

/** Elapsed time is not evidence of settlement. A hung adapter stays unresolved. */
async function settleRunningCalls(running: Set<Promise<void>>): Promise<void> {
  while (running.size > 0) await Promise.all(running);
}

/** What undoing one checkpoint entry did. */
interface UndoneEntry {
  restored: boolean;
  /** The conflict copy kept before the chapter was restored. */
  kept?: { chapterId: string; title: string; savedAs: string };
  /** One sentence for the author when the chapter did not simply go back. */
  note?: string;
}

/**
 * Undo one checkpoint entry. A chapter that changed during or after the turn, or that could not be put
 * back, is left as it is. A chapter someone else wrote in between two of the turn's own changes is kept
 * as a conflict copy before anything replaces it, and is left as it is when the copy cannot be made.
 */
async function undoEntry(library: Library, bookId: string, entry: CheckpointEntry): Promise<UndoneEntry> {
  const name = `“${entry.title}”`;
  let kept: UndoneEntry["kept"];
  const left = (why: string): UndoneEntry => ({
    restored: false,
    ...(kept ? { kept } : {}),
    note: `${name} ${why}, so undo left it as it is.${kept ? ` Its text from before the undo is kept at ${kept.savedAs}.` : ""}`
  });
  try {
    let current: Chapter;
    if (entry.deleted) {
      const { chapters } = await library.readBook(bookId);
      if (chapters.some((chapter) => chapter.id === entry.chapterId)) return left("is already back in the book");
      const back = entry.trashedAt ? await fromTrash(library, bookId, entry.chapterId, entry.trashedAt) : null;
      if (back?.status === "already-in-book") return left("is already back in the book");
      if (!back) {
        // The file has left the trash, or an older checkpoint did not say where it went.
        const recreated = await library.createChapter(bookId, { title: entry.title, content: entry.before });
        if (entry.order) await library.moveChapterTo(bookId, recreated.id, entry.order - 1);
        return {
          restored: true,
          note: `${name} was no longer in the trash, so undo wrote it again as a new chapter with its title and text only.`
        };
      }
      current = back.chapter;
    } else {
      current = await library.readChapter(bookId, entry.chapterId);
      // Text or details that are no longer what the turn left belong to whoever wrote them since. The
      // checkpoint cannot tell an edit during an approval pause from one after the turn, so it says both.
      if (entry.afterHash !== undefined && (await bodyHash(current.content)) !== entry.afterHash) {
        return left("changed during or after the turn");
      }
      if (entry.afterMetaHash !== undefined && (await metaHash(checkpointMeta(current))) !== entry.afterMetaHash) {
        return left("changed during or after the turn");
      }
      if (entry.created) {
        await library.deleteChapter(bookId, entry.chapterId);
        return { restored: true };
      }
    }
    if (entry.outsideEdit) {
      // Words the turn did not write are in this chapter's history. Keep what is there now first.
      const copy = await library.keepConflictCopy(bookId, entry.chapterId, {
        baseVersion: current.version,
        baseHash: current.hash
      });
      if (copy.status !== "kept") return left("changed while undo was reading it");
      kept = { chapterId: entry.chapterId, title: entry.title, savedAs: copy.savedAs };
    }
    const saved = await library.saveChapter(bookId, entry.chapterId, entry.before, {
      baseVersion: current.version,
      baseHash: current.hash
    });
    if (saved.status !== "saved") return left("changed while undo was restoring it");
    current = saved.chapter;
    if (entry.meta && (await metaHash(entry.meta)) !== (await metaHash(checkpointMeta(current)))) {
      // Only the seven details: the entry was read back from a file, and order or id are not undo's.
      const restored = await library.updateChapterMeta(bookId, entry.chapterId, checkpointMeta(entry.meta), {
        baseVersion: current.version,
        baseHash: current.hash
      });
      if (restored.status !== "saved") return left("changed while undo was restoring it");
    }
    if (entry.order) {
      const moved = await library.moveChapterTo(bookId, entry.chapterId, entry.order - 1);
      if (moved.status !== "saved") return left("changed while undo was restoring it");
    }
    if (!kept) return { restored: true };
    return {
      restored: true,
      kept,
      note: `${name} was edited during the turn, so undo kept its text from before the undo at ${kept.savedAs}.`
    };
  } catch {
    return left("could not be put back");
  }
}

/**
 * Bring a deleted chapter's own file back from the trash. A failed restore may mean the author
 * returned it after undo's first read. Check again before recreating anything; an invalid trash
 * reference is not evidence of a missing chapter and must never trigger recreation.
 */
async function fromTrash(
  library: Library, bookId: string, chapterId: string, trashedAt: string
): Promise<{ status: "restored"; chapter: Chapter } | { status: "already-in-book" } | null> {
  try {
    return { status: "restored", chapter: await library.restoreChapter(bookId, chapterId, trashedAt) };
  } catch (error) {
    if (error instanceof LibraryError && (error.code === "not-found" || error.code === "invalid")) {
      const { chapters } = await library.readBook(bookId);
      if (chapters.some((chapter) => chapter.id === chapterId)) return { status: "already-in-book" };
      if (error.code === "not-found") return null;
    }
    throw error;
  }
}

/**
 * Why an undo that named its turn did nothing: another change owns the book's newest checkpoint, or
 * none is left. The newest is named by its request and the chapters it changed, never by a path.
 */
function staleUndoMessage(newest: TurnCheckpoint | null): string {
  const lead = "The book changed since that turn, so nothing was undone.";
  if (!newest) return `${lead} No agent turn is left to undo.`;
  const titles = [...new Set(newest.entries.map((entry) => `“${entry.title}”`))];
  const where =
    titles.length === 0
      ? ""
      : titles.length <= 2
        ? ` in ${titles.join(" and ")}`
        : ` in ${titles[0]} and ${titles.length - 1} more chapters`;
  return `${lead} The newest change is “${titleFromPrompt(newest.prompt)}”${where}.`;
}

/**
 * What the author is told about a tool that threw. The library's refusal is written for the author and
 * names only ids, so it is kept. Any other exception is the program's own, and its text can name paths
 * on this computer, so the conversation file gets a plain line instead.
 */
function toolErrorMessage(error: unknown): string {
  if (!(error instanceof LibraryError)) return "The tool failed.";
  return redact(error.message.trim()).slice(0, 500) || "The tool failed.";
}

function assistantParts(reasoning: string, tools: AgentPart[], text: string, error?: AgentPart): AgentPart[] {
  const parts: AgentPart[] = [];
  if (reasoning.trim()) parts.push({ type: "reasoning", text: reasoning.trim() });
  parts.push(...tools);
  if (text.trim()) parts.push({ type: "text", text: text.trim() });
  if (error) parts.push(error);
  return parts.length > 0 ? parts : [{ type: "error", code: "empty", message: "The model returned no text." }];
}

function titleFromPrompt(prompt: string): string {
  const line = prompt.split(/\r?\n/, 1)[0]?.trim() ?? "";
  if (!line) return "New conversation";
  // Count code points, not UTF-16 units: a 60-unit slice can split an emoji and store a lone
  // surrogate, which the checked conversation reader refuses.
  const points = Array.from(line);
  return points.length > 60 ? `${points.slice(0, 60).join("")}…` : line;
}
