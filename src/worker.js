import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import axios from 'axios';

dotenv.config();

// Initialize Supabase client
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

// Initialize Supabase service role client for admin operations
const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
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
      
      // Check if token meets hotness criteria
      const marketCapGrowth = token.market_cap_usd >= 3 * token.start_market_cap;
      const buyVolumeRatio = (updates.cumulative_buy_volume / token.market_cap_usd) >= 0.05;
      const positiveNetVolume = updates.cumulative_net_volume > 0;
      const liquidityRatio = token.liquidity_usd >= 0.03 * token.market_cap_usd;

      const isHot = marketCapGrowth && buyVolumeRatio && positiveNetVolume && liquidityRatio;

      if (isHot) {
        // Insert into token_hotness table using admin client to bypass RLS
        const { error: hotnessError } = await supabaseAdmin
          .from('token_hotness')
          .insert({
            token_mint: mint,
            detected_at: new Date().toISOString(),
            market_cap_usd: token.market_cap_usd,
            start_market_cap: token.start_market_cap,
            liquidity_usd: token.liquidity_usd,
            cumulative_buy_volume: updates.cumulative_buy_volume,
            cumulative_net_volume: updates.cumulative_net_volume
          });

        if (hotnessError) throw hotnessError;
        
        console.log(`Token ${mint} marked as HOT! Market cap growth: ${token.market_cap_usd / token.start_market_cap}x, Buy volume ratio: ${updates.cumulative_buy_volume / token.market_cap_usd}, Net volume: ${updates.cumulative_net_volume}, Liquidity ratio: ${token.liquidity_usd / token.market_cap_usd}`);
      }
      
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
      console.log('Checking for messages...');
      // Read messages from queue
      const { data, error } = await supabase.functions.invoke('read-messages', {
        body: {
          queue_name: QUEUE_NAME,
          batch_size: BATCH_SIZE,
          visibility_timeout: VISIBILITY_TIMEOUT
        }
      });

      if (error) {
        console.error('Error reading messages:', error);
        throw error;
      }

      console.log('Response from read-messages:', JSON.stringify(data));

      // Extract messages from the data property
      const messages = data?.data || [];
      console.log(`Found ${messages.length} messages`);

      if (messages.length === 0) {
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
