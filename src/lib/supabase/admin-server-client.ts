import "server-only";

import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import {
  ADMIN_COOKIE_NAME,
  SUPABASE_PUBLISHABLE_KEY,
  SUPABASE_URL,
  isSupabaseConfigured,
} from "./config";

/** Server-side client bound to the admin cookie session of the current request. */
export async function getAdminServerClient() {
  const cookieStore = await cookies();
  return createServerClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
    cookieOptions: { name: ADMIN_COOKIE_NAME, sameSite: "lax", path: "/" },
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          cookiesToSet.forEach(({ name, value, options }) =>
            cookieStore.set(name, value, options),
          );
        } catch {
          // Called from a Server Component: cookies are read-only there.
          // The proxy refreshes the admin session cookies instead.
        }
      },
    },
  });
}

/**
 * Returns the signed-in admin's user id, or null when the request has no
 * valid admin session. Membership is checked by the database (private.admins).
 */
export async function getVerifiedAdminId(): Promise<string | null> {
  if (!isSupabaseConfigured()) return null;
  const supabase = await getAdminServerClient();
  // getUser() validates the token with Supabase Auth (not just the cookie).
  const { data: userData, error: userError } = await supabase.auth.getUser();
  if (userError || !userData.user || userData.user.is_anonymous) return null;

  const { data: isAdmin, error } = await supabase.rpc("am_i_admin");
  if (error || isAdmin !== true) return null;
  return userData.user.id;
}
