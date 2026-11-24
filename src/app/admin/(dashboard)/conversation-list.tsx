"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Avatar, customerLabel } from "@/components/Avatar";
import { formatListTime } from "@/components/chat/format";
import { CHAT_EVENTS } from "@/lib/chat/use-conversation-messages";
import { PinIcon } from "@/components/chat/ChatThread";
import { useAdminClient } from "./admin-client-context";
import { HandoffBadge } from "./handoff-badge";
import {
  ARCHIVE_CHANGED,
  LABELS_CHANGED,
  emitArchiveChanged,
  emitBlockChanged,
  BLOCK_CHANGED,
  fetchLabels,
  runStorageCleanup,
  type AdminConversationRow,
  type Label,
} from "./admin-data";

/**
 * Active chats first (pinned before unpinned), archived chats last; newest
 * activity first within each group (same order as the server). Pins only
 * order active chats: an archived chat stays archived even if pinned.
 */
function sortRows(list: AdminConversationRow[]) {
  return [...list].sort((a, b) => {
    if (!!a.archived_at !== !!b.archived_at) return a.archived_at ? 1 : -1;
    if (!a.archived_at && !!a.pinned_at !== !!b.pinned_at) return a.pinned_at ? -1 : 1;
    return (b.last_message_at ?? b.created_at).localeCompare(a.last_message_at ?? a.created_at);
  });
}

