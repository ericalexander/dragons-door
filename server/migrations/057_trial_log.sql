-- A record of each trial that outlives the trial character, so we can see how trials go: how far people get,
-- what they do, how it ends, and where the narrator stumbled. No names. The conversation itself is kept with
-- it for 30 days (for the realm's keeper to read, as the privacy page says), then dropped.
create table if not exists trial_log (
  id            uuid primary key,            -- the trial character's id while it lived (no link: the character goes)
  started_at    timestamptz not null default now(),
  path          text not null,
  moves         int not null default 0,
  last_move_at  timestamptz,
  counts        jsonb not null default '{}', -- fights, wins, deaths, level_ups, places, people, songs, quests, journals, loot
  tools         jsonb not null default '{}', -- game calls the narrator made, by tool
  issues        jsonb not null default '[]', -- narrator trouble: cut off, self-talk, failed calls (kind, move, when)
  ended         text,                        -- claimed | expired (null while it's running)
  ended_at      timestamptz,
  transcript    jsonb                         -- [{ said, told, at }], kept 30 days
);
create index if not exists trial_log_started on trial_log (started_at);
alter table trial_log enable row level security;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on trial_log from anon, authenticated;
  end if;
end $$;
