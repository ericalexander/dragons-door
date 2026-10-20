-- Four more townsfolk personalities.
alter table bots drop constraint if exists bots_personality_check;
alter table bots add constraint bots_personality_check
  check (personality in ('banker','drunk','raider','gossip','pious','reckless','seer','braggart'));
