-- Where a character started: warriors and thieves made from now on start in Ironhold. They return there,
-- and wake there after dying. Everyone made before this started in Brightwater.
alter table players add column if not exists start_town text not null default 'brightwater';
update players p set start_town = 'ironhold' from bots b where b.player_id = p.id and b.home = 'ironhold';

-- Ironhold's armory, for armor and bags.
insert into players (name, api_key_hash, class, role, is_bot, location)
select 'Tobin Harrow', md5(random()::text || clock_timestamp()::text) || md5(random()::text || 'Tobin Harrow'), 'warrior', 'npc', true, 'inn'
where not exists (select 1 from players p where lower(p.name) = 'tobin harrow');
