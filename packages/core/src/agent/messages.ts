import { z } from "zod";
import { COST_BASES } from "../providers/usage";
import { providerIdSchema } from "../providers/types";
import { contextBreakdownSchema } from "./context";
import {
  AGENT_PLAN_LIMITS,
  AGENT_PLAN_STATUSES,
  AGENT_PLAN_STEP_STATES,
  type AgentPlanStatus
} from "./plan-state";

/**
 * The studio's own message format. It is deliberately not an AI SDK type: the runtime converts to
 * and from `ModelMessage` at the provider edge, while storage, IPC and the interface use these
 * parts. A provider or SDK upgrade therefore cannot change what the author sees or what is saved.
 */

const isoDate = z.string().datetime({ offset: true }).or(z.string().datetime());
const messageId = /^msg_[A-Za-z0-9-]{6,}$/;
const threadId = /^thread_[A-Za-z0-9-]{6,}$/;
const bookId = /^book_[A-Za-z0-9-]{6,}$/;
const chapterId = /^ch_[A-Za-z0-9-]{6,}$/;

export const agentMessageIdSchema = z.string().regex(messageId, "invalid message id").max(200);
export const agentThreadIdSchema = z.string().regex(threadId, "invalid thread id").max(200);
export const agentBookIdSchema = z.string().regex(bookId, "invalid book id").max(200);

export const agentChapterIdSchema = z.string().regex(chapterId, "invalid chapter id").max(200);

/**
 * One book's conversation, as the shell asks a window to open it (`OpenConversationEvent`). The
 * chapter, when the shell knows it, is the one that was open when the turn's window closed.
 */
export const agentConversationRefSchema = z
  .object({ bookId: agentBookIdSchema, threadId: agentThreadIdSchema, chapterId: agentChapterIdSchema.optional() })
  .strict();

export const agentTextPartSchema = z
  .object({
    type: z.literal("text"),
    text: z.string().min(1).max(200_000)
  })
  .loose();

export const agentReasoningPartSchema = z
  .object({
    type: z.literal("reasoning"),
    text: z.string().min(1).max(200_000),
    /** Providers that redact or omit reasoning still get a part, so the UI can say so. */
    redacted: z.boolean().optional()
  })
  .loose();

export const agentToolCallPartSchema = z
  .object({
    type: z.literal("tool-call"),
    id: z.string().min(1).max(200),
    name: z.string().min(1).max(120),
    input: z.unknown()
  })
  .loose();

export const agentToolResultPartSchema = z
  .object({
    type: z.literal("tool-result"),
    id: z.string().min(1).max(200),
    name: z.string().min(1).max(120),
    output: z.unknown(),
    isError: z.boolean().optional()
  })
  .loose();

export const agentSourcePartSchema = z
  .object({
    type: z.literal("source"),
    url: z.string().url().max(2_000),
    title: z.string().max(300).optional()
  })
  .loose();

export const agentFilePartSchema = z
  .object({
    type: z.literal("file"),
    mediaType: z.string().min(1).max(200),
    name: z.string().max(300).optional(),
    /** Base64 data, kept as a string so the format survives JSON and structured clone. */
    data: z.string().min(1).max(20_000_000)
  })
  .loose();

export const AGENT_APPROVAL_STATUSES = ["pending", "approved", "denied", "expired"] as const;
export type AgentApprovalStatus = (typeof AGENT_APPROVAL_STATUSES)[number];
export type AgentGuidancePart = z.infer<typeof agentGuidancePartSchema>;

/**
 * The permission level of one turn. Stored on the assistant message with the
 * turn's model and usage, so a reopened conversation shows the recorded mode
 * instead of the composer's current selection. Absent on older turns, which
 * the interface shows as unrecorded rather than guessing.
 */
export const AGENT_MODES = ["discuss", "edit"] as const;
export const agentModeSchema = z.enum(AGENT_MODES);
export type AgentMode = z.infer<typeof agentModeSchema>;

/**
 * One-turn author guidance, stored with the submitted user message. Bounded
 * here; the composer enforces the same limit before sending, and oversize
 * input is rejected rather than truncated.
 */
/**
 * One turn of author guidance: at least one character, at most 2,000, never
 * silently truncated. Shared by the stored part and the request validation.
 */
export const agentGuidanceTextSchema = z.string().min(1).max(2_000);

export const agentGuidancePartSchema = z
  .object({
    type: z.literal("guidance"),
    text: agentGuidanceTextSchema
  })
  .loose();

