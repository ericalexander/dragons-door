-- Endgame gold drops are six figures per kill; 32-bit columns would overflow a long-lived banker.
alter table players
  alter column gold type bigint,
  alter column bank type bigint,
  alter column exp  type bigint;

-- Tavern posts per realm-day, so one player can't bury the board.
alter table turns add column if not exists tavern_posts int not null default 0;

-- Registration invites (only enforced when REALM_INVITE is set; see api.ts).
-- Names: no leading/trailing/double spaces, so "Eric " can't impersonate "Eric".
alter table players add constraint players_name_tidy check (name = btrim(name) and name !~ '  ');
