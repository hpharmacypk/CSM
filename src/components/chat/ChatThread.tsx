"use client";

import {
  Fragment,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { DisplayMessage } from "@/lib/chat/use-conversation-messages";
import type { SenderRole } from "@/lib/types";
import { formatDay, formatTime } from "./format";
import { ChatImage } from "./ChatImage";
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
  /** Newest message seq the reader has actually seen (tab visible, scrolled to it). */
  onViewed: (seq: number) => void;
  onHideForMe: (messageId: string) => Promise<string | null>;
  onDeleteForEveryone: (messageId: string) => Promise<string | null>;
  emptyState: ReactNode;
  otherPartyLabel: string;
};

const NEAR_BOTTOM_PX = 80;

export function ChatThread({
  supabase,
  messages,
  viewerRole,
  hasOlder,
  loadingOlder,
  onLoadOlder,
  onRetry,
  onDiscard,
  onViewed,
  onHideForMe,
  onDeleteForEveryone,
  emptyState,
  otherPartyLabel,
}: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const prevFirstKey = useRef<string | null>(null);
  const prevLastKey = useRef<string | null>(null);
  const prevScrollHeight = useRef(0);
  const nearBottom = useRef(true);
  const viewedSeq = useRef(0);
  const [unseenCount, setUnseenCount] = useState(0);
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [confirmFor, setConfirmFor] = useState<DisplayMessage | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const latestConfirmedSeq = useCallback(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      const s = messages[i].seq;
      if (s !== null) return s;
    }
    return 0;
  }, [messages]);

  /** Report "viewed" only when the reader can actually see the newest message. */
  const reportIfViewed = useCallback(() => {
    if (typeof document === "undefined" || document.visibilityState !== "visible") return;
    if (!nearBottom.current) return;
    const seq = latestConfirmedSeq();
    if (seq > viewedSeq.current) {
      viewedSeq.current = seq;
      onViewed(seq);
    }
    setUnseenCount(0);
  }, [latestConfirmedSeq, onViewed]);

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
        nearBottom.current = true;
      }
    }
    prevFirstKey.current = first;
    prevLastKey.current = last;
    prevScrollHeight.current = el.scrollHeight;
  }, [messages, viewerRole]);

  // After each render: mark read if visible, otherwise count unseen incoming.
  useEffect(() => {
    const id = requestAnimationFrame(() => {
      if (nearBottom.current && document.visibilityState === "visible") {
        reportIfViewed();
      } else {
        const unseen = messages.filter(
          (m) => m.seq !== null && m.seq > viewedSeq.current && m.senderRole !== viewerRole && !m.deleted,
        ).length;
        setUnseenCount(unseen);
      }
    });
    return () => cancelAnimationFrame(id);
  }, [messages, viewerRole, reportIfViewed]);

  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === "visible") reportIfViewed();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [reportIfViewed]);

  // Close the message menu on outside tap / Escape.
  useEffect(() => {
    if (!menuFor) return;
    const close = (e: Event) => {
      if (e instanceof KeyboardEvent && e.key !== "Escape") return;
      if (e.target instanceof Element && e.target.closest("[data-message-menu]")) return;
      setMenuFor(null);
    };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", close);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", close);
    };
  }, [menuFor]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    nearBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM_PX;
    prevScrollHeight.current = el.scrollHeight;
    if (nearBottom.current) reportIfViewed();
  };

  const jumpToLatest = () => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    nearBottom.current = true;
    reportIfViewed();
  };

  const runAction = async (fn: () => Promise<string | null>) => {
    setBusy(true);
    const err = await fn();
    setBusy(false);
    setNotice(err);
  };

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      {notice ? (
        <div className="absolute inset-x-0 top-0 z-20 flex items-center justify-center gap-3 bg-red-50 px-4 py-2 text-xs text-danger" role="alert">
          {notice}
          <button type="button" className="underline" onClick={() => setNotice(null)}>
            Dismiss
          </button>
        </div>
      ) : null}

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
              const canMenu = m.status === "sent" && m.id !== null;
              const menuOpen = canMenu && menuFor === m.id;
              return (
                <Fragment key={m.key}>
                  {showDay ? (
                    <li className="my-3 text-center text-[11px] font-medium uppercase tracking-wide text-muted">
                      {day}
                    </li>
                  ) : null}
                  <li
                    className={`group flex ${mine ? "justify-end" : "justify-start"} ${grouped ? "" : "mt-2"}`}
                    data-message-id={m.id ?? undefined}
                  >
                    <div
                      className={`flex max-w-[85%] flex-col sm:max-w-[70%] ${mine ? "items-end" : "items-start"}`}
                    >
                      {!mine && !grouped ? (
                        <span className="mb-0.5 px-1 text-[11px] font-medium text-muted">
                          {otherPartyLabel}
                        </span>
                      ) : null}
                      <div className={`relative flex items-center gap-1 ${mine ? "flex-row-reverse" : ""}`}>
                        {m.deleted ? (
                          <div className="rounded-2xl border border-dashed border-line bg-surface px-3.5 py-2 text-[14px] italic text-muted">
                            This message was deleted
                          </div>
                        ) : (
                          <div
                            className={`whitespace-pre-wrap break-words rounded-2xl px-3.5 py-2 text-[15px] leading-snug shadow-sm ${
                              mine
                                ? "rounded-br-md bg-brand text-white"
                                : "rounded-bl-md border border-line bg-surface text-ink"
                            } ${m.status === "failed" ? "opacity-70" : ""} ${m.type === "audio" ? "px-2 py-2" : ""} ${m.type === "image" ? "p-1" : ""}`}
                          >
                            {m.type === "image" ? (
                              <ChatImage
                                supabase={supabase}
                                path={m.attachmentPath}
                                localUrl={m.localUrl}
                                width={m.width}
                                height={m.height}
                              />
                            ) : m.type === "audio" ? (
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
                        )}

                        {canMenu ? (
                          <div className="relative shrink-0" data-message-menu>
                            <button
                              type="button"
                              aria-label="Message options"
                              aria-haspopup="menu"
                              aria-expanded={menuOpen}
                              onClick={() => setMenuFor(menuOpen ? null : m.id)}
                              className={`flex h-8 w-8 items-center justify-center rounded-full text-muted hover:bg-black/5 focus:opacity-100 ${
                                menuOpen ? "opacity-100" : "opacity-0 group-hover:opacity-100 [@media(hover:none)]:opacity-60"
                              }`}
                            >
                              <DotsIcon />
                            </button>
                            {menuOpen ? (
                              <div
                                role="menu"
                                className={`absolute bottom-full z-30 mb-1 min-w-44 overflow-hidden rounded-xl border border-line bg-surface py-1 text-sm shadow-lg ${
                                  mine ? "right-0" : "left-0"
                                }`}
                              >
                                <button
                                  type="button"
                                  role="menuitem"
                                  disabled={busy}
                                  onClick={() => {
                                    setMenuFor(null);
                                    void runAction(() => onHideForMe(m.id as string));
                                  }}
                                  className="block w-full px-4 py-2.5 text-left text-ink hover:bg-canvas"
                                >
                                  Delete for me
                                </button>
                                {mine && !m.deleted ? (
                                  <button
                                    type="button"
                                    role="menuitem"
                                    disabled={busy}
                                    onClick={() => {
                                      setMenuFor(null);
                                      setConfirmFor(m);
                                    }}
                                    className="block w-full px-4 py-2.5 text-left text-danger hover:bg-canvas"
                                  >
                                    Delete for everyone
                                  </button>
                                ) : null}
                              </div>
                            ) : null}
                          </div>
                        ) : null}
                      </div>
                      <div className="mt-0.5 flex flex-wrap items-center gap-x-2 px-1 text-[11px] text-muted">
                        {m.status === "sending" ? (
                          <span>{m.type === "text" ? "Sending…" : "Uploading…"}</span>
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

      {unseenCount > 0 ? (
        <button
          type="button"
          onClick={jumpToLatest}
          className="absolute bottom-3 left-1/2 z-10 -translate-x-1/2 rounded-full bg-brand px-4 py-1.5 text-xs font-semibold text-white shadow-lg"
        >
          {unseenCount} new message{unseenCount === 1 ? "" : "s"} ↓
        </button>
      ) : null}

      {confirmFor ? (
        <div
          className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-4 sm:items-center"
          role="dialog"
          aria-modal="true"
          aria-labelledby="delete-everyone-title"
          onClick={() => !busy && setConfirmFor(null)}
        >
          <div className="w-full max-w-sm rounded-2xl bg-surface p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
            <h2 id="delete-everyone-title" className="text-base font-semibold text-ink">
              Delete for everyone?
            </h2>
            <p className="mt-1 text-sm text-muted">
              This {confirmFor.type === "image" ? "photo" : confirmFor.type === "audio" ? "voice note" : "message"} will be replaced with
              &ldquo;This message was deleted&rdquo; for you and {otherPartyLabel === "Customer" ? "the customer" : otherPartyLabel}. This can&apos;t be undone.
            </p>
            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                disabled={busy}
                onClick={() => setConfirmFor(null)}
                className="h-10 rounded-full border border-line px-4 text-sm font-medium text-muted hover:bg-canvas"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  const target = confirmFor;
                  void runAction(async () => {
                    const err = await onDeleteForEveryone(target.id as string);
                    setConfirmFor(null);
                    return err;
                  });
                }}
                className="h-10 rounded-full bg-danger px-4 text-sm font-semibold text-white disabled:opacity-60"
              >
                {busy ? "Deleting…" : "Delete for everyone"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function DotsIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <circle cx="5" cy="12" r="2" />
      <circle cx="12" cy="12" r="2" />
      <circle cx="19" cy="12" r="2" />
    </svg>
  );
}
