-- Bags of marbles for the rare rolls a player feels (weddings, rare drops, quest offers, pieces of the past,
-- gossip): one red marble in a bag sized to the odds, drawn without putting the white ones back, and a fresh
-- bag once it's empty. Same odds in the long run, without the long dry streaks.
create table if not exists luck_bags (
  player_id uuid not null references players(id) on delete cascade,
  kind      text not null,
  size      int not null,   -- marbles when the bag was filled
  left_     int not null,   -- marbles still in it
  reds      int not null,   -- red marbles still in it (0 or 1)
  primary key (player_id, kind)
);
alter table luck_bags enable row level security;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on luck_bags from anon, authenticated;
  end if;
end $$;
