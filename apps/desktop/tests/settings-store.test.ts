import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_VOICE_PREFERENCES, type VoicePreferences } from "@ai-book-studio/core/providers/voice-preferences";
import { createAtomicWriter } from "../src/main/library/atomic";
import { mockElectron } from "./support/mock-electron";

/*
 * `studio.json` in the profile: the library pointer, the window, the plugin folder and the drift
 * scan. The file is the author's to edit or damage, so loading keeps only well-formed values.
 */

const cleanups: string[] = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

afterAll(() => {
  mockElectron(tmpdir());
});

async function store(existingUserData?: string, writer?: ReturnType<typeof createAtomicWriter>) {
  const userData = existingUserData ?? await mkdtemp(join(tmpdir(), "abs-settings-"));
  if (!existingUserData) cleanups.push(userData);
  mockElectron(userData);
  const { SettingsStore } = await import("../src/main/settings");
  return { userData, settings: new SettingsStore(writer) };
}

describe("settings store", () => {
  test("loads every setting the file holds", async () => {
    const { userData, settings } = await store();
    const saved = {
      libraryRoot: "/Users/author/Books",
      windowBounds: { width: 1440, height: 900, x: 10, y: 20 },
      pluginFolder: "/Users/author/Plugins",
      syncCheckIntervalMinutes: 30,
      lastSyncScanAt: "2026-11-03T12:00:00.000Z"
    };
    await writeFile(join(userData, "studio.json"), JSON.stringify(saved));
    expect(await settings.load()).toEqual(saved);
    expect(settings.get()).toEqual(saved);
  });

  test("drops values of the wrong type instead of trusting them", async () => {
    const { userData, settings } = await store();
    await writeFile(
      join(userData, "studio.json"),
      JSON.stringify({
        libraryRoot: 42,
        pluginFolder: ["not", "a", "path"],
        syncCheckIntervalMinutes: "15",
        lastSyncScanAt: null,
        unknown: "ignored"
      })
    );
    expect(await settings.load()).toEqual({ libraryRoot: null });
  });

  test("a damaged file reads as the defaults", async () => {
    const { userData, settings } = await store();
    await writeFile(join(userData, "studio.json"), "{ not json");
    expect(await settings.load()).toEqual({ libraryRoot: null });
  });

  test("an update keeps the other settings and lands in the file", async () => {
    const { userData, settings } = await store();
    await settings.update({ libraryRoot: "/Users/author/Books" });
    await settings.update({ syncCheckIntervalMinutes: 60 });
    expect(settings.get()).toEqual({ libraryRoot: "/Users/author/Books", syncCheckIntervalMinutes: 60 });
    expect(JSON.parse(await readFile(join(userData, "studio.json"), "utf8"))).toEqual({
      libraryRoot: "/Users/author/Books",
      syncCheckIntervalMinutes: 60
    });
  });

  test("overlapping updates preserve unrelated settings and apply same-field updates in order", async () => {
    const { userData, settings } = await store();
    const voicePreferences: VoicePreferences = {
      transcription: { connectionId: "conn_openrouter01", model: "openai/whisper-large-v3" },
      speaking: { connectionId: "conn_openrouter01", model: "heygen/heygen-voice-1", voice: "weston" }
    };
    await Promise.all([
      settings.update({ libraryRoot: "/Users/author/Books" }),
      settings.update({ voicePreferences }),
      settings.update({ syncCheckIntervalMinutes: 30 }),
      settings.update({ syncCheckIntervalMinutes: 60 })
    ]);
    const expected = { libraryRoot: "/Users/author/Books", voicePreferences, syncCheckIntervalMinutes: 60 };
    expect(settings.get()).toEqual(expected);
    expect(JSON.parse(await readFile(join(userData, "studio.json"), "utf8"))).toEqual(expected);
  });

  test("voice preferences round-trip in the local profile", async () => {
    const { userData, settings } = await store();
    const voicePreferences: VoicePreferences = {
      transcription: { connectionId: "conn_openrouter01", model: "openai/whisper-large-v3" },
      speaking: { connectionId: "conn_openrouter01", model: "heygen/heygen-voice-1", voice: "nadine" }
    };
    await settings.update({ voicePreferences });
    expect(settings.voicePreferences()).toEqual(voicePreferences);

    const { settings: reloaded } = await store(userData);
    expect(await reloaded.load()).toMatchObject({ voicePreferences });
    expect(JSON.parse(await readFile(join(userData, "studio.json"), "utf8"))).toMatchObject({ voicePreferences });
  });

  test("drops only malformed voice preferences and keeps unrelated profile values", async () => {
    const { userData, settings } = await store();
    await writeFile(join(userData, "studio.json"), JSON.stringify({
      libraryRoot: "/Users/author/Books",
      syncCheckIntervalMinutes: 45,
      voicePreferences: {
        transcription: { connectionId: "conn_openrouter01", model: null },
        speaking: { connectionId: null, model: null, voice: null }
      }
    }));
    expect(await settings.load()).toEqual({ libraryRoot: "/Users/author/Books", syncCheckIntervalMinutes: 45 });
    expect(settings.voicePreferences()).toEqual(DEFAULT_VOICE_PREFERENCES);
  });

  test("preserves structurally valid choices that have disappeared from the catalog", async () => {
    const { userData, settings } = await store();
    const unavailable: VoicePreferences = {
      transcription: { connectionId: "conn_openrouter01", model: "retired/transcription" },
      speaking: { connectionId: "conn_openrouter01", model: "retired/speaking", voice: "retired-voice" }
    };
    await writeFile(join(userData, "studio.json"), JSON.stringify({ libraryRoot: "/Users/author/Books", voicePreferences: unavailable }));
    expect(await settings.load()).toMatchObject({ voicePreferences: unavailable });
    const repaired = { ...unavailable, transcription: DEFAULT_VOICE_PREFERENCES.transcription };
    await settings.update({ voicePreferences: repaired });
    expect(settings.voicePreferences()).toEqual(repaired);
    const { settings: reloaded } = await store(userData);
    expect(await reloaded.load()).toMatchObject({ voicePreferences: repaired });
    await expect(settings.update({ voicePreferences: { ...repaired, speaking: { ...unavailable.speaking, voice: "another-retired-voice" } } }))
      .rejects.toThrow(/supported/i);
    expect(settings.voicePreferences()).toEqual(repaired);
  });

  test("overlapping profile writes validate retired choices against the latest successful write", async () => {
    const { userData, settings } = await store();
    const retired: VoicePreferences = {
      transcription: { connectionId: "conn_openrouter01", model: "retired/transcription" },
      speaking: { connectionId: "conn_openrouter01", model: "retired/speaking", voice: "retired-voice" }
    };
    await writeFile(join(userData, "studio.json"), JSON.stringify({ voicePreferences: retired }));
    await settings.load();
    const first = { ...retired, transcription: DEFAULT_VOICE_PREFERENCES.transcription };
    const second = { ...retired, speaking: DEFAULT_VOICE_PREFERENCES.speaking };
    const results = await Promise.allSettled([
      settings.update({ voicePreferences: first }),
      settings.update({ voicePreferences: second })
    ]);
    expect(results[0]?.status).toBe("fulfilled");
    expect(results[1]).toMatchObject({ status: "rejected", reason: { code: "invalid-request" } });
    expect(settings.voicePreferences()).toEqual(first);
    expect(JSON.parse(await readFile(join(userData, "studio.json"), "utf8"))).toMatchObject({ voicePreferences: first });
    await settings.update({ voicePreferences: DEFAULT_VOICE_PREFERENCES });
    expect(settings.voicePreferences()).toEqual(DEFAULT_VOICE_PREFERENCES);
  });

  test("a failed atomic voice write preserves the prior profile bytes and in-memory settings", async () => {
    const failure = Object.assign(new Error("Simulated disk full"), { code: "ENOSPC" });
    let failRename = false;
    let failedRenames = 0;
    const writer = createAtomicWriter({ rename: async (from, to) => {
      if (failRename) { failedRenames += 1; throw failure; }
      return rename(from, to);
    } });
    const { userData, settings } = await store(undefined, writer);
    const voicePreferences: VoicePreferences = {
      transcription: { connectionId: "conn_openrouter01", model: "openai/whisper-large-v3" },
      speaking: { connectionId: "conn_openrouter01", model: "heygen/heygen-voice-1", voice: "nadine" }
    };
    await settings.update({ libraryRoot: "/Users/author/Books", voicePreferences });
    const before = structuredClone(settings.get());
    const beforeBytes = await readFile(join(userData, "studio.json"));
    failRename = true;
    await expect(settings.update({ voicePreferences: {
      ...voicePreferences, speaking: { ...voicePreferences.speaking, voice: "weston" }
    } })).rejects.toBe(failure);
    expect(failedRenames).toBe(1);
    expect(settings.get()).toEqual(before);
    expect(settings.voicePreferences()).toEqual(voicePreferences);
    expect(await readFile(join(userData, "studio.json"))).toEqual(beforeBytes);
    failRename = false;
    await settings.update({ pluginFolder: "/Users/author/Plugins" });
    expect(settings.get()).toEqual({ ...before, pluginFolder: "/Users/author/Plugins" });
    expect(JSON.parse(await readFile(join(userData, "studio.json"), "utf8"))).toEqual(settings.get());
  });
});
