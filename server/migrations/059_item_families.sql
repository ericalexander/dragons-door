-- Item families: every carried weapon and piece of armor gets its family for good, as family × 100 + tier.
-- Weapons: 1 Steel (warrior, guardian), 2 Shadow (thief), 3 mage, 4 priest, 5 bard.
-- Armor: 1 heavy (warrior, guardian), 2 leathers (thief), 3 robes (mage, priest), 4 performer's clothes (bard).
-- What's worn stays a plain tier (always the wearer's own family). Each carried thing takes the family of whoever
-- had it, which is what it already looked like to them; the house's own stock is Steel and heavy.
create or replace function pg_temp.wfam(cls text) returns int language sql immutable as $$
  select case cls when 'thief' then 2 when 'mage' then 3 when 'priest' then 4 when 'bard' then 5 else 1 end $$;
create or replace function pg_temp.afam(cls text) returns int language sql immutable as $$
  select case cls when 'thief' then 2 when 'mage' then 3 when 'priest' then 3 when 'bard' then 4 else 1 end $$;

update inventory i set item_id = (case when i.slot = 'weapon' then pg_temp.wfam(p.class) else pg_temp.afam(p.class) end) * 100 + i.item_id
  from players p where p.id = i.player_id and i.slot in ('weapon', 'armor') and i.item_id < 100;

update auctions a set item_id = coalesce((select case when a.slot = 'weapon' then pg_temp.wfam(p.class) else pg_temp.afam(p.class) end from players p where p.id = a.seller_id and p.role <> 'npc'), 1) * 100 + a.item_id
  where a.slot in ('weapon', 'armor') and a.item_id < 100;

update house_stock set item_id = 100 + item_id where slot in ('weapon', 'armor') and item_id < 100;

update gifts g set item_id = coalesce((select case when g.slot = 'weapon' then pg_temp.wfam(p.class) else pg_temp.afam(p.class) end from players p where p.id = g.from_player), 1) * 100 + g.item_id
  where g.slot in ('weapon', 'armor') and g.item_id is not null and g.item_id < 100;

update players set ground = jsonb_set(ground, '{item_id}', to_jsonb((case when ground->>'slot' = 'weapon' then pg_temp.wfam(class) else pg_temp.afam(class) end) * 100 + (ground->>'item_id')::int))
  where ground is not null and ground->>'slot' in ('weapon', 'armor') and (ground->>'item_id')::int < 100;
