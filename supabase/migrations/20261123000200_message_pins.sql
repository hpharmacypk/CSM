-- =============================================================================
-- H-Pharmacy Customer Inbox — One shared pinned message per conversation
--
--  * conversations.pinned_message_id: the single pinned message, shared by the
--    guest and the admin. It is only an id; the banner content is always read
--    through the messages RLS policy, so a viewer who hid the message ("Delete
--    for me") gets no banner, and nobody gets content they cannot see.
--  * pin_message(): guest or admin, for a message in their conversation that
--    they can currently see (not deleted for everyone, not hidden by them).
--    Replacing an existing pin is allowed (the app asks for confirmation).
--  * unpin_message(): guest or admin of that conversation. Optional
--    p_expected_message_id avoids clearing a pin someone else just changed.
--  * Delete for everyone clears the pin (delete function replaced below).
--  * Live sync: the conversations row is already in the Realtime publication
--    and RLS-filtered per viewer.
-- =============================================================================

alter table public.conversations
  add column pinned_message_id uuid references public.messages (id) on delete set null,
  add column pinned_by         uuid references auth.users (id) on delete set null,
  add column pinned_at         timestamptz;

create or replace function public.pin_message(p_message_id uuid)
returns uuid
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

  perform 1 from public.conversations where id = v_conv for update;
  select * into v_msg from public.messages where id = p_message_id for update;

  if v_msg.deleted_at is not null then
    raise exception 'A deleted message cannot be pinned' using errcode = '22023';
  end if;
  if exists (select 1 from public.message_hidden h where h.message_id = p_message_id and h.user_id = v_uid) then
    raise exception 'Message not found' using errcode = '42501';
  end if;

  update public.conversations
     set pinned_message_id = p_message_id,
         pinned_by = v_uid,
         pinned_at = now()
   where id = v_conv
     and pinned_message_id is distinct from p_message_id;

  return p_message_id;
end;
$$;

create or replace function public.unpin_message(
  p_conversation_id     uuid,
  p_expected_message_id uuid default null
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
begin
  if v_uid is null then
    raise exception 'Not signed in' using errcode = '42501';
  end if;
  if not (private.is_admin() or private.owns_conversation(p_conversation_id)) then
    raise exception 'Conversation not found' using errcode = '42501';
  end if;

  update public.conversations
     set pinned_message_id = null, pinned_by = v_uid, pinned_at = now()
   where id = p_conversation_id
     and pinned_message_id is not null
     and (p_expected_message_id is null or pinned_message_id = p_expected_message_id);
end;
$$;

revoke all on function public.pin_message(uuid)         from public, anon, authenticated;
revoke all on function public.unpin_message(uuid, uuid)  from public, anon, authenticated;
grant execute on function public.pin_message(uuid)        to authenticated;
grant execute on function public.unpin_message(uuid, uuid) to authenticated;

-- -----------------------------------------------------------------------------
-- Delete for everyone also clears the shared pin. Body copied from
-- 20261122000200_message_deletion.sql plus the pin-clearing update.
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

  update public.conversations
     set pinned_message_id = null, pinned_by = v_uid, pinned_at = now()
   where id = v_conv and pinned_message_id = p_message_id;

  perform private.refresh_conversation_summary(v_conv);
  return v_msg;
end;
$$;

notify pgrst, 'reload schema';
