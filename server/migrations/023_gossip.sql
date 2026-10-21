-- Places a player has heard of but not visited (drawn on their map), and who they've talked to today.
create table if not exists rumors (
  player_id uuid not null references players(id) on delete cascade,
  x int not null,
  y int not null,
  heard_from text,
  at timestamptz not null default now(),
  primary key (player_id, x, y)
);
alter table rumors enable row level security;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on rumors from anon, authenticated;
  end if;
end $$;
alter table turns add column if not exists talked text[] not null default '{}';
alter table turns add column if not exists gossip_heard boolean not null default false;
