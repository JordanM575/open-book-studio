import { describe, expect, test } from "bun:test";
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
