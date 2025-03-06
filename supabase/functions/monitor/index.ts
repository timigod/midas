import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.39.0'
import { checkTokenHotness } from '../_shared/types.ts'

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

// Market cap threshold for hotness check
const HOTNESS_CHECK_THRESHOLD = 600000 // $600K

Deno.serve(async (req) => {
  try {
    console.log('Starting 30-minute monitoring update...')
    const currentTime = new Date()
    const updatedTokens = []
    const hotTokens = []
    const errors = []

    // First, check for expired tokens to archive
    console.log('Checking for expired tokens to archive...')
    const { data: expiredTokens, error: fetchError } = await supabase
      .from('tokens')
      .select('*')
      .lt('deadline', currentTime.toISOString())
      .eq('is_active', true)
      .is('is_hot', false) // Only get non-hot tokens

    if (fetchError) {
      console.error('Error fetching expired tokens:', fetchError)
      errors.push(fetchError.message)
    } else {
      console.log(`Found ${expiredTokens?.length || 0} expired tokens to archive`)
      
      // Archive each expired token
      for (const token of (expiredTokens || [])) {
        try {
          // Update token to mark as inactive
          const { error: archiveError } = await supabase
            .from('tokens')
            .update({ is_active: false })
            .eq('mint', token.mint)
          
          if (archiveError) {
            console.error(`Error archiving token ${token.mint}:`, archiveError)
            errors.push(`Failed to archive token ${token.mint}: ${archiveError.message}`)
            continue
          }
          
          console.log(`Archived token ${token.mint} (deadline passed, not hot)`)
        } catch (error) {
          console.error(`Error processing token ${token.mint}:`, error)
          errors.push(`Error processing token ${token.mint}: ${error.message}`)
        }
      }
    }

    // Get all active tokens for monitoring
    const { data: tokens, error: tokensError } = await supabase
      .from('tokens')
      .select('*')
      .eq('is_active', true)
    
    if (tokensError) {
      throw tokensError
    }
    
    console.log(`Found ${tokens?.length || 0} active tokens to monitor`)
    
    // Process each token
    for (const token of (tokens || [])) {
      try {
        // Fetch current stats
        const statsResponse = await fetch(`${SOLANA_TRACKER_API_URL}/stats/${token.mint}`, {
          headers: {
            'x-api-key': SOLANA_TRACKER_API_KEY
          }
        })
        
        if (!statsResponse.ok) {
          if (statsResponse.status === 429) {
            // Rate limited, log and continue to next token
            console.error(`Rate limited when fetching stats for token ${token.mint}`)
            errors.push(`Rate limited for token ${token.mint}`)
            continue
          }
          throw new Error(`Failed to fetch stats for token ${token.mint}: ${statsResponse.statusText}`)
        }
        
        const stats = await statsResponse.json()
        
        // Extract 30-minute volume stats
        const thirtyMinBuys = stats['24h']?.volume?.buys || 0
        const thirtyMinSells = stats['24h']?.volume?.sells || 0
        const thirtyMinNetVolume = thirtyMinBuys - thirtyMinSells
        
        // Update token stats
        const updates = {
          market_cap_usd: stats.marketCapUsd,
          liquidity_usd: stats.liquidityUsd,
          cumulative_buy_volume: token.cumulative_buy_volume + thirtyMinBuys,
          cumulative_net_volume: token.cumulative_net_volume + thirtyMinNetVolume,
          last_updated: currentTime.toISOString()
        }
        
        const { error: updateError } = await supabase
          .from('tokens')
          .update(updates)
          .eq('mint', token.mint)
        
        if (updateError) {
          console.error(`Error updating token ${token.mint}:`, updateError)
          errors.push(`Failed to update token ${token.mint}: ${updateError.message}`)
          continue
        }
        
        // Add historical record - only if we have valid market cap and liquidity values
        if (updates.market_cap_usd !== null && updates.market_cap_usd !== undefined && 
            updates.liquidity_usd !== null && updates.liquidity_usd !== undefined) {
          const { error: historyError } = await supabase
            .from('historical_records')
            .insert({
              token_mint: token.mint,
              market_cap_usd: updates.market_cap_usd,
              liquidity_usd: updates.liquidity_usd,
              cumulative_buy_volume: updates.cumulative_buy_volume,
              cumulative_net_volume: updates.cumulative_net_volume,
              timestamp: currentTime.toISOString()
            })
          
          if (historyError) {
            console.error(`Error adding historical record for token ${token.mint}:`, historyError)
            errors.push(`Failed to add historical record for token ${token.mint}: ${historyError.message}`)
          }
        } else {
          console.warn(`Skipping historical record for token ${token.mint} due to null/undefined market cap or liquidity values`)
          errors.push(`Skipped historical record for token ${token.mint}: missing market cap or liquidity values`)
        }
        
        // Check if token should be evaluated for hotness (market cap >= $600K)
        if (updates.market_cap_usd >= HOTNESS_CHECK_THRESHOLD) {
          console.log(`Token ${token.mint} qualifies for hotness check with market cap $${updates.market_cap_usd}`)
          
          // Check hotness criteria
          const hotnessCheck = checkTokenHotness(
            token.start_market_cap,
            updates.market_cap_usd,
            updates.cumulative_buy_volume,
            updates.cumulative_net_volume,
            updates.liquidity_usd
          )
          
          console.log(`Hotness check for ${token.mint}: ${hotnessCheck.isHot ? 'HOT!' : 'Not hot'} ${hotnessCheck.reason ? `(${hotnessCheck.reason})` : ''}`)
          
          if (hotnessCheck.isHot) {
            // Check if token is already marked as hot
            const { data: existingHotness } = await supabase
              .from('token_hotness')
              .select('*')
              .eq('token_mint', token.mint)
              .limit(1)
            
            if (!existingHotness || existingHotness.length === 0) {
              // Insert into token_hotness table using admin client to bypass RLS
              const { error: hotnessError } = await supabaseAdmin
                .from('token_hotness')
                .insert({
                  token_mint: token.mint,
                  detected_at: currentTime.toISOString(),
                  market_cap_usd: updates.market_cap_usd,
                  start_market_cap: token.start_market_cap,
                  liquidity_usd: updates.liquidity_usd,
                  cumulative_buy_volume: updates.cumulative_buy_volume,
                  cumulative_net_volume: updates.cumulative_net_volume
                })
              
              if (hotnessError) {
                console.error(`Error marking token ${token.mint} as hot:`, hotnessError)
                errors.push(`Failed to mark token ${token.mint} as hot: ${hotnessError.message}`)
              } else {
                hotTokens.push(token.mint)
                console.log(`Token ${token.mint} marked as HOT! Market cap growth: ${updates.market_cap_usd / token.start_market_cap}x, Buy volume ratio: ${updates.cumulative_buy_volume / updates.market_cap_usd}, Net volume: ${updates.cumulative_net_volume}, Liquidity ratio: ${updates.liquidity_usd / updates.market_cap_usd}`)
              }
            } else {
              console.log(`Token ${token.mint} is already marked as hot, skipping...`)
            }
          }
        }
        
        updatedTokens.push({
          mint: token.mint,
          marketCapUsd: updates.market_cap_usd,
          liquidityUsd: updates.liquidity_usd,
          cumulativeBuyVolume: updates.cumulative_buy_volume,
          cumulativeNetVolume: updates.cumulative_net_volume
        })
        
        console.log(`Successfully updated token ${token.mint}`)
        
        // Add a small delay to avoid rate limiting
        await new Promise(resolve => setTimeout(resolve, 500))
      } catch (tokenError) {
        console.error(`Error updating token ${token.mint}:`, tokenError)
        errors.push({
          mint: token.mint,
          error: tokenError.message || 'Unknown error'
        })
      }
    }
    
    return new Response(
      JSON.stringify({
        message: `Monitoring update completed. Updated ${updatedTokens.length} tokens. ${hotTokens.length} tokens became hot.`,
        updatedTokens,
        hotTokens,
        errors
      }),
      { headers: { 'Content-Type': 'application/json' }, status: 200 }
    )
  } catch (error) {
    console.error('Monitoring error:', error)
    return new Response(
      JSON.stringify({
        error: 'Failed to perform monitoring update',
        details: error.message
      }),
      { headers: { 'Content-Type': 'application/json' }, status: 500 }
    )
  }
})

/* To invoke locally:

  1. Run `supabase start` (see: https://supabase.com/docs/reference/cli/supabase-start)
  2. Make an HTTP request:

  curl -i --location --request POST 'http://127.0.0.1:54321/functions/v1/monitor' \
    --header 'Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0' \
    --header 'Content-Type: application/json'

*/
