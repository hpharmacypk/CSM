export type SenderRole = "customer" | "admin";

export type Message = {
  id: string;
  seq: number;
  conversation_id: string;
  sender_role: SenderRole;
  sender_user_id: string | null;
  type: "text" | "image" | "audio" | "location";
  body: string | null;
  attachment_path: string | null;
  attachment_mime: string | null;
  attachment_size: number | null;
  attachment_duration_ms: number | null;
  attachment_width: number | null;
  attachment_height: number | null;
  deleted_at: string | null;
  deleted_by: string | null;
  location_lat: number | null;
  location_lng: number | null;
  location_accuracy_m: number | null;
  client_message_id: string;
  created_at: string;
  /** Admin forwarded this from another chat (no source details are stored here). */
  forwarded?: boolean;
  /** "assistant": saved from an order-agent callback (sender_role is "admin"). */
  author?: "human" | "assistant";
  /** Assistant replies only: buttons / list / delivery form offered with the reply. */
  agent_actions?: AgentActions | null;
  /** Customer option clicks and delivery forms: the assistant message they answer. */
  agent_offer_message_id?: string | null;
  agent_action_id?: string | null;
};

export type AgentChoice = { id: string; title: string };

export type AgentFormField = {
  key: "full_name" | "shipping_address" | "email_address" | "phone_number" | "city";
  label: string;
  required: boolean;
  /** The Agent already has this detail (delivery-form-v1); null when unknown. */
  present: boolean | null;
  /** The Agent's message about this detail, if it was not accepted. */
  error: string | null;
};

export type AgentActions = {
  kind: "buttons" | "list" | "delivery_form";
  label: string | null;
  choices: AgentChoice[];
  delivery_form: { form_id: string; submit_event_type: string; fields: AgentFormField[] } | null;
};

export type DeliveryFormValues = {
  full_name: string;
  shipping_address: string;
  email_address: string;
  phone_number: string;
  city: string;
};

export type Conversation = {
  id: string;
  customer_id: string;
  created_at: string;
  last_message_at: string | null;
  last_message_preview: string | null;
  last_message_sender: SenderRole | null;
  last_message_seq: number;
  admin_last_read_seq: number;
  customer_last_read_seq: number;
  admin_unread_count: number;
  customer_unread_count: number;
};

export type ConversationWithCustomer = Conversation & {
  customers: { public_ref: string } | null;
};
