-- What each player last connected with (plugin version, app, OS), and whether they've turned weather off.
-- No IP address or location is stored.
alter table players add column if not exists client jsonb;
alter table players add column if not exists weather_off boolean not null default false;
