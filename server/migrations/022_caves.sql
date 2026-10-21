-- Caves, mining and Odile's workshop: jewelry worn, a pickaxe, how deep in a cave, ore in the bag,
-- and what each cave has given up today (it refills at the reset because it's counted per day).
alter table players add column if not exists trinket_id int not null default 0;
alter table players add column if not exists pickaxe boolean not null default false;
alter table players add column if not exists cave_depth int;
alter table inventory drop constraint if exists inventory_slot_check;
alter table inventory add constraint inventory_slot_check check (slot in ('weapon','armor','ore','trinket'));
create table if not exists mining (
  day date not null,
  x int not null,
  y int not null,
  player_id uuid not null references players(id) on delete cascade,
  n int not null default 0,
  primary key (day, x, y, player_id)
);
alter table mining enable row level security;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on mining from anon, authenticated;
  end if;
end $$;
-- Odile, the gemcutter: a fixed character, like Violet.
insert into players (name, api_key_hash, class, role, is_bot, location)
select 'Odile', md5(random()::text || clock_timestamp()::text) || md5(random()::text || 'Odile'), 'mage', 'npc', true, 'inn'
where not exists (select 1 from players p where lower(p.name) = 'odile');
-- Swings of the pick per day, apart from forest fights.
alter table turns add column if not exists swings int not null default 0;
