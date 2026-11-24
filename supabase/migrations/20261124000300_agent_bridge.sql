-- =============================================================================
-- H-Pharmacy Customer Inbox — Order-agent bridge (Phase 3, Inbox side)
--
-- What this adds
--   * A durable outbox, private.agent_events. An AFTER INSERT trigger on
--     public.messages writes one event in the SAME transaction as the message
--     it describes, for every existing send path:
--       customer text (1–1000 chars, not forwarded)  -> customer.message
--       customer option click (submit_agent_action) -> customer.action
--       customer delivery form (submit_agent_delivery_form)
--                                                   -> customer.delivery_form
--       any saved HUMAN admin message (any type)    -> admin.message
--     Images, voice notes, locations and customer text over 1000 characters
--     stay in staff chat and create no event. Assistant messages never do.
--   * Assistant replies are stored as messages with sender_role 'admin' (so
--     unread counts, Realtime and access rules work as before) and
--     author = 'assistant' (so they are never mistaken for a human reply).
--     messages.agent_actions holds the buttons / list / delivery form the
--     workflow offered with that reply (structured data, no customer details).
--   * Delivery details live in private.agent_form_submissions (never exposed
--     through the Data API). The chat only shows "Delivery details submitted".
--     The stored values are cleared once the event is finished.
--   * Handoff status for the admin UI: conversations.agent_handoff_state.
--     private.agent_conversation_state remembers which event last set it, so a
--     stale callback never overwrites a newer state.
--   * Server-only functions (EXECUTE granted to service_role only) used by the
--     Next.js server: agent_bridge_claim / agent_bridge_report (dispatcher) and
--     agent_bridge_apply_callback (callback route), agent_bridge_status.
--
-- Disabled by default
--   Nothing is captured until the project owner runs, in the SQL editor:
--     update private.agent_bridge_settings set enabled = true;
--   The Next.js server also needs AGENT_BRIDGE_ENABLED=true (see README).
--
-- Forward-only: no earlier migration is modified.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Switch (singleton row; changed only from the SQL editor)
-- -----------------------------------------------------------------------------
create table private.agent_bridge_settings (
  id         boolean primary key default true check (id),
  enabled    boolean not null default false,
  updated_at timestamptz not null default now()
);
insert into private.agent_bridge_settings (id, enabled) values (true, false);
revoke all on table private.agent_bridge_settings from public, anon, authenticated;
alter table private.agent_bridge_settings enable row level security;

create or replace function private.agent_bridge_enabled()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((select s.enabled from private.agent_bridge_settings s where s.id), false);
$$;
revoke all on function private.agent_bridge_enabled() from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- Columns
-- -----------------------------------------------------------------------------
alter table public.messages
  add column author text not null default 'human'
    check (author in ('human', 'assistant')),
  -- Assistant replies only: what the workflow offered (inbox-agent-reply-v1 actions).
  add column agent_actions jsonb,
  -- Customer option clicks / form submissions only: the assistant message answered.
  add column agent_offer_message_id uuid,
  add column agent_action_id text;

alter table public.messages add constraint messages_assistant_shape check (
  author = 'human'
  or (sender_role = 'admin' and sender_user_id is null and type = 'text' and forwarded = false)
);
alter table public.messages add constraint messages_agent_actions_owner check (
  agent_actions is null or (author = 'assistant' and jsonb_typeof(agent_actions) = 'object')
);
alter table public.messages add constraint messages_agent_input_shape check (
  (agent_offer_message_id is null) = (agent_action_id is null)
  and (agent_action_id is null
       or (sender_role = 'customer' and type = 'text' and forwarded = false
           and char_length(agent_action_id) between 1 and 200))
);

-- The Agent's text is stored unchanged; allow longer assistant replies.
alter table public.messages drop constraint messages_text_body;
alter table public.messages add constraint messages_text_body check (
  deleted_at is not null
  or type <> 'text'
  or (body is not null
      and char_length(btrim(body)) between 1 and (case when author = 'assistant' then 8000 else 4000 end))
);

