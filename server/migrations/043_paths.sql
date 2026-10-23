-- Paths and specializations. Everyone walks one of three paths (steel, shadow, gift); at level 5 they choose a
-- specialization, which is their class from then on. Everyone who exists today is already specialized: their
-- class is their specialization, and their path follows from it. Two new classes join the list for later.
alter table players add column if not exists path text;
alter table players add column if not exists specialized boolean not null default true;
update players set path = case when class = 'warrior' then 'steel' when class = 'thief' then 'shadow' else 'gift' end where path is null;
alter table players alter column path set not null;
alter table players drop constraint if exists players_path_check;
alter table players add constraint players_path_check check (path in ('steel', 'shadow', 'gift'));
alter table players drop constraint if exists players_class_check;
alter table players add constraint players_class_check check (class in ('warrior', 'thief', 'mage', 'priest', 'guardian', 'bard'));
-- A bard plays one set a day in a tavern, for tips.
alter table turns add column if not exists performed boolean not null default false;
-- Anything that inserts a player without a path (older server code mid-deploy) gets the one its class implies.
create or replace function players_fill_path() returns trigger language plpgsql as $$
begin
  if new.path is null then
    new.path := case when new.class in ('warrior', 'guardian') then 'steel' when new.class = 'thief' then 'shadow' else 'gift' end;
  end if;
  return new;
end $$;
drop trigger if exists players_fill_path on players;
create trigger players_fill_path before insert on players for each row execute function players_fill_path();
