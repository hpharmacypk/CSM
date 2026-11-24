"use client";

import { useCallback, useEffect, useState } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import { Brand } from "@/components/Brand";
import { ChatThread } from "@/components/chat/ChatThread";
import { Composer } from "@/components/chat/Composer";
import { ConnectionBadge } from "@/components/chat/ConnectionBadge";
import { CHAT_EVENTS, useConversationMessages } from "@/lib/chat/use-conversation-messages";
import { isSupabaseConfigured } from "@/lib/supabase/config";
import { getGuestClient } from "@/lib/supabase/guest-client";
import { GuestProfileButton } from "./guest-profile";

const BASE_TITLE = "H-Pharmacy Support";

/**
 * Guest unread badge (browser tab title). Starts from the stored count, stays
 * live through Realtime, and is set immediately from mark-read results.
 */
function useGuestUnreadTitle(supabase: SupabaseClient, conversationId: string) {
  useEffect(() => {
    let active = true;
    const apply = (n: number) => {
      if (active) document.title = n > 0 ? `(${n}) ${BASE_TITLE}` : BASE_TITLE;
    };
    void supabase
      .from("conversations")
      .select("customer_unread_count")
      .eq("id", conversationId)
      .maybeSingle()
      .then(({ data }) => apply(data?.customer_unread_count ?? 0));
    const channel = supabase
      .channel(`guest-unread:${conversationId}:${crypto.randomUUID()}`)
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "conversations", filter: `id=eq.${conversationId}` },
        (payload) => apply((payload.new as { customer_unread_count?: number }).customer_unread_count ?? 0),
      )
      .subscribe();
    const onRead = (e: Event) => {
      const d = (e as CustomEvent<{ conversationId: string; unread: number }>).detail;
      if (d.conversationId === conversationId) apply(d.unread);
    };
    window.addEventListener(CHAT_EVENTS.read, onRead);
    return () => {
      active = false;
      window.removeEventListener(CHAT_EVENTS.read, onRead);
      document.title = BASE_TITLE;
      void supabase.removeChannel(channel);
    };
  }, [supabase, conversationId]);
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

  return (
    <GuestFrame headerAction={boot.kind === "ready" ? <GuestProfileButton supabase={boot.supabase} /> : null}>

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
      ) : (
        <GuestChat
          key={boot.conversationId}
          supabase={boot.supabase}
          conversationId={boot.conversationId}
        />
      )}
    </GuestFrame>
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
  conversationId,
}: {
  supabase: SupabaseClient;
  conversationId: string;
}) {
  const chat = useConversationMessages(supabase, conversationId, "customer");
  useGuestUnreadTitle(supabase, conversationId);

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

      <Composer
        onSend={chat.send}
        onSendVoice={chat.sendVoice}
        onSendImage={chat.sendImage}
        onSendLocation={chat.sendLocation}
        disabled={chat.loading}
      />
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
