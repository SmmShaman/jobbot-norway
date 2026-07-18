DO $$
DECLARE def text;
BEGIN
  SELECT pg_get_constraintdef(oid) INTO def
  FROM pg_constraint
  WHERE conrelid = 'applications'::regclass
    AND conname = 'applications_status_check';
  IF def IS NOT NULL AND def NOT LIKE '%pending_manual%' THEN
    EXECUTE 'ALTER TABLE applications DROP CONSTRAINT applications_status_check';
    def := replace(def, ']))', ', ''pending_manual'', ''pending_manual_failed''::text]))');
    EXECUTE 'ALTER TABLE applications ADD CONSTRAINT applications_status_check ' || def;
  END IF;
END $$;
