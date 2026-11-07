import { useCallback, useEffect, useRef, useState } from "react";
import { speechModels } from "@ai-book-studio/core/providers/speech";
import type { TranscriptionSelection } from "@ai-book-studio/core/providers/voice-preferences";
import { recordedBlobToWav } from "../lib/audio";

export type DictationState = "idle" | "requesting" | "recording" | "transcribing";

export interface DictationOptions {
  onText: (text: string) => void;
  onError: (error: Error) => void;
  /** Meta accepts at most ten minutes. */
  maxMs?: number;
}

const MAX_DICTATION_MS = 10 * 60 * 1000;
const MIME_CANDIDATES = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"];

/** Read local settings only; the main process still validates the selection before sending audio. */
export async function dictationReadiness(): Promise<
  | { available: true; reason: string; selection: TranscriptionSelection }
  | { available: false; reason: string }
> {
  const voice = window.studio?.voice;
  if (!voice) return { available: false, reason: "Voice dictation is available in the desktop app." };
  try {
    const settings = await voice.settings();
    if (!settings.ok) return { available: false, reason: settings.error.message };
    const selected = settings.data.transcription;
    if (!selected.connectionId || !selected.model) {
      return { available: false, reason: "Choose a transcription connection and model in Settings before using dictation." };
    }
    const connections = await voice.connections();
    if (!connections.ok) return { available: false, reason: connections.error.message };
    const connection = connections.data.find((entry) => entry.id === selected.connectionId);
    if (!connection || !speechModels(connection.provider).some((choice) => choice.id === selected.model)) {
      return { available: false, reason: "The selected transcription connection or model is unavailable. Choose another in Settings." };
    }
    return {
      available: true,
      reason: "Dictate using the selected transcription service.",
      selection: { connectionId: selected.connectionId, model: selected.model }
    };
  } catch {
    return { available: false, reason: "Voice settings could not be read. Try again." };
  }
}

/**
 * Microphone lifecycle for one dictation. It records, converts to the WAV Meta accepts and calls
 * the desktop transcription service. The hook never persists audio and stops every track on exit.
 */
export function useDictation({ onText, onError, maxMs = MAX_DICTATION_MS }: DictationOptions) {
  const [state, setState] = useState<DictationState>("idle");
  const [elapsedMs, setElapsedMs] = useState(0);
  const recorder = useRef<MediaRecorder | null>(null);
  const stream = useRef<MediaStream | null>(null);
  const startedAt = useRef(0);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  const mounted = useRef(true);
  const attempt = useRef(0);
  const starting = useRef(false);

  const clearTimer = useCallback(() => {
    if (timer.current) {
      clearInterval(timer.current);
      timer.current = null;
    }
  }, []);

  const release = useCallback(() => {
    stream.current?.getTracks().forEach((track) => {
      track.stop();
    });
    stream.current = null;
  }, []);

  const fail = useCallback(
    (message: string) => {
      if (!mounted.current) return;
      starting.current = false;
      setState("idle");
      setElapsedMs(0);
      onError(new Error(message));
    },
    [onError]
  );

  const stop = useCallback(() => {
    const active = recorder.current;
    if (!active || active.state === "inactive") return;
    active.stop();
  }, []);

  const cancel = useCallback(() => {
    attempt.current += 1;
    starting.current = false;
    clearTimer();
    const active = recorder.current;
    recorder.current = null;
    if (active && active.state !== "inactive") active.stop();
    release();
    if (mounted.current) {
      setState("idle");
      setElapsedMs(0);
    }
  }, [clearTimer, release]);

  const start = useCallback(async () => {
    if (state !== "idle" || starting.current) return;
    starting.current = true;
    const current = ++attempt.current;
    setState("requesting");
    const readiness = await dictationReadiness();
    if (current !== attempt.current || !mounted.current) return;
    if (!readiness.available) {
      starting.current = false;
      fail(readiness.reason);
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      starting.current = false;
      fail("This build cannot record audio. Voice dictation needs the desktop app.");
      return;
    }
    let media: MediaStream;
    try {
      media = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 }
      });
    } catch (error) {
      if (current !== attempt.current || !mounted.current) return;
      starting.current = false;
      const name = error instanceof Error ? error.name : "";
      fail(
        name === "NotAllowedError"
          ? "Microphone access was denied. Allow it in System Settings and try again."
          : "The microphone could not be opened. Check that it is connected and not in use."
      );
      return;
    }
    if (current !== attempt.current || !mounted.current) {
      media.getTracks().forEach((track) => {
        track.stop();
      });
      return;
    }
    stream.current = media;
    let active: MediaRecorder;
    try {
      const mimeType = MIME_CANDIDATES.find((type) => MediaRecorder.isTypeSupported(type));
      active = mimeType ? new MediaRecorder(media, { mimeType }) : new MediaRecorder(media);
    } catch {
      release();
      fail("The microphone could not start recording. Try again.");
      return;
    }
    const chunks: Blob[] = [];
    recorder.current = active;
    active.addEventListener("dataavailable", (event) => {
      if (current === attempt.current && event.data.size > 0) chunks.push(event.data);
    });
    active.addEventListener("stop", () => {
      // A cancelled recorder may deliver its stop event after a new recording has started.
      if (current !== attempt.current || !mounted.current) {
        chunks.length = 0;
        return;
      }
      clearTimer();
      release();
      recorder.current = null;
      const recorded = new Blob(chunks, { type: active.mimeType || "audio/webm" });
      chunks.length = 0;
      if (recorded.size === 0) {
        fail("The recording was empty. Try again and speak after the microphone starts.");
        return;
      }
      void (async () => {
        if (mounted.current) setState("transcribing");
        try {
          if (!window.studio.voice) {
            throw new Error("Voice dictation is available in the desktop app.");
          }
          const wav = await recordedBlobToWav(recorded);
          if (current !== attempt.current || !mounted.current) return;
          const result = await window.studio.voice.transcribe({
            audio: wav.buffer.slice(wav.byteOffset, wav.byteOffset + wav.byteLength) as ArrayBuffer,
            expectedSelection: readiness.selection
          });
          if (current !== attempt.current || !mounted.current) return;
          if (!result.ok) throw new Error(result.error.message);
          if (!result.data.text) {
            fail("No speech was detected. Try again a little closer to the microphone.");
            return;
          }
          starting.current = false;
          setState("idle");
          setElapsedMs(0);
          onText(result.data.text);
        } catch (error) {
          if (current !== attempt.current || !mounted.current) return;
          fail(error instanceof Error ? error.message : String(error));
        }
      })();
    });

    startedAt.current = Date.now();
    setElapsedMs(0);
    setState("recording");
    try {
      active.start(500);
    } catch {
      recorder.current = null;
      release();
      fail("The microphone could not start recording. Try again.");
      return;
    }
    timer.current = setInterval(() => {
      const elapsed = Date.now() - startedAt.current;
      if (mounted.current) setElapsedMs(elapsed);
      if (elapsed >= maxMs) stop();
    }, 250);
  }, [clearTimer, fail, maxMs, onText, release, state, stop]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      attempt.current += 1;
      starting.current = false;
      clearTimer();
      const active = recorder.current;
      recorder.current = null;
      if (active && active.state !== "inactive") active.stop();
      release();
    };
  }, [clearTimer, release]);

  return { state, elapsedMs, start, stop, cancel };
}