-- One accepted click / form per offer (double clicks and second tabs).
create unique index messages_agent_offer_once
  on public.messages (agent_offer_message_id)
  where agent_offer_message_id is not null;

alter table public.conversations
  add column agent_handoff_state      text
    check (agent_handoff_state is null or agent_handoff_state ~ '^[a-z_]{1,40}$'),
  add column agent_handoff_updated_at timestamptz;

-- -----------------------------------------------------------------------------
-- Private tables
-- -----------------------------------------------------------------------------
create table private.agent_events (
  seq             bigint generated always as identity primary key,
  event_id        uuid not null unique default gen_random_uuid(),
  event_type      text not null check (event_type in
                    ('customer.message', 'customer.action', 'customer.delivery_form', 'admin.message')),
  conversation_id uuid not null references public.conversations (id) on delete cascade,
  message_id      uuid not null unique references public.messages (id) on delete cascade,
  status          text not null default 'pending' check (status in
                    ('pending', 'dispatching', 'sent', 'completed', 'failed', 'expired', 'cancelled')),
  attempts        integer not null default 0,
  next_attempt_at timestamptz not null default now(),
  lease_until     timestamptz,
  last_attempt_at timestamptz,
  sent_at         timestamptz,
  completed_at    timestamptz,
  outcome         text,
  last_error      text,
  created_at      timestamptz not null default now()
);
create index agent_events_conversation_idx on private.agent_events (conversation_id, seq);
create index agent_events_open_idx on private.agent_events (next_attempt_at)
  where status in ('pending', 'dispatching');
revoke all on table private.agent_events from public, anon, authenticated;
alter table private.agent_events enable row level security;

create table private.agent_form_submissions (
  message_id       uuid primary key references public.messages (id) on delete cascade,
  conversation_id  uuid not null references public.conversations (id) on delete cascade,
  offer_message_id uuid not null,
  -- Cleared (null) once the event is finished; never readable by browsers.
  form             jsonb,
  created_at       timestamptz not null default now()
);
revoke all on table private.agent_form_submissions from public, anon, authenticated;
alter table private.agent_form_submissions enable row level security;

create table private.agent_conversation_state (
  conversation_id       uuid primary key references public.conversations (id) on delete cascade,
  handoff_event_seq     bigint not null default 0,
  bot_reply_permitted   boolean,
  handoff_source        text,
  last_reply_event_seq  bigint not null default 0,
  updated_at            timestamptz not null default now()
);
revoke all on table private.agent_conversation_state from public, anon, authenticated;
alter table private.agent_conversation_state enable row level security;

-- -----------------------------------------------------------------------------
-- Capture: one event per eligible message, in the message's own transaction
-- -----------------------------------------------------------------------------
create or replace function private.enqueue_agent_event()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_type text;
begin
  if new.author <> 'human' or not private.agent_bridge_enabled() then
    return null;
  end if;

  if new.sender_role = 'customer' then
    if new.agent_action_id is not null then
      v_type := case when new.agent_action_id = 'hp1:delivery'
                     then 'customer.delivery_form' else 'customer.action' end;
    elsif new.type = 'text' and not new.forwarded and new.deleted_at is null
          and char_length(btrim(coalesce(new.body, ''))) between 1 and 1000 then
      v_type := 'customer.message';
    end if;
  elsif new.sender_role = 'admin' then
    -- Any saved human staff message (text, photo, voice, location, forward).
    v_type := 'admin.message';
  end if;

  if v_type is not null then
    insert into private.agent_events (event_type, conversation_id, message_id)
    values (v_type, new.conversation_id, new.id)
    on conflict (message_id) do nothing;
  end if;
  return null;
end;
$$;
revoke all on function private.enqueue_agent_event() from public, anon, authenticated;

create trigger messages_enqueue_agent_event
  after insert on public.messages
  for each row execute function private.enqueue_agent_event();

