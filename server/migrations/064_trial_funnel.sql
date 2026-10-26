-- The trial funnel, kept with each trial so the trials dashboard can draw it: when the visitor reached
-- the last move, and when they copied the install steps or their claim code.
alter table trial_log add column if not exists finished_at timestamptz;
alter table trial_log add column if not exists install_copied_at timestamptz;
alter table trial_log add column if not exists claim_copied_at timestamptz;