export function ConversationList() {
  const supabase = useAdminClient();
  const pathname = usePathname();
  const router = useRouter();
  const [items, setItems] = useState<AdminConversationRow[]>([]);
  const [labels, setLabels] = useState<Label[]>([]);
  const [filter, setFilter] = useState<string>("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const filterRef = useRef(filter);
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<AdminConversationRow | null>(null);
  const [confirmBlock, setConfirmBlock] = useState<AdminConversationRow | null>(null);
  const [blockBusy, setBlockBusy] = useState(false);
  const [deleting, setDeleting] = useState(false);
  /** Files of deleted customers still in Storage (null = unknown, e.g. offline). */
  const [cleanupLeft, setCleanupLeft] = useState<number | null>(0);
  const [cleaning, setCleaning] = useState(false);
  const itemsRef = useRef(items);
  /** Conversations deleted in this session: never re-added from a stale response. */
  const deletedIds = useRef(new Set<string>());

  useEffect(() => {
    filterRef.current = filter;
  }, [filter]);
  useEffect(() => {
    itemsRef.current = items;
  }, [items]);

  const keepLive = (rows: AdminConversationRow[]) => rows.filter((r) => !deletedIds.current.has(r.id));

  const loadAll = useCallback(async () => {
    const { data, error } = await supabase.rpc("admin_list_conversations", {
      p_label_id: filterRef.current || null,
    });
    if (error) {
      setError(error.message);
    } else {
      setItems(sortRows(keepLive(data as AdminConversationRow[])));
      setError(null);
    }
    setLoading(false);
  }, [supabase]);

  /** Refresh one row (unread/preview/profile/labels/archive changed, or deleted). */
  const loadOne = useCallback(
    async (conversationId: string) => {
      const { data, error } = await supabase.rpc("admin_list_conversations", {
        p_label_id: filterRef.current || null,
        p_conversation_id: conversationId,
      });
      if (error) return; // keep what is shown; the next full sync corrects it
      const row = keepLive((data as AdminConversationRow[] | null) ?? [])[0];
      setItems((prev) =>
        row
          ? sortRows([row, ...prev.filter((c) => c.id !== conversationId)])
          : prev.filter((c) => c.id !== conversationId),
      );
    },
    [supabase],
  );

  const removeConversation = useCallback(
    (conversationId: string) => {
      deletedIds.current.add(conversationId);
      setItems((prev) => prev.filter((c) => c.id !== conversationId));
      if (pathname === `/admin/c/${conversationId}`) router.replace("/admin");
    },
    [pathname, router],
  );

  const loadLabels = useCallback(async () => {
    setLabels(await fetchLabels(supabase));
  }, [supabase]);

  const cleaningRef = useRef(false);
  const cleanUpFiles = useCallback(async () => {
    if (cleaningRef.current) return; // one pass at a time
    cleaningRef.current = true;
    setCleaning(true);
    try {
      setCleanupLeft(await runStorageCleanup(supabase));
    } finally {
      cleaningRef.current = false;
      setCleaning(false);
    }
  }, [supabase]);

  // Reload when the label filter changes.
  useEffect(() => {
    queueMicrotask(() => void loadAll());
  }, [filter, loadAll]);

  // Finish any file cleanup left over from an earlier session.
  useEffect(() => {
    queueMicrotask(() => void cleanUpFiles());
  }, [cleanUpFiles]);

  const removeRef = useRef(removeConversation);
  useEffect(() => {
    removeRef.current = removeConversation;
  }, [removeConversation]);

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
      .on("postgres_changes", { event: "DELETE", schema: "public", table: "conversations" }, (payload) => {
        // Customer deleted (e.g. by another admin or tab). Payload has only the key.
        const id = (payload.old as { id?: string } | null)?.id;
        if (active && id) removeRef.current(id);
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
    window.addEventListener(ARCHIVE_CHANGED, onChanged);
    window.addEventListener(BLOCK_CHANGED, onChanged);
    window.addEventListener(LABELS_CHANGED, onLabels);

    return () => {
      active = false;
      window.removeEventListener("online", onWake);
      document.removeEventListener("visibilitychange", onWake);
      window.removeEventListener(CHAT_EVENTS.read, onRead);
      window.removeEventListener(CHAT_EVENTS.changed, onChanged);
      window.removeEventListener(ARCHIVE_CHANGED, onChanged);
      window.removeEventListener(BLOCK_CHANGED, onChanged);
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
    setActionError(null);
    const pinned = !row.pinned_at;
    // Optimistic: move it now, confirm from the server.
    setItems((prev) =>
      sortRows(prev.map((c) => (c.id === row.id ? { ...c, pinned_at: pinned ? new Date().toISOString() : null } : c))),
    );
    const { error } = await supabase.rpc("set_conversation_pinned", {
      p_conversation_id: row.id,
      p_pinned: pinned,
    });
    if (error) setActionError(pinned ? "Couldn't pin the chat. Try again." : "Couldn't unpin the chat. Try again.");
    await loadOne(row.id);
  };

  /** Admin-only (enforced by set_conversation_archived). Customer's view is unaffected. */
  const toggleArchive = async (row: AdminConversationRow) => {
    setMenuFor(null);
    setActionError(null);
    const archived = !row.archived_at;
    setItems((prev) =>
      sortRows(prev.map((c) => (c.id === row.id ? { ...c, archived_at: archived ? new Date().toISOString() : null } : c))),
    );
    const { error } = await supabase.rpc("set_conversation_archived", {
      p_conversation_id: row.id,
      p_archived: archived,
    });
    if (error) {
      setActionError(archived ? "Couldn't archive the chat. Try again." : "Couldn't restore the chat. Try again.");
    } else {
      emitArchiveChanged(row.id, archived);
    }
    await loadOne(row.id);
  };

  /** Admin-only (enforced by set_customer_blocked). History and files are kept. */
  const setBlocked = async (row: AdminConversationRow, blocked: boolean) => {
    setBlockBusy(true);
    setActionError(null);
    const { error } = await supabase.rpc("set_customer_blocked", { p_conversation_id: row.id, p_blocked: blocked });
    setBlockBusy(false);
    if (error) {
      setActionError(blocked ? "Couldn't block the customer. Try again." : "Couldn't unblock the customer. Try again.");
      return;
    }
    setConfirmBlock(null);
    emitBlockChanged(row.id, blocked);
    await loadOne(row.id);
  };

  /** Admin-only (enforced by admin_delete_customer); then removes the files. */
  const deleteCustomer = async (row: AdminConversationRow) => {
    setDeleting(true);
    setActionError(null);
    const { error } = await supabase.rpc("admin_delete_customer", { p_customer_id: row.customer_id });
    setDeleting(false);
    if (error) {
      setActionError("Couldn't delete the customer. Nothing was removed. Try again.");
      return;
    }
    setConfirmDelete(null);
    removeConversation(row.id);
    await cleanUpFiles();
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

  const activeRows = items.filter((c) => !c.archived_at);
  const archivedRows = items.filter((c) => c.archived_at);
  const archivedUnread = archivedRows.reduce((sum, c) => sum + Math.max(0, c.admin_unread_count), 0);
  const viewingArchived = archivedRows.some((c) => pathname === `/admin/c/${c.id}`);
  const archivedOpen = showArchived || viewingArchived;
  const anyPinned = activeRows.some((c) => c.pinned_at);

  const renderRow = (c: AdminConversationRow, sectionTitle: React.ReactNode) => (
    <ConversationRow
      key={c.id}
      row={c}
      sectionTitle={sectionTitle}
      active={pathname === `/admin/c/${c.id}`}
      supabase={supabase}
      menuOpen={menuFor === c.id}
      onMenu={() => setMenuFor(menuFor === c.id ? null : c.id)}
      onTogglePin={() => void togglePin(c)}
      onToggleArchive={() => void toggleArchive(c)}
      onToggleBlock={() => {
        setMenuFor(null);
        if (c.blocked_at) void setBlocked(c, false);
        else setConfirmBlock(c);
      }}
      onDelete={() => {
        setMenuFor(null);
        setActionError(null);
        setConfirmDelete(c);
      }}
    />
  );

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
      {cleanupLeft ? (
        <div className="mx-4 mt-3 flex items-center gap-2 rounded-xl border border-pin/20 bg-pin-soft px-3 py-2 text-xs text-ink" role="status">
          <span className="flex-1">
            {cleanupLeft} file{cleanupLeft === 1 ? "" : "s"} from deleted customers still need to be removed.
          </span>
          <button
            type="button"
            disabled={cleaning}
            onClick={() => void cleanUpFiles()}
            className="shrink-0 rounded-full bg-surface px-3 py-1 font-semibold text-ink shadow-bubble disabled:opacity-60"
          >
            {cleaning ? "Retrying…" : "Retry"}
          </button>
        </div>
      ) : null}
      {actionError ? (
        <p className="mx-4 mt-3 rounded-xl bg-danger-soft px-3 py-2 text-xs text-danger" role="alert">
          {actionError}
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
          {activeRows.length === 0 ? (
            <li className="px-5 py-6 text-center text-xs text-muted">No active chats. Archived chats are below.</li>
          ) : null}
          {activeRows.map((c, i) =>
            renderRow(
              c,
              anyPinned && (i === 0 || !!activeRows[i - 1].pinned_at !== !!c.pinned_at) ? (
                c.pinned_at ? (
                  <>
                    <span className="text-pin">
                      <PinIcon size={11} />
                    </span>
                    Pinned
                  </>
                ) : (
                  "All chats"
                )
              ) : null,
            ),
          )}
          {archivedRows.length ? (
            <li className="mt-2 border-t border-line">
              <button
                type="button"
                onClick={() => setShowArchived((v) => !v)}
                aria-expanded={archivedOpen}
                aria-controls="archived-chats"
                className="flex w-full items-center gap-2 px-5 pt-3 pb-2 text-left text-[11px] font-semibold tracking-wide text-muted uppercase transition hover:text-ink"
              >
                <ArchiveIcon size={13} />
                <span>Archived · {archivedRows.length}</span>
                {archivedUnread > 0 ? (
                  <span
                    className="flex h-5 min-w-5 items-center justify-center rounded-full bg-brand px-1.5 text-[11px] font-bold tracking-normal text-white normal-case"
                    aria-label={`${archivedUnread} unread in archived chats`}
                    data-testid="archived-unread"
                  >
                    {archivedUnread}
                  </span>
                ) : null}
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  className={`ml-auto transition ${archivedOpen ? "rotate-180" : ""}`}
                  aria-hidden
                >
                  <path d="M6 9l6 6 6-6" />
                </svg>
              </button>
              {archivedOpen ? (
                <ul id="archived-chats" data-testid="archived-section">
                  {archivedRows.map((c) => renderRow(c, null))}
                </ul>
              ) : null}
            </li>
          ) : null}
        </ul>
      )}

      {confirmBlock ? (
        <BlockCustomerDialog
          row={confirmBlock}
          busy={blockBusy}
          error={actionError}
          onCancel={() => !blockBusy && setConfirmBlock(null)}
          onConfirm={() => void setBlocked(confirmBlock, true)}
        />
      ) : null}
      {confirmDelete ? (
        <DeleteCustomerDialog
          row={confirmDelete}
          busy={deleting}
          error={actionError}
          onCancel={() => !deleting && setConfirmDelete(null)}
          onConfirm={() => void deleteCustomer(confirmDelete)}
        />
      ) : null}
    </div>
  );
}

function ConversationRow({
  row: c,
  sectionTitle,
  active,
  supabase,
  menuOpen,
  onMenu,
  onTogglePin,
  onToggleArchive,
  onToggleBlock,
  onDelete,
}: {
  row: AdminConversationRow;
  sectionTitle: React.ReactNode;
  active: boolean;
  supabase: ReturnType<typeof useAdminClient>;
  menuOpen: boolean;
  onMenu: () => void;
  onTogglePin: () => void;
  onToggleArchive: () => void;
  onToggleBlock: () => void;
  onDelete: () => void;
}) {
  const href = `/admin/c/${c.id}`;
  const unread = Math.max(0, c.admin_unread_count);
  const title = customerLabel(c.display_name, c.public_ref);
  const pinned = !!c.pinned_at;
  const archived = !!c.archived_at;
  const blocked = !!c.blocked_at;
  return (
    <li className="group relative" data-pinned={pinned ? "true" : undefined} data-archived={archived ? "true" : undefined}>
      {sectionTitle ? (
        <div className="flex items-center gap-1.5 px-5 pt-3 pb-1 text-[11px] font-semibold tracking-wide text-muted uppercase">
          {sectionTitle}
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
          <span className={`relative shrink-0 self-start ${archived ? "opacity-80" : ""}`}>
            <Avatar supabase={supabase} path={c.avatar_path} label={title} size={44} />
            {unread > 0 ? (
              <span aria-hidden className="absolute -top-0.5 -right-0.5 h-3 w-3 rounded-full border-2 border-surface bg-brand" />
            ) : null}
          </span>
          <div className="flex min-w-0 flex-1 flex-col justify-center gap-0.5">
            <div className="flex items-baseline justify-between gap-2">
              <span className={`flex min-w-0 items-baseline gap-1.5 text-sm text-ink ${unread ? "font-bold" : "font-semibold"}`}>
                {pinned && !archived ? (
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
                {c.last_message_sender === "assistant" ? <span className="font-normal text-muted">Assistant: </span> : null}
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
            {c.labels.length || blocked || c.agent_handoff_state === "handoff_requested" ? (
              <div className="mt-1 flex flex-wrap gap-1">
                <HandoffBadge state={c.agent_handoff_state ?? null} compact />
                {blocked ? (
                  <span className="inline-flex items-center gap-1 rounded-md border border-danger/25 bg-danger-soft px-1.5 py-px text-[11px] font-semibold text-danger" data-testid="blocked-chip">
                    Blocked
                  </span>
                ) : null}
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
            aria-expanded={menuOpen}
            onClick={onMenu}
            className={`flex h-8 w-8 items-center justify-center rounded-full text-muted transition hover:bg-surface hover:text-ink focus-visible:opacity-100 ${
              menuOpen
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
          {menuOpen ? (
            <div role="menu" className="absolute top-full right-0 z-30 mt-1 min-w-48 overflow-hidden rounded-xl border border-line bg-surface p-1 text-sm shadow-pop">
              {!archived ? (
                <MenuItem onClick={onTogglePin} icon={<span className="text-pin"><PinIcon size={13} /></span>}>
                  {pinned ? "Unpin chat" : "Pin chat"}
                </MenuItem>
              ) : null}
              <MenuItem onClick={onToggleArchive} icon={<span className="text-muted"><ArchiveIcon size={14} /></span>}>
                {archived ? "Unarchive chat" : "Archive chat"}
              </MenuItem>
              <div className="my-1 h-px bg-line" role="separator" />
              <MenuItem onClick={onToggleBlock} danger={!blocked} icon={<BlockGlyph />}>
                {blocked ? "Unblock customer" : "Block customer"}
              </MenuItem>
              <MenuItem onClick={onDelete} danger icon={<TrashIcon />}>
                Delete customer
              </MenuItem>
            </div>
          ) : null}
        </div>
      </div>
    </li>
  );
}

function MenuItem({
  onClick,
  icon,
  danger = false,
  children,
}: {
  onClick: () => void;
  icon: React.ReactNode;
  danger?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      className={`flex w-full items-center gap-2 rounded-lg px-3 py-2.5 text-left transition ${
        danger ? "font-medium text-danger hover:bg-danger-soft" : "text-ink hover:bg-subtle"
      }`}
    >
      {icon}
      {children}
    </button>
  );
}

function BlockCustomerDialog({
  row,
  busy,
  error,
  onCancel,
  onConfirm,
}: {
  row: AdminConversationRow;
  busy: boolean;
  error: string | null;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    cancelRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);
  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-ink/45 p-4 backdrop-blur-[2px] sm:items-center"
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="block-customer-title"
      aria-describedby="block-customer-desc"
      onClick={onCancel}
    >
      <div className="w-full max-w-sm rounded-2xl border border-line bg-surface p-5 shadow-dialog" onClick={(e) => e.stopPropagation()}>
        <h2 id="block-customer-title" className="text-base font-semibold text-ink">
          Block this customer?
        </h2>
        <div className="mt-3 rounded-xl border border-line bg-canvas px-3.5 py-2.5">
          <div className="truncate text-sm font-semibold text-ink">{row.display_name?.trim() || "No name set"}</div>
          <div className="font-mono text-xs text-muted">{row.public_ref}</div>
        </div>
        <p id="block-customer-desc" className="mt-3 text-sm text-muted">
          Neither you nor the customer can send new messages until you unblock them. The chat history, files,
          labels and pins are kept, and both of you can still read the conversation.
        </p>
        {error ? (
          <p className="mt-3 rounded-xl bg-danger-soft px-3 py-2 text-xs text-danger" role="alert">
            {error}
          </p>
        ) : null}
        <div className="mt-5 flex justify-end gap-2">
          <button ref={cancelRef} type="button" disabled={busy} onClick={onCancel} className="h-10 rounded-full border border-line px-4 text-sm font-medium text-muted hover:bg-subtle">
            Cancel
          </button>
          <button type="button" disabled={busy} onClick={onConfirm} className="h-10 rounded-full bg-danger px-4 text-sm font-semibold text-white disabled:opacity-60">
            {busy ? "Blocking…" : "Block customer"}
          </button>
        </div>
      </div>
    </div>
  );
}

function DeleteCustomerDialog({
  row,
  busy,
  error,
  onCancel,
  onConfirm,
}: {
  row: AdminConversationRow;
  busy: boolean;
  error: string | null;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    cancelRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);

  const name = row.display_name?.trim() || "No name set";
  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-ink/45 p-4 backdrop-blur-[2px] sm:items-center"
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="delete-customer-title"
      aria-describedby="delete-customer-desc"
      onClick={onCancel}
    >
      <div className="w-full max-w-sm rounded-2xl border border-line bg-surface p-5 shadow-dialog" onClick={(e) => e.stopPropagation()}>
        <h2 id="delete-customer-title" className="text-base font-semibold text-ink">
          Delete this customer?
        </h2>
        <div className="mt-3 rounded-xl border border-line bg-canvas px-3.5 py-2.5">
          <div className="truncate text-sm font-semibold text-ink">{name}</div>
          <div className="font-mono text-xs text-muted">{row.public_ref}</div>
        </div>
        <p id="delete-customer-desc" className="mt-3 text-sm text-muted">
          Their profile, the full chat history and all photos and voice notes will be permanently deleted. This
          can&apos;t be undone. Shared labels and other customers are not affected.
        </p>
        {error ? (
          <p className="mt-3 rounded-xl bg-danger-soft px-3 py-2 text-xs text-danger" role="alert">
            {error}
          </p>
        ) : null}
        <div className="mt-5 flex justify-end gap-2">
          <button
            ref={cancelRef}
            type="button"
            disabled={busy}
            onClick={onCancel}
            className="h-10 rounded-full border border-line px-4 text-sm font-medium text-muted hover:bg-subtle"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={onConfirm}
            className="h-10 rounded-full bg-danger px-4 text-sm font-semibold text-white disabled:opacity-60"
          >
            {busy ? "Deleting…" : "Delete permanently"}
          </button>
        </div>
      </div>
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

export function ArchiveIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="3" y="4" width="18" height="4" rx="1" />
      <path d="M5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8M10 12h4" />
    </svg>
  );
}

export function BlockGlyph({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
      <circle cx="12" cy="12" r="9" />
      <path d="M5.7 5.7l12.6 12.6" />
    </svg>
  );
}

function TrashIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-12M9 7V4h6v3" />
    </svg>
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
