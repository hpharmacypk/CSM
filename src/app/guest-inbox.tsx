"use client";

import { useCallback, useEffect, useState } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import { Brand } from "@/components/Brand";
import { BlockedNotice, ChatThread } from "@/components/chat/ChatThread";
import { Composer } from "@/components/chat/Composer";
import { ConnectionBadge } from "@/components/chat/ConnectionBadge";
import { CHAT_EVENTS, useConversationMessages } from "@/lib/chat/use-conversation-messages";
import { isSupabaseConfigured } from "@/lib/supabase/config";
import { getGuestClient } from "@/lib/supabase/guest-client";
import { GuestProfileButton } from "./guest-profile";

const BASE_TITLE = "H-Pharmacy Support";

type ConversationRowState = { customer_unread_count?: number; customer_archived_at?: string | null };

/**
 * The guest's own conversation row: unread count (also shown in the browser tab
 * title) and the customer-side archive state. Loaded from the database (so it
 * survives a refresh), kept live through Realtime and set immediately from
 * mark-read / archive results.
 */
function useGuestConversationState(supabase: SupabaseClient, conversationId: string) {
  const [unread, setUnread] = useState(0);
  const [archivedAt, setArchivedAt] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [archiveSupported, setArchiveSupported] = useState(true);

  useEffect(() => {
    let active = true;
    const apply = (row: ConversationRowState) => {
      if (!active) return;
      if (typeof row.customer_unread_count === "number") setUnread(row.customer_unread_count);
      if (row.customer_archived_at !== undefined) setArchivedAt(row.customer_archived_at);
    };
    void (async () => {
      let { data, error } = await supabase
        .from("conversations")
        .select("customer_unread_count, customer_archived_at")
        .eq("id", conversationId)
        .maybeSingle();
      if (error) {
        // Database without the archiving migration yet: keep the unread badge
        // working and hide the archive control.
        ({ data, error } = await supabase
          .from("conversations")
          .select("customer_unread_count")
          .eq("id", conversationId)
          .maybeSingle());
        if (active) setArchiveSupported(false);
      }
      if (data) apply(data as ConversationRowState);
      if (active) setLoaded(true);
    })();
    const channel = supabase
      .channel(`guest-conversation:${conversationId}:${crypto.randomUUID()}`)
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "conversations", filter: `id=eq.${conversationId}` },
        (payload) => apply(payload.new as ConversationRowState),
      )
      .subscribe();
    const onRead = (e: Event) => {
      const d = (e as CustomEvent<{ conversationId: string; unread: number }>).detail;
      if (d.conversationId === conversationId) apply({ customer_unread_count: d.unread });
    };
    window.addEventListener(CHAT_EVENTS.read, onRead);
    return () => {
      active = false;
      window.removeEventListener(CHAT_EVENTS.read, onRead);
      void supabase.removeChannel(channel);
    };
  }, [supabase, conversationId]);

  useEffect(() => {
    document.title = unread > 0 ? `(${unread}) ${BASE_TITLE}` : BASE_TITLE;
    return () => {
      document.title = BASE_TITLE;
    };
  }, [unread]);

  return { unread, archivedAt, setArchivedAt, loaded, archiveSupported };
}

type BootState =
  | { kind: "starting" }
  | { kind: "ready"; supabase: SupabaseClient; conversationId: string }
  | { kind: "error"; message: string };

/** Serialize first-visit setup across tabs so two tabs don't create two guests. */
async function withBootLock<T>(fn: () => Promise<T>): Promise<T> {
  if (typeof navigator !== "undefined" && navigator.locks) {
    return navigator.locks.request("hp-guest-bootstrap", fn);
  }
  return fn();
}

function isAuthError(error: { code?: string; message?: string; status?: number } | null) {
  if (!error) return false;
  return (
    error.status === 401 ||
    error.code === "PGRST301" ||
    error.code === "PGRST303" ||
    /jwt|token|not signed in/i.test(error.message ?? "")
  );
}

