-- =============================================================================
-- H-Pharmacy Customer Inbox — Unread fix: explicit read boundary
--
-- Before: mark_conversation_read() always marked *every* message up to the
-- newest one in the conversation as read, even ones the reader never saw
-- (e.g. a message committed while the call was in flight). The browser also
-- never actually sent the call (an un-awaited lazy RPC); that is fixed in the
-- client.
--
-- Now: the browser passes the seq of the newest message the reader actually
-- viewed. The boundary only moves forward, never past the newest message, and
-- the unread count is recomputed from the messages after that boundary while
-- holding the same per-conversation lock that sends use. A message that
-- arrives during a mark-read call therefore stays unread.
-- =============================================================================

-- Unread messages for one side of a conversation after a given boundary.
-- p_side is the *reader*: 'admin' counts customer messages, 'customer' counts
-- admin messages. (Replaced in the deletion migration to skip deleted/hidden.)
create or replace function private.unread_for(
  p_conversation_id uuid,
  p_side            text,
  p_after_seq       bigint
)
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  select count(*)::integer
  from public.messages m
  where m.conversation_id = p_conversation_id
    and m.sender_role = case when p_side = 'admin' then 'customer' else 'admin' end
    and m.seq > p_after_seq;
$$;

revoke all on function private.unread_for(uuid, text, bigint) from public, anon, authenticated;

-- Replace the old 1-argument version (keeping both would make named-argument
-- RPC calls ambiguous). Calls with only p_conversation_id still work: a NULL
-- boundary means "up to the newest message" (previous behaviour).
drop function public.mark_conversation_read(uuid);

create function public.mark_conversation_read(
  p_conversation_id uuid,
  p_up_to_seq       bigint default null
)
returns integer   -- the caller's remaining unread count
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid      uuid := (select auth.uid());
  v_side     text;
  v_last     bigint;
  v_current  bigint;
  v_boundary bigint;
  v_count    integer;
begin
  if v_uid is null then
    raise exception 'Not signed in' using errcode = '42501';
  end if;

  if private.is_admin() then
    v_side := 'admin';
  elsif private.owns_conversation(p_conversation_id) then
    v_side := 'customer';
  else
    raise exception 'Conversation not found' using errcode = '42501';
  end if;

  -- Same lock as send_message / send_attachment_message: no message can be
  -- inserted between reading the boundary and counting what is after it.
  select last_message_seq,
         case when v_side = 'admin' then admin_last_read_seq else customer_last_read_seq end
    into v_last, v_current
  from public.conversations
  where id = p_conversation_id
  for update;
  if not found then
    raise exception 'Conversation not found' using errcode = '42501';
  end if;

  -- Never move backwards, never past the newest message.
  v_boundary := greatest(v_current, least(coalesce(p_up_to_seq, v_last), v_last));
  v_count := private.unread_for(p_conversation_id, v_side, v_boundary);

  if v_side = 'admin' then
    update public.conversations
       set admin_last_read_seq = v_boundary,
           admin_unread_count  = v_count
     where id = p_conversation_id
       and (admin_last_read_seq <> v_boundary or admin_unread_count <> v_count);
  else
    update public.conversations
       set customer_last_read_seq = v_boundary,
           customer_unread_count  = v_count
     where id = p_conversation_id
       and (customer_last_read_seq <> v_boundary or customer_unread_count <> v_count);
  end if;

  return v_count;
end;
$$;

revoke all on function public.mark_conversation_read(uuid, bigint) from public, anon, authenticated;
grant execute on function public.mark_conversation_read(uuid, bigint) to authenticated;

-- -----------------------------------------------------------------------------
-- Sends no longer move the sender's read boundary. Previously a reply marked
-- every earlier message from the other side as read — including one that
-- arrived while the reply was being typed and was never seen. Unread counts
-- only ever count the *other* side's messages, so the sender's own messages
-- never needed it. Same signatures and behaviour otherwise (bodies copied from
-- 20261119000100 / 20261121000100 minus those two assignments).
-- -----------------------------------------------------------------------------
create or replace function public.send_message(
  p_conversation_id   uuid,
  p_body              text,
  p_client_message_id uuid
)
returns public.messages
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid  uuid := (select auth.uid());
  v_role text;
  v_body text := btrim(coalesce(p_body, ''));
  v_msg  public.messages;
