-- =============================================================================
-- H-Pharmacy Customer Inbox — Admin chat pins
--
-- Admins can pin conversations to the top of the inbox. Pins are shared by
-- all admins, persist across refreshes/sign-ins, and are admin-only:
--   * public.conversation_pins has RLS allowing only private.is_admin().
--   * It is not in the Realtime publication, so guests never receive it.
--   * Guests have no other path to it (the conversations row is unchanged).
-- admin_list_conversations() now returns pinned_at and lists pinned chats
-- first, keeping the existing order (newest activity) within each group.
-- =============================================================================

create table public.conversation_pins (
  conversation_id uuid primary key references public.conversations (id) on delete cascade,
  pinned_by       uuid references auth.users (id) on delete set null,
  pinned_at       timestamptz not null default now()
);

revoke all on table public.conversation_pins from public, anon, authenticated;
grant select on table public.conversation_pins to authenticated;
alter table public.conversation_pins enable row level security;
create policy conversation_pins_admin_select on public.conversation_pins
  for select to authenticated
  using ((select private.is_admin()));
-- Writes only through set_conversation_pinned() below.

create or replace function public.set_conversation_pinned(
  p_conversation_id uuid,
  p_pinned          boolean
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

  if coalesce(p_pinned, false) then
    insert into public.conversation_pins (conversation_id, pinned_by)
    values (p_conversation_id, (select auth.uid()))
    on conflict (conversation_id) do nothing;
  else
    delete from public.conversation_pins where conversation_id = p_conversation_id;
  end if;
  return coalesce(p_pinned, false);
end;
$$;

revoke all on function public.set_conversation_pinned(uuid, boolean) from public, anon, authenticated;
grant execute on function public.set_conversation_pinned(uuid, boolean) to authenticated;

-- -----------------------------------------------------------------------------
-- Admin list: add pinned_at, pinned chats first. (Return type changes, so the
-- function is dropped and recreated; same arguments.)
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
  pinned_at            timestamptz
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
    cp.pinned_at
  from public.conversations c
  join public.customers cu on cu.id = c.customer_id
  left join public.conversation_pins cp on cp.conversation_id = c.id
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
  order by (cp.pinned_at is null), c.last_message_at desc nulls last, c.created_at desc
  limit 300;
end;
$$;

revoke all on function public.admin_list_conversations(uuid, uuid) from public, anon, authenticated;
grant execute on function public.admin_list_conversations(uuid, uuid) to authenticated;

notify pgrst, 'reload schema';
