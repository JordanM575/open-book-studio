import { describe, expect, test } from "bun:test";
import {
  DEFAULT_VOICE_PREFERENCES,
  isValidVoicePreferencesTransition,
  speakingChoiceKnown,
  type VoicePreferences
} from "../src/providers/voice-preferences";

/*
 * A speaking choice is a model and a voice together. The saved profile accepts a changed choice only
 * when the local catalog offers that pair, so a voice a model does not support never gets saved.
 */

function speaking(model: string, voice: string): VoicePreferences {
  return {
    ...DEFAULT_VOICE_PREFERENCES,
    speaking: { connectionId: "conn_openai000001", model, voice }
  };
}

describe("a speaking choice", () => {
  test("pairs a model only with the voices it supports", () => {
    expect(speakingChoiceKnown("gpt-4o-mini-tts", "ballad")).toBe(true);
    expect(speakingChoiceKnown("gpt-4o-mini-tts", "verse")).toBe(true);
    expect(speakingChoiceKnown("tts-1", "nova")).toBe(true);
    expect(speakingChoiceKnown("tts-1-hd", "shimmer")).toBe(true);
    // The older models have a smaller set, so these pairs are not offered.
    expect(speakingChoiceKnown("tts-1", "ballad")).toBe(false);
    expect(speakingChoiceKnown("tts-1", "verse")).toBe(false);
    expect(speakingChoiceKnown("tts-1-hd", "ballad")).toBe(false);
    expect(speakingChoiceKnown("tts-1-hd", "verse")).toBe(false);
  });

  test("is refused when saved with a voice its model does not support, and accepted with one it does", () => {
    const start = speaking("gpt-4o-mini-tts", "ballad");

    expect(isValidVoicePreferencesTransition(speaking("tts-1", "ballad"), start)).toBe(false);
    expect(isValidVoicePreferencesTransition(speaking("tts-1-hd", "verse"), start)).toBe(false);
    expect(isValidVoicePreferencesTransition(speaking("tts-1", "nova"), start)).toBe(true);
    expect(isValidVoicePreferencesTransition(speaking("gpt-4o-mini-tts", "verse"), start)).toBe(true);
  });
});
