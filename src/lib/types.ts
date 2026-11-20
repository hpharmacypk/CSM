export type SenderRole = "customer" | "admin";

export type Message = {
  id: string;
  seq: number;
  conversation_id: string;
  sender_role: SenderRole;
  sender_user_id: string | null;
  type: "text" | "image" | "audio";
  body: string | null;
  attachment_path: string | null;
  attachment_mime: string | null;
  attachment_size: number | null;
  attachment_duration_ms: number | null;
  attachment_width: number | null;
  attachment_height: number | null;
  deleted_at: string | null;
  deleted_by: string | null;
  client_message_id: string;
  created_at: string;
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
