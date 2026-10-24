-- Live chat, drawn only in the side pane (never sent to the narrator): one room per town (and "the road" for
-- anyone in the wild), plus whispers to one player.
create table if not exists chat (
  id          bigserial primary key,
  room        text not null,
  from_player uuid not null references players(id) on delete cascade,
  to_player   uuid references players(id) on delete cascade,
  body        text not null check (length(body) between 1 and 240),
  created_at  timestamptz not null default now(),
  hidden_at   timestamptz
);
create index if not exists chat_room_idx on chat(room, id);
create index if not exists chat_to_idx on chat(to_player, id) where to_player is not null;
create index if not exists chat_from_idx on chat(from_player, created_at);
alter table chat enable row level security;
