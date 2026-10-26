-- Della Moss, the clothier on Market Row: a fixed character, like Odile. Robes, performers' clothes, leathers and bags.
insert into players (name, api_key_hash, class, role, is_bot, location)
select 'Della Moss', md5(random()::text || clock_timestamp()::text) || md5(random()::text || 'Della Moss'), 'bard', 'npc', true, 'inn'
where not exists (select 1 from players p where lower(p.name) = 'della moss');
