-- The fight on the road below a town's walls, the first time you go there.
alter table encounters drop constraint if exists encounters_kind_check;
alter table encounters add constraint encounters_kind_check check (kind in ('forest', 'master', 'dragon', 'gate'));
