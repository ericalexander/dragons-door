-- Bots are ordinary players driven by a daily server job instead of a person.
alter table players add column if not exists is_bot bool not null default false;

create table if not exists bots (
  player_id    uuid primary key references players(id) on delete cascade,
  personality  text not null check (personality in ('banker','drunk','raider','gossip')),
  api_key      text not null,
  last_run_day date
);
alter table bots enable row level security;
