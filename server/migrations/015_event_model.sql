-- Which Claude model a player was using, when their status line reports it.
alter table game_events add column if not exists model text;
