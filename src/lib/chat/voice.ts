/**
 * Voice-note helpers shared by the recorder, the send flow and the player.
 * Limits here mirror the database/storage limits in
 * supabase/migrations/20261120000100_phase2b_voice_notes.sql.
 */

export const MEDIA_BUCKET = "chat-media";
export const VOICE_MAX_MS = 120_000; // two minutes
export const VOICE_MAX_BYTES = 3 * 1024 * 1024; // 3 MB (bucket limit)
export const VOICE_BITS_PER_SECOND = 48_000; // ≈ 720 KB for two minutes

export type VoiceBaseMime = "audio/mp4" | "audio/webm" | "audio/ogg";

export type VoiceRecording = {
  blob: Blob;
  /** Base MIME type without codec parameters, e.g. "audio/webm". */
  mime: VoiceBaseMime;
  ext: "m4a" | "webm" | "ogg";
  durationMs: number;
};

/**
 * Preferred recording formats, best cross-browser playback first:
 *  - AAC in MP4 plays in every current browser, including iPhone Safari.
 *  - Opus in WebM is what Chrome/Android and Firefox record natively.
 *  - Plain audio/mp4 is Safari's default (AAC).
 *  - Opus in Ogg is a Firefox fallback.
 */
const CANDIDATES: { request: string; base: VoiceBaseMime }[] = [
  { request: "audio/mp4;codecs=mp4a.40.2", base: "audio/mp4" },
  { request: "audio/webm;codecs=opus", base: "audio/webm" },
  { request: "audio/mp4", base: "audio/mp4" },
  { request: "audio/ogg;codecs=opus", base: "audio/ogg" },
  { request: "audio/webm", base: "audio/webm" },
];

const EXT: Record<VoiceBaseMime, VoiceRecording["ext"]> = {
  "audio/mp4": "m4a",
  "audio/webm": "webm",
  "audio/ogg": "ogg",
};

export function baseMime(mimeType: string): VoiceBaseMime | null {
  const base = mimeType.split(";")[0].trim().toLowerCase();
  return base === "audio/mp4" || base === "audio/webm" || base === "audio/ogg" ? base : null;
}

export function extForMime(mime: VoiceBaseMime): VoiceRecording["ext"] {
  return EXT[mime];
}

/** First recording format this browser supports, or null (let the browser choose). */
export function pickRecordingFormat(): string | null {
  if (typeof MediaRecorder === "undefined" || typeof MediaRecorder.isTypeSupported !== "function") {
    return null;
  }
  return CANDIDATES.find((c) => MediaRecorder.isTypeSupported(c.request))?.request ?? null;
}

/** Why voice recording can't work here, or null if it should. */
export function voiceUnsupportedReason(): string | null {
  if (typeof window === "undefined") return "Voice notes aren't available.";
  if (!window.isSecureContext) {
    return "Voice notes need a secure (https) connection.";
  }
  if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
    return "Voice notes aren't supported in this browser. Please update it, or type your message instead.";
  }
  return null;
}

/** Readable message for a getUserMedia / MediaRecorder failure. */
export function microphoneErrorMessage(error: unknown): string {
  const name = error instanceof DOMException || error instanceof Error ? error.name : "";
  switch (name) {
    case "NotAllowedError":
    case "SecurityError":
      return "Microphone access is blocked. Allow microphone access for this site in your browser settings, then try again.";
    case "NotFoundError":
    case "OverconstrainedError":
      return "No microphone was found on this device.";
    case "NotReadableError":
    case "AbortError":
      return "Your microphone is busy or unavailable. Close other apps using it and try again.";
    case "NotSupportedError":
      return "This browser can't record audio in a supported format.";
    default:
      return "Couldn't start recording. Please try again.";
  }
}

/** Readable message for a failed upload (Supabase Storage error). */
export function uploadErrorMessage(error: unknown): string {
  const e = (error ?? {}) as { status?: number; statusCode?: string | number; message?: string };
  const code = Number(e.statusCode ?? e.status);
  const msg = (e.message ?? "").toLowerCase();
  if (code === 413 || msg.includes("size") || msg.includes("too large")) {
    return "Voice note is too large to send.";
  }
  if (code === 415 || msg.includes("mime") || msg.includes("not supported")) {
    return "This audio format isn't accepted.";
  }
  if (code === 401 || code === 403) {
    return "Upload not allowed. Refresh the page and try again.";
  }
  return "Upload failed. Check your connection and tap Retry.";
}

export function isAlreadyUploaded(error: unknown): boolean {
  const e = (error ?? {}) as { status?: number; statusCode?: string | number; message?: string };
  return (
    Number(e.statusCode ?? e.status) === 409 ||
    /already exists|duplicate/i.test(e.message ?? "")
  );
}

export function formatDuration(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return "";
  const total = Math.round(ms / 1000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}
