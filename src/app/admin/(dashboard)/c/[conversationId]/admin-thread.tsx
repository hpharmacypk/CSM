"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Avatar, customerLabel } from "@/components/Avatar";
import { BlockedNotice, ChatThread } from "@/components/chat/ChatThread";
import { Composer } from "@/components/chat/Composer";
import { ConnectionBadge } from "@/components/chat/ConnectionBadge";
import { useConversationMessages, type DisplayMessage } from "@/lib/chat/use-conversation-messages";
import { useAdminClient } from "../../admin-client-context";
import { ARCHIVE_CHANGED, BLOCK_CHANGED, emitArchiveChanged, emitBlockChanged } from "../../admin-data";
import { ArchiveIcon, BlockGlyph } from "../../conversation-list";
import { ForwardDialog } from "./forward-dialog";
import { CustomerLabels } from "./customer-labels";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type CustomerProfile = {
  id: string;
  public_ref: string;
  display_name: string | null;
  bio: string | null;
  avatar_path: string | null;
  created_at: string;
};

type ThreadMeta = {
  id: string;
  created_at: string;
  customers: CustomerProfile | null;
};

export function AdminThread({ conversationId }: { conversationId: string }) {
  if (!UUID_RE.test(conversationId)) {
    return <NotFound />;
  }
  return <AdminThreadInner conversationId={conversationId} />;
}

