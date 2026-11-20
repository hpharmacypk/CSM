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
  /** Server id/seq (null while still sending). */
  id: string | null;
  seq: number | null;
  /** Deleted for everyone: show "This message was deleted". */
  deleted: boolean;
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
  /** Location messages. */
  latitude: number | null;
  longitude: number | null;
  accuracyM: number | null;
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
  | { kind: "location"; location: SharedLocation }
);

/** One point chosen and explicitly sent by the user (no tracking, no drafts). */
export type SharedLocation = { latitude: number; longitude: number; accuracyM: number | null };

export function isValidLocation(l: SharedLocation): boolean {
  return (
    Number.isFinite(l.latitude) &&
    Number.isFinite(l.longitude) &&
    l.latitude >= -90 &&
    l.latitude <= 90 &&
    l.longitude >= -180 &&
    l.longitude <= 180 &&
    (l.accuracyM === null || (Number.isFinite(l.accuracyM) && l.accuracyM >= 0 && l.accuracyM <= 100000))
  );
}

/** Server rows win over local copies (e.g. a message later deleted for everyone). */
function mergeMessages(existing: Message[], incoming: Message[]): Message[] {
  if (incoming.length === 0) return existing;
  const byId = new Map(existing.map((m) => [m.id, m]));
  let changed = false;
  for (const m of incoming) {
    const prev = byId.get(m.id);
    if (!prev || prev.deleted_at !== m.deleted_at || prev.body !== m.body || prev.attachment_path !== m.attachment_path) {
      byId.set(m.id, m);
      changed = true;
    }
  }
  if (!changed) return existing;
  return [...byId.values()].sort((a, b) => a.seq - b.seq);
}

/** Events other parts of the page listen to (badge, admin list). */
export const CHAT_EVENTS = {
  /** detail: { conversationId, unread } — caller's remaining unread count. */
  read: "hp:conversation-read",
  /** detail: { conversationId } — something in the thread changed (deletion). */
  changed: "hp:conversation-changed",
} as const;

