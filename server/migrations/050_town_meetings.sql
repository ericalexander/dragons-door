-- Town meetings: a question put to a town (or the whole realm), voted on by players and townsfolk.
-- options: [{ id, label, appeals: [careful|bold|faith|profit|kin|curiosity|order|mercy], line? }]
-- The players' votes decide; the townsfolk's are the town's mood (and break a tie).
create table if not exists polls (
  id         bigserial primary key,
  town       text,                         -- null: the whole realm
  question   text not null,
  about      text not null default '',     -- how it's put in the fiction
  options    jsonb not null,
  opens      date not null,
  closes     date not null,                -- last day of voting; settled at the next reset
  status     text not null default 'open' check (status in ('open', 'closed')),
  result     jsonb,
  created_at timestamptz not null default now()
);
create table if not exists poll_votes (
  poll_id    bigint not null references polls(id) on delete cascade,
  player_id  uuid not null references players(id) on delete cascade,
  choice     text not null,
  townsfolk  boolean not null default false,
  why        text,
  day        date not null,
  primary key (poll_id, player_id)
);
alter table polls enable row level security;
alter table poll_votes enable row level security;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on polls from anon, authenticated;
    revoke all on poll_votes from anon, authenticated;
  end if;
end $$;
