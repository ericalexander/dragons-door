-- Which of today's scheduled sessions each townsperson has already played.
alter table bots add column if not exists sessions jsonb not null default '{}'::jsonb;