function emit(name: string, detail: Record<string, unknown>) {
  window.dispatchEvent(new CustomEvent(name, { detail }));
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
  /** Shared pinned message id (conversations.pinned_message_id). */
  const [pinnedId, setPinnedId] = useState<string | null>(null);
  /** Pinned message row as this viewer may see it (RLS); null = no banner. */
  const [pinnedFetched, setPinnedFetched] = useState<Message | null>(null);

  const latestSeqRef = useRef(0);
  const oldestSeqRef = useRef(0);
  const confirmedRef = useRef<Message[]>([]);
  const lastMarkedSeqRef = useRef(0);
  const markInFlight = useRef(false);
  const catchUpRunning = useRef(false);
  const catchUpQueued = useRef(false);
  const localUrlsRef = useRef(new Set<string>());

  useEffect(() => {
    latestSeqRef.current = confirmed.length ? confirmed[confirmed.length - 1].seq : 0;
    oldestSeqRef.current = confirmed.length ? confirmed[0].seq : 0;
    confirmedRef.current = confirmed;
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
      // Re-check what is already on screen: messages deleted for everyone or
      // hidden ("delete for me", maybe in another tab) while we were away.
      if (latestSeqRef.current > 0 && oldestSeqRef.current > 0) {
        const lo = oldestSeqRef.current;
        const hi = latestSeqRef.current;
        const { data, error } = await supabase
          .from("messages")
          .select("*")
          .eq("conversation_id", conversationId)
          .gte("seq", lo)
          .lte("seq", hi)
          .order("seq", { ascending: true })
          .limit(1000);
        if (error) throw error;
        const rows = data as Message[];
        const visible = new Set(rows.map((r) => r.id));
        setConfirmed((prev) =>
          mergeMessages(
            prev.filter((m) => m.seq < lo || m.seq > hi || visible.has(m.id)),
            rows,
          ),
        );
      }
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
          if (rows.length) {
            latestSeqRef.current = rows[rows.length - 1].seq;
            // Record the window start now: a resync queued before the next
            // render must not treat the window as starting at seq 0.
            oldestSeqRef.current = rows[0].seq;
          }
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
      .on(
        "postgres_changes",
        {
          event: "UPDATE",
          schema: "public",
          table: "messages",
          filter: `conversation_id=eq.${conversationId}`,
        },
        (payload) => {
          // e.g. deleted for everyone by the sender: content arrives cleared.
          if (!active) return;
          const row = payload.new as Message;
          setConfirmed((prev) => (prev.some((m) => m.id === row.id) ? mergeMessages(prev, [row]) : prev));
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

  /**
   * Called by the thread view with the newest message the reader actually has
   * on screen (tab visible, scrolled to it). That seq — not "everything on the
   * server" — is the read boundary, so a message that arrives meanwhile stays
   * unread. The RPC is awaited: Supabase query builders are lazy and a
   * `void supabase.rpc(...)` never sends the request (the old badge bug).
   */
  const markViewed = useCallback(
    async (upToSeq: number) => {
      if (upToSeq <= lastMarkedSeqRef.current || markInFlight.current) return;
      const hasIncoming = confirmedRef.current.some(
        (m) =>
          m.seq > lastMarkedSeqRef.current &&
          m.seq <= upToSeq &&
          m.sender_role !== viewerRole &&
          !m.deleted_at,
      );
      const previous = lastMarkedSeqRef.current;
      lastMarkedSeqRef.current = upToSeq;
      if (!hasIncoming) return;
      markInFlight.current = true;
      const { data, error } = await supabase.rpc("mark_conversation_read", {
        p_conversation_id: conversationId,
        p_up_to_seq: upToSeq,
      });
      markInFlight.current = false;
      if (error) {
        lastMarkedSeqRef.current = previous; // try again on the next view
        return;
      }
      emit(CHAT_EVENTS.read, { conversationId, unread: typeof data === "number" ? data : 0 });
    },
    [supabase, conversationId, viewerRole],
  );

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
      if (item.kind === "location") {
        const { latitude, longitude, accuracyM } = item.location;
        if (!isValidLocation(item.location)) {
          markFailed(id, "That location isn't valid.");
          return false;
        }
        const { data, error } = await supabase.rpc("send_location_message", {
          p_conversation_id: conversationId,
          p_latitude: latitude,
          p_longitude: longitude,
          p_client_message_id: id,
          p_accuracy_m: accuracyM === null ? null : Math.round(accuracyM * 10) / 10,
        });
        if (error || !data) {
          markFailed(id, "Couldn't send the location. Tap Retry.");
          return false;
        }
        addConfirmed([data as Message]);
        return true;
      }
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
        .upload(path, file, { contentType: mime, upsert: false, cacheControl: "600" });
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

  const sendLocation = useCallback(
    async (location: SharedLocation) => {
      if (!isValidLocation(location)) return false;
      return enqueue({
        kind: "location",
        location,
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

  // ---------------------------------------------------------------- pinning
  // Load the pin and keep it live (the conversations row is RLS-filtered per viewer).
  useEffect(() => {
    let active = true;
    void supabase
      .from("conversations")
      .select("pinned_message_id")
      .eq("id", conversationId)
      .maybeSingle()
      .then(({ data }) => {
        if (active) setPinnedId((data as { pinned_message_id: string | null } | null)?.pinned_message_id ?? null);
      });
    const channel = supabase
      .channel(`pin:${conversationId}:${crypto.randomUUID()}`)
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "conversations", filter: `id=eq.${conversationId}` },
        (payload) => {
          if (active) setPinnedId((payload.new as { pinned_message_id?: string | null }).pinned_message_id ?? null);
        },
      )
      .subscribe();
    return () => {
      active = false;
      void supabase.removeChannel(channel);
    };
  }, [supabase, conversationId]);

  // Fetch the pinned message through the messages RLS policy, so a viewer who
  // hid it (or cannot see it) gets no banner content.
  useEffect(() => {
    let active = true;
    if (!pinnedId) {
      queueMicrotask(() => active && setPinnedFetched(null));
      return () => {
        active = false;
      };
    }
    void supabase
      .from("messages")
      .select("*")
      .eq("id", pinnedId)
      .maybeSingle()
      .then(({ data }) => {
        if (active) setPinnedFetched((data as Message | null) ?? null);
      });
    return () => {
      active = false;
    };
  }, [supabase, pinnedId]);

  const pinMessage = useCallback(
    async (messageId: string): Promise<string | null> => {
      const { error } = await supabase.rpc("pin_message", { p_message_id: messageId });
      if (error) return /deleted/i.test(error.message) ? "A deleted message can't be pinned." : "Couldn't pin the message. Try again.";
      setPinnedId(messageId);
      return null;
    },
    [supabase],
  );

  const unpinMessage = useCallback(async (): Promise<string | null> => {
    const current = pinnedId;
    if (!current) return null;
    const { error } = await supabase.rpc("unpin_message", {
      p_conversation_id: conversationId,
      p_expected_message_id: current,
    });
    if (error) return "Couldn't unpin the message. Try again.";
    setPinnedId((id) => (id === current ? null : id));
    return null;
  }, [supabase, conversationId, pinnedId]);

  /**
   * Make sure a message is loaded (fetching the older range between it and the
   * oldest loaded message if needed). Returns false if it isn't visible to us.
   */
  const ensureLoaded = useCallback(
    async (messageId: string): Promise<boolean> => {
      if (confirmedRef.current.some((m) => m.id === messageId)) return true;
      const { data: target } = await supabase
        .from("messages")
        .select("id, seq")
        .eq("id", messageId)
        .maybeSingle();
      const t = target as { id: string; seq: number } | null;
      if (!t) return false;
      const oldest = oldestSeqRef.current || Number.MAX_SAFE_INTEGER;
      const { data, error } = await supabase
        .from("messages")
        .select("*")
        .eq("conversation_id", conversationId)
        .gte("seq", t.seq)
        .lt("seq", oldest)
        .order("seq", { ascending: true })
        .limit(1000);
      if (error) return false;
      setConfirmed((prev) => mergeMessages(prev, data as Message[]));
      return true;
    },
    [supabase, conversationId],
  );

  /** "Delete for me": hidden only for this viewer (enforced by RLS). */
  const hideForMe = useCallback(
    async (messageId: string): Promise<string | null> => {
      const removed = confirmedRef.current.find((m) => m.id === messageId);
      setConfirmed((prev) => prev.filter((m) => m.id !== messageId));
      setPinnedFetched((p) => (p?.id === messageId ? null : p));
      const { error } = await supabase.rpc("hide_message_for_me", { p_message_id: messageId });
      if (error) {
        if (removed) setConfirmed((prev) => mergeMessages(prev, [removed]));
        return "Couldn't delete the message. Try again.";
      }
      emit(CHAT_EVENTS.changed, { conversationId });
      return null;
    },
    [supabase, conversationId],
  );

  /** "Delete for everyone": sender only (enforced by the database). */
  const deleteForEveryone = useCallback(
    async (messageId: string): Promise<string | null> => {
      const { data, error } = await supabase.rpc("delete_message_for_everyone", {
        p_message_id: messageId,
      });
      if (error || !data) {
        return /own messages/i.test(error?.message ?? "")
          ? "You can only delete your own messages for everyone."
          : "Couldn't delete the message. Try again.";
      }
      setConfirmed((prev) => mergeMessages(prev, [data as Message]));
      emit(CHAT_EVENTS.changed, { conversationId });
      return null;
    },
    [supabase, conversationId],
  );

  const discard = useCallback((clientMessageId: string) => {
    setPending((prev) => prev.filter((p) => p.clientMessageId !== clientMessageId));
  }, []);

  // Release local audio previews once they are no longer pending.
  useEffect(() => {
    const live = new Set(pending.flatMap((p) => (p.kind === "audio" || p.kind === "image" ? [p.localUrl] : [])));
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

  const pinnedMessage: Message | null = useMemo(() => {
    if (!pinnedId) return null;
    if (pinnedFetched === null || pinnedFetched.id !== pinnedId) return null;
    const live = confirmed.find((m) => m.id === pinnedId);
    const row = live ?? pinnedFetched;
    return row.deleted_at ? null : row;
  }, [pinnedId, pinnedFetched, confirmed]);

  const messages: DisplayMessage[] = useMemo(() => {
    const confirmedIds = new Set(confirmed.map((m) => m.client_message_id));
    return [
      ...confirmed.map<DisplayMessage>((m) => ({
        key: m.id,
        id: m.id,
        seq: m.seq,
        deleted: m.deleted_at !== null && m.deleted_at !== undefined,
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
        latitude: m.location_lat,
        longitude: m.location_lng,
        accuracyM: m.location_accuracy_m,
        localUrl: null,
        failReason: null,
      })),
      ...pending
        .filter((p) => !confirmedIds.has(p.clientMessageId))
        .map<DisplayMessage>((p) => ({
          key: `pending-${p.clientMessageId}`,
          id: null,
          seq: null,
          deleted: false,
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
          latitude: p.kind === "location" ? p.location.latitude : null,
          longitude: p.kind === "location" ? p.location.longitude : null,
          accuracyM: p.kind === "location" ? p.location.accuracyM : null,
          localUrl: p.kind === "text" || p.kind === "location" ? null : p.localUrl,
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
    markViewed,
    sendLocation,
    pinnedId,
    pinnedMessage,
    pinMessage,
    unpinMessage,
    ensureLoaded,
    hideForMe,
    deleteForEveryone,
    connection,
    reload: catchUp,
  };
}
