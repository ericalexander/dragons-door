-- Ironhold: a second town far out in the hills, with its own people, a forge and an auction house.

-- Gear rarity (0 Common .. 4 Mythic), on what's worn, carried, auctioned and in a house's storeroom.
alter table players add column if not exists weapon_rarity int not null default 0;
alter table players add column if not exists armor_rarity int not null default 0;
alter table inventory add column if not exists rarity int not null default 0;
alter table auctions add column if not exists rarity int not null default 0;
alter table house_stock add column if not exists rarity int not null default 0;
alter table house_stock drop constraint if exists house_stock_pkey;
alter table house_stock add primary key (town, slot, item_id, rarity);

-- Ironhold's townsfolk are new kinds of people.
alter table bots drop constraint if exists bots_personality_check;
alter table bots add constraint bots_personality_check
  check (personality in ('banker','drunk','raider','gossip','pious','reckless','seer','braggart','veteran','scout','scholar'));

-- Where a townsperson lives. Brightwater's square only shows its own.
alter table bots add column if not exists home text not null default 'brightwater';

-- Ironhold's fixed characters.
insert into players (name, api_key_hash, class, role, is_bot, location)
select n, md5(random()::text || clock_timestamp()::text) || md5(random()::text || n), c, 'npc', true, 'inn'
from (values ('Sergeant Rusk', 'warrior'), ('Brannagh Steel', 'warrior'), ('Mabry Locke', 'thief'), ('Jessamy Crane', 'priest'), ('Corra Bell', 'thief')) as v(n, c)
where not exists (select 1 from players p where lower(p.name) = lower(v.n));
