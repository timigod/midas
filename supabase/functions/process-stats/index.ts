import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.39.0'
import { Token, TokenStats, QueueMessage, QueueMessageWithId, RETRY_CONFIG, calculateNextRetryTime, checkTokenHotness } from '../_shared/types.ts'

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

// Market cap threshold for hotness check
const HOTNESS_CHECK_THRESHOLD = 600000 // $600K

// Function to validate token stats data
function validateTokenStats(stats: TokenStats, mint: string) {
  const validationResults = {
    isValid: true,
    errors: [] as string[],
    warnings: [] as string[],
    processedData: {
      marketCapUsd: 0,
      liquidityUsd: 0,
      buyVolume: 0,
      sellVolume: 0,
      netVolume: 0
    }
  };
  
  // First, check if stats object exists
  if (!stats) {
    validationResults.isValid = false;
    validationResults.errors.push(`Token ${mint} has no stats data`);
    return validationResults;
  }
  
  // Check for required market cap data
  if (typeof stats.marketCapUsd !== 'number') {
    validationResults.isValid = false;
    validationResults.errors.push(`Token ${mint} has invalid market cap: marketCapUsd=${stats.marketCapUsd}`);
  } else {
    validationResults.processedData.marketCapUsd = stats.marketCapUsd;
  }
  
  // Check for required liquidity data
  if (typeof stats.liquidityUsd !== 'number') {
    validationResults.isValid = false;
    validationResults.errors.push(`Token ${mint} has invalid liquidity: liquidityUsd=${stats.liquidityUsd}`);
  } else {
    validationResults.processedData.liquidityUsd = stats.liquidityUsd;
  }
  
  // Initialize volume variables with defaults
  let buyVolume = 0;
  let sellVolume = 0;
  let netVolume = 0;
  let volumeFound = false;
  
  // Check for volume in 24h time period first (preferred)
  if (stats['24h'] && stats['24h'].volume && 
      typeof stats['24h'].volume.buys === 'number' && 
      typeof stats['24h'].volume.sells === 'number') {
    
    buyVolume = stats['24h'].volume.buys;
    sellVolume = stats['24h'].volume.sells;
    netVolume = buyVolume - sellVolume;
    volumeFound = true;
    console.log(`Found 24h volume data for token ${mint}: buys=${buyVolume}, sells=${sellVolume}`);
  }
  
  // If 24h not available, try other time periods in order of preference
  const timePeriods = ['12h', '6h', '5h', '4h', '3h', '2h', '1h', '30m', '15m', '5m', '1m'];
  
  for (const period of timePeriods) {
    if (!volumeFound && stats[period] && stats[period].volume && 
        typeof stats[period].volume.buys === 'number' && 
        typeof stats[period].volume.sells === 'number') {
      
      buyVolume = stats[period].volume.buys;
      sellVolume = stats[period].volume.sells;
      netVolume = buyVolume - sellVolume;
      volumeFound = true;
      console.log(`Found ${period} volume data for token ${mint}: buys=${buyVolume}, sells=${sellVolume}`);
      validationResults.warnings.push(`Token ${mint} is missing 24h volume data, using ${period} data instead`);
      break;
    }
  }
  
  if (!volumeFound) {
    validationResults.warnings.push(`Token ${mint} is missing volume data, using defaults`);
    console.log(`No volume data found for token ${mint} in any time period`);
  }
  
  validationResults.processedData.buyVolume = buyVolume;
  validationResults.processedData.sellVolume = sellVolume;
  validationResults.processedData.netVolume = netVolume;
  
  return validationResults;
}

