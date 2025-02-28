-- Fix RLS policies for token_stats_queue
-- Enable RLS on the table
ALTER TABLE token_stats_queue ENABLE ROW LEVEL SECURITY;

-- Create a policy that allows the anon role to insert into the queue
CREATE POLICY token_stats_queue_insert_policy
  ON token_stats_queue
  FOR INSERT
  TO anon
  WITH CHECK (true);

-- Create a policy that allows the anon role to select from the queue
CREATE POLICY token_stats_queue_select_policy
  ON token_stats_queue
  FOR SELECT
  TO anon
  USING (true);

-- Create a policy that allows the anon role to update the queue
CREATE POLICY token_stats_queue_update_policy
  ON token_stats_queue
  FOR UPDATE
  TO anon
  USING (true);

-- Create a policy that allows the anon role to delete from the queue
CREATE POLICY token_stats_queue_delete_policy
  ON token_stats_queue
  FOR DELETE
  TO anon
  USING (true);
