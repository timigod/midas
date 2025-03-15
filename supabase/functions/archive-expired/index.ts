import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.39.0'

// Initialize Supabase client
const supabaseUrl = Deno.env.get('SUPABASE_URL')!
const supabaseKey = Deno.env.get('SUPABASE_ANON_KEY')!
const supabase = createClient(supabaseUrl, supabaseKey)

Deno.serve(async (req) => {
  try {
    console.log('Starting expired tokens archival process...')
    const currentTime = new Date().toISOString()
    const archivedTokens = []
    const errors = []
    
    // Get tokens that have passed their deadline
    const { data: expiredTokens, error: fetchError } = await supabase
      .from('tokens')
      .select('*')
      .lt('deadline', currentTime)
    
    if (fetchError) {
      console.error('Error fetching expired tokens:', fetchError)
      errors.push(fetchError.message)
      return new Response(
        JSON.stringify({ 
          error: 'Failed to fetch expired tokens', 
          details: fetchError.message 
        }),
        { headers: { 'Content-Type': 'application/json' }, status: 500 }
      )
    }
    
    console.log(`Found ${expiredTokens?.length || 0} expired tokens to archive`)
    
    // Archive each expired token
    for (const token of (expiredTokens || [])) {
      try {
        // Insert token into archived_tokens table
        const { error: archiveError } = await supabase
          .from('archived_tokens')
          .insert({
            token_mint: token.mint,
            name: token.name,
            symbol: token.symbol,
            start_market_cap: token.start_market_cap,
            final_market_cap: token.market_cap_usd,
            liquidity_usd: token.liquidity_usd,
            cumulative_buy_volume: token.cumulative_buy_volume,
            cumulative_net_volume: token.cumulative_net_volume,
            created_at: token.created_at,
            deadline: token.deadline
          })
        
        if (archiveError) {
          console.error(`Error archiving token ${token.mint}:`, archiveError)
          errors.push(`Failed to archive token ${token.mint}: ${archiveError.message}`)
          continue
        }
        
        // Delete token from tokens table
        const { error: deleteError } = await supabase
          .from('tokens')
          .delete()
          .eq('mint', token.mint)
        
        if (deleteError) {
          console.error(`Error deleting token ${token.mint}:`, deleteError)
          errors.push(`Failed to delete token ${token.mint}: ${deleteError.message}`)
          continue
        }
        
        archivedTokens.push({
          mint: token.mint,
          name: token.name,
          symbol: token.symbol,
          deadline: token.deadline,
          marketCapUsd: token.market_cap_usd,
          startMarketCap: token.start_market_cap
        })
        
        console.log(`Archived token ${token.mint} (deadline passed)`)
      } catch (error) {
        console.error(`Error processing token ${token.mint}:`, error)
        errors.push(`Error processing token ${token.mint}: ${error.message}`)
      }
    }
    
    return new Response(
      JSON.stringify({
        message: `Archival process completed. Archived ${archivedTokens.length} expired tokens.`,
        archivedTokens,
        errors: errors.length > 0 ? errors : null
      }),
      { headers: { 'Content-Type': 'application/json' }, status: 200 }
    )
  } catch (error) {
    console.error('Archival process error:', error)
    return new Response(
      JSON.stringify({
        error: 'Failed to archive expired tokens',
        details: error.message
      }),
      { headers: { 'Content-Type': 'application/json' }, status: 500 }
    )
  }
})
