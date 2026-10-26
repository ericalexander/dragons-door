-- Three newcomers, one per town, who start at level 1 like the players: a student, a greenhorn and a clerk.
alter table bots drop constraint if exists bots_personality_check;
alter table bots add constraint bots_personality_check
  check (personality in ('banker','drunk','raider','gossip','pious','reckless','seer','braggart','veteran','scout','scholar','pickpocket','watchman','prelate','student','greenhorn','clerk'));
