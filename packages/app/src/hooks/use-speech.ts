import { useCallback, useEffect, useRef, useState } from "react";
import type { VoiceOperationView, VoiceSpeakers } from "@ai-book-studio/core/ipc";
import { toSpeechText } from "@ai-book-studio/core/speech-text";

/** Where the speaking pipeline actually is, across the host operation and local playback. */
export type SpeechPhase = "idle" | "synthesizing" | "playing" | "paused" | "cancelling";

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
  /** Which stage the voice is in. A cancel during `synthesizing` reaches the host; a stop during `playing` only stops playback. */
  phase: SpeechPhase;
  /** The last settled host operation, for the receipt line. Null for device speech and before any request. */
  receipt: VoiceOperationView | null;
  /** True right after the author stopped local playback, so the panel can say the settled receipt still stands. */
  playbackStopped: boolean;
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
  const [phase, setPhase] = useState<SpeechPhase>("idle");
  const [receipt, setReceipt] = useState<VoiceOperationView | null>(null);
  const [playbackStopped, setPlaybackStopped] = useState(false);
  const operationId = useRef<number | null>(null);
  const operationRevision = useRef(0);
  const cancelArmed = useRef(false);
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

  // Host operation events: adopt the minted id, keep cancelling state honest, keep the receipt.
  useEffect(() => {
    const onOperation = window.studio?.voice?.onOperation;
    if (!onOperation) return undefined;
    return onOperation((view) => {
      if (view.kind !== "tts") return;
      if (operationId.current === null) {
        if (view.phase !== "starting") return;
        operationId.current = view.operationId;
        operationRevision.current = view.viewRevision;
        if (cancelArmed.current) {
          cancelArmed.current = false;
          void window.studio?.voice?.cancel?.({ operationId: view.operationId })?.catch(() => {});
          setPhase("cancelling");
        } else {
          setPhase("synthesizing");
        }
        return;
      }
      if (view.operationId !== operationId.current) return;
      if (view.viewRevision <= operationRevision.current) return;
      operationRevision.current = view.viewRevision;
      if (view.phase === "in-flight") {
        setPhase("synthesizing");
        return;
      }
      if (view.phase === "cancelling") {
        setPhase("cancelling");
        return;
      }
      if (view.phase === "settled") {
        setReceipt(view);
        operationId.current = null;
        cancelArmed.current = false;
        if (view.status === "cancellation") setPhase("idle");
      }
    });
  }, []);

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

  /** Stop local playback and invalidate pending play promises; no host cancel is involved. */
  const stopPlayback = useCallback(() => {
    token.current += 1;
    source.current = null;
    stopAudio();
    if (deviceSupported) window.speechSynthesis.cancel();
    setSpeaking(false);
    setPaused(false);
    setError(null);
  }, [deviceSupported, stopAudio]);

  const cancel = useCallback(() => {
    const synthesisInFlight = operationId.current !== null || phase === "synthesizing" || phase === "cancelling";
    stopPlayback();
    if (synthesisInFlight) {
      // Stopping synthesis: ask the host to cancel its request. The late reply is discarded.
      cancelArmed.current = true;
      const id = operationId.current;
      if (id !== null) {
        void window.studio?.voice?.cancel?.({ operationId: id })?.catch(() => {});
      }
      setPhase("cancelling");
    } else {
      // Stopping playback: the settled provider request stays settled; no cancel is sent.
      cancelArmed.current = false;
      setPhase("idle");
      setPlaybackStopped(true);
    }
  }, [phase, stopPlayback]);

  const speakWithDevice = useCallback(
    (text: string, mine: number): boolean => {
      if (!deviceSupported || mine !== token.current) return false;
      const current = () => mine === token.current && source.current === "device";
      const settle = (failed: boolean) => {
        source.current = null;
        setSpeaking(false);
        setPaused(false);
        setPhase("idle");
        if (failed) setError("This device could not play the speech. Try reading again.");
      };

      try {
        const utterance = new SpeechSynthesisUtterance(text);
        utterance.lang = "en-US";
        utterance.onend = () => {
          if (current()) settle(false);
        };
        utterance.onerror = () => {
          if (current()) settle(true);
        };
        source.current = "device";
        window.speechSynthesis.speak(utterance);
      } catch {
        if (mine === token.current) settle(true);
        return false;
      }

      // The device may settle the utterance inside the speak call.
      if (current()) {
        setSpeaking(true);
        setPhase("playing");
      }
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
    setPhase("paused");
  }, [deviceSupported, paused, speaking]);

  const resume = useCallback(() => {
    if (!paused) return;
    if (source.current === "device") {
      if (deviceSupported) window.speechSynthesis.resume();
      setPaused(false);
      setPhase("playing");
      return;
    }
    const element = audio.current;
    if (!element || source.current !== "tts") {
      setPaused(false);
      setSpeaking(false);
      setPhase("idle");
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
      setPhase("idle");
      setError("The selected speaking service returned audio, but playback was blocked. Try reading again.");
    };
    try {
      void element.play().then(() => {
        if (!current()) return;
        pendingResume.current = null;
        setPaused(false);
        setPhase("playing");
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
      stopPlayback();
      const mine = token.current;
      operationId.current = null;
      operationRevision.current = 0;
      cancelArmed.current = false;
      setReceipt(null);
      setPlaybackStopped(false);

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
            const outcome = result.data;
            if (outcome.receipt) setReceipt(outcome.receipt);
            if (outcome.status !== "success") {
              setPhase("idle");
              // A deliberate cancel is not an error; a refusal or failure is.
              if (outcome.status !== "cancellation") setError(outcome.message);
              return false;
            }
            const element = new Audio(outcome.reply.dataUrl);
            audio.current = element;
            element.onended = () => {
              if (mine !== token.current || audio.current !== element || source.current !== "tts") return;
              stopAudio();
              source.current = null;
              setSpeaking(false);
              setPaused(false);
              setPhase("idle");
            };
            element.onerror = () => {
              if (mine !== token.current || audio.current !== element || source.current !== "tts") return;
              stopAudio();
              source.current = null;
              setSpeaking(false);
              setPaused(false);
              setPhase("idle");
              setError("The selected speaking service returned audio that could not be played.");
            };
            source.current = "tts";
            setSpeaking(true);
            setPhase("playing");
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
              setPhase("idle");
              setError("The selected speaking service returned audio, but playback was blocked. Try reading again.");
              return false;
            }
            return mine === token.current;
          }
          setPhase("idle");
          if (mine === token.current) setError(result.error.message);
          return false;
        } catch (caught) {
          if (mine === token.current) {
            setPhase("idle");
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
    [stopPlayback, speakWithDevice, stopAudio]
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
    phase,
    receipt,
    playbackStopped,
    error,
    statusMessage,
    voices: speakers?.voices ?? [],
    speak,
    pause,
    resume,
    cancel
  };
}