async function bootstrapGuest(supabase: SupabaseClient): Promise<string> {
  return withBootLock(async () => {
    for (let attempt = 0; attempt < 2; attempt++) {
      const { data: sessionData } = await supabase.auth.getSession();
      if (!sessionData.session) {
        const { error } = await supabase.auth.signInAnonymously();
        if (error) throw new Error(`Could not start a chat session: ${error.message}`);
      }
      const { data, error } = await supabase.rpc("get_or_create_my_conversation");
      if (!error && typeof data === "string") return data;

      if (attempt === 0 && isAuthError(error)) {
        // The stored session is no longer valid: start a fresh guest inbox.
        // (The previous conversation remains in the admin dashboard.)
        await supabase.auth.signOut({ scope: "local" });
        continue;
      }
      throw new Error(error?.message ?? "Could not open your inbox.");
    }
    throw new Error("Could not open your inbox.");
  });
}

const NOT_CONFIGURED: BootState = {
  kind: "error",
  message: "Chat is not configured yet. Add the Supabase settings to .env.local.",
};

export function GuestInbox() {
  const [boot, setBoot] = useState<BootState>(() =>
    isSupabaseConfigured() ? { kind: "starting" } : NOT_CONFIGURED,
  );

  const start = useCallback(async () => {
    if (!isSupabaseConfigured()) return;
    try {
      const supabase = getGuestClient();
      const conversationId = await bootstrapGuest(supabase);
      setBoot({ kind: "ready", supabase, conversationId });
    } catch (e) {
      setBoot({ kind: "error", message: e instanceof Error ? e.message : String(e) });
    }
  }, []);

  useEffect(() => {
    // Runs once in the browser; state updates happen asynchronously.
    let active = true;
    queueMicrotask(() => {
      if (active) void start();
    });
    return () => {
      active = false;
    };
  }, [start]);

  if (boot.kind === "ready") {
    return <GuestReady key={boot.conversationId} supabase={boot.supabase} conversationId={boot.conversationId} />;
  }

  return (
    <GuestFrame>
        {boot.kind === "starting" ? (
          <CenteredNote>
            <Spinner />
            Opening your inbox…
          </CenteredNote>
        ) : boot.kind === "error" ? (
          <CenteredNote>
            <p className="mb-4 max-w-xs text-ink">{boot.message}</p>
            <button
              type="button"
              onClick={() => {
                setBoot({ kind: "starting" });
                void start();
              }}
              className="h-10 rounded-full bg-brand px-5 text-sm font-semibold text-white transition hover:bg-brand-dark"
            >
              Try again
            </button>
          </CenteredNote>
        ) : null}
    </GuestFrame>
  );
}

/**
 * The guest's open inbox: chat, customer-side archive and the "deleted"
 * state. One owner for the chat hook so nothing is reloaded from stale state.
 */
