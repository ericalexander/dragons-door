-- The bridge troll's riddles live in the lore table (kind 'riddle'), with their answers, never in the code.
alter table lore drop constraint if exists lore_kind_check;
alter table lore add constraint lore_kind_check check (kind in ('world', 'person', 'mention', 'master', 'journal', 'quest', 'look', 'place', 'riddle'));
