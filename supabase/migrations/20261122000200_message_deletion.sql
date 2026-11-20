-- =============================================================================
-- H-Pharmacy Customer Inbox — Message deletion
--
--  * Delete for me:       hides one message for the person who chose it only
--                         (public.message_hidden). RLS stops returning it to
--                         them — after refresh, reconnect and in Realtime.
--  * Delete for everyone: only the original sender (guest or admin) can do it.
--                         The row stays (history order, unread maths) but its
--                         content and attachment reference are cleared and
--                         deleted_at is set; both sides then show
--                         "This message was deleted". An admin cannot delete a
--                         customer's message for everyone.
--  * Media: the Storage object is NOT removed (no permanent cleanup in this
--    change). Its path is recorded in private.revoked_media and the Storage
--    read policy refuses it, so no new signed URL or download is possible.
--    Signed URLs issued *before* the deletion keep working until they expire
--    (Storage validates the URL token, not RLS) — the app now issues 10-minute
--    links. See README "Retention".
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Columns + constraints (deleted rows have no content)
-- -----------------------------------------------------------------------------
alter table public.messages
  add column deleted_at timestamptz,
  add column deleted_by uuid references auth.users (id) on delete set null;

alter table public.messages drop constraint messages_text_body;
alter table public.messages add constraint messages_text_body check (
  deleted_at is not null
  or type <> 'text'
  or (body is not null and char_length(btrim(body)) between 1 and 4000)
);

alter table public.messages drop constraint messages_attachment_required;
alter table public.messages add constraint messages_attachment_required check (
  deleted_at is not null or type = 'text' or attachment_path is not null
);

alter table public.messages add constraint messages_deleted_has_no_content check (
  deleted_at is null
  or (body is null and attachment_path is null and attachment_mime is null
      and attachment_size is null and attachment_duration_ms is null
      and attachment_width is null and attachment_height is null)
);

-- -----------------------------------------------------------------------------
-- "Delete for me"
-- -----------------------------------------------------------------------------
create table public.message_hidden (
  message_id uuid not null references public.messages (id) on delete cascade,
  user_id    uuid not null references auth.users (id) on delete cascade,
  hidden_at  timestamptz not null default now(),
  primary key (message_id, user_id)
);
create index message_hidden_user_idx on public.message_hidden (user_id);

revoke all on table public.message_hidden from public, anon, authenticated;
grant select on table public.message_hidden to authenticated;
alter table public.message_hidden enable row level security;
create policy message_hidden_select_own
  on public.message_hidden for select to authenticated
  using (user_id = (select auth.uid()));

-- Messages: same access rule as before, minus what the caller hid.
drop policy messages_select_own_or_admin on public.messages;
create policy messages_select_visible
  on public.messages for select to authenticated
  using (
    ((select private.is_admin()) or private.owns_conversation(conversation_id))
    and not exists (
      select 1 from public.message_hidden h
      where h.message_id = messages.id and h.user_id = (select auth.uid())
    )
  );

-- -----------------------------------------------------------------------------
-- Revoked media (attachments of messages deleted for everyone)
-- -----------------------------------------------------------------------------
create table private.revoked_media (
  object_name text primary key,
  message_id  uuid,
  revoked_at  timestamptz not null default now()
);
revoke all on table private.revoked_media from public, anon, authenticated;
alter table private.revoked_media enable row level security;

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
  if exists (select 1 from private.revoked_media r where r.object_name = p_name) then
    return false;
  end if;
  return private.is_admin() or private.owns_conversation(v_conversation);
end;
$$;

-- -----------------------------------------------------------------------------
-- Unread counts now skip deleted messages and messages the reader hid.
-- -----------------------------------------------------------------------------
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
    and m.seq > p_after_seq
    and m.deleted_at is null
    and not exists (
      select 1 from public.message_hidden h
      where h.message_id = m.id
        and (
          (p_side = 'customer' and h.user_id = (
             select cu.user_id from public.conversations c
             join public.customers cu on cu.id = c.customer_id
             where c.id = p_conversation_id))
          or (p_side = 'admin' and h.user_id in (select a.user_id from private.admins a))
        )
    );
$$;