/**
 * A destructive tool call waiting for the author. It is stored with the turn so a reload can show
 * the same card; the runtime updates the status when the author answers or the turn stops.
 */
export const agentApprovalPartSchema = z
  .object({
    type: z.literal("approval"),
    approvalId: z.string().min(1).max(200),
    turnId: z.string().min(1).max(80),
    name: z.string().min(1).max(120),
    input: z.unknown(),
    status: z.enum(AGENT_APPROVAL_STATUSES),
    requestedAt: isoDate,
    resolvedAt: isoDate.optional()
  })
  .loose();

export const AGENT_ERROR_LIMITS = { message: 2_000, retryAfterSeconds: 86_400 } as const;

export const agentErrorPartSchema = z
  .object({
    type: z.literal("error"),
    code: z.string().min(1).max(80),
    message: z.string().min(1).max(AGENT_ERROR_LIMITS.message),
    /** Seconds the provider asked the studio to wait before asking again, when it named one. */
    retryAfterSeconds: z.number().int().nonnegative().max(AGENT_ERROR_LIMITS.retryAfterSeconds).optional()
  })
  .loose();

/** Every part this build can read and write. An unknown type is read-only, never guessed at. */
export const AGENT_PART_TYPES = [
  "text",
  "reasoning",
  "tool-call",
  "tool-result",
  "source",
  "file",
  "approval",
  "error",
  "guidance"
] as const;

export const agentPartSchema = z.discriminatedUnion("type", [
  agentTextPartSchema,
  agentReasoningPartSchema,
  agentToolCallPartSchema,
  agentToolResultPartSchema,
  agentSourcePartSchema,
  agentFilePartSchema,
  agentApprovalPartSchema,
  agentErrorPartSchema,
  agentGuidancePartSchema
]);

export const agentModelSchema = z
  .object({
    provider: providerIdSchema,
    modelId: z.string().min(1).max(200),
    connectionLabel: z.string().max(200),
    /** The catalogue's display name, so the conversation can name the model in plain words. */
    name: z.string().min(1).max(200).optional()
  })
  .loose();

export const agentUsageSchema = z
  .object({
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    cachedInputTokens: z.number().int().nonnegative().default(0),
    /** Whether the provider reported its cache at all. A measured zero is not the same thing. */
    cacheReported: z.boolean().optional(),
    costUsd: z.number().nonnegative().nullable(),
    costBasis: z.enum(COST_BASES),
    /** The selected model's context window when the catalogue reported one. */
    contextLength: z.number().int().positive().nullable().optional()
  })
  .loose();

export const agentMessageSchema = z
  .object({
    id: agentMessageIdSchema,
    role: z.enum(["user", "assistant"]),
    parts: z.array(agentPartSchema).min(1).max(1_000),
    model: agentModelSchema.optional(),
    /** The permission level of the turn that produced this message, when recorded. */
    mode: agentModeSchema.optional(),
    usage: agentUsageSchema.optional(),
    /** Where the request's estimated context went, stored with the turn. */
    context: contextBreakdownSchema.optional(),
    /** The run that produced this message, when there was one. Used to find its checkpoint. */
    turnId: z.string().min(1).max(80).optional(),
    createdAt: isoDate
  })
  .loose();

export const agentPlanStepSchema = z
  .object({
    text: z
      .string()
      .min(1)
      .max(AGENT_PLAN_LIMITS.stepText)
      .refine((value) => value.trim().length > 0, "empty plan step"),
    state: z.enum(AGENT_PLAN_STEP_STATES)
  })
  .loose();

/**
 * One durable Edit plan. It outlives the assistant turn that proposed it, so it lives on the
 * thread beside `messages` instead of inside a message part. `parent` names that proposal turn;
 * `startedAt` appears once the plan starts and `terminalAt` exactly when the status is terminal.
 */
