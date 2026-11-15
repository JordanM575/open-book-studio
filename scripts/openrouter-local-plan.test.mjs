import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { writeLocalPassFixture } from "./openrouter-local-fixture.mjs";
import { DEFAULT_OPENROUTER_MODEL, planOpenRouterLocalPass } from "./openrouter-local-plan.mjs";

const KEY = "sk-or-local-pass-fixture";

describe("the OpenRouter local pass plan", () => {
  test("skips unless the flag and a key are both present", () => {
    expect(planOpenRouterLocalPass({}).action).toBe("skip");
    expect(planOpenRouterLocalPass({ flag: "1" }).action).toBe("skip");
    expect(planOpenRouterLocalPass({ apiKey: KEY }).action).toBe("skip");
    expect(planOpenRouterLocalPass({ flag: "true", apiKey: KEY }).action).toBe("skip");
    expect(planOpenRouterLocalPass({ flag: " 1 ", apiKey: `  ${KEY}  ` })).toEqual({
      action: "run",
      model: DEFAULT_OPENROUTER_MODEL
    });
  });

  test("refuses a short key or a model id the studio would not store, before any call", () => {
    expect(planOpenRouterLocalPass({ flag: "1", apiKey: "short" }).action).toBe("fail");
    expect(planOpenRouterLocalPass({ flag: "1", apiKey: KEY, model: "../secret" }).action).toBe("fail");
    expect(planOpenRouterLocalPass({ flag: "1", apiKey: KEY, model: "vendor/model name" }).action).toBe("fail");
  });

  test("uses the named model when it is a real model id", () => {
    expect(planOpenRouterLocalPass({ flag: "1", apiKey: KEY, model: " anthropic/claude-3.5-haiku " })).toEqual({
      action: "run",
      model: "anthropic/claude-3.5-haiku"
    });
  });
});

describe("the OpenRouter local pass fixture", () => {
  test("creates the profile directory before writing studio.json", async () => {
    const temp = await mkdtemp(join(tmpdir(), "studio-openrouter-local-fixture-"));
    try {
      const layout = await writeLocalPassFixture(temp);
      const settings = JSON.parse(await readFile(join(layout.profile, "studio.json"), "utf8"));
      expect(settings.libraryRoot).toBe(layout.libraryRoot);
      const book = JSON.parse(await readFile(join(layout.bookDir, "book.json"), "utf8"));
      expect(book.id).toBe("book_localpass01");
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  });
});
