-- How townsfolk get on with each other: the days two of them spent in the same tavern or square (a before b by
-- name, one row a pair), and which turn in it the news has already told (fast friends, a falling-out).
create table if not exists bonds (
  a             text not null,
  b             text not null,
  together      integer not null default 0,
  last_together date,
  told          text,
  primary key (a, b),
  check (a < b)
);
alter table bonds enable row level security;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on bonds from anon, authenticated;
  end if;
end $$;
