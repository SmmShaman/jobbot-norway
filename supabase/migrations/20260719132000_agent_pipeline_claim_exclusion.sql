-- Agent-driven Playwright pipeline takes over external-form submissions from
-- the legacy Python worker (Skyvern). The legacy worker's claim_applications()
-- must skip any row already marked submission_method='agent', so the two
-- pipelines never race for the same application. FINN Enkel Soknad is
-- untouched -- it keeps going through the legacy worker/Skyvern for now.
CREATE OR REPLACE FUNCTION claim_applications(
  p_worker_id text,
  p_limit integer DEFAULT 10
)
RETURNS SETOF applications
LANGUAGE sql
AS $$
  UPDATE applications
  SET worker_id = p_worker_id,
      claimed_at = now(),
      status = CASE WHEN status = 'approved' THEN 'sending' ELSE status END
  WHERE id IN (
    SELECT id FROM applications
    WHERE status IN ('sending', 'approved')
      AND worker_id IS NULL
      AND submission_method IS DISTINCT FROM 'agent'
    ORDER BY created_at ASC
    LIMIT p_limit
    FOR UPDATE SKIP LOCKED
  )
  RETURNING *;
$$;
