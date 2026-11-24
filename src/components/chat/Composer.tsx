"use client";

import { useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import type { PreparedImage } from "@/lib/chat/image";
import type { VoiceRecording } from "@/lib/chat/voice";
import { ImagePicker } from "./ImagePicker";
import { LocationPicker } from "./LocationPicker";
import type { SharedLocation } from "@/lib/chat/use-conversation-messages";
import { VoiceRecorder } from "./VoiceRecorder";
import { COMPOSER_ICON_BUTTON } from "./styles";

const MAX_LENGTH = 4000;

export function Composer({
  onSend,
  onSendVoice,
  onSendImage,
  onSendLocation,
  disabled,
  placeholder = "Type a message",
}: {
  onSend: (body: string) => Promise<boolean> | void;
  onSendVoice?: (recording: VoiceRecording) => Promise<boolean> | void;
  onSendImage?: (image: PreparedImage) => Promise<boolean> | void;
  onSendLocation?: (location: SharedLocation) => Promise<boolean> | void;
  disabled?: boolean;
  placeholder?: string;
}) {
  const [value, setValue] = useState("");
  const [voiceActive, setVoiceActive] = useState(false);
  const [imageActive, setImageActive] = useState(false);
  const [locationOpen, setLocationOpen] = useState(false);
  const attachmentActive = voiceActive || imageActive;
  const ref = useRef<HTMLTextAreaElement>(null);

  const submit = (e?: FormEvent) => {
    e?.preventDefault();
    const body = value.trim();
    if (!body || disabled) return;
    setValue("");
    void onSend(body);
    ref.current?.focus();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // Enter sends; Shift+Enter adds a new line.
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submit();
    }
  };

  return (
    <form
      onSubmit={submit}
      className="shrink-0 border-t border-line bg-surface px-2 pt-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] sm:px-6 sm:pt-3 sm:pb-[max(0.75rem,env(safe-area-inset-bottom))]"
    >
      <div className="mx-auto flex max-w-3xl items-end gap-0.5 sm:gap-1.5">
        {/* Only one attachment flow at a time; the idle one is hidden. */}
        {onSendVoice && !imageActive ? (
          <VoiceRecorder
            onSend={(r) => void onSendVoice(r)}
            onActiveChange={setVoiceActive}
            disabled={disabled}
          />
        ) : null}
        {onSendImage && !voiceActive ? (
          <ImagePicker
            onSend={(img) => void onSendImage(img)}
            onActiveChange={setImageActive}
            disabled={disabled}
          />
        ) : null}
        {onSendLocation && !attachmentActive ? (
          <button
            type="button"
            onClick={() => setLocationOpen(true)}
            disabled={disabled}
            aria-label="Send location"
            title="Send location"
            className={COMPOSER_ICON_BUTTON}
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M12 21s-7-6.2-7-11.5A7 7 0 0 1 19 9.5C19 14.8 12 21 12 21z" />
              <circle cx="12" cy="9.5" r="2.5" />
            </svg>
          </button>
        ) : null}
        <label htmlFor="composer" className="sr-only">
          Message
        </label>
        <textarea
          hidden={attachmentActive}
          id="composer"
          ref={ref}
          rows={1}
          value={value}
          maxLength={MAX_LENGTH}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={placeholder}
          disabled={disabled}
          className="field-sizing-content ml-1 max-h-40 min-h-11 min-w-0 flex-1 resize-none rounded-[22px] border border-line bg-canvas px-4 py-2.5 text-[16px] leading-6 text-ink outline-none transition placeholder:text-muted hover:border-line-strong focus:border-brand focus:bg-surface focus:ring-3 focus:ring-brand/15 disabled:opacity-60"
        />
        <button
          type="submit"
          hidden={attachmentActive}
          disabled={disabled || !value.trim()}
          aria-label="Send message"
          className="ml-1 flex h-11 min-w-11 shrink-0 items-center justify-center gap-1.5 rounded-full bg-brand px-3 text-sm font-semibold text-white transition hover:bg-brand-dark disabled:cursor-not-allowed disabled:bg-brand/35 sm:px-5"
        >
          <span className="sr-only sm:not-sr-only">Send</span>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M4.5 12h14M13 6l6 6-6 6" />
          </svg>
        </button>
      </div>
      {locationOpen && onSendLocation ? (
        <LocationPicker onSend={(l) => void onSendLocation(l)} onClose={() => setLocationOpen(false)} />
      ) : null}
    </form>
  );
}
