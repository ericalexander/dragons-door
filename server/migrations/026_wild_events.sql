-- Wild events: one waiting for an answer per player, and how many turned up today.
alter table players add column if not exists pending_event jsonb;
alter table turns add column if not exists events_seen int not null default 0;