Deno.serve(async (req) => {
  // Check if this is a test request
  if (req.method === 'POST') {
    try {
      const requestData = await req.json();
      
      // If test data is provided, validate it directly
      if (requestData.test === true && requestData.tokenStats) {
        const mint = requestData.mint || 'TEST_TOKEN';
        const validationResults = validateTokenStats(requestData.tokenStats, mint);
        
        return new Response(
          JSON.stringify({
            message: 'Validation test results',
            validationResults
          }),
          { headers: { 'Content-Type': 'application/json' }, status: 200 }
        );
      }
    } catch (error) {
      // If parsing fails, continue with normal processing
      console.log('Not a test request, continuing with normal processing');
    }
  }
  
  // Get messages from queue that are ready to be processed
  const currentTime = new Date().toISOString();
  console.log(`Attempting to read messages from queue: ${QUEUE_NAME}`);
  
  // Declare variables at the top level of the function so they're accessible throughout
  let messages: any[] = [];
  let readError;
  let successCount = 0;
  let failureCount = 0;
  
  try {
    
    try {
      const response = await supabase.functions.invoke('read-messages', {
        body: {
          queue_name: QUEUE_NAME,
          batch_size: 50,
          visibility_timeout: 120,
          // Only get messages that are ready to be retried
          filter: `nextRetryTime IS NULL OR nextRetryTime <= '${currentTime}'`
        }
      });
      
      messages = response.data.data;
      readError = response.error;
      
      console.log(`Read messages response: ${messages ? messages.length : 0} messages found`);
    } catch (invokeError) {
      console.error(`Error invoking read-messages function:`, invokeError);
      return new Response(
        JSON.stringify({ 
          error: `Failed to invoke read-messages: ${invokeError.message}`,
          timestamp: new Date().toISOString()
        }),
        { headers: { 'Content-Type': 'application/json' }, status: 500 }
      );
    }

    if (readError) {
      console.error(`Read error from queue:`, readError);
      return new Response(
        JSON.stringify({ 
          error: `Queue read error: ${JSON.stringify(readError)}`,
          timestamp: new Date().toISOString()
        }),
        { headers: { 'Content-Type': 'application/json' }, status: 500 }
      );
    }
    if (!messages || messages.length === 0) {
      return new Response(
        JSON.stringify({ 
          message: 'No messages to process',
          timestamp: currentTime
        }),
        { headers: { 'Content-Type': 'application/json' }, status: 200 }
      )
    }

    // Process each message
    console.log(`Processing ${messages.length} messages from the queue`);
    
    for (const message of messages) {
      // Debug: Log the message structure to see all available properties
      console.log('Message structure:', JSON.stringify(message));
      
      const queueMessage = message.message as QueueMessage
      const { mint, retryCount } = queueMessage
      
      console.log(`Processing token ${mint} (retry count: ${retryCount})`);
      console.log(`Message ID properties - message.id: ${message.id}, message.message_id: ${message.message_id}`);
      // This will help us determine which property to use

      try {
        // Get token data using the correct endpoint
        const tokenResponse = await fetch(`${SOLANA_TRACKER_API_URL}/tokens/${mint}`, {
          headers: {
            'x-api-key': SOLANA_TRACKER_API_KEY
          },
          method: 'GET'
        })

        if (!tokenResponse.ok) {
          if (tokenResponse.status === 429) {
            // Rate limited, throw error to retry
            throw new Error('Rate limited')
          }
          throw new Error(`Failed to fetch token data: ${tokenResponse.statusText}`)
        }

        const tokenData = await tokenResponse.json()
        
        // Also get stats for volume data
        const statsResponse = await fetch(`${SOLANA_TRACKER_API_URL}/stats/${mint}`, {
          headers: {
            'x-api-key': SOLANA_TRACKER_API_KEY
          },
          method: 'GET'
        })
        
        // We'll continue even if stats endpoint fails, as we primarily need the token data
        let statsData = null
        if (statsResponse.ok) {
          statsData = await statsResponse.json()
        } else {
          console.warn(`Failed to fetch stats data for ${mint}: ${statsResponse.statusText}. Will continue with token data only.`)
        }
        
        // Check if the token has been rugged or has too high risk
        // Higher score = more risk (10 is highest risk, 1 is lowest risk)
        const MAX_RISK_THRESHOLD = 7; // Maximum acceptable risk score on a scale of 1-10
        
        if (tokenData.risk) {
          // Check if token has been explicitly marked as rugged
          if (tokenData.risk.rugged === true) {
            console.log(`Token ${mint} has been rugged, skipping processing`);
            
            // Delete message from queue
            try {
              const deleteResponse = await supabase.functions.invoke('delete-message', {
                body: {
                  queue_name: QUEUE_NAME,
                  message_id: message.id
                }
              });
              
              if (deleteResponse.error) {
                console.error(`Error deleting message ${message.id}:`, deleteResponse.error);
              }
            } catch (deleteInvokeError) {
              console.error(`Failed to invoke delete-message function:`, deleteInvokeError);
            }
            
            // Skip further processing for this token
            continue;
          }
          
          // Check if risk score exceeds our threshold (higher score = more risk)
          if (tokenData.risk.score > MAX_RISK_THRESHOLD) {
            console.log(`Token ${mint} has a risk score of ${tokenData.risk.score}, which exceeds our threshold of ${MAX_RISK_THRESHOLD}`);
            
            // Delete message from queue
            try {
              const deleteResponse = await supabase.functions.invoke('delete-message', {
                body: {
                  queue_name: QUEUE_NAME,
                  message_id: message.id
                }
              });
              
              if (deleteResponse.error) {
                console.error(`Error deleting message ${message.id}:`, deleteResponse.error);
              }
            } catch (deleteInvokeError) {
              console.error(`Failed to invoke delete-message function:`, deleteInvokeError);
            }
            
            // Skip further processing for this token
            continue;
          }
        }
        
        // Construct a TokenStats object from the token data
        const stats: TokenStats = {
          // Get market cap from the first pool (if available)
          marketCapUsd: tokenData.pools && tokenData.pools[0] ? tokenData.pools[0].marketCap.usd : 0,
          // Get liquidity from the first pool (if available)
          liquidityUsd: tokenData.pools && tokenData.pools[0] ? tokenData.pools[0].liquidity.usd : 0,
          // Add volume data from stats if available
          ...(statsData ? statsData : {})
        }

        // Get token from database
        const { data: token, error: getError } = await supabase
          .from('tokens')
          .select('*')
          .eq('mint', mint)
          .single()

        if (getError) {
          console.error(`Error retrieving token ${mint} from database:`, getError);
          throw new Error(`Database error: ${getError.message}`);
        }
        if (!token) {
          console.error(`Token ${mint} not found in database`);
          throw new Error(`Token ${mint} not found`);
        }
        
        // Skip processing for inactive tokens
        if (!token.is_active) {
          console.log(`Token ${mint} is inactive, skipping processing and removing from queue`);
          
          // Delete message from queue
          try {
            console.log(`Attempting to delete message ${message.id} from queue ${QUEUE_NAME}`);
            const deleteResponse = await supabase.functions.invoke('delete-message', {
              body: {
                queue_name: QUEUE_NAME,
                message_id: message.id
              }
            });
            
            if (deleteResponse.error) {
              console.error(`Error deleting message ${message.id}:`, deleteResponse.error);
            } else {
              console.log(`Successfully deleted message ${message.id}`);
            }
          } catch (deleteInvokeError) {
            console.error(`Failed to invoke delete-message function:`, deleteInvokeError);
          }
          
          // Skip further processing for this token
          continue;
        }

        // Validate the stats data structure before processing
        console.log(`Validating stats data for token ${mint}`);
        
        // Use the validation function
        const validation = validateTokenStats(stats, mint);
        
        // If validation failed, throw an error with the first error message
        if (!validation.isValid) {
          const errorMessage = validation.errors[0] || 'Invalid token stats data';
          console.warn(errorMessage);
          throw new Error(errorMessage);
        }
        
        // Log any warnings
        validation.warnings.forEach(warning => console.warn(warning));
        
        // Extract the processed data
        const { marketCapUsd, liquidityUsd, buyVolume, sellVolume, netVolume } = validation.processedData;
        
        // Log volume data if available
        if (buyVolume > 0 || sellVolume > 0) {
          console.log(`Token ${mint} volume data: buys=${buyVolume}, sells=${sellVolume}, net=${netVolume}`);
        }
        
        // Calculate updated cumulative values using the validated data
        const updatedBuyVolume = token.cumulative_buy_volume + validation.processedData.buyVolume;
        const updatedNetVolume = token.cumulative_net_volume + validation.processedData.netVolume;
        
        // Update token with validated data
        const updates = {
          market_cap_usd: validation.processedData.marketCapUsd,
          liquidity_usd: validation.processedData.liquidityUsd,
          cumulative_buy_volume: updatedBuyVolume,
          cumulative_net_volume: updatedNetVolume,
          last_updated: new Date().toISOString()
        }
        
        // Check if token should be evaluated for hotness (market cap >= $600K)
        if (stats.marketCapUsd >= HOTNESS_CHECK_THRESHOLD) {
          console.log(`Token ${mint} qualifies for hotness check with market cap $${stats.marketCapUsd}`);
          
          // Check hotness criteria directly (matching the original worker.js logic)
          // Ensure we have a valid start_market_cap to compare against
          const startMarketCap = typeof token.start_market_cap === 'number' && token.start_market_cap > 0 
            ? token.start_market_cap 
            : stats.marketCapUsd / 3; // Fallback to a reasonable value if start_market_cap is invalid
            
          const marketCapGrowth = stats.marketCapUsd >= 3 * startMarketCap;
          const buyVolumeRatio = (updatedBuyVolume / stats.marketCapUsd) >= 0.05;
          const positiveNetVolume = updatedNetVolume > 0;
          const liquidityRatio = stats.liquidityUsd >= 0.03 * stats.marketCapUsd;
          
          const isHot = marketCapGrowth && buyVolumeRatio && positiveNetVolume && liquidityRatio;
          
          // Log the hotness check details
          console.log(`Hotness check for ${mint}:`);
          console.log(`  Market Cap Growth: ${marketCapGrowth ? 'YES' : 'NO'} (${stats.marketCapUsd / startMarketCap}x, required >= 3x)`); 
          console.log(`  Buy Volume Ratio: ${buyVolumeRatio ? 'YES' : 'NO'} (${(updatedBuyVolume / stats.marketCapUsd).toFixed(4)}, required >= 0.05)`); 
          console.log(`  Positive Net Volume: ${positiveNetVolume ? 'YES' : 'NO'} (${updatedNetVolume})`); 
          console.log(`  Liquidity Ratio: ${liquidityRatio ? 'YES' : 'NO'} (${(stats.liquidityUsd / stats.marketCapUsd).toFixed(4)}, required >= 0.03)`); 
          console.log(`  RESULT: ${isHot ? 'HOT!' : 'Not hot'}`);
          
          // If token is hot, record it
          if (isHot) {
            // Check if token is already marked as hot
            const { data: existingHotness } = await supabase
              .from('token_hotness')
              .select('*')
              .eq('token_mint', mint)
              .limit(1);
            
            if (!existingHotness || existingHotness.length === 0) {
              // Insert into token_hotness table using admin client to bypass RLS
              const { error: hotnessError } = await supabaseAdmin
                .from('token_hotness')
                .insert({
                  token_mint: mint,
                  detected_at: new Date().toISOString(),
                  market_cap_usd: stats.marketCapUsd,
                  start_market_cap: startMarketCap,
                  liquidity_usd: stats.liquidityUsd,
                  cumulative_buy_volume: updatedBuyVolume,
                  cumulative_net_volume: updatedNetVolume
                });

              if (hotnessError) {
                console.error(`Failed to record hotness for token ${mint}:`, hotnessError);
              } else {
                console.log(`Token ${mint} marked as HOT! Market cap growth: ${stats.marketCapUsd / startMarketCap}x, Buy volume ratio: ${updatedBuyVolume / stats.marketCapUsd}, Net volume: ${updatedNetVolume}, Liquidity ratio: ${stats.liquidityUsd / stats.marketCapUsd}`);
              }
            } else {
              console.log(`Token ${mint} is already marked as hot, skipping...`);
            }
          }
        }



        const { error: updateError } = await supabase
          .from('tokens')
          .update(updates)
          .eq('mint', mint)

        if (updateError) {
          console.error(`Failed to update token ${mint}:`, updateError);
          throw new Error(`Database update error: ${updateError.message}`);
        } else {
          console.log(`Successfully updated token ${mint} with new stats`);
          successCount++;
        }

        // Add historical record - only if we have valid market cap and liquidity values
        if (updates.market_cap_usd !== null && updates.market_cap_usd !== undefined && 
            updates.liquidity_usd !== null && updates.liquidity_usd !== undefined) {
          const { error: historyError } = await supabase
            .from('historical_records')
            .insert({
              token_mint: mint,
              market_cap_usd: updates.market_cap_usd,
              liquidity_usd: updates.liquidity_usd,
              cumulative_buy_volume: updates.cumulative_buy_volume,
              cumulative_net_volume: updates.cumulative_net_volume,
              timestamp: new Date().toISOString()
            })
  
          if (historyError) {
            console.error(`Failed to add historical record for token ${mint}:`, historyError);
            // Don't throw here, just log the error and continue
          }
        } else {
          console.warn(`Skipping historical record for token ${mint} due to null/undefined market cap or liquidity values`);
        }

        // Delete processed message
        try {
          console.log(`Attempting to delete message ${message.id} from queue ${QUEUE_NAME}`);
          const deleteResponse = await supabase.functions.invoke('delete-message', {
            body: {
              queue_name: QUEUE_NAME,
              message_id: message.id
            }
          });
          
          if (deleteResponse.error) {
            console.error(`Error deleting message ${message.id}:`, deleteResponse.error);
            // Don't throw here, just log the error and continue
          } else {
            console.log(`Successfully deleted message ${message.id}`);
          }
        } catch (deleteInvokeError) {
          console.error(`Failed to invoke delete-message function:`, deleteInvokeError);
          // Don't throw here, just log the error and continue
        }

        // Success for this token, handled via the successCount++ above
      } catch (error) {
        console.error(`Failed to process token ${mint}:`, error);
        failureCount++;

        // Handle rate limits and other retryable errors
        const shouldRetry = error.message === 'Rate limited' || 
                          error.message.includes('timeout') || 
                          error.message.includes('network error') ||
                          error.message.includes('fetch');

        if (shouldRetry && retryCount < RETRY_CONFIG.MAX_RETRIES) {
          // Update message with retry information
          const nextRetryTime = calculateNextRetryTime(retryCount);
          const updatedMessage: QueueMessage = {
            ...queueMessage,
            retryCount: retryCount + 1,
            lastRetry: new Date().toISOString(),
            nextRetryTime: nextRetryTime.toISOString(),
            error: error.message // Store the error message for debugging
          };

          // Update message in queue
          try {
            console.log(`Attempting to update message ${message.id} for retry ${retryCount + 1}`);
            const updateResponse = await supabase.functions.invoke('update-message', {
              body: {
                queue_name: QUEUE_NAME,
                message_id: message.id,
                message: updatedMessage,
                visible_after: nextRetryTime.toISOString() // Ensure message isn't visible until retry time
              }
            });
            
            if (updateResponse.error) {
              console.error(`Failed to update message for retry:`, updateResponse.error);
              // Continue anyway, we'll return a 429 to indicate retry is needed
            } else {
              console.log(`Successfully scheduled message ${message.id} for retry at ${nextRetryTime.toISOString()}`);
            }
          } catch (updateInvokeError) {
            console.error(`Failed to invoke update-message function:`, updateInvokeError);
            // Continue anyway, we'll return a 429 to indicate retry is needed
          }

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
          try {
            console.log(`Moving message ${message.id} to dead letter queue after ${retryCount} failed attempts`);
            const dlqResponse = await supabase.functions.invoke('send-message', {
              body: {
                queue_name: `${QUEUE_NAME}_dlq`,
                message: {
                  ...queueMessage,
                  error: error.message,
                  failedAt: new Date().toISOString(),
                  retryHistory: queueMessage.retryHistory ? 
                    [...queueMessage.retryHistory, { retryCount, error: error.message, time: new Date().toISOString() }] : 
                    [{ retryCount, error: error.message, time: new Date().toISOString() }]
                }
              }
            });

            if (dlqResponse.error) {
              console.error(`Failed to move message to DLQ:`, dlqResponse.error);
            } else {
              console.log(`Successfully moved message ${message.id} to DLQ`);
            }
          } catch (dlqInvokeError) {
            console.error(`Failed to invoke send-message for DLQ:`, dlqInvokeError);
          }

          // Delete the original message
          try {
            console.log(`Attempting to delete failed message ${message.id} from queue ${QUEUE_NAME}`);
            const deleteResponse = await supabase.functions.invoke('delete-message', {
              body: {
                queue_name: QUEUE_NAME,
                message_id: message.id
              }
            });
            
            if (deleteResponse.error) {
              console.error(`Failed to delete message after moving to DLQ:`, deleteResponse.error);
            } else {
              console.log(`Successfully deleted failed message ${message.id} after moving to DLQ`);
            }
          } catch (deleteInvokeError) {
            console.error(`Failed to invoke delete-message function:`, deleteInvokeError);
          }
        }

        // Don't return here, continue processing the next message
        console.log(`Failed to process token ${mint}: ${error.message}`);
      }
    }
  } catch (error) {
    console.error('Error in process-stats function:', error)
    return new Response(
      JSON.stringify({
        error: 'Failed to process messages',
        details: error.message || String(error),
        timestamp: new Date().toISOString()
      }),
      { headers: { 'Content-Type': 'application/json' }, status: 500 }
    )
  }

  // Return summary of processing results
  const totalMessages = Array.isArray(messages) ? messages.length : 0;
  console.log(`Process stats summary: ${successCount} succeeded, ${failureCount} failed, total: ${totalMessages}`);
  return new Response(
    JSON.stringify({
      message: `Processed stats for ${totalMessages} tokens`,
      summary: {
        total: totalMessages,
        success: successCount,
        failure: failureCount,
        startTime: currentTime,
        endTime: new Date().toISOString(),
        executionTimeMs: new Date().getTime() - new Date(currentTime).getTime()
      }
    }),
    { headers: { 'Content-Type': 'application/json' }, status: 200 }
  )
})

/* To invoke locally:

  1. Run `supabase start` (see: https://supabase.com/docs/reference/cli/supabase-start)
  2. Make an HTTP request:

  curl -i --location --request POST 'http://127.0.0.1:54321/functions/v1/process-stats' \
    --header 'Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0' \
    --header 'Content-Type: application/json' \
    --data '{"name":"Functions"}'

*/
