/// <reference types="bun" />
import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from "bun:test";
import React from "react";
import { mountDom, unmountDom } from "./support/dom";
import type { VoicePreferences } from "@ai-book-studio/core/providers/voice-preferences";

let testing!: typeof import("@testing-library/react/pure");
// Loaded in beforeAll, once the DOM exists.
let SettingsDialog!: typeof import("@ai-book-studio/app/components/SettingsDialog").SettingsDialog;

beforeAll(async () => {
  testing = await mountDom();
  // The dialog reaches react-dom through Radix, and react-dom checks for a DOM the first time it loads.
  // So the component loads here, after the DOM exists, and not at module scope.
  ({ SettingsDialog } = await import("@ai-book-studio/app/components/SettingsDialog"));
});
afterAll(async () => {
  await unmountDom();
});

afterEach(() => testing.cleanup());

const NOW = "2026-11-03T12:00:00.000Z";
const FAKE_KEY = "sk-test-FAKE-SECRET-1234567890";
const CONN = {
  id: "conn_test000001",
  provider: "openrouter",
  label: "Test key",
  kind: "api-key",
  createdAt: NOW
};

function mockStudio(overrides?: {
  test?: (id: string) => Promise<unknown>;
  speakersAvailable?: boolean;
  transcribeCount?: number;
}) {
  const test = mock((id: string) =>
    overrides?.test
      ? overrides.test(id)
      : Promise.resolve({ ok: true, data: { message: "Test provider accepted this connection." } })
  );
  (globalThis as unknown as { window: { studio: unknown } }).window.studio = {
    platform: "darwin",
    providers: { list: mock(async () => ({ ok: true, data: [] })) },
    connections: {
      list: mock(async () => ({ ok: true, data: [CONN] })),
      status: mock(async () => ({
        ok: true,
        data: { available: true, backend: "Synthetic keychain", detail: "", connections: 1 }
      })),
      test
    },
    library: { current: mock(async () => ({ ok: true, data: null })) },
    app: { info: mock(async () => ({ ok: false, error: { code: "internal", message: "Synthetic." } })) },
    voice: {
      connections: mock(async () => ({
        ok: true,
        data: overrides?.transcribeCount ? [CONN] : []
      })),
      speakers: mock(async () => ({
        ok: true,
        data: {
          available: overrides?.speakersAvailable ?? false,
          selected: overrides?.speakersAvailable ?? false,
          unavailable: false,
          connectionId: overrides?.speakersAvailable ? CONN.id : null,
          connectionLabel: overrides?.speakersAvailable ? "Test key" : null,
          model: overrides?.speakersAvailable ? "heygen/heygen-voice-1" : null,
          voice: overrides?.speakersAvailable ? "nadine" : null,
          voices: []
        }
      })),
      settings: mock(async () => {
        const preferences: VoicePreferences = {
          transcription: overrides?.transcribeCount
            ? { connectionId: CONN.id, model: "openai/whisper-1" }
            : { connectionId: null, model: null },
          speaking: overrides?.speakersAvailable
            ? { connectionId: CONN.id, model: "heygen/heygen-voice-1", voice: "nadine" }
            : { connectionId: null, model: null, voice: null }
        };
        return { ok: true, data: preferences };
      }),
      updateSettings: mock(async (preferences: VoicePreferences) => ({ ok: true, data: preferences }))
    }
  };
  return { test };
}

function renderSettings() {
  const onNotice = mock((_error: unknown) => {});
  const rendered = testing.render(
    React.createElement(SettingsDialog, {
      open: true,
      onOpenChange: () => {},
      onNotice,
      theme: { choice: "light" as const, set: () => {} }
    })
  );
  return { onNotice, rendered };
}

async function openTestButton(): Promise<void> {
  await testing.waitFor(
    () => expect(testing.within(document.body).getByRole("button", { name: "Test" })).toBeTruthy(),
    { timeout: 2000 }
  );
}

