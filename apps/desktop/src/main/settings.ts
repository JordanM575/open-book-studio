import { app } from "electron";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { DEFAULT_VOICE_PREFERENCES, isValidStoredVoicePreferences, isValidVoicePreferencesTransition, type VoicePreferences } from "@ai-book-studio/core/providers/voice-preferences";
import { ProviderError } from "@ai-book-studio/core/providers/types";
import { writeFileAtomic } from "./library/atomic";

export interface AppSettings {
  libraryRoot: string | null;
  windowBounds?: { width: number; height: number; x?: number; y?: number };
  /**
   * The folder of TypeScript tools the author points the app at (D-150).
   *
   * It is a library-level setting, not a book setting, because it points at code on the author's
   * disk: a book that travels to another machine never carries the path with it.
   */
  pluginFolder?: string | null;
  /**
   * Minutes between drift scans when the window regains focus. The scan itself is read-only;
   * raising this only spaces the reminders out.
   */
  syncCheckIntervalMinutes?: number;
  /** When the drift scan last ran, as an ISO timestamp. Display only. */
  lastSyncScanAt?: string | null;
  /** Machine-local speech choices; never copied into a library. */
  voicePreferences?: VoicePreferences;
}

/** The focus-scan interval when nothing is configured. */
export const DEFAULT_SYNC_CHECK_INTERVAL_MINUTES = 15;

const DEFAULTS: AppSettings = { libraryRoot: null };

/**
 * The profile file lives directly under Electron's per-app userData directory,
 * which carries the app name but no version. Two compatible builds therefore
 * share one settings file; local install/upgrade never relocates it.
 */
export function settingsFilePath(userDataDir: string): string {
  return join(userDataDir, "studio.json");
}

export class SettingsStore {
  private readonly path = settingsFilePath(app.getPath("userData"));
  private value: AppSettings = { ...DEFAULTS };
  private pendingWrite: Promise<void> = Promise.resolve();

  /** @internal The writer can be replaced for deterministic persistence-failure tests. */
  constructor(private readonly write: typeof writeFileAtomic = writeFileAtomic) {}

  async load(): Promise<AppSettings> {
    try {
      const parsed = JSON.parse(await readFile(this.path, "utf8")) as Partial<AppSettings>;
      this.value = {
        libraryRoot: typeof parsed.libraryRoot === "string" ? parsed.libraryRoot : null,
        ...(parsed.windowBounds ? { windowBounds: parsed.windowBounds } : {}),
        ...(typeof parsed.pluginFolder === "string" ? { pluginFolder: parsed.pluginFolder } : {}),
        ...(typeof parsed.syncCheckIntervalMinutes === "number" &&
        Number.isFinite(parsed.syncCheckIntervalMinutes)
          ? { syncCheckIntervalMinutes: parsed.syncCheckIntervalMinutes }
          : {}),
        ...(typeof parsed.lastSyncScanAt === "string" ? { lastSyncScanAt: parsed.lastSyncScanAt } : {}),
        ...(isValidStoredVoicePreferences(parsed.voicePreferences) ? { voicePreferences: parsed.voicePreferences } : {})
      };
    } catch {
      this.value = { ...DEFAULTS };
    }
    return this.value;
  }

  get(): AppSettings {
    return this.value;
  }

  async update(patch: Partial<AppSettings>): Promise<void> {
    // Compute from the last successful write, not the value at invocation: resize, sync and
    // voice settings can all save concurrently. A failed write must not poison the queue.
    const write = this.pendingWrite.then(async () => {
      if (patch.voicePreferences !== undefined &&
          !isValidVoicePreferencesTransition(patch.voicePreferences, this.voicePreferences())) {
        throw new ProviderError("invalid-request", "Choose a supported speech model and voice in Settings.");
      }
      const next = { ...this.value, ...patch };
      await this.write(this.path, `${JSON.stringify(next, null, 2)}\n`);
      this.value = next;
    });
    this.pendingWrite = write.catch(() => {});
    await write;
  }

  voicePreferences(): VoicePreferences {
    return this.value.voicePreferences ?? DEFAULT_VOICE_PREFERENCES;
  }
}
