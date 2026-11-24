"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  VOICE_BITS_PER_SECOND,
  VOICE_MAX_BYTES,
  VOICE_MAX_MS,
  baseMime,
  extForMime,
  formatDuration,
  microphoneErrorMessage,
  pickRecordingFormat,
  voiceUnsupportedReason,
  type VoiceRecording,
} from "@/lib/chat/voice";
import { COMPOSER_ICON_BUTTON } from "./styles";

type RecorderState =
  | { kind: "idle" }
  | { kind: "requesting" }
  | { kind: "recording"; startedAt: number }
  | { kind: "preview"; recording: VoiceRecording; url: string; autoStopped: boolean }
  | { kind: "error"; message: string };

type Props = {
  onSend: (recording: VoiceRecording) => void;
  /** Tells the composer to hide the text input while recording/previewing. */
  onActiveChange: (active: boolean) => void;
  disabled?: boolean;
};

export function VoiceRecorder({ onSend, onActiveChange, disabled }: Props) {
  const [state, setState] = useState<RecorderState>({ kind: "idle" });
  const [elapsed, setElapsed] = useState(0);

  const streamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const startedAtRef = useRef(0);
  const cancelledRef = useRef(false);
  const autoStoppedRef = useRef(false);
  const tickRef = useRef<number | null>(null);
  const limitRef = useRef<number | null>(null);
  const previewUrlRef = useRef<string | null>(null);

  const go = useCallback(
    (next: RecorderState) => {
      setState(next);
      onActiveChange(next.kind !== "idle");
    },
    [onActiveChange],
  );

  /** Stop the microphone and timers. Safe to call any number of times. */
  const releaseMic = useCallback(() => {
    if (tickRef.current !== null) window.clearInterval(tickRef.current);
    if (limitRef.current !== null) window.clearTimeout(limitRef.current);
    tickRef.current = null;
    limitRef.current = null;
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  }, []);

  const clearPreviewUrl = useCallback(() => {
    if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current);
    previewUrlRef.current = null;
  }, []);

  const stop = useCallback(() => {
    const rec = recorderRef.current;
    if (rec && rec.state !== "inactive") rec.stop(); // onstop builds the preview
    releaseMic();
  }, [releaseMic]);

  const cancel = useCallback(() => {
    cancelledRef.current = true;
    const rec = recorderRef.current;
    if (rec && rec.state !== "inactive") rec.stop();
    recorderRef.current = null;
    releaseMic();
    clearPreviewUrl();
    go({ kind: "idle" });
  }, [releaseMic, clearPreviewUrl, go]);

  const start = useCallback(async () => {
    const unsupported = voiceUnsupportedReason();
    if (unsupported) {
      go({ kind: "error", message: unsupported });
      return;
    }
    go({ kind: "requesting" });
    cancelledRef.current = false;
    autoStoppedRef.current = false;

    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
    } catch (error) {
      go({ kind: "error", message: microphoneErrorMessage(error) });
      return;
    }
    if (cancelledRef.current) {
      stream.getTracks().forEach((t) => t.stop());
      return;
    }
    streamRef.current = stream;

    let recorder: MediaRecorder;
    const preferred = pickRecordingFormat();
    try {
      recorder = new MediaRecorder(stream, {
        ...(preferred ? { mimeType: preferred } : {}),
        audioBitsPerSecond: VOICE_BITS_PER_SECOND,
      });
    } catch {
      try {
        recorder = new MediaRecorder(stream); // let the browser pick
      } catch (error) {
        releaseMic();
        go({ kind: "error", message: microphoneErrorMessage(error) });
        return;
      }
    }

    chunksRef.current = [];
    recorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) chunksRef.current.push(e.data);
    };
    recorder.onerror = () => {
      releaseMic();
      go({ kind: "error", message: "Recording stopped unexpectedly. Please try again." });
    };
    recorder.onstop = () => {
      releaseMic();
      recorderRef.current = null;
      if (cancelledRef.current) return;
      const durationMs = Math.min(Date.now() - startedAtRef.current, VOICE_MAX_MS);
      const actualType = recorder.mimeType || chunksRef.current[0]?.type || preferred || "";
      const mime = baseMime(actualType);
      if (!mime) {
        go({ kind: "error", message: "This browser recorded audio in a format we can't send." });
        return;
      }
      const blob = new Blob(chunksRef.current, { type: mime });
      chunksRef.current = [];
      if (blob.size === 0 || durationMs < 500) {
        go({ kind: "error", message: "That recording was too short. Hold on a little longer." });
        return;
      }
      if (blob.size > VOICE_MAX_BYTES) {
        go({ kind: "error", message: "Voice note is too large to send. Try a shorter recording." });
        return;
      }
      clearPreviewUrl();
      const url = URL.createObjectURL(blob);
      previewUrlRef.current = url;
      go({
        kind: "preview",
        recording: { blob, mime, ext: extForMime(mime), durationMs },
        url,
        autoStopped: autoStoppedRef.current,
      });
    };

    recorderRef.current = recorder;
    startedAtRef.current = Date.now();
    setElapsed(0);
    recorder.start(1000);
    go({ kind: "recording", startedAt: startedAtRef.current });

    tickRef.current = window.setInterval(() => {
      setElapsed(Date.now() - startedAtRef.current);
    }, 250);
    limitRef.current = window.setTimeout(() => {
      autoStoppedRef.current = true;
      stop();
    }, VOICE_MAX_MS);
  }, [go, releaseMic, clearPreviewUrl, stop]);

  const send = useCallback(() => {
    if (state.kind !== "preview") return;
    onSend(state.recording); // the chat keeps its own copy for retries
    clearPreviewUrl();
    go({ kind: "idle" });
  }, [state, onSend, clearPreviewUrl, go]);

  // Release the microphone when leaving the page or unmounting.
  useEffect(() => {
    const onPageHide = () => {
      cancelledRef.current = true;
      const rec = recorderRef.current;
      if (rec && rec.state !== "inactive") rec.stop();
      releaseMic();
    };
    window.addEventListener("pagehide", onPageHide);
    return () => {
      window.removeEventListener("pagehide", onPageHide);
      onPageHide();
      clearPreviewUrl();
    };
  }, [releaseMic, clearPreviewUrl]);

  if (state.kind === "idle" || state.kind === "requesting") {
    return (
      <button
        type="button"
        onClick={() => void start()}
        disabled={disabled || state.kind === "requesting"}
        aria-label="Record a voice note"
        title="Record a voice note"
        className={COMPOSER_ICON_BUTTON}
      >
        {state.kind === "requesting" ? <Spinner /> : <MicIcon />}
      </button>
    );
  }

  if (state.kind === "error") {
    return (
      <div className="flex min-h-11 flex-1 items-center gap-3 rounded-2xl border border-danger/20 bg-danger-soft px-4 py-2" role="alert">
        <p className="flex-1 text-sm text-danger">{state.message}</p>
        <button type="button" onClick={() => go({ kind: "idle" })} className="shrink-0 text-sm font-medium text-ink underline">
          OK
        </button>
      </div>
    );
  }

  if (state.kind === "recording") {
    const remaining = VOICE_MAX_MS - elapsed;
    return (
      <div className="flex min-h-11 flex-1 items-center gap-3 rounded-2xl border border-line bg-canvas px-3 py-1.5">
        <button
          type="button"
          onClick={cancel}
          aria-label="Cancel recording"
          className="rounded-full px-2 py-1 text-sm text-muted hover:text-danger"
        >
          Cancel
        </button>
        <div className="flex flex-1 items-center justify-center gap-2" aria-live="polite">
          <span className="h-2.5 w-2.5 animate-pulse rounded-full bg-red-500" aria-hidden />
          <span className="font-mono text-sm tabular-nums text-ink">
            {formatDuration(elapsed)}
            <span className="text-muted"> / {formatDuration(VOICE_MAX_MS)}</span>
          </span>
          {remaining <= 10_000 ? (
            <span className="text-xs text-danger">{Math.ceil(remaining / 1000)}s left</span>
          ) : null}
        </div>
        <button
          type="button"
          onClick={stop}
          aria-label="Stop recording"
          className="flex h-9 w-9 items-center justify-center rounded-full bg-red-500 text-white hover:bg-red-600"
        >
          <span className="h-3 w-3 rounded-sm bg-white" aria-hidden />
        </button>
      </div>
    );
  }

  // Preview
  return (
    <div className="flex flex-1 flex-col gap-2 rounded-2xl border border-line bg-canvas p-2 sm:flex-row sm:items-center">
      <div className="flex min-w-0 flex-1 flex-col">
        { }
        <audio controls src={state.url} preload="metadata" className="h-10 w-full min-w-0" />
        <span className="px-1 pt-0.5 text-xs text-muted">
          Voice note · {formatDuration(state.recording.durationMs)}
          {state.autoStopped ? " · stopped at the 2-minute limit" : ""}
        </span>
      </div>
      <div className="flex shrink-0 items-center justify-end gap-2">
        <button
          type="button"
          onClick={cancel}
          className="h-10 rounded-full border border-line px-4 text-sm font-medium text-muted hover:bg-surface"
        >
          Discard
        </button>
        <button
          type="button"
          onClick={send}
          disabled={disabled}
          className="h-10 rounded-full bg-brand px-5 text-sm font-semibold text-white hover:bg-brand-dark disabled:opacity-40"
        >
          Send
        </button>
      </div>
    </div>
  );
}

function MicIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="9" y="3" width="6" height="11" rx="3" />
      <path d="M5 11a7 7 0 0 0 14 0" />
      <path d="M12 18v3" />
    </svg>
  );
}

function Spinner() {
  return <span className="h-4 w-4 animate-spin rounded-full border-2 border-brand border-t-transparent" aria-label="Waiting for microphone" />;
}
