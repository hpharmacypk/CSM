"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Avatar, customerLabel } from "@/components/Avatar";
import { formatListTime } from "@/components/chat/format";
import { CHAT_EVENTS } from "@/lib/chat/use-conversation-messages";
import { useAdminClient } from "./admin-client-context";
import {
  LABELS_CHANGED,
  fetchLabels,
  type AdminConversationRow,
  type Label,
} from "./admin-data";

function sortRows(list: AdminConversationRow[]) {
  return [...list].sort((a, b) =>
    (b.last_message_at ?? b.created_at).localeCompare(a.last_message_at ?? a.created_at),
  );
}

export function ConversationList() {
  const supabase = useAdminClient();
  const pathname = usePathname();
  const [items, setItems] = useState<AdminConversationRow[]>([]);
  const [labels, setLabels] = useState<Label[]>([]);
  const [filter, setFilter] = useState<string>("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const filterRef = useRef(filter);
  const itemsRef = useRef(items);

  useEffect(() => {
    filterRef.current = filter;
  }, [filter]);
  useEffect(() => {
    itemsRef.current = items;
  }, [items]);

  const loadAll = useCallback(async () => {
    const { data, error } = await supabase.rpc("admin_list_conversations", {
      p_label_id: filterRef.current || null,
    });
    if (error) {
      setError(error.message);
    } else {
      setItems(sortRows(data as AdminConversationRow[]));
      setError(null);
    }
    setLoading(false);
  }, [supabase]);

  /** Refresh one row (unread/preview/profile/labels changed). */
  const loadOne = useCallback(
    async (conversationId: string) => {
      const { data } = await supabase.rpc("admin_list_conversations", {
        p_label_id: filterRef.current || null,
        p_conversation_id: conversationId,
      });
      const row = (data as AdminConversationRow[] | null)?.[0];
      setItems((prev) =>
        row
          ? sortRows([row, ...prev.filter((c) => c.id !== conversationId)])
          : prev.filter((c) => c.id !== conversationId || !filterRef.current),
      );
    },
    [supabase],
  );

  const loadLabels = useCallback(async () => {
    setLabels(await fetchLabels(supabase));
  }, [supabase]);

  // Reload when the label filter changes.
  useEffect(() => {
    queueMicrotask(() => void loadAll());
  }, [filter, loadAll]);

  useEffect(() => {
    let active = true;
    queueMicrotask(() => {
      if (active) void loadLabels();
    });

    const channel = supabase
      .channel(`admin-conversations:${crypto.randomUUID()}`)
      .on("postgres_changes", { event: "UPDATE", schema: "public", table: "conversations" }, (payload) => {
        if (active) void loadOne((payload.new as { id: string }).id);
      })
      .on("postgres_changes", { event: "UPDATE", schema: "public", table: "customers" }, (payload) => {
        // Profile name/photo changed: refresh that customer's row.
        if (!active) return;
        const customerId = (payload.new as { id: string }).id;
        const row = itemsRef.current.find((c) => c.customer_id === customerId);
        if (row) void loadOne(row.id);
      })
      .subscribe((status) => {
        // Re-sync after (re)connecting so nothing missed while offline is lost.
        if (active && status === "SUBSCRIBED") void loadAll();
      });

    const onWake = () => {
      if (document.visibilityState === "visible") void loadAll();
    };
    const onRead = (e: Event) => {
      const d = (e as CustomEvent<{ conversationId: string; unread: number }>).detail;
      // Update the badge immediately, then confirm from the server.
      setItems((prev) => prev.map((c) => (c.id === d.conversationId ? { ...c, admin_unread_count: d.unread } : c)));
      void loadOne(d.conversationId);
    };
    const onChanged = (e: Event) => {
      void loadOne((e as CustomEvent<{ conversationId: string }>).detail.conversationId);
    };
    const onLabels = () => {
      void loadLabels();
      void loadAll();
    };
    window.addEventListener("online", onWake);
    document.addEventListener("visibilitychange", onWake);
    window.addEventListener(CHAT_EVENTS.read, onRead);
    window.addEventListener(CHAT_EVENTS.changed, onChanged);
    window.addEventListener(LABELS_CHANGED, onLabels);

    return () => {
      active = false;
      window.removeEventListener("online", onWake);
      document.removeEventListener("visibilitychange", onWake);
      window.removeEventListener(CHAT_EVENTS.read, onRead);
      window.removeEventListener(CHAT_EVENTS.changed, onChanged);
      window.removeEventListener(LABELS_CHANGED, onLabels);
      void supabase.removeChannel(channel);
    };
  }, [supabase, loadAll, loadOne, loadLabels]);

  // A deleted label can't stay selected as the filter.
  useEffect(() => {
    if (filter && labels.length && !labels.some((l) => l.id === filter)) {
      queueMicrotask(() => setFilter(""));
    }
  }, [labels, filter]);

  const totalUnread = useMemo(
    () => items.reduce((sum, c) => sum + Math.max(0, c.admin_unread_count), 0),
    [items],
  );

  useEffect(() => {
    document.title = totalUnread > 0 ? `(${totalUnread}) H-Pharmacy Inbox` : "H-Pharmacy Inbox";
  }, [totalUnread]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center justify-between gap-2 border-b border-line px-4 py-3">
        <h2 className="text-sm font-semibold text-ink">Conversations</h2>
        {totalUnread > 0 ? (
          <span className="rounded-full bg-brand px-2 py-0.5 text-xs font-semibold text-white" data-testid="total-unread">
            {totalUnread} unread
          </span>
        ) : null}
      </div>
      <div className="border-b border-line px-4 py-2">
        <label className="sr-only" htmlFor="label-filter">
          Filter by label
        </label>
        <select
          id="label-filter"
          value={filter}
          onChange={(e) => {
            setLoading(true);
            setFilter(e.target.value);
          }}
          className="w-full rounded-lg border border-line bg-canvas px-3 py-2 text-sm text-ink"
        >
          <option value="">All conversations</option>
          {labels.map((l) => (
            <option key={l.id} value={l.id}>
              Label: {l.name}
            </option>
          ))}
        </select>
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
        <p className="p-4 text-sm text-muted">{filter ? "No conversations with this label." : "No conversations yet."}</p>
      ) : (
        <ul className="min-h-0 flex-1 overflow-y-auto">
          {items.map((c) => {
            const href = `/admin/c/${c.id}`;
            const active = pathname === href;
            const unread = Math.max(0, c.admin_unread_count);
            const title = customerLabel(c.display_name, c.public_ref);
            return (
              <li key={c.id}>
                <Link
                  href={href}
                  className={`flex gap-3 border-b border-line px-4 py-3 hover:bg-canvas ${active ? "bg-brand-soft" : ""}`}
                >
                  <Avatar supabase={supabase} path={c.avatar_path} label={title} size={40} />
                  <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <div className="flex items-center justify-between gap-2">
                      <span className={`truncate text-sm ${unread ? "font-bold text-ink" : "font-medium text-ink"}`}>
                        {title}
                        {c.display_name ? (
                          <span className="ml-1.5 font-mono text-[11px] font-normal text-muted">{c.public_ref}</span>
                        ) : null}
                      </span>
                      <span className="shrink-0 text-xs text-muted">{formatListTime(c.last_message_at)}</span>
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
                          data-testid="unread-badge"
                        >
                          {unread}
                        </span>
                      ) : null}
                    </div>
                    {c.labels.length ? (
                      <div className="mt-1 flex flex-wrap gap-1">
                        {c.labels.slice(0, 3).map((l) => (
                          <span key={l.id} className="rounded-full bg-brand-soft px-2 py-0.5 text-[11px] font-medium text-brand-dark">
                            {l.name}
                          </span>
                        ))}
                        {c.labels.length > 3 ? (
                          <span className="rounded-full bg-canvas px-2 py-0.5 text-[11px] text-muted">+{c.labels.length - 3}</span>
                        ) : null}
                      </div>
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
