-- HR Manager Pro - Supabase setup
-- 1) Run this in Supabase SQL Editor.
-- 2) Replace jg338133@gmail.com with your real master email after creating/signing up.
-- 3) Review policies before production.

create extension if not exists pgcrypto;

-- Employee documents / expediente.
-- Stores small documents directly for now. Keep uploads modest; future versions can move files to Supabase Storage.
create table if not exists public.employee_documents (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references public.restaurants(id) on delete cascade,
  employee_id uuid not null references public.employees(id) on delete cascade,
  type text not null default 'other',
  name text,
  file_name text,
  mime_type text,
  size_bytes integer default 0,
  file_data text,
  notes text default '',
  expires_at date,
  created_at timestamptz default now()
);

-- Manager assistant product radar.
-- Stores unanswered questions and feature signals so the master account can see what managers need.
create table if not exists public.manager_assistant_signals (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid references public.restaurants(id) on delete set null,
  question text not null,
  answer text default '',
  category text default 'other',
  page text default '',
  status text default 'new',
  metadata jsonb default '{}'::jsonb,
  created_at timestamptz default now()
);

create table if not exists public.restaurant_invites (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references public.restaurants(id) on delete cascade,
  email text not null,
  role text not null default 'restaurant_manager' check (role in ('restaurant_admin','restaurant_manager')),
  token text not null unique default encode(gen_random_bytes(24), 'hex'),
  created_by uuid references auth.users(id) on delete set null,
  accepted_by uuid references auth.users(id) on delete set null,
  accepted_at timestamptz,
  expires_at timestamptz default (now() + interval '14 days'),
  created_at timestamptz default now()
);

-- Sales module / ventas y caja.
-- Products/services are generic so this can work for restaurants, shops, services or small offices.
create table if not exists public.sales_products (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references public.restaurants(id) on delete cascade,
  name text not null,
  category text default '',
  type text not null default 'product' check (type in ('product','service','ingredient','bundle')),
  price numeric(12,2) not null default 0,
  sku text default '',
  unit text default 'unit',
  track_stock boolean not null default false,
  stock numeric(12,2) not null default 0,
  min_stock numeric(12,2) not null default 0,
  active boolean not null default true,
  created_at timestamptz default now()
);

alter table public.sales_products
add column if not exists sku text default '',
add column if not exists unit text default 'unit',
add column if not exists track_stock boolean not null default false,
add column if not exists stock numeric(12,2) not null default 0,
add column if not exists min_stock numeric(12,2) not null default 0;

do $$
declare
  v_constraint text;
begin
  select conname
  into v_constraint
  from pg_constraint
  where conrelid = 'public.sales_products'::regclass
    and contype = 'c'
    and pg_get_constraintdef(oid) like '%type%'
  limit 1;

  if v_constraint is not null then
    execute format('alter table public.sales_products drop constraint %I', v_constraint);
  end if;

  alter table public.sales_products
  add constraint sales_products_type_check
  check (type in ('product','service','ingredient','bundle'));
end $$;

create table if not exists public.sales (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references public.restaurants(id) on delete cascade,
  product_id uuid references public.sales_products(id) on delete set null,
  product_name text not null default '',
  category text default '',
  quantity numeric(12,2) not null default 1,
  unit_price numeric(12,2) not null default 0,
  total numeric(12,2) not null default 0,
  payment_method text not null default 'cash',
  note text default '',
  sold_at timestamptz default now(),
  created_at timestamptz default now()
);

create table if not exists public.profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  email text unique not null,
  name text,
  role text not null check (role in ('super_admin','restaurant_admin','restaurant_manager','employee')),
  restaurant_id uuid references public.restaurants(id) on delete set null,
  created_at timestamptz default now()
);

-- Business roles.
-- restaurant_admin = owner/admin with full access.
-- restaurant_manager = operational manager for daily HR without payroll/documents/deletion.
do $$
declare
  v_constraint text;
