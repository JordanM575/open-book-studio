import { expect, test } from "bun:test";
import {
  followReading,
  MAX_READING_SPEED,
  MIN_READING_SPEED,
  setReadingSpeed,
  startReading,
  stepReading,
  type ReadingCursor,
  type ReadingCursorResult,
  type ReadingSource,
} from "../../src/voice-session/reading";

const PROSE = "# The hall\n\nThe bell rang once.\n\nThe door stayed shut.\n";

function source(markdown: string, sourceId = "src-1", revision = "rev-1"): ReadingSource {
  return { sourceId, revision, markdown };
}

function cursorOf(result: ReadingCursorResult): ReadingCursor {
  if (!result.ok) throw new Error(result.reason);
  return result.cursor;
}

test("blank, empty-identity, oversize identity, and oversize markdown are refused", () => {
  const prose = "The bell rang once.";
  expect(startReading(source(""))).toEqual({ ok: false, reason: "no-paragraph" });
  expect(startReading(source("\n\n  \n"))).toEqual({ ok: false, reason: "no-paragraph" });
  expect(startReading(source(prose, ""))).toEqual({ ok: false, reason: "empty-identity" });
  expect(startReading(source(prose, "src-1", ""))).toEqual({ ok: false, reason: "empty-identity" });
  expect(startReading(source(prose, "x".repeat(2049)))).toEqual({ ok: false, reason: "oversize-identity" });
  expect(startReading(source(prose, "src-1", "y".repeat(2049)))).toEqual({
    ok: false,
    reason: "oversize-identity",
  });
  expect(startReading(source(`${"a".repeat(65_536)}a`))).toEqual({ ok: false, reason: "oversize-markdown" });

  const atIdentityBound = startReading(source(prose, "s".repeat(2048), "r".repeat(2048)));
  expect(atIdentityBound.ok).toBe(true);
  const atMarkdownBound = startReading(source("a".repeat(65_536)));
  expect(atMarkdownBound.ok).toBe(true);
  if (atMarkdownBound.ok) expect(atMarkdownBound.cursor.paragraphs).toEqual(["a".repeat(65_536)]);
});

test("front matter or a code fence alone is refused, and a fence between prose is not spoken", () => {
  expect(startReading(source("---\ntitle: Synthetic\n---\n"))).toEqual({ ok: false, reason: "no-paragraph" });
  expect(startReading(source("```\nconst hidden = 1;\n```\n"))).toEqual({ ok: false, reason: "no-paragraph" });

  const cursor = cursorOf(startReading(source(
    "---\ntitle: Synthetic\n---\n\nThe bell rang once.\n\n```\nnot spoken\n```\n\nThe door stayed shut.\n",
  )));
  expect(cursor.paragraphs).toEqual(["The bell rang once.", "The door stayed shut."]);
});

test("a heading and two prose paragraphs stay in spoken order", () => {
  const cursor = cursorOf(startReading(source(PROSE, "  src-1  ", "  rev-1  ")));
  expect(cursor.sourceId).toBe("  src-1  ");
  expect(cursor.revision).toBe("  rev-1  ");
  expect(cursor.index).toBe(0);
  expect(cursor.speed).toBe(1);
  expect(cursor.paragraphs).toEqual(["The hall.", "The bell rang once.", "The door stayed shut."]);
  expect(Object.keys(cursor).sort()).toEqual(["index", "paragraphs", "revision", "sourceId", "speed"]);
  expect(Object.isFrozen(cursor)).toBe(true);
  expect(Object.isFrozen(cursor.paragraphs)).toBe(true);
});

test("one Unicode paragraph round-trips a non-BMP character", () => {
  const line = "The bell \u{1F514} rang once.";
  expect(line.codePointAt(9)).toBe(0x1f514);
  const cursor = cursorOf(startReading(source(line)));
  expect(cursor.paragraphs).toEqual([line]);
});

