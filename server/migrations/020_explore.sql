-- Where each player stands in the wild (null = in town), what they've explored, and who found what first.
alter table players add column if not exists pos_x int;
alter table players add column if not exists pos_y int;
create table if not exists explored (
  player_id uuid not null references players(id) on delete cascade,
  x int not null,
  y int not null,
  at timestamptz not null default now(),
  primary key (player_id, x, y)
);
create table if not exists discoveries (
  x int not null,
  y int not null,
  name text not null,
  terrain text not null,
  poi text,
  found_by uuid references players(id) on delete set null,
  found_at timestamptz not null default now(),
  primary key (x, y)
);
alter table explored enable row level security;
alter table discoveries enable row level security;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on explored from anon, authenticated;
    revoke all on discoveries from anon, authenticated;
  end if;
end $$;
