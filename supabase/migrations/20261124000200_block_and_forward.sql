-- =============================================================================
-- H-Pharmacy Customer Inbox — Block / unblock (admin) and Forward message (admin)
--
-- Block
--   * conversations.blocked_at: set/cleared only by public.set_customer_blocked()
--     (admin-only). Readable by the admin and by that customer (their own row),
--     and synced live through the existing Realtime publication.
--   * While blocked, NO new message can be inserted in that conversation by
--     anyone: a BEFORE INSERT trigger on public.messages enforces it for every
--     send path (text/emoji, images, voice, location and forwards), and the
--     chat-media upload policy refuses new files for a blocked conversation, so
--     an attachment is rejected before upload and again before finalizing.
--   * History, files, labels, pins, archive states and read state are untouched.
--     Reads, "delete for me", "delete for everyone" and pins keep working.
--   * The block belongs to the conversation of that guest identity. Reopening the
--     inbox with the same guest session returns the same (blocked) conversation.
--     A new anonymous identity (another browser/device, cleared storage) is a new
--     customer and cannot be linked to the block.
--
-- Forward
--   * public.admin_forward_message(): admin-only. Creates a NEW admin message in
--     the destination conversation, flagged messages.forwarded = true. Nothing in
--     the destination row identifies the source (no source ids, names or paths).
--     The source link is kept only in private.message_forwards (never exposed).
--   * Source must be visible to the forwarding admin: not deleted for everyone,
--     not hidden by them ("delete for me"), media not revoked.
--   * Images / voice notes: the admin's browser first copies the object inside
--     Storage to <destination conversation>/<new client id>.<ext> (its own object,
--     governed by the destination's access rules); this function then verifies
--     that copy and records the message. Retrying with the same client id is
--     idempotent. public.admin_release_unsent_attachment() queues a copy that
--     never became a message for removal (uses the existing cleanup queue).
--   * Ordering, Realtime, conversation summary and unread counts work exactly
--     like a normal admin send.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Columns
-- -----------------------------------------------------------------------------
alter table public.conversations
  add column blocked_at timestamptz;

alter table public.messages
  add column forwarded boolean not null default false;

-- -----------------------------------------------------------------------------
-- Block helpers and enforcement
-- -----------------------------------------------------------------------------
create or replace function private.conversation_is_blocked(p_conversation_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.conversations c
    where c.id = p_conversation_id and c.blocked_at is not null
  );
$$;

revoke all on function private.conversation_is_blocked(uuid) from public, anon, authenticated;
grant execute on function private.conversation_is_blocked(uuid) to authenticated;

create or replace function private.reject_message_if_blocked()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if private.conversation_is_blocked(new.conversation_id) then
    raise exception 'Messages are blocked in this conversation' using errcode = '42501';
  end if;
  return new;
end;
$$;

revoke all on function private.reject_message_if_blocked() from public, anon, authenticated;

create trigger messages_reject_if_blocked
  before insert on public.messages
  for each row execute function private.reject_message_if_blocked();

-- Uploads: same rule as before, plus "not blocked".
drop policy chat_media_insert on storage.objects;
create policy chat_media_insert
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'chat-media'
    and private.can_access_media(name)
    and not private.conversation_is_blocked(private.media_conversation_id(name))
  );

create or replace function public.set_customer_blocked(
  p_conversation_id uuid,
  p_blocked         boolean
)
returns timestamptz
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_blocked_at timestamptz;
begin
  if not private.is_admin() then
    raise exception 'Admin access required' using errcode = '42501';
  end if;

  update public.conversations
  set blocked_at = case
        when coalesce(p_blocked, false) then coalesce(blocked_at, now())
        else null
      end
  where id = p_conversation_id
  returning blocked_at into v_blocked_at;
  if not found then
    raise exception 'Conversation not found' using errcode = '22023';
  end if;
  return v_blocked_at;
end;
$$;

revoke all on function public.set_customer_blocked(uuid, boolean) from public, anon, authenticated;
grant execute on function public.set_customer_blocked(uuid, boolean) to authenticated;

-- -----------------------------------------------------------------------------
-- Forward (admin only)
-- -----------------------------------------------------------------------------
create table private.message_forwards (
  message_id             uuid primary key references public.messages (id) on delete cascade,
  source_message_id      uuid,  -- no FK: the source may be deleted later
  source_conversation_id uuid,
  forwarded_by           uuid,
  forwarded_at           timestamptz not null default now()
);
revoke all on table private.message_forwards from public, anon, authenticated;
alter table private.message_forwards enable row level security;
-- No policies: audit only, never exposed through the Data API.

