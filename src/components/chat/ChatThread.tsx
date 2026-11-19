"use client";

import { Fragment, useLayoutEffect, useRef, type ReactNode } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { DisplayMessage } from "@/lib/chat/use-conversation-messages";
import type { SenderRole } from "@/lib/types";
import { formatDay, formatTime } from "./format";
import { VoiceNotePlayer } from "./VoiceNotePlayer";

type Props = {
  supabase: SupabaseClient;
  messages: DisplayMessage[];
  viewerRole: SenderRole;
  hasOlder: boolean;
  loadingOlder: boolean;
  onLoadOlder: () => void;
  onRetry: (clientMessageId: string) => void;
  onDiscard: (clientMessageId: string) => void;
  emptyState: ReactNode;
  otherPartyLabel: string;
};

export function ChatThread({
  supabase,
  messages,
  viewerRole,
  hasOlder,
  loadingOlder,
  onLoadOlder,
  onRetry,
  onDiscard,
  emptyState,
  otherPartyLabel,
}: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const prevFirstKey = useRef<string | null>(null);
  const prevLastKey = useRef<string | null>(null);
  const prevScrollHeight = useRef(0);
  const nearBottom = useRef(true);

  // Stay pinned to the newest message; keep the position stable when older
  // history is prepended.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const first = messages[0]?.key ?? null;
    const last = messages[messages.length - 1]?.key ?? null;
    const prepended =
      prevFirstKey.current !== null && first !== prevFirstKey.current && last === prevLastKey.current;
    if (prepended) {
      el.scrollTop += el.scrollHeight - prevScrollHeight.current;
    } else if (last !== prevLastKey.current) {
      const mine = messages[messages.length - 1]?.senderRole === viewerRole;
      if (nearBottom.current || mine || prevLastKey.current === null) {
        el.scrollTop = el.scrollHeight;
      }
    }
    prevFirstKey.current = first;
    prevLastKey.current = last;
    prevScrollHeight.current = el.scrollHeight;
  }, [messages, viewerRole]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    nearBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
    prevScrollHeight.current = el.scrollHeight;
  };

  return (
    <div
      ref={scrollRef}
      onScroll={onScroll}
      className="flex-1 overflow-y-auto overscroll-contain px-3 py-4 sm:px-6"
      role="log"
      aria-live="polite"
      aria-relevant="additions"
    >
      {hasOlder ? (
        <div className="mb-4 flex justify-center">
          <button
            type="button"
            onClick={onLoadOlder}
            disabled={loadingOlder}
            className="rounded-full border border-line bg-surface px-4 py-1.5 text-xs font-medium text-muted hover:bg-canvas disabled:opacity-60"
          >
            {loadingOlder ? "Loading…" : "Load earlier messages"}
          </button>
        </div>
      ) : null}

      {messages.length === 0 ? (
        <div className="flex h-full items-center justify-center">{emptyState}</div>
      ) : (
        <ol className="mx-auto flex max-w-3xl flex-col gap-1">
          {messages.map((m, i) => {
            const mine = m.senderRole === viewerRole;
            const day = formatDay(m.createdAt);
            const showDay = i === 0 || formatDay(messages[i - 1].createdAt) !== day;
            const grouped = i > 0 && !showDay && messages[i - 1].senderRole === m.senderRole;
            return (
              <Fragment key={m.key}>
                {showDay ? (
                  <li className="my-3 text-center text-[11px] font-medium uppercase tracking-wide text-muted">
                    {day}
                  </li>
                ) : null}
                <li className={`flex ${mine ? "justify-end" : "justify-start"} ${grouped ? "" : "mt-2"}`}>
                  <div
                    className={`flex max-w-[85%] flex-col sm:max-w-[70%] ${mine ? "items-end" : "items-start"}`}
                  >
                    {!mine && !grouped ? (
                      <span className="mb-0.5 px-1 text-[11px] font-medium text-muted">
                        {otherPartyLabel}
                      </span>
                    ) : null}
                    <div
                      className={`whitespace-pre-wrap break-words rounded-2xl px-3.5 py-2 text-[15px] leading-snug shadow-sm ${
                        mine
                          ? "rounded-br-md bg-brand text-white"
                          : "rounded-bl-md border border-line bg-surface text-ink"
                      } ${m.status === "failed" ? "opacity-70" : ""} ${m.type === "audio" ? "px-2 py-2" : ""}`}
                    >
                      {m.type === "audio" ? (
                        <VoiceNotePlayer
                          supabase={supabase}
                          path={m.attachmentPath}
                          localUrl={m.localUrl}
                          mime={m.attachmentMime}
                          durationMs={m.durationMs}
                        />
                      ) : (
                        m.body
                      )}
                    </div>
                    <div className="mt-0.5 flex flex-wrap items-center gap-x-2 px-1 text-[11px] text-muted">
                      {m.status === "sending" ? (
                        <span>{m.type === "audio" ? "Uploading…" : "Sending…"}</span>
                      ) : null}
                      {m.status === "failed" ? (
                        <>
                          <span className="text-danger">{m.failReason ?? "Not sent"}</span>
                          <button
                            type="button"
                            onClick={() => onRetry(m.clientMessageId)}
                            className="font-medium text-brand underline"
                          >
                            Retry
                          </button>
                          <button
                            type="button"
                            onClick={() => onDiscard(m.clientMessageId)}
                            className="underline"
                          >
                            Remove
                          </button>
                        </>
                      ) : null}
                      {m.status === "sent" ? (
                        <time dateTime={m.createdAt}>{formatTime(m.createdAt)}</time>
                      ) : null}
                    </div>
                  </div>
                </li>
              </Fragment>
            );
          })}
        </ol>
      )}
    </div>
  );
}
