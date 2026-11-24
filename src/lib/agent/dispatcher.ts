import "server-only";

import { getAgentConfig, getServiceClient, type AgentConfig } from "./config";

type ClaimedEvent = { event_id: string; attempt: number; payload: Record<string, unknown> };

export type DispatchSummary = {
  enabled: boolean;
  claimed: number;
  sent: number;
  failed: number;
  error?: string;
};

const BATCH = 10;
const MAX_BATCHES = 5;
const BUDGET_MS = 20_000;
const POST_TIMEOUT_MS = 10_000;

/**
 * POSTs one inbox-agent-event-v1 body to the n8n webhook. Only the outcome is
 * kept (status code or error name): payloads are never logged or stored here.
 */
async function postEvent(cfg: AgentConfig, payload: Record<string, unknown>): Promise<string | null> {
  try {
    const res = await fetch(cfg.webhookUrl, {
      method: "POST",
      headers: { "content-type": "application/json", [cfg.webhookHeaderName]: cfg.webhookHeaderValue },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(POST_TIMEOUT_MS),
      cache: "no-store",
      redirect: "error",
    });
    // Drain the body so the connection can be reused.
    await res.arrayBuffer().catch(() => undefined);
    return res.ok ? null : `HTTP ${res.status}`;
  } catch (error) {
    return error instanceof Error ? error.name : "request failed";
  }
}

async function runOnce(): Promise<DispatchSummary> {
  const cfg = getAgentConfig();
  const summary: DispatchSummary = { enabled: cfg.enabled, claimed: 0, sent: 0, failed: 0 };
  if (!cfg.enabled) return summary;
  const supabase = getServiceClient(cfg);
  const started = Date.now();

  for (let i = 0; i < MAX_BATCHES && Date.now() - started < BUDGET_MS; i++) {
    const { data, error } = await supabase.rpc("agent_bridge_claim", { p_limit: BATCH });
    if (error) {
      summary.error = "claim_failed";
      break;
    }
    const rows = (data as ClaimedEvent[] | null) ?? [];
    if (rows.length === 0) break;
    summary.claimed += rows.length;
    // A claim holds at most one customer event per chat, so these can go out
    // together without breaking per-chat order.
    await Promise.all(
      rows.map(async (row) => {
        const failure = await postEvent(cfg, row.payload);
        const report = await supabase.rpc("agent_bridge_report", {
          p_event_id: row.event_id,
          p_attempt: row.attempt,
          p_ok: failure === null,
          p_error: failure,
        });
        // If the report itself fails, the lease expires and the event is retried.
        if (failure === null && !report.error) summary.sent++;
        else summary.failed++;
      }),
    );
    if (rows.length < BATCH) break;
  }
  return summary;
}

let running: Promise<DispatchSummary> | null = null;
let again = false;

/**
 * Sends every event that is due. Calls that arrive while a pass is running in
 * this process are folded into one more pass afterwards. Safe to run from
 * several processes at once: the database hands each event to one claimer.
 */
export function dispatchDueEvents(): Promise<DispatchSummary> {
  if (running) {
    again = true;
    return running;
  }
  running = (async () => {
    let result: DispatchSummary;
    do {
      again = false;
      result = await runOnce().catch(() => ({ enabled: true, claimed: 0, sent: 0, failed: 0, error: "dispatch_failed" }));
    } while (again);
    return result;
  })().finally(() => {
    running = null;
  });
  return running;
}
