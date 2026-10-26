-- Two kinds of townsperson anyone can share: the tavern regular and the night owl.
alter table bots drop constraint if exists bots_personality_check;
alter table bots add constraint bots_personality_check
  check (personality in ('banker','drunk','raider','gossip','pious','reckless','seer','braggart','veteran','scout','scholar','pickpocket','watchman','prelate','student','greenhorn','clerk','regular','nightowl'));
