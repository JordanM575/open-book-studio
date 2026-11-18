import { describe, expect, test } from "bun:test";
import { agentThreadSchema, serializeAgentThread } from "../../src/agent/messages";

const CREATED = "2026-11-17T10:00:00.000Z";
const STARTED = "2026-11-17T11:00:00.000Z";
const AT = "2026-11-17T12:00:00.000Z";

function parent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "msg_plan0001",
    role: "assistant",
    parts: [{ type: "text", text: "Here is the plan." }],
    mode: "edit",
    turnId: "turn_plan0001",
    createdAt: CREATED,
    ...overrides
  };
}

function plan(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "plan-1",
    mode: "edit",
    status: "proposed",
    purpose: "Revise the opening",
    steps: [{ text: "Read the opening", state: "pending" }],
    revision: 1,
    parent: { messageId: "msg_plan0001", turnId: "turn_plan0001" },
    createdAt: CREATED,
    updatedAt: CREATED,
    ...overrides
  };
}

function terminalPlan(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return plan({
    status: "cancelled",
    steps: [{ text: "Read the opening", state: "not-completed" }],
    startedAt: STARTED,
    terminalAt: AT,
    updatedAt: AT,
    ...overrides
  });
}

function thread(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    id: "thread_plan0001",
    bookId: "book_plan0001",
    title: "A plan conversation",
    createdAt: CREATED,
    updatedAt: CREATED,
    messages: [parent()],
    plans: [plan()],
    checkpointTurns: [],
    ...overrides
  };
}

function expectRefused(value: unknown, path: string): void {
  const result = agentThreadSchema.safeParse(value);
  expect(result.success).toBe(false);
  if (result.success) return;
  expect(result.error.issues.map((issue) => issue.path.join("."))).toContain(path);
}

describe("the stored plan shape", () => {
  test("a proposed plan parses and serializes with its parent binding", () => {
    const parsed = agentThreadSchema.parse(thread({ plans: [plan({ guidance: "Keep the tense." })] }));
    expect(parsed.plans).toHaveLength(1);
    expect(parsed.plans[0]).toMatchObject({
      id: "plan-1",
      mode: "edit",
      status: "proposed",
      revision: 1,
      guidance: "Keep the tense.",
      parent: { messageId: "msg_plan0001", turnId: "turn_plan0001" }
    });
    expect(parsed.plans[0]?.steps[0]?.state).toBe("pending");
    expect(parsed.plans[0]?.startedAt).toBeUndefined();
    expect(parsed.plans[0]?.terminalAt).toBeUndefined();

    const out = JSON.parse(serializeAgentThread(parsed)) as Record<string, unknown>;
    expect((out.plans as Array<Record<string, unknown>>)[0]?.purpose).toBe("Revise the opening");
  });

  test("a legacy thread without plans reads as an empty list", () => {
    const legacy = thread();
    delete legacy.plans;
    expect(agentThreadSchema.parse(legacy).plans).toEqual([]);
  });

  test("a terminal plan keeps exactly one finished record and a new proposal follows it", () => {
    const parsed = agentThreadSchema.parse(
      thread({ plans: [terminalPlan(), plan({ id: "plan-2" })] })
    );
    expect(parsed.plans.map((entry) => entry.status)).toEqual(["cancelled", "proposed"]);
    expect(parsed.plans[0]?.terminalAt).toBe(AT);
    expect(parsed.plans[0]?.steps[0]?.state).toBe("not-completed");
  });
});

describe("the proposal parent", () => {
  test("refuses a plan whose parent message is missing", () => {
    expectRefused(thread({ messages: [] }), "plans.0.parent.messageId");
  });

  test("refuses a user message as the parent", () => {
    expectRefused(
      thread({ messages: [parent({ role: "user" })] }),
      "plans.0.parent.messageId"
    );
  });

  test("refuses a parent without a stored turn", () => {
    const message = parent();
    delete message.turnId;
    expectRefused(thread({ messages: [message] }), "plans.0.parent.turnId");
  });

  test("refuses a parent turn that does not match the stored turn", () => {
    expectRefused(
      thread({ plans: [plan({ parent: { messageId: "msg_plan0001", turnId: "turn_other01" } })] }),
      "plans.0.parent.turnId"
    );
  });

  test("refuses a Discuss parent and a parent with no recorded mode", () => {
    expectRefused(
      thread({ messages: [parent({ mode: "discuss" })] }),
      "plans.0.parent.messageId"
    );
    const message = parent();
    delete message.mode;
    expectRefused(thread({ messages: [message] }), "plans.0.parent.messageId");
  });
});

