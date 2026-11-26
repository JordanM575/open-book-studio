import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { headlessDesktopEnvironment, headlessEnvironment, mockKeychainArgs } from "../../../scripts/headless-environment.mjs";

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

test("desktop checks set the owned profile and refuse protected storage despite conflicting shell flags", () => {
  const profile = resolve("synthetic-profile");
  expect(headlessDesktopEnvironment({
    PATH: "/synthetic/bin",
    STUDIO_TEST_MEMORY_VAULT: "1",
    STUDIO_NO_KEYCHAIN: "0",
    STUDIO_USER_DATA: "/unrelated-profile",
    STUDIO_VISIBLE: "1",
    ELECTRON_RUN_AS_NODE: "1"
  }, profile)).toEqual({
    PATH: "/synthetic/bin",
    STUDIO_TEST: "1",
    STUDIO_HEADLESS: "1",
    STUDIO_USER_DATA: profile,
    STUDIO_NO_KEYCHAIN: "1"
  });
  expect(() => headlessDesktopEnvironment({}, "")).toThrow("absolute fixture profile");
  expect(() => headlessDesktopEnvironment({}, "relative-profile")).toThrow("absolute fixture profile");
});

test("the synthetic provider check explicitly chooses the memory vault", () => {
  const profile = resolve("synthetic-profile");
  expect(headlessDesktopEnvironment({ STUDIO_NO_KEYCHAIN: "1" }, profile, "memory")).toEqual({
    STUDIO_TEST: "1",
    STUDIO_HEADLESS: "1",
    STUDIO_USER_DATA: profile,
    STUDIO_TEST_MEMORY_VAULT: "1"
  });
});

test("only the macOS launch requests the Chromium mock keychain", () => {
  expect(mockKeychainArgs("darwin")).toEqual(["--use-mock-keychain"]);
  expect(mockKeychainArgs("linux")).toEqual([]);
  expect(mockKeychainArgs("win32")).toEqual([]);
});