function AdminThreadInner({ conversationId }: { conversationId: string }) {
  const supabase = useAdminClient();
  const [meta, setMeta] = useState<ThreadMeta | null | undefined>(undefined);
  const [showProfile, setShowProfile] = useState(false);
  const chat = useConversationMessages(supabase, conversationId, "admin");
  const customerId = meta?.customers?.id ?? null;

  useEffect(() => {
    let active = true;
    void supabase
      .from("conversations")
      .select("id, created_at, customers(id, public_ref, display_name, bio, avatar_path, created_at)")
      .eq("id", conversationId)
      .maybeSingle()
      .then(({ data }) => {
        if (active) setMeta((data as ThreadMeta | null) ?? null);
      });
    return () => {
      active = false;
    };
  }, [supabase, conversationId]);

  // Admin-side archive state (independent of the customer's).
  const [archived, setArchived] = useState(false);
  const [archiveBusy, setArchiveBusy] = useState(false);
  useEffect(() => {
    let active = true;
    const load = () =>
      void supabase
        .from("conversation_admin_archives")
        .select("archived_at")
        .eq("conversation_id", conversationId)
        .maybeSingle()
        .then(({ data, error }) => {
          if (active && !error) setArchived(!!data);
        });
    load();
    const onChange = (e: Event) => {
      const d = (e as CustomEvent<{ conversationId: string; archived: boolean }>).detail;
      if (d.conversationId === conversationId) setArchived(d.archived);
    };
    window.addEventListener(ARCHIVE_CHANGED, onChange);
    return () => {
      active = false;
      window.removeEventListener(ARCHIVE_CHANGED, onChange);
    };
  }, [supabase, conversationId]);

  // Block state comes from the chat hook (live via Realtime); list actions in
  // this tab refresh it immediately.
  const [blockBusy, setBlockBusy] = useState(false);
  const [forwarding, setForwarding] = useState<DisplayMessage | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const refreshBlocked = chat.refreshBlocked;
  useEffect(() => {
    const onBlock = (e: Event) => {
      if ((e as CustomEvent<{ conversationId: string }>).detail.conversationId === conversationId) void refreshBlocked();
    };
    window.addEventListener(BLOCK_CHANGED, onBlock);
    return () => window.removeEventListener(BLOCK_CHANGED, onBlock);
  }, [conversationId, refreshBlocked]);

  const unblock = async () => {
    setBlockBusy(true);
    const { error } = await supabase.rpc("set_customer_blocked", { p_conversation_id: conversationId, p_blocked: false });
    setBlockBusy(false);
    if (!error) emitBlockChanged(conversationId, false);
  };

  const toggleArchive = async () => {
    const next = !archived;
    setArchiveBusy(true);
    const { error } = await supabase.rpc("set_conversation_archived", {
      p_conversation_id: conversationId,
      p_archived: next,
    });
    setArchiveBusy(false);
    if (!error) {
      setArchived(next);
      emitArchiveChanged(conversationId, next);
    }
  };

  // Live profile changes (name, photo, bio) from the customer.
  useEffect(() => {
    if (!customerId) return;
    const channel = supabase
      .channel(`admin-profile:${customerId}:${crypto.randomUUID()}`)
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "customers", filter: `id=eq.${customerId}` },
        (payload) => {
          const row = payload.new as CustomerProfile;
          setMeta((m) => (m && m.customers ? { ...m, customers: { ...m.customers, ...row } } : m));
        },
      )
      .subscribe();
    return () => {
      void supabase.removeChannel(channel);
    };
  }, [supabase, customerId]);

  if (meta === null || chat.gone) return <NotFound deleted={chat.gone} />;
  const profile = meta?.customers ?? null;
  const title = profile ? customerLabel(profile.display_name, profile.public_ref) : "…";

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="shrink-0 border-b border-line bg-surface px-2 py-2 sm:px-5 sm:py-3">
        <div className="flex items-center gap-2 sm:gap-3">
          <Link
            href="/admin"
            className="flex h-10 shrink-0 items-center gap-0.5 rounded-full pr-2 pl-1 text-sm font-semibold text-brand transition hover:bg-brand-soft md:hidden"
            aria-label="Back to conversations"
          >
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M15 18l-6-6 6-6" />
            </svg>
            <span aria-hidden>Chats</span>
          </Link>
          {profile ? (
            <button
              type="button"
              onClick={() => setShowProfile(true)}
              className="flex min-w-0 flex-1 items-center gap-3 rounded-xl p-1 pr-2 text-left transition hover:bg-subtle"
              aria-label={`View profile of ${title}`}
            >
              <Avatar supabase={supabase} path={profile.avatar_path} label={title} size={40} />
              <span className="min-w-0">
                <span className="block truncate text-[15px] font-semibold tracking-tight text-ink">{title}</span>
                <span className="block truncate text-xs text-muted">
                  {profile.display_name ? <span className="font-mono">{profile.public_ref} · </span> : null}
                  {meta ? <>Started {new Date(meta.created_at).toLocaleDateString("en", { day: "numeric", month: "short", year: "numeric" })}</> : null}
                </span>
              </span>
            </button>
          ) : (
            <div className="min-w-0 flex-1 px-1">
              <span className="block h-4 w-32 animate-pulse rounded bg-subtle" />
            </div>
          )}
          <ConnectionBadge state={chat.connection} compact />
          {chat.blocked ? (
            <span className="flex h-7 shrink-0 items-center gap-1 rounded-full border border-danger/25 bg-danger-soft px-2.5 text-xs font-semibold text-danger" data-testid="blocked-badge">
              <BlockGlyph size={12} />
              Blocked
            </span>
          ) : null}
          <button
            type="button"
            onClick={() => void toggleArchive()}
            disabled={archiveBusy}
            aria-pressed={archived}
            title={archived ? "Restore to the inbox" : "Archive this chat"}
            className={`flex h-9 shrink-0 items-center gap-1.5 rounded-full border px-3 text-xs font-semibold transition disabled:opacity-60 ${
              archived
                ? "border-pin/30 bg-pin-soft text-pin hover:bg-pin-soft/70"
                : "border-line text-ink hover:border-line-strong hover:bg-subtle"
            }`}
          >
            <ArchiveIcon size={14} />
            <span className={archived ? "" : "sr-only sm:not-sr-only"}>{archived ? "Archived · Restore" : "Archive"}</span>
          </button>
          {profile ? (
            <button
              type="button"
              onClick={() => setShowProfile(true)}
              className="hidden h-9 shrink-0 items-center rounded-full border border-line px-3.5 text-xs font-semibold text-ink transition hover:border-line-strong hover:bg-subtle sm:flex"
            >
              Profile
            </button>
          ) : null}
        </div>
        {customerId ? (
          <div className="mt-1.5 px-1 md:pl-[56px]">
            <CustomerLabels customerId={customerId} />
          </div>
        ) : null}
      </div>

      {chat.loading ? (
        <div className="flex flex-1 items-center justify-center gap-2 text-sm text-muted">
          <span className="h-5 w-5 animate-spin rounded-full border-2 border-brand/25 border-t-brand" aria-hidden />
          Loading messages…
        </div>
      ) : (
        <ChatThread
          supabase={supabase}
          messages={chat.messages}
          viewerRole="admin"
          otherPartyLabel={profile?.display_name ?? "Customer"}
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
          onForward={(m) => {
            setNotice(null);
            setForwarding(m);
          }}
          emptyState={<p className="text-sm text-muted">No messages in this conversation yet.</p>}
        />
      )}

      {chat.loadError ? (
        <div className="shrink-0 border-t border-danger/15 bg-danger-soft px-4 py-2 text-center text-xs text-danger" role="alert">
          Couldn&apos;t refresh messages.{" "}
          <button type="button" className="underline" onClick={() => void chat.reload()}>
            Retry
          </button>
        </div>
      ) : null}

      {notice ? (
        <div className="shrink-0 border-t border-brand/15 bg-brand-soft px-4 py-2 text-center text-xs font-medium text-brand-ink" role="status">
          {notice}{" "}
          <button type="button" className="underline" onClick={() => setNotice(null)}>
            Dismiss
          </button>
        </div>
      ) : null}

      {chat.blocked ? (
        <BlockedNotice
          action={
            <button
              type="button"
              onClick={() => void unblock()}
              disabled={blockBusy}
              className="h-9 shrink-0 rounded-full border border-line px-4 text-xs font-semibold text-ink transition hover:bg-subtle disabled:opacity-60"
            >
              {blockBusy ? "Unblocking…" : "Unblock"}
            </button>
          }
        >
          This customer is blocked. Neither side can send messages.
        </BlockedNotice>
      ) : (
        <Composer
          onSend={chat.send}
          onSendVoice={chat.sendVoice}
          onSendImage={chat.sendImage}
          onSendLocation={chat.sendLocation}
          disabled={chat.loading}
          placeholder="Reply to customer"
        />
      )}

      {forwarding ? (
        <ForwardDialog
          message={forwarding}
          sourceConversationId={conversationId}
          onClose={() => setForwarding(null)}
          onForwarded={(name) => {
            setForwarding(null);
            setNotice(`Forwarded to ${name}.`);
          }}
        />
      ) : null}

      {showProfile && profile ? (
        <div
          className="fixed inset-0 z-50 flex items-end justify-center bg-ink/45 backdrop-blur-[2px] sm:items-center sm:p-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="customer-profile-title"
          onClick={() => setShowProfile(false)}
        >
          <div
            className="w-full max-w-sm rounded-t-3xl border border-line bg-surface p-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] shadow-dialog sm:rounded-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center gap-4">
              <Avatar supabase={supabase} path={profile.avatar_path} label={title} size={64} />
              <div className="min-w-0">
                <h2 id="customer-profile-title" className="truncate text-lg font-semibold tracking-tight text-ink">
                  {profile.display_name ?? "No name set"}
                </h2>
                <div className="font-mono text-xs text-muted">{profile.public_ref}</div>
              </div>
            </div>
            <h3 className="mt-5 text-[11px] font-semibold uppercase tracking-wide text-muted">Bio</h3>
            <p className="mt-1.5 whitespace-pre-wrap break-words rounded-xl border border-line bg-canvas px-3.5 py-3 text-sm leading-relaxed text-ink">
              {profile.bio ?? <span className="text-muted">No bio provided.</span>}
            </p>
            <p className="mt-4 text-xs text-muted">
              Customer since {new Date(profile.created_at).toLocaleDateString("en")}. The customer can change or
              remove these details at any time.
            </p>
            <div className="mt-4 flex justify-end">
              <button
                type="button"
                onClick={() => setShowProfile(false)}
                className="h-10 rounded-full border border-line px-5 text-sm font-semibold text-ink transition hover:border-line-strong hover:bg-subtle"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function NotFound({ deleted = false }: { deleted?: boolean }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center text-sm text-muted" role="status">
      <p className="font-medium text-ink">
        {deleted ? "This conversation is no longer available." : "Conversation not found."}
      </p>
      {deleted ? <p>The customer and their chat history were deleted.</p> : null}
      <Link href="/admin" className="text-brand underline">
        Back to conversations
      </Link>
    </div>
  );
}
