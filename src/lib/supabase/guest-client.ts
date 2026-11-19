"use client";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { GUEST_STORAGE_KEY, SUPABASE_PUBLISHABLE_KEY, SUPABASE_URL } from "./config";

let guestClient: SupabaseClient | null = null;

/**
 * Browser-only client for the customer inbox. The anonymous session lives in
 * localStorage under its own key, separate from the admin cookie session.
 */
export function getGuestClient(): SupabaseClient {
  if (!guestClient) {
    guestClient = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
      auth: {
        storageKey: GUEST_STORAGE_KEY,
        storage: window.localStorage,
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: false,
      },
    });
  }
  return guestClient;
}
