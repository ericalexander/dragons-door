-- What each townsperson is after: a goal, a mood, a grudge, and what they actually did today.
alter table bots add column if not exists mind jsonb not null default '{}'::jsonb;
