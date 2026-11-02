-- Townsfolk who do harm in secret. Who they are lives in the lore table (kind 'shadow'), never in code; what
-- they did, day by day, is here: one row a shadow a day, which is also the lock against doing it twice.
alter table lore drop constraint if exists lore_kind_check;
alter table lore add constraint lore_kind_check check (kind in ('world', 'person', 'mention', 'master', 'journal', 'quest', 'look', 'place', 'riddle', 'shadow'));

create table if not exists shadow_deeds (
  day     date not null,
  key     text not null,
  deed    text not null,
  town    text,
  detail  jsonb not null default '{}'::jsonb,
  ts      timestamptz not null default now(),
  primary key (day, key)
);
create index if not exists shadow_deeds_town_idx on shadow_deeds (town, day);
alter table shadow_deeds enable row level security;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on shadow_deeds from anon, authenticated;
  end if;
end $$;
