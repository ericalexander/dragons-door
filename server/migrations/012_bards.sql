-- One song from the tavern's bard per player per day.
alter table turns add column if not exists bard_heard boolean not null default false;