begin
  select conname
  into v_constraint
  from pg_constraint
  where conrelid = 'public.profiles'::regclass
    and contype = 'c'
    and pg_get_constraintdef(oid) like '%role%'
  limit 1;

  if v_constraint is not null then
    execute format('alter table public.profiles drop constraint %I', v_constraint);
  end if;

  alter table public.profiles
  add constraint profiles_role_check
  check (role in ('super_admin','restaurant_admin','restaurant_manager','employee'));
end $$;

alter table public.profiles enable row level security;
alter table public.restaurants enable row level security;
alter table public.employees enable row level security;
alter table public.attendance enable row level security;
alter table public.absences enable row level security;
alter table public.shifts enable row level security;
alter table public.employee_documents enable row level security;
alter table public.manager_assistant_signals enable row level security;
alter table public.restaurant_invites enable row level security;
alter table public.sales_products enable row level security;
alter table public.sales enable row level security;

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

create or replace function public.get_my_profile()
returns public.profiles
language sql
security definer
set search_path = public
as $$
  select *
  from public.profiles
  where user_id = auth.uid()
  limit 1;
$$;

drop policy if exists "profiles read own or super" on public.profiles;
create policy "profiles read own or super"
on public.profiles for select
using (
  user_id = auth.uid()
  or public.is_super_admin()
  or (
    restaurant_id = public.current_restaurant_id()
    and exists (
      select 1 from public.profiles p
      where p.user_id = auth.uid()
        and p.role in ('restaurant_admin','super_admin')
    )
  )
);

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

drop policy if exists "restaurants delete super" on public.restaurants;
create policy "restaurants delete super"
on public.restaurants for delete
using (public.is_super_admin());

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

drop policy if exists "employee documents scoped all" on public.employee_documents;
create policy "employee documents scoped all"
on public.employee_documents for all
using (restaurant_id = public.current_restaurant_id() or public.is_super_admin())
with check (restaurant_id = public.current_restaurant_id() or public.is_super_admin());

drop policy if exists "assistant signals scoped all" on public.manager_assistant_signals;
create policy "assistant signals scoped all"
on public.manager_assistant_signals for all
using (restaurant_id = public.current_restaurant_id() or public.is_super_admin())
with check (restaurant_id = public.current_restaurant_id() or public.is_super_admin());

create index if not exists manager_assistant_signals_restaurant_idx
on public.manager_assistant_signals (restaurant_id, created_at desc);

drop policy if exists "sales products scoped all" on public.sales_products;
create policy "sales products scoped all"
on public.sales_products for all
using (restaurant_id = public.current_restaurant_id() or public.is_super_admin())
with check (restaurant_id = public.current_restaurant_id() or public.is_super_admin());

drop policy if exists "sales scoped all" on public.sales;
create policy "sales scoped all"
on public.sales for all
using (restaurant_id = public.current_restaurant_id() or public.is_super_admin())
with check (restaurant_id = public.current_restaurant_id() or public.is_super_admin());

create index if not exists sales_products_restaurant_idx
on public.sales_products (restaurant_id, active, created_at desc);

create index if not exists sales_products_sku_idx
on public.sales_products (restaurant_id, sku);

create index if not exists sales_restaurant_sold_idx
on public.sales (restaurant_id, sold_at desc);

drop policy if exists "restaurant invites scoped owner" on public.restaurant_invites;
create policy "restaurant invites scoped owner"
on public.restaurant_invites for all
using (
  public.is_super_admin()
  or (
    restaurant_id = public.current_restaurant_id()
    and exists (
      select 1 from public.profiles p
      where p.user_id = auth.uid()
        and p.role = 'restaurant_admin'
    )
  )
)
with check (
  public.is_super_admin()
  or (
    restaurant_id = public.current_restaurant_id()
    and exists (
      select 1 from public.profiles p
      where p.user_id = auth.uid()
        and p.role = 'restaurant_admin'
    )
  )
);

create or replace function public.create_manager_invite(p_email text, p_role text default 'restaurant_manager')
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_restaurant_id uuid;
  v_token text;
