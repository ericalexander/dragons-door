-- The keeper's tools: banning, renaming, hiding tavern posts, and a log of every action taken.
alter table players add column if not exists banned_at timestamptz;
alter table players add column if not exists renamed_from text;
alter table tavern add column if not exists hidden_at timestamptz;
create table if not exists admin_log (
  id bigserial primary key,
  at timestamptz not null default now(),
  admin text not null,
  action text not null,
  target text,
  detail jsonb not null default '{}'::jsonb
);
alter table admin_log enable row level security;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on admin_log from anon, authenticated;
  end if;
end $$;
