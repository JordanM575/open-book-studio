import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { FormEvent, ReactElement } from "react";
import { Cpu, GitBranch, History, Monitor, Pencil, Plus, Trash2, X } from "lucide-react";
import type { AgentEvent, AgentPlanTurnRef, AgentTurnInput } from "@ai-book-studio/core/agent";
import { agentModeSchema, type AgentMode, type AgentPlan } from "@ai-book-studio/core/agent/messages";
import type { ThreadSummary } from "@ai-book-studio/core/agent/threads";
import { modelDisplayName } from "@ai-book-studio/core/providers/compatibility";
import { Button } from "@ai-book-studio/ui/button";
import { Dialog, DialogContent, DialogFooter } from "@ai-book-studio/ui/dialog";
import { Tooltip, TooltipContent, TooltipTrigger } from "@ai-book-studio/ui/components/tooltip";
import { Bubble, BubbleContent } from "@ai-book-studio/ui/components/bubble";
import { InputGroupAddon, InputGroupButton } from "@ai-book-studio/ui/components/input-group";
import { Marker, MarkerContent } from "@ai-book-studio/ui/components/marker";
import { Message as MessageRow, MessageContent, MessageFooter } from "@ai-book-studio/ui/components/message";
import { Checkpoint, CheckpointIcon, CheckpointTrigger } from "@ai-book-studio/ui/ai-elements/checkpoint";
import {
  Confirmation,
  ConfirmationAction,
  ConfirmationActions,
  ConfirmationRequest,
  ConfirmationTitle
} from "@ai-book-studio/ui/ai-elements/confirmation";
import {
  Context,
  ContextContent,
  ContextContentBody,
  ContextContentFooter,
  ContextContentHeader,
  ContextTrigger
} from "@ai-book-studio/ui/ai-elements/context";
import {
  Conversation,
  ConversationContent,
  ConversationEmptyState,
  ConversationItem,
  ConversationScrollButton
} from "@ai-book-studio/ui/ai-elements/conversation";
import {
  PromptInput,
  PromptInputFooter,
  PromptInputSubmit,
  PromptInputTextarea,
  PromptInputTools
} from "@ai-book-studio/ui/ai-elements/prompt-input";
import { Suggestion, Suggestions } from "@ai-book-studio/ui/ai-elements/suggestion";
import { Tool, ToolContent, ToolHeader, ToolLine, ToolOutput, Tools } from "@ai-book-studio/ui/ai-elements/tool";
import { cn, must } from "../lib/utils";
import type { HandsFreeAdmission, HandsFreePort, HandsFreeTurn } from "../lib/hands-free";
import { HandsFreeBar } from "./HandsFreeBar";
import { PlanFirstControl, type PlanProposalRequest } from "./PlanFirstControl";
import {
  PlanProgress,
  type PlanActionOutcome,
  type PlanCancelRef,
  type PlanResumeRef,
  type PlanStartRef
} from "./PlanProgress";
import {
  approvalLabel,
  keptNote,
  toChatMessage,
  toolDetailText,
  toolLabel,
  toolStatus,
  usageNote,
  waitWords,
  type Approval,
  type Message
} from "../lib/chat-view";

interface Props {
  bookId: string;
  chapterId: string | null;
  /** Open this conversation instead of the newest, as a window reopened after a background turn does. */
  openThreadId?: string | null | undefined;
  onClose: () => void;
  onBeforeSend: () => Promise<void>;
  onChanged: () => Promise<void> | void;
  onReconnect: () => void;
  onChooseModel: () => void;
  onChooseTurnModel: () => void;
  /** A one-off model for the next message. The book default stays unchanged. */
  turnModel?: { connectionId: string; modelId: string } | null;
  onTurnModelUsed: () => void;
  /** A tool kept a conflict copy, so the workspace can count it. */
  onConflictCopy?: () => void;
  onNotice: (error: unknown) => void;
  /**
   * A trusted hands-free host adapter. This build ships none: without one the Discuss bar says so
   * and records nothing. A synthetic test adapter proves the mounted controls and binding.
   */
  handsFreePort?: HandsFreePort | undefined;
  className?: string;
}

