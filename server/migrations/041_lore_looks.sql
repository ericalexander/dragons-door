-- How people look: a new kind of lore row (the description, and for a few, their manner).
alter table lore drop constraint if exists lore_kind_check;
alter table lore add constraint lore_kind_check check (kind in ('world', 'person', 'mention', 'master', 'journal', 'quest', 'look'));
