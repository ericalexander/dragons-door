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