create or replace function public.admin_forward_message(
  p_source_message_id      uuid,
  p_target_conversation_id uuid,
  p_client_message_id      uuid,
  p_attachment_path        text default null
)
returns public.messages
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid     uuid := (select auth.uid());
  v_src     public.messages;
  v_ext     text;
  v_object  record;
  v_mime    text;
  v_size    bigint;
  v_msg     public.messages;
begin
  if not private.is_admin() then
    raise exception 'Admin access required' using errcode = '42501';
  end if;
  if p_source_message_id is null or p_target_conversation_id is null or p_client_message_id is null then
    raise exception 'Missing message, destination or message id' using errcode = '22023';
  end if;

  -- Source: visible to this admin, not deleted, not hidden, supported type.
  select * into v_src from public.messages m where m.id = p_source_message_id;
  if not found
     or v_src.deleted_at is not null
     or exists (select 1 from public.message_hidden h where h.message_id = v_src.id and h.user_id = v_uid) then
    raise exception 'Message not available to forward' using errcode = '22023';
  end if;
  if v_src.type not in ('text', 'image', 'audio', 'location') then
    raise exception 'This message type cannot be forwarded' using errcode = '22023';
  end if;
  if v_src.conversation_id = p_target_conversation_id then
    raise exception 'Choose a different conversation' using errcode = '22023';
  end if;

  -- Destination: lock (same ordering rule as every send), must not be blocked.
  perform 1 from public.conversations where id = p_target_conversation_id for update;
  if not found then
    raise exception 'Conversation not found' using errcode = '22023';
  end if;
  if private.conversation_is_blocked(p_target_conversation_id) then
    raise exception 'Messages are blocked in this conversation' using errcode = '42501';
  end if;

  -- Idempotent retry: same client id returns the original row.
  select * into v_msg from public.messages
  where conversation_id = p_target_conversation_id
    and client_message_id = p_client_message_id;
  if found then
    if v_msg.sender_user_id is distinct from v_uid then
      raise exception 'Duplicate message id' using errcode = '23505';
    end if;
    return v_msg;
  end if;

  if v_src.type in ('image', 'audio') then
    if v_src.attachment_path is null
       or exists (select 1 from private.revoked_media r where r.object_name = v_src.attachment_path) then
      raise exception 'Message not available to forward' using errcode = '22023';
    end if;
    -- The copy must be the destination's own object: <dest>/<client id>.<same ext>.
    v_ext := substring(v_src.attachment_path from '\.([a-z0-9]+)$');
    if p_attachment_path is null
       or p_attachment_path <> p_target_conversation_id::text || '/' || p_client_message_id::text || '.' || v_ext then
      raise exception 'Invalid attachment path' using errcode = '22023';
    end if;
    select o.metadata into v_object
    from storage.objects o
    where o.bucket_id = 'chat-media' and o.name = p_attachment_path;
    if not found then
      raise exception 'Attachment not uploaded' using errcode = '22023';
    end if;
    v_mime := lower(split_part(coalesce(v_object.metadata ->> 'mimetype', ''), ';', 1));
    if v_mime <> lower(split_part(coalesce(v_src.attachment_mime, ''), ';', 1)) then
      raise exception 'Attachment does not match the original' using errcode = '22023';
    end if;
    v_size := nullif(v_object.metadata ->> 'size', '')::bigint;
  elsif p_attachment_path is not null then
    raise exception 'Only images and voice notes have attachments' using errcode = '22023';
  end if;

  insert into public.messages
    (conversation_id, sender_role, sender_user_id, type, body,
     attachment_path, attachment_mime, attachment_size, attachment_duration_ms,
     attachment_width, attachment_height,
     location_lat, location_lng, location_accuracy_m,
     client_message_id, forwarded)
  values
    (p_target_conversation_id, 'admin', v_uid, v_src.type,
     case when v_src.type = 'text' then v_src.body end,
     case when v_src.type in ('image', 'audio') then p_attachment_path end,
     case when v_src.type in ('image', 'audio') then v_src.attachment_mime end,
     case when v_src.type in ('image', 'audio') then coalesce(v_size, v_src.attachment_size) end,
     case when v_src.type = 'audio' then v_src.attachment_duration_ms end,
     case when v_src.type = 'image' then v_src.attachment_width end,
     case when v_src.type = 'image' then v_src.attachment_height end,
     case when v_src.type = 'location' then v_src.location_lat end,
     case when v_src.type = 'location' then v_src.location_lng end,
     case when v_src.type = 'location' then v_src.location_accuracy_m end,
     p_client_message_id, true)
  returning * into v_msg;

  insert into private.message_forwards (message_id, source_message_id, source_conversation_id, forwarded_by)
  values (v_msg.id, v_src.id, v_src.conversation_id, v_uid);

  update public.conversations c set
    last_message_at       = v_msg.created_at,
    last_message_preview  = private.message_preview(v_msg),
    last_message_sender   = 'admin',
    last_message_seq      = v_msg.seq,
    customer_unread_count = c.customer_unread_count + 1
  where c.id = p_target_conversation_id;

  return v_msg;
