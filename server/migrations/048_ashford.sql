-- Ashford: the third town, down the south road at the river ford. Home to the Shadow path.

-- Ashford's townsfolk are new kinds of people.
alter table bots drop constraint if exists bots_personality_check;
alter table bots add constraint bots_personality_check
  check (personality in ('banker','drunk','raider','gossip','pious','reckless','seer','braggart','veteran','scout','scholar','pickpocket','watchman','prelate'));

-- Ashford's fixed characters.
insert into players (name, api_key_hash, class, role, is_bot, location)
select n, md5(random()::text || clock_timestamp()::text) || md5(random()::text || n), c, 'npc', true, 'inn'
from (values ('Herald Ambrose Kettle', 'mage'), ('Agnes Fane', 'warrior'), ('Linnet', 'thief'), ('Octavia Strand', 'mage'),
             ('Sim Haverly', 'thief'), ('Ysolde Fairweather', 'mage'), ('Doctor Aurel Imre', 'priest'), ('Hesper Wick', 'thief')) as v(n, c)
where not exists (select 1 from players p where lower(p.name) = lower(v.n));
