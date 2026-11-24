"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Avatar, customerLabel } from "@/components/Avatar";
import { formatListTime } from "@/components/chat/format";
import { CHAT_EVENTS } from "@/lib/chat/use-conversation-messages";
import { PinIcon } from "@/components/chat/ChatThread";
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

  const changeFilter = (id: string) => {
    if (id === filter) return;
    setLoading(true);
    setFilter(id);
  };
  const activeFilterName = labels.find((l) => l.id === filter)?.name;
  const anyPinned = !!items[0]?.pinned_at;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center justify-between gap-2 px-4 pt-4 pb-2">
        <h2 className="text-base font-semibold tracking-tight text-ink">Conversations</h2>
        {totalUnread > 0 ? (
          <span className="rounded-full bg-brand px-2.5 py-0.5 text-xs font-semibold text-white" data-testid="total-unread">
            {totalUnread} unread
          </span>
        ) : null}
      </div>
      {labels.length ? (
        <div
          className="hp-no-scrollbar flex gap-1.5 overflow-x-auto border-b border-line px-4 pt-1 pb-3"
          role="group"
          aria-label="Filter by label"
        >
          <FilterChip active={!filter} onClick={() => changeFilter("")}>
            All
          </FilterChip>
          {labels.map((l) => (
            <FilterChip key={l.id} active={filter === l.id} onClick={() => changeFilter(l.id)}>
              {l.name}
            </FilterChip>
          ))}
        </div>
      ) : (
        <div className="border-b border-line" />
      )}
      {pinError ? (
        <p className="mx-4 mt-3 rounded-xl bg-danger-soft px-3 py-2 text-xs text-danger" role="alert">
          {pinError}
        </p>
      ) : null}
      {error ? (
        <p className="mx-4 mt-3 rounded-xl bg-danger-soft px-3 py-2 text-sm text-danger" role="alert">
          Couldn&apos;t load conversations: {error}{" "}
          <button className="font-semibold underline" type="button" onClick={() => void loadAll()}>
            Retry
          </button>
        </p>
      ) : null}
      {loading ? (
        <ListSkeleton />
      ) : items.length === 0 ? (
        <div className="flex flex-col items-center gap-1 px-6 py-12 text-center">
          <p className="text-sm font-medium text-ink">
            {filter ? "No conversations with this label" : "No conversations yet"}
          </p>
          <p className="text-xs text-muted">
            {filter ? (
              <>
                Nothing is labelled &ldquo;{activeFilterName}&rdquo;.{" "}
                <button type="button" className="font-semibold text-brand underline" onClick={() => changeFilter("")}>
                  Show all
                </button>
              </>
            ) : (
              "New customer chats will appear here."
            )}
          </p>
        </div>
      ) : (
        <ul className="hp-scroll min-h-0 flex-1 overflow-y-auto pt-1 pb-2">
          {items.map((c, i) => {
            const href = `/admin/c/${c.id}`;
            const active = pathname === href;
            const unread = Math.max(0, c.admin_unread_count);
            const title = customerLabel(c.display_name, c.public_ref);
            const pinned = !!c.pinned_at;
            const showSection = anyPinned && (i === 0 || !!items[i - 1].pinned_at !== pinned);
            return (
              <li key={c.id} className="group relative" data-pinned={pinned ? "true" : undefined}>
                {showSection ? (
                  <div className="flex items-center gap-1.5 px-5 pt-3 pb-1 text-[11px] font-semibold tracking-wide text-muted uppercase">
                    {pinned ? (
                      <>
                        <span className="text-pin">
                          <PinIcon size={11} />
                        </span>
                        Pinned
                      </>
                    ) : (
                      "All chats"
                    )}
                  </div>
                ) : null}
                <div className="relative">
                  <Link
                    href={href}
                    aria-current={active ? "page" : undefined}
                    className={`relative mx-2 flex gap-3 rounded-xl py-2.5 pr-11 pl-3 transition ${
                      active ? "bg-brand-soft" : "hover:bg-subtle"
                    }`}
                  >
                    {active ? <span aria-hidden className="absolute inset-y-3 left-0 w-[3px] rounded-full bg-brand" /> : null}
                    <span className="relative shrink-0 self-start">
                      <Avatar supabase={supabase} path={c.avatar_path} label={title} size={44} />
                      {unread > 0 ? (
                        <span aria-hidden className="absolute -top-0.5 -right-0.5 h-3 w-3 rounded-full border-2 border-surface bg-brand" />
                      ) : null}
                    </span>
                    <div className="flex min-w-0 flex-1 flex-col justify-center gap-0.5">
                      <div className="flex items-baseline justify-between gap-2">
                        <span className={`flex min-w-0 items-baseline gap-1.5 text-sm text-ink ${unread ? "font-bold" : "font-semibold"}`}>
                          {pinned ? (
                            <span className="shrink-0 self-center text-pin" role="img" aria-label="Pinned chat" title="Pinned chat">
                              <PinIcon size={12} />
                            </span>
                          ) : null}
                          <span className="truncate">{title}</span>
                          {c.display_name ? (
                            <span className="shrink-0 font-mono text-[11px] font-normal text-muted">{c.public_ref}</span>
                          ) : null}
                        </span>
                        <span className={`shrink-0 text-[11px] ${unread ? "font-semibold text-brand" : "text-muted"}`}>
                          {formatListTime(c.last_message_at)}
                        </span>
                      </div>
                      <div className="flex items-center justify-between gap-2">
                        <span className={`truncate text-[13px] ${unread ? "font-medium text-ink" : "text-muted"}`}>
                          {c.last_message_sender === "admin" ? <span className="font-normal text-muted">You: </span> : null}
                          {c.last_message_preview ?? <span className="italic">No messages yet</span>}
                        </span>
                        {unread > 0 ? (
                          <span
                            className="flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full bg-brand px-1.5 text-[11px] font-bold text-white"
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
                            <LabelChip key={l.id}>{l.name}</LabelChip>
                          ))}
                          {c.labels.length > 3 ? (
                            <span className="px-1 py-px text-[11px] font-medium text-muted">+{c.labels.length - 3}</span>
                          ) : null}
                        </div>
                      ) : null}
                    </div>
                  </Link>
                  <div className="absolute top-2 right-3" data-chat-menu>
                    <button
                      type="button"
                      aria-label={`Chat options for ${title}`}
                      aria-haspopup="menu"
                      aria-expanded={menuFor === c.id}
                      onClick={() => setMenuFor(menuFor === c.id ? null : c.id)}
                      className={`flex h-8 w-8 items-center justify-center rounded-full text-muted transition hover:bg-surface hover:text-ink focus-visible:opacity-100 ${
                        menuFor === c.id
                          ? "bg-surface text-ink opacity-100"
                          : "opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 [@media(hover:none)]:opacity-70"
                      }`}
                    >
                      <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
                        <circle cx="5" cy="12" r="2" />
                        <circle cx="12" cy="12" r="2" />
                        <circle cx="19" cy="12" r="2" />
                      </svg>
                    </button>
                    {menuFor === c.id ? (
                      <div role="menu" className="absolute top-full right-0 z-30 mt-1 min-w-40 overflow-hidden rounded-xl border border-line bg-surface p-1 text-sm shadow-pop">
                        <button
                          type="button"
                          role="menuitem"
                          onClick={() => void togglePin(c)}
                          className="flex w-full items-center gap-2 rounded-lg px-3 py-2.5 text-left text-ink transition hover:bg-subtle"
                        >
                          <span className="text-pin">
                            <PinIcon size={13} />
                          </span>
                          {c.pinned_at ? "Unpin chat" : "Pin chat"}
                        </button>
                      </div>
                    ) : null}
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function FilterChip({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={`h-8 max-w-[12rem] shrink-0 truncate rounded-full border px-3 text-xs font-medium whitespace-nowrap transition ${
        active ? "border-brand bg-brand text-white" : "border-line bg-surface text-ink hover:border-line-strong hover:bg-subtle"
      }`}
    >
      {children}
    </button>
  );
}

/** Admin-only label tag: neutral, so it never reads as an unread badge or a selection. */
export function LabelChip({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex max-w-[10rem] items-center gap-1 rounded-md border border-line bg-canvas px-1.5 py-px text-[11px] font-medium text-ink/80">
      <span aria-hidden className="h-1.5 w-1.5 shrink-0 rounded-full bg-brand/60" />
      <span className="truncate">{children}</span>
    </span>
  );
}

function ListSkeleton() {
  return (
    <div className="flex flex-col gap-1 px-2 pt-2" aria-label="Loading conversations" role="status">
      {[0, 1, 2, 3].map((i) => (
        <div key={i} className="flex animate-pulse gap-3 rounded-xl px-3 py-3">
          <span className="h-11 w-11 shrink-0 rounded-full bg-subtle" />
          <span className="flex flex-1 flex-col gap-2 pt-1">
            <span className="h-3 w-2/5 rounded bg-subtle" />
            <span className="h-3 w-4/5 rounded bg-subtle" />
          </span>
        </div>
      ))}
    </div>
  );
}
