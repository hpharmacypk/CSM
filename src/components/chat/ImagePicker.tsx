"use client";

import { useCallback, useEffect, useRef, useState, type ChangeEvent } from "react";
import {
  IMAGE_ACCEPT,
  ImagePrepError,
  formatBytes,
  prepareImage,
  type PreparedImage,
} from "@/lib/chat/image";
import { COMPOSER_ICON_BUTTON } from "./styles";

type PickerState =
  | { kind: "idle" }
  | { kind: "preparing" }
  | { kind: "preview"; image: PreparedImage; url: string }
  | { kind: "error"; message: string };

type Props = {
  onSend: (image: PreparedImage) => void;
  /** Tells the composer to hide the text input while previewing. */
  onActiveChange: (active: boolean) => void;
  disabled?: boolean;
};

export function ImagePicker({ onSend, onActiveChange, disabled }: Props) {
  const [state, setState] = useState<PickerState>({ kind: "idle" });
  const inputRef = useRef<HTMLInputElement>(null);
  const urlRef = useRef<string | null>(null);

  const go = useCallback(
    (next: PickerState) => {
      setState(next);
      onActiveChange(next.kind !== "idle");
    },
    [onActiveChange],
  );

  const clearUrl = useCallback(() => {
    if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    urlRef.current = null;
  }, []);

  useEffect(() => clearUrl, [clearUrl]);

  const onPick = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ""; // allow picking the same file again
    if (!file) return;
    go({ kind: "preparing" });
    try {
      const image = await prepareImage(file);
      clearUrl();
      const url = URL.createObjectURL(image.blob);
      urlRef.current = url;
      go({ kind: "preview", image, url });
    } catch (error) {
      go({
        kind: "error",
        message:
          error instanceof ImagePrepError ? error.message : "This image couldn't be prepared. Try another one.",
      });
    }
  };

  const remove = () => {
    clearUrl();
    go({ kind: "idle" });
  };

  const send = () => {
    if (state.kind !== "preview") return;
    onSend(state.image); // the chat keeps its own copy for retries
    clearUrl();
    go({ kind: "idle" });
  };

  const input = (
    <input
      ref={inputRef}
      type="file"
      accept={IMAGE_ACCEPT}
      className="hidden"
      onChange={(e) => void onPick(e)}
      data-testid="image-input"
    />
  );

  if (state.kind === "idle" || state.kind === "preparing") {
    return (
      <>
        {input}
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          disabled={disabled || state.kind === "preparing"}
          aria-label="Attach an image"
          title="Attach an image (JPEG, PNG or WebP)"
          className={COMPOSER_ICON_BUTTON}
        >
          {state.kind === "preparing" ? (
            <span
              className="h-4 w-4 animate-spin rounded-full border-2 border-brand border-t-transparent"
              aria-label="Preparing image"
            />
          ) : (
            <ImageIcon />
          )}
        </button>
      </>
    );
  }

  if (state.kind === "error") {
    return (
      <div
        className="flex min-h-11 flex-1 items-center gap-3 rounded-2xl border border-danger/20 bg-danger-soft px-4 py-2"
        role="alert"
      >
        <p className="flex-1 text-sm text-danger">{state.message}</p>
        <button type="button" onClick={remove} className="shrink-0 text-sm font-medium text-ink underline">
          OK
        </button>
      </div>
    );
  }

  const { image, url } = state;
  return (
    <div className="flex flex-1 flex-col gap-2 rounded-2xl border border-line bg-canvas p-2 sm:flex-row sm:items-end">
      {/* eslint-disable-next-line @next/next/no-img-element -- local blob preview */}
      <img
        src={url}
        alt="Selected image preview"
        width={image.width}
        height={image.height}
        className="max-h-[40vh] w-auto max-w-full self-center rounded-xl border border-line bg-surface object-contain sm:max-h-48"
      />
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <span className="px-1 text-xs text-muted">
          {image.width}×{image.height} · {formatBytes(image.blob.size)}
          {image.originalBytes > image.blob.size ? ` (from ${formatBytes(image.originalBytes)})` : ""}
        </span>
        <div className="flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={remove}
            className="h-10 rounded-full border border-line px-4 text-sm font-medium text-muted hover:bg-surface"
          >
            Remove
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
    </div>
  );
}

function ImageIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <circle cx="9" cy="10" r="2" />
      <path d="m21 16-5-5-9 9" />
    </svg>
  );
}
