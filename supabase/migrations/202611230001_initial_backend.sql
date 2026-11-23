create table if not exists public.users (
  id uuid primary key references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);

create table if not exists public.sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  started_at timestamptz not null default now(),
  ended_at timestamptz,
  classification text not null default 'inconclusive'
    check (classification in ('human_like', 'automated_like', 'suspicious', 'inconclusive')),
  score double precision not null default 0,
  is_simulated text,
  metadata_json jsonb,
  analysis_state jsonb not null default '{}'::jsonb
);

create index if not exists sessions_user_started_idx
  on public.sessions(user_id, started_at desc);

create table if not exists public.events (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.sessions(id) on delete cascade,
  event_type varchar(50) not null,
  timestamp double precision not null,
  page varchar(255),
  target varchar(255),
  metadata_json jsonb,
  sequence_number integer not null,
  product_state jsonb,
  is_suspicious boolean not null default false,
  detections jsonb not null default '[]'::jsonb,
  unique(session_id, sequence_number)
);

create index if not exists events_session_sequence_idx
  on public.events(session_id, sequence_number);

create table if not exists public.automaton_states (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.sessions(id) on delete cascade,
  automaton_type varchar(50) not null,
  state varchar(100) not null,
  previous_state varchar(100),
  input_symbol varchar(50),
  timestamp double precision not null,
  event_id uuid references public.events(id) on delete cascade
);

create index if not exists automaton_states_session_time_idx
  on public.automaton_states(session_id, timestamp);

create table if not exists public.detections (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.sessions(id) on delete cascade,
  reason text not null,
  severity text not null default 'low'
    check (severity in ('low', 'medium', 'high', 'critical')),
  event_id uuid references public.events(id) on delete cascade,
  automaton_type varchar(50),
  from_state varchar(100),
  to_state varchar(100),
  input_symbol varchar(50),
  created_at timestamptz not null default now()
);

create index if not exists detections_session_created_idx
  on public.detections(session_id, created_at);

alter table public.users enable row level security;
alter table public.sessions enable row level security;
alter table public.events enable row level security;
alter table public.automaton_states enable row level security;
alter table public.detections enable row level security;

create policy "Users can read their own profile"
  on public.users for select to authenticated using (id = (select auth.uid()));

create policy "Users can read their own sessions"
  on public.sessions for select to authenticated using (user_id = (select auth.uid()));

create policy "Users can read events from their sessions"
  on public.events for select to authenticated
  using (exists (select 1 from public.sessions s where s.id = session_id and s.user_id = (select auth.uid())));

create policy "Users can read states from their sessions"
  on public.automaton_states for select to authenticated
  using (exists (select 1 from public.sessions s where s.id = session_id and s.user_id = (select auth.uid())));

create policy "Users can read detections from their sessions"
  on public.detections for select to authenticated
  using (exists (select 1 from public.sessions s where s.id = session_id and s.user_id = (select auth.uid())));

do $$ begin
  alter publication supabase_realtime add table public.events;
exception when duplicate_object then null;
end $$;
