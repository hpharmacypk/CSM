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
import type { Message, SenderRole } from "@/lib/types";
import { formatDay, formatTime } from "./format";
import { ChatImage } from "./ChatImage";
import { LocationCard } from "./LocationCard";
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
  /** Shared pinned message id and the row as this viewer may see it. */
  pinnedId: string | null;
  pinnedMessage: Message | null;
  onPin: (messageId: string) => Promise<string | null>;
  onUnpin: () => Promise<string | null>;
  /** Loads the message (and anything newer than it) if it isn't loaded yet. */
  onEnsureLoaded: (messageId: string) => Promise<boolean>;
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
  pinnedId,
  pinnedMessage,
  onPin,
  onUnpin,
  onEnsureLoaded,
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
  const [replacePinFor, setReplacePinFor] = useState<DisplayMessage | null>(null);
  const [highlightId, setHighlightId] = useState<string | null>(null);

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

  // Keep the newest message in view when the thread shrinks (e.g. the mobile
  // keyboard opens or the composer grows) while the reader is at the bottom.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    let lastHeight = el.clientHeight;
    const ro = new ResizeObserver(() => {
      const h = el.clientHeight;
      if (h < lastHeight && nearBottom.current) el.scrollTop = el.scrollHeight;
      lastHeight = h;
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

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

  /** Tap on the pinned banner: load the original message if needed, then scroll to it. */
  const jumpToPinned = async () => {
    if (!pinnedMessage) return;
    const id = pinnedMessage.id;
    setBusy(true);
    const ok = await onEnsureLoaded(id);
    setBusy(false);
    if (!ok) {
      setNotice("That message is no longer available.");
      return;
    }
    // Wait for the (possibly prepended) history to render.
    for (let i = 0; i < 20; i++) {
      const el = scrollRef.current?.querySelector(`[data-message-id="${id}"]`);
      if (el) {
        nearBottom.current = false;
        el.scrollIntoView({ block: "center" });
        setHighlightId(id);
        window.setTimeout(() => setHighlightId((h) => (h === id ? null : h)), 2000);
        return;
      }
      // Timeouts (not animation frames) so this also completes in a background tab.
      await new Promise((r) => setTimeout(r, 50));
    }
  };

  const requestPin = (m: DisplayMessage) => {
    setMenuFor(null);
    if (pinnedId && pinnedId !== m.id) {
      setReplacePinFor(m); // confirm before replacing the current pin
      return;
    }
    void runAction(() => onPin(m.id as string));
  };

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
        <div
          className="absolute inset-x-3 top-2 z-20 mx-auto flex max-w-md items-center justify-center gap-3 rounded-xl border border-danger/20 bg-danger-soft px-4 py-2 text-xs text-danger shadow-pop"
          role="alert"
        >
          <span className="min-w-0 flex-1">{notice}</span>
          <button type="button" className="shrink-0 rounded font-semibold underline" onClick={() => setNotice(null)}>
            Dismiss
          </button>
        </div>
      ) : null}

      {pinnedMessage ? (
        <div className="flex items-stretch border-b border-line bg-surface" data-testid="pinned-banner">
          <button
            type="button"
            onClick={() => void jumpToPinned()}
            className="flex min-w-0 flex-1 items-center gap-3 px-4 py-2 text-left transition hover:bg-subtle sm:px-6"
            aria-label="Go to pinned message"
          >
            <span aria-hidden className="h-8 w-1 shrink-0 rounded-full bg-pin" />
            <span className="min-w-0">
              <span className="flex items-center gap-1 text-[11px] font-semibold text-pin">
                <PinIcon size={12} />
                Pinned message
              </span>
              <span className="block truncate text-sm text-ink">{pinnedPreview(pinnedMessage)}</span>
            </span>
          </button>
          <button
            type="button"
            onClick={() => void runAction(onUnpin)}
            disabled={busy}
            className="m-1.5 shrink-0 rounded-lg px-3 text-xs font-medium text-muted transition hover:bg-subtle hover:text-ink disabled:opacity-50 sm:mr-4"
            aria-label="Unpin message"
          >
            Unpin
          </button>
        </div>
      ) : null}

      <div
        ref={scrollRef}
        onScroll={onScroll}
        className="hp-scroll flex-1 overflow-y-auto overscroll-contain px-3 pt-3 pb-4 sm:px-6"
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
              className="rounded-full border border-line bg-surface px-4 py-1.5 text-xs font-medium text-ink shadow-bubble transition hover:border-line-strong disabled:opacity-60"
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
                    <li className="my-4 flex items-center gap-3 first:mt-1" aria-label={day}>
                      <span aria-hidden className="h-px flex-1 bg-line" />
                      <span className="rounded-full border border-line bg-surface px-3 py-0.5 text-[11px] font-medium text-muted">
                        {day}
                      </span>
                      <span aria-hidden className="h-px flex-1 bg-line" />
                    </li>
                  ) : null}
                  <li
                    className={`group -mx-2 flex rounded-xl px-2 transition-colors duration-700 ${mine ? "justify-end" : "justify-start"} ${grouped ? "pt-0.5" : "pt-2.5"} ${
                      highlightId !== null && highlightId === m.id ? "bg-pin-soft" : ""
                    }`}
                    data-message-id={m.id ?? undefined}
                  >
                    <div
                      className={`flex max-w-[86%] flex-col sm:max-w-[72%] ${mine ? "items-end" : "items-start"}`}
                    >
                      {!mine && !grouped ? (
                        <span className="mb-1 px-1 text-xs font-semibold text-brand-ink">
                          {otherPartyLabel}
                        </span>
                      ) : null}
                      <div className={`relative flex items-center gap-1 ${mine ? "flex-row-reverse" : ""}`}>
                        {m.deleted ? (
                          <div className="flex items-center gap-1.5 rounded-2xl border border-dashed border-line-strong px-3.5 py-2 text-sm italic text-muted">
                            <BlockIcon />
                            This message was deleted
                          </div>
                        ) : (
                          <div
                            className={`whitespace-pre-wrap break-words text-[15px] leading-[1.4] shadow-bubble ${
                              m.type === "image"
                                ? "rounded-2xl border border-line bg-surface p-1"
                                : mine
                                  ? `rounded-[18px] bg-brand text-white ${grouped ? "" : "rounded-tr-md"}`
                                  : `rounded-[18px] border border-line bg-surface text-ink ${grouped ? "" : "rounded-tl-md"}`
                            } ${m.status === "failed" ? "opacity-70" : ""} ${m.type === "text" ? "px-3.5 py-2" : ""} ${m.type === "audio" ? "py-2 pr-3 pl-2" : ""} ${m.type === "location" ? "p-3" : ""}`}
                          >
                            {m.type === "location" ? (
                              <LocationCard
                                latitude={m.latitude}
                                longitude={m.longitude}
                                accuracyM={m.accuracyM}
                                mine={mine}
                              />
                            ) : m.type === "image" ? (
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
                                mine={mine}
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
                              className={`flex h-8 w-8 items-center justify-center rounded-full text-muted transition hover:bg-subtle hover:text-ink focus-visible:opacity-100 ${
                                menuOpen ? "bg-subtle text-ink opacity-100" : "opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 [@media(hover:none)]:opacity-70"
                              }`}
                            >
                              <DotsIcon />
                            </button>
                            {menuOpen ? (
                              <div
                                role="menu"
                                // Open over the bubble (the options button sits on the
                                // bubble's outer side), so the menu never leaves the screen.
                                className={`absolute bottom-full z-30 mb-1 w-max max-w-[calc(100vw-2rem)] min-w-48 overflow-hidden rounded-xl border border-line bg-surface p-1 text-sm shadow-pop ${
                                  mine ? "left-0" : "right-0"
                                }`}
                              >
                                {!m.deleted ? (
                                  m.id === pinnedId ? (
                                    <button
                                      type="button"
                                      role="menuitem"
                                      disabled={busy}
                                      onClick={() => {
                                        setMenuFor(null);
                                        void runAction(onUnpin);
                                      }}
                                      className="block w-full rounded-lg px-3 py-2.5 text-left text-ink transition hover:bg-subtle disabled:opacity-50"
                                    >
                                      Unpin message
                                    </button>
                                  ) : (
                                    <button
                                      type="button"
                                      role="menuitem"
                                      disabled={busy}
                                      onClick={() => requestPin(m)}
                                      className="block w-full rounded-lg px-3 py-2.5 text-left text-ink transition hover:bg-subtle disabled:opacity-50"
                                    >
                                      Pin message
                                    </button>
                                  )
                                ) : null}
                                <button
                                  type="button"
                                  role="menuitem"
                                  disabled={busy}
                                  onClick={() => {
                                    setMenuFor(null);
                                    void runAction(() => onHideForMe(m.id as string));
                                  }}
                                  className="block w-full rounded-lg px-3 py-2.5 text-left text-ink transition hover:bg-subtle disabled:opacity-50"
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
                                    className="block w-full rounded-lg px-3 py-2.5 text-left font-medium text-danger transition hover:bg-danger-soft disabled:opacity-50"
                                  >
                                    Delete for everyone
                                  </button>
                                ) : null}
                              </div>
                            ) : null}
                          </div>
                        ) : null}
                      </div>
                      <div className={`mt-1 flex flex-wrap items-center gap-x-2 px-1 text-[11px] leading-4 text-muted ${mine ? "justify-end" : ""}`}>
                        {m.status === "sending" ? (
                          <span>{m.type === "text" ? "Sending…" : "Uploading…"}</span>
                        ) : null}
                        {m.status === "failed" ? (
                          <>
                            <span className="font-medium text-danger">{m.failReason ?? "Not sent"}</span>
                            <button
                              type="button"
                              onClick={() => onRetry(m.clientMessageId)}
                              className="rounded-full bg-brand-soft px-2 py-0.5 font-semibold text-brand-ink hover:bg-brand hover:text-white"
                            >
                              Retry
                            </button>
                            <button
                              type="button"
                              onClick={() => onDiscard(m.clientMessageId)}
                              className="rounded-full px-1.5 py-0.5 underline hover:text-ink"
                            >
                              Remove
                            </button>
                          </>
                        ) : null}
                        {m.status === "sent" && m.id !== null && m.id === pinnedId && !m.deleted ? (
                          <span className="inline-flex items-center gap-0.5 font-medium text-pin">
                            <PinIcon size={11} />
                            Pinned
                          </span>
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
          className="absolute bottom-3 left-1/2 z-10 inline-flex -translate-x-1/2 items-center gap-1.5 rounded-full bg-brand py-1.5 pr-3 pl-2 text-xs font-semibold text-white shadow-pop transition hover:bg-brand-dark"
        >
          <span className="flex h-5 min-w-5 items-center justify-center rounded-full bg-white px-1 text-[11px] font-bold text-brand-ink">
            {unseenCount}
          </span>
          new message{unseenCount === 1 ? "" : "s"}
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M12 5v14M6 13l6 6 6-6" />
          </svg>
        </button>
      ) : null}

      {replacePinFor ? (
        <div
          className="fixed inset-0 z-50 flex items-end justify-center bg-ink/45 backdrop-blur-[2px] p-4 sm:items-center"
          role="dialog"
          aria-modal="true"
          aria-labelledby="replace-pin-title"
          onClick={() => !busy && setReplacePinFor(null)}
        >
          <div className="w-full max-w-sm rounded-2xl border border-line bg-surface p-5 shadow-dialog" onClick={(e) => e.stopPropagation()}>
            <h2 id="replace-pin-title" className="text-base font-semibold text-ink">
              Replace pinned message?
            </h2>
            <p className="mt-1 text-sm text-muted">
              Only one message can be pinned. The current pin
              {pinnedMessage ? <> (&ldquo;{pinnedPreview(pinnedMessage)}&rdquo;)</> : null} will be replaced for you and{" "}
              {otherPartyLabel === "Customer" ? "the customer" : otherPartyLabel}.
            </p>
            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                disabled={busy}
                onClick={() => setReplacePinFor(null)}
                className="h-10 rounded-full border border-line px-4 text-sm font-medium text-muted hover:bg-subtle"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  const target = replacePinFor;
                  void runAction(async () => {
                    const err = await onPin(target.id as string);
                    setReplacePinFor(null);
                    return err;
                  });
                }}
                className="h-10 rounded-full bg-brand px-4 text-sm font-semibold text-white disabled:opacity-60"
              >
                Replace pin
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {confirmFor ? (
        <div
          className="fixed inset-0 z-50 flex items-end justify-center bg-ink/45 backdrop-blur-[2px] p-4 sm:items-center"
          role="dialog"
          aria-modal="true"
          aria-labelledby="delete-everyone-title"
          onClick={() => !busy && setConfirmFor(null)}
        >
          <div className="w-full max-w-sm rounded-2xl border border-line bg-surface p-5 shadow-dialog" onClick={(e) => e.stopPropagation()}>
            <h2 id="delete-everyone-title" className="text-base font-semibold text-ink">
              Delete for everyone?
            </h2>
            <p className="mt-1 text-sm text-muted">
              This {confirmFor.type === "image" ? "photo" : confirmFor.type === "audio" ? "voice note" : confirmFor.type === "location" ? "location" : "message"} will be replaced with
              &ldquo;This message was deleted&rdquo; for you and {otherPartyLabel === "Customer" ? "the customer" : otherPartyLabel}. This can&apos;t be undone.
            </p>
            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                disabled={busy}
                onClick={() => setConfirmFor(null)}
                className="h-10 rounded-full border border-line px-4 text-sm font-medium text-muted hover:bg-subtle"
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

/** One-line preview of a pinned message (content already filtered by RLS). */
function pinnedPreview(m: Message): string {
  switch (m.type) {
    case "image":
      return "Photo";
    case "audio":
      return "Voice note";
    case "location":
      return "Shared location";
    default:
      return (m.body ?? "").replace(/\s+/g, " ").slice(0, 120);
  }
}

export function PinIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M15.2 2.6a1 1 0 0 1 1.4 0l4.8 4.8a1 1 0 0 1 0 1.4l-1.1 1.1a1 1 0 0 1-1 .25l-.6-.2-3.3 3.3.4 2.6a1 1 0 0 1-.28.86l-1.2 1.2a1 1 0 0 1-1.4 0l-3.2-3.2-4.5 4.5a1 1 0 0 1-1.4-1.4l4.5-4.5-3.2-3.2a1 1 0 0 1 0-1.4l1.2-1.2a1 1 0 0 1 .86-.28l2.6.4 3.3-3.3-.2-.6a1 1 0 0 1 .25-1z" />
    </svg>
  );
}

function BlockIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
      <circle cx="12" cy="12" r="9" />
      <path d="M5.7 5.7l12.6 12.6" />
    </svg>
  );
}