-- Preview text for one message row.
create or replace function private.message_preview(m public.messages)
returns text
language sql
immutable
set search_path = ''
as $$
  select case
    when m.id is null then null
    when m.deleted_at is not null then 'This message was deleted'
    when m.type = 'text' then left(m.body, 140)
    when m.type = 'image' then 'Photo'
    else 'Voice note' || case
      when m.attachment_duration_ms is not null
        then ' (' || (m.attachment_duration_ms / 60000)::text || ':'
             || lpad(((m.attachment_duration_ms / 1000) % 60)::text, 2, '0') || ')'
      else '' end
  end;
$$;

-- Recompute the stored list preview and both unread counts.
create or replace function private.refresh_conversation_summary(p_conversation_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_last public.messages;
begin
  select * into v_last from public.messages
  where conversation_id = p_conversation_id
  order by seq desc limit 1;

  update public.conversations c set
    last_message_preview  = private.message_preview(v_last),
    last_message_sender   = v_last.sender_role,
    admin_unread_count    = private.unread_for(c.id, 'admin', c.admin_last_read_seq),
    customer_unread_count = private.unread_for(c.id, 'customer', c.customer_last_read_seq)
  where c.id = p_conversation_id;
end;
$$;

revoke all on function private.message_preview(public.messages)       from public, anon, authenticated;
revoke all on function private.refresh_conversation_summary(uuid)      from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- RPC: delete for me
-- -----------------------------------------------------------------------------
create or replace function public.hide_message_for_me(p_message_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid  uuid := (select auth.uid());
  v_conv uuid;
begin
  if v_uid is null then
    raise exception 'Not signed in' using errcode = '42501';
  end if;
  select conversation_id into v_conv from public.messages where id = p_message_id;
  if v_conv is null or not (private.is_admin() or private.owns_conversation(v_conv)) then
    raise exception 'Message not found' using errcode = '42501';
  end if;

  perform 1 from public.conversations where id = v_conv for update;
  insert into public.message_hidden (message_id, user_id)
  values (p_message_id, v_uid)
  on conflict do nothing;
  perform private.refresh_conversation_summary(v_conv);
end;
$$;

-- -----------------------------------------------------------------------------
-- RPC: delete for everyone (sender only)
-- -----------------------------------------------------------------------------
create or replace function public.delete_message_for_everyone(p_message_id uuid)
returns public.messages
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid  uuid := (select auth.uid());
  v_conv uuid;
  v_msg  public.messages;
begin
  if v_uid is null then
    raise exception 'Not signed in' using errcode = '42501';
  end if;
  select conversation_id into v_conv from public.messages where id = p_message_id;
  if v_conv is null or not (private.is_admin() or private.owns_conversation(v_conv)) then
    raise exception 'Message not found' using errcode = '42501';
  end if;

  -- Lock order matches sends: conversation first, then the message.
  perform 1 from public.conversations where id = v_conv for update;
  select * into v_msg from public.messages where id = p_message_id for update;

  if v_msg.sender_user_id is distinct from v_uid then
    raise exception 'You can only delete your own messages for everyone' using errcode = '42501';
  end if;
  if v_msg.deleted_at is not null then
    return v_msg;  -- already deleted: idempotent
  end if;

  if v_msg.attachment_path is not null then
    insert into private.revoked_media (object_name, message_id)
    values (v_msg.attachment_path, v_msg.id)
    on conflict (object_name) do nothing;
  end if;

  update public.messages set
    body = null,
    attachment_path = null,
    attachment_mime = null,
    attachment_size = null,
    attachment_duration_ms = null,
    attachment_width = null,
    attachment_height = null,
    deleted_at = now(),
    deleted_by = v_uid
  where id = p_message_id
  returning * into v_msg;

  perform private.refresh_conversation_summary(v_conv);
  return v_msg;
end;
$$;

revoke all on function public.hide_message_for_me(uuid)          from public, anon, authenticated;
revoke all on function public.delete_message_for_everyone(uuid)  from public, anon, authenticated;
grant execute on function public.hide_message_for_me(uuid)         to authenticated;
grant execute on function public.delete_message_for_everyone(uuid) to authenticated;

notify pgrst, 'reload schema';
