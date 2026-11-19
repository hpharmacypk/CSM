"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Message, SenderRole } from "@/lib/types";

const PAGE_SIZE = 50;
const CATCH_UP_PAGE = 200;

export type ConnectionState = "connecting" | "live" | "reconnecting";

export type DisplayMessage = {
  key: string;
  clientMessageId: string;
  senderRole: SenderRole;
  body: string;
  createdAt: string;
  status: "sent" | "sending" | "failed";
};

type PendingMessage = {
  clientMessageId: string;
  body: string;
  createdAt: string;
  status: "sending" | "failed";
};

function mergeMessages(existing: Message[], incoming: Message[]): Message[] {
  if (incoming.length === 0) return existing;
  const byId = new Map(existing.map((m) => [m.id, m]));
  let changed = false;
  for (const m of incoming) {
    if (!byId.has(m.id)) {
      byId.set(m.id, m);
      changed = true;
    }
  }
  if (!changed) return existing;
  return [...byId.values()].sort((a, b) => a.seq - b.seq);
}

function errorText(error: unknown): string {
  if (error && typeof error === "object" && "message" in error) {
    return String((error as { message: unknown }).message);
  }
  return "Something went wrong.";
}

/**
 * Loads one conversation's history, keeps it live over Supabase Realtime and
 * recovers anything missed after a reconnect. Sending is idempotent: each
 * message gets a client id that is reused on retry, so the database never
 * stores a duplicate.
 *
 * The caller should remount (key=conversationId) when the conversation changes.
 */
