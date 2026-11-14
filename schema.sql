-- GROQGPT Supabase schema. Run once in the Supabase SQL editor before deployment.
create extension if not exists pgcrypto;

create table if not exists public.app_users (
  id uuid primary key default gen_random_uuid(),
  email text unique,
  password_hash text,
  display_name text not null default 'Guest',
  role text not null default 'user' check (role in ('user','admin')),
  is_guest boolean not null default true,
  created_at timestamptz not null default now(),
  expires_at timestamptz
);

create table if not exists public.app_sessions (
  token_hash text primary key,
  user_id uuid references public.app_users(id) on delete cascade,
  is_admin boolean not null default false,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);
create index if not exists app_sessions_expiry_idx on public.app_sessions(expires_at);

create table if not exists public.workspaces (
  user_id uuid primary key references public.app_users(id) on delete cascade,
  state jsonb not null default '{"chats":[],"projects":[],"assistants":[],"folders":[],"memory":[],"settings":{},"images":[]}'::jsonb,
  updated_at timestamptz not null default now()
);

create table if not exists public.library_files (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.app_users(id) on delete cascade,
  project_id uuid,
  name text not null,
  mime_type text not null,
  file_size bigint not null,
  object_key text not null unique,
  extracted_text text not null default '',
  search_vector tsvector generated always as (to_tsvector('english', coalesce(name, '') || ' ' || coalesce(extracted_text, ''))) stored,
  created_at timestamptz not null default now()
);
create index if not exists library_files_user_idx on public.library_files(user_id, created_at desc);
create index if not exists library_files_search_idx on public.library_files using gin(search_vector);

create table if not exists public.calendar_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.app_users(id) on delete cascade,
  title text not null,
  description text not null default '',
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  created_at timestamptz not null default now()
);
create index if not exists calendar_events_user_date_idx on public.calendar_events(user_id, starts_at);

create table if not exists public.scheduled_tasks (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.app_users(id) on delete cascade,
  title text not null,
  prompt text not null,
  cadence text not null check (cadence in ('once','daily','weekly','monthly')),
  next_run_at timestamptz not null,
  enabled boolean not null default true,
  status text not null default 'scheduled' check (status in ('scheduled','running','completed','failed','paused')),
  last_result text,
  last_error text,
  last_run_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists scheduled_tasks_due_idx on public.scheduled_tasks(enabled, next_run_at) where enabled = true;
create index if not exists scheduled_tasks_user_idx on public.scheduled_tasks(user_id, created_at desc);

create table if not exists public.image_assets (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.app_users(id) on delete cascade,
  prompt text not null,
  object_key text not null unique,
  is_favorite boolean not null default false,
  created_at timestamptz not null default now()
);
create index if not exists image_assets_user_idx on public.image_assets(user_id, created_at desc);

create table if not exists public.usage_events (
  id bigint generated always as identity primary key,
  user_id uuid references public.app_users(id) on delete set null,
  event_type text not null,
  model text,
  created_at timestamptz not null default now()
);
create index if not exists usage_events_created_idx on public.usage_events(created_at desc);

create table if not exists public.announcements (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  message text not null,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists public.community_assistants (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.app_users(id) on delete cascade,
  name text not null,
  description text not null default '',
  instructions text not null,
  category text not null default 'General',
  use_count bigint not null default 0,
  created_at timestamptz not null default now()
);
create index if not exists community_assistants_feed_idx on public.community_assistants(use_count desc, created_at desc);

-- Claim due tasks atomically, preventing two server instances from running one task twice.
create or replace function public.claim_due_ai_tasks(batch_size integer default 20)
returns setof public.scheduled_tasks
language sql
security definer
set search_path = public
as $$
  with due as (
    select id from public.scheduled_tasks
    where enabled = true and status = 'scheduled' and next_run_at <= now()
    order by next_run_at
    for update skip locked
    limit greatest(1, least(batch_size, 100))
  )
  update public.scheduled_tasks as task
  set status = 'running', updated_at = now()
  from due where task.id = due.id
  returning task.*;
$$;
revoke all on function public.claim_due_ai_tasks(integer) from public, anon, authenticated;
grant execute on function public.claim_due_ai_tasks(integer) to service_role;

-- Private user data is accessed only through the Node server's secret key.
alter table public.app_users enable row level security;
alter table public.app_sessions enable row level security;
alter table public.workspaces enable row level security;
alter table public.library_files enable row level security;
alter table public.scheduled_tasks enable row level security;
alter table public.image_assets enable row level security;
alter table public.calendar_events enable row level security;
alter table public.usage_events enable row level security;
alter table public.announcements enable row level security;
alter table public.community_assistants enable row level security;

insert into storage.buckets (id, name, public, file_size_limit)
values ('groqgpt-private', 'groqgpt-private', false, 10485760)
on conflict (id) do nothing;
