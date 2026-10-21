-- One system for every character. A player row's role says what it is:
--   player     a person playing
--   townsfolk  a scheduled local who plays the game (the bots table drives them)
--   npc        a fixed character (Violet, the bards): never ranked, fought, robbed, or played
alter table players add column if not exists role text not null default 'player';
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'players_role_check') then
    alter table players add constraint players_role_check check (role in ('player', 'townsfolk', 'npc'));
  end if;
end $$;
update players set role = 'townsfolk' where id in (select player_id from bots) and role = 'player';

-- Fixed characters can have longer names ("Dunstan the Unfinished").
do $$ declare c text; begin
  for c in select conname from pg_constraint where conrelid = 'players'::regclass and contype = 'c' and pg_get_constraintdef(oid) like '%length(name)%' loop
    execute format('alter table players drop constraint %I', c);
  end loop;
end $$;
alter table players add constraint players_name_length check (length(name) between 2 and case when role = 'npc' then 40 else 20 end);

-- Who you're married to. Each character can be married to one player at a time.
alter table players add column if not exists spouse_id uuid references players(id) on delete set null;
create unique index if not exists players_spouse_once on players (spouse_id) where spouse_id is not null;

-- The fixed characters. Their keys are random and unknown, so nobody can play as them.
insert into players (name, api_key_hash, class, role, is_bot, location)
select v.name, md5(random()::text || clock_timestamp()::text) || md5(random()::text || v.name), 'mage', 'npc', true, 'inn'
from (values ('Violet'), ('Fennick Reed'), ('Dunstan the Unfinished'), ('Corwin Lark'), ('Wren')) as v(name)
where not exists (select 1 from players p where lower(p.name) = lower(v.name));

-- Whoever married Violet most recently is married to her now.
update players set spouse_id = (select id from players where role = 'npc' and name = 'Violet')
where name = (select actor from news where kind = 'married' order by id desc limit 1)
  and role = 'player' and spouse_id is null
  and not exists (select 1 from players where spouse_id = (select id from players where role = 'npc' and name = 'Violet'));
