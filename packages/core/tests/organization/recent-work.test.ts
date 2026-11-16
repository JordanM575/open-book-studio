import { describe, expect, test } from "bun:test";
import {
  RECENT_NON_EXPLICIT_INTENTS,
  RECENT_POINTER_BYTES,
  dismissRecentPointer,
  emptyRecentWork,
  recentPointerBytes,
  recordRecentOpen,
  selectRecentScope,
  type RecentDismissResult,
  type RecentRecordResult,
  type RecentWorkList,
} from "../../src/organization/recent-work";

const SCOPE = "opaque-library-token";

function ready(scope = SCOPE): RecentWorkList {
  const result = emptyRecentWork(scope);
  if (result.status !== "ready") throw new Error("expected an empty list");
  return result.list;
}

function intent(
  bookId: string,
  id: string,
  openedAt: string,
  extras: Record<string, unknown> = {},
) {
  return {
    id,
    kind: "explicit-navigation" as const,
    bookId,
    openedAt,
    openedSuccessfully: true,
    remainsCurrent: true,
    ...extras,
  };
}

function trackingWriter() {
  const calls: unknown[] = [];
  return {
    calls,
    write(...args: unknown[]) {
      calls.push(args);
      throw new Error("the recent-work contract must not call the writer");
    },
  };
}

function recorded(result: RecentRecordResult): RecentWorkList {
  if (result.status !== "recorded") {
    throw new Error(result.status === "refused" ? result.reason : "not recorded");
  }
  return result.list;
}

function dismissed(result: RecentDismissResult): RecentWorkList {
  if (result.status !== "dismissed") {
    throw new Error(result.status === "refused" ? result.reason : "not dismissed");
  }
  return result.list;
}

