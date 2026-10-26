-- Herbs and potions: herbs foraged in the wild, potions brewed from recipes the healers sell.
alter table inventory drop constraint if exists inventory_slot_check;
alter table inventory add constraint inventory_slot_check check (slot in ('weapon','armor','ore','trinket','quest','herb','potion'));
alter table auctions drop constraint if exists auctions_slot_check;
alter table auctions add constraint auctions_slot_check check (slot in ('weapon','armor','ore','trinket','gem','herb','potion'));
alter table house_stock drop constraint if exists house_stock_slot_check;
alter table house_stock add constraint house_stock_slot_check check (slot in ('weapon','armor','ore','trinket','gem','herb','potion'));

-- Searches of the ground today, apart from turns.
alter table turns add column if not exists forages int not null default 0;
-- A draught drunk for the fight: {name, str?, def?}, cleared when that fight ends.
alter table players add column if not exists boost jsonb;
-- One draught a fight.
alter table encounters add column if not exists drank boolean not null default false;

-- Recipes a player has bought, and how many times they've brewed each (practice; never shown as a number).
create table if not exists recipes (
  player_id  uuid not null references players(id) on delete cascade,
  potion     int not null,
  brewed     int not null default 0,
  learned_day date not null,
  primary key (player_id, potion)
);
alter table recipes enable row level security;