-- -----------------------------------------------------------------------------
-- Offers: the newest assistant message with actions, not yet answered and not
-- followed by any newer admin-side message (assistant or human).
-- -----------------------------------------------------------------------------
create or replace function private.agent_offer_is_current(p_offer_message_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.messages o
    where o.id = p_offer_message_id
      and o.author = 'assistant'
      and o.deleted_at is null
      and o.agent_actions is not null
      and not exists (
        select 1 from public.messages n
        where n.conversation_id = o.conversation_id
          and n.seq > o.seq
          and n.sender_role = 'admin'
      )
      and not exists (
        select 1 from public.messages c where c.agent_offer_message_id = o.id
      )
  );
$$;
revoke all on function private.agent_offer_is_current(uuid) from public, anon, authenticated;

-- Shared checks for both customer submissions. Returns the locked offer row.
create or replace function private.agent_lock_offer(p_offer_message_id uuid)
returns public.messages
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_offer public.messages;
begin
  if (select auth.uid()) is null then
    raise exception 'Not signed in' using errcode = '42501';
  end if;
  select * into v_offer from public.messages where id = p_offer_message_id;
  if not found or v_offer.author <> 'assistant'
     or not private.owns_conversation(v_offer.conversation_id) then
    raise exception 'This option is no longer available' using errcode = '42501';
  end if;
  -- Same per-conversation lock as every send.
  perform 1 from public.conversations where id = v_offer.conversation_id for update;
  return v_offer;
end;
$$;
revoke all on function private.agent_lock_offer(uuid) from public, anon, authenticated;

create or replace function private.agent_record_customer_input(
  p_conversation_id   uuid,
  p_body              text,
  p_client_message_id uuid,
  p_offer_message_id  uuid,
  p_action_id         text
)
returns public.messages
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_msg public.messages;
begin
  insert into public.messages
    (conversation_id, sender_role, sender_user_id, type, body, client_message_id,
     agent_offer_message_id, agent_action_id)
  values
    (p_conversation_id, 'customer', (select auth.uid()), 'text', p_body, p_client_message_id,
     p_offer_message_id, p_action_id)
  returning * into v_msg;

  update public.conversations c set
    last_message_at      = v_msg.created_at,
    last_message_preview = left(v_msg.body, 140),
    last_message_sender  = 'customer',
    last_message_seq     = v_msg.seq,
    admin_unread_count   = c.admin_unread_count + 1
  where c.id = p_conversation_id;
  return v_msg;
end;
$$;
revoke all on function private.agent_record_customer_input(uuid, text, uuid, uuid, text)
  from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- RPC (guest): click one option the assistant offered
-- -----------------------------------------------------------------------------
create or replace function public.submit_agent_action(
  p_offer_message_id  uuid,
  p_action_id         text,
  p_client_message_id uuid
)
returns public.messages
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_offer  public.messages;
  v_msg    public.messages;
  v_choice jsonb;
begin
  if p_offer_message_id is null or p_action_id is null or p_client_message_id is null then
    raise exception 'Missing option or message id' using errcode = '22023';
  end if;
  v_offer := private.agent_lock_offer(p_offer_message_id);

  -- Idempotent retry: same client id returns the original row.
  select * into v_msg from public.messages
  where conversation_id = v_offer.conversation_id and client_message_id = p_client_message_id;
  if found then
    if v_msg.sender_user_id is distinct from (select auth.uid())
       or v_msg.agent_offer_message_id is distinct from p_offer_message_id
       or v_msg.agent_action_id is distinct from p_action_id then
      raise exception 'Duplicate message id' using errcode = '23505';
    end if;
    return v_msg;
  end if;

  if not private.agent_bridge_enabled() then
    raise exception 'The assistant is not available right now' using errcode = '55000';
  end if;
  if p_action_id = 'hp1:more' then
    raise exception 'Continue shopping does not send a message' using errcode = '22023';
  end if;
  if coalesce(v_offer.agent_actions ->> 'kind', '') not in ('buttons', 'list')
     or not private.agent_offer_is_current(p_offer_message_id) then
    raise exception 'This option is no longer available' using errcode = '22023';
  end if;

  select c into v_choice
  from jsonb_array_elements(v_offer.agent_actions -> 'choices') c
  where c ->> 'id' = p_action_id
  limit 1;
  if v_choice is null or coalesce(btrim(v_choice ->> 'title'), '') = '' then
    raise exception 'This option is no longer available' using errcode = '22023';
  end if;

  return private.agent_record_customer_input(
    v_offer.conversation_id, left(btrim(v_choice ->> 'title'), 200), p_client_message_id,
    p_offer_message_id, p_action_id);