begin
  if p_role not in ('restaurant_admin','restaurant_manager') then
    raise exception 'Invalid role';
  end if;

  select restaurant_id
  into v_restaurant_id
  from public.profiles
  where user_id = auth.uid()
    and role in ('restaurant_admin','super_admin')
  limit 1;

  if v_restaurant_id is null and not public.is_super_admin() then
    raise exception 'Not allowed';
  end if;

  v_restaurant_id := coalesce(v_restaurant_id, public.current_restaurant_id());
  if v_restaurant_id is null then
    raise exception 'No restaurant selected';
  end if;

  insert into public.restaurant_invites (restaurant_id, email, role, created_by)
  values (v_restaurant_id, lower(trim(p_email)), p_role, auth.uid())
  returning token into v_token;

  return v_token;
end;
$$;

create or replace function public.accept_manager_invite(p_token text)
returns public.profiles
language plpgsql
security definer
set search_path = public
as $$
declare
  v_invite public.restaurant_invites%rowtype;
  v_profile public.profiles%rowtype;
  v_email text;
begin
  select lower(email)
  into v_email
  from auth.users
  where id = auth.uid();

  if v_email is null then
    raise exception 'Auth required';
  end if;

  select *
  into v_invite
  from public.restaurant_invites
  where token = p_token
    and accepted_at is null
    and expires_at > now()
    and lower(email) = v_email
  limit 1;

  if v_invite.id is null then
    raise exception 'Invite not valid';
  end if;

  insert into public.profiles (user_id, email, name, role, restaurant_id)
  values (auth.uid(), v_email, split_part(v_email,'@',1), v_invite.role, v_invite.restaurant_id)
  on conflict (user_id) do update
    set role = case
          when public.profiles.role = 'super_admin' then public.profiles.role
          else excluded.role
        end,
        restaurant_id = case
          when public.profiles.role = 'super_admin' then public.profiles.restaurant_id
          else excluded.restaurant_id
        end,
        email = excluded.email
  returning * into v_profile;

  update public.restaurant_invites
  set accepted_by = auth.uid(), accepted_at = now()
  where id = v_invite.id;

  return v_profile;
end;
$$;

create or replace function public.update_manager_access(p_email text, p_role text)
returns public.profiles
language plpgsql
security definer
set search_path = public
as $$
declare
  v_restaurant_id uuid;
  v_profile public.profiles%rowtype;
begin
  if p_role not in ('restaurant_admin','restaurant_manager') then
    raise exception 'Invalid role';
  end if;

  select restaurant_id
  into v_restaurant_id
  from public.profiles
  where user_id = auth.uid()
    and role in ('restaurant_admin','super_admin')
  limit 1;

  if v_restaurant_id is null then
    raise exception 'Not allowed';
  end if;

  update public.profiles
  set role = p_role
  where restaurant_id = v_restaurant_id
    and lower(email) = lower(trim(p_email))
    and role <> 'super_admin'
  returning * into v_profile;

  if v_profile.user_id is null then
    raise exception 'Profile not found';
  end if;

  return v_profile;
end;
$$;

create or replace function public.revoke_manager_access(p_email text)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_restaurant_id uuid;
  v_count integer;
begin
  select restaurant_id
  into v_restaurant_id
  from public.profiles
  where user_id = auth.uid()
    and role in ('restaurant_admin','super_admin')
  limit 1;

  if v_restaurant_id is null then
    raise exception 'Not allowed';
  end if;

  delete from public.profiles
  where restaurant_id = v_restaurant_id
    and lower(email) = lower(trim(p_email))
    and user_id <> auth.uid()
    and role <> 'super_admin';

  get diagnostics v_count = row_count;
  return v_count > 0;
end;
$$;

-- Promote your own account to master after it exists in Supabase Auth.
-- Replace jg338133@gmail.com with your email.
insert into public.profiles (user_id,email,name,role,restaurant_id)
select id,email,coalesce(raw_user_meta_data->>'name', split_part(email,'@',1)),'super_admin',null
from auth.users
where email = 'jg338133@gmail.com'
on conflict (user_id) do update set role='super_admin', restaurant_id=null;

