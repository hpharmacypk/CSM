-- =============================================================================
-- H-Pharmacy Customer Inbox — Web Push for staff replies + Home Screen handoff
--
-- What this adds
--   * private.push_subscriptions: one row per browser/device that opted in.
--     Owned by a customer (derived from the guest session in the RPCs below,
--     never from browser-supplied ids). Not reachable through the Data API.
--   * private.push_jobs: a durable outbox. An AFTER INSERT trigger on
--     public.messages adds one job per subscribed device of that chat, in the
--     SAME transaction as the reply, for every saved HUMAN staff message
--     (sender_role 'admin', author 'human'). Assistant (bot) replies and
--     customer messages never create a job. UNIQUE (message_id,
--     subscription_id) deduplicates. A failure here never blocks the reply.
--   * Guest RPCs (authenticated): push_subscribe, push_unsubscribe,
--     push_subscription_active. Push endpoints are limited to the browser push
--     services (Google FCM, Mozilla, Apple, Microsoft WNS) over HTTPS.
--   * Server RPCs (service_role only): push_claim, push_report, push_status.
--   * Home Screen handoff (iPhone/iPad keep Home Screen web apps' storage apart
--     from Safari): create_guest_handoff issues a one-time 8-character code
--     (20 minutes, single use, stored only as a SHA-256 hash);
--     redeem_guest_handoff moves the chat to the session that enters it
--     (rate limited); guest_handoff_moved lets the old session explain that.
--
-- Nothing is sent until the Next.js server has WEB_PUSH_ENABLED=true and the
-- VAPID keys (see README). Forward-only: no earlier migration is modified.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Tables
-- -----------------------------------------------------------------------------
create table private.push_subscriptions (
  id              uuid primary key default gen_random_uuid(),
  customer_id     uuid not null references public.customers (id) on delete cascade,
  -- The guest session that registered it (its rows are removed if the chat
  -- later moves to another session through the handoff).
  user_id         uuid references auth.users (id) on delete set null,
  endpoint        text not null unique,
  p256dh          text not null,
  auth_secret     text not null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  last_success_at timestamptz
);
create index push_subscriptions_customer_idx on private.push_subscriptions (customer_id);
revoke all on table private.push_subscriptions from public, anon, authenticated;
alter table private.push_subscriptions enable row level security;

create table private.push_jobs (
  id              bigint generated always as identity primary key,
  message_id      uuid not null references public.messages (id) on delete cascade,
  subscription_id uuid not null references private.push_subscriptions (id) on delete cascade,
  status          text not null default 'pending' check (status in
                    ('pending', 'sending', 'sent', 'failed', 'expired', 'cancelled')),
  attempts        integer not null default 0,
  next_attempt_at timestamptz not null default now(),
  lease_until     timestamptz,
  last_attempt_at timestamptz,
  sent_at         timestamptz,
  last_error      text,
  created_at      timestamptz not null default now(),
  constraint push_jobs_once unique (message_id, subscription_id)
);
create index push_jobs_open_idx on private.push_jobs (next_attempt_at)
  where status in ('pending', 'sending');
create index push_jobs_subscription_idx on private.push_jobs (subscription_id);
revoke all on table private.push_jobs from public, anon, authenticated;
alter table private.push_jobs enable row level security;

create table private.guest_handoffs (
  code_hash    bytea primary key,
  customer_id  uuid not null references public.customers (id) on delete cascade,
  from_user_id uuid not null,
  created_at   timestamptz not null default now(),
  expires_at   timestamptz not null,
  redeemed_at  timestamptz,
  redeemed_by  uuid
);
create index guest_handoffs_customer_idx on private.guest_handoffs (customer_id);
create index guest_handoffs_from_user_idx on private.guest_handoffs (from_user_id);
revoke all on table private.guest_handoffs from public, anon, authenticated;
alter table private.guest_handoffs enable row level security;

create table private.guest_handoff_failures (
  id      bigint generated always as identity primary key,
  user_id uuid not null,
  at      timestamptz not null default now()
);
create index guest_handoff_failures_idx on private.guest_handoff_failures (user_id, at);
create index guest_handoff_failures_at_idx on private.guest_handoff_failures (at);
revoke all on table private.guest_handoff_failures from public, anon, authenticated;
alter table private.guest_handoff_failures enable row level security;

-- -----------------------------------------------------------------------------
-- Helpers
-- -----------------------------------------------------------------------------
-- The caller's own customer row (guest sessions only; admins have none).
create or replace function private.my_customer_id()
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select cu.id from public.customers cu
  where (select auth.uid()) is not null and cu.user_id = (select auth.uid());
$$;
revoke all on function private.my_customer_id() from public, anon, authenticated;

