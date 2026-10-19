-- Player-to-player mail. (The older `mailbox` table holds system events like "you were robbed".)
create table if not exists messages (
  id          bigserial primary key,
  from_player uuid not null references players(id) on delete cascade,
  to_player   uuid not null references players(id) on delete cascade,
  body        text not null check (length(body) between 1 and 500),
  created_at  timestamptz not null default now(),
  read_at     timestamptz
);
create index if not exists messages_to_unread_idx on messages(to_player, id) where read_at is null;
create index if not exists messages_to_idx on messages(to_player, id);
alter table messages enable row level security;

create table if not exists mutes (
  player_id uuid not null references players(id) on delete cascade,
  muted_id  uuid not null references players(id) on delete cascade,
  primary key (player_id, muted_id)
);
alter table mutes enable row level security;

alter table turns add column if not exists messages_sent int not null default 0;
