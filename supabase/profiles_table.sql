-- Run this in your Supabase SQL Editor (supabase.com → SQL Editor)
-- Creates the profiles table for Solar Optimiser user accounts.

create table if not exists public.profiles (
  id            uuid primary key references auth.users(id) on delete cascade,
  email         text,
  display_name  text,
  app_state     jsonb,
  updated_at    timestamptz default now()
);

-- Enable Row Level Security so users can only read/write their own row
alter table public.profiles enable row level security;

create policy "Users can view own profile"
  on public.profiles for select
  using (auth.uid() = id);

create policy "Users can insert own profile"
  on public.profiles for insert
  with check (auth.uid() = id);

create policy "Users can update own profile"
  on public.profiles for update
  using (auth.uid() = id);
