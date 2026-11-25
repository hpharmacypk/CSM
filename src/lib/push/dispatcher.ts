import "server-only";

import { getPushConfig, getPushServiceClient } from "./config";
import { sendPush } from "./sender";

type ClaimedJob = { job_id: number; attempt: number; endpoint: string; p256dh: string; auth_secret: string };

export type PushSummary = {
  enabled: boolean;
  claimed: number;
  sent: number;
  failed: number;
  removed: number;
  error?: string;
};

const BATCH = 25;
const MAX_BATCHES = 5;
const BUDGET_MS = 20_000;

async function runOnce(): Promise<PushSummary> {
  const cfg = getPushConfig();
  const summary: PushSummary = { enabled: cfg.enabled, claimed: 0, sent: 0, failed: 0, removed: 0 };
  if (!cfg.enabled) return summary;
  const supabase = getPushServiceClient(cfg);
  const started = Date.now();

  for (let i = 0; i < MAX_BATCHES && Date.now() - started < BUDGET_MS; i++) {
    const { data, error } = await supabase.rpc("push_claim", { p_limit: BATCH });
    if (error) {
      summary.error = "claim_failed";
      break;
    }
    const rows = (data as ClaimedJob[] | null) ?? [];
    if (rows.length === 0) break;
    summary.claimed += rows.length;
    await Promise.all(
      rows.map(async (row) => {
        const outcome = await sendPush(cfg, row);
        const report = await supabase.rpc("push_report", {
          p_job_id: row.job_id,
          p_attempt: row.attempt,
          p_result: outcome.result,
          p_error: outcome.error ?? null,
        });
        // If the report fails, the lease expires and the job is retried.
        if (report.error) summary.failed++;
        else if (outcome.result === "sent") summary.sent++;
        else if (outcome.result === "gone") summary.removed++;
        else summary.failed++;
      }),
    );
    if (rows.length < BATCH) break;
  }
  return summary;
}

let running: Promise<PushSummary> | null = null;
let again = false;

/**
 * Sends every due push job. Calls that arrive while a pass is running in this
 * process are folded into one more pass. Safe across processes: the database
 * hands each job to one claimer. Never throws.
 */
export function dispatchPushJobs(): Promise<PushSummary> {
  if (running) {
    again = true;
    return running;
  }
  running = (async () => {
    let result: PushSummary;
    do {
      again = false;
      result = await runOnce().catch(() => ({
        enabled: true,
        claimed: 0,
        sent: 0,
        failed: 0,
        removed: 0,
        error: "dispatch_failed",
      }));
    } while (again);
    return result;
  })().finally(() => {
    running = null;
  });
  return running;
}
