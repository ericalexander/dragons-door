-- More people to court. Fixed characters, like Violet.
insert into players (name, api_key_hash, class, role, is_bot, location)
select v.name, md5(random()::text || clock_timestamp()::text) || md5(random()::text || v.name), 'mage', 'npc', true, 'inn'
from (values ('Rosalind'), ('Mara'), ('Jory')) as v(name)
where not exists (select 1 from players p where lower(p.name) = lower(v.name));
