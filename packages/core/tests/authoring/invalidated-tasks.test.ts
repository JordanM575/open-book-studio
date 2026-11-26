import { describe, expect, test } from "bun:test";
import {
  AuthoringError, decodeWorkflowRecord, encodeWorkflowRecord, projectInvalidatedTasks,
  WORKFLOW_LIMITS, type WorkflowKind, type WorkflowReference,
} from "../../src/authoring";
import { owner } from "./fixtures";

const at = "2026-11-07T00:00:00.000Z";
const updatedAt = "2026-11-08T12:34:56.789Z";
const hash = (n = 1) => n.toString(16).padStart(64, "0");
const absentBase = { kind: "absent" as const, revision: 0 as const };

function ref<K extends WorkflowKind>(kind: K, id: string, revision = 1, digest = revision + 1):
  WorkflowReference<K> {
  return { kind, owner: { ...owner }, id, revision, hash: hash(digest) };
}

function definition(keys: readonly string[], dependsOn: readonly WorkflowReference<"task">[] = [],
  complete = true) {
  return {
    role: "drafter",
    completion: "candidate",
    dependsOn: [...dependsOn],
    impact: { complete, keys: [...keys] },
    note: "kept-definition",
  };
}

function taskRecord(id: string, overrides: Record<string, unknown> = {}) {
  const revision = typeof overrides.revision === "number" ? overrides.revision : 1;
  return {
    schemaVersion: 1,
    kind: "task",
    owner: { ...owner },
    id,
    revision,
    base: revision === 1
      ? { ...absentBase }
      : { kind: "sha256", value: hash(80), revision: revision - 1 },
    generation: 1,
    plan: ref("phase-plan", "plan_1"),
    phase: 1,
    definition: definition([id]),
    direction: ref("direction", "direction_1"),
    currentAttempt: null,
    retryAllowed: false,
    needsDirection: false,
    createdAt: at,
    updatedAt: at,
    ...overrides,
  };
}

function directionReference() {
  return {
    kind: "direction" as const,
    owner: { ...owner },
    id: "direction_9",
    revision: 4,
    hash: hash(40),
    label: "kept-reference",
  };
}

function project(tasks: unknown, keys: unknown, digests: unknown,
  direction: unknown = directionReference(), when: unknown = updatedAt) {
  return projectInvalidatedTasks(tasks, keys, direction, owner, when, digests);
}

function refusal(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    if (error instanceof AuthoringError) return error.code;
    throw error;
  }
  throw new Error("expected AuthoringError");
}

