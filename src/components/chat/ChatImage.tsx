"use client";

import { useEffect, useRef, useState } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import { MEDIA_BUCKET } from "@/lib/chat/voice";

const SIGNED_URL_SECONDS = 60 * 60;

type Props = {
  supabase: SupabaseClient;
  /** Storage path of a saved image (null while still sending). */
  path: string | null;
  /** Local object URL for an image that is still being sent. */
  localUrl: string | null;
  width: number | null;
  height: number | null;
};

/**
 * Inline chat image. Saved images load through a short-lived signed URL that
 * Supabase only issues if the viewer passes the conversation's Storage policy.
 * Tap to view full size.
 */
export function ChatImage({ supabase, path, localUrl, width, height }: Props) {
  const [signedUrl, setSignedUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [open, setOpen] = useState(false);
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
          setError("Image unavailable.");
        } else {
          setSignedUrl(data.signedUrl);
          setError(null);
        }
      });
    return () => {
      active = false;
    };
  }, [supabase, path, localUrl, attempt]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  const src = localUrl ?? signedUrl;
  const ratio = width && height ? `${width} / ${height}` : "4 / 3";

  if (error) {
    return (
      <div className="flex w-60 items-center gap-2 px-2 py-6 text-sm">
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
    );
  }

  return (
    <>
      <button
        type="button"
        onClick={() => src && setOpen(true)}
        className="block overflow-hidden rounded-xl bg-white"
        style={{ aspectRatio: ratio, width: "min(15rem, 60vw)", maxHeight: "20rem" }}
        aria-label="View image full size"
      >
        {src ? (
          // eslint-disable-next-line @next/next/no-img-element -- private signed/blob URL
          <img
            src={src}
            alt="Image sent in chat"
            width={width ?? undefined}
            height={height ?? undefined}
            loading="lazy"
            decoding="async"
            className="h-full w-full object-cover"
            onError={() => {
              // A signed URL may have expired: fetch a fresh one once.
              if (!localUrl && !retriedOnError.current) {
                retriedOnError.current = true;
                setAttempt((n) => n + 1);
              } else {
                setError("Couldn't load this image.");
              }
            }}
          />
        ) : (
          <span className="block h-full w-full animate-pulse" aria-label="Loading image" />
        )}
      </button>

      {open && src ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Image viewer"
          className="fixed inset-0 z-50 flex flex-col bg-black/90"
          onClick={() => setOpen(false)}
        >
          <div className="flex justify-end gap-2 p-3">
            <a
              href={src}
              target="_blank"
              rel="noopener noreferrer"
              onClick={(e) => e.stopPropagation()}
              className="rounded-full bg-white/10 px-4 py-2 text-sm text-white hover:bg-white/20"
            >
              Open original
            </a>
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="rounded-full bg-white/10 px-4 py-2 text-sm text-white hover:bg-white/20"
            >
              Close
            </button>
          </div>
          <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto p-2">
            {/* eslint-disable-next-line @next/next/no-img-element -- private signed/blob URL */}
            <img
              src={src}
              alt="Image sent in chat, full size"
              className="max-h-full max-w-full object-contain"
              onClick={(e) => e.stopPropagation()}
            />
          </div>
        </div>
      ) : null}
    </>
  );
}
