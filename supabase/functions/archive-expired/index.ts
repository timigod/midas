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
    
    // Get tokens that have passed their deadline and aren't hot
    const { data: expiredTokens, error: fetchError } = await supabase
      .from('tokens')
      .select('*')
      .lt('deadline', currentTime)
      .eq('is_active', true)
      .is('is_hot', false) // Only get non-hot tokens
    
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
        
        archivedTokens.push({
          mint: token.mint,
          deadline: token.deadline,
          marketCapUsd: token.market_cap_usd,
          startMarketCap: token.start_market_cap
        })
        
        console.log(`Archived token ${token.mint} (deadline passed, not hot)`)
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

/* To invoke locally:

  1. Run `supabase start` (see: https://supabase.com/docs/reference/cli/supabase-start)
  2. Make an HTTP request:

  curl -i --location --request POST 'http://127.0.0.1:54321/functions/v1/archive-expired' \
    --header 'Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0' \
    --header 'Content-Type: application/json'

*/
