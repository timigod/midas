-- Enable required extensions
CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

-- Set up service role key as a database setting
-- Note: Replace 'your-service-role-key' with your actual service role key from Supabase dashboard
ALTER DATABASE postgres SET app.settings.service_role_key = 'your-service-role-key';

-- Drop existing cron jobs if they exist
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'discover_tokens') THEN
        PERFORM cron.unschedule('discover_tokens');
    END IF;
    
    IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'process_token_stats') THEN
        PERFORM cron.unschedule('process_token_stats');
    END IF;
    
    IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'archive_expired_tokens') THEN
        PERFORM cron.unschedule('archive_expired_tokens');
    END IF;
    
    IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'queue_tokens_for_processing') THEN
        PERFORM cron.unschedule('queue_tokens_for_processing');
    END IF;
END $$;

-- Schedule discover_tokens to run every hour
SELECT cron.schedule(
    'discover_tokens',
    '0 * * * *',  -- Every hour at minute 0
    $$
    SELECT net.http_post(
        url:='https://mgdagmkhveyrshpbitdd.supabase.co/functions/v1/discover',
        headers:='{"Authorization": "Bearer ' || current_setting('app.settings.service_role_key') || '"}'::jsonb
    ) AS request_id;
    $$
);

-- Schedule process-stats to run every minute
SELECT cron.schedule(
    'process_token_stats',
    '* * * * *',  -- Every minute
    $$
    SELECT net.http_post(
        url:='https://mgdagmkhveyrshpbitdd.supabase.co/functions/v1/process-stats',
        headers:='{"Authorization": "Bearer ' || current_setting('app.settings.service_role_key') || '"}'::jsonb
    ) AS request_id;
    $$
);

-- Schedule archive-expired to run every hour
SELECT cron.schedule(
    'archive_expired_tokens',
    '0 * * * *',  -- Every hour
    $$
    SELECT net.http_post(
        url:='https://mgdagmkhveyrshpbitdd.supabase.co/functions/v1/archive-expired',
        headers:='{"Authorization": "Bearer ' || current_setting('app.settings.service_role_key') || '"}'::jsonb
    ) AS request_id;
    $$
);

-- Schedule queue-tokens to run every 30 minutes
SELECT cron.schedule(
    'queue_tokens_for_processing',
    '*/30 * * * *',  -- Every 30 minutes
    $$
    SELECT net.http_post(
        url:='https://mgdagmkhveyrshpbitdd.supabase.co/functions/v1/queue-tokens',
        headers:='{"Authorization": "Bearer ' || current_setting('app.settings.service_role_key') || '"}'::jsonb
    ) AS request_id;
    $$
);
