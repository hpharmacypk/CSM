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

/** Pinned chats first; within each group, newest activity first (same as the server). */
function sortRows(list: AdminConversationRow[]) {
  return [...list].sort((a, b) => {
    if (!!a.pinned_at !== !!b.pinned_at) return a.pinned_at ? -1 : 1;
    return (b.last_message_at ?? b.created_at).localeCompare(a.last_message_at ?? a.created_at);
  });
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
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [pinError, setPinError] = useState<string | null>(null);
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

  // Close the row menu on outside tap / Escape.
  useEffect(() => {
    if (!menuFor) return;
    const close = (e: Event) => {
      if (e instanceof KeyboardEvent && e.key !== "Escape") return;
      if (e.target instanceof Element && e.target.closest("[data-chat-menu]")) return;
      setMenuFor(null);
    };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", close);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", close);
    };
  }, [menuFor]);

  /** Admin-only (enforced by set_conversation_pinned). */
  const togglePin = async (row: AdminConversationRow) => {
    setMenuFor(null);
    setPinError(null);
    const pinned = !row.pinned_at;
    // Optimistic: move it now, confirm from the server.
    setItems((prev) =>
      sortRows(prev.map((c) => (c.id === row.id ? { ...c, pinned_at: pinned ? new Date().toISOString() : null } : c))),
    );
    const { error } = await supabase.rpc("set_conversation_pinned", {
      p_conversation_id: row.id,
      p_pinned: pinned,
    });
    if (error) setPinError(pinned ? "Couldn't pin the chat. Try again." : "Couldn't unpin the chat. Try again.");
    await loadOne(row.id);
  };

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
      {pinError ? (
        <p className="px-4 py-2 text-xs text-danger" role="alert">
          {pinError}
        </p>
      ) : null}
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
              <li key={c.id} className="group relative" data-pinned={c.pinned_at ? "true" : undefined}>
                <Link
                  href={href}
                  className={`flex gap-3 border-b border-line py-3 pl-4 pr-11 hover:bg-canvas ${active ? "bg-brand-soft" : ""}`}
                >
                  <Avatar supabase={supabase} path={c.avatar_path} label={title} size={40} />
                  <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <div className="flex items-center justify-between gap-2">
                      <span className={`truncate text-sm ${unread ? "font-bold text-ink" : "font-medium text-ink"}`}>
                        {c.pinned_at ? (
                          <span className="mr-1" role="img" aria-label="Pinned chat" title="Pinned chat">
                            📌
                          </span>
                        ) : null}
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
                <div className="absolute right-2 top-3" data-chat-menu>
                  <button
                    type="button"
                    aria-label={`Chat options for ${title}`}
                    aria-haspopup="menu"
                    aria-expanded={menuFor === c.id}
                    onClick={() => setMenuFor(menuFor === c.id ? null : c.id)}
                    className={`flex h-8 w-8 items-center justify-center rounded-full text-muted hover:bg-black/5 focus:opacity-100 ${
                      menuFor === c.id ? "opacity-100" : "opacity-0 group-hover:opacity-100 [@media(hover:none)]:opacity-60"
                    }`}
                  >
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
                      <circle cx="5" cy="12" r="2" />
                      <circle cx="12" cy="12" r="2" />
                      <circle cx="19" cy="12" r="2" />
                    </svg>
                  </button>
                  {menuFor === c.id ? (
                    <div role="menu" className="absolute right-0 top-full z-30 mt-1 min-w-36 overflow-hidden rounded-xl border border-line bg-surface py-1 text-sm shadow-lg">
                      <button
                        type="button"
                        role="menuitem"
                        onClick={() => void togglePin(c)}
                        className="block w-full px-4 py-2.5 text-left text-ink hover:bg-canvas"
                      >
                        {c.pinned_at ? "Unpin chat" : "Pin chat"}
                      </button>
                    </div>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
