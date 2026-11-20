-- =============================================================================
-- H-Pharmacy Customer Inbox — Admin labels + admin conversation list
--
--  * public.labels: admin-defined labels. Names are trimmed (inner whitespace
--    collapsed) and unique ignoring case, so "Complete" and " complete "
--    cannot both exist.
--  * public.customer_labels: many-to-many, one row per (customer, label).
--    Deleting a label removes its assignments; chats are untouched.
--  * Admin-only: RLS allows only private.is_admin(). Neither table is in the
--    Realtime publication, so guests can never receive them live.
--  * public.admin_list_conversations(): one admin-only call that returns the
--    inbox list with customer reference, profile name/photo path, labels,
--    unread count and a preview that respects the admin's own "Delete for me".
-- =============================================================================

create table public.labels (
  id         uuid primary key default gen_random_uuid(),
  name       text not null check (char_length(name) between 1 and 40 and name = btrim(name)),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index labels_name_ci_unique on public.labels (lower(name));

create table public.customer_labels (
  customer_id uuid not null references public.customers (id) on delete cascade,
  label_id    uuid not null references public.labels (id) on delete cascade,
  created_at  timestamptz not null default now(),
  primary key (customer_id, label_id)
);
create index customer_labels_label_idx on public.customer_labels (label_id);

-- Normalise names before the uniqueness check.
create or replace function private.normalize_label_name()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.name := btrim(regexp_replace(coalesce(new.name, ''), '\s+', ' ', 'g'));
  new.updated_at := now();
  return new;
end;
$$;
revoke all on function private.normalize_label_name() from public, anon, authenticated;

create trigger labels_normalize_name
  before insert or update of name on public.labels
  for each row execute function private.normalize_label_name();

-- Privileges: admin-only through RLS. Guests (and signed-out) get nothing.
revoke all on table public.labels, public.customer_labels from public, anon, authenticated;
grant select, insert, update, delete on table public.labels, public.customer_labels to authenticated;
alter table public.labels          enable row level security;
alter table public.customer_labels enable row level security;

create policy labels_admin_all on public.labels
  for all to authenticated
  using ((select private.is_admin()))
  with check ((select private.is_admin()));

create policy customer_labels_admin_all on public.customer_labels
  for all to authenticated
  using ((select private.is_admin()))
  with check ((select private.is_admin()));

-- -----------------------------------------------------------------------------
-- Admin conversation list
-- -----------------------------------------------------------------------------
create or replace function public.admin_list_conversations(
  p_label_id        uuid default null,
  p_conversation_id uuid default null
)
returns table (
  id                  uuid,
  customer_id         uuid,
  public_ref          text,
  display_name        text,
  avatar_path         text,
  created_at          timestamptz,
  last_message_at     timestamptz,
  last_message_sender text,
  last_message_preview text,
  admin_unread_count  integer,
  labels              jsonb
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
    ), '[]'::jsonb)
  from public.conversations c
  join public.customers cu on cu.id = c.customer_id
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
  order by c.last_message_at desc nulls last, c.created_at desc
  limit 300;
end;
$$;

revoke all on function public.admin_list_conversations(uuid, uuid) from public, anon, authenticated;
grant execute on function public.admin_list_conversations(uuid, uuid) to authenticated;
-- message_preview is called from this definer function only.

notify pgrst, 'reload schema';
