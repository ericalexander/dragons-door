-- The auction house on Market Row. Listings belong to a town; houses in different towns share one
-- board, so a listing in one town can be bought from another once there are more towns.
create table if not exists auctions (
  id bigserial primary key,
  town text not null default 'brightwater',
  seller_id uuid references players(id) on delete set null,
  slot text not null check (slot in ('weapon', 'armor', 'ore', 'trinket', 'gem')),
  item_id int not null default 0,
  qty int not null default 1 check (qty > 0),
  min_bid int not null check (min_bid > 0),
  buy_now int check (buy_now is null or buy_now >= min_bid),
  high_bid int,
  high_bidder uuid references players(id) on delete set null,
  status text not null default 'open' check (status in ('open', 'sold', 'expired', 'cancelled')),
  listed_day date not null,
  ends_day date not null,
  -- Whoever is owed the item (the buyer if sold, the seller if not) picks it up at the house.
  collected boolean not null default false,
  created_at timestamptz not null default now(),
  settled_at timestamptz
);
create index if not exists auctions_open on auctions (status, ends_day);
create index if not exists auctions_seller on auctions (seller_id, status);
create index if not exists auctions_bidder on auctions (high_bidder, status);

alter table auctions enable row level security;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on auctions from anon, authenticated;
  end if;
end $$;

-- Cass Marrow, who runs the house: a fixed character, like Odile.
insert into players (name, api_key_hash, class, role, is_bot, location)
select 'Cass Marrow', md5(random()::text || clock_timestamp()::text) || md5(random()::text || 'Cass Marrow'), 'thief', 'npc', true, 'inn'
where not exists (select 1 from players p where lower(p.name) = 'cass marrow');
