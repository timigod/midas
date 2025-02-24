import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.39.0'
import { Token, checkTokenHotness } from '../_shared/types.ts'

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
    const validTokens: Token[] = []
    const currentTime = new Date()

    for (const token of discoveredTokens) {
      // Check liquidity criteria (liquidityUsd >= 0.03 × marketCapUsd)
      if (token.liquidityUsd >= 0.03 * token.marketCapUsd) {
        // Check if token needs immediate hotness check (market cap >= $600K)
        const IMMEDIATE_CHECK_THRESHOLD = 600000;

        if (token.marketCapUsd >= IMMEDIATE_CHECK_THRESHOLD) {
          console.log(`Token ${token.mint} qualifies for immediate hotness check with market cap $${token.marketCapUsd}`);
          
          // For immediate check, we use current values since we just discovered the token
          const hotnessCheck = checkTokenHotness(
            token.marketCapUsd, // startMarketCap is same as current for new tokens
            token.marketCapUsd,
            token['24h'].volume.buys,
            token['24h'].volume.buys - token['24h'].volume.sells, // net volume
            token.liquidityUsd
          );

          console.log(`Immediate hotness check for ${token.mint}: ${hotnessCheck.isHot ? 'HOT!' : 'Not hot'} ${hotnessCheck.reason ? `(${hotnessCheck.reason})` : ''}`);

          // If token is hot, record it in token_hotness table
          if (hotnessCheck.isHot) {
            const { error: hotnessError } = await supabase
              .from('token_hotness')
              .insert({
                token_mint: token.mint,
                market_cap_usd: token.marketCapUsd,
                start_market_cap: token.marketCapUsd,
                liquidity_usd: token.liquidityUsd,
                cumulative_buy_volume: token['24h'].volume.buys,
                cumulative_net_volume: token['24h'].volume.buys - token['24h'].volume.sells
              });

            if (hotnessError) {
              console.error(`Failed to record hotness for token ${token.mint}:`, hotnessError);
            }
          }
        }

        const newToken: Token = {
          mint: token.mint,
          startMarketCap: token.marketCapUsd,
          liquidityUsd: token.liquidityUsd,
          marketCapUsd: token.marketCapUsd,
          cumulativeBuyVolume: token['24h'].volume.buys,
          cumulativeNetVolume: token['24h'].volume.buys - token['24h'].volume.sells,
          createdAt: currentTime.toISOString(),
          lastUpdated: currentTime.toISOString(),
          deadline: new Date(currentTime.getTime() + 6 * 60 * 60 * 1000).toISOString() // current time + 6 hours
        }

        try {
          // Store token in database
          const { error: insertError } = await supabase
            .from('tokens')
            .insert(newToken)

          if (insertError) throw insertError

          // Queue token for stats processing with retry metadata
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
            })

          if (queueError) throw queueError

          validTokens.push(newToken)
        } catch (error) {
          console.error(`Failed to process token ${token.mint}:`, error)
          continue
        }
      }
    }

    return new Response(
      JSON.stringify({
        message: `Discovery completed. Found ${validTokens.length} valid tokens.`,
        summary: {
          totalTokensChecked: discoveredTokens.length,
          validTokensFound: validTokens.length,
          liquidityFilterRejections: discoveredTokens.length - validTokens.length
        },
        tokens: validTokens
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