describe("recent work pointers", () => {
  test("a repeated open of the same book is newest and the display time is not the order", () => {
    const writer = trackingWriter();
    const first = recorded(recordRecentOpen(ready(), SCOPE, intent("book_aaaaaa", "open-1", "Friday"), writer));
    const second = recorded(recordRecentOpen(first, SCOPE, intent("book_bbbbbb", "open-2", "Monday"), writer));
    const third = recorded(recordRecentOpen(second, SCOPE, intent("book_aaaaaa", "open-3", "Wednesday"), writer));

    expect(third.pointers.map((pointer) => pointer.bookId)).toEqual(["book_aaaaaa", "book_bbbbbb"]);
    expect(third.pointers.map((pointer) => pointer.openedAt)).toEqual(["Wednesday", "Monday"]);
    expect(third.consumedIntentIds).toEqual(["open-1", "open-2", "open-3"]);
    expect(second.pointers.map((pointer) => pointer.bookId)).toEqual(["book_bbbbbb", "book_aaaaaa"]);
    expect(second.pointers[1]?.openedAt).toBe("Friday");
    expect(writer.calls).toEqual([]);
    expect(Object.isFrozen(third)).toBe(true);
    expect(Object.isFrozen(third.pointers)).toBe(true);
    expect(Object.isFrozen(third.pointers[0])).toBe(true);
    expect(Object.isFrozen(third.consumedIntentIds)).toBe(true);
  });

  test("listing, refresh, import, onboarding, review, and background reads do not record", () => {
    const list = ready();
    for (const kind of RECENT_NON_EXPLICIT_INTENTS) {
      const writer = trackingWriter();
      const result = recordRecentOpen(list, SCOPE, { ...intent("book_aaaaaa", `intent-${kind}`, "Now"), kind }, writer);
      expect(result).toEqual({ status: "refused", reason: "not-explicit-navigation", list });
      expect(result.status).not.toBe("recorded");
      expect(writer.calls).toEqual([]);
      expect(list.pointers).toEqual([]);
    }
  });

  test("an intent that already succeeded is not recorded again", () => {
    const list = recorded(recordRecentOpen(ready(), SCOPE, intent("book_aaaaaa", "open-1", "Now"), trackingWriter()));
    const replay = recordRecentOpen(list, SCOPE, intent("book_aaaaaa", "open-1", "Later"), trackingWriter());
    expect(replay).toEqual({ status: "refused", reason: "intent-replayed", list });
    expect(replay.status).not.toBe("recorded");
    expect(list.pointers).toEqual([{ bookId: "book_aaaaaa", openedAt: "Now", scope: SCOPE }]);
    const retry = recordRecentOpen(
      list,
      SCOPE,
      { ...intent("book_bbbbbb", "open-2", "Later"), openedSuccessfully: false },
      trackingWriter(),
    );
    expect(retry).toEqual({ status: "refused", reason: "open-not-current", list });
    const afterMiss = recorded(recordRecentOpen(list, SCOPE, intent("book_bbbbbb", "open-2", "Later"), trackingWriter()));
    expect(afterMiss.pointers.map((pointer) => pointer.bookId)).toEqual(["book_bbbbbb", "book_aaaaaa"]);
  });

  test("the same scope keeps its pointers and a different scope does not record over them", () => {
    const list = recorded(recordRecentOpen(ready(), SCOPE, intent("book_aaaaaa", "open-1", "Now"), trackingWriter()));
    const retained = selectRecentScope(list, SCOPE);
    expect(retained.status).toBe("retained");
    if (retained.status !== "retained") throw new Error("expected the same scope");
    expect(retained.list).toBe(list);

    const replaced = selectRecentScope(list, "other-token", trackingWriter());
    expect(replaced.status).toBe("replaced");
    if (replaced.status !== "replaced") throw new Error("expected a fresh scope");
    expect(replaced.previous).toBe(list);
    expect(replaced.list).not.toBe(list);
    expect(replaced.list).toEqual({ scope: "other-token", pointers: [], consumedIntentIds: [] });
    expect(Object.isFrozen(replaced.list)).toBe(true);
    expect(list.pointers.map((pointer) => pointer.bookId)).toEqual(["book_aaaaaa"]);

    const crossed = recordRecentOpen(list, "other-token", intent("book_bbbbbb", "open-2", "Later"), trackingWriter());
    expect(crossed).toEqual({ status: "refused", reason: "scope-mismatch", list });
    expect(crossed.status).not.toBe("recorded");
    expect(list.pointers.map((pointer) => pointer.bookId)).toEqual(["book_aaaaaa"]);

    const missingWriter = selectRecentScope(list, "third-token");
    expect(missingWriter).toEqual({ status: "refused", reason: "missing-writer", list });
    expect(list.scope).toBe(SCOPE);
  });

  test("dismissal removes one pointer and an absent pointer is not a removal", () => {
    const first = recorded(recordRecentOpen(ready(), SCOPE, intent("book_aaaaaa", "open-1", "Now"), trackingWriter()));
    const second = recorded(recordRecentOpen(first, SCOPE, intent("book_bbbbbb", "open-2", "Later"), trackingWriter()));
    const removed = dismissed(dismissRecentPointer(second, SCOPE, "book_bbbbbb", trackingWriter()));
    expect(removed.pointers).toEqual([{ bookId: "book_aaaaaa", openedAt: "Now", scope: SCOPE }]);
    expect(removed.consumedIntentIds).toEqual(["open-1", "open-2"]);
    expect(second.pointers.map((pointer) => pointer.bookId)).toEqual(["book_bbbbbb", "book_aaaaaa"]);

    const absent = dismissRecentPointer(removed, SCOPE, "book_cccccc", trackingWriter());
    expect(absent).toEqual({ status: "refused", reason: "pointer-absent", list: removed });
    expect(absent.status).not.toBe("dismissed");
    expect(removed.pointers.map((pointer) => pointer.bookId)).toEqual(["book_aaaaaa"]);
    const replay = recordRecentOpen(removed, SCOPE, intent("book_bbbbbb", "open-2", "Again"), trackingWriter());
    expect(replay).toEqual({ status: "refused", reason: "intent-replayed", list: removed });
  });

  test("a writer is inspected and never called, and a throwing writer is not success", () => {
    const list = ready();
    const called = trackingWriter();
    const saved = recorded(recordRecentOpen(list, SCOPE, intent("book_aaaaaa", "open-1", "Now"), called));
    expect(called.calls).toEqual([]);
    expect(saved.pointers).toHaveLength(1);

    const source = {
      write() {
        return undefined;
      },
      toString() {
        throw new Error("do not read the writer source");
      },
    };
    const unread = recorded(recordRecentOpen(saved, SCOPE, intent("book_bbbbbb", "open-2", "Later"), source));
    expect(unread.pointers.map((pointer) => pointer.bookId)).toEqual(["book_bbbbbb", "book_aaaaaa"]);

    const throwing = new Proxy({}, {
      get() {
        throw new Error("writer inspection failed");
      },
    });
    const refused = recordRecentOpen(unread, SCOPE, intent("book_cccccc", "open-3", "After"), throwing);
    expect(refused).toEqual({ status: "refused", reason: "invalid-writer", list: unread });
    expect(refused.status).not.toBe("recorded");
    expect(unread.pointers.map((pointer) => pointer.bookId)).toEqual(["book_bbbbbb", "book_aaaaaa"]);

    const missing = dismissRecentPointer(unread, SCOPE, "book_bbbbbb", undefined);
    expect(missing).toEqual({ status: "refused", reason: "missing-writer", list: unread });
    expect(missing.status).not.toBe("dismissed");
    const invalid = recordRecentOpen(unread, SCOPE, intent("book_cccccc", "open-3", "After"), { write: "no" });
    expect(invalid).toEqual({ status: "refused", reason: "invalid-writer", list: unread });
  });

  test("a pointer keeps no prose, title, path, draft, or score", () => {
    const prose = "Chapter one. The river was low.";
    const list = recorded(recordRecentOpen(
      ready(),
      SCOPE,
      intent("book_aaaaaa", "open-1", "Shown as typed", {
        prose,
        title: "Same title",
        path: "books/book_aaaaaa",
        draft: "unsaved sentence",
        wordCount: 40,
        qualityScore: 9,
        activity: "wrote a scene",
      }),
      trackingWriter(),
    ));
    expect(list.pointers).toEqual([{ bookId: "book_aaaaaa", openedAt: "Shown as typed", scope: SCOPE }]);
    expect(Object.keys(list.pointers[0] ?? {})).toEqual(["bookId", "openedAt", "scope"]);
    expect(JSON.stringify(list.pointers)).not.toContain(prose);
    expect(JSON.stringify(list)).not.toContain("Same title");

    const broken = {
      scope: SCOPE,
      pointers: [{ bookId: "book_aaaaaa", openedAt: "Now", scope: SCOPE, prose }],
      consumedIntentIds: [],
    };
    const refused = recordRecentOpen(broken, SCOPE, intent("book_bbbbbb", "open-2", "Later"), trackingWriter());
    expect(refused).toEqual({ status: "refused", reason: "malformed", list: broken });
    expect(refused.status).not.toBe("recorded");
    expect(broken.pointers[0]?.prose).toBe(prose);
  });

  test("the recent-pointer budget evicts only the oldest pointers", () => {
    const writer = trackingWriter();
    const chunk = "x".repeat(900_000);
    const first = recorded(recordRecentOpen(ready(), SCOPE, intent("book_aaaaaa", "open-1", chunk), writer));
    const second = recorded(recordRecentOpen(first, SCOPE, intent("book_bbbbbb", "open-2", chunk), writer));
    expect(recentPointerBytes(second.pointers)).toBeLessThanOrEqual(RECENT_POINTER_BYTES);
    expect(second.pointers.map((pointer) => pointer.bookId)).toEqual(["book_bbbbbb", "book_aaaaaa"]);

    const third = recorded(recordRecentOpen(second, SCOPE, intent("book_cccccc", "open-3", chunk), writer));
    expect(third.pointers.map((pointer) => pointer.bookId)).toEqual(["book_cccccc", "book_bbbbbb"]);
    expect(third.pointers.map((pointer) => pointer.bookId)).not.toContain("book_aaaaaa");
    expect(recentPointerBytes(third.pointers)).toBeLessThanOrEqual(RECENT_POINTER_BYTES);
    expect(second.pointers.map((pointer) => pointer.bookId)).toEqual(["book_bbbbbb", "book_aaaaaa"]);
    expect(writer.calls).toEqual([]);

    const longId = "i".repeat(800_000);
    const kept = recorded(recordRecentOpen(second, SCOPE, intent("book_dddddd", longId, "short"), writer));
    expect(kept.pointers.map((pointer) => pointer.bookId)).toEqual(["book_dddddd", "book_bbbbbb", "book_aaaaaa"]);
    expect(kept.consumedIntentIds).toContain(longId);
    expect(recentPointerBytes(kept.pointers)).toBeLessThanOrEqual(RECENT_POINTER_BYTES);

    const tooBig = recordRecentOpen(second, SCOPE, intent("book_eeeeee", "open-huge", "y".repeat(2_600_000)), writer);
    expect(tooBig).toEqual({ status: "refused", reason: "pointer-exceeds-budget", list: second });
    expect(tooBig.status).not.toBe("recorded");
    expect(second.pointers.map((pointer) => pointer.bookId)).toEqual(["book_bbbbbb", "book_aaaaaa"]);
  });

  test("malformed input is refused and is not replaced with an empty list", () => {
    const list = ready();
    expect(emptyRecentWork("")).toEqual({ status: "refused", reason: "malformed" });
    expect(emptyRecentWork(1)).toEqual({ status: "refused", reason: "malformed" });
    const notList = recordRecentOpen(1, SCOPE, intent("book_aaaaaa", "open-1", "Now"), trackingWriter());
    expect(notList).toEqual({ status: "refused", reason: "malformed", list: 1 });
    const badBook = recordRecentOpen(list, SCOPE, intent("book_short", "open-1", "Now"), trackingWriter());
    expect(badBook).toEqual({ status: "refused", reason: "malformed", list });
    const notCurrent = recordRecentOpen(
      list,
      SCOPE,
      { ...intent("book_aaaaaa", "open-1", "Now"), remainsCurrent: false },
      trackingWriter(),
    );
    expect(notCurrent).toEqual({ status: "refused", reason: "open-not-current", list });
    expect(list.pointers).toEqual([]);
    expect(() => recordRecentOpen(undefined, null, null, null)).not.toThrow();
    expect(() => dismissRecentPointer(list, "", "book_aaaaaa", trackingWriter())).not.toThrow();
  });
});