export const agentPlanSchema = z
  .object({
    id: z
      .string()
      .min(1)
      .max(AGENT_PLAN_LIMITS.id)
      .refine((value) => value.trim().length > 0, "empty plan id"),
    mode: z.literal("edit"),
    status: z.enum(AGENT_PLAN_STATUSES),
    purpose: z
      .string()
      .min(1)
      .max(AGENT_PLAN_LIMITS.purpose)
      .refine((value) => value.trim().length > 0, "empty plan purpose"),
    steps: z.array(agentPlanStepSchema).min(1).max(AGENT_PLAN_LIMITS.steps),
    /** Proposal revision. Starts at 1; only a proposed-plan guidance refresh increments it. */
    revision: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    /** Absent means no guidance; a blank value is omitted by the caller, never stored. */
    guidance: z
      .string()
      .min(1)
      .max(AGENT_PLAN_LIMITS.guidance)
      .refine((value) => value.trim().length > 0, "empty plan guidance")
      .optional(),
    parent: z
      .object({
        messageId: agentMessageIdSchema,
        turnId: z.string().min(1).max(AGENT_PLAN_LIMITS.turnId)
      })
      .loose(),
    createdAt: isoDate,
    updatedAt: isoDate,
    /** Present once the plan has started; kept across pause and resume. */
    startedAt: isoDate.optional(),
    /** Present exactly when `status` is terminal. */
    terminalAt: isoDate.optional()
  })
  .loose();

const TERMINAL_PLAN_STATUSES = new Set<AgentPlanStatus>([
  "completed",
  "cancelled",
  "failed",
  "expired"
]);
const STARTED_PLAN_STATUSES = new Set<AgentPlanStatus>([
  "running",
  "waiting-for-approval",
  "pause-requested",
  "paused",
  "completed",
  "failed"
]);

