-- Cleanup expired application_confirmations records
-- Confirmations expire (expires_at < NOW()) but are never deleted automatically.
-- This function is called by the Python worker cleanup cycle.

CREATE OR REPLACE FUNCTION cleanup_expired_confirmations()
RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    deleted_count int;
BEGIN
    DELETE FROM application_confirmations
    WHERE expires_at < NOW();

    GET DIAGNOSTICS deleted_count = ROW_COUNT;
    RETURN deleted_count;
END;
$$;

-- Also cleanup expired finn_auth_requests older than 2 hours
CREATE OR REPLACE FUNCTION cleanup_expired_finn_auth_requests()
RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    deleted_count int;
BEGIN
    DELETE FROM finn_auth_requests
    WHERE expires_at < NOW() - INTERVAL '2 hours';

    GET DIAGNOSTICS deleted_count = ROW_COUNT;
    RETURN deleted_count;
END;
$$;
