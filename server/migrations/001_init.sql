-- Dragonmoor realm schema. Everything that matters lives here; the plugin holds only an API key.

create extension if not exists pgcrypto;

create table if not exists players (
  id            uuid primary key default gen_random_uuid(),
  name          text unique not null check (length(name) between 2 and 20),
  api_key_hash  text unique not null,
  class         text not null check (class in ('warrior','thief','mage')),
  level         int  not null default 1,
  exp           int  not null default 0,
  hp            int  not null default 20,
  max_hp        int  not null default 20,
  str           int  not null default 10,
  def           int  not null default 1,
  gold          int  not null default 100,   -- on hand, lost on death
  bank          int  not null default 0,     -- safe
  gems          int  not null default 0,
  charm         int  not null default 0,
  weapon_id     int  not null default 0,
  armor_id      int  not null default 0,
  alive         bool not null default true,
  location      text not null default 'fields' check (location in ('inn','fields')),
  dragon_kills  int  not null default 0,
  created_at    timestamptz not null default now(),
  last_seen     timestamptz not null default now()
);

-- One row per player per realm-day. Lazily created on first request of the day.
create table if not exists turns (
  player_id      uuid not null references players(id) on delete cascade,
  day            date not null,
  forest_fights  int  not null default 10,
  player_fights  int  not null default 3,
  specials       int  not null default 3,
  inn_used       bool not null default false,
  flirted        bool not null default false,
  bank_tx        int  not null default 0,
  primary key (player_id, day)
);

-- An open forest/master/dragon encounter. One per player. Deleted when it ends.
create table if not exists encounters (
  id          uuid primary key default gen_random_uuid(),
  player_id   uuid unique not null references players(id) on delete cascade,
  kind        text not null check (kind in ('forest','master','dragon')),
  monster     jsonb not null,
  round       int  not null default 0,
  log         jsonb not null default '[]'::jsonb,
  started_at  timestamptz not null default now()
);

create table if not exists news (
  id      bigserial primary key,
  day     date not null,
  kind    text not null,
  actor   text,
  target  text,
  detail  jsonb not null default '{}'::jsonb,
  ts      timestamptz not null default now()
);
create index if not exists news_day_idx on news(day, id);

create table if not exists tavern (
  id      bigserial primary key,
  day     date not null,
  author  text not null,
  body    text not null check (length(body) <= 280),
  ts      timestamptz not null default now()
);
create index if not exists tavern_day_idx on tavern(day, id);

-- Things that happened to a player while they were away (PvP results). Drained on next status.
create table if not exists mailbox (
  id         bigserial primary key,
  player_id  uuid not null references players(id) on delete cascade,
  event      jsonb not null,
  ts         timestamptz not null default now()
);
create index if not exists mailbox_player_idx on mailbox(player_id, id);

create table if not exists realm (
  key   text primary key,
  value jsonb not null
);
insert into realm (key, value) values
  ('reset_hour_utc', '5'),
  ('dragon_alive', 'true'),
  ('season', '1')
on conflict (key) do nothing;
