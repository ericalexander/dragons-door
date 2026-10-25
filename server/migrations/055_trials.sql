-- Try-it-in-the-browser characters. A trial character is a test character (kept out of rankings, news, the
-- chronicle, the board and real chat) that only the website's narrator can drive, and that's deleted after a day.
alter table players add column if not exists trial boolean not null default false;
create table if not exists trials (
  player_id  uuid primary key references players(id) on delete cascade,
  addr_hash  text not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  turns      int not null default 0,         -- things the player has said to the narrator
  busy_until timestamptz,                    -- one turn at a time
  history    jsonb not null default '[]',    -- the last few exchanges, so the narrator keeps the thread
  last_state jsonb
);
-- What trials cost each day, to hold to the budget.
create table if not exists trial_usage (
  day           date primary key,
  trials        int not null default 0,
  turns         int not null default 0,
  input_tokens  bigint not null default 0,
  output_tokens bigint not null default 0,
  micro_usd     bigint not null default 0
);
-- Trials started per address per day (hashed with the day and a salt; never the address itself).
create table if not exists trial_addrs (
  addr_hash text not null,
  day       date not null,
  n         int not null default 0,
  primary key (addr_hash, day)
);
alter table trials enable row level security;
alter table trial_usage enable row level security;
alter table trial_addrs enable row level security;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on trials from anon, authenticated;
    revoke all on trial_usage from anon, authenticated;
    revoke all on trial_addrs from anon, authenticated;
  end if;
end $$;
