import { describe, expect, test } from "bun:test";
import { encodeWorkflowRecord, projectAnsweredQuestion } from "../../src/authoring";
import { owner } from "./fixtures";

const at = "2026-11-07T00:00:00.000Z";
const answeredAt = "2026-11-08T12:34:56.789Z";
const hash = (n = 1) => n.toString(16).padStart(64, "0");
const previousHash = hash(11);
const absentBase = { kind: "absent" as const, revision: 0 as const };

function questionReference(id = "question_1", revision = 1) {
  return { kind: "question" as const, owner: { ...owner }, id, revision, hash: hash(revision) };
}

function directionReference(id = "direction_2", revision = 1, digest = revision + 3) {
  return {
    kind: "direction" as const,
    owner: { ...owner },
    id,
    revision,
    hash: hash(digest),
    label: "kept-reference",
  };
}

function openQuestion(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    kind: "question",
    owner: { ...owner },
    id: "question_1",
    revision: 1,
    base: absentBase,
    generation: 1,
    keys: ["mara"],
    affected: ["task_1"],
    characterId: null,
    evidence: [],
    options: [{ id: "option_1", label: "Leave", consequence: "She goes." }],
    state: "open",
    answer: null,
    prompt: "Does Mara leave?",
    irreversibleChoice: true,
    createdAt: at,
    updatedAt: at,
    ...overrides,
  };
}

function answerDirection(confirmed = "Protective lie", overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    kind: "direction",
    owner: { ...owner },
    id: "direction_2",
    revision: 1,
    exactText: confirmed,
    origin: "answer",
    previous: null,
    question: questionReference(),
    createdAt: at,
    ...overrides,
  };
}

function proposed(overrides: Record<string, unknown> = {}) {
  return {
    exactText: "  protective lie\n",
    confirmedText: "Protective lie",
    direction: directionReference(),
    note: "not stored",
    ...overrides,
  };
}

function project(
  question: unknown = openQuestion(),
  namedRevision: unknown = 1,
  answer: unknown = proposed(),
  direction: unknown = answerDirection(),
  when: unknown = answeredAt,
  previous: unknown = previousHash,
) {
  return projectAnsweredQuestion(question, namedRevision, answer, direction, owner, when, previous);
}

