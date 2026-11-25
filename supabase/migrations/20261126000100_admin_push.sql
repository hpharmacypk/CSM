-- =============================================================================
-- H-Pharmacy Customer Inbox — Web Push for ADMINS (new customer messages)
--
-- Reuses the browser push setup of 20261125000100_web_push.sql (same service
-- worker, VAPID keys and endpoint rules), with its own tables so customer and
-- staff subscriptions never mix:
--   * private.admin_push_subscriptions: one row per staff device, owned by the
--     signed-in admin (auth.uid()); registration requires private.is_admin().
--   * private.admin_push_jobs: an AFTER INSERT trigger on public.messages adds
--     one job per subscribed admin device for every new customer message
--     (text, photo, voice note, location; not option clicks / delivery forms),
--     in the message's own transaction. Staff replies and assistant (bot)
--     replies never create a job. UNIQUE (message_id, subscription_id).
--   * Delivery re-checks that the owner is still an admin; devices of removed
--     admins are deleted. Every admin may open every chat, so "authorized to
--     view that conversation" = listed in private.admins.
--   * Shared devices: admin_push_unsubscribe (called before sign-out) and
--     admin_push_release_device (a different admin signs in on the same
--     browser) stop notifications for the previous admin.
--
-- Forward-only. Requires 20261125000100_web_push.sql (endpoint/key helpers).
-- =============================================================================

create table private.admin_push_subscriptions (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references auth.users (id) on delete cascade,
  endpoint        text not null unique,
  p256dh          text not null,
  auth_secret     text not null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  last_success_at timestamptz
);
create index admin_push_subscriptions_user_idx on private.admin_push_subscriptions (user_id);
revoke all on table private.admin_push_subscriptions from public, anon, authenticated;
alter table private.admin_push_subscriptions enable row level security;

create table private.admin_push_jobs (
  id              bigint generated always as identity primary key,
  message_id      uuid not null references public.messages (id) on delete cascade,
  subscription_id uuid not null references private.admin_push_subscriptions (id) on delete cascade,
  status          text not null default 'pending' check (status in
                    ('pending', 'sending', 'sent', 'failed', 'expired', 'cancelled')),
  attempts        integer not null default 0,
  next_attempt_at timestamptz not null default now(),
  lease_until     timestamptz,
  last_attempt_at timestamptz,
  sent_at         timestamptz,
  last_error      text,
  created_at      timestamptz not null default now(),
  constraint admin_push_jobs_once unique (message_id, subscription_id)
);
create index admin_push_jobs_open_idx on private.admin_push_jobs (next_attempt_at)
  where status in ('pending', 'sending');
create index admin_push_jobs_subscription_idx on private.admin_push_jobs (subscription_id);
revoke all on table private.admin_push_jobs from public, anon, authenticated;
alter table private.admin_push_jobs enable row level security;

-- -----------------------------------------------------------------------------
-- Capture: one job per admin device for every new customer message
-- -----------------------------------------------------------------------------
create or replace function private.enqueue_admin_push_jobs()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.sender_role <> 'customer' or new.author <> 'human'
     or new.agent_action_id is not null or new.deleted_at is not null then
    return null;
  end if;
  begin
    insert into private.admin_push_jobs (message_id, subscription_id)
    select new.id, s.id
    from private.admin_push_subscriptions s
    join private.admins a on a.user_id = s.user_id
    on conflict (message_id, subscription_id) do nothing;
  exception when others then
    -- A notification problem must never stop the message from being saved.
    raise warning 'admin push job enqueue failed: %', sqlstate;
  end;
  return null;
end;
$$;
revoke all on function private.enqueue_admin_push_jobs() from public, anon, authenticated;

create trigger messages_enqueue_admin_push_jobs
  after insert on public.messages
  for each row execute function private.enqueue_admin_push_jobs();

