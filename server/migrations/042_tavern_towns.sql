-- Each tavern keeps its own board: Brightwater's tavern and Ironhold's Long Hall. Posts so far were all
-- on the one shared board; they stay on Brightwater's.
alter table tavern add column if not exists town text not null default 'brightwater';
create index if not exists tavern_town_day on tavern (town, day);
