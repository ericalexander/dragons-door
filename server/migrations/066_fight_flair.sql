-- Fights told plainly: no comic-book sounds, prayers, incantations, noir or oaths (bards still sing).
alter table players add column if not exists plain_fights boolean not null default false;
