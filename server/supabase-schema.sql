-- BidMax Supabase Schema
-- Run this in your Supabase SQL editor

-- Users table
create table if not exists users (
  id uuid primary key default gen_random_uuid(),
  email text unique not null,
  google_id text unique,
  stripe_customer_id text unique,
  is_pro boolean default false,
  pro_since timestamptz,
  pro_until timestamptz,
  created_at timestamptz default now()
);

-- Sessions table
create table if not exists sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references users(id) on delete cascade,
  token text unique not null default encode(gen_random_bytes(32), 'hex'),
  created_at timestamptz default now(),
  expires_at timestamptz default now() + interval '90 days',
  last_used_at timestamptz default now()
);

-- Usage table (tracks batch analyses per device or user per day)
create table if not exists usage (
  id uuid primary key default gen_random_uuid(),
  device_id text,
  user_id uuid references users(id) on delete set null,
  date date default current_date,
  batch_count integer default 0,
  unique(device_id, date),
  unique(user_id, date)
);

-- Indexes
create index if not exists sessions_token_idx on sessions(token);
create index if not exists sessions_user_id_idx on sessions(user_id);
create index if not exists usage_device_date_idx on usage(device_id, date);
create index if not exists usage_user_date_idx on usage(user_id, date);
create index if not exists users_google_id_idx on users(google_id);

-- Row level security (disable for service role, which we use server-side)
alter table users enable row level security;
alter table sessions enable row level security;
alter table usage enable row level security;

-- Allow service role full access (our server uses service role key)
create policy "service role full access users" on users using (true) with check (true);
create policy "service role full access sessions" on sessions using (true) with check (true);
create policy "service role full access usage" on usage using (true) with check (true);
