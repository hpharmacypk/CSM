/**
 * Browser hint after a message is saved: asks our server to look for due
 * order-agent events now instead of at the next scheduled run. It carries no
 * data; the events are already stored with the message. Fire-and-forget.
 */
export function nudgeAgentBridge() {
  if (typeof window === "undefined") return;
  void fetch("/api/agent/nudge", { method: "POST", keepalive: true, cache: "no-store" }).catch(() => undefined);
}
