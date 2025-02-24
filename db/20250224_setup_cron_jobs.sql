-- Migration: Setup cron jobs for token discovery and processing
-- Date: 2025-02-24

-- Enable required extensions
CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

-- Set up service role key as a database setting
-- Note: Replace 'your-service-role-key' with your actual service role key
ALTER DATABASE postgres SET app.settings.service_role_key = 'your-service-role-key';

-- Drop existing jobs if they exist (for clean setup)
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'discover_tokens') THEN
        PERFORM cron.unschedule('discover_tokens');
    END IF;
    
    IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'process_token_stats') THEN
        PERFORM cron.unschedule('process_token_stats');
    END IF;
    
    IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'reset_stuck_messages') THEN
        PERFORM cron.unschedule('reset_stuck_messages');
    END IF;
END $$;

-- Schedule discover_tokens to run every hour
SELECT cron.schedule(
    'discover_tokens',
    '0 * * * *',  -- Every hour at minute 0
    $$
    SELECT net.http_post(
        url:='https://mgdagmkhveyrshpbitdd.supabase.co/functions/v1/discover',
        headers:='{"Authorization": "Bearer ' || current_setting('app.settings.service_role_key') || '"}'
    ) AS request_id;
    $$
);

-- Schedule process_token_stats to run every 15 minutes
SELECT cron.schedule(
    'process_token_stats',
    '*/15 * * * *',  -- Every 15 minutes
    $$
    SELECT net.http_post(
        url:='https://mgdagmkhveyrshpbitdd.supabase.co/functions/v1/process-stats',
        headers:='{"Authorization": "Bearer ' || current_setting('app.settings.service_role_key') || '"}'
    ) AS request_id;
    $$
);

-- Schedule cleanup of stuck messages daily at midnight
SELECT cron.schedule(
    'reset_stuck_messages',
    '0 0 * * *',  -- Every day at midnight
    $$
    UPDATE public.token_stats_queue
    SET status = 'pending',
        visible_after = NULL,
        updated_at = NOW()
    WHERE status = 'processing'
    AND updated_at < NOW() - INTERVAL '1 hour';
    $$
);

-- Grant necessary permissions
GRANT USAGE ON SCHEMA cron TO postgres;
GRANT ALL ON ALL TABLES IN SCHEMA cron TO postgres;

-- Verify scheduled jobs
SELECT jobid, schedule, command, nodename, nodeport, database, username
FROM cron.job;