describe("projectInvalidatedTasks", () => {
  test("projects affected copies in input order and leaves the caller unchanged", () => {
    const attempt = ref("attempt", "attempt_1", 2, 9);
    const direction = directionReference();
    const setup = taskRecord("task_setup", {
      status: "completed",
      generation: 3,
      definition: definition(["setup"]),
    });
    const root = taskRecord("task_root", {
      revision: 5,
      generation: 7,
      status: "ready",
      retryAllowed: false,
      needsDirection: true,
      currentAttempt: attempt,
      note: "kept-task",
      definition: definition(["mara"], [ref("task", "task_setup")]),
    });
    const child = taskRecord("task_child", {
      status: "blocked",
      definition: definition(["other"], [ref("task", "task_root")]),
    });
    const open = taskRecord("task_open", {
      status: "stale",
      definition: definition([], [], false),
    });
    const later = taskRecord("task_later", {
      definition: definition(["later"], [ref("task", "task_child")]),
    });
    const tasks = [setup, root, child, open, later];
    const keys = ["mara", "mara"];
    const digests = {
      task_setup: hash(1),
      task_root: hash(51),
      task_child: hash(3),
      task_open: hash(4),
      task_later: hash(5),
      spare_1: hash(6),
    };
    const before = {
      tasks: JSON.stringify(tasks),
      keys: JSON.stringify(keys),
      direction: JSON.stringify(direction),
      digests: JSON.stringify(digests),
    };

    const projected = project(tasks, keys, digests, direction);

    expect(projected.tasks.map(task => task.id)).toEqual([
      "task_root", "task_child", "task_open", "task_later",
    ]);
    const [projectedRoot, projectedChild, projectedOpen, projectedLater] = projected.tasks;
    expect(projectedRoot?.revision).toBe(6);
    expect(projectedRoot?.base).toEqual({ kind: "sha256", value: hash(51), revision: 5 });
    expect(projectedRoot?.base).not.toEqual(root.base);
    expect(projectedRoot?.direction).toEqual(direction);
    expect(projectedRoot?.direction).not.toBe(direction);
    const projectedDirection = projectedRoot?.direction as { owner: unknown; label: string } | undefined;
    expect(projectedDirection?.owner).not.toBe(direction.owner);
    expect(projectedDirection?.label).toBe("kept-reference");
    expect(projectedRoot?.retryAllowed).toBe(true);
    expect(projectedRoot?.needsDirection).toBe(true);
    expect(projectedRoot?.generation).toBe(7);
    expect(projectedRoot?.createdAt).toBe(at);
    expect(projectedRoot?.updatedAt).toBe(updatedAt);
    expect(projectedRoot?.currentAttempt).toEqual(attempt);
    expect(projectedRoot?.currentAttempt).not.toBe(attempt);
    expect(projectedRoot?.definition).toEqual(root.definition);
    expect(projectedRoot?.definition).not.toBe(root.definition);
    expect(projectedRoot?.note).toBe("kept-task");
    expect(Object.hasOwn(projectedRoot ?? {}, "status")).toBe(false);
    expect(projectedChild?.revision).toBe(2);
    expect(projectedChild?.base).toEqual({ kind: "sha256", value: hash(3), revision: 1 });
    expect(projectedChild?.retryAllowed).toBe(true);
    expect(projectedChild?.needsDirection).toBe(false);
    expect(projectedChild?.currentAttempt).toBeNull();
    expect(projectedChild?.generation).toBe(1);
    expect(Object.hasOwn(projectedChild ?? {}, "status")).toBe(false);
    expect(projectedOpen?.definition).toMatchObject({ impact: { complete: false, keys: [] } });
    expect(projectedLater?.revision).toBe(2);
    expect(Object.isFrozen(projected)).toBe(true);
    expect(Object.isFrozen(projected.tasks)).toBe(true);
    expect(Object.isFrozen(projectedRoot)).toBe(true);
    expect(Object.isFrozen(projectedRoot?.definition)).toBe(true);
    expect(Object.isFrozen(projectedRoot?.direction)).toBe(true);
    expect(Object.isFrozen(root)).toBe(false);
    expect(Object.isFrozen(direction)).toBe(false);
    expect(Object.isFrozen(attempt)).toBe(false);
    expect(Object.isFrozen(digests)).toBe(false);
    expect(JSON.stringify(tasks)).toBe(before.tasks);
    expect(JSON.stringify(keys)).toBe(before.keys);
    expect(JSON.stringify(direction)).toBe(before.direction);
    expect(JSON.stringify(digests)).toBe(before.digests);
    expect(root.status).toBe("ready");
    expect(root.retryAllowed).toBe(false);
    expect(root.revision).toBe(5);

    const decoded = decodeWorkflowRecord(encodeWorkflowRecord(projectedRoot!), {
      kind: "task", owner,
    });
    expect(decoded.revision).toBe(6);
    expect(decoded.base).toEqual({ kind: "sha256", value: hash(51), revision: 5 });
    expect(decoded.direction).toEqual(direction);
    expect(decoded.retryAllowed).toBe(true);
    expect(decoded.currentAttempt).toEqual(attempt);
    expect(decoded.generation).toBe(7);
    expect(decoded.note).toBe("kept-task");
    expect(Object.hasOwn(decoded, "status")).toBe(false);
  });

  test("matches an incomplete impact and dependents, not an unaffected ancestor", () => {
    const setup = taskRecord("task_setup", { definition: definition(["setup"]) });
    const root = taskRecord("task_root", {
      definition: definition(["mara"], [ref("task", "task_setup")]),
    });
    const projected = project([setup, root], ["mara"], { task_root: hash(5) });
    expect(projected.tasks.map(task => task.id)).toEqual(["task_root"]);
    expect(Object.hasOwn(projected.tasks[0] ?? {}, "status")).toBe(false);
  });

  test("returns an empty list only after the direction, timestamp, and digest checks", () => {
    const setup = taskRecord("task_setup", { definition: definition(["setup"]) });
    const direction = directionReference();
    const projected = project([setup], ["mara"], {}, direction);
    expect(projected).toEqual({ tasks: [] });
    expect(Object.isFrozen(projected)).toBe(true);
    expect(Object.isFrozen(projected.tasks)).toBe(true);
    expect(Object.isFrozen(setup)).toBe(false);

    expect(refusal(() => project([setup], ["mara"], {}, { kind: "task" }, "not-a-time")))
      .toBe("invalid-reference-kind");
    expect(refusal(() => project([setup], ["mara"], null, direction, "not-a-time")))
      .toBe("invalid-timestamp");
    expect(refusal(() => project([setup], ["mara"], { spare: "nope" }, direction)))
      .toBe("invalid-digest");
    expect(setup.direction).toMatchObject({ id: "direction_1" });
  });

  test("accepts an array or a tasks object and unwraps only a snapshot without kind", () => {
    const task = taskRecord("task_1", {
      status: "ready",
      definition: definition(["mara"]),
    });
    const nested = { id: "task_9", kind: "task" };
    const ownRecord = taskRecord("task_2", {
      definition: definition(["mara"]),
      record: nested,
    });
    const fromArray = project([task], ["mara"], { task_1: hash(4) });
    const fromListing = project({ tasks: [task], note: "not a cursor" }, ["mara"], {
      task_1: hash(4),
    });
    expect(fromListing.tasks.map(item => item.id)).toEqual(["task_1"]);
    expect(fromListing.tasks[0]?.revision).toBe(fromArray.tasks[0]?.revision);
    expect(fromListing.tasks[0]?.base).toEqual(fromArray.tasks[0]?.base);

    const wrapper = { record: task, hash: hash(99), status: "completed" };
    const unwrapped = project([wrapper], ["mara"], { task_1: hash(4) });
    expect(unwrapped.tasks[0]?.id).toBe("task_1");
    expect(unwrapped.tasks[0]?.base).toEqual({ kind: "sha256", value: hash(4), revision: 1 });
    expect(refusal(() => project([wrapper], ["mara"], {}))).toBe("missing-digest");

    const kept = project([ownRecord], ["mara"], { task_2: hash(8) });
    expect(kept.tasks[0]?.id).toBe("task_2");
    expect(kept.tasks[0]?.record).toEqual(nested);
    expect(kept.tasks[0]?.record).not.toBe(nested);
  });

  test("a two-task cycle follows the matching task only", () => {
    const left = taskRecord("task_left", {
      definition: definition(["left"], [ref("task", "task_right")]),
    });
    const right = taskRecord("task_right", {
      definition: definition(["mara"], [ref("task", "task_left")]),
    });
    const projected = project([left, right], ["mara"], {
      task_left: hash(1),
      task_right: hash(2),
    });
    expect(projected.tasks.map(task => task.id)).toEqual(["task_left", "task_right"]);
  });

  test("checks the owner, then keys, before any task", () => {
    expect(refusal(() => projectInvalidatedTasks(
      [1], [], directionReference(), null as never, "not-a-time", null,
    ))).toBe("invalid-owner");
    expect(refusal(() => project([1], [], {}))).toBe("missing-impact");
    expect(refusal(() => project([1], null, {}))).toBe("missing-impact");
    expect(refusal(() => project([1], { keys: ["mara"] }, {}))).toBe("missing-impact");
    expect(refusal(() => project([1], ["", "mara"], {}))).toBe("invalid-id");
    expect(refusal(() => project(
      [1],
      Array.from({ length: WORKFLOW_LIMITS.impactKeysPerTask }, () => 1),
      {},
    ))).toBe("invalid-id");
    expect(refusal(() => project(
      [1],
      Array.from({ length: WORKFLOW_LIMITS.impactKeysPerTask + 1 }, () => "mara"),
      {},
    ))).toBe("record-count");
  });

  test("refuses an oversized task list before inspection and a duplicate before a missing dependency", () => {
    expect(refusal(() => project(
      Array.from({ length: WORKFLOW_LIMITS.tasksPerPlan }, () => 1),
      ["mara"],
      {},
    ))).toBe("invalid-task");
    expect(refusal(() => project(
      Array.from({ length: WORKFLOW_LIMITS.tasksPerPlan + 1 }, () => 1),
      ["mara"],
      {},
    ))).toBe("record-count");

    const missing = taskRecord("task_1", {
      definition: definition(["mara"], [ref("task", "task_missing")]),
    });
    const duplicate = taskRecord("task_1", { definition: definition(["mara"]) });
    expect(refusal(() => project([missing, duplicate], ["mara"], {}, { kind: "nope" }, "not-a-time")))
      .toBe("duplicate-task");
    const foreign = taskRecord("task_2", { kind: "question", id: "question_2" });
    expect(refusal(() => project([missing, foreign], ["mara"], {}, { kind: "nope" }, "not-a-time")))
      .toBe("foreign-kind");
    expect(refusal(() => project([missing], ["mara"], { task_1: hash(1) }, { kind: "nope" }, "not-a-time")))
      .toBe("missing-task");
  });

  test("checks the direction, timestamp, and digest map before a missing affected digest", () => {
    const task = taskRecord("task_1", { definition: definition(["mara"]) });
    const foreign = taskRecord("task_1", {
      owner: { ...owner, bookId: "book_2" },
      definition: definition(["mara"]),
    });
    expect(refusal(() => project([foreign], ["mara"], {}, { kind: "nope" }, "not-a-time")))
      .toBe("foreign-owner");
    expect(refusal(() => project(
      [taskRecord("task_1", { definition: definition(["mara", "mara"]) })],
      ["mara"],
      {},
      { kind: "nope" },
      "not-a-time",
    ))).toBe("duplicate-impact");
    expect(refusal(() => project([task], ["mara"], { task_1: "nope" }, { kind: "task" }, "not-a-time")))
      .toBe("invalid-reference-kind");
    expect(refusal(() => project([task], ["mara"], { task_1: "nope" }, directionReference(), "not-a-time")))
      .toBe("invalid-timestamp");
    expect(refusal(() => project([task], ["mara"], { task_1: "NOPE" }))).toBe("invalid-digest");
    expect(refusal(() => project([task], ["mara"], []))).toBe("invalid-digest");
    expect(refusal(() => project([task], ["mara"], {}))).toBe("missing-digest");
    expect(refusal(() => project([task], ["mara"], { task_2: hash(1) }))).toBe("missing-digest");

    const digests: Record<string, unknown> = {};
    for (let index = 0; index < WORKFLOW_LIMITS.tasksPerPlan + 1; index++) digests[`spare_${index}`] = 1;
    expect(refusal(() => project([], ["mara"], digests, directionReference(), "not-a-time")))
      .toBe("invalid-timestamp");
    expect(refusal(() => project([], ["mara"], digests))).toBe("record-count");
    expect(task.updatedAt).toBe(at);
    expect(Object.isFrozen(task)).toBe(false);
  });
});