export function useConversationMessages(
  supabase: SupabaseClient,
  conversationId: string,
  viewerRole: SenderRole,
) {
  const [confirmed, setConfirmed] = useState<Message[]>([]);
  const [pending, setPending] = useState<PendingMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [hasOlder, setHasOlder] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [connection, setConnection] = useState<ConnectionState>("connecting");

  const latestSeqRef = useRef(0);
  const lastMarkedSeqRef = useRef(0);
  const catchUpRunning = useRef(false);
  const catchUpQueued = useRef(false);

  useEffect(() => {
    latestSeqRef.current = confirmed.length ? confirmed[confirmed.length - 1].seq : 0;
  }, [confirmed]);

  const addConfirmed = useCallback((rows: Message[]) => {
    setConfirmed((prev) => mergeMessages(prev, rows));
    const ids = new Set(rows.map((r) => r.client_message_id));
    setPending((prev) => prev.filter((p) => !ids.has(p.clientMessageId)));
  }, []);

  /** Fetch every message newer than the newest one we already have. */
  const catchUp = useCallback(async () => {
    if (catchUpRunning.current) {
      // Run once more after the current pass so nothing in between is missed.
      catchUpQueued.current = true;
      return;
    }
    catchUpRunning.current = true;
    catchUpQueued.current = false;
    try {
      for (;;) {
        const after = latestSeqRef.current;
        if (after === 0) {
          const { data, error } = await supabase
            .from("messages")
            .select("*")
            .eq("conversation_id", conversationId)
            .order("seq", { ascending: false })
            .limit(PAGE_SIZE);
          if (error) throw error;
          const rows = (data as Message[]).reverse();
          addConfirmed(rows);
          setHasOlder(rows.length === PAGE_SIZE);
          if (rows.length) latestSeqRef.current = rows[rows.length - 1].seq;
          break;
        }
        const { data, error } = await supabase
          .from("messages")
          .select("*")
          .eq("conversation_id", conversationId)
          .gt("seq", after)
          .order("seq", { ascending: true })
          .limit(CATCH_UP_PAGE);
        if (error) throw error;
        const rows = data as Message[];
        addConfirmed(rows);
        if (rows.length) latestSeqRef.current = rows[rows.length - 1].seq;
        if (rows.length < CATCH_UP_PAGE) break;
      }
      setLoadError(null);
    } catch (error) {
      setLoadError(errorText(error));
    } finally {
      catchUpRunning.current = false;
      setLoading(false);
    }
    if (catchUpQueued.current) await catchUpRef.current();
  }, [supabase, conversationId, addConfirmed]);

  const catchUpRef = useRef(catchUp);
  useEffect(() => {
    catchUpRef.current = catchUp;
  }, [catchUp]);

  // Initial load + live subscription + reconnect recovery.
  useEffect(() => {
    let active = true;
    // Initial history load (state updates happen asynchronously).
    queueMicrotask(() => {
      if (active) void catchUp();
    });

    const channel = supabase
      .channel(`messages:${conversationId}:${crypto.randomUUID()}`)
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "messages",
          filter: `conversation_id=eq.${conversationId}`,
        },
        (payload) => {
          if (active) addConfirmed([payload.new as Message]);
        },
      )
      .subscribe((status) => {
        if (!active) return;
        if (status === "SUBSCRIBED") {
          setConnection("live");
          // Anything sent while we were disconnected is fetched here.
          void catchUp();
        } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") {
          setConnection("reconnecting");
        }
      });

    const onWake = () => {
      if (document.visibilityState === "visible") void catchUp();
    };
    window.addEventListener("online", onWake);
    document.addEventListener("visibilitychange", onWake);

    return () => {
      active = false;
      window.removeEventListener("online", onWake);
      document.removeEventListener("visibilitychange", onWake);
      void supabase.removeChannel(channel);
    };
  }, [supabase, conversationId, catchUp, addConfirmed]);

  // Mark as read whenever a message from the other side is visible.
  useEffect(() => {
    const markIfNeeded = () => {
      if (document.visibilityState !== "visible") return;
      const latest = confirmed[confirmed.length - 1];
      if (!latest || latest.seq <= lastMarkedSeqRef.current) return;
      const hasIncoming = confirmed.some(
        (m) => m.seq > lastMarkedSeqRef.current && m.sender_role !== viewerRole,
      );
      lastMarkedSeqRef.current = latest.seq;
      if (hasIncoming) {
        void supabase.rpc("mark_conversation_read", { p_conversation_id: conversationId });
      }
    };
    markIfNeeded();
    document.addEventListener("visibilitychange", markIfNeeded);
    return () => document.removeEventListener("visibilitychange", markIfNeeded);
  }, [confirmed, supabase, conversationId, viewerRole]);

  const loadOlder = useCallback(async () => {
    const oldest = confirmed[0];
    if (!oldest || loadingOlder) return;
    setLoadingOlder(true);
    const { data, error } = await supabase
      .from("messages")
      .select("*")
      .eq("conversation_id", conversationId)
      .lt("seq", oldest.seq)
      .order("seq", { ascending: false })
      .limit(PAGE_SIZE);
    if (!error) {
      const rows = data as Message[];
      setConfirmed((prev) => mergeMessages(prev, rows));
      setHasOlder(rows.length === PAGE_SIZE);
    }
    setLoadingOlder(false);
  }, [confirmed, loadingOlder, supabase, conversationId]);

  const deliver = useCallback(
    async (clientMessageId: string, body: string) => {
      const { data, error } = await supabase.rpc("send_message", {
        p_conversation_id: conversationId,
        p_body: body,
        p_client_message_id: clientMessageId,
      });
      if (error || !data) {
        setPending((prev) =>
          prev.map((p) =>
            p.clientMessageId === clientMessageId ? { ...p, status: "failed" } : p,
          ),
        );
        return false;
      }
      addConfirmed([data as Message]);
      return true;
    },
    [supabase, conversationId, addConfirmed],
  );

  const send = useCallback(
    async (rawBody: string) => {
      const body = rawBody.trim();
      if (!body) return false;
      const clientMessageId = crypto.randomUUID();
      setPending((prev) => [
        ...prev,
        { clientMessageId, body, createdAt: new Date().toISOString(), status: "sending" },
      ]);
      return deliver(clientMessageId, body);
    },
    [deliver],
  );

  const retry = useCallback(
    async (clientMessageId: string) => {
      const item = pending.find((p) => p.clientMessageId === clientMessageId);
      if (!item) return;
      setPending((prev) =>
        prev.map((p) =>
          p.clientMessageId === clientMessageId ? { ...p, status: "sending" } : p,
        ),
      );
      await deliver(clientMessageId, item.body);
    },
    [pending, deliver],
  );

  const discard = useCallback((clientMessageId: string) => {
    setPending((prev) => prev.filter((p) => p.clientMessageId !== clientMessageId));
  }, []);

  const messages: DisplayMessage[] = useMemo(() => {
    const confirmedIds = new Set(confirmed.map((m) => m.client_message_id));
    return [
      ...confirmed.map<DisplayMessage>((m) => ({
        key: m.id,
        clientMessageId: m.client_message_id,
        senderRole: m.sender_role,
        body: m.body ?? "",
        createdAt: m.created_at,
        status: "sent",
      })),
      ...pending
        .filter((p) => !confirmedIds.has(p.clientMessageId))
        .map<DisplayMessage>((p) => ({
          key: `pending-${p.clientMessageId}`,
          clientMessageId: p.clientMessageId,
          senderRole: viewerRole,
          body: p.body,
          createdAt: p.createdAt,
          status: p.status,
        })),
    ];
  }, [confirmed, pending, viewerRole]);

  return {
    messages,
    loading,
    loadError,
    hasOlder,
    loadingOlder,
    loadOlder,
    send,
    retry,
    discard,
    connection,
    reload: catchUp,
  };
}
