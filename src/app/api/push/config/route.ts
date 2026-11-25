import { connection } from "next/server";
import { getPushConfig } from "@/lib/push/config";

/** Tells the Inbox whether notifications are offered and which VAPID public key to subscribe with. */
export async function GET() {
  // Read the server settings per request, never at build time.
  await connection();
  const cfg = getPushConfig();
  return Response.json(cfg.enabled ? { enabled: true, publicKey: cfg.publicKey } : { enabled: false }, {
    headers: { "cache-control": "no-store" },
  });
}
