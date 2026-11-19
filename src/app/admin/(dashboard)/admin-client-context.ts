"use client";

import { createContext, use } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";

export const AdminClientContext = createContext<SupabaseClient | null>(null);

export function useAdminClient(): SupabaseClient {
  const client = use(AdminClientContext);
  if (!client) throw new Error("useAdminClient must be used inside AdminShell");
  return client;
}
