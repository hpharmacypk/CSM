-- Removes conversations created by `npm run verify:isolation`.
-- Run in: Supabase Dashboard → SQL Editor. Review the SELECT first.
-- Only conversations whose FIRST message starts with "[isolation-test]" are
-- affected, so real customer threads are never touched.

-- 1) Preview
select c.id, cu.public_ref, c.created_at
from public.conversations c
join public.customers cu on cu.id = c.customer_id
where (
  select m.body from public.messages m
  where m.conversation_id = c.id
  order by m.seq asc limit 1
) like '[isolation-test]%';

-- 2) Delete (uncomment to run). Deleting a customer row also deletes its
--    conversation and messages; then the matching anonymous auth users go.
-- with test_customers as (
--   select cu.id as customer_id, cu.user_id
--   from public.conversations c
--   join public.customers cu on cu.id = c.customer_id
--   where (
--     select m.body from public.messages m
--     where m.conversation_id = c.id
--     order by m.seq asc limit 1
--   ) like '[isolation-test]%'
-- ), deleted as (
--   delete from public.customers where id in (select customer_id from test_customers)
--   returning user_id
-- )
-- delete from auth.users
-- where id in (select user_id from deleted where user_id is not null)
--   and is_anonymous = true;
