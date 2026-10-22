-- A townsperson can be away on an errand for a few days: living in another town (walking there,
-- sleeping there, drinking in its tavern) until a day, then home again. Quests start them.
-- { to: "brightwater" | "ironhold", until: "YYYY-MM-DD", why: text, lines?: { [name]: [text] } }
alter table bots add column if not exists errand jsonb;
