import { bearerMatches, getAgentConfig, getServiceClient } from "@/lib/agent/config";
import { dispatchDueEvents } from "@/lib/agent/dispatcher";

const json = (body: Record<string, unknown>, status: number) =>
  Response.json(body, { status, headers: { "cache-control": "no-store" } });

/**
 * Scheduled processing endpoint (the reliable path): sends every due event
 * and retries failed ones. Call it every minute from a scheduler with
 * `Authorization: Bearer <AGENT_DISPATCH_SECRET>`. Returns counts only.
 */
export async function POST(request: Request) {
  const cfg = getAgentConfig();
  if (!bearerMatches(request.headers.get("authorization"), cfg.dispatchSecret)) {
    return json({ error: "unauthorized" }, 401);
  }
  if (!cfg.enabled) return json({ enabled: false }, 200);

  const summary = await dispatchDueEvents();
  const status = await getServiceClient(cfg).rpc("agent_bridge_status");
  return json({ ...summary, queue: status.error ? null : status.data }, summary.error ? 500 : 200);
}
