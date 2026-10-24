-- Townsfolk and the realm's characters remember each player: when they first met, how often they've talked,
-- and a few short notes of what the player said to them (newest last, a handful kept).
create table if not exists npc_memory (
  player_id  uuid not null references players(id) on delete cascade,
  npc        text not null,
  first_met  date not null,
  last_talk  date not null,
  talks      integer not null default 0,
  notes      jsonb not null default '[]'::jsonb,
  primary key (player_id, npc)
);
alter table npc_memory enable row level security;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on npc_memory from anon, authenticated;
  end if;
end $$;
