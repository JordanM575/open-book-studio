import { describe, expect, test } from "bun:test";
import {
  buildThreadDocument,
  readThreadDocument,
  ThreadDocumentError,
  type ThreadDocumentErrorCode
} from "../src/agent/thread-document";
import type { AgentThread } from "../src/agent/messages";

const encoder = new TextEncoder();
const CREATED = "2026-10-25T00:00:00.000Z";
const STARTED = "2026-11-01T00:00:00.000Z";
const NOW = "2026-11-08T12:00:00.000Z";

function base(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    id: "thread_test0001",
    bookId: "book_test0001",
    title: "Old conversation",
    createdAt: CREATED,
    updatedAt: CREATED,
    messages: [
      {
        id: "msg_test0001",
        role: "user",
        parts: [{ type: "text", text: "Tighten the opening." }],
        createdAt: CREATED
      }
    ],
    checkpointTurns: [],
    ...overrides
  };
}

function bytes(value: unknown | string): Uint8Array {
  return encoder.encode(typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`);
}

function document(raw: Record<string, unknown>) {
  return readThreadDocument({ bytes: bytes(raw), sha256: "test-hash" });
}

describe("thread document", () => {
  test("preserves supported unknown plain fields at every depth through a read-modify-write", () => {
    const raw = base({
      futureTopLevel: { note: "keep me", nested: [1.5, "text", true] },
      messages: [
        {
          id: "msg_test0001",
          role: "user",
          parts: [
            {
              type: "text",
              text: "Tighten the opening.",
              futurePartField: { keep: "this" }
            }
          ],
          futureMessageField: "keep me too",
          createdAt: CREATED
        }
      ]
    });
    const previous = document(raw);
    const built = buildThreadDocument(previous, { ...previous.thread, title: "New title" }, NOW);

    expect(built.unchanged).toBe(false);
    const out = JSON.parse(built.text) as Record<string, unknown>;
    expect(out.title).toBe("New title");
    expect(out.updatedAt).toBe(NOW);
    expect(out.futureTopLevel).toEqual(raw.futureTopLevel);
    const messages = out.messages as Array<Record<string, unknown>>;
    expect(messages[0]?.futureMessageField).toBe("keep me too");
    const parts = messages[0]?.parts as Array<Record<string, unknown>>;
    expect(parts[0]?.futurePartField).toEqual({ keep: "this" });
    expect(parts[0]?.text).toBe("Tighten the opening.");
  });

  test("keeps an unknown __proto__ extension as own plain data", () => {
    const raw = base({
      messages: [
        {
          id: "msg_proto001",
          role: "user",
          parts: [{ type: "text", text: "Keep this." }],
          ["__proto__"]: { keep: true },
          createdAt: CREATED
        }
      ]
    });
    const previous = document(raw);
    const built = buildThreadDocument(previous, { ...previous.thread, title: "New title" }, NOW);
    const out = JSON.parse(built.text) as Record<string, unknown>;
    const message = (out.messages as Array<Record<string, unknown>>)[0] as Record<string, unknown>;
    expect(Object.hasOwn(message, "__proto__")).toBe(true);
    expect(Object.getOwnPropertyDescriptor(message, "__proto__")?.value).toEqual({ keep: true });
    expect(Object.getPrototypeOf(message)).toBe(Object.prototype);
  });

  test("an unchanged body is a no-op and keeps the stored bytes and timestamp", () => {
    const previous = document(base());
    const built = buildThreadDocument(previous, previous.thread, NOW);
    expect(built.unchanged).toBe(true);
    expect(built.text).toBe(previous.text);
    expect(built.bytes).toBe(previous.bytes);
  });

  test("keeps a v1 file without newer optional fields readable", () => {
    const parsed = document(base());
    expect(parsed.thread.messages[0]?.mode).toBeUndefined();
    expect(parsed.thread.messages[0]?.id).toBe("msg_test0001");
  });

  test("refuses a newer schemaVersion without rewriting it", () => {
    expect(() => document(base({ schemaVersion: 2 }))).toThrow(ThreadDocumentError);
    try {
      document(base({ schemaVersion: 2 }));
    } catch (error) {
      expect((error as ThreadDocumentError).code).toBe("newer");
    }
  });

  test("reports an unknown semantic part as read-only rather than corrupt", () => {
    const raw = base({
      messages: [
        {
          id: "msg_test0001",
          role: "user",
          parts: [{ type: "future-part", text: "From a later build" }],
          createdAt: CREATED
        }
      ]
    });
    try {
      document(raw);
      throw new Error("expected a refusal");
    } catch (error) {
      expect(error).toBeInstanceOf(ThreadDocumentError);
      expect((error as ThreadDocumentError).code).toBe("unsupported");
    }
  });

  test("refuses malformed JSON, duplicate keys, unsafe numbers and invalid UTF-8", () => {
    const text = `${JSON.stringify(base(), null, 2)}\n`;
    expect(() => readThreadDocument({ bytes: bytes("{ not json"), sha256: "h" })).toThrow(ThreadDocumentError);
    expect(() =>
      readThreadDocument({
        bytes: bytes(text.replace('"title": "Old conversation",', '"title": "Old conversation", "title": "again",')),
        sha256: "h"
      })
    ).toThrow(ThreadDocumentError);
    expect(() =>
      readThreadDocument({ bytes: bytes(text.replace('"checkpointTurns": []', '"checkpointTurns": [], "lossy": 9007199254740993')), sha256: "h" })
    ).toThrow(ThreadDocumentError);
    expect(() => readThreadDocument({ bytes: new Uint8Array([0xff, 0xfe, 0x00]), sha256: "h" })).toThrow(
      ThreadDocumentError
    );
  });

  test("refuses an oversized document before parsing it", () => {
    const small = readThreadDocument({ bytes: bytes(base()), sha256: "h", maxBytes: 4_096 });
    expect(small.thread.id).toBe("thread_test0001");
    expect(() =>
      readThreadDocument({ bytes: new Uint8Array(4_097).fill(0x20), sha256: "h", maxBytes: 4_096 })
    ).toThrow(ThreadDocumentError);
  });

  test("refuses to build a document over the save ceiling", () => {
    const previous = document(base());
    expect(() =>
      buildThreadDocument(previous, { ...previous.thread, title: "x".repeat(200) }, NOW, 100)
    ).toThrow(ThreadDocumentError);
  });

  test("returns the typed thread for the next read after an edit", () => {
    const previous = document(base());
    const built = buildThreadDocument(previous, { ...previous.thread, title: "Changed" }, NOW);
    const next = readThreadDocument({ bytes: built.bytes, sha256: "next" });
    expect(next.thread.title).toBe("Changed");
    expect(next.thread.updatedAt).toBe(NOW);
  });
});

test("a new document starts at schema 1 with the supplied timestamp", () => {
  const typed: AgentThread = {
    schemaVersion: 1,
    id: "thread_test0001",
    bookId: "book_test0001",
    title: "New",
    createdAt: CREATED,
    updatedAt: CREATED,
    messages: [],
    plans: [],
    checkpointTurns: []
  };
  const built = buildThreadDocument(null, typed, NOW);
  expect(JSON.parse(built.text).updatedAt).toBe(NOW);
});

const PLAN_PARENT = {
  id: "msg_plan0001",
  role: "assistant",
  parts: [{ type: "text", text: "Here is the plan." }],
  mode: "edit",
  turnId: "turn_plan0001",
  createdAt: CREATED
};

function rawPlan(overrides: Record<string, unknown> = {}): Record<string, unknown> {
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

function terminalRawPlan(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return rawPlan({
    status: "cancelled",
    steps: [{ text: "Read the opening", state: "not-completed" }],
    startedAt: STARTED,
    terminalAt: NOW,
    updatedAt: NOW,
    ...overrides
  });
}

function planned(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return base({
    messages: [PLAN_PARENT],
    plans: [rawPlan()],
    ...overrides
  });
}

function expectRefusal(raw: Record<string, unknown>, code: ThreadDocumentErrorCode): void {
  const input = bytes(raw);
  const before = [...input];
  try {
    readThreadDocument({ bytes: input, sha256: "h" });
    throw new Error("expected the document to be refused");
  } catch (error) {
    expect(error).toBeInstanceOf(ThreadDocumentError);
    expect((error as ThreadDocumentError).code).toBe(code);
  }
  // A read never rewrites or clears the bytes it refused.
  expect([...input]).toEqual(before);
}

describe("plan documents", () => {
  test("keeps a valid plan and every unknown plan field through a rename", () => {
    const raw = planned({
      futureTopLevel: "keep this too",
      plans: [
        rawPlan({
          futurePlanField: { keep: true },
          steps: [{ text: "Read the opening", state: "pending", futureStepField: "step extra" }],
          parent: {
            messageId: "msg_plan0001",
            turnId: "turn_plan0001",
            futureParentField: "parent extra"
          }
        })
      ]
    });
    const previous = document(raw);
    expect(previous.thread.plans[0]?.status).toBe("proposed");
    const built = buildThreadDocument(previous, { ...previous.thread, title: "Renamed" }, NOW);
    expect(built.unchanged).toBe(false);
    const out = JSON.parse(built.text) as Record<string, unknown>;
    expect(out.title).toBe("Renamed");
    expect(out.futureTopLevel).toBe("keep this too");
    const [plan] = out.plans as Array<Record<string, unknown>>;
    if (!plan) throw new Error("Expected the preserved plan");
    expect(plan.futurePlanField).toEqual({ keep: true });
    expect((plan.steps as Array<Record<string, unknown>>)[0]?.futureStepField).toBe("step extra");
    expect((plan.parent as Record<string, unknown>).futureParentField).toBe("parent extra");
  });

  test("an unchanged plan document is a no-op that keeps the stored bytes", () => {
    const previous = document(planned());
    const built = buildThreadDocument(previous, previous.thread, NOW);
    expect(built.unchanged).toBe(true);
    expect(built.text).toBe(previous.text);
    expect(built.bytes).toBe(previous.bytes);
  });

  test("reports an unknown stored status or step state as unsupported and leaves the bytes", () => {
    for (const raw of [
      planned({ plans: [rawPlan({ status: "paused-future" })] }),
      planned({ plans: [rawPlan({ status: "started" })] }),
      planned({ plans: [rawPlan({ steps: [{ text: "Read", state: "skipped" }] })] })
    ]) {
      expectRefusal(raw, "unsupported");
    }
  });

  test("reports a malformed plan as corrupt and leaves the bytes", () => {
    const twoOpen = [
      rawPlan(),
      rawPlan({ id: "plan-2", purpose: "Another plan" })
    ];
    const missingTerminalAt = terminalRawPlan();
    delete missingTerminalAt.terminalAt;
    for (const raw of [
      planned({ messages: [] }),
      planned({ messages: [{ ...PLAN_PARENT, role: "user" }] }),
      planned({ plans: [rawPlan(), rawPlan()] }),
      planned({ plans: twoOpen }),
      planned({ plans: [missingTerminalAt] }),
      planned({ plans: [terminalRawPlan({ steps: [{ text: "Read", state: "pending" }] })] })
    ]) {
      expectRefusal(raw, "corrupt");
    }
  });

  test("a terminal plan is retained next to a new proposal", () => {
    const previous = document(
      planned({ plans: [terminalRawPlan(), rawPlan({ id: "plan-2" })] })
    );
    expect(previous.thread.plans.map((plan) => plan.status)).toEqual(["cancelled", "proposed"]);
    const built = buildThreadDocument(previous, { ...previous.thread, title: "After" }, NOW);
    const out = JSON.parse(built.text) as Record<string, unknown>;
    expect((out.plans as Array<Record<string, unknown>>).map((plan) => plan.status)).toEqual([
      "cancelled",
      "proposed"
    ]);
  });
});