function GuestReady({ supabase, conversationId }: { supabase: SupabaseClient; conversationId: string }) {
  const chat = useConversationMessages(supabase, conversationId, "customer");
  const state = useGuestConversationState(supabase, conversationId);
  const [archiveBusy, setArchiveBusy] = useState(false);
  const [archiveError, setArchiveError] = useState<string | null>(null);

  const setArchived = async (archived: boolean) => {
    setArchiveBusy(true);
    setArchiveError(null);
    const { data, error } = await supabase.rpc("set_my_conversation_archived", { p_archived: archived });
    setArchiveBusy(false);
    if (error) {
      setArchiveError(archived ? "Couldn't archive the chat. Try again." : "Couldn't unarchive the chat. Try again.");
      return;
    }
    state.setArchivedAt((data as string | null) ?? null);
  };

  if (chat.gone) {
    return (
      <GuestFrame>
        <CenteredNote>
          <span aria-hidden className="flex h-14 w-14 items-center justify-center rounded-2xl border border-line bg-surface text-muted shadow-bubble">
            <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <path d="M20 12a8 8 0 0 1-11.6 7.1L4 20l1-4.1A8 8 0 1 1 20 12z" />
              <path d="M9 10l6 6M15 10l-6 6" />
            </svg>
          </span>
          <div role="status">
            <p className="text-base font-semibold text-ink">This conversation is no longer available.</p>
            <p className="mt-1 max-w-xs text-sm text-muted">
              It was removed by H-Pharmacy. You can start a new chat at any time.
            </p>
          </div>
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="h-10 rounded-full bg-brand px-5 text-sm font-semibold text-white transition hover:bg-brand-dark"
          >
            Start a new chat
          </button>
        </CenteredNote>
      </GuestFrame>
    );
  }

  const archived = !!state.archivedAt;
  return (
    <GuestFrame
      headerAction={
        <div className="flex min-w-0 items-center gap-1.5">
          {state.loaded && state.archiveSupported && !archived ? (
            <button
              type="button"
              onClick={() => void setArchived(true)}
              disabled={archiveBusy}
              aria-label="Archive chat"
              title="Archive chat"
              className="flex h-10 shrink-0 items-center gap-1.5 rounded-full px-2.5 text-sm font-medium text-muted transition hover:bg-subtle hover:text-ink disabled:opacity-50"
            >
              <ArchiveGlyph />
              <span className="hidden sm:inline">Archive</span>
            </button>
          ) : null}
          <GuestProfileButton supabase={supabase} />
        </div>
      }
    >
      {archiveError ? (
        <div className="shrink-0 border-b border-danger/15 bg-danger-soft px-4 py-2 text-center text-xs text-danger" role="alert">
          {archiveError}
        </div>
      ) : null}
      {archived ? (
        <ArchivedView unread={state.unread} busy={archiveBusy} onUnarchive={() => void setArchived(false)} />
      ) : (
        <GuestChat supabase={supabase} chat={chat} />
      )}
    </GuestFrame>
  );
}

function ArchivedView({ unread, busy, onUnarchive }: { unread: number; busy: boolean; onUnarchive: () => void }) {
  return (
    <main className="flex min-h-0 flex-1 items-center justify-center p-6 text-center">
      <div className="flex max-w-sm flex-col items-center gap-3" data-testid="archived-view">
        <span aria-hidden className="flex h-14 w-14 items-center justify-center rounded-2xl border border-line bg-surface text-brand shadow-bubble">
          <ArchiveGlyph size={26} />
        </span>
        <div>
          <h1 className="text-lg font-semibold tracking-tight text-ink">This chat is archived</h1>
          <p className="mt-1.5 text-sm leading-relaxed text-muted">
            Your messages, photos and voice notes are kept. New replies from H-Pharmacy still arrive here.
          </p>
        </div>
        {unread > 0 ? (
          <p className="inline-flex items-center gap-2 rounded-full bg-brand-soft px-3 py-1 text-sm font-semibold text-brand-ink" role="status">
            <span className="flex h-5 min-w-5 items-center justify-center rounded-full bg-brand px-1.5 text-[11px] font-bold text-white">
              {unread}
            </span>
            new {unread === 1 ? "reply" : "replies"}
          </p>
        ) : null}
        <button
          type="button"
          onClick={onUnarchive}
          disabled={busy}
          className="mt-1 h-11 rounded-full bg-brand px-6 text-sm font-semibold text-white transition hover:bg-brand-dark disabled:opacity-60"
        >
          {busy ? "Opening…" : "Unarchive chat"}
        </button>
      </div>
    </main>
  );
}

function ArchiveGlyph({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="3" y="4" width="18" height="4" rx="1" />
      <path d="M5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8M10 12h4" />
    </svg>
  );
}

/** Centered chat column with the compact branded header. */
function GuestFrame({ headerAction, children }: { headerAction?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="h-full bg-subtle">
      <div className="mx-auto flex h-full w-full max-w-3xl flex-col bg-canvas md:border-x md:border-line">
        <header className="flex h-14 shrink-0 items-center justify-between gap-3 border-b border-line bg-surface px-3 sm:h-16 sm:px-5">
          <Brand subtitle="Customer support" className="h-11 sm:h-12" subtitleOnMobile={false} />
          {headerAction}
        </header>
        {children}
      </div>
    </div>
  );
}

