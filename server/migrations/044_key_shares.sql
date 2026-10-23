-- A maintainer carrying their characters to another machine. The plugin seals its keys with a one-time code
-- the server never sees; this holds only the sealed bundle and a hash of the code, for fifteen minutes, once.
create table if not exists key_shares (
  code_hash text primary key,
  sealed text not null,
  created_by uuid not null references players(id) on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '15 minutes',
  claimed_at timestamptz,
  claimed_by uuid references players(id) on delete set null
);
alter table key_shares enable row level security;
