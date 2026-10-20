-- Highest news id each player has read, for the status line's "⚔ N". Existing players start caught up.
alter table players add column if not exists news_seen_upto bigint not null default 0;
update players set news_seen_upto = (select coalesce(max(id), 0) from news) where news_seen_upto = 0;
