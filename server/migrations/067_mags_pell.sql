-- Mags Pell, who keeps the music room on Ashford's Exchange: a fixed character, like Della Moss. Instruments,
-- stage clothes and bards' level tests.
insert into players (name, api_key_hash, class, role, is_bot, location)
select 'Mags Pell', md5(random()::text || clock_timestamp()::text) || md5(random()::text || 'Mags Pell'), 'bard', 'npc', true, 'inn'
where not exists (select 1 from players p where lower(p.name) = 'mags pell');