begin
  if v_uid is null then
    raise exception 'Not signed in' using errcode = '42501';
  end if;
  if p_conversation_id is null or p_client_message_id is null then
    raise exception 'Missing conversation or message id' using errcode = '22023';
  end if;

  if private.is_admin() then
    v_role := 'admin';
  elsif private.owns_conversation(p_conversation_id) then
    v_role := 'customer';
  else
    -- Same error whether the conversation exists or not.
    raise exception 'Conversation not found' using errcode = '42501';
  end if;

  if char_length(v_body) < 1 or char_length(v_body) > 4000 then
    raise exception 'Message must be 1–4000 characters' using errcode = '22023';
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

  insert into public.messages
    (conversation_id, sender_role, sender_user_id, type, body, client_message_id)
  values
    (p_conversation_id, v_role, v_uid, 'text', v_body, p_client_message_id)
  returning * into v_msg;

  update public.conversations c set
    last_message_at       = v_msg.created_at,
    last_message_preview  = left(v_body, 140),
    last_message_sender   = v_role,
    last_message_seq      = v_msg.seq,
    admin_unread_count    = case when v_role = 'customer' then c.admin_unread_count + 1 else c.admin_unread_count end,
    customer_unread_count = case when v_role = 'admin' then c.customer_unread_count + 1 else c.customer_unread_count end
  where c.id = p_conversation_id;

  return v_msg;
end;
$$;

create or replace function public.send_attachment_message(
  p_conversation_id   uuid,
  p_type              text,
  p_attachment_path   text,
  p_client_message_id uuid,
  p_duration_ms       integer default null,
  p_width             integer default null,
  p_height            integer default null
)
returns public.messages
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid           uuid := (select auth.uid());
  v_role          text;
  v_ext           text;
  v_expected_mime text;
  v_object        record;
  v_mime          text;
  v_size          bigint;
  v_preview       text;
  v_msg           public.messages;
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

  if p_type is null or p_type not in ('audio', 'image') then
    raise exception 'Unsupported attachment type' using errcode = '22023';
  end if;

  -- The path must be exactly <conversation>/<client message id>.<ext>, and the
  -- extension must belong to the message type.
  v_ext := substring(p_attachment_path from '\.([a-z0-9]+)$');
  v_expected_mime := case
    when p_type = 'audio' and v_ext = 'webm' then 'audio/webm'
    when p_type = 'audio' and v_ext = 'ogg'  then 'audio/ogg'
    when p_type = 'audio' and v_ext = 'm4a'  then 'audio/mp4'
    when p_type = 'image' and v_ext = 'jpg'  then 'image/jpeg'
    when p_type = 'image' and v_ext = 'png'  then 'image/png'
    when p_type = 'image' and v_ext = 'webp' then 'image/webp'
  end;
  if v_expected_mime is null
     or p_attachment_path <> p_conversation_id::text || '/' || p_client_message_id::text || '.' || v_ext then
    raise exception 'Invalid attachment path' using errcode = '22023';
  end if;

  if p_type = 'audio' then
    if p_duration_ms is not null and (p_duration_ms < 0 or p_duration_ms > 125000) then
      raise exception 'Voice notes are limited to two minutes' using errcode = '22023';
    end if;
    if p_width is not null or p_height is not null then
      raise exception 'Dimensions are only for images' using errcode = '22023';
    end if;
  else
    if p_duration_ms is not null then
      raise exception 'Duration is only for voice notes' using errcode = '22023';
    end if;
    if (p_width is null) <> (p_height is null)
       or p_width not between 1 and 10000
       or p_height not between 1 and 10000 then
      raise exception 'Invalid image dimensions' using errcode = '22023';
    end if;
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
  if v_mime is distinct from v_expected_mime then
    raise exception 'Attachment type does not match its file' using errcode = '22023';
  end if;
  if v_size is null or v_size <= 0 or v_size > 3145728 then
    raise exception 'Attachment is too large' using errcode = '22023';
  end if;

  insert into public.messages
    (conversation_id, sender_role, sender_user_id, type, body, attachment_path,
     attachment_mime, attachment_size, attachment_duration_ms,
     attachment_width, attachment_height, client_message_id)
  values
    (p_conversation_id, v_role, v_uid, p_type, null, p_attachment_path,
     v_mime, v_size, case when p_type = 'audio' then p_duration_ms end,
     case when p_type = 'image' then p_width end,
     case when p_type = 'image' then p_height end,
     p_client_message_id)
  returning * into v_msg;

  v_preview := case
    when p_type = 'image' then 'Photo'
    else 'Voice note' || case
      when p_duration_ms is not null
        then ' (' || (p_duration_ms / 60000)::text || ':' || lpad(((p_duration_ms / 1000) % 60)::text, 2, '0') || ')'
      else ''
    end
  end;

  update public.conversations c set
    last_message_at       = v_msg.created_at,
    last_message_preview  = v_preview,
    last_message_sender   = v_role,
    last_message_seq      = v_msg.seq,
    admin_unread_count    = case when v_role = 'customer' then c.admin_unread_count + 1 else c.admin_unread_count end,
    customer_unread_count = case when v_role = 'admin' then c.customer_unread_count + 1 else c.customer_unread_count end
  where c.id = p_conversation_id;

  return v_msg;
end;
$$;

notify pgrst, 'reload schema';