test("next and previous do not wrap, and the previous cursor is unchanged", () => {
  const original = cursorOf(startReading(source(PROSE)));
  const snapshot = {
    sourceId: original.sourceId,
    revision: original.revision,
    paragraphs: [...original.paragraphs],
    index: original.index,
    speed: original.speed,
  };

  const stayed = stepReading(original, "previous");
  expect(stayed.boundary).toBe("start");
  expect(stayed.cursor.index).toBe(0);
  expect(stayed.cursor).not.toBe(original);
  expect(original).toEqual(snapshot);

  const middle = stepReading(stayed.cursor, "next");
  expect(middle.boundary).toBe("none");
  expect(middle.cursor.index).toBe(1);
  expect(middle.cursor.paragraphs).toBe(original.paragraphs);

  const last = stepReading(middle.cursor, "next");
  expect(last.boundary).toBe("none");
  expect(last.cursor.index).toBe(2);

  const end = stepReading(last.cursor, "next");
  expect(end.boundary).toBe("end");
  expect(end.cursor.index).toBe(2);
  expect(end.cursor.paragraphs[0]).toBe("The hall.");

  const back = stepReading(end.cursor, "previous");
  expect(back.boundary).toBe("none");
  expect(back.cursor.index).toBe(1);
  expect(original).toEqual(snapshot);
});

test("speed 0.25, 1, and 4 are accepted, and out-of-range speeds do not move the paragraph", () => {
  expect(MIN_READING_SPEED).toBe(0.25);
  expect(MAX_READING_SPEED).toBe(4);
  const cursor = stepReading(cursorOf(startReading(source(PROSE))), "next").cursor;
  expect(cursor.index).toBe(1);

  for (const speed of [0.25, 1, 4]) {
    const accepted = setReadingSpeed(cursor, speed);
    expect(accepted.ok).toBe(true);
    if (!accepted.ok) continue;
    expect(accepted.cursor.speed).toBe(speed);
    expect(accepted.cursor.index).toBe(1);
    expect(accepted.cursor).not.toBe(cursor);
    expect(cursor.speed).toBe(1);
  }

  for (const speed of [0.24, 4.01, Number.NaN, Number.POSITIVE_INFINITY]) {
    const refused = setReadingSpeed(cursor, speed);
    expect(refused).toEqual({ ok: false, reason: "invalid-speed" });
    expect(cursor.index).toBe(1);
    expect(cursor.speed).toBe(1);
  }

  expect(startReading(source(PROSE), 0.25).ok).toBe(true);
  expect(startReading(source(PROSE), 4).ok).toBe(true);
  expect(startReading(source(PROSE), 0.24)).toEqual({ ok: false, reason: "invalid-speed" });
});

test("the same source follows, and a changed revision or body does not", () => {
  const origin = source(PROSE);
  const cursor = stepReading(cursorOf(startReading(origin)), "next").cursor;
  const followed = followReading(cursor, origin);
  expect(followed).toEqual({ ok: true, cursor });

  const emphasized = followReading(cursor, source("# The hall\n\nThe **bell** rang once.\n\nThe door stayed shut.\n"));
  expect(emphasized).toEqual({ ok: true, cursor });

  expect(followReading(cursor, source(PROSE, "src-1", "rev-2"))).toEqual({
    ok: false,
    reason: "source-mismatch",
  });
  expect(followReading(cursor, source(PROSE, "src-2", "rev-1"))).toEqual({
    ok: false,
    reason: "source-mismatch",
  });
  expect(followReading(cursor, source("The hall.\n\nA different sentence stood alone.\n"))).toEqual({
    ok: false,
    reason: "source-mismatch",
  });
  expect(cursor.index).toBe(1);
  expect(cursor.revision).toBe("rev-1");
  expect(cursor.paragraphs).toEqual(["The hall.", "The bell rang once.", "The door stayed shut."]);
});

test("the cursor does not write or alter the supplied markdown", () => {
  const markdown = "The bell rang once.\n\nThe door stayed shut.\n";
  const origin = Object.freeze(source(markdown));
  const cursor = cursorOf(startReading(origin));
  stepReading(cursor, "next");
  setReadingSpeed(cursor, 1);
  followReading(cursor, origin);
  expect(origin.markdown).toBe(markdown);
  expect(markdown).toBe("The bell rang once.\n\nThe door stayed shut.\n");
});