end;
$$;

-- -----------------------------------------------------------------------------
-- RPC (guest): submit the delivery form the assistant asked for
-- -----------------------------------------------------------------------------
create or replace function public.submit_agent_delivery_form(
  p_offer_message_id  uuid,
  p_form              jsonb,
  p_client_message_id uuid
)
returns public.messages
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_offer  public.messages;
  v_msg    public.messages;
  v_form   jsonb := '{}'::jsonb;
  v_key    text;
  v_value  text;
  v_total  integer := 0;
  v_lines  integer := 0;
  -- key, label used by n8n, max length, required
  v_fields constant text[][] := array[
    array['full_name',        'Name',          '200', 'y'],
    array['shipping_address', 'Home Address',  '500', 'y'],
    array['email_address',    'Email Address', '200', 'n'],
    array['phone_number',     'Phone Number',  '50',  'y'],
    array['city',             'City',          '200', 'y']
  ];
  i integer;
begin
  if p_offer_message_id is null or p_client_message_id is null then
    raise exception 'Missing form or message id' using errcode = '22023';
  end if;
  v_offer := private.agent_lock_offer(p_offer_message_id);

  select * into v_msg from public.messages
  where conversation_id = v_offer.conversation_id and client_message_id = p_client_message_id;
  if found then
    if v_msg.sender_user_id is distinct from (select auth.uid())
       or v_msg.agent_offer_message_id is distinct from p_offer_message_id
       or v_msg.agent_action_id is distinct from 'hp1:delivery' then
      raise exception 'Duplicate message id' using errcode = '23505';
    end if;
    return v_msg;
  end if;

  if not private.agent_bridge_enabled() then
    raise exception 'The assistant is not available right now' using errcode = '55000';
  end if;
  if coalesce(v_offer.agent_actions ->> 'kind', '') <> 'delivery_form'
     or not private.agent_offer_is_current(p_offer_message_id) then
    raise exception 'This form is no longer available' using errcode = '22023';
  end if;

  -- Structure only. Whether a value is a valid address/phone/email is decided
  -- by the Agent, which owns delivery validation and the checkout.
  if p_form is null or jsonb_typeof(p_form) <> 'object' then
    raise exception 'Invalid delivery form' using errcode = '22023';
  end if;
  for v_key in select jsonb_object_keys(p_form) loop
    if v_key not in ('full_name', 'shipping_address', 'email_address', 'phone_number', 'city') then
      raise exception 'Invalid delivery form' using errcode = '22023';
    end if;
  end loop;

  for i in 1 .. array_length(v_fields, 1) loop
    v_key := v_fields[i][1];
    if p_form -> v_key is null or jsonb_typeof(p_form -> v_key) = 'null' then
      v_value := null;
    elsif jsonb_typeof(p_form -> v_key) = 'string' then
      v_value := btrim(p_form ->> v_key);
    else
      raise exception 'Invalid delivery form' using errcode = '22023';
    end if;
    if v_value = '' then v_value := null; end if;

    if v_value is null then
      if v_fields[i][4] = 'y' then
        raise exception 'Please fill in every required field' using errcode = '22023';
      end if;
      continue; -- optional email left blank: not sent at all
    end if;
    if char_length(v_value) > v_fields[i][3]::integer then
      raise exception 'A delivery field is too long' using errcode = '22023';
    end if;
    v_form := v_form || jsonb_build_object(v_key, v_value);
    -- Same one-line form n8n builds ("Label: value"), for its 1000-char limit.
    v_total := v_total + char_length(v_fields[i][2]) + 2
               + char_length(btrim(regexp_replace(v_value, '\s+', ' ', 'g')));
    v_lines := v_lines + 1;
  end loop;
  if v_total + greatest(v_lines - 1, 0) > 1000 then
    raise exception 'The delivery details are too long' using errcode = '22023';
  end if;

  v_msg := private.agent_record_customer_input(
    v_offer.conversation_id, 'Delivery details submitted', p_client_message_id,
    p_offer_message_id, 'hp1:delivery');

  insert into private.agent_form_submissions (message_id, conversation_id, offer_message_id, form)
  values (v_msg.id, v_offer.conversation_id, p_offer_message_id, v_form);
  return v_msg;
