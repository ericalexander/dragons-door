-- The realm's chronicle: one entry per realm day, written after it ends (by Claude when a key is set, else from templates).
create table if not exists chronicle (
  day date primary key,
  body text not null,
  source text not null check (source in ('claude', 'template')),
  created_at timestamptz not null default now()
);
alter table chronicle enable row level security;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on chronicle from anon, authenticated;
  end if;
end $$;
