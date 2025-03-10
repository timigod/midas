import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.39.0'
import { Token, checkTokenHotness } from '../_shared/types.ts'

// Initialize Supabase client
const supabaseUrl = Deno.env.get('SUPABASE_URL')!
const supabaseKey = Deno.env.get('SUPABASE_ANON_KEY')!
const supabase = createClient(supabaseUrl, supabaseKey)

// Initialize Supabase service role client for admin operations
const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey)

// Configure Solana Tracker API
const SOLANA_TRACKER_API_URL = Deno.env.get('SOLANA_TRACKER_API_URL')!
const SOLANA_TRACKER_API_KEY = Deno.env.get('SOLANA_TRACKER_API_KEY')!

// Queue name for stats processing
const QUEUE_NAME = 'token_stats_queue'

// Market cap threshold for immediate hotness check
const IMMEDIATE_CHECK_THRESHOLD = 600000 // $600K

Deno.serve(async (req) => {
  try {
    console.log('Starting token discovery process...');
    
    // Call Solana Tracker search endpoint
    const searchResponse = await fetch(`${SOLANA_TRACKER_API_URL}/search`, {
      headers: {
        'x-api-key': SOLANA_TRACKER_API_KEY
      },
      method: 'GET'
    })

    if (!searchResponse.ok) {
      throw new Error(`Failed to fetch tokens: ${searchResponse.statusText}`)
    }

    const { data: discoveredTokens } = await searchResponse.json()
    console.log(`Found ${discoveredTokens?.length || 0} tokens from Solana Tracker API`);
    
    const validTokens: Token[] = []
    const currentTime = new Date()
    const rejectedTokens: {mint: string, reason: string}[] = []

    for (const token of discoveredTokens) {
      try {
        // Check if token already exists in our database
        const { data: existingToken } = await supabase
          .from('tokens')
          .select('mint, is_active')
          .eq('mint', token.mint)
          .single();
          
        if (existingToken) {
          if (existingToken.is_active) {
            console.log(`Token ${token.mint} already exists and is active, skipping...`);
            continue;
          } else {
            console.log(`Token ${token.mint} exists but is archived, skipping...`);
            continue;
          }
        }
        
        // Check liquidity criteria (liquidityUsd >= 0.03 × marketCapUsd)
        if (token.liquidityUsd < 0.03 * token.marketCapUsd) {
          rejectedTokens.push({
            mint: token.mint, 
            reason: `Insufficient liquidity ratio: ${(token.liquidityUsd / token.marketCapUsd * 100).toFixed(2)}% (required >= 3%)`
          });
          continue;
        }
        
        // Prepare token for database
        // Get volume data from buys/sells fields (search endpoint format)
        // Note: The search endpoint doesn't have the same volume structure as stats endpoint
        // It has buys and sells at the root level
        let buyVolume = 0;
        let sellVolume = 0;
        
        // Check if token has transaction data
        if (typeof token.buys === 'number' || typeof token.sells === 'number') {
          buyVolume = token.buys || 0;
          sellVolume = token.sells || 0;
          console.log(`Found transaction data for token ${token.mint}: buys=${buyVolume}, sells=${sellVolume}`);
        } else if (typeof token.totalTransactions === 'number' && token.totalTransactions > 0) {
          // If we only have total transactions but no buy/sell breakdown, 
          // assume an even split as a fallback
          buyVolume = Math.round(token.totalTransactions / 2);
          sellVolume = token.totalTransactions - buyVolume;
          console.log(`Using totalTransactions as volume proxy for token ${token.mint}: ${token.totalTransactions}`);
        } else {
          console.log(`Token ${token.mint} is missing transaction data, using defaults`);
        }
        
        // Use snake_case for database compatibility but cast to Token type for type safety
        const newToken = {
          mint: token.mint,
          start_market_cap: token.marketCapUsd,
          liquidity_usd: token.liquidityUsd,
          market_cap_usd: token.marketCapUsd,
          cumulative_buy_volume: buyVolume,
          cumulative_net_volume: buyVolume - sellVolume,
          created_at: currentTime.toISOString(),
          last_updated: currentTime.toISOString(),
          deadline: new Date(currentTime.getTime() + 6 * 60 * 60 * 1000).toISOString(), // current time + 6 hours
          is_active: true,
          is_hot: false
        } as unknown as Token

        // Store token in database
        const { error: insertError } = await supabase
          .from('tokens')
          .insert(newToken)

        if (insertError) {
          console.error(`Failed to insert token ${token.mint}:`, insertError);
          continue;
        }
        
        // Insert initial historical record
        const { error: historyError } = await supabase
          .from('historical_records')
          .insert({
            token_mint: token.mint,
            market_cap_usd: token.marketCapUsd,
            liquidity_usd: token.liquidityUsd,
            cumulative_buy_volume: buyVolume,
            cumulative_net_volume: buyVolume - sellVolume,
            timestamp: currentTime.toISOString()
          });
          
        if (historyError) {
          console.error(`Failed to insert historical record for ${token.mint}:`, historyError);
        }

        // Note: We no longer perform immediate hotness check in the discover function
        // All hotness checks are now handled by the process-stats function
        // This ensures accurate volume data is used for hotness determination
        if (token.marketCapUsd >= IMMEDIATE_CHECK_THRESHOLD) {
          console.log(`Token ${token.mint} has high market cap ($${token.marketCapUsd}), will be evaluated for hotness in process-stats`);
        }

        // Queue token for stats processing with retry metadata
        let queueRetries = 0;
        const MAX_QUEUE_RETRIES = 3;
        let queueSuccess = false;
        
        while (!queueSuccess && queueRetries < MAX_QUEUE_RETRIES) {
          try {
            const { error: queueError } = await supabase
              .functions.invoke('send-message', {
                body: {
                  queue_name: QUEUE_NAME,
                  message: {
                    mint: token.mint,
                    retryCount: 0,
                    lastRetry: null,
                    nextRetryTime: null
                  }
                }
              });
    
            if (queueError) {
              queueRetries++;
              console.error(`Failed to queue token ${token.mint} for processing (attempt ${queueRetries}/${MAX_QUEUE_RETRIES}):`, queueError);
              
              if (queueRetries < MAX_QUEUE_RETRIES) {
                // Wait before retrying (exponential backoff)
                const backoffMs = Math.min(1000 * Math.pow(2, queueRetries), 8000);
                console.log(`Retrying in ${backoffMs}ms...`);
                await new Promise(resolve => setTimeout(resolve, backoffMs));
              }
            } else {
              queueSuccess = true;
              console.log(`Successfully queued token ${token.mint} for processing`);
            }
          } catch (error) {
            queueRetries++;
            console.error(`Exception when queuing token ${token.mint} (attempt ${queueRetries}/${MAX_QUEUE_RETRIES}):`, error);
            
            if (queueRetries < MAX_QUEUE_RETRIES) {
              // Wait before retrying (exponential backoff)
              const backoffMs = Math.min(1000 * Math.pow(2, queueRetries), 8000);
              console.log(`Retrying in ${backoffMs}ms...`);
              await new Promise(resolve => setTimeout(resolve, backoffMs));
            }
          }
        }
        
        if (!queueSuccess) {
          console.error(`Failed to queue token ${token.mint} after ${MAX_QUEUE_RETRIES} attempts. Token will not be processed for stats.`);
        }

        validTokens.push(newToken)
        console.log(`Successfully processed token ${token.mint}`);
      } catch (error) {
        console.error(`Failed to process token ${token.mint}:`, error)
        continue;
      }
    }

    return new Response(
      JSON.stringify({
        message: `Discovery completed. Found ${validTokens.length} valid tokens. All tokens queued for stats processing.`,
        summary: {
          totalTokensChecked: discoveredTokens.length,
          validTokensFound: validTokens.length,
          liquidityFilterRejections: rejectedTokens.length
        },
        tokens: validTokens,
        rejectedTokens
      }),
      {
        headers: { 'Content-Type': 'application/json' },
        status: 200
      }
    )
  } catch (error) {
    console.error('Error in discover function:', error)
    return new Response(
      JSON.stringify({
        error: 'Failed to discover tokens',
        details: error
      }),
      {
        headers: { 'Content-Type': 'application/json' },
        status: 500
      }
    )
  }
})

/* To invoke locally:

  1. Run `supabase start` (see: https://supabase.com/docs/reference/cli/supabase-start)
  2. Make an HTTP request:

  curl -i --location --request POST 'http://127.0.0.1:54321/functions/v1/discover' \
    --header 'Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0' \
    --header 'Content-Type: application/json' \
    --data '{"name":"Functions"}'

*/
