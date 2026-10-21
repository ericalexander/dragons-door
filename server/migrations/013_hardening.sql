-- Names are unique regardless of case.
create unique index if not exists players_name_lower_key on players (lower(name));
-- Sign-ups per address per day, keyed by a salted hash that changes daily. No address is stored.
create table if not exists signups (
  addr_hash text not null,
  day       text not null,
  n         int  not null default 0,
  primary key (addr_hash, day)
);
alter table signups enable row level security;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then revoke all on signups from anon, authenticated; end if;
end $$;
-- Help the mailbag queries.
create index if not exists messages_from_player_idx on messages (from_player);
create index if not exists mutes_muted_id_idx on mutes (muted_id);