function timestampValue(value: string | undefined): number | null {
  if (value === undefined) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export const agentThreadSchema = z
  .object({
    schemaVersion: z.literal(1).default(1),
    id: agentThreadIdSchema,
    bookId: agentBookIdSchema,
    title: z.string().max(200).default("New conversation"),
    createdAt: isoDate,
    updatedAt: isoDate,
    messages: z.array(agentMessageSchema).max(2_000).default([]),
    /** Bounded plan history, oldest first. At most one plan is non-terminal. */
    plans: z.array(agentPlanSchema).max(AGENT_PLAN_LIMITS.plansPerThread).default([]),
    /** Turn ids whose checkpoints belong to this conversation, newest last. */
    checkpointTurns: z.array(z.string().min(1).max(200)).max(200).default([])
  })
  .loose()
  .superRefine((thread, context) => {
    const seen = new Set<string>();
    for (const [index, message] of thread.messages.entries()) {
      if (seen.has(message.id)) {
        context.addIssue({
          code: "custom",
          message: "Message ids must be unique inside a conversation.",
          path: ["messages", index, "id"]
        });
      }
      seen.add(message.id);
    }

    const issue = (path: (string | number)[], message: string): void => {
      context.addIssue({ code: "custom", message, path });
    };
    const planIds = new Set<string>();
    let openPlan = false;

    for (const [index, plan] of thread.plans.entries()) {
      const planPath = (field: string): (string | number)[] => ["plans", index, field];
      const parentPath = (field: "messageId" | "turnId"): (string | number)[] => [
        "plans",
        index,
        "parent",
        field
      ];
      const parent = thread.messages.find((message) => message.id === plan.parent.messageId);
      if (!parent) {
        issue(
          parentPath("messageId"),
          "The assistant turn that proposed this plan is not in the conversation."
        );
      } else {
        if (parent.role !== "assistant") {
          issue(parentPath("messageId"), "A plan must be proposed by an assistant turn.");
        }
        if (!parent.turnId || parent.turnId !== plan.parent.turnId) {
          issue(parentPath("turnId"), "The plan's parent turn does not match the stored turn.");
        }
        if (parent.mode !== "edit") {
          issue(parentPath("messageId"), "A plan can only be proposed by an Edit turn.");
        }
      }

      if (planIds.has(plan.id)) {
        issue(planPath("id"), "Plan ids must be unique inside a conversation.");
      }
      planIds.add(plan.id);

      const terminal = TERMINAL_PLAN_STATUSES.has(plan.status);
      if (!terminal) {
        if (openPlan) {
          issue(planPath("status"), "Only one plan can be unfinished in a conversation.");
        }
        openPlan = true;
      }

      const created = timestampValue(plan.createdAt)!;
      const updated = timestampValue(plan.updatedAt)!;
      const started = timestampValue(plan.startedAt);
      const ended = timestampValue(plan.terminalAt);

      if (terminal && plan.terminalAt === undefined) {
        issue(planPath("terminalAt"), "A finished plan must record when it finished.");
      }
      if (!terminal && plan.terminalAt !== undefined) {
        issue(planPath("terminalAt"), "An unfinished plan cannot record a finish time.");
      }
      if (plan.status === "proposed" && plan.startedAt !== undefined) {
        issue(planPath("startedAt"), "A proposed plan has not started.");
      }
      if (STARTED_PLAN_STATUSES.has(plan.status) && plan.startedAt === undefined) {
        issue(planPath("startedAt"), "A started plan must record when it started.");
      }
      if (started !== null) {
        if (started < created) issue(planPath("startedAt"), "A plan cannot start before it was created.");
        if (started > updated) issue(planPath("startedAt"), "A plan cannot start after its last update.");
      }
      if (ended !== null) {
        if (ended < created) issue(planPath("terminalAt"), "A plan cannot finish before it was created.");
        if (ended > updated) issue(planPath("terminalAt"), "A plan cannot finish after its last update.");
        if (started !== null && ended < started) {
          issue(planPath("terminalAt"), "A plan cannot finish before it started.");
        }
      }

      let inProgress = 0;
      for (const [stepIndex, step] of plan.steps.entries()) {
        const stepPath: (string | number)[] = ["plans", index, "steps", stepIndex, "state"];
        if (terminal && (step.state === "pending" || step.state === "in-progress")) {
          issue(stepPath, "A finished plan cannot leave a step open.");
        }
        if (step.state === "in-progress") {
          inProgress += 1;
          if (inProgress > 1) issue(stepPath, "Only one step can be in progress.");
        }
        const earlierOpen = plan.steps
          .slice(0, stepIndex)
          .some((entry) => entry.state === "pending" || entry.state === "in-progress");
        if (step.state !== "pending" && earlierOpen) {
          issue(stepPath, "Steps must finish in order.");
        }
      }
      if (plan.status === "completed" && !plan.steps.some((step) => step.state === "completed")) {
        issue(planPath("status"), "A completed plan needs at least one completed step.");
      }
    }
  });

export type AgentTextPart = z.infer<typeof agentTextPartSchema>;
export type AgentReasoningPart = z.infer<typeof agentReasoningPartSchema>;
export type AgentToolCallPart = z.infer<typeof agentToolCallPartSchema>;
export type AgentToolResultPart = z.infer<typeof agentToolResultPartSchema>;
export type AgentSourcePart = z.infer<typeof agentSourcePartSchema>;
export type AgentFilePart = z.infer<typeof agentFilePartSchema>;
export type AgentApprovalPart = z.infer<typeof agentApprovalPartSchema>;
export type AgentErrorPart = z.infer<typeof agentErrorPartSchema>;
export type AgentPart = z.infer<typeof agentPartSchema>;
export type AgentModel = z.infer<typeof agentModelSchema>;
export type AgentUsage = z.infer<typeof agentUsageSchema>;
export type AgentMessage = z.infer<typeof agentMessageSchema>;
export type AgentPlanStep = z.infer<typeof agentPlanStepSchema>;
export type AgentPlan = z.infer<typeof agentPlanSchema>;
export type AgentThread = z.infer<typeof agentThreadSchema>;

export {
  AGENT_PLAN_LIMITS,
  AGENT_PLAN_STATUSES,
  AGENT_PLAN_STEP_STATES,
  applyAgentPlanEvent,
  refreshAgentPlanProposal,
  type AgentPlanEvent,
  type AgentPlanEventResult,
  type AgentPlanRefusal,
  type AgentPlanState,
  type AgentPlanStatus,
  type AgentPlanStepState
} from "./plan-state";

/** The visible prose of one message, without reasoning or tool payloads. */
export function messageText(message: AgentMessage): string {
  return message.parts
    .filter((part): part is AgentTextPart => part.type === "text")
    .map((part) => part.text)
    .join("\n")
    .trim();
}

/** The last visible text in a conversation, used for a list preview. */
export function lastMessageText(thread: AgentThread): string {
  for (let index = thread.messages.length - 1; index >= 0; index -= 1) {
    const text = messageText(thread.messages[index]!);
    if (text) return text;
  }
  return "";
}

export function parseAgentThread(value: unknown): AgentThread {
  return agentThreadSchema.parse(value);
}

export function parseAgentMessage(value: unknown): AgentMessage {
  return agentMessageSchema.parse(value);
}

export function serializeAgentThread(thread: AgentThread): string {
  return `${JSON.stringify(agentThreadSchema.parse(thread), null, 2)}\n`;
}