end;
$$;

revoke all on function public.admin_forward_message(uuid, uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.admin_forward_message(uuid, uuid, uuid, text) to authenticated;

-- A forward copy that never became a message (e.g. the destination was blocked
-- meanwhile, or the admin discarded a failed forward) is queued for removal.
-- Only the caller's own, unreferenced copies qualify.
create or replace function public.admin_release_unsent_attachment(p_attachment_path text)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_customer uuid;
begin
  if not private.is_admin() then
    raise exception 'Admin access required' using errcode = '42501';
  end if;
  if not exists (
    select 1 from storage.objects o
    where o.bucket_id = 'chat-media' and o.name = p_attachment_path and o.owner_id = v_uid::text
  ) or exists (
    select 1 from public.messages m where m.attachment_path = p_attachment_path
  ) then
    return false;
  end if;

  select c.customer_id into v_customer
  from public.conversations c where c.id = private.media_conversation_id(p_attachment_path);
  if v_customer is null then
    return false;
  end if;

  insert into private.storage_cleanup (bucket_id, object_name, customer_id, queued_by)
  values ('chat-media', p_attachment_path, v_customer, v_uid)
  on conflict (bucket_id, object_name) do nothing;
  return true;
end;
$$;

revoke all on function public.admin_release_unsent_attachment(text) from public, anon, authenticated;
grant execute on function public.admin_release_unsent_attachment(text) to authenticated;

-- -----------------------------------------------------------------------------
-- Admin list: add blocked_at (return type changes: drop + recreate, same args).
-- -----------------------------------------------------------------------------
drop function public.admin_list_conversations(uuid, uuid);

create function public.admin_list_conversations(
  p_label_id        uuid default null,
  p_conversation_id uuid default null
)
returns table (
  id                   uuid,
  customer_id          uuid,
  public_ref           text,
  display_name         text,
  avatar_path          text,
  created_at           timestamptz,
  last_message_at      timestamptz,
  last_message_sender  text,
  last_message_preview text,
  admin_unread_count   integer,
  labels               jsonb,
  pinned_at            timestamptz,
  archived_at          timestamptz,
  blocked_at           timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_uid uuid := (select auth.uid());
begin
  if not private.is_admin() then
    raise exception 'Admin access required' using errcode = '42501';
  end if;

  return query
  select
    c.id,
    cu.id,
    cu.public_ref,
    cu.display_name,
    cu.avatar_path,
    c.created_at,
    c.last_message_at,
    (lm.msg).sender_role,
    private.message_preview(lm.msg),
    c.admin_unread_count,
    coalesce((
      select jsonb_agg(jsonb_build_object('id', l.id, 'name', l.name) order by lower(l.name))
      from public.customer_labels cl
      join public.labels l on l.id = cl.label_id
      where cl.customer_id = cu.id
    ), '[]'::jsonb),
    cp.pinned_at,
    ca.archived_at,
    c.blocked_at
  from public.conversations c
  join public.customers cu on cu.id = c.customer_id
  left join public.conversation_pins cp on cp.conversation_id = c.id
  left join public.conversation_admin_archives ca on ca.conversation_id = c.id
  left join lateral (
    -- Newest message this admin has not hidden for themself.
    select m as msg from public.messages m
    where m.conversation_id = c.id
      and not exists (
        select 1 from public.message_hidden h
        where h.message_id = m.id and h.user_id = v_uid
      )
    order by m.seq desc
    limit 1
  ) lm on true
  where c.last_message_at is not null
    and (p_conversation_id is null or c.id = p_conversation_id)
    and (p_label_id is null or exists (
      select 1 from public.customer_labels cl
      where cl.customer_id = cu.id and cl.label_id = p_label_id
    ))
  order by
    (ca.archived_at is not null),
    (ca.archived_at is null and cp.pinned_at is not null) desc,
    c.last_message_at desc nulls last,
    c.created_at desc
  limit 300;
end;
$$;

revoke all on function public.admin_list_conversations(uuid, uuid) from public, anon, authenticated;
grant execute on function public.admin_list_conversations(uuid, uuid) to authenticated;