-- Columns required by the current app version.
alter table public.employees add column if not exists pin text default '0000';
alter table public.attendance add column if not exists note text default '';
alter table public.restaurants add column if not exists emoji text default '🍽️';
alter table public.restaurants add column if not exists brand_color text default '#4f6ef7';
alter table public.restaurants add column if not exists brand_color2 text default '#7c3aed';
alter table public.restaurants add column if not exists status text default 'active';
alter table public.restaurants add column if not exists opening_hours jsonb default '{}'::jsonb;
alter table public.shifts add column if not exists blocks jsonb default '[]'::jsonb;
update public.employees set pin = '0000' where pin is null or pin = '';
update public.restaurants set emoji = '🍽️' where emoji is null or emoji = '';
update public.restaurants set brand_color = '#4f6ef7' where brand_color is null or brand_color = '';
update public.restaurants set brand_color2 = '#7c3aed' where brand_color2 is null or brand_color2 = '';
update public.restaurants set status = 'active' where status is null or status = '';
update public.restaurants set opening_hours = '{}'::jsonb where opening_hours is null;
create unique index if not exists shifts_employee_date_unique on public.shifts(employee_id, shift_date);
create index if not exists employee_documents_employee_idx on public.employee_documents(employee_id, created_at desc);

-- Employee self-service login by email + PIN.
-- This lets employees access only their own badge screen without knowing the restaurant id.
create or replace function public.employee_login(p_email text, p_pin text)
returns table (
  id text,
  restaurant_id text,
  name text,
  last_name text,
  employee_number text,
  "position" text,
  department text,
  phone text,
  email text,
  start_date date,
  contract_type text,
  pay_type text,
  hourly_rate numeric,
  monthly_salary numeric,
  vacation_weeks integer,
  avs_number text,
  emergency_contact text,
  notes text,
  status text,
  photo_url text,
  color text,
  schedules jsonb,
  restaurant_name text,
  restaurant_emoji text,
  currency text,
  late_tolerance integer,
  max_hours_week integer,
  lang text,
  brand_color text,
  brand_color2 text
)
language sql
security definer
set search_path = public
as $$
  select
    e.id::text,
    e.restaurant_id::text,
    e.name,
    e.last_name,
    e.employee_number,
    e.position,
    e.department,
    e.phone,
    e.email,
    e.start_date,
    e.contract_type,
    e.pay_type,
    e.hourly_rate,
    e.monthly_salary,
    e.vacation_weeks,
    e.avs_number,
    e.emergency_contact,
    e.notes,
    e.status,
    e.photo_url,
    e.color,
    e.schedules,
    r.name as restaurant_name,
    r.emoji as restaurant_emoji,
    r.currency,
    r.late_tolerance,
    r.max_hours_week,
    r.lang,
    r.brand_color,
    r.brand_color2
  from public.employees e
  join public.restaurants r on r.id = e.restaurant_id
  where lower(e.email) = lower(trim(p_email))
    and e.pin = p_pin
    and e.status = 'active'
    and coalesce(r.status,'active') = 'active'
  limit 1;
$$;

create or replace function public.employee_register_attendance(p_email text, p_pin text, p_type text, p_note text default '')
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_emp record;
begin
  if p_type not in ('in','out','break_start','break_end') then
    raise exception 'Invalid attendance type';
  end if;

  select e.id, e.restaurant_id, e.name, e.last_name
  into v_emp
  from public.employees e
  join public.restaurants r on r.id = e.restaurant_id
  where lower(e.email) = lower(trim(p_email))
    and e.pin = p_pin
    and e.status = 'active'
    and coalesce(r.status,'active') = 'active'
  limit 1;

  if v_emp.id is null then
    raise exception 'Employee not found';
  end if;

  insert into public.attendance (restaurant_id, employee_id, employee_name, type, timestamp, note)
  values (
    v_emp.restaurant_id,
    v_emp.id,
    trim(concat(v_emp.name, ' ', coalesce(v_emp.last_name,''))),
    p_type,
    now(),
    coalesce(p_note,'')
  );