describe("duplicates and open plans", () => {
  test("refuses duplicate plan ids", () => {
    expectRefused(thread({ plans: [terminalPlan(), plan()] }), "plans.1.id");
  });

  test("refuses a second unfinished plan", () => {
    expectRefused(thread({ plans: [plan(), plan({ id: "plan-2" })] }), "plans.1.status");
  });

  test("accepts one unfinished plan after any number of terminal plans", () => {
    const result = agentThreadSchema.safeParse(
      thread({ plans: [terminalPlan({ id: "plan-0" }), plan({ id: "plan-1" })] })
    );
    expect(result.success).toBe(true);
  });
});

describe("bounds", () => {
  function invalid(overrides: Record<string, unknown>): void {
    expect(agentThreadSchema.safeParse(thread(overrides)).success).toBe(false);
  }

  test("refuses empty or over-bound identity and purpose", () => {
    invalid({ plans: [plan({ id: "" })] });
    invalid({ plans: [plan({ id: "   " })] });
    invalid({ plans: [plan({ id: "x".repeat(201) })] });
    invalid({ plans: [plan({ purpose: "" })] });
    invalid({ plans: [plan({ purpose: "   " })] });
    invalid({ plans: [plan({ purpose: "x".repeat(2_001) })] });
  });

  test("refuses an empty, over-full or over-bound step list", () => {
    invalid({ plans: [plan({ steps: [] })] });
    invalid({ plans: [plan({ steps: Array.from({ length: 51 }, (_, index) => ({ text: `Step ${index}`, state: "pending" })) })] });
    invalid({ plans: [plan({ steps: [{ text: "", state: "pending" }] })] });
    invalid({ plans: [plan({ steps: [{ text: "   ", state: "pending" }] })] });
    invalid({ plans: [plan({ steps: [{ text: "x".repeat(2_001), state: "pending" }] })] });
  });

  test("refuses an invalid revision or guidance", () => {
    invalid({ plans: [plan({ revision: 0 })] });
    invalid({ plans: [plan({ revision: 1.5 })] });
    invalid({ plans: [plan({ revision: 9_007_199_254_740_992 })] });
    invalid({ plans: [plan({ guidance: "" })] });
    invalid({ plans: [plan({ guidance: "   " })] });
    invalid({ plans: [plan({ guidance: "x".repeat(2_001) })] });
  });

  test("refuses a Discuss plan or an extra status outside the stored set", () => {
    invalid({ plans: [plan({ mode: "discuss" })] });
    invalid({ plans: [plan({ status: "started" })] });
    invalid({ plans: [plan({ status: "paused-future" })] });
    invalid({ plans: [plan({ steps: [{ text: "Read", state: "skipped" }] })] });
  });

  test("refuses a fifty-first plan and accepts the exact plan cap", () => {
    const fifty = Array.from({ length: 49 }, (_, index) =>
      terminalPlan({ id: `plan-${index}`, purpose: `Plan ${index}` })
    );
    fifty.push(plan({ id: "plan-last" }));
    expect(agentThreadSchema.safeParse(thread({ plans: fifty })).success).toBe(true);
    invalid({ plans: [...fifty, terminalPlan({ id: "plan-over" })] });
  });

  test("accepts every exact field bound", () => {
    const value = plan({
      id: "x".repeat(200),
      purpose: "y".repeat(2_000),
      steps: Array.from({ length: 50 }, () => ({ text: "z".repeat(2_000), state: "pending" })),
      revision: Number.MAX_SAFE_INTEGER,
      guidance: "g".repeat(2_000)
    });
    expect(agentThreadSchema.safeParse(thread({ plans: [value] })).success).toBe(true);
  });
});

