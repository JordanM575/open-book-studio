import { expect, test } from "bun:test";
import { headlessEnvironment } from "../../../scripts/headless-environment.mjs";

test("a hidden check keeps the host fields it needs to start and nothing from the caller's shell", () => {
  const source = {
    PATH: "/synthetic/bin",
    HOME: "/synthetic/home",
    TMPDIR: "/synthetic/temp",
    DISPLAY: ":99",
    XAUTHORITY: "/synthetic/xauth",
    OPENAI_API_KEY: "SYNTHETIC",
    OPENROUTER_API_KEY: "SYNTHETIC",
    NODE_OPTIONS: "--require /synthetic/inject.js",
    ELECTRON_RUN_AS_NODE: "1",
    HTTPS_PROXY: "http://synthetic.invalid",
    STUDIO_TEST: "1",
    STUDIO_USER_DATA: "/not-the-fixture"
  };
  const before = { ...source };

  expect(headlessEnvironment(source)).toEqual({
    PATH: "/synthetic/bin",
    HOME: "/synthetic/home",
    TMPDIR: "/synthetic/temp",
    DISPLAY: ":99",
    XAUTHORITY: "/synthetic/xauth"
  });
  expect(source).toEqual(before);
});

test("a field the caller does not have is left out, not set to undefined", () => {
  expect(headlessEnvironment({ PATH: "/synthetic/bin", HOME: undefined })).toEqual({ PATH: "/synthetic/bin" });
});
