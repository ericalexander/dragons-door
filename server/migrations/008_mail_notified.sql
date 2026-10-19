-- Highest message id the player has been told about, so "a letter is waiting" shows once per arrival.
alter table players add column if not exists mail_notified_upto bigint not null default 0;