end;
$$;

create or replace function public.employee_register_break(p_email text, p_pin text, p_minutes integer)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_emp record;
  v_minutes integer;
begin
  v_minutes := case when p_minutes in (15,30) then p_minutes else null end;
  if v_minutes is null then
    raise exception 'Invalid break length';
  end if;

  select e.id, e.restaurant_id, e.name, e.last_name
  into v_emp
  from public.employees e
  join public.restaurants r on r.id = e.restaurant_id
  where lower(e.email) = lower(trim(p_email))
    and e.pin = p_pin
    and e.status = 'active'
    and coalesce(r.status,'active') = 'active'
  limit 1;

  if v_emp.id is null then
    raise exception 'Employee not found';
  end if;

  insert into public.attendance (restaurant_id, employee_id, employee_name, type, timestamp)
  values
    (v_emp.restaurant_id, v_emp.id, trim(concat(v_emp.name, ' ', coalesce(v_emp.last_name,''))), 'break_start', now()),
    (v_emp.restaurant_id, v_emp.id, trim(concat(v_emp.name, ' ', coalesce(v_emp.last_name,''))), 'break_end', now() + make_interval(mins => v_minutes));
end;
$$;

create or replace function public.employee_portal_data(p_email text, p_pin text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_emp record;
  v_payload jsonb;
begin
  select e.id, e.restaurant_id
  into v_emp
  from public.employees e
  join public.restaurants r on r.id = e.restaurant_id
  where lower(e.email) = lower(trim(p_email))
    and e.pin = p_pin
    and e.status = 'active'
    and coalesce(r.status,'active') = 'active'
  limit 1;

  if v_emp.id is null then
    raise exception 'Employee not found';
  end if;

  select jsonb_build_object(
    'attendance', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', a.id::text,
        'employee_id', a.employee_id::text,
        'employee_name', a.employee_name,
        'type', a.type,
        'timestamp', a.timestamp,
        'note', a.note
      ) order by a.timestamp desc)
      from public.attendance a
      where a.employee_id = v_emp.id
        and a.restaurant_id = v_emp.restaurant_id
        and a.timestamp >= date_trunc('year', now())
    ), '[]'::jsonb),
    'absences', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', ab.id::text,
        'employee_id', ab.employee_id::text,
        'type', ab.type,
        'start_date', ab.start_date,
        'end_date', ab.end_date,
        'approved', ab.approved,
        'notes', ab.notes
      ) order by ab.start_date desc)
      from public.absences ab
      where ab.employee_id = v_emp.id
        and ab.restaurant_id = v_emp.restaurant_id
        and ab.start_date >= (current_date - interval '90 days')
    ), '[]'::jsonb),
    'shifts', coalesce((
      select jsonb_agg(jsonb_build_object(
        'employee_id', s.employee_id::text,
        'shift_date', s.shift_date,
        'shift_type', s.shift_type,
        'start_time', s.start_time,
        'end_time', s.end_time,
        'blocks', coalesce(s.blocks, '[]'::jsonb),
        'notes', s.notes
      ) order by s.shift_date)
      from public.shifts s
      where s.employee_id = v_emp.id
        and s.restaurant_id = v_emp.restaurant_id
        and s.shift_date between (current_date - interval '90 days') and (current_date + interval '180 days')
    ), '[]'::jsonb)
  ) into v_payload;

  return v_payload;
end;
$$;

