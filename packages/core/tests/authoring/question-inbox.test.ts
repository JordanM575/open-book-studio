import { describe, expect, test } from "bun:test";
import { projectQuestionInbox } from "../../src/authoring";
import { owner } from "./fixtures";

function question(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    state: "open",
    kind: "question",
    keys: ["mara"],
    options: [{ label: "Leave", consequence: "The town forgets her" }],
    answer: { exactText: "She stays" },
    prompt: "Does Mara leave?",
    ...overrides,
  };
}

describe("projectQuestionInbox", () => {
  test("keeps open questions, sorts by id, and copies only an explicit classification", () => {
    const absent = question("question_10");
    const closed = question("question_2", { state: "answered", irreversibleChoice: true });
    const explicitFalse = question("question_b", { irreversibleChoice: false });
    const explicitTrue = question("question_a", { irreversibleChoice: true });
    const inbox = projectQuestionInbox(
      [absent, closed, explicitFalse, explicitTrue],
      owner,
    );

    expect(inbox.questions.map((entry) => entry.id)).toEqual([
      "question_10",
      "question_a",
      "question_b",
    ]);
    expect(inbox.questions.every((entry) => entry.state === "open")).toBe(true);
    expect(Object.hasOwn(inbox.questions[0]!, "irreversibleChoice")).toBe(false);
    expect(inbox.questions[1]!.irreversibleChoice).toBe(true);
    expect(inbox.questions[2]!.irreversibleChoice).toBe(false);
    expect(Object.isFrozen(inbox)).toBe(true);
    expect(Object.isFrozen(inbox.questions)).toBe(true);
    expect(Object.isFrozen(inbox.questions[0])).toBe(true);
  });

  test("omits prose, keys, options, and answers", () => {
    const source = question("question_00000001", { irreversibleChoice: true });
    const inbox = projectQuestionInbox([source], owner);
    const serialized = JSON.stringify(inbox);
    expect(serialized).not.toContain("mara");
    expect(serialized).not.toContain("Leave");
    expect(serialized).not.toContain("town forgets");
    expect(serialized).not.toContain("She stays");
    expect(serialized).not.toContain("Does Mara");
    expect(Object.keys(inbox.questions[0]!).sort()).toEqual([
      "id",
      "irreversibleChoice",
      "state",
    ]);
    expect(Object.keys(source)).toContain("prompt");
  });

  test("does not treat absence as false and does not freeze the caller", () => {
    const source = question("question_00000001");
    const inbox = projectQuestionInbox([source], owner);
    expect(JSON.stringify(inbox.questions[0])).toBe(
      '{"id":"question_00000001","state":"open"}',
    );
    expect(Object.isFrozen(source)).toBe(false);
    source.keys.push("untouched");
    expect(source.keys).toEqual(["mara", "untouched"]);
  });

  test("drops answered, superseded, and withdrawn questions after validating them", () => {
    const inbox = projectQuestionInbox(
      [
        question("question_open"),
        question("question_answered", { state: "answered" }),
        question("question_superseded", { state: "superseded" }),
        question("question_withdrawn", { state: "withdrawn", irreversibleChoice: false }),
      ],
      owner,
    );
    expect(inbox.questions.map((entry) => entry.id)).toEqual(["question_open"]);
  });

  test("a question's own classification wins over a nested record", () => {
    const nested = question("question_00000001", {
      irreversibleChoice: true,
      record: { irreversibleChoice: false, prompt: "hidden" },
    });
    const inbox = projectQuestionInbox([nested], owner);
    expect(inbox.questions[0]!.irreversibleChoice).toBe(true);
    expect(JSON.stringify(inbox)).not.toContain("hidden");

    const outerAbsent = question("question_00000002", {
      record: { irreversibleChoice: true, state: "open", id: "question_other" },
    });
    const fromOuter = projectQuestionInbox([outerAbsent], owner);
    expect(fromOuter.questions.map((entry) => entry.id)).toEqual(["question_00000002"]);
    expect(Object.hasOwn(fromOuter.questions[0]!, "irreversibleChoice")).toBe(false);
  });

  test("unwraps a snapshot that has no question kind or state of its own", () => {
    const snapshot = {
      record: question("question_00000001", { irreversibleChoice: false }),
      bytes: new Uint8Array([1]),
      hash: "abc",
    };
    const inbox = projectQuestionInbox([snapshot], owner);
    expect(inbox.questions).toEqual([
      { id: "question_00000001", state: "open", irreversibleChoice: false },
    ]);
    expect(JSON.stringify(inbox)).not.toContain("abc");
  });

  test("accepts a complete listing and refuses a partial page", () => {
    const open = question("question_00000002", { irreversibleChoice: true });
    const answered = question("question_00000001", { state: "answered" });
    const listing = {
      bookId: owner.bookId,
      runId: owner.runId,
      offset: 0,
      limit: 256,
      total: 2,
      questions: [open, answered],
    };
    const inbox = projectQuestionInbox(listing, owner);
    expect(inbox.questions).toEqual([
      { id: "question_00000002", state: "open", irreversibleChoice: true },
    ]);

    expect(() =>
      projectQuestionInbox({ questions: [open, answered], total: 3, offset: 0 }, owner),
    ).toThrow("partial-question-list");
    expect(() =>
      projectQuestionInbox({ questions: [open], total: 1, offset: 256 }, owner),
    ).toThrow("partial-question-list");
    expect(() =>
      projectQuestionInbox({ questions: [open, answered], total: 1, offset: 0 }, owner),
    ).toThrow("partial-question-list");
    expect(() =>
      projectQuestionInbox({ questions: [open], total: "1", offset: 0 }, owner),
    ).toThrow("partial-question-list");
    expect(() =>
      projectQuestionInbox({ questions: [open], offset: "0" }, owner),
    ).toThrow("partial-question-list");
    expect(projectQuestionInbox({ questions: [open], offset: 0 }, owner).questions).toHaveLength(1);
    expect(projectQuestionInbox({ questions: [], total: 0, offset: 0 }, owner).questions).toEqual(
      [],
    );
  });

  test("refuses duplicates, foreign records, bad state, and a non-boolean classification", () => {
    const foreignOwner = { ...owner, runId: "run_99999999" };
    expect(() =>
      projectQuestionInbox(
        [question("question_00000001"), question("question_00000001", { state: "answered" })],
        owner,
      ),
    ).toThrow("duplicate-question");
    expect(() =>
      projectQuestionInbox(
        [{ id: "question_00000001", state: "open", kind: "effect" }],
        owner,
      ),
    ).toThrow("foreign-kind");
    expect(() =>
      projectQuestionInbox(
        [{ id: "question_00000001", state: "open", owner: foreignOwner }],
        owner,
      ),
    ).toThrow("foreign-owner");
    expect(() =>
      projectQuestionInbox([{ id: "question_00000001", state: "future-state" }], owner),
    ).toThrow("unknown-question-state");
    expect(() =>
      projectQuestionInbox([{ id: "question_00000001", state: 1 }], owner),
    ).toThrow("invalid-question-state");
    expect(() =>
      projectQuestionInbox(
        [{ id: "question_00000001", state: "answered", irreversibleChoice: "yes" }],
        owner,
      ),
    ).toThrow("invalid-irreversible-choice");
    expect(() =>
      projectQuestionInbox(
        [{ id: "question_00000001", state: "open", irreversibleChoice: null }],
        owner,
      ),
    ).toThrow("invalid-irreversible-choice");
    expect(() => projectQuestionInbox(null, owner)).toThrow("invalid-questions");
    expect(() => projectQuestionInbox({ total: 0 }, owner)).toThrow("invalid-questions");
    expect(() =>
      projectQuestionInbox([question("question_00000001")], { ...owner, bookId: "bad id!" }),
    ).toThrow();
  });

  test("refuses more than 10,000 inputs before inspecting them", () => {
    let inspected = false;
    const poison = new Proxy(
      { id: "question_00000001", state: "open", kind: "effect" },
      {
        get(target, prop, receiver) {
          inspected = true;
          return Reflect.get(target, prop, receiver);
        },
      },
    );
    const huge: unknown[] = [poison];
    huge.length = 10_001;
    let totalRead = false;
    const listing = { questions: huge };
    Object.defineProperty(listing, "total", {
      get() {
        totalRead = true;
        return huge.length;
      },
    });
    expect(() => projectQuestionInbox(listing, owner)).toThrow("question-inbox-too-large");
    expect(inspected).toBe(false);
    expect(totalRead).toBe(false);
    expect(() => projectQuestionInbox(huge, owner)).toThrow("question-inbox-too-large");
    expect(inspected).toBe(false);
  });

  test("inspects exactly 10,000 inputs", () => {
    const full = Array.from({ length: 10_000 }, (_, index) => {
      const overrides: Record<string, unknown> = {};
      if (index === 9_999) overrides.irreversibleChoice = false;
      return question(`q${String(index).padStart(4, "0")}`, overrides);
    });
    const inbox = projectQuestionInbox(full, owner);
    expect(inbox.questions).toHaveLength(10_000);
    expect(inbox.questions[0]!.id).toBe("q0000");
    expect(inbox.questions[9_999]!.id).toBe("q9999");
    expect(inbox.questions[9_999]!.irreversibleChoice).toBe(false);
    expect(Object.hasOwn(inbox.questions[0]!, "irreversibleChoice")).toBe(false);

    const refused: unknown[] = full.slice();
    refused[10] = { id: "q0010", state: "later" };
    expect(() => projectQuestionInbox(refused, owner)).toThrow("unknown-question-state");
  });
});
