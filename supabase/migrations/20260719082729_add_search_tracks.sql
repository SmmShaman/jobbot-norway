-- Search tracks: nav_quota (NAV activity-report jobs) vs career (leadership/IT jobs, LinkedIn).
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS track text DEFAULT 'nav_quota'
  CHECK (track IN ('nav_quota', 'career'));
COMMENT ON COLUMN jobs.track IS
  'nav_quota: NAV activity-report track, hard-requirement gate. career: leadership/IT track, higher score bar, auto_submit never allowed.';
CREATE INDEX IF NOT EXISTS idx_jobs_track ON jobs(track);

CREATE TABLE IF NOT EXISTS track_policies (
  track text PRIMARY KEY CHECK (track IN ('nav_quota', 'career')),
  min_score integer NOT NULL,
  auto_submit_allowed boolean NOT NULL DEFAULT false,
  letter_style text NOT NULL,
  daily_limit integer,
  updated_at timestamptz DEFAULT now()
);
COMMENT ON TABLE track_policies IS
  'Global config, not per-user. auto_submit_allowed is toggled via the /automode bot command, never edited by hand.';

INSERT INTO track_policies (track, min_score, auto_submit_allowed, letter_style, daily_limit) VALUES
  ('nav_quota', 60, false, 'standard', 10),
  ('career',    70, false, 'wide_individual', NULL)
ON CONFLICT (track) DO NOTHING;
