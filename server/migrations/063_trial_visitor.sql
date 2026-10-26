-- The trial page's anonymous analytics id, so a claim in Claude Code can close the visitor's funnel.
alter table trial_log add column if not exists visitor text;