create or replace function public.employee_request_absence(p_email text, p_pin text, p_type text, p_start date, p_end date, p_notes text default '')
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_emp record;
begin
  if p_start is null or p_end is null or p_end < p_start then
    raise exception 'Invalid absence dates';
  end if;

  select e.id, e.restaurant_id
  into v_emp
  from public.employees e
  join public.restaurants r on r.id = e.restaurant_id
  where lower(e.email) = lower(trim(p_email))
    and e.pin = p_pin
    and e.status = 'active'
    and coalesce(r.status,'active') = 'active'
  limit 1;

  if v_emp.id is null then
    raise exception 'Employee not found';
  end if;

  insert into public.absences (restaurant_id, employee_id, type, start_date, end_date, approved, notes)
  values (v_emp.restaurant_id, v_emp.id, p_type, p_start, p_end, false, coalesce(p_notes,''));
end;
$$;

grant execute on function public.employee_login(text,text) to anon, authenticated;
grant execute on function public.employee_register_attendance(text,text,text) to anon, authenticated;
grant execute on function public.employee_register_attendance(text,text,text,text) to anon, authenticated;
grant execute on function public.employee_register_break(text,text,integer) to anon, authenticated;
grant execute on function public.employee_portal_data(text,text) to anon, authenticated;
grant execute on function public.employee_request_absence(text,text,text,date,date,text) to anon, authenticated;

-- Employee self-service: warn when requested vacation overlaps another employee.
create or replace function public.employee_absence_conflicts
  (p_email text, p_pin text, p_start date, p_end date)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_emp record;
  v_payload jsonb;
begin
  if p_start is null or p_end is null or p_end < p_start then
    raise exception 'Invalid absence dates';
  end if;

  select e.id, e.restaurant_id
  into v_emp
  from public.employees e
  join public.restaurants r on r.id = e.restaurant_id
  where lower(e.email) = lower(trim(p_email))
    and e.pin = p_pin
    and e.status = 'active'
    and coalesce(r.status,'active') = 'active'
  limit 1;

  if v_emp.id is null then
    raise exception 'Employee not found';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'id', ab.id::text,
    'employee_id', ab.employee_id::text,
    'start', ab.start_date,
    'end', ab.end_date,
    'approved', ab.approved
  ) order by ab.start_date), '[]'::jsonb)
  into v_payload
  from public.absences ab
  where ab.restaurant_id = v_emp.restaurant_id
    and ab.employee_id <> v_emp.id
    and ab.type = 'vacation'
    and ab.start_date <= p_end
    and ab.end_date >= p_start;

  return v_payload;
end;
$$;

grant execute on function public.employee_absence_conflicts(text,text,date,date) to anon, authenticated;

-- Master admin: delete a restaurant and all app data linked to it.
create or replace function public.master_delete_restaurant(p_restaurant_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_super_admin() then
    raise exception 'Only super admin can delete restaurants';
  end if;

  if p_restaurant_id is null then
    raise exception 'Restaurant id is required';
  end if;

  delete from public.attendance where restaurant_id = p_restaurant_id;
  delete from public.absences where restaurant_id = p_restaurant_id;
  delete from public.shifts where restaurant_id = p_restaurant_id;
  delete from public.employee_documents where restaurant_id = p_restaurant_id;
  delete from public.sales where restaurant_id = p_restaurant_id;
  delete from public.sales_products where restaurant_id = p_restaurant_id;
  delete from public.employees where restaurant_id = p_restaurant_id;
  update public.profiles set restaurant_id = null where restaurant_id = p_restaurant_id;
  delete from public.restaurants where id = p_restaurant_id;
end;
$$;

grant execute on function public.master_delete_restaurant(uuid) to authenticated;

-- Master admin: freeze/reactivate a restaurant without deleting its data.
create or replace function public.master_set_restaurant_status(p_restaurant_id uuid, p_status text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_super_admin() then
    raise exception 'Only super admin can change restaurant status';
  end if;

  if p_restaurant_id is null then
    raise exception 'Restaurant id is required';
  end if;

  if p_status not in ('active','frozen') then
    raise exception 'Invalid restaurant status';
  end if;

  update public.restaurants
  set status = p_status
  where id = p_restaurant_id;
end;
$$;

grant execute on function public.master_set_restaurant_status(uuid,text) to authenticated;

