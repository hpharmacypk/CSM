-- =============================================================================
-- H-Pharmacy Customer Inbox — Phase 2B: voice notes (+ shared attachment base)
--
-- Adds a private Storage bucket and a generic, idempotent attachment-message
-- function. Phase 2B enables only 'audio'; image support can later extend the
-- allowed types in a new migration without changing this workflow.
--
-- Object path (enforced):  <conversation_id>/<client_message_id>.<ext>
--   * The folder binds the object to one conversation, so Storage access uses
--     exactly the same rule as messages (owner guest or admin).
--   * The file name is the message's client id, so a retried send re-uses the
--     same object and the same message row — never a duplicate.
--
-- Storage boundary: the bucket rejects anything that is not an allowed audio
-- type or is larger than 3 MB. The send function re-checks the stored object's
-- type, size, owner and path before a message can reference it.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Bucket
-- -----------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'chat-media',
  'chat-media',
  false,
  3145728,                                         -- 3 MB (2 min of voice is ~0.5–2 MB)
  array['audio/webm', 'audio/ogg', 'audio/mp4']
)
on conflict (id) do update set
  public             = excluded.public,
  file_size_limit    = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

-- -----------------------------------------------------------------------------
-- Message columns for attachments
-- -----------------------------------------------------------------------------
alter table public.messages
  add column attachment_mime        text,
  add column attachment_size        bigint check (attachment_size is null or attachment_size > 0),
  add column attachment_duration_ms integer
    check (attachment_duration_ms is null or attachment_duration_ms between 0 and 125000);

alter table public.messages
  add constraint messages_attachment_required
  check (type = 'text' or attachment_path is not null);

-- -----------------------------------------------------------------------------
-- Helpers
-- -----------------------------------------------------------------------------

-- Conversation id from an object path, or NULL if the path is not well formed.
create or replace function private.media_conversation_id(p_name text)
returns uuid
language sql
immutable
set search_path = ''
as $$
  select case
    when p_name ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(webm|ogg|m4a)$'
    then split_part(p_name, '/', 1)::uuid
    else null
  end;
$$;

-- Owner guest or admin may access media of this path's conversation.
create or replace function private.can_access_media(p_name text)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_conversation uuid := private.media_conversation_id(p_name);
begin
  if v_conversation is null or (select auth.uid()) is null then
    return false;
  end if;
  return private.is_admin() or private.owns_conversation(v_conversation);
end;
$$;

revoke all on function private.media_conversation_id(text) from public, anon, authenticated;
revoke all on function private.can_access_media(text)      from public, anon, authenticated;
grant execute on function private.media_conversation_id(text) to authenticated;
grant execute on function private.can_access_media(text)      to authenticated;

-- -----------------------------------------------------------------------------
-- Storage policies (only for this bucket). No UPDATE/DELETE policies:
-- objects cannot be overwritten or removed from the browser.
-- -----------------------------------------------------------------------------
create policy chat_media_select
  on storage.objects for select to authenticated
  using (bucket_id = 'chat-media' and private.can_access_media(name));

create policy chat_media_insert
  on storage.objects for insert to authenticated
  with check (bucket_id = 'chat-media' and private.can_access_media(name));

-- -----------------------------------------------------------------------------
-- RPC: send a message that references an uploaded attachment
-- -----------------------------------------------------------------------------
create or replace function public.send_attachment_message(
  p_conversation_id   uuid,
  p_type              text,
  p_attachment_path   text,
  p_client_message_id uuid,
  p_duration_ms       integer default null
)
returns public.messages
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid      uuid := (select auth.uid());
  v_role     text;
  v_ext      text;
  v_object   record;
  v_mime     text;
  v_size     bigint;
  v_preview  text;
  v_msg      public.messages;