end;
$$;

revoke all on function public.submit_agent_action(uuid, text, uuid) from public, anon, authenticated;
revoke all on function public.submit_agent_delivery_form(uuid, jsonb, uuid) from public, anon, authenticated;
grant execute on function public.submit_agent_action(uuid, text, uuid) to authenticated;
grant execute on function public.submit_agent_delivery_form(uuid, jsonb, uuid) to authenticated;

-- -----------------------------------------------------------------------------
-- Dispatcher (service_role only)
-- -----------------------------------------------------------------------------

-- inbox-agent-event-v1 body built from trusted records at dispatch time, or
-- {"cancel": reason} when the event must not be sent any more.
create or replace function private.agent_event_payload(p_event private.agent_events)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_c    public.conversations;
  v_m    public.messages;
  v_form jsonb;
  v_body jsonb;
begin
  select * into v_c from public.conversations where id = p_event.conversation_id;
  if not found then return jsonb_build_object('cancel', 'conversation_deleted'); end if;
  if v_c.blocked_at is not null then return jsonb_build_object('cancel', 'conversation_blocked'); end if;
  select * into v_m from public.messages where id = p_event.message_id;
  if not found then return jsonb_build_object('cancel', 'message_deleted'); end if;

  v_body := jsonb_build_object(
    'contract_version', 'inbox-agent-event-v1',
    'event_id',         p_event.event_id,
    'event_type',       p_event.event_type,
    'conversation_id',  v_c.id,
    'customer_id',      v_c.customer_id,
    'message_id',       v_m.id
  );

  if p_event.event_type = 'admin.message' then
    -- Staff takeover signal: sent even if the message was later deleted.
    return jsonb_build_object('payload', v_body || jsonb_build_object(
      'admin_author', 'human',
      'occurred_at',  to_char(v_m.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')));
  end if;

  if v_m.deleted_at is not null then
    return jsonb_build_object('cancel', 'message_deleted');
  end if;
  if p_event.event_type = 'customer.message' then
    return jsonb_build_object('payload', v_body || jsonb_build_object('text', v_m.body));
  elsif p_event.event_type = 'customer.action' then
    return jsonb_build_object('payload', v_body || jsonb_build_object('action_id', v_m.agent_action_id));
  else
    select s.form into v_form from private.agent_form_submissions s where s.message_id = v_m.id;
    if v_form is null then return jsonb_build_object('cancel', 'form_missing'); end if;
    return jsonb_build_object('payload', v_body || jsonb_build_object('delivery_form', v_form));
  end if;
end;
$$;
revoke all on function private.agent_event_payload(private.agent_events) from public, anon, authenticated;

-- Clears stored delivery details once their event is finished (or stuck > 1 day).
create or replace function private.agent_purge_forms()
returns void
language sql
volatile
security definer
set search_path = ''
as $$
  update private.agent_form_submissions s set form = null
  from private.agent_events e
  where e.message_id = s.message_id
    and s.form is not null
    and (e.status in ('completed', 'failed', 'expired', 'cancelled')
         or (e.status = 'sent' and e.sent_at < now() - interval '1 day'));
$$;
revoke all on function private.agent_purge_forms() from public, anon, authenticated;

-- Claims the next events that may be sent. Per chat, a customer event waits
-- until every earlier event of that chat is sent and answered (or 90 seconds
-- passed without a callback). admin.message is never held back, so a staff
-- takeover reaches the Agent as soon as possible.
create or replace function public.agent_bridge_claim(p_limit integer default 10)
returns table (event_id uuid, attempt integer, payload jsonb)
language plpgsql
volatile
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  r        private.agent_events;
  v        jsonb;
  v_limit  integer := greatest(1, least(coalesce(p_limit, 10), 50));
  v_try    integer;
begin
  if not private.agent_bridge_enabled() then
    return;
  end if;

  -- A customer turn that could not be sent for 30 minutes is no longer answered.
  update private.agent_events e
     set status = 'expired', outcome = 'expired_before_dispatch', lease_until = null
   where (e.status = 'pending' or (e.status = 'dispatching' and e.lease_until < now()))
     and e.event_type <> 'admin.message'
     and e.created_at < now() - interval '30 minutes';

  perform private.agent_purge_forms();

  for r in
    select e.* from private.agent_events e
    where (e.status = 'pending' or (e.status = 'dispatching' and e.lease_until < now()))
      and e.next_attempt_at <= now()
      and (e.event_type = 'admin.message' or not exists (
        select 1 from private.agent_events p
        where p.conversation_id = e.conversation_id
          and p.seq < e.seq
          and (p.status in ('pending', 'dispatching')
               or (p.status = 'sent' and p.sent_at > now() - interval '90 seconds'))
      ))
    order by e.seq
    limit v_limit
    for update of e skip locked
  loop
    v := private.agent_event_payload(r);
    if v ? 'cancel' then
      update private.agent_events
         set status = 'cancelled', outcome = v ->> 'cancel', lease_until = null
       where seq = r.seq;
      continue;
    end if;
    update private.agent_events
       set status = 'dispatching',
           attempts = attempts + 1,
           lease_until = now() + interval '60 seconds',
           last_attempt_at = now()
     where seq = r.seq
     returning attempts into v_try;
    event_id := r.event_id;
    attempt := v_try;
    payload := v -> 'payload';
    return next;
  end loop;
end;
$$;

-- Records the result of one POST to n8n. p_attempt must match the claim, so a
-- slow worker can never overwrite a newer attempt or a received callback.
create or replace function public.agent_bridge_report(
  p_event_id uuid,
  p_attempt  integer,
  p_ok       boolean,
  p_error    text default null
)
returns text
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_status  text;
  v_backoff constant integer[] := array[10, 30, 60, 120, 300, 600, 900];
  v_max     constant integer := 8;
begin
  if p_ok then
    update private.agent_events
       set status = 'sent', sent_at = now(), lease_until = null, last_error = null
     where event_id = p_event_id and status = 'dispatching' and attempts = p_attempt
     returning status into v_status;
  else
    update private.agent_events
       set status = case when attempts >= v_max then 'failed' else 'pending' end,
           outcome = case when attempts >= v_max then 'dispatch_failed' else outcome end,
           next_attempt_at = now() + make_interval(secs => v_backoff[least(attempts, array_length(v_backoff, 1))]),
           lease_until = null,
           last_error = left(coalesce(p_error, 'unknown error'), 300)
     where event_id = p_event_id and status = 'dispatching' and attempts = p_attempt
     returning status into v_status;
    perform private.agent_purge_forms();
  end if;
  if v_status is null then
    select status into v_status from private.agent_events where event_id = p_event_id;
  end if;
  return v_status;
end;
$$;

-- Applies one inbox-agent-reply-v1 callback (already validated by the server).
create or replace function public.agent_bridge_apply_callback(p_callback jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_event_id   uuid;
  v_conv_id    uuid;
  v_cb_conv    uuid;
  v_cb_cust    uuid;
  v_cb_msg     uuid;
  v_e          private.agent_events;
  v_c          public.conversations;
  v_origin     public.messages;
  v_msg        public.messages;
  v_state      private.agent_conversation_state;
  v_type       text := p_callback ->> 'callback_type';
  v_status     text := p_callback #>> '{delivery,status}';
  v_text       text := p_callback #>> '{reply,text}';
  v_actions    jsonb := p_callback -> 'actions';
  v_hstate     text := p_callback #>> '{handoff,state}';
  v_hpermitted text := p_callback #>> '{handoff,bot_reply_permitted}';
  v_turn_state text := p_callback #>> '{handoff,turn_state}';
  v_rtype      text := p_callback #>> '{reply,response_type}';
  v_handoff    text := 'not_provided';
  v_outcome    text;
begin
  if not private.agent_bridge_enabled() then
    return jsonb_build_object('result', 'disabled');
  end if;

  begin
    v_event_id := (p_callback ->> 'event_id')::uuid;
    v_cb_conv  := (p_callback ->> 'conversation_id')::uuid;
    v_cb_cust  := (p_callback ->> 'customer_id')::uuid;
    v_cb_msg   := (p_callback ->> 'in_reply_to_message_id')::uuid;
  exception when others then
    return jsonb_build_object('result', 'invalid');
  end;

  select e.conversation_id into v_conv_id from private.agent_events e where e.event_id = v_event_id;
  if not found then
    return jsonb_build_object('result', 'unknown_event');
  end if;
  -- Lock order matches sends: the conversation first, then the event.
  select * into v_c from public.conversations where id = v_conv_id for update;
  if not found then
    return jsonb_build_object('result', 'unknown_event');
  end if;
  select * into v_e from private.agent_events e where e.event_id = v_event_id for update;
  if not found then
    return jsonb_build_object('result', 'unknown_event');
  end if;

  if v_cb_conv is distinct from v_e.conversation_id
     or v_cb_cust is distinct from v_c.customer_id
     or v_cb_msg is distinct from v_e.message_id
     or (p_callback ->> 'event_type') is distinct from v_e.event_type
     or (v_type = 'agent.reply') <> (v_e.event_type <> 'admin.message')
     or v_type not in ('agent.reply', 'handoff.update') then
    return jsonb_build_object('result', 'mismatch');
  end if;

  -- Handoff: applied for every valid callback, unless a later event already
  -- set the state (stale callbacks never overwrite newer status).
  if v_hstate is not null and v_hstate ~ '^[a-z_]{1,40}$' then
    select * into v_state from private.agent_conversation_state where conversation_id = v_conv_id for update;
    if not found or v_e.seq >= v_state.handoff_event_seq then
      insert into private.agent_conversation_state
        (conversation_id, handoff_event_seq, bot_reply_permitted, handoff_source, updated_at)
      values (v_conv_id, v_e.seq, v_hpermitted::boolean, left(p_callback #>> '{handoff,source}', 60), now())
      on conflict (conversation_id) do update set
        handoff_event_seq   = excluded.handoff_event_seq,
        bot_reply_permitted = excluded.bot_reply_permitted,
        handoff_source      = excluded.handoff_source,
        updated_at          = now();
      update public.conversations
         set agent_handoff_state = v_hstate, agent_handoff_updated_at = now()
       where id = v_conv_id and agent_handoff_state is distinct from v_hstate;
      v_handoff := 'applied';
    else
      v_handoff := 'stale';
    end if;
  end if;
  select * into v_state from private.agent_conversation_state where conversation_id = v_conv_id;

  if v_type = 'handoff.update' then
    v_outcome := 'handoff_only';
  elsif v_status is distinct from 'deliver' then
    v_outcome := 'not_delivered_' || coalesce(v_status, 'unknown');
  else
    select * into v_msg from public.messages
    where conversation_id = v_conv_id and client_message_id = v_event_id and author = 'assistant';
    if found then
      v_outcome := 'duplicate';
    elsif v_c.blocked_at is not null then
      v_outcome := 'rejected_blocked';
    elsif v_e.status in ('cancelled', 'expired') then
      v_outcome := 'rejected_event_closed';
    elsif coalesce(v_state.last_reply_event_seq, 0) > v_e.seq then
      v_outcome := 'rejected_superseded';
    elsif v_text is null or char_length(btrim(v_text)) = 0 or char_length(btrim(v_text)) > 8000 then
      v_outcome := 'rejected_invalid_text';
    else
      select * into v_origin from public.messages where id = v_e.message_id;
      -- Staff took over after the customer's message: hold the bot reply.
      -- Exception kept from the workflow: a reply the Agent permitted while a
      -- person was active (its emergency notice) is always published.
      if coalesce(v_turn_state, '') <> 'human_active'
         and coalesce(v_rtype, '') <> 'emergency_safety_response'
         and exists (
           select 1 from public.messages h
           where h.conversation_id = v_conv_id
             and h.sender_role = 'admin'
             and h.author = 'human'
             and h.seq > coalesce(v_origin.seq, 0)
         ) then
        v_outcome := 'held_staff_reply';
      else
        insert into public.messages
          (conversation_id, sender_role, sender_user_id, author, type, body, client_message_id, agent_actions)
        values
          (v_conv_id, 'admin', null, 'assistant', 'text', v_text, v_event_id,
           case when jsonb_typeof(v_actions) = 'object'
                     and v_actions ->> 'kind' in ('buttons', 'list', 'delivery_form')
                then v_actions end)
        returning * into v_msg;

        update public.conversations c set
          last_message_at       = v_msg.created_at,
          last_message_preview  = left(v_msg.body, 140),
          last_message_sender   = 'admin',
          last_message_seq      = v_msg.seq,
          customer_unread_count = c.customer_unread_count + 1
        where c.id = v_conv_id;

        insert into private.agent_conversation_state (conversation_id, last_reply_event_seq)
        values (v_conv_id, v_e.seq)
        on conflict (conversation_id) do update
          set last_reply_event_seq = greatest(private.agent_conversation_state.last_reply_event_seq, excluded.last_reply_event_seq),
              updated_at = now();
        v_outcome := 'delivered';
      end if;
    end if;
  end if;

  update private.agent_events
     set status       = case when status in ('cancelled', 'expired') then status else 'completed' end,
         completed_at = coalesce(completed_at, now()),
         lease_until  = null,
         outcome      = case when status = 'completed' and outcome is not null then outcome else v_outcome end
   where seq = v_e.seq;
  perform private.agent_purge_forms();

  return jsonb_build_object(
    'result', 'ok',
    'outcome', v_outcome,
    'handoff', v_handoff,
    'message_id', v_msg.id
  );
end;
$$;

-- Counts per status (for the authenticated dispatch endpoint; no content).
create or replace function public.agent_bridge_status()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'enabled', private.agent_bridge_enabled(),
    'events', coalesce((select jsonb_object_agg(status, n)
                        from (select status, count(*) n from private.agent_events group by status) s), '{}'::jsonb)
  );
$$;

revoke all on function public.agent_bridge_claim(integer) from public, anon, authenticated;
revoke all on function public.agent_bridge_report(uuid, integer, boolean, text) from public, anon, authenticated;
revoke all on function public.agent_bridge_apply_callback(jsonb) from public, anon, authenticated;
revoke all on function public.agent_bridge_status() from public, anon, authenticated;
grant execute on function public.agent_bridge_claim(integer) to service_role;
grant execute on function public.agent_bridge_report(uuid, integer, boolean, text) to service_role;
grant execute on function public.agent_bridge_apply_callback(jsonb) to service_role;
grant execute on function public.agent_bridge_status() to service_role;

-- -----------------------------------------------------------------------------
-- Admin list: add the handoff state; label assistant replies in the preview.
-- (Return type changes: drop + recreate, same arguments.)
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
  blocked_at           timestamptz,
  agent_handoff_state  text
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
    case when (lm.msg).author = 'assistant' then 'assistant' else (lm.msg).sender_role end,
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
    c.blocked_at,
    c.agent_handoff_state
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

notify pgrst, 'reload schema';
