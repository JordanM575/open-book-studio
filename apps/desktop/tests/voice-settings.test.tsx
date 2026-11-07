/// <reference types="bun" />
import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from "bun:test";
import React from "react";
import { DEFAULT_VOICE_PREFERENCES, type VoicePreferences } from "@ai-book-studio/core/providers/voice-preferences";
import type { ConnectionSummary } from "@ai-book-studio/core/providers/types";
import { ttsModels } from "@ai-book-studio/core/providers/tts";
import { mountDom, unmountDom } from "./support/dom";

let testing!: typeof import("@testing-library/react/pure");
let SettingsDialog!: typeof import("@ai-book-studio/app/components/SettingsDialog").SettingsDialog;
let AmbientPanel!: typeof import("@ai-book-studio/app/components/AmbientPanel").AmbientPanel;
let VoiceButton!: typeof import("@ai-book-studio/app/components/VoiceButton").VoiceButton;

beforeAll(async () => {
  testing = await mountDom();
  ({ SettingsDialog } = await import("@ai-book-studio/app/components/SettingsDialog"));
  ({ AmbientPanel } = await import("@ai-book-studio/app/components/AmbientPanel"));
  ({ VoiceButton } = await import("@ai-book-studio/app/components/VoiceButton"));
});

afterAll(async () => {
  await unmountDom();
});

afterEach(() => testing.cleanup());

const CONNECTIONS: ConnectionSummary[] = [
  {
    id: "conn_openrouter01",
    provider: "openrouter",
    label: "OpenRouter account",
    kind: "api-key",
    createdAt: "2026-11-04T12:00:00.000Z"
  },
  {
    id: "conn_meta000001",
    provider: "meta",
    label: "Meta account",
    kind: "api-key",
    createdAt: "2026-11-04T12:00:00.000Z"
  }
];

function mockStudio(initial: VoicePreferences = DEFAULT_VOICE_PREFERENCES, beforeSave?: Promise<void>) {
  let saved = initial;
  const updateSettings = mock(async (preferences: VoicePreferences) => {
    if (beforeSave) await beforeSave;
    saved = preferences;
    return { ok: true as const, data: preferences };
  });
  const testConnection = mock(async () => ({ ok: true as const, data: { message: "Connected." } }));
  const loadModels = mock(async () => ({ ok: true as const, data: { models: [], fetchedAt: null } }));
  const voice = {
    connections: mock(async () => ({ ok: true as const, data: CONNECTIONS })),
    settings: mock(async () => ({ ok: true as const, data: saved })),
    updateSettings,
    speakers: mock(async () => {
      const connection = CONNECTIONS.find((entry) => entry.id === saved.speaking.connectionId);
      const available = connection !== undefined && ttsModels(connection.provider).some((choice) =>
        choice.id === saved.speaking.model && choice.voices.includes(saved.speaking.voice ?? "")
      );
      return { ok: true as const, data: {
        available,
        selected: Boolean(saved.speaking.connectionId),
        unavailable: Boolean(saved.speaking.connectionId) && !available,
        connectionId: saved.speaking.connectionId,
        connectionLabel: CONNECTIONS.find((entry) => entry.id === saved.speaking.connectionId)?.label ?? null,
        model: saved.speaking.model,
        voice: saved.speaking.voice,
        voices: []
      } };
    })
  };
  (globalThis as unknown as { window: { studio: unknown } }).window.studio = {
    platform: "darwin",
    providers: { list: mock(async () => ({ ok: true as const, data: [] })), models: loadModels },
    connections: {
      list: mock(async () => ({ ok: true as const, data: CONNECTIONS })),
      status: mock(async () => ({
        ok: true as const,
        data: { available: true, backend: "Synthetic keychain", detail: "", connections: CONNECTIONS.length }
      })),
      test: testConnection,
      check: mock(async () => ({ ok: true as const, data: { available: true, backend: "Synthetic", detail: "", connections: 2 } })),
      remove: mock(async () => ({ ok: true as const, data: null })),
      startOpenRouter: mock(async () => ({ ok: true as const, data: CONNECTIONS[0] })),
      cancelOpenRouter: mock(async () => ({ ok: true as const, data: null })),
      addKey: mock(async () => ({ ok: true as const, data: CONNECTIONS[0] }))
    },
    voice,
    library: { current: mock(async () => ({ ok: true as const, data: null })) },
    app: { info: mock(async () => ({ ok: false as const, error: { code: "internal", message: "No build metadata." } })) },
    sync: {
      settings: mock(async () => ({ ok: true as const, data: { checkIntervalMinutes: 15, lastScanAt: null } })),
      updateSettings: mock(async () => ({ ok: true as const, data: { checkIntervalMinutes: 15, lastScanAt: null } }))
    }
  };
  return { updateSettings, testConnection, loadModels, voice };
}

