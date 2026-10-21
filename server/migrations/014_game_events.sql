-- What happens in the realm, for checking real play against the simulator. Game facts only:
-- no names, no text players wrote, no location. Townsfolk are flagged so they can be left out.
create table if not exists game_events (
  id         bigserial primary key,
  ts         timestamptz not null default now(),
  day        text not null,
  player_id  uuid references players(id) on delete set null,
  class      text not null,
  level      int  not null,
  is_bot     boolean not null default false,
  plugin     text,
  kind       text not null,
  data       jsonb not null default '{}'::jsonb
);
create index if not exists game_events_kind_day_idx on game_events (kind, day);
create index if not exists game_events_player_idx on game_events (player_id, ts);
alter table game_events enable row level security;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then revoke all on game_events from anon, authenticated; end if;
end $$;

-- Real players only, by class: how fights go and how often people die.
create or replace view balance_by_class with (security_invoker = true) as
select class,
       count(*) filter (where kind = 'fight_end' and data->>'encounter' = 'forest')                               as forest_fights,
       round(avg((data->>'rounds')::numeric) filter (where kind = 'fight_end' and data->>'encounter' = 'forest'), 2) as avg_rounds,
       round(100.0 * count(*) filter (where kind = 'fight_end' and data->>'outcome' = 'won')
             / nullif(count(*) filter (where kind = 'fight_end'), 0), 1)                                          as win_pct,
       count(*) filter (where kind = 'fight_end' and data->>'outcome' = 'died')                                  as deaths,
       count(*) filter (where kind = 'fight_end' and data->>'outcome' = 'fled')                                  as fled,
       round(avg((data->>'crits')::numeric) filter (where kind = 'fight_end'), 2)                                as crits_per_fight,
       count(*) filter (where kind = 'loot')                                                                     as loot_drops,
       count(*) filter (where kind = 'level_up')                                                                 as level_ups,
       count(distinct player_id)                                                                                 as players,
       count(distinct (player_id, day)) filter (where kind = 'day_start')                                       as player_days
from game_events where not is_bot
group by class;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then revoke all on balance_by_class from anon, authenticated; end if;
end $$;
