import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.39.0'

// Initialize Supabase client
const supabaseUrl = Deno.env.get('SUPABASE_URL')!
const supabaseKey = Deno.env.get('SUPABASE_ANON_KEY')!
const supabase = createClient(supabaseUrl, supabaseKey)

// Initialize Supabase admin client for operations that require bypassing RLS
const supabaseServiceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const supabaseAdmin = createClient(supabaseUrl, supabaseServiceRoleKey)

// Constants
const SOLANA_TRACKER_API_URL = Deno.env.get('SOLANA_TRACKER_API_URL')!
const SOLANA_TRACKER_API_KEY = Deno.env.get('SOLANA_TRACKER_API_KEY')!
const QUEUE_NAME = 'token_stats_queue'
const HOTNESS_CHECK_THRESHOLD = 600000 // $600K market cap threshold for hotness check
const MAX_RISK_THRESHOLD = 7 // Maximum acceptable risk score on a scale of 1-10

// Retry configuration
const RETRY_CONFIG = {
  MAX_RETRIES: 3,
  BASE_DELAY_MS: 5000, // 5 seconds
  MAX_DELAY_MS: 60000 // 1 minute
}

// Token stats interface
interface TokenStats {
  marketCapUsd: number;
  liquidityUsd: number;
  buyVolume?: number;
  sellVolume?: number;
  [key: string]: any;
}

// Queue message interface
interface QueueMessage {
  mint: string;
  name?: string;
  symbol?: string;
  timestamp: string;
  retryCount?: number;
  lastRetry?: string;
  nextRetryTime?: string;
  error?: string;
  retryHistory?: Array<{
    retryCount: number;
    error: string;
    time: string;
  }>;
}

// Function to validate token stats
function validateTokenStats(stats: TokenStats, mint: string) {
  const errors: string[] = [];
  const warnings: string[] = [];
  const processedData = {
    marketCapUsd: 0,
    liquidityUsd: 0,
    buyVolume: 0,
    sellVolume: 0,
    netVolume: 0
  };
  
  // Validate market cap
  if (typeof stats.marketCapUsd !== 'number' || isNaN(stats.marketCapUsd)) {
    errors.push(`Token ${mint} has invalid market cap: ${stats.marketCapUsd}`);
  } else if (stats.marketCapUsd <= 0) {
    errors.push(`Token ${mint} has non-positive market cap: ${stats.marketCapUsd}`);
  } else {
    processedData.marketCapUsd = stats.marketCapUsd;
  }
  
  // Validate liquidity
  if (typeof stats.liquidityUsd !== 'number' || isNaN(stats.liquidityUsd)) {
    errors.push(`Token ${mint} has invalid liquidity: ${stats.liquidityUsd}`);
  } else if (stats.liquidityUsd < 0) {
    errors.push(`Token ${mint} has negative liquidity: ${stats.liquidityUsd}`);
  } else {
    processedData.liquidityUsd = stats.liquidityUsd;
  }
  
  // Process volume data if available
  if (stats.buyVolume !== undefined) {
    if (typeof stats.buyVolume !== 'number' || isNaN(stats.buyVolume)) {
      warnings.push(`Token ${mint} has invalid buy volume: ${stats.buyVolume}, using 0`);
    } else if (stats.buyVolume < 0) {
      warnings.push(`Token ${mint} has negative buy volume: ${stats.buyVolume}, using 0`);
    } else {
      processedData.buyVolume = stats.buyVolume;
    }
  }
  
  if (stats.sellVolume !== undefined) {
    if (typeof stats.sellVolume !== 'number' || isNaN(stats.sellVolume)) {
      warnings.push(`Token ${mint} has invalid sell volume: ${stats.sellVolume}, using 0`);
    } else if (stats.sellVolume < 0) {
      warnings.push(`Token ${mint} has negative sell volume: ${stats.sellVolume}, using 0`);
    } else {
      processedData.sellVolume = stats.sellVolume;
    }
  }
  
  // Calculate net volume
  processedData.netVolume = processedData.buyVolume - processedData.sellVolume;
  
  return {
    isValid: errors.length === 0,
    errors,
    warnings,
    processedData
  };
}

