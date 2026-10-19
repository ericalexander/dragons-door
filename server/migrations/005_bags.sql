-- Bags: gear you're carrying but not using. Equipped pieces stay on players.weapon_id / armor_id.
alter table players add column if not exists bag_id int not null default 0;
-- A drop that didn't fit in the bag. One at a time; gone when you walk back into the forest or the day resets.
alter table players add column if not exists ground jsonb;

create table if not exists inventory (
  id          bigserial primary key,
  player_id   uuid not null references players(id) on delete cascade,
  slot        text not null check (slot in ('weapon','armor')),
  item_id     int  not null,
  acquired_at timestamptz not null default now()
);
create index if not exists inventory_player_idx on inventory(player_id);
alter table inventory enable row level security;
