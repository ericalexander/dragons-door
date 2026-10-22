-- Changing class: when it last happened (once a week at most).
alter table players add column if not exists respec_at timestamptz;