// Function to calculate next retry time with exponential backoff
function calculateNextRetryTime(retryCount: number): Date {
  const delay = Math.min(
    RETRY_CONFIG.BASE_DELAY_MS * Math.pow(2, retryCount),
    RETRY_CONFIG.MAX_DELAY_MS
  );
  
  const nextRetryTime = new Date();
  nextRetryTime.setTime(nextRetryTime.getTime() + delay);
  
  return nextRetryTime;
}

Deno.serve(async (req) => {
  try {
    console.log('Starting token stats processing...')
    const currentTime = new Date().toISOString()
    let successCount = 0
    let failureCount = 0
    
    // Get messages from the queue
    const { data: messages, error: queueError } = await supabase
      .from(QUEUE_NAME)
      .select('*')
      .lte('visible_after', currentTime)
      .order('created_at', { ascending: true })
      .limit(10) // Process 10 messages at a time
    
    if (queueError) {
      console.error('Error fetching messages from queue:', queueError)
      return new Response(
        JSON.stringify({
          error: 'Failed to fetch messages from queue',
          details: queueError.message
        }),
        { headers: { 'Content-Type': 'application/json' }, status: 500 }
      )
    }
    
    if (!messages || messages.length === 0) {
      console.log('No messages in queue to process')
      return new Response(
        JSON.stringify({ message: 'No messages in queue to process' }),
        { headers: { 'Content-Type': 'application/json' }, status: 200 }
      )
    }
    
    console.log(`Found ${messages.length} messages in queue`)
    
    // Process each message
    for (const message of messages) {
      // Parse message data
      let queueMessage: QueueMessage
      try {
        queueMessage = typeof message.message === 'string'
          ? JSON.parse(message.message)
          : message.message
      } catch (parseError) {
        console.error(`Failed to parse message ${message.id}:`, parseError)
        failureCount++
        continue
      }
      
      const mint = queueMessage.mint
      const retryCount = queueMessage.retryCount || 0
      
      if (!mint) {
        console.error(`Message ${message.id} missing mint address, skipping`)
        failureCount++
        continue
      }
      
      // Extract the message ID from the database record
      const messageId = message.id
      
      console.log(`Processing token ${mint} (retry count: ${retryCount})`)
      console.log(`Message ID: ${messageId}`)
      
      if (!messageId) {
        console.error(`No message ID found for token ${mint}, skipping processing`)
        continue
      }
      
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
        if (tokenData.risk) {
          // Check if token has been explicitly marked as rugged
          if (tokenData.risk.rugged === true) {
            console.log(`Token ${mint} has been rugged, skipping processing`)
            
            // Delete message from queue
            try {
              const deleteResponse = await supabase.functions.invoke('delete-message', {
                body: {
                  queue_name: QUEUE_NAME,
                  message_id: messageId
                }
              })
              if (deleteResponse.error) {
                console.error(`Error deleting message ${messageId}:`, deleteResponse.error)
              }
            } catch (deleteInvokeError) {
              console.error(`Failed to invoke delete-message function:`, deleteInvokeError)
            }
            
            // Skip further processing for this token
            continue
          }
          
          // Check if risk score exceeds our threshold (higher score = more risk)
          if (tokenData.risk.score > MAX_RISK_THRESHOLD) {
            console.log(`Token ${mint} has a risk score of ${tokenData.risk.score}, which exceeds our threshold of ${MAX_RISK_THRESHOLD}`)
            
            // Delete message from queue
            try {
              const deleteResponse = await supabase.functions.invoke('delete-message', {
                body: {
                  queue_name: QUEUE_NAME,
                  message_id: messageId
                }
              })
              if (deleteResponse.error) {
                console.error(`Error deleting message ${messageId}:`, deleteResponse.error)
              }
            } catch (deleteInvokeError) {
              console.error(`Failed to invoke delete-message function:`, deleteInvokeError)
            }
            
            // Skip further processing for this token
            continue
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
        
        // First check if token exists in token_hotness table
        const { data: hotToken, error: hotTokenError } = await supabase
          .from('token_hotness')
          .select('*')
          .eq('token_mint', mint)
          .maybeSingle()
        
        if (hotTokenError) {
          console.error(`Error checking if token ${mint} is hot:`, hotTokenError)
          throw new Error(`Database error: ${hotTokenError.message}`)
        }
        
        // If token is already in token_hotness, update it and continue
        if (hotToken) {
          console.log(`Token ${mint} is already marked as hot, updating stats`)
          
          // Validate the stats data
          const validation = validateTokenStats(stats, mint)
          
          if (!validation.isValid) {
            const errorMessage = validation.errors[0] || 'Invalid token stats data'
            console.warn(errorMessage)
            throw new Error(errorMessage)
          }
          
          // Extract the processed data
          const { marketCapUsd, liquidityUsd, buyVolume, sellVolume, netVolume } = validation.processedData
          
          // Update hot token with new data
          const { error: updateHotError } = await supabase
            .from('token_hotness')
            .update({
              market_cap_usd: marketCapUsd,
              liquidity_usd: liquidityUsd,
              cumulative_buy_volume: hotToken.cumulative_buy_volume + buyVolume,
              cumulative_net_volume: hotToken.cumulative_net_volume + netVolume
            })
            .eq('token_mint', mint)
          
          if (updateHotError) {
            console.error(`Failed to update hot token ${mint}:`, updateHotError)
            throw new Error(`Database update error: ${updateHotError.message}`)
          }
          
          // Add historical record
          const { error: historyError } = await supabase
            .from('historical_records')
            .insert({
              token_mint: mint,
              name: hotToken.name,
              symbol: hotToken.symbol,
              market_cap_usd: marketCapUsd,
              liquidity_usd: liquidityUsd,
              cumulative_buy_volume: hotToken.cumulative_buy_volume + buyVolume,
              cumulative_net_volume: hotToken.cumulative_net_volume + netVolume
            })
          
          if (historyError) {
            console.error(`Failed to add historical record for hot token ${mint}:`, historyError)
            // Don't throw here, just log the error and continue
          }
          
          // Delete processed message
          try {
            const deleteResponse = await supabase.functions.invoke('delete-message', {
              body: {
                queue_name: QUEUE_NAME,
                message_id: messageId
              }
            })
            
            if (deleteResponse.error) {
              console.error(`Error deleting message ${messageId}:`, deleteResponse.error)
            } else {
              console.log(`Successfully deleted message ${messageId}`)
            }
          } catch (deleteInvokeError) {
            console.error(`Failed to invoke delete-message function:`, deleteInvokeError)
          }
          
          successCount++
          continue
        }
        
        // If not in hot tokens, check if it's in the regular tokens table
        const { data: token, error: getError } = await supabase
          .from('tokens')
          .select('*')
          .eq('mint', mint)
          .maybeSingle()
        
        if (getError) {
          console.error(`Error retrieving token ${mint} from database:`, getError)
          throw new Error(`Database error: ${getError.message}`)
        }
        
        // If token not found in either table, it might have been archived or deleted
        if (!token) {
          console.log(`Token ${mint} not found in database, checking archived tokens`)
          
          // Check if token exists in archived_tokens
          const { data: archivedToken, error: archivedError } = await supabase
            .from('archived_tokens')
            .select('token_mint')
            .eq('token_mint', mint)
            .maybeSingle()
          
          if (archivedError) {
            console.error(`Error checking archived tokens for ${mint}:`, archivedError)
          }
          
          if (archivedToken) {
            console.log(`Token ${mint} found in archived tokens, removing from queue`)
          } else {
            console.log(`Token ${mint} not found in any table, it may have been deleted`)
          }
          
          // Delete message from queue
          try {
            const deleteResponse = await supabase.functions.invoke('delete-message', {
              body: {
                queue_name: QUEUE_NAME,
                message_id: messageId
              }
            })
            
            if (deleteResponse.error) {
              console.error(`Error deleting message ${messageId}:`, deleteResponse.error)
            } else {
              console.log(`Successfully deleted message ${messageId}`)
            }
          } catch (deleteInvokeError) {
            console.error(`Failed to invoke delete-message function:`, deleteInvokeError)
          }
          
          continue
        }
        
        // Validate the stats data structure before processing
        console.log(`Validating stats data for token ${mint}`)
        
        // Use the validation function
        const validation = validateTokenStats(stats, mint)
        
        // If validation failed, throw an error with the first error message
        if (!validation.isValid) {
          const errorMessage = validation.errors[0] || 'Invalid token stats data'
          console.warn(errorMessage)
          throw new Error(errorMessage)
        }
        
        // Log any warnings
        validation.warnings.forEach(warning => console.warn(warning))
        
        // Extract the processed data
        const { marketCapUsd, liquidityUsd, buyVolume, sellVolume, netVolume } = validation.processedData
        
        // Log volume data if available
        if (buyVolume > 0 || sellVolume > 0) {
          console.log(`Token ${mint} volume data: buys=${buyVolume}, sells=${sellVolume}, net=${netVolume}`)
        }
        
        // Calculate updated cumulative values using the validated data
        const updatedBuyVolume = token.cumulative_buy_volume + validation.processedData.buyVolume
        const updatedNetVolume = token.cumulative_net_volume + validation.processedData.netVolume
        
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
          console.log(`Token ${mint} qualifies for hotness check with market cap $${stats.marketCapUsd}`)
          
          // Check hotness criteria directly (matching the original worker.js logic)
          // Only proceed if we have a valid start_market_cap to compare against
          if (typeof token.start_market_cap !== 'number' || token.start_market_cap <= 0) {
            console.log(`Token ${mint} has invalid start_market_cap (${token.start_market_cap}), skipping hotness check`)
            // Update token but skip hotness check
            const { error: updateError } = await supabase
              .from('tokens')
              .update(updates)
              .eq('mint', token.mint)
              
            if (updateError) {
              console.error(`Failed to update token ${mint}:`, updateError)
              throw new Error(`Database update error: ${updateError.message}`)
            } else {
              console.log(`Successfully updated token ${mint} with new stats`)
              successCount++
            }
            continue
          }
          
          const startMarketCap = token.start_market_cap
            
          const marketCapGrowth = stats.marketCapUsd >= 3 * startMarketCap
          const buyVolumeRatio = (updatedBuyVolume / stats.marketCapUsd) >= 0.05
          const positiveNetVolume = updatedNetVolume > 0
          const liquidityRatio = stats.liquidityUsd >= 0.03 * stats.marketCapUsd
          
          const isHot = marketCapGrowth && buyVolumeRatio && positiveNetVolume && liquidityRatio
          
          // Log the hotness check details
          console.log(`Hotness check for ${mint}:`)
          console.log(`  Market Cap Growth: ${marketCapGrowth ? 'YES' : 'NO'} (${stats.marketCapUsd / startMarketCap}x, required >= 3x)`)
          console.log(`  Buy Volume Ratio: ${buyVolumeRatio ? 'YES' : 'NO'} (${(updatedBuyVolume / stats.marketCapUsd).toFixed(4)}, required >= 0.05)`)
          console.log(`  Positive Net Volume: ${positiveNetVolume ? 'YES' : 'NO'} (${updatedNetVolume})`)
          console.log(`  Liquidity Ratio: ${liquidityRatio ? 'YES' : 'NO'} (${(stats.liquidityUsd / stats.marketCapUsd).toFixed(4)}, required >= 0.03)`)
          console.log(`  RESULT: ${isHot ? 'HOT!' : 'Not hot'}`)
          
          // If token is hot, move it to token_hotness table
          if (isHot) {
            // Insert into token_hotness table
            const { error: hotnessError } = await supabase
              .from('token_hotness')
              .insert({
                token_mint: token.mint,
                name: token.name,
                symbol: token.symbol,
                detected_at: new Date().toISOString(),
                market_cap_usd: stats.marketCapUsd,
                start_market_cap: startMarketCap,
                liquidity_usd: stats.liquidityUsd,
                cumulative_buy_volume: updatedBuyVolume,
                cumulative_net_volume: updatedNetVolume
              })
            
            if (hotnessError) {
              console.error(`Failed to record hotness for token ${mint}:`, hotnessError)
              // Continue with regular update
            } else {
              console.log(`Token ${mint} marked as HOT! Market cap growth: ${stats.marketCapUsd / startMarketCap}x, Buy volume ratio: ${updatedBuyVolume / stats.marketCapUsd}, Net volume: ${updatedNetVolume}, Liquidity ratio: ${stats.liquidityUsd / stats.marketCapUsd}`)
              
              // Delete from tokens table since it's now in hotness table
              const { error: deleteTokenError } = await supabase
                .from('tokens')
                .delete()
                .eq('mint', token.mint)
              
              if (deleteTokenError) {
                console.error(`Failed to delete token ${mint} after moving to hotness:`, deleteTokenError)
              } else {
                console.log(`Successfully moved token ${mint} from tokens to token_hotness table`)
              }
              
              // Success for this token
              successCount++
              
              // Delete processed message
              try {
                const deleteResponse = await supabase.functions.invoke('delete-message', {
                  body: {
                    queue_name: QUEUE_NAME,
                    message_id: messageId
                  }
                })
                
                if (deleteResponse.error) {
                  console.error(`Error deleting message ${messageId}:`, deleteResponse.error)
                } else {
                  console.log(`Successfully deleted message ${messageId}`)
                }
              } catch (deleteInvokeError) {
                console.error(`Failed to invoke delete-message function:`, deleteInvokeError)
              }
              
              continue
            }
          }
        }
        
        // Update token in database (if it wasn't moved to hotness)
        const { error: updateError } = await supabase
          .from('tokens')
          .update(updates)
          .eq('mint', token.mint)
        
        if (updateError) {
          console.error(`Failed to update token ${mint}:`, updateError)
          throw new Error(`Database update error: ${updateError.message}`)
        } else {
          console.log(`Successfully updated token ${mint} with new stats`)
          successCount++
        }
        
        // Add historical record - only if we have valid market cap and liquidity values
        if (updates.market_cap_usd !== null && updates.market_cap_usd !== undefined && 
            updates.liquidity_usd !== null && updates.liquidity_usd !== undefined) {
          const { error: historyError } = await supabase
            .from('historical_records')
            .insert({
              token_mint: mint,
              name: token.name,
              symbol: token.symbol,
              market_cap_usd: updates.market_cap_usd,
              liquidity_usd: updates.liquidity_usd,
              cumulative_buy_volume: updates.cumulative_buy_volume,
              cumulative_net_volume: updates.cumulative_net_volume
            })
  
          if (historyError) {
            console.error(`Failed to add historical record for token ${mint}:`, historyError)
            // Don't throw here, just log the error and continue
          }
        } else {
          console.warn(`Skipping historical record for token ${mint} due to null/undefined market cap or liquidity values`)
        }
        
        // Delete processed message
        try {
          console.log(`Attempting to delete message ${message.id} from queue ${QUEUE_NAME}`)
          const deleteResponse = await supabase.functions.invoke('delete-message', {
            body: {
              queue_name: QUEUE_NAME,
              message_id: message.id
            }
          })
          
          if (deleteResponse.error) {
            console.error(`Error deleting message ${message.id}:`, deleteResponse.error)
            // Don't throw here, just log the error and continue
          } else {
            console.log(`Successfully deleted message ${message.id}`)
          }
        } catch (deleteInvokeError) {
          console.error(`Failed to invoke delete-message function:`, deleteInvokeError)
          // Don't throw here, just log the error and continue
        }
        
        // Success for this token, handled via the successCount++ above
      } catch (error) {
        console.error(`Failed to process token ${mint}:`, error)
        failureCount++
        
        // Handle rate limits and other retryable errors
        const shouldRetry = error.message === 'Rate limited' || 
                          error.message.includes('timeout') || 
                          error.message.includes('network error') ||
                          error.message.includes('fetch')
        
        if (shouldRetry && retryCount < RETRY_CONFIG.MAX_RETRIES) {
          // Update message with retry information
          const nextRetryTime = calculateNextRetryTime(retryCount)
          const updatedMessage: QueueMessage = {
            ...queueMessage,
            retryCount: retryCount + 1,
            lastRetry: new Date().toISOString(),
            nextRetryTime: nextRetryTime.toISOString(),
            error: error.message // Store the error message for debugging
          }
          
          // Update message in queue
          try {
            console.log(`Attempting to update message ${messageId} for retry ${retryCount + 1}`)
            const updateResponse = await supabase.functions.invoke('update-message', {
              body: {
                queue_name: QUEUE_NAME,
                message_id: messageId,
                message: updatedMessage,
                visible_after: nextRetryTime.toISOString() // Ensure message isn't visible until retry time
              }
            })
            
            if (updateResponse.error) {
              console.error(`Failed to update message for retry:`, updateResponse.error)
              // Continue anyway, we'll return a 429 to indicate retry is needed
            } else {
              console.log(`Successfully scheduled message ${messageId} for retry at ${nextRetryTime.toISOString()}`)
            }
          } catch (updateInvokeError) {
            console.error(`Failed to invoke update-message function:`, updateInvokeError)
            // Continue anyway, we'll return a 429 to indicate retry is needed
          }
        } else if (retryCount >= RETRY_CONFIG.MAX_RETRIES) {
          // Move to dead letter queue after max retries
          try {
            console.log(`Moving message ${messageId} to dead letter queue after ${retryCount} failed attempts`)
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
            })
            
            if (dlqResponse.error) {
              console.error(`Failed to move message to DLQ:`, dlqResponse.error)
            } else {
              console.log(`Successfully moved message ${messageId} to DLQ`)
            }
          } catch (dlqInvokeError) {
            console.error(`Failed to invoke send-message for DLQ:`, dlqInvokeError)
          }
          
          // Delete the original message
          try {
            console.log(`Attempting to delete failed message ${messageId} from queue ${QUEUE_NAME}`)
            const deleteResponse = await supabase.functions.invoke('delete-message', {
              body: {
                queue_name: QUEUE_NAME,
                message_id: messageId
              }
            })
            
            if (deleteResponse.error) {
              console.error(`Failed to delete message after moving to DLQ:`, deleteResponse.error)
            } else {
              console.log(`Successfully deleted failed message ${messageId} after moving to DLQ`)
            }
          } catch (deleteInvokeError) {
            console.error(`Failed to invoke delete-message function:`, deleteInvokeError)
          }
        }
        
        // Don't return here, continue processing the next message
        console.log(`Failed to process token ${mint}: ${error.message}`)
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
  const totalMessages = Array.isArray(messages) ? messages.length : 0
  console.log(`Process stats summary: ${successCount} succeeded, ${failureCount} failed, total: ${totalMessages}`)
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
