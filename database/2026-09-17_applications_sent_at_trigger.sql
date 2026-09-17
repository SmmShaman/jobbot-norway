-- 2026-09-17: the fill agent sets applications.status='sent' by hand and once
-- (16.09, Kongsberg Automotive) forgot sent_at. /navreport and the 10-day
-- stats filter on sent_at, so such a row is invisible. Stamp it in the DB.
CREATE OR REPLACE FUNCTION public.applications_stamp_sent_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status = 'sent' AND NEW.sent_at IS NULL THEN
    NEW.sent_at := now();
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS applications_stamp_sent_at ON public.applications;
CREATE TRIGGER applications_stamp_sent_at
  BEFORE INSERT OR UPDATE OF status ON public.applications
  FOR EACH ROW EXECUTE FUNCTION public.applications_stamp_sent_at();

-- Backfill the one row that slipped through (sent 2026-09-16 09:10 UTC).
UPDATE public.applications SET sent_at = updated_at
 WHERE status = 'sent' AND sent_at IS NULL AND submission_method = 'agent';
