-- A meeting can name a sketch for the website to draw beside it (web/meetings.html keeps the drawings).
alter table polls add column if not exists art text;
