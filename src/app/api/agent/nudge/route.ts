import { after } from "next/server";
import { getAgentConfig } from "@/lib/agent/config";
import { dispatchDueEvents } from "@/lib/agent/dispatcher";

/**
 * Low-latency hint sent by the chat page after it saves a message. It carries
 * no data and cannot choose what is sent: the server just looks for due events
 * in the database (the same work as the scheduled endpoint). Repeated calls
 * are folded into one pass. Delivery never depends on this request: events are
 * already stored, and the scheduled endpoint sends them if this one is lost.
 */
export async function POST() {
  if (getAgentConfig().enabled) after(() => dispatchDueEvents());
  return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
}
