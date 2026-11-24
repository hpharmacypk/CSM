"use client";

import type { SupabaseClient } from "@supabase/supabase-js";

export type Label = { id: string; name: string };

/** Row returned by public.admin_list_conversations (admin-only). */
export type AdminConversationRow = {
  id: string;
  customer_id: string;
  public_ref: string;
  display_name: string | null;
  avatar_path: string | null;
  created_at: string;
  last_message_at: string | null;
  /** "assistant" when the newest message is an order-agent reply. */
  last_message_sender: "customer" | "admin" | "assistant" | null;
  last_message_preview: string | null;
  admin_unread_count: number;
  labels: Label[];
  /** Set when an admin pinned this chat (admin-only). */
  pinned_at: string | null;
  /** Set when an admin archived this chat (admin-only; independent of the customer). */
  archived_at: string | null;
  /** Set while the admin has blocked this customer (no new messages either way). */
  blocked_at?: string | null;
  /** Order-agent handoff state ("handoff_requested" = Needs staff). */
  agent_handoff_state?: string | null;
};

/** detail: { conversationId, blocked } — the admin blocked/unblocked a customer. */
export const BLOCK_CHANGED = "hp:block-changed";

export function emitBlockChanged(conversationId: string, blocked: boolean) {
  window.dispatchEvent(new CustomEvent(BLOCK_CHANGED, { detail: { conversationId, blocked } }));
}

/** detail: { conversationId, archived } — the admin archived/unarchived a chat. */
export const ARCHIVE_CHANGED = "hp:archive-changed";

export function emitArchiveChanged(conversationId: string, archived: boolean) {
  window.dispatchEvent(new CustomEvent(ARCHIVE_CHANGED, { detail: { conversationId, archived } }));
}

/** One Storage object still queued for removal after a customer was deleted. */
type PendingFile = { bucket_id: string; object_name: string };

/**
 * Removes files of deleted customers through the Storage API with the admin's
 * own session (Storage policies allow this only for queued files), then asks
 * the database what is still left. Safe to call any number of times.
 * Returns the number of files still pending, or null if the queue can't be read.
 */
export async function runStorageCleanup(supabase: SupabaseClient): Promise<number | null> {
  const first = await supabase.rpc("admin_pending_storage_cleanup");
  if (first.error) return null;
  const files = (first.data as PendingFile[] | null) ?? [];
  if (files.length === 0) return 0;

  const byBucket = new Map<string, string[]>();
  for (const f of files) byBucket.set(f.bucket_id, [...(byBucket.get(f.bucket_id) ?? []), f.object_name]);
  for (const [bucket, names] of byBucket) {
    for (let i = 0; i < names.length; i += 100) {
      // Errors are reflected in the re-check below; nothing else to do here.
      await supabase.storage.from(bucket).remove(names.slice(i, i + 100));
    }
  }

  const again = await supabase.rpc("admin_pending_storage_cleanup");
  if (again.error) return null;
  return ((again.data as PendingFile[] | null) ?? []).length;
}

/** Fired after the admin creates, renames, deletes, assigns or removes labels. */
export const LABELS_CHANGED = "hp:labels-changed";

export function emitLabelsChanged() {
  window.dispatchEvent(new CustomEvent(LABELS_CHANGED));
}

export async function fetchLabels(supabase: SupabaseClient): Promise<Label[]> {
  const { data } = await supabase.from("labels").select("id, name").order("name");
  return ((data as Label[] | null) ?? []).sort((a, b) =>
    a.name.localeCompare(b.name, "en", { sensitivity: "base" }),
  );
}

/** Readable message for a failed label write. */
export function labelErrorMessage(error: { code?: string; message?: string } | null): string {
  if (!error) return "Something went wrong.";
  if (error.code === "23505") return "A label with that name already exists.";
  if (error.code === "23514") return "Label names must be 1–40 characters.";
  return "Couldn't save the label. Try again.";
}