function GuestChat({
  supabase,
  chat,
}: {
  supabase: SupabaseClient;
  chat: ReturnType<typeof useConversationMessages>;
}) {
  return (
    <main className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center justify-between gap-3 border-b border-line bg-brand-soft/60 px-3 py-1.5 sm:px-5">
        <p className="flex min-w-0 items-center gap-1.5 text-xs text-brand-ink">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0" aria-hidden>
            <rect x="5" y="11" width="14" height="10" rx="2" />
            <path d="M8 11V8a4 4 0 0 1 8 0v3" />
          </svg>
          <span>
            Private to you and the H-Pharmacy team<span className="hidden sm:inline">. This chat stays available in this browser</span>.
          </span>
        </p>
        <ConnectionBadge state={chat.connection} />
      </div>

      {chat.loading ? (
        <CenteredNote>
          <Spinner />
          Loading messages…
        </CenteredNote>
      ) : (
        <ChatThread
          supabase={supabase}
          messages={chat.messages}
          viewerRole="customer"
          otherPartyLabel="H-Pharmacy"
          hasOlder={chat.hasOlder}
          loadingOlder={chat.loadingOlder}
          onLoadOlder={() => void chat.loadOlder()}
          onRetry={(id) => void chat.retry(id)}
          onDiscard={chat.discard}
          onViewed={(seq) => void chat.markViewed(seq)}
          onHideForMe={chat.hideForMe}
          onDeleteForEveryone={chat.deleteForEveryone}
          pinnedId={chat.pinnedId}
          pinnedMessage={chat.pinnedMessage}
          onPin={chat.pinMessage}
          onUnpin={chat.unpinMessage}
          onEnsureLoaded={chat.ensureLoaded}
          emptyState={
            <div className="flex max-w-sm flex-col items-center px-4 text-center">
              <span aria-hidden className="mb-4 flex h-14 w-14 items-center justify-center rounded-2xl border border-line bg-surface text-brand shadow-bubble">
                <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M20 12a8 8 0 0 1-11.6 7.1L4 20l1-4.1A8 8 0 1 1 20 12z" />
                  <path d="M9 12h6M12 9v6" />
                </svg>
              </span>
              <p className="text-lg font-semibold tracking-tight text-ink">How can we help?</p>
              <p className="mt-1.5 text-sm leading-relaxed text-muted">
                Send us a message about your order, a product, or a prescription question. Our
                team will reply here.
              </p>
              <p className="mt-4 text-xs text-muted">You can send text, photos, voice notes and your location.</p>
            </div>
          }
        />
      )}

      {chat.loadError ? (
        <div className="shrink-0 border-t border-danger/15 bg-danger-soft px-4 py-2 text-center text-xs text-danger" role="alert">
          Couldn&apos;t refresh messages.{" "}
          <button type="button" className="font-semibold underline" onClick={() => void chat.reload()}>
            Retry
          </button>
        </div>
      ) : null}

      {chat.blocked ? (
        <BlockedNotice>
          You can&apos;t send messages in this chat right now. You can still read your conversation.
        </BlockedNotice>
      ) : (
        <Composer
          onSend={chat.send}
          onSendVoice={chat.sendVoice}
          onSendImage={chat.sendImage}
          onSendLocation={chat.sendLocation}
          disabled={chat.loading}
        />
      )}
    </main>
  );
}

function CenteredNote({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex flex-1 items-center justify-center p-6 text-center text-sm text-muted">
      <div className="flex flex-col items-center gap-3">{children}</div>
    </div>
  );
}

function Spinner() {
  return <span className="h-6 w-6 animate-spin rounded-full border-2 border-brand/25 border-t-brand" aria-hidden />;
}
