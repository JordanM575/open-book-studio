import { z } from "zod";
import { connectionIdSchema } from "./types";
import { speechModels } from "./speech";
import { ttsModels } from "./tts";

/** A complete transcription choice bound to one recording. */
export interface TranscriptionSelection {
  connectionId: string;
  model: string;
}

export interface VoicePreferences {
  transcription: { connectionId: string | null; model: string | null };
  speaking: { connectionId: string | null; model: string | null; voice: string | null };
}

export const DEFAULT_VOICE_PREFERENCES: VoicePreferences = {
  transcription: { connectionId: null, model: null },
  speaking: { connectionId: null, model: null, voice: null }
};

export const voicePreferencesSchema = z.object({
  transcription: z.object({
    connectionId: connectionIdSchema.nullable(),
    model: z.string().min(1).max(200).nullable()
  }).strict(),
  speaking: z.object({
    connectionId: connectionIdSchema.nullable(),
    model: z.string().min(1).max(200).nullable(),
    voice: z.string().min(1).max(80).nullable()
  }).strict()
}).strict();

/** Validate saved structure without discarding a choice retired from the current catalog. */
export function isValidStoredVoicePreferences(value: unknown): value is VoicePreferences {
  const parsed = voicePreferencesSchema.safeParse(value);
  if (!parsed.success) return false;
  const preferences = parsed.data;
  const transcriptionValid = preferences.transcription.connectionId === null
    ? preferences.transcription.model === null
    : preferences.transcription.model !== null;
  const speakingValid = preferences.speaking.connectionId === null
    ? preferences.speaking.model === null && preferences.speaking.voice === null
    : preferences.speaking.model !== null && preferences.speaking.voice !== null;
  return transcriptionValid && speakingValid;
}

/** A retired choice can survive unchanged, but a changed choice must exist in a local catalog. */
export function isValidVoicePreferencesTransition(next: VoicePreferences, previous: VoicePreferences): boolean {
  if (!isValidStoredVoicePreferences(next)) return false;
  const transcriptionUnchanged = next.transcription.connectionId === previous.transcription.connectionId &&
    next.transcription.model === previous.transcription.model;
  const speakingUnchanged = next.speaking.connectionId === previous.speaking.connectionId &&
    next.speaking.model === previous.speaking.model && next.speaking.voice === previous.speaking.voice;
  return (transcriptionUnchanged || next.transcription.model === null || speechModelKnown(next.transcription.model)) &&
    (speakingUnchanged || next.speaking.model === null ||
      (next.speaking.voice !== null && speakingChoiceKnown(next.speaking.model, next.speaking.voice)));
}

export function speechModelKnown(model: string): boolean {
  return ["meta", "openrouter"].some((provider) =>
    speechModels(provider as "meta" | "openrouter").some((choice) => choice.id === model)
  );
}

export function speakingChoiceKnown(model: string, voice: string): boolean {
  return ["openai", "openrouter"].some((provider) =>
    ttsModels(provider as "openai" | "openrouter").some((choice) => choice.id === model && choice.voices.includes(voice))
  );
}
