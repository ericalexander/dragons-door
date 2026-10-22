-- The realm's lore. The words live only in the database, never in the code or on the website:
-- players learn them in play, a piece at a time.
create table if not exists lore (
  key text primary key,            -- world | person:<name>:<n> | mention:<name>:<n> | master:<level> | journal:<slug> | quest:<id>
  kind text not null check (kind in ('world', 'person', 'mention', 'master', 'journal', 'quest')),
  subject text,
  piece int,
  body text not null default '',
  data jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

-- What each player has learned: pieces of someone's past, journals they found.
create table if not exists player_lore (
  player_id uuid not null references players(id) on delete cascade,
  key text not null,
  day date not null,
  how text,
  primary key (player_id, key)
);

alter table lore enable row level security;
alter table player_lore enable row level security;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on lore from anon, authenticated;
    revoke all on player_lore from anon, authenticated;
  end if;
end $$;
