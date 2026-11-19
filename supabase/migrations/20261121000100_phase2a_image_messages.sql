-- =============================================================================
-- H-Pharmacy Customer Inbox — Phase 2A: image messages
--
-- Forward migration on top of 20261120000100_phase2b_voice_notes.sql.
-- Reuses the private `chat-media` bucket, its conversation-scoped policies and
-- the shared attachment send function. Existing audio formats, access rules
-- and saved attachments are unchanged.
--
-- Object path (enforced):  <conversation_id>/<client_message_id>.<ext>
--   audio: webm | ogg | m4a      image: jpg | png | webp
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Bucket: also accept JPEG, PNG and WebP. Size limit stays 3 MB for every
-- object (images are compressed in the browser well below this).
-- -----------------------------------------------------------------------------
update storage.buckets
set allowed_mime_types = array[
      'audio/webm', 'audio/ogg', 'audio/mp4',
      'image/jpeg', 'image/png', 'image/webp'
    ],
    file_size_limit = 3145728,
    public = false
where id = 'chat-media';

-- -----------------------------------------------------------------------------
-- Image dimensions (lets the chat reserve space before the image loads).
-- -----------------------------------------------------------------------------
alter table public.messages
  add column attachment_width  integer check (attachment_width  is null or attachment_width  between 1 and 10000),
  add column attachment_height integer check (attachment_height is null or attachment_height between 1 and 10000);

-- -----------------------------------------------------------------------------
-- Path rule: allow image extensions too. Same function, so the existing
-- storage policies (chat_media_select / chat_media_insert) pick it up.
-- -----------------------------------------------------------------------------
create or replace function private.media_conversation_id(p_name text)
returns uuid
language sql
immutable
set search_path = ''
as $$
  select case
    when p_name ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(webm|ogg|m4a|jpg|png|webp)$'
    then split_part(p_name, '/', 1)::uuid
    else null
  end;
$$;

-- Privileges are kept by CREATE OR REPLACE; restated for clarity.
revoke all on function private.media_conversation_id(text) from public, anon;
grant execute on function private.media_conversation_id(text) to authenticated;

-- -----------------------------------------------------------------------------
-- Shared attachment send: now 'audio' or 'image'.
-- The signature gains optional width/height, so the old 5-argument version is
-- replaced (keeping both would make named-argument RPC calls ambiguous).
-- Existing callers that pass 5 named arguments keep working via defaults.
-- -----------------------------------------------------------------------------
drop function public.send_attachment_message(uuid, text, text, uuid, integer);

create function public.send_attachment_message(
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
    customer_unread_count = case when v_role = 'admin' then c.customer_unread_count + 1 else c.customer_unread_count end,
    admin_last_read_seq    = case when v_role = 'admin' then v_msg.seq else c.admin_last_read_seq end,
    customer_last_read_seq = case when v_role = 'customer' then v_msg.seq else c.customer_last_read_seq end
  where c.id = p_conversation_id;

  return v_msg;
end;
$$;

revoke all on function public.send_attachment_message(uuid, text, text, uuid, integer, integer, integer)
  from public, anon, authenticated;
grant execute on function public.send_attachment_message(uuid, text, text, uuid, integer, integer, integer)
  to authenticated;

-- Ask PostgREST to pick up the new function signature immediately.
notify pgrst, 'reload schema';
