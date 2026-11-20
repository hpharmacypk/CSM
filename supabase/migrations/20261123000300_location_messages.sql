-- =============================================================================
-- H-Pharmacy Customer Inbox — Location (map pin) messages
--
-- A location message is one latitude/longitude point (WGS 84) chosen and
-- explicitly sent by the guest or the admin. No live tracking, no drafts.
--  * Stored on messages (type = 'location'); same RLS, Realtime, unread,
--    history, "delete for me", "delete for everyone" and pinning as others.
--  * Validated twice: by send_location_message() (readable errors) and by
--    table CHECK constraints (finite, -90..90 / -180..180; NaN and ±Infinity
--    fail the range checks).
--  * Delete for everyone clears the coordinates and the shared pin.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Columns and constraints
-- -----------------------------------------------------------------------------
alter table public.messages
  add column location_lat        double precision,
  add column location_lng        double precision,
  add column location_accuracy_m real;

alter table public.messages drop constraint messages_type_check;
alter table public.messages add constraint messages_type_check
  check (type in ('text', 'image', 'audio', 'location'));

alter table public.messages add constraint messages_location_range check (
  (location_lat is null and location_lng is null)
  or (location_lat between -90 and 90 and location_lng between -180 and 180)
);
alter table public.messages add constraint messages_location_accuracy check (
  location_accuracy_m is null or (location_accuracy_m >= 0 and location_accuracy_m <= 100000)
);
alter table public.messages add constraint messages_location_required check (
  type <> 'location' or deleted_at is not null
  or (location_lat is not null and location_lng is not null)
);
alter table public.messages add constraint messages_location_only_on_location check (
  type = 'location' or (location_lat is null and location_lng is null and location_accuracy_m is null)
);

alter table public.messages drop constraint messages_attachment_required;
alter table public.messages add constraint messages_attachment_required check (
  deleted_at is not null or type in ('text', 'location') or attachment_path is not null
);

alter table public.messages drop constraint messages_deleted_has_no_content;
alter table public.messages add constraint messages_deleted_has_no_content check (
  deleted_at is null
  or (body is null and attachment_path is null and attachment_mime is null
      and attachment_size is null and attachment_duration_ms is null
      and attachment_width is null and attachment_height is null
      and location_lat is null and location_lng is null and location_accuracy_m is null)
);

-- -----------------------------------------------------------------------------
-- List preview
-- -----------------------------------------------------------------------------
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
    when m.type = 'location' then 'Location'
    else 'Voice note' || case
      when m.attachment_duration_ms is not null
        then ' (' || (m.attachment_duration_ms / 60000)::text || ':'
             || lpad(((m.attachment_duration_ms / 1000) % 60)::text, 2, '0') || ')'
      else '' end
  end;
$$;

-- -----------------------------------------------------------------------------
-- RPC: send a location (sender + role from the session; idempotent retry)
-- -----------------------------------------------------------------------------
create or replace function public.send_location_message(
  p_conversation_id   uuid,
  p_latitude          double precision,
  p_longitude         double precision,
  p_client_message_id uuid,
  p_accuracy_m        real default null
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
    raise exception 'Conversation not found' using errcode = '42501';
  end if;

  -- NaN and ±Infinity are not between the bounds, so they are rejected here.
  if p_latitude is null or p_longitude is null
     or not (p_latitude between -90 and 90)
     or not (p_longitude between -180 and 180) then
    raise exception 'Invalid location: latitude must be -90..90 and longitude -180..180' using errcode = '22023';
  end if;
  if p_accuracy_m is not null and not (p_accuracy_m >= 0 and p_accuracy_m <= 100000) then
    raise exception 'Invalid location accuracy' using errcode = '22023';
  end if;

  perform 1 from public.conversations where id = p_conversation_id for update;
  if not found then
    raise exception 'Conversation not found' using errcode = '42501';
  end if;

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
    (conversation_id, sender_role, sender_user_id, type, body,
     location_lat, location_lng, location_accuracy_m, client_message_id)
  values
    (p_conversation_id, v_role, v_uid, 'location', null,
     p_latitude, p_longitude, p_accuracy_m, p_client_message_id)
  returning * into v_msg;

  update public.conversations c set
    last_message_at       = v_msg.created_at,
    last_message_preview  = 'Location',
    last_message_sender   = v_role,
    last_message_seq      = v_msg.seq,
    admin_unread_count    = case when v_role = 'customer' then c.admin_unread_count + 1 else c.admin_unread_count end,
    customer_unread_count = case when v_role = 'admin' then c.customer_unread_count + 1 else c.customer_unread_count end
  where c.id = p_conversation_id;

  return v_msg;
end;
$$;

revoke all on function public.send_location_message(uuid, double precision, double precision, uuid, real)
  from public, anon, authenticated;
grant execute on function public.send_location_message(uuid, double precision, double precision, uuid, real)
  to authenticated;

-- -----------------------------------------------------------------------------
-- Delete for everyone: also clears coordinates (and the shared pin).
-- Body from 20261123000200_message_pins.sql plus the location fields.
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
    location_lat = null,
    location_lng = null,
    location_accuracy_m = null,
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
