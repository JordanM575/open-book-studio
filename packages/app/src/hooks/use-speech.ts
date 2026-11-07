import { useCallback, useEffect, useRef, useState } from "react";
import type { VoiceSpeakers } from "@ai-book-studio/core/ipc";
import { toSpeechText } from "@ai-book-studio/core/speech-text";

/**
 * Speaking.
 *
 * An explicitly selected speaking service receives the words. A removed selection or a failed
 * request never falls back to another voice. Only when no service is selected may the device's
 * own speech synthesis read them.
 *
 * Either way, what it says is also on the screen. Someone who cannot hear, or who is in a room
 * they do not want to talk in, must still get the words.
 */
export type VoiceSource = "tts" | "device" | "none";

export interface Speech {
  /** Whether this machine can speak at all. */
  supported: boolean;
  /** Which voice is in use. */
  using: VoiceSource;
  /** True while the voice is talking. Stays true while paused. */
  speaking: boolean;
  /** True while the voice is held mid-utterance and can go on. */
  paused: boolean;
  /** A safe provider or playback failure, if the requested speech could not play. */
  error: string | null;
  /** An explanation when the speaking status cannot yet be used. */
  statusMessage: string | null;
  /** The voices the service offers, when there is one. */
  voices: string[];
  /** Say something. Resolves false when nothing could be said. */
  speak: (text: string) => Promise<boolean>;
  /** Hold the current utterance. Does nothing when nothing is being said. */
  pause: () => void;
  /** Go on after a pause. Does nothing when nothing is held. */
  resume: () => void;
  /** Stop talking. */
  cancel: () => void;
}

