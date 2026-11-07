import { useEffect, useState } from "react";
import { Loader2, Mic, MicOff, Square } from "lucide-react";
import { Button } from "@ai-book-studio/ui/button";
import { dictationReadiness, useDictation } from "../hooks/use-dictation";

interface Props {
  onText: (text: string) => void;
  onError: (error: Error) => void;
  disabled?: boolean;
  voiceStatusRevision?: number;
}

type Availability = "checking" | "ready" | "unavailable";

function elapsed(ms: number): string {
  const total = Math.floor(ms / 1000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

/**
 * The indicator follows the saved selection, not the presence of an unrelated connection. The
 * button can still be pressed when unavailable so its reason is announced through onError.
 */
export function VoiceButton({ onText, onError, disabled = false, voiceStatusRevision = 0 }: Props) {
  const [availability, setAvailability] = useState<Availability>("checking");
  const [reason, setReason] = useState("Checking voice access…");
  const { state, elapsedMs, start, stop } = useDictation({ onText, onError });

  // biome-ignore lint/correctness/useExhaustiveDependencies: voiceStatusRevision triggers a fresh local settings check after the author changes Voice settings
  useEffect(() => {
    let live = true;
    setAvailability("checking");
    setReason("Checking voice access…");
    void dictationReadiness()
      .then((result) => {
        if (!live) return;
        setAvailability(result.available ? "ready" : "unavailable");
        setReason(result.reason);
      });
    return () => {
      live = false;
    };
  }, [voiceStatusRevision]);

  const busy = state === "requesting" || state === "transcribing";
  const recording = state === "recording";
  const unavailable = availability !== "ready" || disabled;

  return (
    <span className="inline-flex items-center gap-2">
      <Button
        type="button"
        variant={recording ? "danger" : "outline"}
        size="icon"
        className="size-11"
        aria-label={recording ? "Stop dictation" : "Start dictation"}
        aria-pressed={recording}
        title={unavailable ? reason : recording ? "Stop and transcribe" : "Start dictation"}
        disabled={disabled || busy}
        onClick={() => {
          if (recording) stop();
          else void start();
        }}
      >
        {busy ? <Loader2 size={17} className="animate-spin" /> : recording ? <Square size={15} /> : unavailable ? <MicOff size={17} /> : <Mic size={17} />}
      </Button>
      {recording ? (
        <span className="tabular text-(length:--text-caption-size) text-muted-foreground" role="status">
          {elapsed(elapsedMs)}
        </span>
      ) : state === "transcribing" ? (
        <span className="text-(length:--text-caption-size) text-muted-foreground" role="status">
          Transcribing…
        </span>
      ) : null}
    </span>
  );
}
