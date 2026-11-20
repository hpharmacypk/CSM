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
  last_message_sender: "customer" | "admin" | null;
  last_message_preview: string | null;
  admin_unread_count: number;
  labels: Label[];
  /** Set when an admin pinned this chat (admin-only). */
  pinned_at: string | null;
};

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
