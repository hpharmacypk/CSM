"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Message, SenderRole } from "@/lib/types";
import { IMAGE_MAX_UPLOAD_BYTES, type PreparedImage } from "./image";
import {
  MEDIA_BUCKET,
  VOICE_MAX_BYTES,
  isAlreadyUploaded,
  uploadErrorMessage,
  type VoiceRecording,
} from "./voice";

const PAGE_SIZE = 50;
const CATCH_UP_PAGE = 200;

export type ConnectionState = "connecting" | "live" | "reconnecting";

export type DisplayMessage = {
  key: string;
  clientMessageId: string;
  senderRole: SenderRole;
  type: Message["type"];
  body: string;
  createdAt: string;
  status: "sent" | "sending" | "failed";
  /** Storage path for saved attachments. */
  attachmentPath: string | null;
  attachmentMime: string | null;
  durationMs: number | null;
  /** Image dimensions (for layout before the image loads). */
  width: number | null;
  height: number | null;
  /** Local object URL for an attachment that is still being sent. */
  localUrl: string | null;
  /** Readable reason when status is "failed". */
  failReason: string | null;
};

type PendingMessage = {
  clientMessageId: string;
  createdAt: string;
  status: "sending" | "failed";
  failReason?: string;
} & (
  | { kind: "text"; body: string }
  | { kind: "audio"; recording: VoiceRecording; localUrl: string }
  | { kind: "image"; image: PreparedImage; localUrl: string }
);

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
  const localUrlsRef = useRef(new Set<string>());

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

  const markFailed = useCallback((clientMessageId: string, reason: string) => {
    setPending((prev) =>
      prev.map((p) =>
        p.clientMessageId === clientMessageId ? { ...p, status: "failed", failReason: reason } : p,
      ),
    );
  }, []);

  /**
   * Sends (or re-sends) one pending item. Every step is idempotent for the
   * same client id: the upload path is derived from it (a repeat upload is
   * a 409 we treat as success) and the database returns the existing row.
   */
  const deliver = useCallback(
    async (item: PendingMessage) => {
      const id = item.clientMessageId;
      if (item.kind === "text") {
        const { data, error } = await supabase.rpc("send_message", {
          p_conversation_id: conversationId,
          p_body: item.body,
          p_client_message_id: id,
        });
        if (error || !data) {
          markFailed(id, "Not sent");
          return false;
        }
        addConfirmed([data as Message]);
        return true;
      }

      // Attachments (voice note or image): upload, then reference it.
      const isImage = item.kind === "image";
      const { blob, mime, ext } = isImage ? item.image : item.recording;
      const noun = isImage ? "image" : "voice note";
      if (blob.size > (isImage ? IMAGE_MAX_UPLOAD_BYTES : VOICE_MAX_BYTES)) {
        markFailed(id, `The ${noun} is too large to send.`);
        return false;
      }
      const path = `${conversationId}/${id}.${ext}`;
      // Re-wrap so the multipart part carries the base type the bucket allows.
      const file = new Blob([blob], { type: mime });
      const upload = await supabase.storage
        .from(MEDIA_BUCKET)
        .upload(path, file, { contentType: mime, upsert: false, cacheControl: "31536000" });
      if (upload.error && !isAlreadyUploaded(upload.error)) {
        markFailed(id, uploadErrorMessage(upload.error, noun));
        return false;
      }
      const { data, error } = await supabase.rpc(
        "send_attachment_message",
        isImage
          ? {
              p_conversation_id: conversationId,
              p_type: "image",
              p_attachment_path: path,
              p_client_message_id: id,
              p_width: item.image.width,
              p_height: item.image.height,
            }
          : {
              p_conversation_id: conversationId,
              p_type: "audio",
              p_attachment_path: path,
              p_client_message_id: id,
              p_duration_ms: Math.round(item.recording.durationMs),
            },
      );
      if (error || !data) {
        markFailed(id, `Couldn't send the ${noun}. Tap Retry.`);
        return false;
      }
      addConfirmed([data as Message]);
      return true;
    },
    [supabase, conversationId, addConfirmed, markFailed],
  );

  const enqueue = useCallback(
    (item: PendingMessage) => {
      setPending((prev) => [...prev, item]);
      return deliver(item);
    },
    [deliver],
  );

  const send = useCallback(
    async (rawBody: string) => {
      const body = rawBody.trim();
      if (!body) return false;
      return enqueue({
        kind: "text",
        body,
        clientMessageId: crypto.randomUUID(),
        createdAt: new Date().toISOString(),
        status: "sending",
      });
    },
    [enqueue],
  );

  const sendVoice = useCallback(
    async (recording: VoiceRecording) => {
      const localUrl = URL.createObjectURL(recording.blob);
      localUrlsRef.current.add(localUrl);
      return enqueue({
        kind: "audio",
        recording,
        localUrl,
        clientMessageId: crypto.randomUUID(),
        createdAt: new Date().toISOString(),
        status: "sending",
      });
    },
    [enqueue],
  );

  const sendImage = useCallback(
    async (image: PreparedImage) => {
      const localUrl = URL.createObjectURL(image.blob);
      localUrlsRef.current.add(localUrl);
      return enqueue({
        kind: "image",
        image,
        localUrl,
        clientMessageId: crypto.randomUUID(),
        createdAt: new Date().toISOString(),
        status: "sending",
      });
    },
    [enqueue],
  );

  const retry = useCallback(
    async (clientMessageId: string) => {
      const item = pending.find((p) => p.clientMessageId === clientMessageId);
      if (!item || item.status === "sending") return;
      setPending((prev) =>
        prev.map((p) =>
          p.clientMessageId === clientMessageId
            ? { ...p, status: "sending", failReason: undefined }
            : p,
        ),
      );
      await deliver(item);
    },
    [pending, deliver],
  );

  const discard = useCallback((clientMessageId: string) => {
    setPending((prev) => prev.filter((p) => p.clientMessageId !== clientMessageId));
  }, []);

  // Release local audio previews once they are no longer pending.
  useEffect(() => {
    const live = new Set(pending.flatMap((p) => (p.kind === "text" ? [] : [p.localUrl])));
    for (const url of localUrlsRef.current) {
      if (!live.has(url)) {
        URL.revokeObjectURL(url);
        localUrlsRef.current.delete(url);
      }
    }
  }, [pending]);
  useEffect(() => {
    const urls = localUrlsRef.current;
    return () => {
      urls.forEach((url) => URL.revokeObjectURL(url));
      urls.clear();
    };
  }, []);

  const messages: DisplayMessage[] = useMemo(() => {
    const confirmedIds = new Set(confirmed.map((m) => m.client_message_id));
    return [
      ...confirmed.map<DisplayMessage>((m) => ({
        key: m.id,
        clientMessageId: m.client_message_id,
        senderRole: m.sender_role,
        type: m.type,
        body: m.body ?? "",
        createdAt: m.created_at,
        status: "sent",
        attachmentPath: m.attachment_path,
        attachmentMime: m.attachment_mime,
        durationMs: m.attachment_duration_ms,
        width: m.attachment_width,
        height: m.attachment_height,
        localUrl: null,
        failReason: null,
      })),
      ...pending
        .filter((p) => !confirmedIds.has(p.clientMessageId))
        .map<DisplayMessage>((p) => ({
          key: `pending-${p.clientMessageId}`,
          clientMessageId: p.clientMessageId,
          senderRole: viewerRole,
          type: p.kind,
          body: p.kind === "text" ? p.body : "",
          createdAt: p.createdAt,
          status: p.status,
          attachmentPath: null,
          attachmentMime:
            p.kind === "audio" ? p.recording.mime : p.kind === "image" ? p.image.mime : null,
          durationMs: p.kind === "audio" ? p.recording.durationMs : null,
          width: p.kind === "image" ? p.image.width : null,
          height: p.kind === "image" ? p.image.height : null,
          localUrl: p.kind === "text" ? null : p.localUrl,
          failReason: p.failReason ?? null,
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
    sendVoice,
    sendImage,
    retry,
    discard,
    connection,
    reload: catchUp,
  };
}
