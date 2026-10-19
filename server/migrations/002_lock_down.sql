-- On Supabase, public tables are exposed over REST unless RLS is on.
-- The game server connects as the owner role and bypasses RLS; nothing else gets in.
alter table players    enable row level security;
alter table turns      enable row level security;
alter table encounters enable row level security;
alter table news       enable row level security;
alter table tavern     enable row level security;
alter table mailbox    enable row level security;
alter table realm      enable row level security;
