-- Which narrator model each trial got (for comparing them), and what each trial cost.
alter table trials add column if not exists model text;
alter table trial_log add column if not exists model text;
alter table trial_log add column if not exists micro_usd bigint not null default 0;
