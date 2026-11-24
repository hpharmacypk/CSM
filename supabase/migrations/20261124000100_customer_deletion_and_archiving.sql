-- =============================================================================
-- H-Pharmacy Customer Inbox — Customer deletion (admin) and chat archiving
--
-- Customer deletion
--   * public.admin_delete_customer(): admin-only. Deletes ONE customer row;
--     existing ON DELETE CASCADE rules remove that customer's conversation,
--     messages, "delete for me" records, admin chat pin, admin archive record
--     and label assignments. Shared labels, other customers and every admin
--     account are untouched. The anonymous auth account is kept (it holds no
--     personal data); if that browser opens the inbox again it gets a new,
--     empty inbox with a new HP reference.
--   * Files: before deleting, the customer's Storage objects (chat-media/<conv>/…
--     and profile-photos/<customer>/…) are recorded in private.storage_cleanup.
--     The admin's browser then removes them through the Storage API with its
--     own session. Two Storage policies allow an admin to see/delete ONLY
--     objects in that queue — no service-role key is needed anywhere.
--   * public.admin_pending_storage_cleanup(): admin-only. Forgets queue entries
--     whose file is gone and returns what is left, so a failed cleanup can be
--     retried at any time.
--
-- Archiving (independent per side, never automatic, never undone by new
-- messages; messages, attachments, pins, labels and unread counts unchanged)
--   * Admin: public.conversation_admin_archives (admin-only, like chat pins),
--     written by public.set_conversation_archived(). admin_list_conversations()
--     now also returns archived_at.
--   * Customer: conversations.customer_archived_at, written only by
--     public.set_my_conversation_archived() for the caller's own conversation.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Storage cleanup queue (private; never exposed through the Data API)
-- -----------------------------------------------------------------------------
create table private.storage_cleanup (
  bucket_id   text        not null check (bucket_id in ('chat-media', 'profile-photos')),
  object_name text        not null,
  customer_id uuid        not null, -- the deleted customer (row no longer exists)
  queued_by   uuid,
  queued_at   timestamptz not null default now(),
  primary key (bucket_id, object_name)
);
revoke all on table private.storage_cleanup from public, anon, authenticated;
alter table private.storage_cleanup enable row level security;
-- No policies: reachable only through the SECURITY DEFINER functions below.

