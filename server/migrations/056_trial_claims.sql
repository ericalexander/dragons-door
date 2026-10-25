-- A trial character can be claimed in Claude Code with a one-time code, and becomes a real character.
alter table trials add column if not exists claim_hash text;
create unique index if not exists trials_claim_hash on trials (claim_hash) where claim_hash is not null;
