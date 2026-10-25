-- Hand-placed places (a shrine, a ruin) live in the private lore with their tiles.
alter table lore drop constraint if exists lore_kind_check;
alter table lore add constraint lore_kind_check check (kind in ('world', 'person', 'mention', 'master', 'journal', 'quest', 'look', 'place'));
