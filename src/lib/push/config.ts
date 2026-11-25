import "server-only";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { SUPABASE_URL } from "@/lib/supabase/config";

/**
 * Server-only Web Push settings. None of these are NEXT_PUBLIC; the browser
 * gets the VAPID public key from GET /api/push/config at runtime. Missing
 * values keep push off (the chat never depends on them).
 */
export type PushConfig = {
  enabled: boolean;
  /** Supabase secret (service_role) key: the push queue functions are granted only to it. */
  secretKey: string;
  publicKey: string;
  privateKey: string;
  /** mailto: or https: contact the push services can reach (VAPID "sub"). */
  subject: string;
  /**
   * Test-only: also allow http(s)://127.0.0.1:<port> endpoints so a local mock
   * push service can be used. Never set this in production; the database
   * refuses such endpoints from browsers in any case.
   */
  allowLoopbackForTests: boolean;
};

const B64URL = /^[A-Za-z0-9_-]+$/;

export function getPushConfig(): PushConfig {
  const env = process.env;
  const cfg: PushConfig = {
    enabled: env.WEB_PUSH_ENABLED === "true",
    secretKey: env.SUPABASE_SECRET_KEY ?? "",
    publicKey: (env.VAPID_PUBLIC_KEY ?? "").trim(),
    privateKey: (env.VAPID_PRIVATE_KEY ?? "").trim(),
    subject: (env.VAPID_SUBJECT ?? "").trim(),
    allowLoopbackForTests: env.WEB_PUSH_ALLOW_LOOPBACK_FOR_TESTS === "true",
  };
  const keysLookValid =
    B64URL.test(cfg.publicKey) &&
    cfg.publicKey.length === 87 &&
    B64URL.test(cfg.privateKey) &&
    cfg.privateKey.length === 43;
  const subjectValid = /^(mailto:[^\s@]+@[^\s@]+|https:\/\/\S+)$/.test(cfg.subject);
  cfg.enabled = cfg.enabled && Boolean(SUPABASE_URL && cfg.secretKey && keysLookValid && subjectValid);
  return cfg;
}

let serviceClient: SupabaseClient | null = null;

/** Supabase client with the secret key, used only by the push queue on the server. */
export function getPushServiceClient(cfg: PushConfig): SupabaseClient {
  if (!serviceClient) {
    serviceClient = createClient(SUPABASE_URL, cfg.secretKey, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    });
  }
  return serviceClient;
}
