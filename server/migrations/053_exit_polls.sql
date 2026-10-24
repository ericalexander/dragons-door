-- Exit polls: for each choice, one townsperson who voted for it, saying why in their own voice.
-- { "<option id>": { "name": "...", "said": "..." } }
alter table polls add column if not exists interviews jsonb not null default '{}'::jsonb;