describe("status and timestamp consistency", () => {
  test("a terminal status needs a terminal time and a live status must not have one", () => {
    const missing = terminalPlan();
    delete missing.terminalAt;
    expectRefused(thread({ plans: [missing] }), "plans.0.terminalAt");
    expectRefused(
      thread({ plans: [plan({ terminalAt: AT, updatedAt: AT })] }),
      "plans.0.terminalAt"
    );
  });

  test("only a started status may record a start", () => {
    expectRefused(
      thread({ plans: [plan({ startedAt: STARTED, updatedAt: AT })] }),
      "plans.0.startedAt"
    );
    for (const status of ["running", "paused"] as const) {
      expectRefused(
        thread({
          plans: [
            plan({
              status,
              steps: [
                { text: "One", state: "completed" },
                { text: "Two", state: "pending" }
              ],
              updatedAt: AT
            })
          ]
        }),
        "plans.0.startedAt"
      );
    }
    expectRefused(
      thread({
        plans: [
          plan({
            status: "completed",
            steps: [{ text: "One", state: "completed" }],
            terminalAt: AT,
            updatedAt: AT
          })
        ]
      }),
      "plans.0.startedAt"
    );
    expectRefused(
      thread({
        plans: [
          plan({
            status: "failed",
            steps: [{ text: "One", state: "not-completed" }],
            terminalAt: AT,
            updatedAt: AT
          })
        ]
      }),
      "plans.0.startedAt"
    );
  });

  test("timestamps must run created, started, finished, updated", () => {
    expectRefused(
      thread({
        plans: [
          plan({
            status: "running",
            createdAt: AT,
            startedAt: CREATED,
            updatedAt: AT,
            steps: [
              { text: "One", state: "completed" },
              { text: "Two", state: "pending" }
            ]
          })
        ]
      }),
      "plans.0.startedAt"
    );
    expectRefused(
      thread({
        plans: [
          terminalPlan({ startedAt: AT, terminalAt: STARTED, updatedAt: AT })
        ]
      }),
      "plans.0.terminalAt"
    );
    expectRefused(
      thread({
        plans: [
          terminalPlan({ startedAt: CREATED, terminalAt: AT, updatedAt: STARTED })
        ]
      }),
      "plans.0.terminalAt"
    );
  });

  test("a proposed plan may be cancelled or expired before it starts", () => {
    for (const status of ["cancelled", "expired"] as const) {
      const value = plan({
        status,
        steps: [{ text: "One", state: "not-completed" }],
        terminalAt: AT,
        updatedAt: AT
      });
      expect(agentThreadSchema.safeParse(thread({ plans: [value] })).success).toBe(true);
    }
  });
});

describe("step consistency", () => {
  test("only one step may be in progress", () => {
    expectRefused(
      thread({
        plans: [
          plan({
            status: "running",
            startedAt: STARTED,
            updatedAt: AT,
            steps: [
              { text: "One", state: "in-progress" },
              { text: "Two", state: "in-progress" }
            ]
          })
        ]
      }),
      "plans.0.steps.1.state"
    );
  });

  test("a later step may not finish before an earlier one", () => {
    expectRefused(
      thread({
        plans: [
          plan({
            status: "running",
            startedAt: STARTED,
            updatedAt: AT,
            steps: [
              { text: "One", state: "pending" },
              { text: "Two", state: "completed" }
            ]
          })
        ]
      }),
      "plans.0.steps.1.state"
    );
  });

  test("a finished plan leaves no open step and a completed plan proves its work", () => {
    expectRefused(
      thread({ plans: [terminalPlan({ steps: [{ text: "One", state: "pending" }] })] }),
      "plans.0.steps.0.state"
    );
    expectRefused(
      thread({ plans: [terminalPlan({ steps: [{ text: "One", state: "in-progress" }] })] }),
      "plans.0.steps.0.state"
    );
    expectRefused(
      thread({
        plans: [
          plan({
            status: "completed",
            steps: [{ text: "One", state: "not-completed" }],
            startedAt: STARTED,
            terminalAt: AT,
            updatedAt: AT
          })
        ]
      }),
      "plans.0.status"
    );
    expect(
      agentThreadSchema.safeParse(
        thread({
          plans: [
            plan({
              status: "completed",
              steps: [
                { text: "One", state: "completed" },
                { text: "Two", state: "not-completed" }
              ],
              startedAt: STARTED,
              terminalAt: AT,
              updatedAt: AT
            })
          ]
        })
      ).success
    ).toBe(true);
  });
});

describe("unknown data", () => {
  test("unknown plain plan, step and parent fields survive a parse and serialize", () => {
    const parsed = agentThreadSchema.parse(
      thread({
        futureTopLevel: { keep: true },
        plans: [
          plan({
            futurePlanField: "keep the plan",
            steps: [{ text: "Read", state: "pending", futureStepField: { deep: 1 } }],
            parent: {
              messageId: "msg_plan0001",
              turnId: "turn_plan0001",
              futureParentField: [1, 2]
            }
          })
        ]
      })
    );
    const out = JSON.parse(serializeAgentThread(parsed)) as Record<string, unknown>;
    expect(out.futureTopLevel).toEqual({ keep: true });
    const plans = out.plans as Array<Record<string, unknown>>;
    expect(plans[0]?.futurePlanField).toBe("keep the plan");
    const steps = plans[0]?.steps as Array<Record<string, unknown>>;
    expect(steps[0]?.futureStepField).toEqual({ deep: 1 });
    const storedParent = plans[0]?.parent as Record<string, unknown>;
    expect(storedParent.futureParentField).toEqual([1, 2]);
  });
});
