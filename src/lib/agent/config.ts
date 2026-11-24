import "server-only";

import { createHash, timingSafeEqual } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { SUPABASE_URL } from "@/lib/supabase/config";

/**
 * Server-only settings for the order-agent bridge. None of these are
 * NEXT_PUBLIC: they never reach the browser bundle. Missing values keep the
 * bridge off (the chat itself never depends on them).
 */
export type AgentConfig = {
  enabled: boolean;
  /** Supabase secret (service_role) key: the bridge's database functions are granted only to it. */
  secretKey: string;
  webhookUrl: string;
  webhookHeaderName: string;
  webhookHeaderValue: string;
  callbackSecret: string;
  dispatchSecret: string;
};

export function getAgentConfig(): AgentConfig {
  const env = process.env;
  const cfg: AgentConfig = {
    enabled: env.AGENT_BRIDGE_ENABLED === "true",
    secretKey: env.SUPABASE_SECRET_KEY ?? "",
    webhookUrl: env.N8N_INBOX_WEBHOOK_URL ?? "",
    webhookHeaderName: env.N8N_INBOX_WEBHOOK_HEADER_NAME ?? "",
    webhookHeaderValue: env.N8N_INBOX_WEBHOOK_HEADER_VALUE ?? "",
    callbackSecret: env.AGENT_CALLBACK_SECRET ?? "",
    dispatchSecret: env.AGENT_DISPATCH_SECRET ?? "",
  };
  // Every piece is required; a half-configured bridge stays off.
  cfg.enabled =
    cfg.enabled &&
    Boolean(SUPABASE_URL && cfg.secretKey && cfg.webhookUrl && cfg.webhookHeaderName && cfg.webhookHeaderValue && cfg.callbackSecret);
  return cfg;
}

let serviceClient: SupabaseClient | null = null;

/** Supabase client with the secret key. Used only by the bridge routes on the server. */
export function getServiceClient(cfg: AgentConfig): SupabaseClient {
  if (!serviceClient) {
    serviceClient = createClient(SUPABASE_URL, cfg.secretKey, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    });
  }
  return serviceClient;
}

/** Constant-time check of an `Authorization: Bearer <secret>` header. */
export function bearerMatches(header: string | null, secret: string): boolean {
  if (!secret || !header) return false;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (!match) return false;
  const a = createHash("sha256").update(match[1]).digest();
  const b = createHash("sha256").update(secret).digest();
  return timingSafeEqual(a, b);
}