export function useSpeech(voiceStatusRevision = 0): Speech {
  const [speakers, setSpeakers] = useState<VoiceSpeakers | null>(null);
  const [speakerStatus, setSpeakerStatus] = useState<"loading" | "ready" | "failed">("loading");
  const [speaking, setSpeaking] = useState(false);
  const [paused, setPaused] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const audio = useRef<HTMLAudioElement | null>(null);
  /** Which voice is saying the current utterance, so pause and resume hold the right one. */
  const source = useRef<"tts" | "device" | null>(null);
  const token = useRef(0);
  /** A pause or a newer play request supersedes earlier play promises for the same element. */
  const playAttempt = useRef(0);
  const pendingResume = useRef<HTMLAudioElement | null>(null);
  const speakerRead = useRef(0);

  const deviceSupported =
    typeof window !== "undefined" &&
    "speechSynthesis" in window &&
    "SpeechSynthesisUtterance" in window;

  // biome-ignore lint/correctness/useExhaustiveDependencies: the revision deliberately triggers a fresh local status read after Settings changes
  useEffect(() => {
    const read = ++speakerRead.current;
    setSpeakers(null);
    setSpeakerStatus("loading");
    void window.studio.voice
      .speakers()
      .then((result) => {
        if (read !== speakerRead.current) return;
        if (result.ok) {
          setSpeakers(result.data);
          setSpeakerStatus("ready");
        } else {
          setSpeakerStatus("failed");
        }
      })
      .catch(() => {
        if (read === speakerRead.current) setSpeakerStatus("failed");
      });
    return () => {
      if (read === speakerRead.current) speakerRead.current += 1;
    };
  }, [voiceStatusRevision]);

  const selectedUnavailable = speakers?.selected === true && !speakers.available;
  const using: VoiceSource = speakers?.available
    ? "tts"
    : selectedUnavailable || speakers === null
      ? "none"
      : deviceSupported
        ? "device"
        : "none";
  const statusMessage = speakerStatus === "loading"
    ? "Checking speaking settings…"
    : speakerStatus === "failed"
      ? "Speaking settings could not be read. Try again."
      : selectedUnavailable
        ? "The selected speaking connection is unavailable or its model or voice is no longer supported. Change it in Settings."
        : using === "none"
          ? "This device cannot speak, so the agent shows its status instead of saying it."
          : null;

  const stopAudio = useCallback(() => {
    playAttempt.current += 1;
    pendingResume.current = null;
    const element = audio.current;
    audio.current = null;
    if (element) {
      element.pause();
      element.src = "";
    }
  }, []);

  const cancel = useCallback(() => {
    token.current += 1;
    source.current = null;
    stopAudio();
    if (deviceSupported) window.speechSynthesis.cancel();
    setSpeaking(false);
    setPaused(false);
    setError(null);
  }, [deviceSupported, stopAudio]);

  const speakWithDevice = useCallback(
    (text: string, mine: number): boolean => {
      if (!deviceSupported || mine !== token.current) return false;
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.lang = "en-US";
      utterance.onend = () => {
        if (mine !== token.current || source.current !== "device") return;
        source.current = null;
        setSpeaking(false);
        setPaused(false);
      };
      utterance.onerror = () => {
        if (mine !== token.current || source.current !== "device") return;
        source.current = null;
        setSpeaking(false);
        setPaused(false);
        setError("This device could not play the speech. Try reading again.");
      };
      source.current = "device";
      setSpeaking(true);
      window.speechSynthesis.speak(utterance);
      return true;
    },
    [deviceSupported]
  );

  const pause = useCallback(() => {
    if (!speaking || paused) return;
    if (source.current === "device") {
      if (deviceSupported) window.speechSynthesis.pause();
    } else if (source.current === "tts" && audio.current) {
      playAttempt.current += 1;
      pendingResume.current = null;
      audio.current.pause();
    } else {
      return;
    }
    setPaused(true);
  }, [deviceSupported, paused, speaking]);

  const resume = useCallback(() => {
    if (!paused) return;
    if (source.current === "device") {
      if (deviceSupported) window.speechSynthesis.resume();
      setPaused(false);
      return;
    }
    const element = audio.current;
    if (!element || source.current !== "tts") {
      setPaused(false);
      setSpeaking(false);
      return;
    }
    // Do not start two overlapping resumes on the same still-paused element.
    if (pendingResume.current === element) return;
    const mine = token.current;
    const attempt = ++playAttempt.current;
    pendingResume.current = element;
    const current = () => mine === token.current && audio.current === element &&
      source.current === "tts" && attempt === playAttempt.current;
    const failed = () => {
      if (!current()) return;
      stopAudio();
      source.current = null;
      setPaused(false);
      setSpeaking(false);
      setError("The selected speaking service returned audio, but playback was blocked. Try reading again.");
    };
    try {
      void element.play().then(() => {
        if (!current()) return;
        pendingResume.current = null;
        setPaused(false);
      }, failed);
    } catch {
      failed();
    }
  }, [deviceSupported, paused, stopAudio]);

  const speak = useCallback(
    async (text: string): Promise<boolean> => {
      // Speech reads every symbol it is given, so the markup goes first and the words are what is spoken.
      const trimmed = toSpeechText(text);
      if (!trimmed) return false;
      cancel();
      const mine = token.current;

      let currentSpeakers: VoiceSpeakers | null = null;
      const read = ++speakerRead.current;
      try {
        const latest = await window.studio.voice.speakers();
        if (read === speakerRead.current) {
          if (latest.ok) {
            setSpeakers(latest.data);
            setSpeakerStatus("ready");
          } else {
            setSpeakers(null);
            setSpeakerStatus("failed");
          }
        }
        if (mine !== token.current) return false;
        // A Settings change started a newer read while this one was pending. Do not use the
        // stale result to select a voice, especially the device voice for an old empty choice.
        if (read !== speakerRead.current) {
          setError("Speaking settings changed. Try again.");
          return false;
        }
        if (!latest.ok) {
          setError(latest.error.message);
          return false;
        }
        currentSpeakers = latest.data;
      } catch (caught) {
        if (read === speakerRead.current) {
          setSpeakers(null);
          setSpeakerStatus("failed");
        }
        if (mine === token.current) {
          setError(read !== speakerRead.current
            ? "Speaking settings changed. Try again."
            : caught instanceof Error ? caught.message : "Voice settings could not be read.");
        }
        return false;
      }

      if (currentSpeakers?.available) {
        try {
          const result = await window.studio.voice.speak({ text: trimmed });
          // A newer request arrived while this one was being spoken; drop this one.
          if (mine !== token.current) return false;
          if (result.ok) {
            const element = new Audio(result.data.dataUrl);
            audio.current = element;
            element.onended = () => {
              if (mine !== token.current || audio.current !== element || source.current !== "tts") return;
              stopAudio();
              source.current = null;
              setSpeaking(false);
              setPaused(false);
            };
            element.onerror = () => {
              if (mine !== token.current || audio.current !== element || source.current !== "tts") return;
              stopAudio();
              source.current = null;
              setSpeaking(false);
              setPaused(false);
              setError("The selected speaking service returned audio that could not be played.");
            };
            source.current = "tts";
            setSpeaking(true);
            const attempt = ++playAttempt.current;
            try {
              await element.play();
            } catch {
              if (mine !== token.current || audio.current !== element || source.current !== "tts" ||
                  attempt !== playAttempt.current) return false;
              stopAudio();
              source.current = null;
              setSpeaking(false);
              setPaused(false);
              setError("The selected speaking service returned audio, but playback was blocked. Try reading again.");
              return false;
            }
            return mine === token.current;
          }
          if (mine === token.current) setError(result.error.message);
          return false;
        } catch (caught) {
          if (mine === token.current) {
            setError(caught instanceof Error ? caught.message : "The selected speaking service could not be reached.");
          }
          return false;
        }
      }

      if (currentSpeakers?.selected === true) {
        setError("The selected speaking connection is unavailable. Choose another in Settings.");
        return false;
      }

      return speakWithDevice(trimmed, mine);
    },
    [cancel, speakWithDevice, stopAudio]
  );

  // Leaving the screen must not leave a voice talking.
  useEffect(() => () => {
    token.current += 1;
    speakerRead.current += 1;
    stopAudio();
    if (deviceSupported) window.speechSynthesis.cancel();
  }, [deviceSupported, stopAudio]);

  return {
    supported: using !== "none",
    using,
    speaking,
    paused,
    error,
    statusMessage,
    voices: speakers?.voices ?? [],
    speak,
    pause,
    resume,
    cancel
  };
}