-- -----------------------------------------------------------------------------
-- Admin RPCs (ownership from the signed-in admin session)
-- -----------------------------------------------------------------------------
create or replace function public.admin_push_subscribe(
  p_endpoint text,
  p_p256dh   text,
  p_auth     text
)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid    uuid := (select auth.uid());
  v_key    bytea := private.b64url_bytes(p_p256dh);
  v_secret bytea := private.b64url_bytes(p_auth);
begin
  if v_uid is null or not private.is_admin() then
    raise exception 'Admins only' using errcode = '42501';
  end if;
  if not private.push_endpoint_allowed(p_endpoint) then
    raise exception 'This browser''s push service is not supported' using errcode = '22023';
  end if;
  if v_key is null or length(v_key) <> 65 or get_byte(v_key, 0) <> 4
     or v_secret is null or length(v_secret) <> 16 then
    raise exception 'Invalid push subscription keys' using errcode = '22023';
  end if;

  -- A device belongs to the admin who registered it last.
  insert into private.admin_push_subscriptions (user_id, endpoint, p256dh, auth_secret)
  values (v_uid, p_endpoint, rtrim(p_p256dh, '='), rtrim(p_auth, '='))
  on conflict (endpoint) do update
    set user_id     = excluded.user_id,
        p256dh      = excluded.p256dh,
        auth_secret = excluded.auth_secret,
        updated_at  = now();

  delete from private.admin_push_subscriptions s
  where s.user_id = v_uid
    and s.id not in (select s2.id from private.admin_push_subscriptions s2
                     where s2.user_id = v_uid order by s2.updated_at desc limit 10);
  return true;
end;
$$;

-- Removes the caller's own registration of this device (sign-out, "Turn off").
-- Works for any signed-in user, so a former admin can still clean up.
create or replace function public.admin_push_unsubscribe(p_endpoint text)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  if (select auth.uid()) is null then
    return false;
  end if;
  delete from private.admin_push_subscriptions
  where endpoint = p_endpoint and user_id = (select auth.uid());
  get diagnostics v_count = row_count;
  return v_count > 0;
end;
$$;

-- 'mine' | 'other' | 'none' for this device (endpoint), for the signed-in admin.
create or replace function public.admin_push_device_state(p_endpoint text)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when not private.is_admin() then 'none'
    else coalesce((select case when s.user_id = (select auth.uid()) then 'mine' else 'other' end
                   from private.admin_push_subscriptions s where s.endpoint = p_endpoint), 'none')
  end;
$$;

-- A different admin signed in on this device: stop the previous admin's
-- notifications here. Needs the endpoint, which only this browser has.
create or replace function public.admin_push_release_device(p_endpoint text)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  if not private.is_admin() then
    return false;
  end if;
  delete from private.admin_push_subscriptions
  where endpoint = p_endpoint and user_id <> (select auth.uid());
  get diagnostics v_count = row_count;
  return v_count > 0;
end;
$$;

revoke all on function public.admin_push_subscribe(text, text, text) from public, anon, authenticated;
revoke all on function public.admin_push_unsubscribe(text) from public, anon, authenticated;
revoke all on function public.admin_push_device_state(text) from public, anon, authenticated;
revoke all on function public.admin_push_release_device(text) from public, anon, authenticated;
grant execute on function public.admin_push_subscribe(text, text, text) to authenticated;
grant execute on function public.admin_push_unsubscribe(text) to authenticated;
grant execute on function public.admin_push_device_state(text) to authenticated;
grant execute on function public.admin_push_release_device(text) to authenticated;

-- -----------------------------------------------------------------------------
-- Server RPCs (service_role only), same lease/retry rules as push_claim/report
-- -----------------------------------------------------------------------------
create or replace function public.admin_push_claim(p_limit integer default 20)
returns table (job_id bigint, attempt integer, endpoint text, p256dh text, auth_secret text)
language plpgsql
volatile
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  r       record;
  v_limit integer := greatest(1, least(coalesce(p_limit, 20), 100));
  v_try   integer;
