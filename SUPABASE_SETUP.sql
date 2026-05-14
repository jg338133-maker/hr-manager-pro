-- HR Manager Pro - Supabase setup
-- 1) Run this in Supabase SQL Editor.
-- 2) Replace jg338133@gmail.com with your real master email after creating/signing up.
-- 3) Review policies before production.

create extension if not exists pgcrypto;

create table if not exists public.profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  email text unique not null,
  name text,
  role text not null check (role in ('super_admin','restaurant_admin','employee')),
  restaurant_id uuid references public.restaurants(id) on delete set null,
  created_at timestamptz default now()
);

alter table public.profiles enable row level security;
alter table public.restaurants enable row level security;
alter table public.employees enable row level security;
alter table public.attendance enable row level security;
alter table public.absences enable row level security;
alter table public.shifts enable row level security;

create or replace function public.is_super_admin()
returns boolean
language sql
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.profiles
    where user_id = auth.uid()
    and role = 'super_admin'
  );
$$;

create or replace function public.current_restaurant_id()
returns uuid
language sql
security definer
set search_path = public
as $$
  select restaurant_id from public.profiles
  where user_id = auth.uid()
  limit 1;
$$;

drop policy if exists "profiles read own or super" on public.profiles;
create policy "profiles read own or super"
on public.profiles for select
using (user_id = auth.uid() or public.is_super_admin());

drop policy if exists "profiles insert own" on public.profiles;
create policy "profiles insert own"
on public.profiles for insert
with check (user_id = auth.uid());

drop policy if exists "profiles update own or super" on public.profiles;
create policy "profiles update own or super"
on public.profiles for update
using (user_id = auth.uid() or public.is_super_admin());

drop policy if exists "restaurants read scoped" on public.restaurants;
create policy "restaurants read scoped"
on public.restaurants for select
using (id = public.current_restaurant_id() or public.is_super_admin());

drop policy if exists "restaurants insert authenticated" on public.restaurants;
create policy "restaurants insert authenticated"
on public.restaurants for insert
to authenticated
with check (true);

drop policy if exists "restaurants update scoped" on public.restaurants;
create policy "restaurants update scoped"
on public.restaurants for update
using (id = public.current_restaurant_id() or public.is_super_admin());

-- Scoped policies for app data tables.
drop policy if exists "employees scoped all" on public.employees;
create policy "employees scoped all"
on public.employees for all
using (restaurant_id = public.current_restaurant_id() or public.is_super_admin())
with check (restaurant_id = public.current_restaurant_id() or public.is_super_admin());

drop policy if exists "attendance scoped all" on public.attendance;
create policy "attendance scoped all"
on public.attendance for all
using (restaurant_id = public.current_restaurant_id() or public.is_super_admin())
with check (restaurant_id = public.current_restaurant_id() or public.is_super_admin());

drop policy if exists "absences scoped all" on public.absences;
create policy "absences scoped all"
on public.absences for all
using (restaurant_id = public.current_restaurant_id() or public.is_super_admin())
with check (restaurant_id = public.current_restaurant_id() or public.is_super_admin());

drop policy if exists "shifts scoped all" on public.shifts;
create policy "shifts scoped all"
on public.shifts for all
using (restaurant_id = public.current_restaurant_id() or public.is_super_admin())
with check (restaurant_id = public.current_restaurant_id() or public.is_super_admin());

-- Promote your own account to master after it exists in Supabase Auth.
-- Replace jg338133@gmail.com with your email.
insert into public.profiles (user_id,email,name,role,restaurant_id)
select id,email,coalesce(raw_user_meta_data->>'name', split_part(email,'@',1)),'super_admin',null
from auth.users
where email = 'jg338133@gmail.com'
on conflict (user_id) do update set role='super_admin', restaurant_id=null;

