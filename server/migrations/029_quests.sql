-- Side quests: one row per quest a player has started, and quest items in the bag.
create table if not exists quests (
  id bigserial primary key,
  player_id uuid not null references players(id) on delete cascade,
  quest text not null,
  step text not null,
  data jsonb not null default '{}'::jsonb,
  status text not null default 'active' check (status in ('active', 'done', 'expired', 'abandoned')),
  outcome text,
  started_day date not null,
  step_day date not null,
  deadline date not null,
  ended_at timestamptz,
  unique (player_id, quest)
);
create index if not exists quests_active_idx on quests(player_id) where status = 'active';
alter table quests enable row level security;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on quests from anon, authenticated;
  end if;
end $$;
alter table inventory drop constraint if exists inventory_slot_check;
alter table inventory add constraint inventory_slot_check check (slot in ('weapon','armor','ore','trinket','quest'));
