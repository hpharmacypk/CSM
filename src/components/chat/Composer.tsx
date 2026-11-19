"use client";

import { useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import type { VoiceRecording } from "@/lib/chat/voice";
import { VoiceRecorder } from "./VoiceRecorder";

const MAX_LENGTH = 4000;

export function Composer({
  onSend,
  onSendVoice,
  disabled,
  placeholder = "Type a message",
}: {
  onSend: (body: string) => Promise<boolean> | void;
  onSendVoice?: (recording: VoiceRecording) => Promise<boolean> | void;
  disabled?: boolean;
  placeholder?: string;
}) {
  const [value, setValue] = useState("");
  const [voiceActive, setVoiceActive] = useState(false);
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
      className="border-t border-line bg-surface px-3 pt-2.5 pb-[max(0.625rem,env(safe-area-inset-bottom))] sm:px-6"
    >
      <div className="mx-auto flex max-w-3xl items-end gap-2">
        {onSendVoice ? (
          <VoiceRecorder
            onSend={(r) => void onSendVoice(r)}
            onActiveChange={setVoiceActive}
            disabled={disabled}
          />
        ) : null}
        <label htmlFor="composer" className="sr-only">
          Message
        </label>
        <textarea
          hidden={voiceActive}
          id="composer"
          ref={ref}
          rows={1}
          value={value}
          maxLength={MAX_LENGTH}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={placeholder}
          disabled={disabled}
          className="field-sizing-content max-h-40 min-h-11 flex-1 resize-none rounded-2xl border border-line bg-canvas px-4 py-2.5 text-[16px] text-ink outline-none placeholder:text-muted focus:border-brand focus:ring-2 focus:ring-brand/20 disabled:opacity-60"
        />
        <button
          type="submit"
          hidden={voiceActive}
          disabled={disabled || !value.trim()}
          className="h-11 shrink-0 rounded-full bg-brand px-5 text-sm font-semibold text-white transition hover:bg-brand-dark disabled:cursor-not-allowed disabled:opacity-40"
        >
          Send
        </button>
      </div>
    </form>
  );
}
