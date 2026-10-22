-- Priests: a fourth class, healers who cast holy spells and pray mid-fight.
do $$
declare c text;
begin
  select conname into c from pg_constraint where conrelid = 'players'::regclass and pg_get_constraintdef(oid) like '%warrior%thief%mage%';
  if c is not null then execute format('alter table players drop constraint %I', c); end if;
end $$;
alter table players add constraint players_class_check check (class in ('warrior','thief','mage','priest'));
-- Brother Ansel was always more monk than mage.
update players set class = 'priest' where name = 'Brother Ansel' and role = 'townsfolk';
-- Prior Hale keeps the chapel and teaches priests their spells: a fixed character.
insert into players (name, api_key_hash, class, role, is_bot, location)
select 'Prior Hale', md5(random()::text || clock_timestamp()::text) || md5(random()::text || 'Prior Hale'), 'priest', 'npc', true, 'inn'
where not exists (select 1 from players p where lower(p.name) = 'prior hale');