-- Browser push services only, HTTPS on the default port, no user info. The
-- server checks the same list (and resolves the host) before every send.
create or replace function private.push_endpoint_allowed(p_endpoint text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select coalesce(char_length(p_endpoint) <= 1024
    and p_endpoint ~ ('^https://('
        || 'fcm\.googleapis\.com'
        || '|updates\.push\.services\.mozilla\.com'
        || '|push\.services\.mozilla\.com'
        || '|web\.push\.apple\.com'
        || '|[a-z0-9-]{1,63}\.push\.apple\.com'
        || '|[a-z0-9-]{1,63}\.notify\.windows\.com'
        || ')/[!-~]+$'), false);
$$;
revoke all on function private.push_endpoint_allowed(text) from public, anon, authenticated;

-- Decodes a base64url value (null if it is not valid base64url).
create or replace function private.b64url_bytes(p_value text)
returns bytea
language plpgsql
immutable
set search_path = ''
as $$
declare
  v text := rtrim(coalesce(p_value, ''), '=');
begin
  if v !~ '^[A-Za-z0-9_-]{1,200}$' then
    return null;
  end if;
  v := translate(v, '-_', '+/');
  return decode(rpad(v, ((char_length(v) + 3) / 4) * 4, '='), 'base64');
exception when others then
  return null;
end;
$$;
revoke all on function private.b64url_bytes(text) from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- Capture: one job per subscribed device for every saved human staff reply
-- -----------------------------------------------------------------------------
create or replace function private.enqueue_push_jobs()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.sender_role <> 'admin' or new.author <> 'human' or new.deleted_at is not null then
    return null;
  end if;
  begin
    insert into private.push_jobs (message_id, subscription_id)
    select new.id, s.id
    from public.conversations c
    join private.push_subscriptions s on s.customer_id = c.customer_id
    where c.id = new.conversation_id
    on conflict (message_id, subscription_id) do nothing;
  exception when others then
    -- A notification problem must never stop the reply from being saved.
    raise warning 'push job enqueue failed: %', sqlstate;
  end;
  return null;
end;
$$;
revoke all on function private.enqueue_push_jobs() from public, anon, authenticated;

create trigger messages_enqueue_push_jobs
  after insert on public.messages
  for each row execute function private.enqueue_push_jobs();

-- -----------------------------------------------------------------------------
-- Guest RPCs (ownership always from the session)
-- -----------------------------------------------------------------------------
create or replace function public.push_subscribe(
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
  v_uid      uuid := (select auth.uid());
  v_customer uuid := private.my_customer_id();
  v_key      bytea := private.b64url_bytes(p_p256dh);
  v_secret   bytea := private.b64url_bytes(p_auth);
begin
  if v_uid is null or v_customer is null then
    raise exception 'Open your chat first' using errcode = '42501';
  end if;
  if not private.push_endpoint_allowed(p_endpoint) then
    raise exception 'This browser''s push service is not supported' using errcode = '22023';
  end if;
  if v_key is null or length(v_key) <> 65 or get_byte(v_key, 0) <> 4
     or v_secret is null or length(v_secret) <> 16 then
    raise exception 'Invalid push subscription keys' using errcode = '22023';
  end if;

  -- The same browser may have belonged to another guest chat before: the
  -- newest guest session on this browser owns its endpoint.
  insert into private.push_subscriptions (customer_id, user_id, endpoint, p256dh, auth_secret)
  values (v_customer, v_uid, p_endpoint, rtrim(p_p256dh, '='), rtrim(p_auth, '='))
  on conflict (endpoint) do update
    set customer_id = excluded.customer_id,
        user_id     = excluded.user_id,
        p256dh      = excluded.p256dh,
        auth_secret = excluded.auth_secret,
        updated_at  = now();

  -- At most 10 devices per chat: drop the oldest beyond that.
  delete from private.push_subscriptions s
  where s.customer_id = v_customer
    and s.id not in (select s2.id from private.push_subscriptions s2
                     where s2.customer_id = v_customer
                     order by s2.updated_at desc limit 10);
  return true;
end;
$$;

create or replace function public.push_unsubscribe(p_endpoint text)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_customer uuid := private.my_customer_id();
  v_count    integer;
begin
  if v_customer is null then
    return false;
  end if;
  delete from private.push_subscriptions
  where endpoint = p_endpoint and customer_id = v_customer;
  get diagnostics v_count = row_count;
  return v_count > 0;
end;
$$;

create or replace function public.push_subscription_active(p_endpoint text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from private.push_subscriptions s
    where s.endpoint = p_endpoint
      and s.customer_id = private.my_customer_id()
  );
$$;

revoke all on function public.push_subscribe(text, text, text) from public, anon, authenticated;
revoke all on function public.push_unsubscribe(text) from public, anon, authenticated;
revoke all on function public.push_subscription_active(text) from public, anon, authenticated;
grant execute on function public.push_subscribe(text, text, text) to authenticated;
grant execute on function public.push_unsubscribe(text) to authenticated;
grant execute on function public.push_subscription_active(text) to authenticated;

-- -----------------------------------------------------------------------------
-- Server RPCs (service_role only)
-- -----------------------------------------------------------------------------
-- Hands out due jobs with a 60-second lease. A job whose reply was deleted, or
-- whose device now belongs to another chat, is cancelled instead. Jobs not
-- sent within 6 hours expire (a late "new reply" is no longer useful).
create or replace function public.push_claim(p_limit integer default 20)
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
  update private.push_jobs j
     set status = 'expired', lease_until = null
   where (j.status = 'pending' or (j.status = 'sending' and j.lease_until < now()))
     and j.created_at < now() - interval '6 hours';

  for r in
    select j.id, s.endpoint as s_endpoint, s.p256dh as s_p256dh, s.auth_secret as s_auth,
           (m.deleted_at is not null or s.customer_id <> c.customer_id) as stale
    from private.push_jobs j
    join private.push_subscriptions s on s.id = j.subscription_id
    join public.messages m on m.id = j.message_id
    join public.conversations c on c.id = m.conversation_id
    where (j.status = 'pending' or (j.status = 'sending' and j.lease_until < now()))
      and j.next_attempt_at <= now()
    order by j.id
    limit v_limit
    for update of j skip locked
  loop
    if r.stale then
      update private.push_jobs set status = 'cancelled', lease_until = null where id = r.id;
      continue;
    end if;
    update private.push_jobs
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

-- Records one send attempt. p_attempt must match the claim, so a slow worker
-- never overwrites a newer attempt.
--   sent   -> status 'sent'
--   gone   -> the push service says the subscription no longer exists:
--             the subscription (and its jobs) are deleted
--   retry  -> back to 'pending' with backoff; 'failed' after 6 attempts
--   failed -> permanent failure for this job
create or replace function public.push_report(
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
  v_job     private.push_jobs;
  v_backoff constant integer[] := array[15, 60, 180, 600, 1800];
  v_max     constant integer := 6;
begin
  select * into v_job from private.push_jobs
  where id = p_job_id and status = 'sending' and attempts = p_attempt
  for update;
  if not found then
    return coalesce((select status from private.push_jobs where id = p_job_id), 'missing');
  end if;

  if p_result = 'sent' then
    update private.push_jobs
       set status = 'sent', sent_at = now(), lease_until = null, last_error = null
     where id = p_job_id;
    update private.push_subscriptions set last_success_at = now() where id = v_job.subscription_id;
    return 'sent';
  elsif p_result = 'gone' then
    delete from private.push_subscriptions where id = v_job.subscription_id;
    return 'gone';
  elsif p_result = 'failed' then
    update private.push_jobs
       set status = 'failed', lease_until = null, last_error = left(coalesce(p_error, 'failed'), 200)
     where id = p_job_id;
    return 'failed';
  else
    update private.push_jobs
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

-- Counts only (for the authenticated dispatch endpoint; no endpoints, no content).
create or replace function public.push_status()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'subscriptions', (select count(*) from private.push_subscriptions),
    'jobs', coalesce((select jsonb_object_agg(status, n)
                      from (select status, count(*) n from private.push_jobs group by status) s), '{}'::jsonb)
  );
$$;

revoke all on function public.push_claim(integer) from public, anon, authenticated;
revoke all on function public.push_report(bigint, integer, text, text) from public, anon, authenticated;
revoke all on function public.push_status() from public, anon, authenticated;
grant execute on function public.push_claim(integer) to service_role;
grant execute on function public.push_report(bigint, integer, text, text) to service_role;
grant execute on function public.push_status() to service_role;

-- -----------------------------------------------------------------------------
-- Home Screen handoff
-- -----------------------------------------------------------------------------
create or replace function private.handoff_hash(p_code text)
returns bytea
language sql
immutable
set search_path = ''
as $$
  select sha256(convert_to('hp-handoff:' || p_code, 'UTF8'));
$$;
revoke all on function private.handoff_hash(text) from public, anon, authenticated;

-- Issues a new code for the caller's chat (any earlier unused code stops working).
create or replace function public.create_guest_handoff()
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid      uuid := (select auth.uid());
  v_customer uuid := private.my_customer_id();
  alphabet   constant text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; -- 32 symbols
  bytes      bytea;
  v_code     text := '';
  v_expires  timestamptz := now() + interval '20 minutes';
begin
  if v_uid is null or v_customer is null
     or coalesce(((select auth.jwt()) ->> 'is_anonymous')::boolean, false) = false then
    raise exception 'Open your chat first' using errcode = '42501';
  end if;

  delete from private.guest_handoffs
  where (customer_id = v_customer and redeemed_at is null)
     or expires_at < now() - interval '1 day';

  bytes := extensions.gen_random_bytes(8);
  for i in 0..7 loop
    v_code := v_code || substr(alphabet, (get_byte(bytes, i) % 32) + 1, 1);
  end loop;

  insert into private.guest_handoffs (code_hash, customer_id, from_user_id, expires_at)
  values (private.handoff_hash(v_code), v_customer, v_uid, v_expires);

  return jsonb_build_object('code', substr(v_code, 1, 4) || '-' || substr(v_code, 5, 4),
                            'expires_at', v_expires);
end;
$$;

-- Moves the chat to the calling (new, empty) guest session. Returns a status
-- object instead of raising so failed attempts are recorded for rate limiting.
create or replace function public.redeem_guest_handoff(p_code text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid      uuid := (select auth.uid());
  v_code     text := upper(regexp_replace(coalesce(p_code, ''), '[^A-Za-z0-9]', '', 'g'));
  v_handoff  private.guest_handoffs;
  v_own      uuid;
  v_conv     uuid;
begin
  if v_uid is null
     or coalesce(((select auth.jwt()) ->> 'is_anonymous')::boolean, false) = false then
    raise exception 'Not signed in' using errcode = '42501';
  end if;

  if (select count(*) from private.guest_handoff_failures f
      where f.user_id = v_uid and f.at > now() - interval '15 minutes') >= 5
     or (select count(*) from private.guest_handoff_failures f
         where f.at > now() - interval '1 minute') >= 100 then
    return jsonb_build_object('ok', false, 'reason', 'rate_limited');
  end if;

  if char_length(v_code) = 8 then
    select * into v_handoff from private.guest_handoffs h
    where h.code_hash = private.handoff_hash(v_code)
      and h.redeemed_at is null
      and h.expires_at > now()
    for update;
  end if;

  if v_handoff.code_hash is null then
    insert into private.guest_handoff_failures (user_id) values (v_uid);
    delete from private.guest_handoff_failures where at < now() - interval '1 day';
    return jsonb_build_object('ok', false, 'reason', 'invalid');
  end if;

  -- This session may already have opened an empty chat: replace it. A chat
  -- with messages is never thrown away.
  v_own := private.my_customer_id();
  if v_own is not null and v_own <> v_handoff.customer_id then
    if exists (select 1 from public.messages m
               join public.conversations c on c.id = m.conversation_id
               where c.customer_id = v_own) then
      return jsonb_build_object('ok', false, 'reason', 'has_chat');
    end if;
    delete from public.customers where id = v_own;
  end if;

  if v_own is distinct from v_handoff.customer_id then
    update public.customers set user_id = v_uid
    where id = v_handoff.customer_id and user_id = v_handoff.from_user_id;
    if not found then
      insert into private.guest_handoff_failures (user_id) values (v_uid);
      return jsonb_build_object('ok', false, 'reason', 'invalid');
    end if;
    -- "Delete for me" choices follow the chat.
    update public.message_hidden set user_id = v_uid where user_id = v_handoff.from_user_id;
    -- The old browser no longer opens this chat: stop notifying it.
    delete from private.push_subscriptions
    where customer_id = v_handoff.customer_id and user_id = v_handoff.from_user_id;
  end if;

  update private.guest_handoffs
     set redeemed_at = now(), redeemed_by = v_uid
   where code_hash = v_handoff.code_hash;

  select id into v_conv from public.conversations where customer_id = v_handoff.customer_id;
  return jsonb_build_object('ok', true, 'conversation_id', v_conv);
end;
$$;

-- True when this session's chat was moved to another session (Home Screen app).
create or replace function public.guest_handoff_moved()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select private.my_customer_id() is null and exists (
    select 1 from private.guest_handoffs h
    where h.from_user_id = (select auth.uid()) and h.redeemed_at is not null
  );
$$;

revoke all on function public.create_guest_handoff() from public, anon, authenticated;
revoke all on function public.redeem_guest_handoff(text) from public, anon, authenticated;
revoke all on function public.guest_handoff_moved() from public, anon, authenticated;
grant execute on function public.create_guest_handoff() to authenticated;
grant execute on function public.redeem_guest_handoff(text) to authenticated;
grant execute on function public.guest_handoff_moved() to authenticated;
