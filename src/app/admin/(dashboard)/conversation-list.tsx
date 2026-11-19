"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { formatListTime } from "@/components/chat/format";
import type { Conversation, ConversationWithCustomer } from "@/lib/types";
import { useAdminClient } from "./admin-client-context";

const LIST_LIMIT = 300;
const SELECT = "*, customers(public_ref)";

function sortConversations(list: ConversationWithCustomer[]) {
  return [...list].sort((a, b) => {
    const at = a.last_message_at ?? a.created_at;
    const bt = b.last_message_at ?? b.created_at;
    return bt.localeCompare(at);
  });
}

export function ConversationList() {
  const supabase = useAdminClient();
  const pathname = usePathname();
  const [items, setItems] = useState<ConversationWithCustomer[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadAll = useCallback(async () => {
    // Only conversations with at least one message; empty guest inboxes are hidden.
    const { data, error } = await supabase
      .from("conversations")
      .select(SELECT)
      .not("last_message_at", "is", null)
      .order("last_message_at", { ascending: false })
      .limit(LIST_LIMIT);
    if (error) {
      setError(error.message);
    } else {
      setItems(data as ConversationWithCustomer[]);
      setError(null);
    }
    setLoading(false);
  }, [supabase]);

  const loadOne = useCallback(
    async (id: string) => {
      const { data } = await supabase.from("conversations").select(SELECT).eq("id", id).maybeSingle();
      if (!data) return;
      const row = data as ConversationWithCustomer;
      setItems((prev) => sortConversations([row, ...prev.filter((c) => c.id !== id)]));
    },
    [supabase],
  );

  useEffect(() => {
    let active = true;
    queueMicrotask(() => {
      if (active) void loadAll();
    });

    const channel = supabase
      .channel(`admin-conversations:${crypto.randomUUID()}`)
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "conversations" },
        (payload) => {
          if (!active) return;
          const next = payload.new as Conversation;
          if (!next.last_message_at) return;
          setItems((prev) => {
            const existing = prev.find((c) => c.id === next.id);
            if (!existing) {
              // New thread: fetch it with its customer reference.
              void loadOne(next.id);
              return prev;
            }
            return sortConversations(
              prev.map((c) => (c.id === next.id ? { ...c, ...next, customers: c.customers } : c)),
            );
          });
        },
      )
      .subscribe((status) => {
        // Re-sync after (re)connecting so nothing missed while offline is lost.
        if (active && status === "SUBSCRIBED") void loadAll();
      });

    const onWake = () => {
      if (document.visibilityState === "visible") void loadAll();
    };
    window.addEventListener("online", onWake);
    document.addEventListener("visibilitychange", onWake);

    return () => {
      active = false;
      window.removeEventListener("online", onWake);
      document.removeEventListener("visibilitychange", onWake);
      void supabase.removeChannel(channel);
    };
  }, [supabase, loadAll, loadOne]);

  const totalUnread = useMemo(
    () => items.reduce((sum, c) => sum + c.admin_unread_count, 0),
    [items],
  );

  useEffect(() => {
    document.title = totalUnread > 0 ? `(${totalUnread}) H-Pharmacy Inbox` : "H-Pharmacy Inbox";
  }, [totalUnread]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center justify-between border-b border-line px-4 py-3">
        <h2 className="text-sm font-semibold text-ink">Conversations</h2>
        {totalUnread > 0 ? (
          <span className="rounded-full bg-brand px-2 py-0.5 text-xs font-semibold text-white">
            {totalUnread} unread
          </span>
        ) : null}
      </div>
      {error ? (
        <p className="p-4 text-sm text-danger">
          Couldn&apos;t load conversations: {error}{" "}
          <button className="underline" type="button" onClick={() => void loadAll()}>
            Retry
          </button>
        </p>
      ) : null}
      {loading ? (
        <p className="p-4 text-sm text-muted">Loading…</p>
      ) : items.length === 0 ? (
        <p className="p-4 text-sm text-muted">No conversations yet.</p>
      ) : (
        <ul className="min-h-0 flex-1 overflow-y-auto">
          {items.map((c) => {
            const href = `/admin/c/${c.id}`;
            const active = pathname === href;
            const unread = c.admin_unread_count;
            return (
              <li key={c.id}>
                <Link
                  href={href}
                  className={`flex flex-col gap-0.5 border-b border-line px-4 py-3 hover:bg-canvas ${
                    active ? "bg-brand-soft" : ""
                  }`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span
                      className={`font-mono text-sm ${unread ? "font-bold text-ink" : "font-medium text-ink"}`}
                    >
                      {c.customers?.public_ref ?? "Unknown customer"}
                    </span>
                    <span className="shrink-0 text-xs text-muted">
                      {formatListTime(c.last_message_at)}
                    </span>
                  </div>
                  <div className="flex items-center justify-between gap-2">
                    <span className={`truncate text-sm ${unread ? "text-ink" : "text-muted"}`}>
                      {c.last_message_sender === "admin" ? "You: " : ""}
                      {c.last_message_preview}
                    </span>
                    {unread > 0 ? (
                      <span
                        className="min-w-5 shrink-0 rounded-full bg-brand px-1.5 text-center text-xs font-semibold leading-5 text-white"
                        aria-label={`${unread} unread`}
                      >
                        {unread}
                      </span>
                    ) : null}
                  </div>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
