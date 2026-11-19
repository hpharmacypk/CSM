/**
 * Public Supabase settings. Both values are safe to expose to the browser:
 * access is enforced by Row Level Security and database functions.
 */
export const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
export const SUPABASE_PUBLISHABLE_KEY =
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? "";

export function isSupabaseConfigured(): boolean {
  return Boolean(SUPABASE_URL && SUPABASE_PUBLISHABLE_KEY);
}

/**
 * Guest and admin sessions are stored under different names AND in different
 * places, so signing in as admin can never replace a guest inbox session in
 * the same browser (and vice versa).
 *   - Guest: localStorage key below (client-only, never sent to our server).
 *   - Admin: HTTP cookies with the name below (needed for server-side checks).
 */
export const GUEST_STORAGE_KEY = "hp-guest-auth";
export const ADMIN_COOKIE_NAME = "hp-admin-auth";