begin
  -- Devices of people who are no longer admins never get another notification.
  delete from private.admin_push_subscriptions s
  where not exists (select 1 from private.admins a where a.user_id = s.user_id);

  update private.admin_push_jobs j
     set status = 'expired', lease_until = null
   where (j.status = 'pending' or (j.status = 'sending' and j.lease_until < now()))
     and j.created_at < now() - interval '6 hours';

  for r in
    select j.id, s.endpoint as s_endpoint, s.p256dh as s_p256dh, s.auth_secret as s_auth,
           (m.deleted_at is not null) as stale
    from private.admin_push_jobs j
    join private.admin_push_subscriptions s on s.id = j.subscription_id
    join public.messages m on m.id = j.message_id
    where (j.status = 'pending' or (j.status = 'sending' and j.lease_until < now()))
      and j.next_attempt_at <= now()
    order by j.id
    limit v_limit
    for update of j skip locked
  loop
    if r.stale then
      update private.admin_push_jobs set status = 'cancelled', lease_until = null where id = r.id;
      continue;
    end if;
    update private.admin_push_jobs
       set status = 'sending',
           attempts = attempts + 1,
           lease_until = now() + interval '60 seconds',
           last_attempt_at = now()
     where id = r.id
     returning attempts into v_try;
    job_id := r.id;
    attempt := v_try;
    endpoint := r.s_endpoint;
    p256dh := r.s_p256dh;
    auth_secret := r.s_auth;
    return next;
  end loop;
end;
$$;

create or replace function public.admin_push_report(
  p_job_id  bigint,
  p_attempt integer,
  p_result  text,
  p_error   text default null
)
returns text
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_job     private.admin_push_jobs;
  v_backoff constant integer[] := array[15, 60, 180, 600, 1800];
  v_max     constant integer := 6;
begin
  select * into v_job from private.admin_push_jobs
  where id = p_job_id and status = 'sending' and attempts = p_attempt
  for update;
  if not found then
    return coalesce((select status from private.admin_push_jobs where id = p_job_id), 'missing');
  end if;

  if p_result = 'sent' then
    update private.admin_push_jobs
       set status = 'sent', sent_at = now(), lease_until = null, last_error = null
     where id = p_job_id;
    update private.admin_push_subscriptions set last_success_at = now() where id = v_job.subscription_id;
    return 'sent';
  elsif p_result = 'gone' then
    delete from private.admin_push_subscriptions where id = v_job.subscription_id;
    return 'gone';
  elsif p_result = 'failed' then
    update private.admin_push_jobs
       set status = 'failed', lease_until = null, last_error = left(coalesce(p_error, 'failed'), 200)
     where id = p_job_id;
    return 'failed';
  else
    update private.admin_push_jobs
       set status = case when attempts >= v_max then 'failed' else 'pending' end,
           next_attempt_at = now() + make_interval(secs => v_backoff[least(attempts, array_length(v_backoff, 1))]),
           lease_until = null,
           last_error = left(coalesce(p_error, 'unknown error'), 200)
     where id = p_job_id
     returning status into v_job.status;
    return v_job.status;
  end if;
end;
$$;

create or replace function public.admin_push_status()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'subscriptions', (select count(*) from private.admin_push_subscriptions),
    'jobs', coalesce((select jsonb_object_agg(status, n)
                      from (select status, count(*) n from private.admin_push_jobs group by status) s), '{}'::jsonb)
  );
$$;

revoke all on function public.admin_push_claim(integer) from public, anon, authenticated;
revoke all on function public.admin_push_report(bigint, integer, text, text) from public, anon, authenticated;
revoke all on function public.admin_push_status() from public, anon, authenticated;
grant execute on function public.admin_push_claim(integer) to service_role;
grant execute on function public.admin_push_report(bigint, integer, text, text) to service_role;
grant execute on function public.admin_push_status() to service_role;
