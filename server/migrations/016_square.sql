-- One conversation with the day's visitor in the town square, per player per day.
alter table turns add column if not exists visitor_talked boolean not null default false;
