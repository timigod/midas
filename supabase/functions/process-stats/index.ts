import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.39.0'
import { Token, TokenStats, QueueMessage, QueueMessageWithId, RETRY_CONFIG, calculateNextRetryTime } from '../_shared/types.ts'

// Initialize Supabase client
const supabaseUrl = Deno.env.get('SUPABASE_URL')!
const supabaseKey = Deno.env.get('SUPABASE_ANON_KEY')!
const supabase = createClient(supabaseUrl, supabaseKey)

// Configure Solana Tracker API
const SOLANA_TRACKER_API_URL = Deno.env.get('SOLANA_TRACKER_API_URL')!
const SOLANA_TRACKER_API_KEY = Deno.env.get('SOLANA_TRACKER_API_KEY')!

// Queue name for stats processing
const QUEUE_NAME = 'token_stats_queue'

Deno.serve(async (req) => {
  try {
    // Get messages from queue that are ready to be processed
    const currentTime = new Date().toISOString();
    const { data: messages, error: readError } = await supabase.functions.invoke('read-messages', {
      body: {
        queue_name: QUEUE_NAME,
        batch_size: 1,
        visibility_timeout: 60,
        // Only get messages that are ready to be retried
        filter: `nextRetryTime IS NULL OR nextRetryTime <= '${currentTime}'`
      }
    })

    if (readError) throw readError
    if (!messages || messages.length === 0) {
      return new Response(
        JSON.stringify({ message: 'No messages to process' }),
        { headers: { 'Content-Type': 'application/json' }, status: 200 }
      )
    }

    // Process each message
    for (const message of messages) {
      const queueMessage = message.message as QueueMessage
      const { mint, retryCount } = queueMessage

      try {
        // Get token stats
        const statsResponse = await fetch(`${SOLANA_TRACKER_API_URL}/stats/${mint}`, {
          headers: {
            'x-api-key': SOLANA_TRACKER_API_KEY
          },
          method: 'GET'
        })

        if (!statsResponse.ok) {
          if (statsResponse.status === 429) {
            // Rate limited, throw error to retry
            throw new Error('Rate limited')
          }
          throw new Error(`Failed to fetch stats: ${statsResponse.statusText}`)
        }

        const stats: TokenStats = await statsResponse.json()

        // Get token from database
        const { data: token, error: getError } = await supabase
          .from('tokens')
          .select('*')
          .eq('mint', mint)
          .single()

        if (getError) throw getError
        if (!token) throw new Error(`Token ${mint} not found`)

        // Check if token is hot
        const hotnessCheck = checkTokenHotness(
          token.start_market_cap,
          stats.marketCapUsd,
          stats['24h'].volume.buys,
          (stats['24h'].volume.buys || 0) - (stats['24h'].volume.sells || 0),
          stats.liquidityUsd
        );

        // If token is hot, record it
        if (hotnessCheck.isHot) {
          const { error: hotnessError } = await supabase
            .from('token_hotness')
            .insert({
              token_mint: mint,
              market_cap_usd: stats.marketCapUsd,
              start_market_cap: token.start_market_cap,
              liquidity_usd: stats.liquidityUsd,
              cumulative_buy_volume: stats['24h'].volume.buys,
              cumulative_net_volume: (stats['24h'].volume.buys || 0) - (stats['24h'].volume.sells || 0),
              reason: hotnessCheck.reason
            });

          if (hotnessError) {
            console.error(`Failed to record hotness for token ${mint}:`, hotnessError);
          } else {
            console.log(`Token ${mint} marked as hot! Reason: ${hotnessCheck.reason}`);
          }
        }

        // Update token
        const updates = {
          market_cap_usd: stats.marketCapUsd,
          liquidity_usd: stats.liquidityUsd,
          cumulative_buy_volume: stats['24h'].volume.buys || 0,
          cumulative_net_volume: (stats['24h'].volume.buys || 0) - (stats['24h'].volume.sells || 0),
          last_updated: new Date().toISOString()
        }

        const { error: updateError } = await supabase
          .from('tokens')
          .update(updates)
          .eq('mint', mint)

        if (updateError) throw updateError

        // Add historical record
        const { error: historyError } = await supabase
          .from('historical_records')
          .insert({
            token_mint: mint,
            market_cap_usd: token.market_cap_usd,
            liquidity_usd: token.liquidity_usd,
            cumulative_buy_volume: updates.cumulative_buy_volume,
            cumulative_net_volume: updates.cumulative_net_volume
          })

        if (historyError) throw historyError

        // Delete processed message
        const { error: deleteError } = await supabase.functions.invoke('delete-message', {
          body: {
            queue_name: QUEUE_NAME,
            message_id: message.message_id
          }
        })

        if (deleteError) throw deleteError

        return new Response(
          JSON.stringify({
            message: `Successfully processed stats for token ${mint}`,
            updates
          }),
          { headers: { 'Content-Type': 'application/json' }, status: 200 }
        )
      } catch (error) {
        console.error(`Failed to process token ${mint}:`, error)

        // Handle rate limits and other retryable errors
        const shouldRetry = error.message === 'Rate limited' || 
                          error.message.includes('timeout') || 
                          error.message.includes('network error');

        if (shouldRetry && retryCount < RETRY_CONFIG.MAX_RETRIES) {
          // Update message with retry information
          const nextRetryTime = calculateNextRetryTime(retryCount);
          const updatedMessage: QueueMessage = {
            ...queueMessage,
            retryCount: retryCount + 1,
            lastRetry: new Date().toISOString(),
            nextRetryTime: nextRetryTime.toISOString()
          };

          // Update message in queue
          const { error: updateError } = await supabase.functions.invoke('update-message', {
            body: {
              queue_name: QUEUE_NAME,
              message_id: message.message_id,
              message: updatedMessage
            }
          });

          if (updateError) throw updateError;

          return new Response(
            JSON.stringify({
              error: 'Rate limited, scheduled for retry',
              nextRetry: nextRetryTime.toISOString(),
              retryCount: retryCount + 1
            }),
            { headers: { 'Content-Type': 'application/json' }, status: 429 }
          );
        } else if (retryCount >= RETRY_CONFIG.MAX_RETRIES) {
          // Move to dead letter queue after max retries
          const { error: dlqError } = await supabase.functions.invoke('send-message', {
            body: {
              queue_name: `${QUEUE_NAME}_dlq`,
              message: {
                ...queueMessage,
                error: error.message,
                failedAt: new Date().toISOString()
              }
            }
          });

          if (dlqError) throw dlqError;

          // Delete from main queue
          await supabase.functions.invoke('delete-message', {
            body: {
              queue_name: QUEUE_NAME,
              message_id: message.message_id
            }
          });
        }

        return new Response(
          JSON.stringify({
            error: `Failed to process token ${mint}`,
            details: error
          }),
          { headers: { 'Content-Type': 'application/json' }, status: 500 }
        )
      }
    }
  } catch (error) {
    console.error('Error in process-stats function:', error)
    return new Response(
      JSON.stringify({
        error: 'Failed to process messages',
        details: error
      }),
      { headers: { 'Content-Type': 'application/json' }, status: 500 }
    )
  }
})

/* To invoke locally:

  1. Run `supabase start` (see: https://supabase.com/docs/reference/cli/supabase-start)
  2. Make an HTTP request:

  curl -i --location --request POST 'http://127.0.0.1:54321/functions/v1/process-stats' \
    --header 'Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0' \
    --header 'Content-Type: application/json' \
    --data '{"name":"Functions"}'

*/
