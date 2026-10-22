-- The auction house's storeroom: what players and townsfolk have sold to the smith and to Odile
-- (trade-ins included). Cass lists from here instead of out of thin air.
create table if not exists house_stock (
  town text not null default 'brightwater',
  slot text not null check (slot in ('weapon', 'armor', 'ore', 'trinket', 'gem')),
  item_id int not null default 0,
  qty int not null default 0 check (qty >= 0),
  primary key (town, slot, item_id)
);
alter table house_stock enable row level security;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on house_stock from anon, authenticated;
  end if;
end $$;

-- The house's own lots so far were made up; take down the ones nobody has bid on.
update auctions a set status = 'cancelled', collected = true, settled_at = now()
from players s
where s.id = a.seller_id and s.role = 'npc' and a.status = 'open' and a.high_bid is null;
