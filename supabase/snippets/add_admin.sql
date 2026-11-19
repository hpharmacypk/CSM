-- Grant admin access to ONE existing Supabase Auth user.
-- Run in: Supabase Dashboard → SQL Editor (runs as the project owner).
-- Replace the email below with the admin account you created in
-- Authentication → Users. This is NOT a migration; run it by hand once.

insert into private.admins (user_id)
select id
from auth.users
where email = 'admin@example.com'          -- ← change this
  and coalesce(is_anonymous, false) = false
on conflict (user_id) do nothing
returning user_id;

-- Check: should list exactly the admin account(s).
select a.user_id, u.email, a.created_at
from private.admins a
join auth.users u on u.id = a.user_id;

-- To revoke admin access later:
-- delete from private.admins where user_id = (select id from auth.users where email = 'admin@example.com');