describe("projectAnsweredQuestion", () => {
  test("projects a frozen next revision and leaves the caller unchanged", () => {
    const question = openQuestion({ generation: 4, keys: ["mara", "door"] });
    const direction = answerDirection();
    const answer = proposed();
    const before = {
      question: JSON.stringify(question),
      answer: JSON.stringify(answer),
      direction: JSON.stringify(direction),
    };
    const projected = projectAnsweredQuestion(
      question,
      1,
      answer,
      direction,
      owner,
      answeredAt,
      previousHash,
    );

    expect(projected.revision).toBe(2);
    expect(projected.base).toEqual({ kind: "sha256", value: previousHash, revision: 1 });
    expect(projected.state).toBe("answered");
    expect(projected.updatedAt).toBe(answeredAt);
    expect(projected.createdAt).toBe(at);
    expect(projected.generation).toBe(4);
    expect(projected.id).toBe("question_1");
    expect(projected.kind).toBe("question");
    expect(projected.schemaVersion).toBe(1);
    expect(projected.prompt).toBe("Does Mara leave?");
    expect(projected.irreversibleChoice).toBe(true);
    expect(projected.characterId).toBeNull();
    expect(projected.keys).toEqual(["mara", "door"]);
    expect(projected.keys).not.toBe(question.keys);
    expect(projected.options).toEqual(question.options);
    expect(projected.options).not.toBe(question.options);
    expect(projected.owner).toEqual(owner);
    expect(projected.owner).not.toBe(question.owner);
    expect(Object.hasOwn(projected, "hash")).toBe(false);

    const stored = projected.answer as {
      exactText: string;
      confirmedText: string;
      direction: Record<string, unknown>;
      answeredAt: string;
    };
    expect(Object.keys(stored).sort()).toEqual([
      "answeredAt",
      "confirmedText",
      "direction",
      "exactText",
    ]);
    expect(stored.exactText).toBe("  protective lie\n");
    expect(stored.confirmedText).toBe("Protective lie");
    expect(stored.answeredAt).toBe(answeredAt);
    expect(stored.direction).toEqual(answer.direction);
    expect(stored.direction).not.toBe(answer.direction);
    expect(stored.direction.owner).not.toBe(answer.direction.owner);
    expect(stored.direction.label).toBe("kept-reference");
    expect(JSON.stringify(projected)).not.toContain("not stored");
    expect(encodeWorkflowRecord(projected).byteLength).toBeGreaterThan(0);

    expect(Object.isFrozen(projected)).toBe(true);
    expect(Object.isFrozen(projected.base)).toBe(true);
    expect(Object.isFrozen(projected.answer)).toBe(true);
    expect(Object.isFrozen(stored.direction)).toBe(true);
    expect(Object.isFrozen(projected.keys)).toBe(true);
    expect(Object.isFrozen(projected.owner)).toBe(true);
    expect(Object.isFrozen(question)).toBe(false);
    expect(Object.isFrozen(answer)).toBe(false);
    expect(Object.isFrozen(answer.direction)).toBe(false);
    expect(Object.isFrozen(direction)).toBe(false);
    expect(JSON.stringify(question)).toBe(before.question);
    expect(JSON.stringify(answer)).toBe(before.answer);
    expect(JSON.stringify(direction)).toBe(before.direction);
    expect(question.state).toBe("open");
    expect(question.answer).toBeNull();
    expect(question.revision).toBe(1);

    answer.direction.hash = hash(99);
    expect(stored.direction.hash).toBe(hash(4));
  });

  test("advances a later open revision without bumping generation", () => {
    const question = openQuestion({
      revision: 2,
      generation: 3,
      base: { kind: "sha256", value: hash(1), revision: 1 },
    });
    const direction = answerDirection("Protective lie", {
      revision: 2,
      previous: directionReference("direction_1", 1),
      question: questionReference("question_1", 2),
    });
    const projected = project(
      question,
      2,
      proposed({ direction: directionReference("direction_2", 2) }),
      direction,
    );
    expect(projected.revision).toBe(3);
    expect(projected.base).toEqual({ kind: "sha256", value: previousHash, revision: 2 });
    expect(projected.generation).toBe(3);
    expect(projected.createdAt).toBe(at);
    expect(projected.state).toBe("answered");
    expect(question.revision).toBe(2);
    expect(question.state).toBe("open");
    expect(question.answer).toBeNull();
    expect(Object.isFrozen(question)).toBe(false);
    expect(Object.isFrozen(direction)).toBe(false);
  });

  test("unwraps a snapshot and keeps a question's own nested record", () => {
    const question = openQuestion();
    const snapshot = { record: question, bytes: new Uint8Array([1, 2]) };
    const projected = project(snapshot);
    expect(projected.id).toBe("question_1");
    expect(projected.prompt).toBe("Does Mara leave?");
    expect(projected.revision).toBe(2);
    expect(Object.hasOwn(projected, "bytes")).toBe(false);
    expect(Object.hasOwn(projected, "record")).toBe(false);
    expect(Object.isFrozen(snapshot)).toBe(false);
    expect(Object.isFrozen(question)).toBe(false);
    expect(question.state).toBe("open");

    const nestedRecord = { id: "question_9", marker: "kept" };
    const nested = openQuestion({ record: nestedRecord });
    const fromNested = project(nested);
    expect(fromNested.id).toBe("question_1");
    expect(fromNested.record).toEqual(nestedRecord);
    expect(fromNested.record).not.toBe(nestedRecord);
    expect(fromNested.state).toBe("answered");
    expect(nested.state).toBe("open");
    expect(Object.getOwnPropertyDescriptor(nested, "record")?.value).toBe(nestedRecord);
  });

  test("lets the existing check refuse before the timestamp or digest is read", () => {
    const badTime = "not-a-time";
    const badDigest = "not-a-digest";
    const question = openQuestion();
    expect(() => project(openQuestion({ state: "answered" }), 1, proposed(), answerDirection(), badTime, badDigest))
      .toThrow("stale-question");
    expect(() => project(question, 2, proposed(), answerDirection(), badTime, badDigest))
      .toThrow("stale-question");
    expect(() => project(question, 1, null, answerDirection(), badTime, badDigest))
      .toThrow("invalid-answer");
    expect(() => project(
      question,
      1,
      proposed(),
      answerDirection("Protective lie", { origin: "author", question: null }),
      badTime,
      badDigest,
    )).toThrow("invalid-question-link");
    expect(() => project(
      question,
      1,
      proposed(),
      answerDirection("Protective lie", { revision: 2 }),
      badTime,
      badDigest,
    )).toThrow("stale-direction-link");
    expect(() => project(
      question,
      1,
      proposed(),
      answerDirection("  protective lie\n"),
      badTime,
      badDigest,
    )).toThrow("direction-text-mismatch");
    expect(question.state).toBe("open");
    expect(question.answer).toBeNull();
    expect(question.revision).toBe(1);
    expect(Object.isFrozen(question)).toBe(false);
  });

  test("refuses an invalid timestamp before an invalid digest", () => {
    const question = openQuestion();
    const answer = proposed();
    const direction = answerDirection();
    expect(() => project(question, 1, answer, direction, "not-a-time", "not-a-digest"))
      .toThrow("invalid-timestamp");
    expect(() => project(question, 1, answer, direction, "2026-11-08T12:34:56Z", "not-a-digest"))
      .toThrow("invalid-timestamp");
    expect(() => project(question, 1, answer, direction, 1, "not-a-digest"))
      .toThrow("invalid-timestamp");
    expect(() => project(question, 1, answer, direction, answeredAt, "not-a-digest"))
      .toThrow("invalid-digest");
    expect(() => project(question, 1, answer, direction, answeredAt, previousHash.slice(0, 63)))
      .toThrow("invalid-digest");
    expect(question.state).toBe("open");
    expect(question.answer).toBeNull();
    expect(question.updatedAt).toBe(at);
    expect(Object.isFrozen(question)).toBe(false);
    expect(Object.isFrozen(answer)).toBe(false);
    expect(Object.isFrozen(direction)).toBe(false);
  });
});
