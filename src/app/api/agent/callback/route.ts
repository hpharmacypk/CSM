import { after } from "next/server";
import { parseCallback } from "@/lib/agent/callback-contract";
import { bearerMatches, getAgentConfig, getServiceClient } from "@/lib/agent/config";
import { dispatchDueEvents } from "@/lib/agent/dispatcher";

const MAX_BODY_BYTES = 64 * 1024;

const json = (body: Record<string, unknown>, status: number) =>
  Response.json(body, { status, headers: { "cache-control": "no-store" } });

/**
 * n8n -> Inbox callback (inbox-agent-reply-v1).
 * Auth: `Authorization: Bearer <AGENT_CALLBACK_SECRET>` (n8n Header Auth credential).
 * 2xx = processed (including "not shown" outcomes such as held or duplicate),
 * 4xx = rejected (bad auth, payload or ids), 5xx = try again.
 */
export async function POST(request: Request) {
  const cfg = getAgentConfig();
  if (!cfg.enabled) return json({ error: "disabled" }, 503);
  if (!bearerMatches(request.headers.get("authorization"), cfg.callbackSecret)) {
    return json({ error: "unauthorized" }, 401);
  }

  const raw = await request.text();
  if (raw.length > MAX_BODY_BYTES) return json({ error: "payload_too_large" }, 413);
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return json({ error: "invalid_json" }, 400);
  }
  const parsed = parseCallback(body);
  if (!parsed.ok) return json({ error: "invalid_payload", field: parsed.field }, 422);

  const { data, error } = await getServiceClient(cfg).rpc("agent_bridge_apply_callback", {
    p_callback: parsed.value,
  });
  if (error || !data) return json({ error: "storage_failed" }, 500);

  const result = data as { result: string; outcome?: string; handoff?: string };
  switch (result.result) {
    case "ok":
      // The chat's next turn may be waiting for this callback.
      after(() => dispatchDueEvents());
      return json({ ok: true, outcome: result.outcome ?? null, handoff: result.handoff ?? null }, 200);
    case "unknown_event":
      return json({ error: "unknown_event" }, 404);
    case "mismatch":
      return json({ error: "event_mismatch" }, 409);
    case "disabled":
      return json({ error: "disabled" }, 503);
    default:
      return json({ error: "invalid_payload" }, 422);
  }
}
