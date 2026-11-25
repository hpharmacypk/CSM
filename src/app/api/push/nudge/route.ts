import { getPushConfig } from "@/lib/push/config";
import { dispatchPushJobs } from "@/lib/push/dispatcher";

/**
 * Browser hint after a staff reply is saved: send due notifications now
 * instead of at the next scheduled run. Carries no data (the jobs were stored
 * with the reply). The work is awaited inside this request, so a host that
 * stops background work after the response cannot cut it short; anything
 * left over is retried by the scheduled /api/agent/dispatch call.
 */
export async function POST() {
  if (getPushConfig().enabled) await dispatchPushJobs();
  return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
}
