-- Gifts by courier: gold, gems or one item sent with a letter, arriving at the next dawn.
-- state: sent (on the road, or waiting to be collected once arrives_day comes), collected, kept (a townsperson
-- or character took it), returned (unclaimed after a week, on its way back; from/to are swapped), lost.
create table if not exists gifts (
  id          bigserial primary key,
  message_id  bigint references messages(id) on delete set null,
  from_player uuid references players(id) on delete set null,
  to_player   uuid not null references players(id) on delete cascade,
  gold        integer not null default 0 check (gold >= 0),
  gems        integer not null default 0 check (gems >= 0),
  slot        text,
  item_id     integer,
  rarity      integer not null default 0,
  fee         integer not null default 0,
  sent_day    date not null,
  arrives_day date not null,
  state       text not null default 'sent' check (state in ('sent', 'collected', 'kept', 'returned', 'lost')),
  returned    boolean not null default false,
  created_at  timestamptz not null default now(),
  settled_at  timestamptz
);
create index if not exists gifts_to_idx on gifts(to_player, state);
create index if not exists gifts_from_idx on gifts(from_player, sent_day);
alter table gifts enable row level security;