function renderSettings(onVoiceConfigurationChanged?: () => void) {
  const onNotice = mock((_error: unknown) => {});
  const rendered = testing.render(React.createElement(SettingsDialog, {
    open: true,
    onOpenChange: () => {},
    onNotice,
    onVoiceConfigurationChanged,
    theme: { choice: "system" as const, set: () => {} }
  }));
  return { rendered, onNotice };
}

function WorkspaceForVoiceSettings() {
  const [open, setOpen] = React.useState(true);
  const [revision, setRevision] = React.useState(0);
  return React.createElement(React.Fragment, null,
    React.createElement(AmbientPanel, {
      bookId: "book_test00001", chapterId: null, chapterTitle: "Chapter", chapterContent: "Words.",
      onNextChapter: () => {}, onNotice: () => {}, voiceStatusRevision: revision
    }),
    React.createElement(SettingsDialog, {
      open, onOpenChange: setOpen, onNotice: () => {}, theme: { choice: "system", set: () => {} },
      onVoiceConfigurationChanged: () => setRevision((current) => current + 1)
    })
  );
}

describe("voice provider choices in Settings", () => {
  test("editor dictation explains an empty choice and refreshes for an OpenRouter selection", async () => {
    const { voice } = mockStudio();
    const onError = mock((_error: Error) => {});
    const props = { onText: () => {}, onError, voiceStatusRevision: 0 };
    const view = testing.render(React.createElement(VoiceButton, props));
    const button = view.getByRole("button", { name: "Start dictation" }) as HTMLButtonElement;
    await testing.waitFor(() => expect(button.title).toContain("Choose a transcription connection"));
    expect(button.disabled).toBe(false);
    await testing.fireEvent.click(button);
    await testing.waitFor(() => expect(onError.mock.calls[0]?.[0].message).toContain("Choose a transcription connection"));

    await voice.updateSettings({
      ...DEFAULT_VOICE_PREFERENCES,
      transcription: { connectionId: "conn_openrouter01", model: "openai/whisper-1" }
    });
    view.rerender(React.createElement(VoiceButton, { ...props, voiceStatusRevision: 1 }));
    await testing.waitFor(() => expect(button.title).toBe("Start dictation"));
  });

  test("uses local model and voice catalogs and saves explicit selections without provider probes", async () => {
    const { updateSettings, testConnection, loadModels } = mockStudio();
    const changed = mock(() => {});
    renderSettings(changed);

    await testing.waitFor(() => expect(testing.within(document.body).getByTestId("voice-preferences")).toBeTruthy());

    const transcriptionConnection = testing.within(document.body).getByLabelText("Transcription connection") as HTMLSelectElement;
    await testing.fireEvent.change(transcriptionConnection, { target: { value: "conn_openrouter01" } });
    await testing.waitFor(() => expect(updateSettings).toHaveBeenCalled());
    const transcriptionModel = testing.within(document.body).getByLabelText("Transcription model") as HTMLSelectElement;
    expect(Array.from(transcriptionModel.options).map((option) => option.value)).toEqual([
      "", "openai/whisper-1", "openai/whisper-large-v3", "openai/whisper-large-v3-turbo"
    ]);
    await testing.fireEvent.change(transcriptionModel, { target: { value: "openai/whisper-large-v3-turbo" } });
    await testing.waitFor(() => expect(updateSettings).toHaveBeenCalledTimes(2));

    const speakingConnection = testing.within(document.body).getByLabelText("Speaking connection") as HTMLSelectElement;
    await testing.fireEvent.change(speakingConnection, { target: { value: "conn_openrouter01" } });
    await testing.waitFor(() => expect(updateSettings).toHaveBeenCalledTimes(3));
    const speakingModel = testing.within(document.body).getByLabelText("Speaking model") as HTMLSelectElement;
    await testing.fireEvent.change(speakingModel, { target: { value: "mistralai/voxtral-mini-tts-2603" } });
    await testing.waitFor(() => expect(updateSettings).toHaveBeenCalledTimes(4));
    const speakingVoice = testing.within(document.body).getByLabelText("Speaking voice") as HTMLSelectElement;
    expect(Array.from(speakingVoice.options).map((option) => option.value)).toContain("gb_jane_sarcasm");
    expect(Array.from(speakingVoice.options).map((option) => option.value)).not.toContain("nadine");
    await testing.fireEvent.change(speakingVoice, { target: { value: "gb_jane_sarcasm" } });
    await testing.waitFor(() => expect(updateSettings).toHaveBeenCalledTimes(5));
    expect(updateSettings).toHaveBeenLastCalledWith(expect.objectContaining({
      transcription: { connectionId: "conn_openrouter01", model: "openai/whisper-large-v3-turbo" },
      speaking: { connectionId: "conn_openrouter01", model: "mistralai/voxtral-mini-tts-2603", voice: "gb_jane_sarcasm" }
    }));
    expect(testConnection).not.toHaveBeenCalled();
    expect(loadModels).not.toHaveBeenCalled();
    expect(changed).toHaveBeenCalledTimes(5);
  });

  test("notifies the workspace only after a connection is removed", async () => {
    mockStudio();
    const changed = mock(() => {});
    renderSettings(changed);
    const body = testing.within(document.body);
    await testing.waitFor(() => expect(body.getByLabelText("Remove OpenRouter account")).toBeTruthy());
    await testing.fireEvent.click(body.getByLabelText("Remove OpenRouter account"));
    expect(changed).not.toHaveBeenCalled();
    await testing.fireEvent.click(body.getByTestId("connection-remove-confirm"));
    await testing.waitFor(() => expect(changed).toHaveBeenCalledTimes(1));
  });

  test("a save finishing after Settings closes refreshes the still-mounted ambient panel", async () => {
    let finishSave!: () => void;
    const beforeSave = new Promise<void>((resolve) => { finishSave = resolve; });
    const { updateSettings, voice } = mockStudio(DEFAULT_VOICE_PREFERENCES, beforeSave);
    const studio = (window as unknown as { studio: { agent: unknown } }).studio;
    studio.agent = {
      ambient: async () => ({ ok: true, data: { say: "Ready to write.", actions: [] } }),
      onEvent: () => () => {}
    };
    const view = testing.render(React.createElement(WorkspaceForVoiceSettings));
    await testing.fireEvent.click(view.getByTestId("ambient-toggle"));
    const body = testing.within(document.body);
    await testing.waitFor(() => expect(body.getByTestId("voice-preferences")).toBeTruthy());
    const previousMessage = "speechSynthesis" in window && "SpeechSynthesisUtterance" in window
      ? /Speaking with this computer/
      : /This device cannot speak/;
    await testing.waitFor(() => expect(view.getByText(previousMessage)).toBeTruthy());
    const readsBeforeSave = voice.speakers.mock.calls.length;

    await testing.fireEvent.change(body.getByLabelText("Speaking connection"), { target: { value: "conn_openrouter01" } });
    await testing.waitFor(() => expect(updateSettings).toHaveBeenCalledTimes(1));
    await testing.fireEvent.click(body.getByRole("button", { name: "Done" }));
    await testing.act(async () => { finishSave(); });

    await testing.waitFor(() => expect(voice.speakers.mock.calls.length).toBeGreaterThanOrEqual(readsBeforeSave + 2));
    await testing.waitFor(() => {
      expect(view.queryByText(previousMessage)).toBeNull();
      expect(view.queryByText(/Checking speaking settings/)).toBeNull();
      expect(view.queryByText(/Speaking settings could not be read/)).toBeNull();
    });
  });

  test("shows two removed connections and lets each be cleared without silently changing the other", async () => {
    const stale: VoicePreferences = {
      transcription: { connectionId: "conn_removed01", model: "openai/whisper-1" },
      speaking: { connectionId: "conn_removed02", model: "heygen/heygen-voice-1", voice: "nadine" }
    };
    const { updateSettings, testConnection, loadModels } = mockStudio(stale);
    const { onNotice } = renderSettings();
    const body = testing.within(document.body);
    await testing.waitFor(() => expect(body.getByTestId("voice-preferences")).toBeTruthy());
    expect(body.getByTestId("voice-status").textContent).toContain("selected speaking connection is unavailable");
    expect(body.getByTestId("voice-status").textContent).toContain("selected transcription connection is unavailable");

    const transcription = body.getByLabelText("Transcription connection") as HTMLSelectElement;
    const speaking = body.getByLabelText("Speaking connection") as HTMLSelectElement;
    expect(transcription.value).toBe("conn_removed01");
    expect(speaking.value).toBe("conn_removed02");
    expect(transcription.selectedOptions[0]?.textContent).toBe("Saved connection unavailable");
    expect(speaking.selectedOptions[0]?.textContent).toBe("Saved connection unavailable");

    await testing.fireEvent.change(transcription, { target: { value: "" } });
    await testing.waitFor(() => expect(transcription.value).toBe(""));
    expect(updateSettings).toHaveBeenLastCalledWith({ ...stale, transcription: DEFAULT_VOICE_PREFERENCES.transcription });
    expect(speaking.value).toBe("conn_removed02");
    await testing.waitFor(() => expect(speaking.disabled).toBe(false));
    await testing.fireEvent.change(speaking, { target: { value: "" } });
    await testing.waitFor(() => expect(speaking.value).toBe(""));
    expect(updateSettings).toHaveBeenLastCalledWith(DEFAULT_VOICE_PREFERENCES);
    expect(onNotice).not.toHaveBeenCalled();
    expect(testConnection).not.toHaveBeenCalled();
    expect(loadModels).not.toHaveBeenCalled();
  });

  test("shows a retired saved voice instead of presenting it as an empty choice", async () => {
    const retired: VoicePreferences = {
      ...DEFAULT_VOICE_PREFERENCES,
      speaking: { connectionId: "conn_openrouter01", model: "heygen/heygen-voice-1", voice: "retired-voice" }
    };
    const { updateSettings } = mockStudio(retired);
    renderSettings();
    const body = testing.within(document.body);
    await testing.waitFor(() => expect(body.getByTestId("voice-preferences")).toBeTruthy());
    const voice = body.getByLabelText("Speaking voice") as HTMLSelectElement;
    expect(voice.value).toBe("retired-voice");
    expect(voice.selectedOptions[0]?.textContent).toBe("Saved voice unavailable");
    expect(body.getByTestId("voice-status").textContent).toContain("selected speaking connection is unavailable");
    await testing.fireEvent.change(voice, { target: { value: "weston" } });
    await testing.waitFor(() => expect(updateSettings).toHaveBeenCalledWith({
      ...retired, speaking: { ...retired.speaking, voice: "weston" }
    }));
  });

  test("shows a retired model and its voice while allowing a supported replacement", async () => {
    const retired: VoicePreferences = {
      ...DEFAULT_VOICE_PREFERENCES,
      speaking: { connectionId: "conn_openrouter01", model: "retired/speaking", voice: "retired-voice" }
    };
    const { updateSettings } = mockStudio(retired);
    renderSettings();
    const body = testing.within(document.body);
    await testing.waitFor(() => expect(body.getByTestId("voice-preferences")).toBeTruthy());
    const model = body.getByLabelText("Speaking model") as HTMLSelectElement;
    const voice = body.getByLabelText("Speaking voice") as HTMLSelectElement;
    expect(model.selectedOptions[0]?.textContent).toBe("Saved model unavailable");
    expect(voice.selectedOptions[0]?.textContent).toBe("Saved voice unavailable");
    expect(voice.disabled).toBe(true);
    await testing.fireEvent.change(model, { target: { value: "heygen/heygen-voice-1" } });
    await testing.waitFor(() => expect(updateSettings).toHaveBeenCalledWith(expect.objectContaining({
      speaking: expect.objectContaining({ connectionId: "conn_openrouter01", model: "heygen/heygen-voice-1" })
    })));
  });
});
