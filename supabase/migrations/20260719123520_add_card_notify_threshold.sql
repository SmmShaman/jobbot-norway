-- Configurable per-user threshold for Telegram job-card notifications (2026-07-19).
-- Jobs below this score are still analyzed and stored, but do not get a per-job
-- Telegram card push -- they're summarized as a single "filtered out" count line
-- in the evening digest instead. Distinct from track_policies.min_score (auto-mode
-- eligibility) and the 70-point manual-confirmation batch cutoff.
ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS card_notify_min_score integer DEFAULT 40;
COMMENT ON COLUMN user_settings.card_notify_min_score IS
  'Minimum relevance_score for a job to get a per-job Telegram card push. Below this, the job is still analyzed and stored, just not pushed as a card -- counted instead in the evening digest as filtered/irrelevant.';
