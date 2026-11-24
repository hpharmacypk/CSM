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
  /** Sent by the viewer (on the green bubble). */
  mine?: boolean;
};

/**
 * Inline voice-note player. Saved notes are fetched through a short-lived
 * signed URL that Supabase only issues if the viewer passes the same
 * conversation access rule as the message itself.
 */
export function VoiceNotePlayer({ supabase, path, localUrl, mime, durationMs, mine = false }: Props) {
  const [signedUrl, setSignedUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [canPlay] = useState(() => {
    if (!mime || typeof document === "undefined") return true;
    return document.createElement("audio").canPlayType(mime) !== "";
  });
  const retriedOnError = useRef(false);
  const audioRef = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [waiting, setWaiting] = useState(false);
  const [current, setCurrent] = useState(0);
  const [mediaDuration, setMediaDuration] = useState<number | null>(null);

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
  // Recorded WebM often reports an infinite duration: prefer the stored length.
  const total = durationMs ? durationMs / 1000 : mediaDuration ?? 0;
  const progress = total > 0 ? Math.min(1, current / total) : 0;

  const toggle = () => {
    const a = audioRef.current;
    if (!a) return;
    if (a.paused) {
      setWaiting(true);
      a.play().catch(() => setWaiting(false));
    } else {
      a.pause();
    }
  };

  const seek = (value: number) => {
    const a = audioRef.current;
    if (!a || !total) return;
    a.currentTime = value;
    setCurrent(value);
  };

  const retry = () => {
    retriedOnError.current = false;
    setError(null);
    setAttempt((n) => n + 1);
  };

  if (!canPlay) {
    return (
      <div className="flex w-60 max-w-full flex-col gap-1 px-1 text-sm">
        <span className="font-medium">Voice note{durationMs ? ` · ${formatDuration(durationMs)}` : ""}</span>
        <span className="text-xs opacity-80">
          This browser can&apos;t play this audio format ({mime?.replace("audio/", "").toUpperCase()}).
        </span>
        {src ? (
          <a href={src} download className="text-xs font-medium underline">
            Download to listen
          </a>
        ) : null}
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex w-60 max-w-full items-center gap-2 px-1 text-sm">
        <span className="flex-1">{error}</span>
        <button type="button" className="rounded-full px-2 py-1 font-semibold underline" onClick={retry}>
          Retry
        </button>
      </div>
    );
  }

  const buttonTone = mine ? "bg-white text-brand-ink hover:bg-white/90" : "bg-brand text-white hover:bg-brand-dark";
  const trackTone = mine ? "bg-white/30" : "bg-line";
  const fillTone = mine ? "bg-white" : "bg-brand";
  const shownTime = playing || current > 0 ? current * 1000 : durationMs ?? (mediaDuration ?? 0) * 1000;

  return (
    <div className="flex w-56 max-w-full items-center gap-2.5 sm:w-64" data-testid="voice-note">
      {src ? (
        <audio
          ref={audioRef}
          preload={localUrl ? "metadata" : "none"}
          src={src}
          className="hidden"
          onPlay={() => setPlaying(true)}
          onPlaying={() => setWaiting(false)}
          onPause={() => {
            setPlaying(false);
            setWaiting(false);
          }}
          onEnded={() => {
            setPlaying(false);
            setCurrent(0);
          }}
          onTimeUpdate={(e) => setCurrent(e.currentTarget.currentTime)}
          onLoadedMetadata={(e) => {
            const d = e.currentTarget.duration;
            if (Number.isFinite(d)) setMediaDuration(d);
          }}
          onError={() => {
            setPlaying(false);
            setWaiting(false);
            // A signed URL may have expired: fetch a fresh one once.
            if (!localUrl && !retriedOnError.current) {
              retriedOnError.current = true;
              setAttempt((n) => n + 1);
            } else {
              setError("Couldn't play this voice note.");
            }
          }}
        />
      ) : null}
      <button
        type="button"
        onClick={toggle}
        disabled={!src}
        aria-label={playing ? "Pause voice note" : "Play voice note"}
        className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-full transition disabled:opacity-50 ${buttonTone}`}
      >
        {waiting ? (
          <span className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" aria-hidden />
        ) : playing ? (
          <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
            <rect x="6" y="5" width="4" height="14" rx="1" />
            <rect x="14" y="5" width="4" height="14" rx="1" />
          </svg>
        ) : (
          <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
            <path d="M8 5.5v13a1 1 0 0 0 1.5.86l10.5-6.5a1 1 0 0 0 0-1.72L9.5 4.64A1 1 0 0 0 8 5.5z" />
          </svg>
        )}
      </button>
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <div className="relative h-5">
          <div className={`absolute inset-x-0 top-1/2 h-1 -translate-y-1/2 rounded-full ${trackTone}`} aria-hidden>
            <div className={`h-full rounded-full ${fillTone}`} style={{ width: `${progress * 100}%` }} />
          </div>
          <div
            className={`pointer-events-none absolute top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full ${fillTone} ${playing || current > 0 ? "" : "opacity-0"}`}
            style={{ left: `${progress * 100}%` }}
            aria-hidden
          />
          <input
            type="range"
            min={0}
            max={total || 1}
            step={0.1}
            value={Math.min(current, total || 1)}
            onChange={(e) => seek(Number(e.target.value))}
            disabled={!src || !total}
            aria-label="Seek voice note"
            aria-valuetext={`${formatDuration(current * 1000) || "0:00"} of ${formatDuration(total * 1000) || "unknown"}`}
            className="absolute inset-0 h-full w-full cursor-pointer opacity-0 disabled:cursor-default"
          />
        </div>
        <div className="flex items-center justify-between text-[11px] leading-none tabular-nums opacity-80">
          <span>{formatDuration(shownTime) || "0:00"}</span>
          <span className="flex items-center gap-1">
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden>
              <rect x="9" y="3" width="6" height="11" rx="3" />
              <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
            </svg>
            Voice note
          </span>
        </div>
      </div>
    </div>
  );
}
