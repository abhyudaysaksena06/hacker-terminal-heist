-- Hacker Terminal Heist: game sessions, leaderboard and rate limits.
-- The `game` Edge Function is the only writer (it uses the service role, which bypasses RLS).
-- Players never touch game_sessions directly: puzzle progress, alert and score stay server-authoritative.

create table public.game_sessions (
  id          uuid primary key,
  user_id     uuid not null references auth.users (id) on delete cascade,
  data        jsonb not null,            -- the engine's session object (level, alert, intel, lock, ...)
  version     integer not null default 0, -- optimistic lock: a save only succeeds against the version it read
  started_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index game_sessions_user_started_idx on public.game_sessions (user_id, started_at desc);
alter table public.game_sessions enable row level security;
-- No policies: anon and authenticated roles cannot read or write sessions.

create table public.leaderboard (
  id          bigint generated always as identity primary key,
  session_id  uuid not null unique,      -- one submission per finished run
  name        text not null check (name ~ '^[A-Za-z0-9_ -]{1,16}$'),
  score       integer not null check (score >= 0),
  time_s      integer not null check (time_s >= 0),
  created_at  timestamptz not null default now()
);
create index leaderboard_rank_idx on public.leaderboard (score desc, id);
alter table public.leaderboard enable row level security;
create policy "leaderboard is public" on public.leaderboard for select to anon, authenticated using (true);

create table public.rate_limits (
  key       text primary key,            -- player id, or ip:<address> when signed out
  n         integer not null,
  reset_at  timestamptz not null
);
alter table public.rate_limits enable row level security;

-- Counts one request for `p_key` in a fixed window. Returns true while the key is under the limit.
create function public.hit_rate_limit(p_key text, p_window_ms integer, p_max integer)
returns boolean
language sql
security definer
set search_path = ''
as $$
  insert into public.rate_limits as r (key, n, reset_at)
  values (p_key, 1, now() + make_interval(secs => p_window_ms / 1000.0))
  on conflict (key) do update set
    n        = case when r.reset_at <= now() then 1 else r.n + 1 end,
    reset_at = case when r.reset_at <= now() then now() + make_interval(secs => p_window_ms / 1000.0) else r.reset_at end
  returning n <= p_max;
$$;

-- Adds a finished run and keeps only the top 50, ranked by score (earlier submission wins a tie).
create function public.submit_score(p_session uuid, p_name text, p_score integer, p_time integer)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.leaderboard (session_id, name, score, time_s) values (p_session, p_name, p_score, p_time);
  delete from public.leaderboard
  where id not in (select id from public.leaderboard order by score desc, id limit 50);
end;
$$;

revoke execute on function public.hit_rate_limit(text, integer, integer) from public, anon, authenticated;
revoke execute on function public.submit_score(uuid, text, integer, integer) from public, anon, authenticated;
grant execute on function public.hit_rate_limit(text, integer, integer) to service_role;
grant execute on function public.submit_score(uuid, text, integer, integer) to service_role;