function nextId(): string {
  return `m_${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * The proposal request is one user message. Ordered suggestions are labelled as suggestions,
 * never as the durable plan; the stored proposal remains the agent's.
 */
function planRequestPrompt(request: PlanProposalRequest): string {
  const steps = request.steps.map((step, index) => `${index + 1}. ${step}`).join("\n");
  return steps.length > 0
    ? `${request.request}\n\nSteps to consider:\n${steps}`
    : request.request;
}

/** What a typed or hands-free turn carries into the one checked start path. */
interface SendOptions {
  readonly mode: AgentMode;
  readonly threadId: string | undefined;
  readonly guidance: string | undefined;
  readonly model: { connectionId: string; modelId: string } | undefined;
  readonly background: boolean;
  readonly resetComposer: boolean;
  /** A proposal turn carries no plan content; the runtime stores the reviewed proposal. */
  readonly planProposal?: boolean;
  /** Identity-only continuation of a stored plan. */
  readonly plan?: AgentPlanTurnRef;
  /** A refused Start stored no user message, so its optimistic local rows are removed. */
  readonly discardOnFailure?: boolean;
  readonly voiceAdmission?: HandsFreeAdmission;
}

/** Local display includes voice words awaiting admission; those are not conversation history. */
type PanelMessage = Message & { historyEligible?: boolean };

const APPROVAL_STATUS: Record<Approval["status"], string> = {
  pending: "Waiting",
  approved: "Allowed",
  denied: "Denied",
  expired: "Expired"
};

/** Prompts the empty conversation offers. Picking one fills the field; it never sends by itself. */
const SUGGESTIONS = ["Draft the next scene", "Tighten this paragraph", "Check what happened earlier"];

/** Runtime control tools are not book actions, so the plan card is their author-facing record. */
const PLAN_TOOL_NAMES = new Set(["propose_plan", "plan_step"]);

const TOOL_DOT: Record<ReturnType<typeof toolStatus>, string> = {
  running: "bg-[var(--warning)]",
  done: "bg-[var(--success)]",
  error: "bg-[var(--destructive)]"
};

/** A short hint on hover and keyboard focus, in place of the browser's title tooltip. */
function Hint({ label, children }: { label: string; children: ReactElement }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

function ToolDot({ status }: { status: ReturnType<typeof toolStatus> }) {
  return <span className={cn("size-1.5 rounded-full", TOOL_DOT[status])} />;
}

/**
 * The author's side of one conversation with the writing agent. Text arrives as the model produces
 * it; tool activity is reduced to short, human lines. The panel never sees a key or a raw provider
 * request.
 */
export function ChatPanel({
  bookId,
  chapterId,
  openThreadId,
  onClose,
  onBeforeSend,
  onChanged,
  onReconnect,
  onChooseModel,
  onChooseTurnModel,
  turnModel,
  onTurnModelUsed,
  onConflictCopy,
  onNotice,
  handsFreePort,
  className
}: Props) {
  const [messages, setMessages] = useState<PanelMessage[]>([]);
  const [input, setInput] = useState("");
  const [mode, setMode] = useState<AgentMode>("discuss");
  const [guidance, setGuidance] = useState("");
  const guidanceTooLong = guidance.length > 2_000;
  const [running, setRunning] = useState(false);
  const [waiting, setWaiting] = useState(false);
  const [background, setBackground] = useState(false);
  const [threadId, setThreadId] = useState<string | null>(null);
  /**
   * The conversation's turns that left a checkpoint, newest last, as the thread file lists them.
   * Undo always takes the book's newest checkpoint, so only the last of these offers it.
   */
  const [checkpointTurns, setCheckpointTurns] = useState<string[]>([]);
  /**
   * The stored plans the thread file returned, oldest first. They are updated only from a
   * confirmed plan notice, a Start acknowledgement, or a later thread read; never from a local
   * draft or an optimistic message.
   */
  const [plans, setPlans] = useState<AgentPlan[]>([]);
  const [planAction, setPlanAction] = useState<"propose" | "start" | "resume" | "cancel" | null>(null);
  const [planNotice, setPlanNotice] = useState<string | null>(null);
  /** The plan of the live, acknowledged plan turn this window started. */
  const [livePlanId, setLivePlanId] = useState<string | null>(null);
  /** The plan whose stop was requested and whose terminal event has not arrived. */
  const [stoppingPlanId, setStoppingPlanId] = useState<string | null>(null);
  /** The plan whose live cancel is settling or was confirmed before its stopped event. */
  const [cancellingPlanId, setCancellingPlanId] = useState<string | null>(null);
  /** The stopped event's change and undo facts for a pause this window confirmed. */
  const [pauseSummary, setPauseSummary] = useState<{
    planId: string;
    changed: number;
    undoAvailable?: boolean;
  } | null>(null);
  /** The stopped event's change and undo facts for a cancel this window confirmed. */
  const [cancelSummary, setCancelSummary] = useState<{
    planId: string;
    changed: number;
    undoAvailable?: boolean;
  } | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [threads, setThreads] = useState<ThreadSummary[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<ThreadSummary | null>(null);
  const turnRef = useRef<string | null>(null);
  const stoppingRef = useRef<string | null>(null);
  const livePlanRef = useRef<string | null>(null);
  const stoppingPlanRef = useRef<string | null>(null);
  /** Set by a confirm-pause notice; only the terminal stopped event may show Paused. */
  const pauseConfirmedRef = useRef<{ planId: string; turnId: string } | null>(null);
  /** A live cancel was requested for this plan/turn. It is not a confirmation. */
  const cancelAttemptRef = useRef<{ planId: string; turnId: string } | null>(null);
  /** Set only by a confirmed `plan { change: "cancel" }` notice. A request alone is not a confirm. */
  const cancelConfirmedRef = useRef<{ planId: string; turnId: string } | null>(null);
  /** A cancel plan-error can beat the live Cancel response; it must not be re-entered. */
  const cancelFailureRef = useRef<{ planId: string; turnId: string } | null>(null);
  /** Guards duplicate plan actions in the same tick, before React state renders. */
  const planActionRef = useRef<"propose" | "start" | "resume" | "cancel" | null>(null);
  const assistantRef = useRef<string | null>(null);
  const retryRequestsRef = useRef(new Map<string, AgentTurnInput>());
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const loadToken = useRef(0);
  const planReadToken = useRef(0);
  const plansRef = useRef<AgentPlan[]>([]);
  const noticeRef = useRef(onNotice);
  const threadIdRef = useRef<string | null>(threadId);
  const voiceView = useRef({ epoch: 0, mounted: false, bookId, chapterId, threadId, openThreadId });

  useLayoutEffect(() => {
    voiceView.current = { epoch: voiceView.current.epoch + 1, mounted: true, bookId, chapterId, threadId, openThreadId };
    return () => { voiceView.current.mounted = false; voiceView.current.epoch += 1; };
  }, [bookId, chapterId, threadId, openThreadId]);

  useEffect(() => {
    noticeRef.current = onNotice;
  }, [onNotice]);

  useEffect(() => {
    threadIdRef.current = threadId;
  }, [threadId]);

  // The refs are read now, not inside the update: the callers clear them right after
  // patching, and an update that runs later must still land on this turn's message.
  const patchAssistant = useCallback((turnId: string, patch: (message: Message) => Message) => {
    const liveTurn = turnRef.current;
    const liveAssistant = assistantRef.current;
    if (liveTurn !== turnId) return;
    setMessages((current) =>
      current.map((message) => (message.id === liveAssistant ? patch(message) : message))
    );
  }, []);

  const patchMessage = useCallback((id: string, patch: (message: Message) => Message) => {
    setMessages((current) => current.map((message) => (message.id === id ? patch(message) : message)));
  }, []);

  /** Write one stored plan list to the screen and to the event handler's synchronous view. */
  const applyPlans = useCallback((next: AgentPlan[]) => {
    plansRef.current = next;
    setPlans(next);
  }, []);

  /** Keep the synchronous guard and the visible action state together. */
  const setPlanActionState = useCallback((next: "propose" | "start" | "resume" | "cancel" | null) => {
    planActionRef.current = next;
    setPlanAction(next);
  }, []);

  /** A new conversation or thread switch holds no live, stopping, cancel or pause view. */
  const clearPlanTurnView = useCallback(() => {
    livePlanRef.current = null;
    setLivePlanId(null);
    stoppingPlanRef.current = null;
    setStoppingPlanId(null);
    pauseConfirmedRef.current = null;
    setPauseSummary(null);
    setCancellingPlanId(null);
    setCancelSummary(null);
    cancelAttemptRef.current = null;
    cancelConfirmedRef.current = null;
    cancelFailureRef.current = null;
  }, []);

  /** Re-read the conversation after a confirmed plan notice or a terminal turn. */
  const refreshStoredPlans = useCallback(async (): Promise<void> => {
    const id = threadIdRef.current;
    if (!id) return;
    const token = ++planReadToken.current;
    try {
      const thread = await must(window.studio.agent.threads.read(bookId, id));
      if (token !== planReadToken.current) return;
      if (thread) applyPlans(thread.plans ?? []);
    } catch (error) {
      if (token === planReadToken.current) noticeRef.current(error);
    }
  }, [applyPlans, bookId]);

  // Load the requested conversation, or else the newest stored one for this book. A send cancels
  // this read so it cannot overwrite a turn the author already started.
  useEffect(() => {
    const token = ++loadToken.current;
    planReadToken.current += 1;
    setThreadId(null);
    setMessages([]);
    setCheckpointTurns([]);
    setPlans([]);
    plansRef.current = [];
    clearPlanTurnView();
    setPlanActionState(null);
    setPlanNotice(null);
    setMode("discuss");
    setGuidance("");
    void (async () => {
      try {
        const id = openThreadId ?? (await must(window.studio.agent.threads.list(bookId)))[0]?.id;
        if (!id || token !== loadToken.current) return;
        const thread = await must(window.studio.agent.threads.read(bookId, id));
        if (!thread || token !== loadToken.current) return;
        const checkpointTurn = thread.checkpointTurns.at(-1);
        setThreadId(thread.id);
        threadIdRef.current = thread.id;
        setCheckpointTurns(thread.checkpointTurns);
        setMessages(thread.messages.map((message) => toChatMessage(message, checkpointTurn)));
        applyPlans(thread.plans ?? []);
      } catch (error) {
        if (token === loadToken.current) noticeRef.current(error);
      }
    })();
    return () => {
      loadToken.current += 1;
    };
  }, [applyPlans, bookId, clearPlanTurnView, openThreadId, setPlanActionState]);

  const startNew = (): void => {
    if (running) return;
    loadToken.current += 1;
    planReadToken.current += 1;
    setThreadId(null);
    threadIdRef.current = null;
    setMessages([]);
    setCheckpointTurns([]);
    applyPlans([]);
    clearPlanTurnView();
    setPlanActionState(null);
    setPlanNotice(null);
    setInput("");
    setMode("discuss");
    setGuidance("");
    setHistoryOpen(false);
    retryRequestsRef.current.clear();
    assistantRef.current = null;
    turnRef.current = null;
  };

  const openHistory = async (): Promise<void> => {
    if (running) return;
    setHistoryOpen(true);
    setHistoryLoading(true);
    try {
      setThreads(await must(window.studio.agent.threads.list(bookId)));
    } catch (error) {
      onNotice(error);
    } finally {
      setHistoryLoading(false);
    }
  };

  const loadThread = async (id: string): Promise<void> => {
    if (running) return;
    try {
      const thread = await must(window.studio.agent.threads.read(bookId, id));
      if (!thread) return;
      const checkpointTurn = thread.checkpointTurns.at(-1);
      planReadToken.current += 1;
      setThreadId(thread.id);
      threadIdRef.current = thread.id;
      setCheckpointTurns(thread.checkpointTurns);
      setMessages(thread.messages.map((message) => toChatMessage(message, checkpointTurn)));
      applyPlans(thread.plans ?? []);
      clearPlanTurnView();
      setPlanActionState(null);
      setPlanNotice(null);
      setHistoryOpen(false);
    } catch (error) {
      onNotice(error);
    }
  };

  const beginRename = (thread: ThreadSummary): void => {
    setRenamingId(thread.id);
    setRenameValue(thread.title);
  };

  const saveRename = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    const title = renameValue.trim();
    if (!renamingId || !title) return;
    try {
      const updated = await must(window.studio.agent.threads.rename(bookId, renamingId, title));
      setThreads((current) =>
        current.map((thread) =>
          thread.id === renamingId ? { ...thread, title: updated.title, updatedAt: updated.updatedAt } : thread
        )
      );
      setRenamingId(null);
    } catch (error) {
      onNotice(error);
    }
  };

  const deleteThread = async (): Promise<void> => {
    const target = deleteTarget;
    if (!target) return;
    try {
      await must(window.studio.agent.threads.remove(bookId, target.id));
      setThreads((current) => current.filter((thread) => thread.id !== target.id));
      if (threadId === target.id) {
        setThreadId(null);
        threadIdRef.current = null;
        setMessages([]);
        setCheckpointTurns([]);
        applyPlans([]);
        clearPlanTurnView();
        setPlanActionState(null);
        setPlanNotice(null);
      }
      setDeleteTarget(null);
    } catch (error) {
      onNotice(error);
    }
  };

  const branchFrom = async (message: Message): Promise<void> => {
    if (running || !threadId || !message.turnId) return;
    try {
      const created = await must(window.studio.agent.threads.fork(bookId, threadId, message.turnId));
      const checkpointTurn = created.checkpointTurns.at(-1);
      planReadToken.current += 1;
      setThreadId(created.id);
      threadIdRef.current = created.id;
      setCheckpointTurns(created.checkpointTurns);
      setMessages(created.messages.map((entry) => toChatMessage(entry, checkpointTurn)));
      applyPlans(created.plans ?? []);
      clearPlanTurnView();
      setPlanActionState(null);
      setPlanNotice(null);
      setHistoryOpen(false);
    } catch (error) {
      onNotice(error);
    }
  };

  const startAttempt = async (
    assistantId: string,
    request: AgentTurnInput,
    voice?: { admission: HandsFreeAdmission; userMessageId: string }
  ): Promise<
    | { ok: true; threadId: string; plan?: { id: string; revision: number; status: "running" } }
    | { ok: false; reason: string; code?: string }
  > => {
    const voiceViewEpoch = voiceView.current.epoch;
    assistantRef.current = assistantId;
    turnRef.current = null;
    setRunning(true);
    setWaiting(true);
    setMessages((current) =>
      current.map((message) =>
        message.id === assistantId
          ? { ...message, text: "", tools: [], note: undefined, failed: false, retryable: undefined, errorCode: undefined, turnId: undefined, changed: 0, undoAvailable: undefined, approvals: undefined }
          : message
      )
    );

    let dispatched = false;
    try {
      await onBeforeSend();
      const dispatch = () => {
        dispatched = true;
        return window.studio.agent.start(request);
      };
      const started = voice
        ? await voice.admission.dispatch(request, () => voiceView.current.mounted && voiceView.current.epoch === voiceViewEpoch,
          () => {
            dispatched = true;
            // Only the actual admitted start makes these displayed words eligible for later
            // history. Refusal/flush failure leaves them local; a later start failure does not.
            setMessages((current) => current.map((item) => item.id === voice.userMessageId
              ? { ...item, historyEligible: true } : item));
          })
        : await dispatch();
      if (!started) {
        // Revoked before dispatch: keep the words visible, without a retry that could bypass a
        // new voice session's admission. Typed messages continue through this same flush/start path.
        const reason = "The voice session ended before dispatch. Nothing was sent.";
        retryRequestsRef.current.delete(assistantId);
        setMessages((current) => current.map((item) => item.id === assistantId
          ? { ...item, failed: true, retryable: false, note: reason } : item));
        setRunning(false);
        setWaiting(false);
        return { ok: false, reason };
      }
      if (!started.ok) {
        throw Object.assign(new Error(started.error.message), { code: started.error.code });
      }
      if (voice && voiceView.current.epoch !== voiceViewEpoch) {
        // Dispatch already happened: return its real receipt, without rebinding a changed panel
        // to the old book/thread. Stop listening alone does not change this view identity.
        if (voiceView.current.mounted) { setRunning(false); setWaiting(false); }
        return {
          ok: true,
          threadId: started.data.threadId,
          ...(started.data.plan ? { plan: started.data.plan } : {})
        };
      }
      turnRef.current = started.data.turnId;
      setThreadId(started.data.threadId);
      threadIdRef.current = started.data.threadId;
      retryRequestsRef.current.set(assistantId, { ...request, threadId: started.data.threadId });
      if (request.model) onTurnModelUsed();
      setWaiting(false);
      return {
        ok: true,
        threadId: started.data.threadId,
        ...(started.data.plan ? { plan: started.data.plan } : {})
      };
    } catch (error) {
      const retryable = !voice || dispatched;
      if (!retryable) retryRequestsRef.current.delete(assistantId);
      const message = error instanceof Error ? error.message : String(error);
      const code = error && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : undefined;
      turnRef.current = null;
      setMessages((current) =>
        current.map((item) =>
          item.id === assistantId
            ? { ...item, failed: true, retryable, note: message, errorCode: code, changed: 0, undoAvailable: true }
            : item
        )
      );
      setRunning(false);
      setWaiting(false);
      onNotice(error);
      return { ok: false, reason: message, ...(code ? { code } : {}) };
    }
  };

  const retry = async (assistantId: string): Promise<void> => {
    const request = retryRequestsRef.current.get(assistantId);
    if (!request || running) return;
    await startAttempt(assistantId, request);
  };

  useEffect(() => {
    const unsubscribe = window.studio.agent.onEvent((event: AgentEvent) => {
      if (event.turnId !== turnRef.current) return;
      // A terminal stopped event shows Cancelled only for a cancel this window saw confirmed.
      const cancelConfirmation = cancelConfirmedRef.current;
      const cancelledStop = event.type === "stopped" && cancelConfirmation !== null &&
        cancelConfirmation.turnId === event.turnId;
      // A turn that changed the book and saved its checkpoint now owns the newest one, the next undo.
      // The runtime lists it in the thread file on the same terms.
      if ((event.type === "done" || event.type === "stopped" || event.type === "error") && event.changed && event.undoAvailable) {
        const turnId = event.turnId;
        setCheckpointTurns((current) => (current.includes(turnId) ? current : [...current, turnId]));
      }
      // A terminal turn is the moment to re-read stored plans: a plan write that failed reports
      // through `plan-error`, and the thread file still owns the last confirmed state.
      if (event.type === "done" || event.type === "stopped" || event.type === "error") {
        const confirmation = pauseConfirmedRef.current;
        // Paused is shown only after the terminal stopped event for the turn whose pause this
        // window saw confirmed. A confirm-pause notice alone never reaches this branch.
        const pausedHere = event.type === "stopped" && confirmation !== null &&
          confirmation.turnId === event.turnId && confirmation.planId === livePlanRef.current;
        if (cancelledStop && cancelConfirmation) {
          const planId = cancelConfirmation.planId;
          setPlans((current) => {
            const next = current.map((plan) =>
              plan.id === planId ? { ...plan, status: "cancelled" as const } : plan
            );
            plansRef.current = next;
            return next;
          });
          setCancelSummary({
            planId,
            changed: event.changed ?? 0,
            ...(event.undoAvailable !== undefined ? { undoAvailable: event.undoAvailable } : {})
          });
        } else if (pausedHere) {
          const planId = confirmation.planId;
          setPlans((current) => {
            const next = current.map((plan) =>
              plan.id === planId ? { ...plan, status: "paused" as const } : plan
            );
            plansRef.current = next;
            return next;
          });
          setPauseSummary({
            planId,
            changed: event.changed ?? 0,
            ...(event.undoAvailable !== undefined ? { undoAvailable: event.undoAvailable } : {})
          });
        } else {
          setPauseSummary(null);
          setCancelSummary(null);
        }
        pauseConfirmedRef.current = null;
        cancelAttemptRef.current = null;
        cancelConfirmedRef.current = null;
        cancelFailureRef.current = null;
        setCancellingPlanId(null);
        stoppingRef.current = null;
        stoppingPlanRef.current = null;
        setStoppingPlanId(null);
        livePlanRef.current = null;
        setLivePlanId(null);
        setPlanActionState(null);
        void refreshStoredPlans();
      }
      if (event.type === "stopping") {
        stoppingRef.current = event.turnId;
        stoppingPlanRef.current = livePlanRef.current;
        setStoppingPlanId(livePlanRef.current);
        patchAssistant(event.turnId, (message) => ({
          ...message,
          note: cancelAttemptRef.current?.turnId === event.turnId
            ? "Cancelling… Waiting for in-flight work to settle. Completed edits stay."
            : "Stopping… Waiting for in-flight work to settle."
        }));
      } else if (event.type === "text") {
        patchAssistant(event.turnId, (message) => ({ ...message, text: message.text + event.delta }));
      } else if (event.type === "reasoning") {
        // Reasoning is deliberately not shown; the author sees the result, not the machinery.
      } else if (event.type === "tool") {
        patchAssistant(event.turnId, (message) => {
          const tools = [...message.tools];
          const index = tools.findIndex((tool) => tool.id === event.id && tool.status === "start");
          if (event.status === "start") {
            tools.push({ id: event.id, name: event.name, status: "start", input: event.input });
          } else if (index >= 0) {
            tools[index] = {
              ...tools[index]!,
              status: "end",
              output: event.output,
              ...(event.detail ? { detail: event.detail } : {})
            };
          } else {
            tools.push({
              id: event.id,
              name: event.name,
              status: "end",
              output: event.output,
              ...(event.detail ? { detail: event.detail } : {})
            });
          }
          return { ...message, tools };
        });
        // A refused overwrite kept its text in `conflicts/`; the workspace counts it now, not at the turn's end.
        const output = event.output as { savedAs?: unknown } | null | undefined;
        if (event.status === "end" && typeof output?.savedAs === "string") onConflictCopy?.();
      } else if (event.type === "approval") {
        patchAssistant(event.turnId, (message) => ({
          ...message,
          turnId: event.turnId,
          approvals: [
            ...(message.approvals ?? []).filter((entry) => entry.id !== event.approvalId),
            {
              id: event.approvalId,
              turnId: event.turnId,
              name: event.name,
              input: event.input,
              status: "pending"
            }
          ],
          note: "Waiting for your approval."
        }));
        setWaiting(false);
      } else if (event.type === "plan") {
        // A confirmed pause is stored, but the author-visible boundary is the terminal stopped
        // event. Record it without changing the local status or re-reading the stored plan,
        // which already says paused and would make the card show Paused too early.
        if (event.change === "confirm-pause") {
          pauseConfirmedRef.current = { planId: event.planId, turnId: event.turnId };
          return;
        }
        setPlanActionState(null);
        setPlanNotice(null);
        // Status and revision here are a confirmed store write. Purpose and steps still come
        // from the thread read below, so a terminal change can close later steps honestly.
        setPlans((current) => {
          const next = current.map((plan) =>
            plan.id === event.planId
              ? { ...plan, revision: event.revision, status: event.status }
              : plan
          );
          plansRef.current = next;
          return next;
        });
        if (event.change === "proposed") {
          // The proposal is stored. The composer returns to its new-turn Discuss default;
          // the plan region keeps the reviewed plan available.
          setMode("discuss");
          setGuidance("");
          setBackground(false);
          setPauseSummary(null);
          // The new plan starts with no cancel view from the earlier one.
          setCancellingPlanId(null);
          setCancelSummary(null);
          cancelAttemptRef.current = null;
          cancelConfirmedRef.current = null;
          cancelFailureRef.current = null;
        }
        if (event.change === "complete" || event.change === "fail" || event.change === "cancel") {
          // A terminal plan wins over the stopping and cancelling labels and can never be Paused.
          pauseConfirmedRef.current = null;
          setPauseSummary(null);
        }
        if (event.change === "cancel") {
          // Only this confirmed notice may show Cancelled. The terminal stopped event still owns
          // the change and undo facts.
          cancelAttemptRef.current = { planId: event.planId, turnId: event.turnId };
          cancelConfirmedRef.current = { planId: event.planId, turnId: event.turnId };
          cancelFailureRef.current = null;
          setCancellingPlanId(event.planId);
          setCancelSummary(null);
        }
        if (event.change === "complete" || event.change === "fail") {
          // A completion or failure race wins; no cancel label or stopped facts survive it.
          cancelAttemptRef.current = null;
          cancelConfirmedRef.current = null;
          cancelFailureRef.current = null;
          setCancellingPlanId(null);
          setCancelSummary(null);
        }
        // Purpose, steps, status and revision are the stored thread's; a notice only says a
        // confirmed write happened.
        void refreshStoredPlans();
      } else if (event.type === "plan-step") {
        setPlanActionState(null);
        setPlanNotice(null);
        setPlans((current) => {
          const next = current.map((plan) =>
            plan.id === event.planId
              ? {
                  ...plan,
                  revision: event.revision,
                  status: event.status,
                  steps: plan.steps.map((step, index) =>
                    index === event.index ? { ...step, state: event.state } : step
                  )
                }
              : plan
          );
          plansRef.current = next;
          return next;
        });
      } else if (event.type === "plan-error") {
        // No state changed. Keep the last confirmed plan and show the fixed sentence.
        if (event.change === "confirm-pause") pauseConfirmedRef.current = null;
        if (event.change === "cancel") {
          // The cancel write failed; the turn is still stopping, so the card falls back to
          // Stopping and never shows Cancelled.
          cancelFailureRef.current = { planId: event.planId, turnId: event.turnId };
          cancelAttemptRef.current = null;
          cancelConfirmedRef.current = null;
          setCancellingPlanId(null);
        }
        setPlanNotice(event.message);
      } else if (event.type === "done") {
        patchAssistant(event.turnId, (message) => ({
          ...message,
          text: event.text || message.text,
          turnId: event.turnId,
          model: event.model.connectionLabel
            ? `${event.model.connectionLabel} · ${event.model.name ?? event.model.modelId}`
            : (event.model.name ?? event.model.modelId),
          context: event.context,
          usage: {
            inputTokens: event.inputTokens,
            outputTokens: event.outputTokens,
            contextLength: event.contextLength
          },
          changed: event.changed ?? 0,
          undoAvailable: event.undoAvailable,
          note:
            usageNote({
              inputTokens: event.inputTokens,
              outputTokens: event.outputTokens,
              costUsd: event.costUsd,
              costBasis: event.costBasis,
              contextLength: event.contextLength
            }) + (event.changed && event.undoAvailable === false ? " · no undo checkpoint" : "") +
            (event.persistenceError ? ` · ${event.persistenceError}` : "")
        }));
        if (assistantRef.current) retryRequestsRef.current.delete(assistantRef.current);
        turnRef.current = null;
        setRunning(false);
        setWaiting(false);
        void onChanged();
      } else if (event.type === "stopped") {
        patchAssistant(event.turnId, (message) => ({
          ...message,
          turnId: event.turnId,
          changed: event.changed ?? 0,
          undoAvailable: event.undoAvailable,
          note: cancelledStop
            ? `Cancelled · ${event.changed
              ? `${event.changed} ${event.changed === 1 ? "chapter" : "chapters"} changed` +
                (event.undoAvailable ? " · undo available" : " · no undo checkpoint")
              : "no book changes"}` +
              (event.persistenceError ? ` · ${event.persistenceError}` : "")
            : `Stopped · ${event.changed ?? 0} ${event.changed === 1 ? "chapter" : "chapters"} changed` +
              (event.changed ? (event.undoAvailable ? " · undo available" : " · no undo checkpoint") : "") +
              (event.persistenceError ? ` · ${event.persistenceError}` : ""),
          approvals: message.approvals?.map((entry) =>
            entry.status === "pending" ? { ...entry, status: "expired" } : entry
          )
        }));
        turnRef.current = null;
        setRunning(false);
        setWaiting(false);
        void onChanged();
      } else if (event.type === "error") {
        patchAssistant(event.turnId, (message) => ({
          ...message,
          failed: true,
          note: event.message + (event.persistenceError ? ` · ${event.persistenceError}` : ""),
          errorCode: event.code,
          ...(event.retryAfterSeconds !== undefined ? { retryAfterSeconds: event.retryAfterSeconds } : {}),
          turnId: event.turnId,
          changed: event.changed ?? 0,
          undoAvailable: event.undoAvailable,
          approvals: message.approvals?.map((entry) =>
            entry.status === "pending" ? { ...entry, status: "expired" } : entry
          )
        }));
        turnRef.current = null;
        setRunning(false);
        setWaiting(false);
        // A turn can fail after it changed a chapter; that change is real, so the editor reloads.
        if (event.changed) void onChanged();
      }
    });
    return unsubscribe;
  }, [onChanged, onConflictCopy, patchAssistant, refreshStoredPlans, setPlanActionState]);

  /**
   * The one checked turn-start path. A typed message and a confirmed hands-free turn both come
   * through here, so there is no second send path and no second provider call.
   */
  const sendPrompt = async (
    raw: string,
    options: SendOptions
  ): Promise<
    | { ok: true; plan?: { id: string; revision: number; status: "running" } }
    | { ok: false; reason: string; code?: string }
  > => {
    const prompt = raw.trim();
    if (!prompt) return { ok: false, reason: "There are no words to send." };
    if (running) return { ok: false, reason: "The conversation is already answering. Wait for it to finish." };
    if (options.guidance !== undefined && options.guidance.length > 2_000) {
      return { ok: false, reason: "Shorten guidance to 2,000 characters before sending." };
    }
    const user: PanelMessage = {
      id: nextId(),
      role: "user",
      text: prompt,
      tools: [],
      historyEligible: !options.voiceAdmission,
      mode: options.mode,
      ...(options.guidance ? { guidance: options.guidance } : {})
    };
    const assistant: Message = { id: nextId(), role: "assistant", text: "", tools: [], mode: options.mode };
    const history = messages
      .filter((message) => message.historyEligible !== false && message.text.trim() && !(message.role === "assistant" && message.failed))
      .slice(-20)
      .map((message) => ({ role: message.role, text: message.text }));
    const request: AgentTurnInput = {
      bookId,
      chapterId,
      prompt,
      mode: options.mode,
      ...(options.guidance ? { guidance: options.guidance } : {}),
      ...(options.threadId ? { threadId: options.threadId } : {}),
      ...(options.planProposal ? { planProposal: true } : {}),
      ...(options.plan ? { plan: options.plan } : {}),
      history,
      ...(options.background ? { background: true } : {}),
      ...(options.model ? { model: options.model } : {})
    };
    if (options.resetComposer) {
      setBackground(false);
      setMode("discuss");
      setGuidance("");
    }
    loadToken.current += 1;
    retryRequestsRef.current.set(assistant.id, request);
    setMessages((current) => [...current, user, assistant]);
    const outcome = await startAttempt(assistant.id, request, options.voiceAdmission
      ? { admission: options.voiceAdmission, userMessageId: user.id } : undefined);
    if (!outcome.ok) {
      if (options.discardOnFailure) {
        // A refused Start is decided before any user message is stored, so the local rows are
        // not a record of the conversation.
        retryRequestsRef.current.delete(assistant.id);
        setMessages((current) => current.filter((message) => message.id !== user.id && message.id !== assistant.id));
      }
      return { ok: false, reason: outcome.reason, ...(outcome.code ? { code: outcome.code } : {}) };
    }
    return { ok: true, ...(outcome.plan ? { plan: outcome.plan } : {}) };
  };

  const send = async (event?: FormEvent): Promise<void> => {
    event?.preventDefault();
    const prompt = input.trim();
    if (!prompt || running || guidanceTooLong) return;
    setInput("");
    await sendPrompt(prompt, {
      mode,
      threadId: threadId ?? undefined,
      guidance: guidance || undefined,
      model: turnModel ?? undefined,
      background,
      resetComposer: true
    });
  };

  const sendVoiceTurn = async (turn: HandsFreeTurn, admission: HandsFreeAdmission): Promise<{ ok: boolean; reason?: string }> => {
    if (turn.bookId !== bookId || turn.chapterId !== chapterId || turn.mode !== "discuss") {
      return { ok: false, reason: "The book or chapter changed. Nothing was sent." };
    }
    if (turn.threadId !== threadIdRef.current) {
      return { ok: false, reason: "The conversation changed. Nothing was sent." };
    }
    return sendPrompt(turn.text, {
      mode: "discuss",
      threadId: turn.threadId,
      guidance: undefined,
      model: undefined,
      background: false,
      resetComposer: false,
      voiceAdmission: admission
    });
  };

  /** Ask once for a read-only Edit proposal. The stored plan, not this request, is reviewed. */
  const proposePlan = async (request: PlanProposalRequest): Promise<PlanActionOutcome> => {
    if (running || planActionRef.current !== null) {
      return { ok: false, reason: "The conversation is already answering. Wait for it to finish." };
    }
    setPlanActionState("propose");
    setPlanNotice(null);
    const outcome = await sendPrompt(planRequestPrompt(request), {
      mode: "edit",
      threadId: threadId ?? undefined,
      guidance: request.guidance,
      model: turnModel ?? undefined,
      background,
      resetComposer: false,
      planProposal: true
    });
    if (!outcome.ok) {
      setPlanActionState(null);
      return { ok: false, reason: outcome.reason };
    }
    // The proposal notice (or its terminal failure) clears this once the turn is over.
    return { ok: true };
  };

  /**
   * Start the reviewed plan as one explicit Edit turn. The ref is identity only; the fixed
   * prompt carries no plan text and no guidance, and the stored plan owns both.
   */
  const startPlan = async (ref: PlanStartRef): Promise<PlanActionOutcome> => {
    if (running || planActionRef.current !== null) {
      return { ok: false, reason: "The conversation is already answering. Wait for it to finish." };
    }
    const id = threadIdRef.current;
    if (!id) {
      return { ok: false, reason: "Open the plan's conversation before starting it. Nothing was started." };
    }
    const stored = plansRef.current.find((plan) => plan.id === ref.id);
    if (!stored) {
      return { ok: false, reason: "That plan is not in this conversation. Nothing was started." };
    }
    if (stored.revision !== ref.revision) {
      return { ok: false, reason: "The plan changed since you reviewed it. Review the current revision before starting." };
    }
    if (stored.status !== "proposed") {
      return { ok: false, reason: "That plan cannot be started. Only a proposed plan can start." };
    }
    setPlanActionState("start");
    setPlanNotice(null);
    const outcome = await sendPrompt("Start the reviewed plan.", {
      mode: "edit",
      threadId: id,
      guidance: undefined,
      model: turnModel ?? undefined,
      background,
      resetComposer: false,
      plan: { id: ref.id, revision: ref.revision, action: "start" },
      discardOnFailure: true
    });
    setPlanActionState(null);
    if (!outcome.ok) {
      return { ok: false, reason: outcome.reason };
    }
    if (outcome.plan) {
      // The only running signal is the confirmed turn-start acknowledgement; Start emits no notice.
      const acknowledged = outcome.plan;
      setPlans((current) => {
        const next = current.map((plan) =>
          plan.id === acknowledged.id
            ? { ...plan, revision: acknowledged.revision, status: acknowledged.status }
            : plan
        );
        plansRef.current = next;
        return next;
      });
      livePlanRef.current = acknowledged.id;
      setLivePlanId(acknowledged.id);
      setPauseSummary(null);
    }
    return { ok: true };
  };

  /**
   * Resume the paused plan as one explicit new Edit turn. The stored plan owns its purpose,
   * steps and guidance; this turn carries no approval and no composer guidance.
   */
  const resumePlan = async (ref: PlanResumeRef): Promise<PlanActionOutcome> => {
    if (running || planActionRef.current !== null) {
      return { ok: false, reason: "The conversation is already answering. Wait for it to finish." };
    }
    const id = threadIdRef.current;
    if (!id) {
      return { ok: false, reason: "Open the plan's conversation before resuming it. Nothing was started." };
    }
    const stored = plansRef.current.find((plan) => plan.id === ref.id);
    if (!stored) {
      return { ok: false, reason: "That plan is not in this conversation. Nothing was started." };
    }
    if (stored.revision !== ref.revision) {
      return { ok: false, reason: "The plan changed since you reviewed it. Review the current revision before resuming." };
    }
    if (stored.status !== "paused") {
      return { ok: false, reason: "That plan cannot be resumed. Only a paused plan resumes." };
    }
    setPlanActionState("resume");
    setPlanNotice(null);
    const outcome = await sendPrompt("Resume the reviewed plan.", {
      mode: "edit",
      threadId: id,
      guidance: undefined,
      model: turnModel ?? undefined,
      background,
      resetComposer: false,
      plan: { id: ref.id, revision: ref.revision, action: "resume" },
      discardOnFailure: true
    });
    setPlanActionState(null);
    if (!outcome.ok) {
      return { ok: false, reason: outcome.reason };
    }
    if (outcome.plan) {
      const acknowledged = outcome.plan;
      setPlans((current) => {
        const next = current.map((plan) =>
          plan.id === acknowledged.id
            ? { ...plan, revision: acknowledged.revision, status: acknowledged.status }
            : plan
        );
        plansRef.current = next;
        return next;
      });
      livePlanRef.current = acknowledged.id;
      setLivePlanId(acknowledged.id);
      setPauseSummary(null);
    }
    return { ok: true };
  };

  /**
   * Cancel one stored plan terminally. A live turn stops through the runtime barrier; a plan with no
   * live turn is cancelled directly. The request is never treated as a confirmation: Cancelled comes
   * only from the returned stored plan or a confirmed `plan { change: "cancel" }` notice.
   */
  const cancelPlan = async (ref: PlanCancelRef): Promise<PlanActionOutcome> => {
    if (planActionRef.current !== null) {
      return { ok: false, reason: "Another plan action is already in flight. Wait for it to finish." };
    }
    const id = threadIdRef.current;
    if (!id) {
      return { ok: false, reason: "Open the plan's conversation before cancelling it. Nothing was changed." };
    }
    const stored = plansRef.current.find((plan) => plan.id === ref.id);
    if (!stored) {
      return { ok: false, reason: "That plan is not in this conversation. Nothing was changed." };
    }
    if (stored.status === "completed" || stored.status === "cancelled" ||
      stored.status === "failed" || stored.status === "expired") {
      return { ok: false, reason: "That plan has already ended. Nothing was changed." };
    }
    setPlanActionState("cancel");
    setPlanNotice(null);
    setCancelSummary(null);
    cancelConfirmedRef.current = null;
    cancelFailureRef.current = null;
    try {
      const answer = await window.studio.agent.cancelPlan({ bookId, threadId: id, planId: ref.id });
      if (!answer.ok) throw new Error(answer.error.message);
      const result = answer.data;
      const replacePlan = (plan: AgentPlan): void => {
        setPlans((current) => {
          const next = current.map((entry) => entry.id === plan.id ? plan : entry);
          plansRef.current = next;
          return next;
        });
      };
      if (result.outcome === "live") {
        setPlanActionState(null);
        if (result.turnId !== turnRef.current) {
          // A reloaded or unowned window learns only the stored plan; it does not fabricate the
          // stopped facts of a turn this view does not hold.
          void refreshStoredPlans();
          return { ok: true };
        }
        const cancelFailure = cancelFailureRef.current as { planId: string; turnId: string } | null;
        if (cancelFailure?.turnId === result.turnId && cancelFailure.planId === ref.id) {
          // The plan-error already recorded the failure; do not re-enter a cancelling label.
          return { ok: true };
        }
        cancelAttemptRef.current = { planId: ref.id, turnId: result.turnId };
        setCancellingPlanId(ref.id);
        patchAssistant(result.turnId, (message) => ({
          ...message,
          note: "Cancelling… Waiting for in-flight work to settle. Completed edits stay."
        }));
        return { ok: true };
      }
      if (result.outcome === "cancelled") {
        replacePlan(result.plan);
        pauseConfirmedRef.current = null;
        setPauseSummary(null);
        setCancelSummary(null);
        setCancellingPlanId(null);
        cancelAttemptRef.current = null;
        cancelConfirmedRef.current = null;
        cancelFailureRef.current = null;
        if (livePlanRef.current === result.plan.id) {
          livePlanRef.current = null;
          setLivePlanId(null);
        }
        if (stoppingPlanRef.current === result.plan.id) {
          stoppingPlanRef.current = null;
          setStoppingPlanId(null);
        }
        setPlanActionState(null);
        void refreshStoredPlans();
        return { ok: true };
      }
      // A completion, failure or expiry won the race. The stored plan is the fact.
      replacePlan(result.plan);
      setPlanActionState(null);
      setCancellingPlanId(null);
      setCancelSummary(null);
      cancelAttemptRef.current = null;
      cancelConfirmedRef.current = null;
      cancelFailureRef.current = null;
      pauseConfirmedRef.current = null;
      setPauseSummary(null);
      setPlanNotice(
        result.plan.status === "completed"
          ? "This plan completed before Cancel. Nothing was cancelled."
          : "This plan already ended. Nothing was changed."
      );
      return { ok: true };
    } catch (error) {
      setPlanActionState(null);
      setCancellingPlanId(null);
      cancelAttemptRef.current = null;
      cancelConfirmedRef.current = null;
      cancelFailureRef.current = null;
      return {
        ok: false,
        reason: error instanceof Error ? error.message : "The plan could not be cancelled. Nothing changed."
      };
    }
  };

  const approve = async (message: Message, approval: Approval, approved: boolean, pressed: HTMLElement): Promise<void> => {
    if (approval.status !== "pending" || stoppingRef.current === approval.turnId) return;
    // Allow and Deny leave with the question. Focus still on them moves to their card before they
    // go, so an answer from the keyboard does not drop focus to the page.
    const card = pressed.closest<HTMLElement>('[data-slot="confirmation"]');
    const keepFocus = (): void => {
      if (card?.contains(document.activeElement)) card.focus();
    };
    try {
      setWaiting(true);
      setRunning(true);
      turnRef.current = approval.turnId;
      assistantRef.current = message.id;
      await must(window.studio.agent.approve(approval.turnId, approval.id, approved));
      const status: Approval["status"] = approved ? "approved" : "denied";
      if (turnRef.current !== approval.turnId || stoppingRef.current === approval.turnId) {
        // The answer won ownership, but its persistence reply can arrive after Stop. Keep the
        // accepted answer without resurrecting a working status or changing terminal controls.
        patchMessage(message.id, (item) => ({ ...item, approvals: item.approvals?.map((entry) =>
          entry.id === approval.id ? { ...entry, status } : entry) }));
        keepFocus();
        return;
      }
      patchMessage(message.id, (item) => ({
        ...item,
        note: approved ? "Approved. Working…" : "Denied. Working…",
        approvals: item.approvals?.map((entry) =>
          entry.id === approval.id ? { ...entry, status } : entry
        )
      }));
      keepFocus();
    } catch (error) {
      if (turnRef.current !== approval.turnId || stoppingRef.current === approval.turnId) return;
      const expired = error instanceof Error && /no longer waiting/i.test(error.message);
      if (expired) {
        patchMessage(message.id, (item) => ({
          ...item,
          note: "This approval expired when the app closed. Ask the agent to try again.",
          approvals: item.approvals?.map((entry) =>
            entry.id === approval.id ? { ...entry, status: "expired" } : entry
          )
        }));
        keepFocus();
        turnRef.current = null;
        assistantRef.current = null;
      } else {
        onNotice(error);
      }
      setWaiting(false);
      setRunning(false);
    }
  };

  const stop = async (): Promise<void> => {
    const turnId = turnRef.current;
    if (!turnId) return;
    stoppingRef.current = turnId;
    stoppingPlanRef.current = livePlanRef.current;
    setStoppingPlanId(livePlanRef.current);
    patchAssistant(turnId, (message) => ({ ...message, note: "Stopping… Waiting for in-flight work to settle." }));
    try {
      // The stop call returning is not the pause boundary. Only the terminal stopped event is.
      await must(window.studio.agent.stop(turnId));
    } catch (error) {
      onNotice(error);
    }
  };

  // The turn is over by the time its undo runs, so the message is patched by id: the
  // turn-scoped patch no longer matches once the turn is gone.
  const undo = async (messageId: string, turnId: string | undefined): Promise<void> => {
    try {
      // Named, so the main process refuses when another turn owns the book's newest checkpoint.
      const answer = await window.studio.agent.undoLast(bookId, turnId);
      if (!answer.ok) {
        // Nothing was undone. Say why on this turn, and read the conversation's undo turns again: an
        // undo from the strip, the CLI or the phone has already taken its turn out of the file.
        patchMessage(messageId, (message) => ({ ...message, note: answer.error.message }));
        const thread = threadId ? await must(window.studio.agent.threads.read(bookId, threadId)) : null;
        if (thread) setCheckpointTurns(thread.checkpointTurns);
        return;
      }
      const result = answer.data;
      // The turn is used up. The turn before it, if any, owns the newest checkpoint now.
      setCheckpointTurns((current) => current.filter((turn) => turn !== turnId));
      // Each note names a chapter that did not simply go back, and where a kept copy is.
      const notes = result.notes?.length ? ` ${result.notes.join(" ")}` : "";
      patchMessage(messageId, (message) => ({
        ...message,
        changed: result.skipped,
        undoAvailable: false,
        note:
          (result.skipped
            ? `Restored ${result.restored} ${result.restored === 1 ? "chapter" : "chapters"}, but skipped ${result.skipped}. Review the remaining changes before retrying.`
            : `Restored ${result.restored} ${result.restored === 1 ? "chapter" : "chapters"}.`) + notes
      }));
      await onChanged();
    } catch (error) {
      onNotice(error);
    }
  };

  const fillSuggestion = (suggestion: string): void => {
    setInput(suggestion);
    inputRef.current?.focus();
  };

  // The last turn still waiting for the author's approval, or -1.
  const lastPending = messages.findLastIndex((message) =>
    message.approvals?.some((approval) => approval.status === "pending")
  );

  // The last stored plan is the one the author is reviewing or running. Older terminal plans
  // remain in the thread file but do not need a second card in the conversation.
  const currentPlan = plans.at(-1) ?? null;
  const modelLabel = turnModel ? `This turn: ${modelDisplayName(turnModel.modelId)}` : "Model: book default";
  const planRegion = currentPlan ? (
    <div data-testid="plan-region" key={currentPlan.id} className="px-1 pb-2">
      <PlanProgress
        plan={currentPlan}
        running={running}
        live={currentPlan.id === livePlanId && running}
        stopping={currentPlan.id === stoppingPlanId}
        resuming={planAction === "resume"}
        pauseSummary={pauseSummary?.planId === currentPlan.id ? pauseSummary : null}
        cancelling={currentPlan.id === cancellingPlanId || planAction === "cancel"}
        cancelSummary={cancelSummary?.planId === currentPlan.id ? cancelSummary : null}
        modelLabel={modelLabel}
        notice={planNotice}
        onStart={startPlan}
        onPause={() => void stop()}
        onResume={resumePlan}
        onCancel={cancelPlan}
      />
    </div>
  ) : null;

  return (
    <aside
      className={cn("glass flex w-[clamp(320px,30vw,400px)] shrink-0 flex-col overflow-hidden rounded-[var(--corner-xl)]", className)}
      aria-label="Writing agent"
      data-testid="chat-panel"
    >
      <header className="flex items-center justify-between border-b border-[var(--glass-outline)] px-4 py-3">
        <div>
          <h2 className="text-(length:--text-headline-size) font-semibold">Writing agent</h2>
          <p className="text-(length:--text-caption-size) text-muted-foreground">Discuss ideas or choose Edit to change your book.</p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Hint label="New conversation">
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={startNew}
              disabled={running}
              aria-label="New conversation"
              className="size-11 min-[700px]:size-7"
              data-testid="agent-new-thread"
            >
              <Plus size={15} />
            </Button>
          </Hint>
          <Hint label="Conversation history">
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => void openHistory()}
              disabled={running}
              aria-label="Conversation history"
              className="size-11 min-[700px]:size-7"
              data-testid="agent-history"
            >
              <History size={15} />
            </Button>
          </Hint>
          <Hint label="Close">
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={onClose}
              aria-label="Close the writing agent"
              className="size-11 min-[700px]:size-7"
            >
              <X size={16} />
            </Button>
          </Hint>
        </div>
      </header>

      <Conversation className="min-h-0 flex-1">
        <ConversationContent>
          {messages.length === 0 ? (
            <ConversationEmptyState
              className="rounded-[var(--corner-lg)] bg-[var(--secondary)] px-4 py-3"
              description="Discuss reads your book without changing it. To request changes, choose Edit for a new turn; destructive changes still ask for approval."
            >
              <Suggestions>
                {SUGGESTIONS.map((suggestion) => (
                  <Suggestion
                    key={suggestion}
                    suggestion={suggestion}
                    onClick={fillSuggestion}
                    data-testid="agent-suggestion"
                  />
                ))}
              </Suggestions>
            </ConversationEmptyState>
          ) : null}

          {messages.map((message, index) => {
            const previousModel = messages
              .slice(0, index)
              .reverse()
              .find((item) => item.role === "assistant" && item.model)?.model;
            const showModel = message.role === "assistant" && message.model && message.model !== previousModel;
            // Undo takes the book's newest checkpoint, so only the turn that owns it offers undo. None does
            // while a turn runs, nor at or before a turn waiting for approval: either may already own the
            // newest checkpoint before the conversation lists it.
            const canUndo =
              !running &&
              index > lastPending &&
              message.role === "assistant" &&
              Boolean(message.turnId) &&
              message.turnId === checkpointTurns.at(-1);
            // A branch copies the conversation, and an approval still waiting cannot be answered from a copy.
            const canBranch =
              message.role === "assistant" &&
              Boolean(message.turnId) &&
              !message.failed &&
              !message.approvals?.some((approval) => approval.status === "pending");
            // `plan_step` and `propose_plan` are runtime control tools, not author-facing book
            // actions. The plan region is their record, so their ordinary rows stay hidden.
            const visibleTools = message.tools.filter((tool) => !PLAN_TOOL_NAMES.has(tool.name));
            return (
              <ConversationItem
                key={message.id}
                messageId={message.id}
                scrollAnchor={message.role === "user"}
                className="flex flex-col gap-3"
              >
                {showModel ? (
                  <Marker variant="separator" className="pt-1 text-xs" data-testid="model-change">
                    <MarkerContent>Now answering with {message.model}</MarkerContent>
                  </Marker>
                ) : null}
                <MessageRow align={message.role === "user" ? "end" : "start"}>
                  <MessageContent className="gap-1.5">
                    <Bubble
                      align={message.role === "user" ? "end" : "start"}
                      variant={message.role === "user" ? "author" : "agent"}
                      className="max-w-[92%]"
                    >
                      <BubbleContent className="px-3.5 py-2.5 text-base">
                        {message.role === "assistant" || message.mode ? (
                          <p className="mb-1 text-xs text-muted-foreground" data-testid="agent-message-mode">
                            {message.mode === "discuss" ? "Discuss" : message.mode === "edit" ? "Edit" : "Mode unrecorded"}
                          </p>
                        ) : null}
                        {message.guidance ? (
                          <details className="mb-2 text-xs text-muted-foreground">
                            <summary className="cursor-pointer rounded-sm focus-visible:outline-2">Guidance for this turn</summary>
                            <p className="whitespace-pre-wrap">{message.guidance}</p>
                          </details>
                        ) : null}
                        {visibleTools.length > 0 ? (
                          <Tools className="mb-2">
                            {visibleTools.map((tool, toolIndex) => {
                              const detail = toolDetailText(tool);
                              const status = toolStatus(tool);
                              const kept = keptNote(tool);
                              const line = {
                                title: toolLabel(tool.name),
                                status,
                                icon: <ToolDot status={status} />,
                                className: "text-(length:--text-caption-size)"
                              };
                              return (
                                // biome-ignore lint/suspicious/noArrayIndexKey: tools update in place by index and never reorder within a message; the index is a tiebreaker for repeated tool names
                                <div key={`${tool.id ?? tool.name}-${toolIndex}`} className="min-w-0">
                                  {detail ? (
                                    <Tool>
                                      <ToolHeader {...line} />
                                      <ToolContent>
                                        <ToolOutput>{detail}</ToolOutput>
                                      </ToolContent>
                                    </Tool>
                                  ) : (
                                    <ToolLine {...line} />
                                  )}
                                  {/* Outside the closed detail: the author's words were kept, and where its own text went. */}
                                  {kept ? (
                                    <div
                                      className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-(length:--text-caption-size) leading-[var(--text-caption-leading)] text-muted-foreground"
                                      data-testid="agent-kept"
                                    >
                                      <span>{kept.text}</span>
                                      {kept.savedAs ? (
                                        <Button
                                          variant="secondary"
                                          size="xs"
                                          onClick={() =>
                                            void must(window.studio.conflicts.reveal(bookId, kept.savedAs ?? "")).catch(onNotice)
                                          }
                                          data-testid="agent-show-copy"
                                        >
                                          Show the saved copy
                                        </Button>
                                      ) : null}
                                    </div>
                                  ) : null}
                                </div>
                              );
                            })}
                          </Tools>
                        ) : null}
                        {/* With the tool steps and before the reply: the turn reads in the order it
                            happened, and the answered card never trails the words that came after it. */}
                        {message.approvals?.map((approval) => (
                          <Confirmation
                            key={approval.id}
                            state={approval.status}
                            tabIndex={-1}
                            className="my-2"
                            data-testid="agent-approval"
                          >
                            <ConfirmationTitle
                              description={
                                approval.status === "pending"
                                  ? "The agent will wait for your answer before changing anything."
                                  : APPROVAL_STATUS[approval.status]
                              }
                            >
                              {approvalLabel(approval.name)}
                            </ConfirmationTitle>
                            <ConfirmationRequest>
                              <ConfirmationActions>
                                <ConfirmationAction
                                  onClick={(event) => void approve(message, approval, true, event.currentTarget)}
                                  data-testid="agent-approve"
                                >
                                  Allow
                                </ConfirmationAction>
                                <ConfirmationAction
                                  variant="outline"
                                  onClick={(event) => void approve(message, approval, false, event.currentTarget)}
                                  data-testid="agent-deny"
                                >
                                  Deny
                                </ConfirmationAction>
                              </ConfirmationActions>
                            </ConfirmationRequest>
                          </Confirmation>
                        ))}
                        {message.text ? (
                          <p className="whitespace-pre-wrap text-(length:--text-body-size) leading-[var(--text-body-leading)]">
                            {message.text}
                          </p>
                        ) : waiting && message.role === "assistant" ? (
                          <p className="text-(length:--text-subheadline-size) text-muted-foreground">Reading and thinking…</p>
                        ) : null}
                        {message.note ? (
                          <p
                            role={message.failed ? "alert" : undefined}
                            className={`mt-2 text-(length:--text-caption-size) ${message.failed ? "text-[var(--destructive-text)]" : "text-muted-foreground"}`}
                          >
                            {message.note}
                          </p>
                        ) : null}
                        {message.failed && message.changed ? (
                          <p role="status" className="mt-2 text-(length:--text-caption-size) text-muted-foreground">
                            This attempt changed {message.changed} {message.changed === 1 ? "chapter" : "chapters"}. Undo it
                            before retrying.
                          </p>
                        ) : null}
                        {message.failed && message.errorCode === "offline" ? (
                          <p
                            role="status"
                            className="mt-2 text-(length:--text-caption-size) text-muted-foreground"
                            data-testid="agent-offline-note"
                          >
                            You are offline. Your words are safe — writing, planning and exporting all still work.
                          </p>
                        ) : null}
                        {message.failed && message.errorCode === "rate-limit" && message.retryAfterSeconds !== undefined ? (
                          <p
                            role="status"
                            className="mt-2 text-(length:--text-caption-size) text-muted-foreground"
                            data-testid="agent-rate-note"
                          >
                            The provider asked to wait. Try again {waitWords(message.retryAfterSeconds)}.
                          </p>
                        ) : null}
                        {message.failed && !message.changed && message.retryable !== false && message.errorCode !== "context" ? (
                          <div className="mt-2 flex flex-wrap gap-2">
                            <Button variant="secondary" size="sm" onClick={() => void retry(message.id)} data-testid="agent-retry-request">
                              Retry request
                            </Button>
                            {message.errorCode === "auth" ? (
                              <Button variant="ghost" size="sm" onClick={onReconnect} data-testid="agent-reconnect">
                                Reconnect
                              </Button>
                            ) : null}
                            {message.errorCode === "invalid-request" ? (
                              <Button variant="ghost" size="sm" onClick={onChooseModel} data-testid="agent-request-model">
                                Choose a model
                              </Button>
                            ) : null}
                            {message.errorCode === "refusal" ? (
                              <Button variant="ghost" size="sm" onClick={onChooseModel} data-testid="agent-try-another-model">
                                Try another model
                              </Button>
                            ) : null}
                          </div>
                        ) : null}
                        {message.failed && message.errorCode === "context" ? (
                          <div className="mt-2 flex flex-wrap gap-2">
                            <Button variant="secondary" size="sm" onClick={onChooseModel} data-testid="agent-context-model">
                              Choose a larger model
                            </Button>
                            <Button variant="outline" size="sm" onClick={startNew} data-testid="agent-context-new">
                              Start a new conversation
                            </Button>
                          </div>
                        ) : null}
                      </BubbleContent>
                    </Bubble>
                    {canBranch || message.context ? (
                      <MessageFooter className="flex-wrap gap-1 px-1 font-normal">
                        {canBranch ? (
                          <Hint label="Copy this conversation up to this turn into a new thread">
                            <Button
                              variant="ghost"
                              size="xs"
                              className="text-muted-foreground hover:text-foreground"
                              onClick={() => void branchFrom(message)}
                              data-testid="agent-branch-turn"
                            >
                              <GitBranch size={13} />
                              Branch from here
                            </Button>
                          </Hint>
                        ) : null}
                        {message.context ? (
                          <Context
                            usedTokens={message.usage?.inputTokens ?? message.context.totalTokens}
                            maxTokens={message.usage?.contextLength ?? undefined}
                          >
                            <ContextTrigger
                              className="font-normal text-muted-foreground hover:text-foreground"
                              data-testid="agent-context"
                            >
                              Context · ~{message.context.totalTokens.toLocaleString()} tokens
                            </ContextTrigger>
                            <ContextContent align="start">
                              {message.usage ? <ContextContentHeader /> : null}
                              <ContextContentBody>
                                <ul className="space-y-0.5">
                                  {message.context.sections.map((section) => (
                                    <li key={section.id} className="flex justify-between gap-3">
                                      <span>{section.label}</span>
                                      <span className="tabular-nums">~{section.estimatedTokens.toLocaleString()}</span>
                                    </li>
                                  ))}
                                  <li className="flex justify-between gap-3">
                                    <span>Conversation</span>
                                    <span className="tabular-nums">~{message.context.conversationTokens.toLocaleString()}</span>
                                  </li>
                                </ul>
                              </ContextContentBody>
                              <ContextContentFooter>
                                Estimated from characters. The provider&apos;s reported usage is authoritative.
                              </ContextContentFooter>
                            </ContextContent>
                          </Context>
                        ) : null}
                      </MessageFooter>
                    ) : null}
                  </MessageContent>
                </MessageRow>
                {canUndo ? (
                  <Checkpoint>
                    <CheckpointIcon>
                      <History />
                    </CheckpointIcon>
                    <CheckpointTrigger onClick={() => void undo(message.id, message.turnId)} data-testid="agent-undo-turn">
                      Undo this turn
                    </CheckpointTrigger>
                  </Checkpoint>
                ) : null}
                {currentPlan && message.id === currentPlan.parent.messageId ? planRegion : null}
              </ConversationItem>
            );
          })}
          {currentPlan && !messages.some((message) => message.id === currentPlan.parent.messageId)
            ? planRegion
            : null}
        </ConversationContent>
        <ConversationScrollButton />
      </Conversation>

      <div className="border-t border-[var(--glass-outline)] p-3">
        <div className="mb-2 space-y-2 text-xs text-muted-foreground">
          <label className="flex items-center gap-2">
            Mode for next turn
            <select
              value={mode}
              onChange={(event) => setMode(agentModeSchema.parse(event.target.value))}
              disabled={running}
              data-testid="agent-mode"
              className="rounded-[var(--corner-sm)] border border-[var(--input)] bg-[var(--card)] px-2 py-1.5 text-foreground focus-visible:outline-2"
            >
              <option value="discuss">Discuss</option>
              <option value="edit">Edit</option>
            </select>
          </label>
          <p role="status">
            {running ? "The sent turn's mode and guidance are fixed. Stop it and send a new turn to change them." :
              mode === "discuss" ? "Read-only. Send a new turn in Edit mode to request changes." :
              "Changes use checked saves and turn undo. Destructive actions still ask for approval."}
          </p>
          <details>
            <summary className="cursor-pointer rounded-sm focus-visible:outline-2">One-turn guidance (optional)</summary>
            <label className="mt-2 block">
              Guidance for next turn
              <textarea
                value={guidance}
                onChange={(event) => setGuidance(event.target.value)}
                disabled={running}
                aria-invalid={guidanceTooLong}
                aria-describedby="agent-guidance-limit"
                data-testid="agent-guidance"
                rows={2}
                className="mt-1 block w-full resize-y rounded-[var(--corner-sm)] border border-[var(--input)] bg-[var(--card)] p-2 text-foreground focus-visible:outline-2"
              />
            </label>
            <p id="agent-guidance-limit">{guidance.length.toLocaleString()} / 2,000 characters · This turn only</p>
            <p>Book tone, answer length and this guidance go to the selected provider when you send. They do not change permissions or the model.</p>
            <Button variant="ghost" size="xs" disabled={running || !guidance} onClick={() => setGuidance("")}>Clear guidance</Button>
          </details>
          {guidanceTooLong ? <p role="alert">Shorten guidance to 2,000 characters before sending. Your text is kept.</p> : null}
        </div>
        {mode === "edit" ? (
          <div className="mb-2">
            <PlanFirstControl
              mode={mode}
              running={running}
              proposing={planAction === "propose"}
              plan={currentPlan}
              notice={planNotice}
              modelLabel={modelLabel}
              onPropose={proposePlan}
              onStart={startPlan}
              live={currentPlan !== null && currentPlan.id === livePlanId && running}
              stopping={currentPlan !== null && currentPlan.id === stoppingPlanId}
              resuming={planAction === "resume"}
              pauseSummary={pauseSummary?.planId === currentPlan?.id ? pauseSummary : null}
              cancelling={currentPlan !== null && (currentPlan.id === cancellingPlanId || planAction === "cancel")}
              cancelSummary={cancelSummary?.planId === currentPlan?.id ? cancelSummary : null}
              onPause={() => void stop()}
              onResume={resumePlan}
              onCancel={cancelPlan}
            />
          </div>
        ) : null}
        {mode === "discuss" ? (
          <HandsFreeBar
            bookId={bookId}
            chapterId={chapterId}
            threadId={threadId}
            {...(handsFreePort ? { port: handsFreePort } : {})}
            onSendTurn={sendVoiceTurn}
            onNotice={onNotice}
            disabled={running}
          />
        ) : null}
        <PromptInput onSubmit={(event) => void send(event)} groupClassName="rounded-[var(--corner-lg)]">
          <PromptInputTextarea
            ref={inputRef}
            value={input}
            onChange={(event) => setInput(event.target.value)}
            rows={4}
            className="min-h-24 px-3.5 py-3"
            placeholder={mode === "discuss" ? "What would you like to discuss?" : "What should change?"}
            aria-label="Message the writing agent"
            data-testid="chat-input"
          />
          <PromptInputFooter className="items-end">
            <PromptInputTools className="flex-1 flex-wrap gap-1.5">
              <Hint label="Choose a model for the next message only">
                <InputGroupButton
                  variant="ghost"
                  size="xs"
                  onClick={onChooseTurnModel}
                  data-testid="agent-turn-model"
                  className="min-w-0 max-w-full gap-1.5 px-2 text-xs font-normal text-muted-foreground hover:text-foreground"
                >
                  <Cpu size={13} className="shrink-0" />
                  <span className="truncate">
                    {turnModel ? `This turn: ${modelDisplayName(turnModel.modelId)}` : "Model: book default"}
                  </span>
                </InputGroupButton>
              </Hint>
              <Hint label="Keep the turn running after the window closes and notify you when it finishes">
                <label
                  className="relative flex shrink-0 cursor-pointer items-center rounded-[var(--corner-md)] focus-within:ring-2 focus-within:ring-[var(--ring)] has-disabled:cursor-not-allowed"
                >
                  <input
                    type="checkbox"
                    checked={background}
                    onChange={(event) => setBackground(event.target.checked)}
                    disabled={running}
                    aria-label="Background"
                    data-testid="agent-background"
                    className="peer sr-only"
                  />
                  <span className="inline-flex min-h-8 items-center gap-1.5 rounded-[var(--corner-md)] border border-[var(--border)] px-2 text-xs text-muted-foreground transition-colors hover:bg-[var(--accent)] peer-checked:border-[var(--primary)] peer-checked:bg-[var(--accent)] peer-checked:text-foreground peer-disabled:opacity-50">
                    <Monitor size={13} aria-hidden="true" />
                    Background
                    <span className="text-[10px] font-medium">{background ? "On" : "Off"}</span>
                  </span>
                </label>
              </Hint>
            </PromptInputTools>
            {running ? (
              <PromptInputSubmit status="streaming" onStop={() => void stop()} data-testid="chat-stop" />
            ) : (
              <PromptInputSubmit disabled={!input.trim() || guidanceTooLong} data-testid="chat-send" />
            )}
          </PromptInputFooter>
          {/* Its own line: in the narrow chat panel it would squeeze the model and Background controls. */}
          <InputGroupAddon
            align="block-end"
            className="hidden cursor-default pt-0 text-xs font-normal text-muted-foreground min-[520px]:flex"
          >
            Enter sends · Shift Enter adds a line
          </InputGroupAddon>
        </PromptInput>
      </div>

      <Dialog open={historyOpen} onOpenChange={setHistoryOpen}>
        <DialogContent
          title="Conversations"
          description="Continue an earlier conversation or start a new one."
        >
          {historyLoading ? (
            <p className="text-(length:--text-subheadline-size) text-muted-foreground">Loading conversations…</p>
          ) : threads.length === 0 ? (
            <p className="text-(length:--text-subheadline-size) text-muted-foreground">
              No earlier conversations yet. Send a message to start one.
            </p>
          ) : (
            <ul className="space-y-2">
              {threads.map((thread) => (
                <li
                  key={thread.id}
                  className="rounded-[var(--corner-md)] border border-[var(--border)] bg-[var(--secondary)]"
                >
                  {renamingId === thread.id ? (
                    <form onSubmit={(event) => void saveRename(event)} className="flex flex-wrap items-center gap-2 p-2">
                      <input
                        value={renameValue}
                        onChange={(event) => setRenameValue(event.target.value)}
                        aria-label="Conversation title"
                        data-testid="agent-rename-input"
                        autoFocus
                        className="min-w-0 flex-1 rounded-[var(--corner-sm)] border border-[var(--input)] bg-[var(--card)] px-2 py-1.5 text-(length:--text-subheadline-size) outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
                      />
                      <Button type="submit" size="sm" disabled={!renameValue.trim()} data-testid="agent-rename-save">
                        Save
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => setRenamingId(null)}
                      >
                        Cancel
                      </Button>
                    </form>
                  ) : (
                    <div className="flex items-start gap-1 p-2">
                      <button
                        type="button"
                        data-testid="thread-option"
                        onClick={() => void loadThread(thread.id)}
                        className="min-w-0 flex-1 rounded-[var(--corner-sm)] px-1.5 py-1 text-left transition-colors hover:bg-[var(--accent)] focus-visible:outline-2"
                      >
                        <span className="flex items-baseline justify-between gap-2">
                          <span className="truncate text-(length:--text-subheadline-size) font-medium">
                            {thread.title}
                            {thread.id === threadId ? " · current" : ""}
                          </span>
                          <span className="shrink-0 text-(length:--text-caption-size) text-muted-foreground">
                            {new Date(thread.updatedAt).toLocaleDateString("en-US", {
                              month: "short",
                              day: "numeric"
                            })}
                          </span>
                        </span>
                        <span className="mt-0.5 block text-(length:--text-caption-size) text-muted-foreground">
                          {thread.messageCount} {thread.messageCount === 1 ? "message" : "messages"}
                        </span>
                        {thread.preview ? (
                          <span className="mt-1 line-clamp-2 block text-(length:--text-caption-size) text-muted-foreground">
                            {thread.preview}
                          </span>
                        ) : null}
                      </button>
                      <Hint label="Rename conversation">
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          className="size-11 min-[700px]:size-7"
                          onClick={() => beginRename(thread)}
                          aria-label={`Rename ${thread.title}`}
                          data-testid="agent-rename-thread"
                        >
                          <Pencil size={14} />
                        </Button>
                      </Hint>
                      <Hint label="Delete conversation">
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          className="size-11 min-[700px]:size-7"
                          onClick={() => setDeleteTarget(thread)}
                          aria-label={`Delete ${thread.title}`}
                          data-testid="agent-delete-thread"
                        >
                          <Trash2 size={14} />
                        </Button>
                      </Hint>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </DialogContent>
      </Dialog>

      <Dialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
      >
        <DialogContent
          title="Delete conversation?"
          description="This removes the stored messages and their checkpoints. The manuscript is not changed."
          footer={
            <DialogFooter>
              <Button variant="outline" onClick={() => setDeleteTarget(null)}>
                Cancel
              </Button>
              <Button variant="danger" onClick={() => void deleteThread()} data-testid="agent-confirm-delete">
                Delete
              </Button>
            </DialogFooter>
          }
        >
          <p className="text-(length:--text-subheadline-size) leading-[var(--text-subheadline-leading)] text-muted-foreground">
            “{deleteTarget?.title ?? "This conversation"}” will be removed from this book. This cannot be
            undone.
          </p>
        </DialogContent>
      </Dialog>
    </aside>
  );
}
