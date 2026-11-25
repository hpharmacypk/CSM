import { bearerMatches, getAgentConfig, getServiceClient } from "@/lib/agent/config";
import { dispatchDueEvents, type DispatchSummary } from "@/lib/agent/dispatcher";
import { getPushConfig, getPushServiceClient } from "@/lib/push/config";
import { dispatchPushJobs } from "@/lib/push/dispatcher";

const json = (body: Record<string, unknown>, status: number) =>
  Response.json(body, { status, headers: { "cache-control": "no-store" } });

/**
 * Scheduled processing endpoint (the reliable path): sends every due
 * order-agent event and every due reply notification, and retries failed
 * ones. Call it every minute from a scheduler with
 * `Authorization: Bearer <AGENT_DISPATCH_SECRET>`. Returns counts only.
 */
export async function POST(request: Request) {
  const cfg = getAgentConfig();
  if (!bearerMatches(request.headers.get("authorization"), cfg.dispatchSecret)) {
    return json({ error: "unauthorized" }, 401);
  }
  const pushCfg = getPushConfig();

  const [agent, push] = await Promise.all([
    cfg.enabled ? dispatchDueEvents() : Promise.resolve<DispatchSummary | null>(null),
    pushCfg.enabled ? dispatchPushJobs() : Promise.resolve(null),
  ]);

  const body: Record<string, unknown> = agent ? { ...agent } : { enabled: false };
  if (agent) {
    const status = await getServiceClient(cfg).rpc("agent_bridge_status");
    body.queue = status.error ? null : status.data;
  }
  if (push) {
    const service = getPushServiceClient(pushCfg);
    const [status, adminStatus] = await Promise.all([service.rpc("push_status"), service.rpc("admin_push_status")]);
    body.push = {
      ...push,
      queue: status.error ? null : status.data,
      // Staff notifications (absent before the admin push migration).
      admin_queue: adminStatus.error ? null : adminStatus.data,
    };
  } else {
    body.push = { enabled: false };
  }
  return json(body, agent?.error || push?.error ? 500 : 200);
}
