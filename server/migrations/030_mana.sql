-- Mana for casters (mages for now): a daily pool on the turns row. Today's mages get theirs now.
alter table turns add column if not exists mana int not null default 0;
update turns t set mana = 20 + 5 * p.level from players p where p.id = t.player_id and p.class = 'mage' and t.mana = 0;
-- Mother Quill, who keeps the library and teaches spells: a fixed character, like Odile.
insert into players (name, api_key_hash, class, role, is_bot, location)
select 'Mother Quill', md5(random()::text || clock_timestamp()::text) || md5(random()::text || 'Mother Quill'), 'mage', 'npc', true, 'inn'
where not exists (select 1 from players p where lower(p.name) = 'mother quill');
