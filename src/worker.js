import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import axios from 'axios';

dotenv.config();

// Initialize Supabase client
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

// Configure Solana Tracker API client
const solanaTrackerApi = axios.create({
  baseURL: process.env.SOLANA_TRACKER_API_URL,
  headers: {
    'x-api-key': process.env.SOLANA_TRACKER_API_KEY
  }
});

const QUEUE_NAME = 'token_stats_queue';
const BATCH_SIZE = 1; // Process 1 message at a time due to rate limits
const VISIBILITY_TIMEOUT = 60; // 60 seconds
const RETRY_DELAY = 1100; // Wait slightly over 1 second between retries due to rate limit

async function processMessage(message) {
  const { mint } = message;
  console.log(`Processing stats for token ${mint}`);

  try {
    // Get detailed token stats
    const statsResponse = await solanaTrackerApi.get(`/stats/${mint}`);
    const stats = statsResponse.data;

    // Update token in database
    const { data: token, error: getError } = await supabase
      .from('tokens')
      .select('*')
      .eq('mint', mint)
      .single();

    if (getError) throw getError;

    if (token) {
      const updates = {
        cumulative_buy_volume: stats['24h']?.volume?.buys || 0,
        cumulative_net_volume: (stats['24h']?.volume?.buys || 0) - (stats['24h']?.volume?.sells || 0),
        last_updated: new Date().toISOString()
      };

      const { error: updateError } = await supabase
        .from('tokens')
        .update(updates)
        .eq('mint', mint);

      if (updateError) throw updateError;

      // Insert historical record
      const { error: historyError } = await supabase
        .from('historical_records')
        .insert({
          token_mint: mint,
          market_cap_usd: token.market_cap_usd,
          liquidity_usd: token.liquidity_usd,
          cumulative_buy_volume: updates.cumulative_buy_volume,
          cumulative_net_volume: updates.cumulative_net_volume
        });

      if (historyError) throw historyError;
      
      console.log(`Updated stats for token ${mint}`);
    }

    return true;
  } catch (error) {
    if (error.response?.status === 429) {
      // Rate limited, throw error to retry
      throw new Error('Rate limited');
    }
    console.error(`Failed to process token ${mint}:`, error);
    return false;
  }
}

async function worker() {
  console.log('Starting worker...');

  while (true) {
    try {
      // Read messages from queue
      const { data: messages, error } = await supabase.functions.invoke('read-messages', {
        body: {
          queue_name: QUEUE_NAME,
          batch_size: BATCH_SIZE,
          visibility_timeout: VISIBILITY_TIMEOUT
        }
      });

      if (error) throw error;

      if (!messages || messages.length === 0) {
        // No messages, wait before checking again
        await new Promise(resolve => setTimeout(resolve, 5000));
        continue;
      }

      // Process each message
      for (const message of messages) {
        try {
          const success = await processMessage(message.message);
          if (success) {
            // Delete message from queue
            await supabase.functions.invoke('delete-message', {
              body: {
                queue_name: QUEUE_NAME,
                message_id: message.message_id
              }
            });
          }
        } catch (error) {
          console.error('Error processing message:', error);
          // Message will become visible again after visibility timeout
        }

        // Wait before processing next message (rate limit)
        await new Promise(resolve => setTimeout(resolve, RETRY_DELAY));
      }
    } catch (error) {
      console.error('Worker error:', error);
      // Wait before retrying
      await new Promise(resolve => setTimeout(resolve, 5000));
    }
  }
}

// Start the worker
worker().catch(console.error);
