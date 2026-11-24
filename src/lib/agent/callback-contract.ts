/**
 * Validation of the n8n -> Inbox callback (inbox-agent-reply-v1), matching the
 * "Render Inbox Reply", "Apply Send-Time Hold" and "Render Handoff Update"
 * nodes of the Customer Inbox workflow. Returns a rebuilt object with known
 * fields only; anything malformed is rejected with the field that failed.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ACTION_ID = /^hp1:[a-z]+(?::[\s\S]*)?$/;
const STATE = /^[a-z_]{1,40}$/;
const EVENT_TYPES = ["customer.message", "customer.action", "customer.delivery_form", "admin.message"] as const;
const FORM_KEYS = ["full_name", "shipping_address", "email_address", "phone_number", "city"] as const;

export const MAX_REPLY_CHARS = 8000;

export type Choice = { id: string; title: string };
export type FormField = { key: string; label: string; required: boolean; present: boolean | null; error: string | null };
export type AgentActions =
  | { kind: "none"; label: null; choices: []; delivery_form: null }
  | { kind: "buttons" | "list"; label: string | null; choices: Choice[]; delivery_form: null }
  | {
      kind: "delivery_form";
      label: string | null;
      choices: [];
      delivery_form: { form_id: "hp1:delivery"; submit_event_type: "customer.delivery_form"; fields: FormField[] };
    };

export type Callback = {
  contract_version: "inbox-agent-reply-v1";
  callback_type: "agent.reply" | "handoff.update";
  event_id: string;
  event_type: (typeof EVENT_TYPES)[number];
  conversation_id: string;
  customer_id: string;
  in_reply_to_message_id: string;
  delivery: { status: "deliver" | "suppressed" | "no_reply"; reason: string | null };
  reply: { text: string | null; language: string | null; response_type: string | null };
  actions: AgentActions;
  handoff: {
    state: string;
    bot_reply_permitted: boolean;
    source: string | null;
    turn_state: string | null;
  };
  agent: { idempotent_replay: boolean } | null;
};

class Invalid extends Error {}
const fail = (field: string): never => {
  throw new Invalid(field);
};

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const obj = (v: unknown, field: string) => (isObj(v) ? v : fail(field));
const uuid = (v: unknown, field: string) => {
  const s = typeof v === "string" ? v.trim().toLowerCase() : "";
  return UUID.test(s) ? s : fail(field);
};
const optText = (v: unknown, max: number, field: string): string | null => {
  if (v === null || v === undefined) return null;
  if (typeof v !== "string" || v.length > max) fail(field);
  return v as string;
};
const oneOf = <T extends string>(v: unknown, values: readonly T[], field: string): T =>
  typeof v === "string" && (values as readonly string[]).includes(v) ? (v as T) : fail(field);

const NONE: AgentActions = { kind: "none", label: null, choices: [], delivery_form: null };

function parseActions(raw: unknown): AgentActions {
  const a = obj(raw, "actions");
  const kind = oneOf(a.kind, ["none", "buttons", "list", "delivery_form"] as const, "actions.kind");
  const label = optText(a.label, 60, "actions.label");
  if (kind === "none") return NONE;

  if (kind === "delivery_form") {
    const f = obj(a.delivery_form, "actions.delivery_form");
    if (f.form_id !== "hp1:delivery") fail("actions.delivery_form.form_id");
    if (f.submit_event_type !== "customer.delivery_form") fail("actions.delivery_form.submit_event_type");
    if (!Array.isArray(f.fields)) fail("actions.delivery_form.fields");
    const byKey = new Map<string, FormField>();
    for (const rawField of f.fields as unknown[]) {
      const x = obj(rawField, "actions.delivery_form.fields");
      const key = oneOf(x.key, FORM_KEYS, "actions.delivery_form.fields.key");
      if (byKey.has(key)) fail("actions.delivery_form.fields.key");
      if (typeof x.required !== "boolean") fail("actions.delivery_form.fields.required");
      if (!(x.present === null || x.present === undefined || typeof x.present === "boolean")) fail("actions.delivery_form.fields.present");
      byKey.set(key, {
        key,
        label: optText(x.label, 60, "actions.delivery_form.fields.label") ?? key,
        required: x.required as boolean,
        present: typeof x.present === "boolean" ? x.present : null,
        error: optText(x.error, 300, "actions.delivery_form.fields.error"),
      });
    }
    if (byKey.size !== FORM_KEYS.length) fail("actions.delivery_form.fields");
    // The Inbox form submits exactly these keys; only email may be optional.
    if (FORM_KEYS.some((k) => k !== "email_address" && !byKey.get(k)!.required)) fail("actions.delivery_form.fields.required");
    return {
      kind,
      label,
      choices: [],
      delivery_form: { form_id: "hp1:delivery", submit_event_type: "customer.delivery_form", fields: FORM_KEYS.map((k) => byKey.get(k)!) },
    };
  }

  if (!Array.isArray(a.choices) || a.choices.length < 1 || a.choices.length > 10) fail("actions.choices");
  if (kind === "buttons" && (a.choices as unknown[]).length > 3) fail("actions.choices");
  const seen = new Set<string>();
  const choices = (a.choices as unknown[]).map((rawChoice) => {
    const c = obj(rawChoice, "actions.choices");
    if (typeof c.id !== "string" || c.id.length > 200 || !ACTION_ID.test(c.id) || seen.has(c.id)) fail("actions.choices.id");
    seen.add(c.id as string);
    if (typeof c.title !== "string" || !c.title.trim() || c.title.length > 200) fail("actions.choices.title");
    return { id: c.id as string, title: (c.title as string).trim() };
  });
  return { kind, label, choices, delivery_form: null };
}

export function parseCallback(raw: unknown): { ok: true; value: Callback } | { ok: false; field: string } {
  try {
    const b = obj(raw, "body");
    if (b.contract_version !== "inbox-agent-reply-v1") fail("contract_version");
    const callbackType = oneOf(b.callback_type, ["agent.reply", "handoff.update"] as const, "callback_type");
    const eventType = oneOf(b.event_type, EVENT_TYPES, "event_type");
    if ((callbackType === "handoff.update") !== (eventType === "admin.message")) fail("callback_type");

    const d = obj(b.delivery, "delivery");
    const status = oneOf(d.status, ["deliver", "suppressed", "no_reply"] as const, "delivery.status");
    const r = obj(b.reply, "reply");
    let text = optText(r.text, MAX_REPLY_CHARS, "reply.text");
    if (status === "deliver") {
      if (callbackType !== "agent.reply" || !text || !text.trim()) fail("reply.text");
    } else {
      text = null; // never shown when not delivered
    }

    const h = obj(b.handoff, "handoff");
    if (typeof h.state !== "string" || !STATE.test(h.state)) fail("handoff.state");
    if (typeof h.bot_reply_permitted !== "boolean") fail("handoff.bot_reply_permitted");
    const turnState = h.turn_state === null || h.turn_state === undefined ? null : h.turn_state;
    if (turnState !== null && (typeof turnState !== "string" || !STATE.test(turnState))) fail("handoff.turn_state");

    const agent = b.agent === null || b.agent === undefined ? null : obj(b.agent, "agent");

    return {
      ok: true,
      value: {
        contract_version: "inbox-agent-reply-v1",
        callback_type: callbackType,
        event_id: uuid(b.event_id, "event_id"),
        event_type: eventType,
        conversation_id: uuid(b.conversation_id, "conversation_id"),
        customer_id: uuid(b.customer_id, "customer_id"),
        in_reply_to_message_id: uuid(b.in_reply_to_message_id, "in_reply_to_message_id"),
        delivery: { status, reason: optText(d.reason, 100, "delivery.reason") },
        reply: {
          text,
          language: optText(r.language, 20, "reply.language"),
          response_type: optText(r.response_type, 60, "reply.response_type"),
        },
        // Actions belong to a delivered reply only.
        actions: status === "deliver" ? parseActions(b.actions) : NONE,
        handoff: {
          state: h.state as string,
          bot_reply_permitted: h.bot_reply_permitted as boolean,
          source: optText(h.source, 60, "handoff.source"),
          turn_state: turnState as string | null,
        },
        agent: agent ? { idempotent_replay: agent.idempotent_replay === true } : null,
      },
    };
  } catch (error) {
    if (error instanceof Invalid) return { ok: false, field: error.message };
    return { ok: false, field: "body" };
  }
}
