"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { ChatThread } from "@/components/chat/ChatThread";
import { Composer } from "@/components/chat/Composer";
import { ConnectionBadge } from "@/components/chat/ConnectionBadge";
import { useConversationMessages } from "@/lib/chat/use-conversation-messages";
import type { ConversationWithCustomer } from "@/lib/types";
import { useAdminClient } from "../../admin-client-context";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function AdminThread({ conversationId }: { conversationId: string }) {
  if (!UUID_RE.test(conversationId)) {
    return <NotFound />;
  }
  return <AdminThreadInner conversationId={conversationId} />;
}

function AdminThreadInner({ conversationId }: { conversationId: string }) {
  const supabase = useAdminClient();
  const [meta, setMeta] = useState<ConversationWithCustomer | null | undefined>(undefined);
  const chat = useConversationMessages(supabase, conversationId, "admin");

  useEffect(() => {
    let active = true;
    void supabase
      .from("conversations")
      .select("*, customers(public_ref)")
      .eq("id", conversationId)
      .maybeSingle()
      .then(({ data }) => {
        if (active) setMeta((data as ConversationWithCustomer | null) ?? null);
      });
    return () => {
      active = false;
    };
  }, [supabase, conversationId]);

  if (meta === null) return <NotFound />;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-3 border-b border-line bg-surface px-4 py-3">
        <Link
          href="/admin"
          className="rounded-full px-2 py-1 text-sm text-brand md:hidden"
          aria-label="Back to conversations"
        >
          ←
        </Link>
        <div className="min-w-0 flex-1">
          <div className="font-mono text-sm font-semibold text-ink">
            {meta?.customers?.public_ref ?? "…"}
          </div>
          {meta ? (
            <div className="text-xs text-muted">
              Started {new Date(meta.created_at).toLocaleString("en")}
            </div>
          ) : null}
        </div>
        <ConnectionBadge state={chat.connection} />
      </div>

      {chat.loading ? (
        <div className="flex flex-1 items-center justify-center text-sm text-muted">
          Loading messages…
        </div>
      ) : (
        <ChatThread
          supabase={supabase}
          messages={chat.messages}
          viewerRole="admin"
          otherPartyLabel="Customer"
          hasOlder={chat.hasOlder}
          loadingOlder={chat.loadingOlder}
          onLoadOlder={() => void chat.loadOlder()}
          onRetry={(id) => void chat.retry(id)}
          onDiscard={chat.discard}
          emptyState={<p className="text-sm text-muted">No messages in this conversation yet.</p>}
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

      <Composer
        onSend={chat.send}
        onSendVoice={chat.sendVoice}
        disabled={chat.loading}
        placeholder="Reply to customer"
      />
    </div>
  );
}

function NotFound() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-sm text-muted">
      <p>Conversation not found.</p>
      <Link href="/admin" className="text-brand underline">
        Back to conversations
      </Link>
    </div>
  );
}