describe("provider and voice status in Settings", () => {
  test("the keychain check control is named as the timeout detail names it", async () => {
    mockStudio();
    renderSettings();

    await testing.waitFor(
      () => expect(testing.within(document.body).getByTestId("check-keychain")).toBeTruthy(),
      { timeout: 2000 }
    );
    // The vault's timeout detail says "Choose Check keychain to try again."
    expect(testing.within(document.body).getByTestId("check-keychain").textContent).toContain("Check keychain");
  });

  test("an untested connection reads as saved, with no check time and no warning", async () => {
    mockStudio();
    renderSettings();

    await testing.waitFor(
      () => expect(testing.within(document.body).getByTestId("connection-status")).toBeTruthy(),
      { timeout: 2000 }
    );
    const status = testing.within(document.body).getByTestId("connection-status").textContent ?? "";
    expect(status).toContain("Saved");
    expect(status).not.toContain("Unavailable");
    expect(status).toContain("not checked yet");
  });

  test("a successful Test shows Connected with the volatile check time", async () => {
    const { test } = mockStudio();
    const { rendered } = renderSettings();

    await openTestButton();
    testing.fireEvent.click(testing.within(document.body).getByRole("button", { name: "Test" }));
    expect(test).toHaveBeenCalledTimes(1);
    await testing.waitFor(
      () =>
        expect(testing.within(document.body).getByTestId("connection-status").textContent ?? "").toContain(
          "Connected"
        ),
      { timeout: 2000 }
    );
    expect(testing.within(document.body).getByTestId("connection-status").textContent ?? "").toContain("checked");

    // Reopening Settings forgets the volatile check: no stored health fact survives.
    rendered.rerender(
      React.createElement(SettingsDialog, {
        open: false,
        onOpenChange: () => {},
        onNotice: () => {},
        theme: { choice: "light" as const, set: () => {} }
      })
    );
    rendered.rerender(
      React.createElement(SettingsDialog, {
        open: true,
        onOpenChange: () => {},
        onNotice: () => {},
        theme: { choice: "light" as const, set: () => {} }
      })
    );
    await testing.waitFor(
      () => expect(testing.within(document.body).getByTestId("connection-status")).toBeTruthy(),
      { timeout: 2000 }
    );
    expect(testing.within(document.body).getByTestId("connection-status").textContent ?? "").toContain(
      "not checked yet"
    );
    // Let bridge promises and dialog focus timers settle before teardown unmounts the DOM.
    await testing.act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 100));
    });
  });

  test("a rejected key shows Key rejected without printing the secret", async () => {
    mockStudio({
      test: async () => ({
        ok: false,
        error: { code: "auth", message: `The key ${FAKE_KEY} was rejected. Check the key and try again.` }
      })
    });
    renderSettings();

    await openTestButton();
    testing.fireEvent.click(testing.within(document.body).getByRole("button", { name: "Test" }));
    await testing.waitFor(
      () =>
        expect(testing.within(document.body).getByTestId("connection-status").textContent ?? "").toContain(
          "Key rejected"
        ),
      { timeout: 2000 }
    );
    expect(document.body.textContent ?? "").not.toContain(FAKE_KEY);
  });

  test("voice shows configured availability with no check time", async () => {
    mockStudio({ speakersAvailable: true, transcribeCount: 1 });
    renderSettings();

    await testing.waitFor(
      () => expect(testing.within(document.body).getByTestId("voice-status")).toBeTruthy(),
      { timeout: 2000 }
    );
    const voice = testing.within(document.body).getByTestId("voice-status").textContent ?? "";
    expect(voice).toContain("Read-aloud is available");
    expect(voice).toContain("Dictation is set to Test key.");
    expect(voice).toContain("never tested automatically");
    expect(voice).not.toContain("checked");
    // Let bridge promises and dialog focus timers settle before teardown unmounts the DOM.
    await testing.act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 100));
    });
  });

  test("voice without connections says it is not set up", async () => {
    mockStudio();
    renderSettings();

    await testing.waitFor(
      () => expect(testing.within(document.body).getByTestId("voice-status")).toBeTruthy(),
      { timeout: 2000 }
    );
    const voice = testing.within(document.body).getByTestId("voice-status").textContent ?? "";
    expect(voice).toContain("Read-aloud is not set up");
    expect(voice).toContain("Dictation is not set up");
    // Let bridge promises and dialog focus timers settle before teardown unmounts the DOM.
    await testing.act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 100));
    });
  });
});
