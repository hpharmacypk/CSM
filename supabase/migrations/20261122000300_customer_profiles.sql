-- =============================================================================
-- H-Pharmacy Customer Inbox — Editable customer profile
--
-- Optional display name, short bio and profile photo, stored on the existing
-- customer record (same id, HP- reference, inbox, history and labels).
--  * A guest reads and edits only their own profile (existing customers RLS;
--    writes only through the functions below).
--  * The admin can read every profile. Other guests cannot.
--  * Photos live in the private `profile-photos` bucket under
--    <customer_id>/<random uuid>.<webp|jpg|png>. Only the customer's
--    *current* photo is readable (by that customer and the admin); replaced
--    or removed photos are no longer served. Objects are not deleted here.
-- =============================================================================

alter table public.customers
  add column display_name text
    check (display_name is null or (char_length(display_name) between 1 and 60 and display_name = btrim(display_name))),
  add column bio text
    check (bio is null or (char_length(bio) between 1 and 300 and bio = btrim(bio))),
  add column avatar_path text,
  add column profile_updated_at timestamptz;

-- -----------------------------------------------------------------------------
-- Bucket
-- -----------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('profile-photos', 'profile-photos', false, 1048576, array['image/webp', 'image/jpeg', 'image/png'])
on conflict (id) do update set
  public             = excluded.public,
  file_size_limit    = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

create or replace function private.avatar_customer_id(p_name text)
returns uuid
language sql
immutable
set search_path = ''
as $$
  select case
    when p_name ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(webp|jpg|png)$'
    then split_part(p_name, '/', 1)::uuid
    else null
  end;
$$;

-- Read: the customer may read files in their own folder (needed while
-- uploading, before the photo is set); the admin may read only the customer's
-- *current* photo. Other guests: nothing.
create or replace function private.can_read_avatar(p_name text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select (select auth.uid()) is not null and exists (
    select 1 from public.customers c
    where c.id = private.avatar_customer_id(p_name)
      and (
        c.user_id = (select auth.uid())
        or (c.avatar_path = p_name and private.is_admin())
      )
  );
$$;

-- Upload: only into your own customer folder.
create or replace function private.can_upload_avatar(p_name text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select (select auth.uid()) is not null and exists (
    select 1 from public.customers c
    where c.id = private.avatar_customer_id(p_name)
      and c.user_id = (select auth.uid())
  );
$$;

revoke all on function private.avatar_customer_id(text) from public, anon, authenticated;
revoke all on function private.can_read_avatar(text)    from public, anon, authenticated;
revoke all on function private.can_upload_avatar(text)  from public, anon, authenticated;
grant execute on function private.avatar_customer_id(text) to authenticated;
grant execute on function private.can_read_avatar(text)    to authenticated;
grant execute on function private.can_upload_avatar(text)  to authenticated;

create policy profile_photos_select
  on storage.objects for select to authenticated
  using (bucket_id = 'profile-photos' and private.can_read_avatar(name));

create policy profile_photos_insert
  on storage.objects for insert to authenticated
  with check (bucket_id = 'profile-photos' and private.can_upload_avatar(name));

-- -----------------------------------------------------------------------------
-- RPCs (guest edits own profile only)
-- -----------------------------------------------------------------------------
create or replace function public.update_my_profile(p_display_name text, p_bio text)
returns public.customers
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid  uuid := (select auth.uid());
  v_name text := nullif(btrim(regexp_replace(coalesce(p_display_name, ''), '\s+', ' ', 'g')), '');
  v_bio  text := nullif(btrim(regexp_replace(coalesce(p_bio, ''), '\r\n?', E'\n', 'g')), '');
  v_row  public.customers;
begin
  if v_uid is null then
    raise exception 'Not signed in' using errcode = '42501';
  end if;
  if v_name is not null and char_length(v_name) > 60 then
    raise exception 'Name must be 60 characters or fewer' using errcode = '22023';
  end if;
  if v_bio is not null and char_length(v_bio) > 300 then
    raise exception 'Bio must be 300 characters or fewer' using errcode = '22023';
  end if;

  update public.customers
     set display_name = v_name, bio = v_bio, profile_updated_at = now()
   where user_id = v_uid
  returning * into v_row;
  if not found then
    raise exception 'No customer profile for this session' using errcode = '42501';
  end if;
  return v_row;
end;
$$;

create or replace function public.set_my_avatar(p_path text)
returns public.customers
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid      uuid := (select auth.uid());
  v_customer uuid;
  v_object   record;
  v_mime     text;
  v_size     bigint;
  v_ext      text := substring(p_path from '\.([a-z]+)$');
  v_row      public.customers;
begin
  if v_uid is null then
    raise exception 'Not signed in' using errcode = '42501';
  end if;
  select id into v_customer from public.customers where user_id = v_uid;
  if v_customer is null then
    raise exception 'No customer profile for this session' using errcode = '42501';
  end if;
  if p_path is null or private.avatar_customer_id(p_path) is distinct from v_customer then
    raise exception 'Invalid photo path' using errcode = '22023';
  end if;

  select o.owner_id, o.metadata into v_object
  from storage.objects o
  where o.bucket_id = 'profile-photos' and o.name = p_path;
  if not found then
    raise exception 'Photo not uploaded' using errcode = '22023';
  end if;
  if v_object.owner_id is distinct from v_uid::text then
    raise exception 'Photo not uploaded by this customer' using errcode = '42501';
  end if;
  v_mime := lower(split_part(coalesce(v_object.metadata ->> 'mimetype', ''), ';', 1));
  v_size := nullif(v_object.metadata ->> 'size', '')::bigint;
  if v_mime is distinct from (
       case v_ext when 'webp' then 'image/webp' when 'jpg' then 'image/jpeg' when 'png' then 'image/png' end
     ) then
    raise exception 'Photo type does not match its file' using errcode = '22023';
  end if;
  if v_size is null or v_size <= 0 or v_size > 1048576 then
    raise exception 'Photo is too large' using errcode = '22023';
  end if;

  update public.customers
     set avatar_path = p_path, profile_updated_at = now()
   where id = v_customer
  returning * into v_row;
  return v_row;
end;
$$;

create or replace function public.remove_my_avatar()
returns public.customers
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_row public.customers;
begin
  if v_uid is null then
    raise exception 'Not signed in' using errcode = '42501';
  end if;
  update public.customers
     set avatar_path = null, profile_updated_at = now()
   where user_id = v_uid
  returning * into v_row;
  if not found then
    raise exception 'No customer profile for this session' using errcode = '42501';
  end if;
  return v_row;
end;
$$;

revoke all on function public.update_my_profile(text, text) from public, anon, authenticated;
revoke all on function public.set_my_avatar(text)            from public, anon, authenticated;
revoke all on function public.remove_my_avatar()             from public, anon, authenticated;
grant execute on function public.update_my_profile(text, text) to authenticated;
grant execute on function public.set_my_avatar(text)            to authenticated;
grant execute on function public.remove_my_avatar()             to authenticated;

-- Live profile updates for the admin dashboard (RLS still applies per viewer:
-- a guest only ever receives their own row).
alter publication supabase_realtime add table public.customers;

notify pgrst, 'reload schema';
