-- When a townsperson or character answered a letter (null = not yet). Older letters count as answered.
alter table messages add column if not exists answered_at timestamptz;
update messages set answered_at = now() where answered_at is null and created_at < now();
create index if not exists messages_unanswered_idx on messages(id) where answered_at is null;
