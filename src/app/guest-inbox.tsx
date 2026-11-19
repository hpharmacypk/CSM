"use client";

import { useCallback, useEffect, useState } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import { Brand } from "@/components/Brand";
import { ChatThread } from "@/components/chat/ChatThread";
import { Composer } from "@/components/chat/Composer";
import { ConnectionBadge } from "@/components/chat/ConnectionBadge";
import { useConversationMessages } from "@/lib/chat/use-conversation-messages";
import { isSupabaseConfigured } from "@/lib/supabase/config";
import { getGuestClient } from "@/lib/supabase/guest-client";

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
    <div className="flex h-full flex-col">
      <header className="border-b border-line bg-surface px-4 py-3 sm:px-6">
        <div className="mx-auto flex max-w-3xl items-center justify-between gap-3">
          <Brand subtitle="Customer support" />
        </div>
      </header>

      {boot.kind === "starting" ? (
        <CenteredNote>Opening your inbox…</CenteredNote>
      ) : boot.kind === "error" ? (
        <CenteredNote>
          <p className="mb-3 text-ink">{boot.message}</p>
          <button
            type="button"
            onClick={() => {
              setBoot({ kind: "starting" });
              void start();
            }}
            className="rounded-full bg-brand px-5 py-2 text-sm font-semibold text-white"
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

  return (
    <main className="flex min-h-0 flex-1 flex-col">
      <div className="border-b border-line bg-brand-soft px-4 py-2 sm:px-6">
        <div className="mx-auto flex max-w-3xl items-center justify-between gap-3">
          <p className="text-xs text-brand-dark">
            Your messages are private to you and the H-Pharmacy team. This chat stays available in
            this browser.
          </p>
          <ConnectionBadge state={chat.connection} />
        </div>
      </div>

      {chat.loading ? (
        <CenteredNote>Loading messages…</CenteredNote>
      ) : (
        <ChatThread
          messages={chat.messages}
          viewerRole="customer"
          otherPartyLabel="H-Pharmacy"
          hasOlder={chat.hasOlder}
          loadingOlder={chat.loadingOlder}
          onLoadOlder={() => void chat.loadOlder()}
          onRetry={(id) => void chat.retry(id)}
          onDiscard={chat.discard}
          emptyState={
            <div className="max-w-sm text-center">
              <p className="text-base font-semibold text-ink">How can we help?</p>
              <p className="mt-1 text-sm text-muted">
                Send us a message about your order, a product, or a prescription question. Our
                team will reply here.
              </p>
            </div>
          }
        />
      )}

      {chat.loadError ? (
        <div className="bg-red-50 px-4 py-2 text-center text-xs text-danger">
          Couldn&apos;t refresh messages.{" "}
          <button type="button" className="underline" onClick={() => void chat.reload()}>
            Retry
          </button>
        </div>
      ) : null}

      <Composer onSend={chat.send} disabled={chat.loading} />
    </main>
  );
}

function CenteredNote({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex flex-1 items-center justify-center p-6 text-center text-sm text-muted">
      <div>{children}</div>
    </div>
  );
}