begin
  if v_uid is null then
    raise exception 'Not signed in' using errcode = '42501';
  end if;
  if p_conversation_id is null or p_client_message_id is null or p_attachment_path is null then
    raise exception 'Missing conversation, message id or attachment' using errcode = '22023';
  end if;

  if private.is_admin() then
    v_role := 'admin';
  elsif private.owns_conversation(p_conversation_id) then
    v_role := 'customer';
  else
    raise exception 'Conversation not found' using errcode = '42501';
  end if;

  -- Phase 2B: audio only. (Images will extend this list in a later migration.)
  if p_type is distinct from 'audio' then
    raise exception 'Unsupported attachment type' using errcode = '22023';
  end if;

  -- The path must be exactly <conversation>/<client message id>.<ext>.
  v_ext := substring(p_attachment_path from '\.([a-z0-9]+)$');
  if v_ext is null
     or v_ext not in ('webm', 'ogg', 'm4a')
     or p_attachment_path <> p_conversation_id::text || '/' || p_client_message_id::text || '.' || v_ext then
    raise exception 'Invalid attachment path' using errcode = '22023';
  end if;

  if p_duration_ms is not null and (p_duration_ms < 0 or p_duration_ms > 125000) then
    raise exception 'Voice notes are limited to two minutes' using errcode = '22023';
  end if;

  -- Serialize sends per conversation so seq order matches commit order.
  perform 1 from public.conversations where id = p_conversation_id for update;
  if not found then
    raise exception 'Conversation not found' using errcode = '42501';
  end if;

  -- Idempotent retry: same client id returns the original row.
  select * into v_msg from public.messages
  where conversation_id = p_conversation_id
    and client_message_id = p_client_message_id;
  if found then
    if v_msg.sender_user_id is distinct from v_uid then
      raise exception 'Duplicate message id' using errcode = '23505';
    end if;
    return v_msg;
  end if;

  -- The object must exist, be uploaded by this caller, and match the rules.
  select o.owner_id, o.metadata into v_object
  from storage.objects o
  where o.bucket_id = 'chat-media' and o.name = p_attachment_path;
  if not found then
    raise exception 'Attachment not uploaded' using errcode = '22023';
  end if;
  if v_object.owner_id is distinct from v_uid::text then
    raise exception 'Attachment not uploaded by sender' using errcode = '42501';
  end if;

  v_mime := lower(split_part(coalesce(v_object.metadata ->> 'mimetype', ''), ';', 1));
  v_size := nullif(v_object.metadata ->> 'size', '')::bigint;
  if v_mime not in ('audio/webm', 'audio/ogg', 'audio/mp4') then
    raise exception 'Unsupported audio format' using errcode = '22023';
  end if;
  if v_size is null or v_size <= 0 or v_size > 3145728 then
    raise exception 'Voice note is too large' using errcode = '22023';
  end if;

  insert into public.messages
    (conversation_id, sender_role, sender_user_id, type, body, attachment_path,
     attachment_mime, attachment_size, attachment_duration_ms, client_message_id)
  values
    (p_conversation_id, v_role, v_uid, 'audio', null, p_attachment_path,
     v_mime, v_size, p_duration_ms, p_client_message_id)
  returning * into v_msg;

  v_preview := 'Voice note' || case
    when p_duration_ms is not null
      then ' (' || (p_duration_ms / 60000)::text || ':' || lpad(((p_duration_ms / 1000) % 60)::text, 2, '0') || ')'
    else ''
  end;

  update public.conversations c set
    last_message_at       = v_msg.created_at,
    last_message_preview  = v_preview,
    last_message_sender   = v_role,
    last_message_seq      = v_msg.seq,
    admin_unread_count    = case when v_role = 'customer' then c.admin_unread_count + 1 else c.admin_unread_count end,
    customer_unread_count = case when v_role = 'admin' then c.customer_unread_count + 1 else c.customer_unread_count end,
    admin_last_read_seq    = case when v_role = 'admin' then v_msg.seq else c.admin_last_read_seq end,
    customer_last_read_seq = case when v_role = 'customer' then v_msg.seq else c.customer_last_read_seq end
  where c.id = p_conversation_id;

  return v_msg;
end;
$$;

revoke all on function public.send_attachment_message(uuid, text, text, uuid, integer)
  from public, anon, authenticated;
grant execute on function public.send_attachment_message(uuid, text, text, uuid, integer)
  to authenticated;
