"use client";

import { useEffect, useRef, useState } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import { MEDIA_BUCKET, formatDuration } from "@/lib/chat/voice";

// Short-lived: a link issued before a "delete for everyone" keeps working until
// it expires (Storage validates the link token, not RLS). See README "Retention".
const SIGNED_URL_SECONDS = 10 * 60;

type Props = {
  supabase: SupabaseClient;
  /** Storage path of a saved voice note (null while still sending). */
  path: string | null;
  /** Local object URL for a voice note that is still being sent. */
  localUrl: string | null;
  mime: string | null;
  durationMs: number | null;
};

/**
 * Inline voice-note player. Saved notes are fetched through a short-lived
 * signed URL that Supabase only issues if the viewer passes the same
 * conversation access rule as the message itself.
 */
export function VoiceNotePlayer({ supabase, path, localUrl, mime, durationMs }: Props) {
  const [signedUrl, setSignedUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [canPlay] = useState(() => {
    if (!mime || typeof document === "undefined") return true;
    return document.createElement("audio").canPlayType(mime) !== "";
  });
  const retriedOnError = useRef(false);

  useEffect(() => {
    if (localUrl || !path) return;
    let active = true;
    void supabase.storage
      .from(MEDIA_BUCKET)
      .createSignedUrl(path, SIGNED_URL_SECONDS)
      .then(({ data, error: e }) => {
        if (!active) return;
        if (e || !data?.signedUrl) {
          setError("Voice note unavailable.");
        } else {
          setSignedUrl(data.signedUrl);
          setError(null);
        }
      });
    return () => {
      active = false;
    };
  }, [supabase, path, localUrl, attempt]);

  const src = localUrl ?? signedUrl;
  const label = `Voice note${durationMs ? ` · ${formatDuration(durationMs)}` : ""}`;

  if (!canPlay) {
    return (
      <div className="flex w-64 max-w-full flex-col gap-1 text-sm">
        <span className="font-medium">{label}</span>
        <span className="text-xs opacity-80">
          This browser can&apos;t play this audio format ({mime?.replace("audio/", "").toUpperCase()}).
        </span>
        {src ? (
          <a href={src} download className="text-xs underline">
            Download to listen
          </a>
        ) : null}
      </div>
    );
  }

  return (
    <div className="flex w-64 max-w-full flex-col gap-1 sm:w-72">
      {error ? (
        <div className="flex items-center gap-2 text-sm">
          <span>{error}</span>
          <button
            type="button"
            className="underline"
            onClick={() => {
              retriedOnError.current = false;
              setError(null);
              setAttempt((n) => n + 1);
            }}
          >
            Retry
          </button>
        </div>
      ) : src ? (
         
        <audio
          controls
          preload={localUrl ? "metadata" : "none"}
          src={src}
          className="h-10 w-full"
          onError={() => {
            // A signed URL may have expired: fetch a fresh one once.
            if (!localUrl && !retriedOnError.current) {
              retriedOnError.current = true;
              setAttempt((n) => n + 1);
            } else {
              setError("Couldn't play this voice note.");
            }
          }}
        />
      ) : (
        <div className="h-10 w-full animate-pulse rounded-full bg-black/5" aria-label="Loading voice note" />
      )}
      <span className="px-1 text-[11px] opacity-80">{label}</span>
    </div>
  );
}
