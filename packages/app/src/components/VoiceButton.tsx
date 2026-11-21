import { useEffect, useState } from "react";
import { Loader2, Mic, MicOff, Square } from "lucide-react";
import { Button } from "@ai-book-studio/ui/button";
import { dictationReadiness, useDictation } from "../hooks/use-dictation";
import { voiceReceiptLine } from "../lib/voice-receipt";

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
 *
 * While a transcription is in flight the button is a Stop control: it asks the host to cancel the
 * request, keeps the slot honest, and shows the host's receipt — never a fabricated cost.
 */
export function VoiceButton({ onText, onError, disabled = false, voiceStatusRevision = 0 }: Props) {
  const [availability, setAvailability] = useState<Availability>("checking");
  const [reason, setReason] = useState("Checking voice access…");
  const { state, elapsedMs, start, stop, cancel, receipt } = useDictation({ onText, onError });

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

  const recording = state === "recording";
  const transcribing = state === "transcribing";
  const cancelling = state === "cancelling";
  const requesting = state === "requesting";
  const unavailable = availability !== "ready" || disabled;
  const busy = requesting;

  return (
    <span className="inline-flex items-center gap-2">
      <Button
        type="button"
        variant={recording ? "danger" : "outline"}
        size="icon"
        className="size-11"
        aria-label={recording ? "Stop dictation" : transcribing || cancelling ? "Stop transcription" : "Start dictation"}
        aria-pressed={recording}
        title={
          unavailable && !recording
            ? reason
            : recording
              ? "Stop and transcribe"
              : transcribing || cancelling
                ? "Stop the transcription request"
                : "Start dictation"
        }
        disabled={disabled || busy}
        onClick={() => {
          if (recording) stop();
          else if (transcribing || cancelling) cancel();
          else void start();
        }}
      >
        {requesting ? (
          <Loader2 size={17} className="animate-spin" />
        ) : recording ? (
          <Square size={15} />
        ) : transcribing || cancelling ? (
          cancelling ? <Loader2 size={17} className="animate-spin" /> : <Square size={15} />
        ) : unavailable ? (
          <MicOff size={17} />
        ) : (
          <Mic size={17} />
        )}
      </Button>
      {recording ? (
        <span className="tabular text-(length:--text-caption-size) text-muted-foreground" role="status">
          {elapsed(elapsedMs)}
        </span>
      ) : transcribing ? (
        <span className="text-(length:--text-caption-size) text-muted-foreground" role="status">
          Transcribing…
        </span>
      ) : cancelling ? (
        <span className="text-(length:--text-caption-size) text-muted-foreground" role="status">
          Stopping…
        </span>
      ) : null}
      {receipt ? (
        <span className="max-w-64 text-(length:--text-caption-size) text-muted-foreground" role="status" data-testid="voice-receipt">
          {voiceReceiptLine(receipt)}
        </span>
      ) : null}
    </span>
  );
}
