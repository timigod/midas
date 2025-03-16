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
const MIN_MARKET_CAP = 50000 // Minimum market cap of $50K
const TOKEN_MONITORING_HOURS = 6 // How long to monitor tokens before archiving

Deno.serve(async (req) => {
  try {
    const currentTime = new Date().toISOString()
    console.log(`Starting token discovery at ${currentTime}`)
    
    // Parse request for any custom parameters
    let requestParams = {}
    try {
      requestParams = await req.json()
    } catch (e) {
      // If no JSON body or invalid JSON, use empty object
      console.log('No request body or invalid JSON, using default parameters')
    }
    
    // Set up parameters for the Solana Tracker API call
    const searchParams = new URLSearchParams({
      minMarketCap: String(MIN_MARKET_CAP), // Apply minimum market cap filter
      limit: '50', // Limit to 50 tokens per request
      ...requestParams // Include any custom parameters from the request
    })
    
    // Fetch new tokens from Solana Tracker API
    const response = await fetch(`${SOLANA_TRACKER_API_URL}/search?${searchParams.toString()}`, {
      headers: {
        'x-api-key': SOLANA_TRACKER_API_KEY
      },
      method: 'GET'
    })

    if (!response.ok) {
      throw new Error(`Failed to fetch tokens: ${response.statusText}`)
    }

    const data = await response.json()
    const tokens = data.data || []
    
    if (!Array.isArray(tokens) || tokens.length === 0) {
      return new Response(
        JSON.stringify({ message: 'No tokens found or invalid response format' }),
        { headers: { 'Content-Type': 'application/json' }, status: 200 }
      )
    }
    
    console.log(`Found ${tokens.length} tokens from API`)
    
    // Process each token
    const processedTokens: any[] = []
    const queuedTokens: any[] = []
    const rejectedTokens: { mint?: string; reason: string }[] = []

    for (const token of tokens) {
      const mint = token.mint
      
      if (!mint) {
        console.warn('Token missing mint address, skipping')
        rejectedTokens.push({ reason: 'Missing mint address' })
        continue
      }
      
      // Check if token already exists in our database
      const { data: existingToken } = await supabase
        .from('tokens')
        .select('mint')
        .eq('mint', mint)
        .maybeSingle()
      
      // Also check if token exists in token_hotness
      const { data: existingHotToken } = await supabase
        .from('token_hotness')
        .select('token_mint')
        .eq('token_mint', mint)
        .maybeSingle()
      
      // Skip if token already exists in either table
      if (existingToken || existingHotToken) {
        console.log(`Token ${mint} already exists in database, skipping`)
        rejectedTokens.push({ mint, reason: 'Already exists in database' })
        continue
      }
      
      // Apply liquidity ratio check (liquidity should be at least 3% of market cap)
      if (token.liquidityUsd < 0.03 * token.marketCapUsd) {
        rejectedTokens.push({ mint, reason: `Insufficient liquidity ratio` })
        continue
      }
      
      // Fetch volume data from stats endpoint
      const statsResponse = await fetch(`${SOLANA_TRACKER_API_URL}/stats/${mint}`, {
        headers: {
          'x-api-key': SOLANA_TRACKER_API_KEY
        },
        method: 'GET'
      })
      
      let buyVolume = 0
      let sellVolume = 0
      let netVolume = 0
      
      if (statsResponse.ok) {
        const statsData = await statsResponse.json()
        
        // Extract 24h volume data from the stats response
        if (statsData['24h'] && statsData['24h'].volume) {
          buyVolume = statsData['24h'].volume.buys || 0
          sellVolume = statsData['24h'].volume.sells || 0
          netVolume = buyVolume - sellVolume
          
          console.log(`Token ${mint} 24h volumes - Buy: ${buyVolume}, Sell: ${sellVolume}, Net: ${netVolume}`)
          
          // Additional volume-based filtering
          if (buyVolume < 0.01 * token.marketCapUsd) {
            rejectedTokens.push({ mint, reason: `Insufficient buy volume` })
            continue
          }
          
          if (netVolume <= 0) {
            rejectedTokens.push({ mint, reason: `Negative or zero net volume` })
            continue
          }
        } else {
          console.warn(`No 24h volume data found for token ${mint}`)
        }
      } else {
        console.warn(`Failed to fetch stats for ${mint}: ${statsResponse.statusText}`)
      }
      
      // Calculate deadline (6 hours from now)
      const deadline = new Date()
      deadline.setHours(deadline.getHours() + TOKEN_MONITORING_HOURS)
      
      // Insert token into database
      const { error: insertError } = await supabase
        .from('tokens')
        .insert({
          mint: token.mint,
          name: token.name,
          symbol: token.symbol,
          market_cap_usd: token.marketCapUsd,
          liquidity_usd: token.liquidityUsd,
          start_market_cap: token.marketCapUsd,
          cumulative_buy_volume: buyVolume,
          cumulative_net_volume: netVolume,
          deadline: deadline.toISOString()
        })
      
      if (insertError) {
        console.error(`Failed to insert token ${mint}:`, insertError)
        rejectedTokens.push({ mint, reason: `Database insert error: ${insertError.message}` })
        continue
      }
      
      // Insert initial historical record
      const { error: historyError } = await supabase
        .from('historical_records')
        .insert({
          token_mint: token.mint,
          name: token.name,
          symbol: token.symbol,
          market_cap_usd: token.marketCapUsd,
          liquidity_usd: token.liquidityUsd,
          cumulative_buy_volume: buyVolume,
          cumulative_net_volume: netVolume,
          timestamp: new Date().toISOString()
        })
        
      if (historyError) {
        console.error(`Failed to insert historical record for ${mint}:`, historyError)
        // Continue processing even if historical record insertion fails
      } else {
        console.log(`Created initial historical record for token ${mint}`)
      }
      
      processedTokens.push({
        mint,
        name: token.name,
        symbol: token.symbol,
        marketCapUsd: token.marketCapUsd,
        liquidityUsd: token.liquidityUsd
      })
      
      // Queue token for processing
      try {
        const queueResponse = await supabase.functions.invoke('send-message', {
          body: {
            queue_name: QUEUE_NAME,
            message: {
              mint: token.mint,
              timestamp: currentTime
            }
          }
        })
        
        if (queueResponse.error) {
          console.error(`Failed to queue token ${mint}:`, queueResponse.error)
        } else {
          console.log(`Successfully queued token ${mint} for processing`)
          queuedTokens.push(mint)
        }
      } catch (queueError) {
        console.error(`Error invoking send-message function for ${mint}:`, queueError)
      }
    }
    
    return new Response(
      JSON.stringify({
        message: `Processed ${tokens.length} tokens, added ${processedTokens.length} new tokens to database`,
        processed: processedTokens,
        queued: queuedTokens,
        rejected: rejectedTokens
      }),
      { headers: { 'Content-Type': 'application/json' }, status: 200 }
    )
  } catch (error) {
    console.error('Error in discover function:', error)
    return new Response(
      JSON.stringify({
        error: 'Failed to discover tokens',
        details: error.message || String(error),
        timestamp: new Date().toISOString()
      }),
      { headers: { 'Content-Type': 'application/json' }, status: 500 }
    )
  }
})