create or replace function private.is_queued_for_cleanup(p_bucket_id text, p_name text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select private.is_admin() and exists (
    select 1 from private.storage_cleanup q
    where q.bucket_id = p_bucket_id and q.object_name = p_name
  );
$$;

revoke all on function private.is_queued_for_cleanup(text, text) from public, anon, authenticated;
grant execute on function private.is_queued_for_cleanup(text, text) to authenticated;

-- The Storage API deletes with the caller's role (DELETE … RETURNING), so the
-- admin needs both SELECT and DELETE — and only for queued objects.
create policy storage_cleanup_admin_select
  on storage.objects for select to authenticated
  using (
    bucket_id in ('chat-media', 'profile-photos')
    and private.is_queued_for_cleanup(bucket_id, name)
  );

create policy storage_cleanup_admin_delete
  on storage.objects for delete to authenticated
  using (
    bucket_id in ('chat-media', 'profile-photos')
    and private.is_queued_for_cleanup(bucket_id, name)
  );

-- -----------------------------------------------------------------------------
-- RPC: delete one customer (admin only)
-- -----------------------------------------------------------------------------
create or replace function public.admin_delete_customer(p_customer_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_customer public.customers%rowtype;
  v_conversations uuid[];
  v_messages integer;
  v_files integer;
begin
  if not private.is_admin() then
    raise exception 'Admin access required' using errcode = '42501';
  end if;

  select * into v_customer from public.customers where id = p_customer_id for update;
  if not found then
    -- Already deleted (e.g. from another tab): nothing to do.
    return null;
  end if;

  -- Never touch an admin's account or anything that is not a guest customer.
  if v_customer.user_id is not null and (
    exists (select 1 from private.admins a where a.user_id = v_customer.user_id)
    or exists (
      select 1 from auth.users u
      where u.id = v_customer.user_id and coalesce(u.is_anonymous, false) = false
    )
  ) then
    raise exception 'Only guest customers can be deleted' using errcode = '42501';
  end if;

  select coalesce(array_agg(c.id), '{}') into v_conversations
  from public.conversations c where c.customer_id = p_customer_id;

  select count(*) into v_messages
  from public.messages m where m.conversation_id = any (v_conversations);

  -- Queue this customer's files (only their own folders).
  insert into private.storage_cleanup (bucket_id, object_name, customer_id, queued_by)
  select o.bucket_id, o.name, p_customer_id, (select auth.uid())
  from storage.objects o
  where (o.bucket_id = 'chat-media'
         and split_part(o.name, '/', 1) in (select unnest(v_conversations)::text))
     or (o.bucket_id = 'profile-photos'
         and split_part(o.name, '/', 1) = p_customer_id::text)
  on conflict (bucket_id, object_name) do nothing;
  get diagnostics v_files = row_count;

  -- Cascades: conversations → messages → message_hidden; conversation_pins;
  -- conversation_admin_archives; customer_labels.
  delete from public.customers where id = p_customer_id;

  return jsonb_build_object(
    'customer_id', p_customer_id,
    'public_ref', v_customer.public_ref,
    'conversation_ids', to_jsonb(v_conversations),
    'messages_deleted', v_messages,
    'files_queued', v_files
  );
end;
$$;

revoke all on function public.admin_delete_customer(uuid) from public, anon, authenticated;
grant execute on function public.admin_delete_customer(uuid) to authenticated;

-- -----------------------------------------------------------------------------
-- RPC: what still has to be removed from Storage (admin only, retryable)
-- -----------------------------------------------------------------------------
create or replace function public.admin_pending_storage_cleanup()
returns table (bucket_id text, object_name text)
language plpgsql
volatile
security definer
set search_path = ''
as $$
#variable_conflict use_column
begin
  if not private.is_admin() then
    raise exception 'Admin access required' using errcode = '42501';
  end if;

  -- Files that are gone no longer need tracking (nor their revocation entry).
  with gone as (
    delete from private.storage_cleanup q
    where not exists (
      select 1 from storage.objects o
      where o.bucket_id = q.bucket_id and o.name = q.object_name
    )
    returning q.bucket_id, q.object_name
  )
  delete from private.revoked_media r
  using gone g
  where g.bucket_id = 'chat-media' and r.object_name = g.object_name;

  return query
  select q.bucket_id, q.object_name
  from private.storage_cleanup q
  order by q.queued_at, q.bucket_id, q.object_name
  limit 1000;
end;
$$;

revoke all on function public.admin_pending_storage_cleanup() from public, anon, authenticated;
grant execute on function public.admin_pending_storage_cleanup() to authenticated;

-- -----------------------------------------------------------------------------
-- Admin-side archive (admin-only, shared by all admins; not in Realtime)
-- -----------------------------------------------------------------------------
create table public.conversation_admin_archives (
  conversation_id uuid primary key references public.conversations (id) on delete cascade,
  archived_by     uuid references auth.users (id) on delete set null,
  archived_at     timestamptz not null default now()
);

revoke all on table public.conversation_admin_archives from public, anon, authenticated;
grant select on table public.conversation_admin_archives to authenticated;
alter table public.conversation_admin_archives enable row level security;
create policy conversation_admin_archives_admin_select on public.conversation_admin_archives
  for select to authenticated
  using ((select private.is_admin()));
-- Writes only through set_conversation_archived().

create or replace function public.set_conversation_archived(
  p_conversation_id uuid,
  p_archived        boolean
)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if not private.is_admin() then
    raise exception 'Admin access required' using errcode = '42501';
  end if;
  if not exists (select 1 from public.conversations where id = p_conversation_id) then
    raise exception 'Conversation not found' using errcode = '22023';
  end if;

  if coalesce(p_archived, false) then
    insert into public.conversation_admin_archives (conversation_id, archived_by)
    values (p_conversation_id, (select auth.uid()))
    on conflict (conversation_id) do nothing;
  else
    delete from public.conversation_admin_archives where conversation_id = p_conversation_id;
  end if;
  return coalesce(p_archived, false);
end;
$$;

revoke all on function public.set_conversation_archived(uuid, boolean) from public, anon, authenticated;
grant execute on function public.set_conversation_archived(uuid, boolean) to authenticated;

-- -----------------------------------------------------------------------------
-- Customer-side archive (the guest's own conversation only)
-- -----------------------------------------------------------------------------
alter table public.conversations
  add column customer_archived_at timestamptz;

create or replace function public.set_my_conversation_archived(p_archived boolean)
returns timestamptz
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_conversation uuid;
  v_archived_at timestamptz;
begin
  if v_uid is null then
    raise exception 'Not signed in' using errcode = '42501';
  end if;

  select c.id into v_conversation
  from public.conversations c
  join public.customers cu on cu.id = c.customer_id
  where cu.user_id = v_uid
  for update of c;
  if v_conversation is null then
    raise exception 'Conversation not found' using errcode = '22023';
  end if;

  update public.conversations
  set customer_archived_at = case
        when coalesce(p_archived, false) then coalesce(customer_archived_at, now())
        else null
      end
  where id = v_conversation
  returning customer_archived_at into v_archived_at;

  return v_archived_at;
end;
$$;

revoke all on function public.set_my_conversation_archived(boolean) from public, anon, authenticated;
grant execute on function public.set_my_conversation_archived(boolean) to authenticated;

-- -----------------------------------------------------------------------------
-- Admin list: add archived_at. Return type changes, so drop and recreate
-- (same arguments). Archived chats come last; pins only order active chats.
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
  archived_at          timestamptz
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
    ca.archived_at
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
