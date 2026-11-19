"use client";

import { createBrowserClient } from "@supabase/ssr";
import type { SupabaseClient } from "@supabase/supabase-js";
import { ADMIN_COOKIE_NAME, SUPABASE_PUBLISHABLE_KEY, SUPABASE_URL } from "./config";

/** Browser client for the admin dashboard. Session is kept in admin-only cookies. */
export function getAdminBrowserClient(): SupabaseClient {
  return createBrowserClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
    cookieOptions: { name: ADMIN_COOKIE_NAME, sameSite: "lax", path: "/" },
    auth: { detectSessionInUrl: false },
  });
}
