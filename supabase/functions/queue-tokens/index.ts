import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.39.0'

// Initialize Supabase client
const supabaseUrl = Deno.env.get('SUPABASE_URL')!
const supabaseKey = Deno.env.get('SUPABASE_ANON_KEY')!
const supabase = createClient(supabaseUrl, supabaseKey)

// Constants
const QUEUE_NAME = 'token_stats_queue'

Deno.serve(async (req) => {
  try {
    console.log('Starting token queuing process...')
    const currentTime = new Date().toISOString()
    const queuedTokens: string[] = []
    const errors: string[] = []
    
    // Get all tokens from the tokens table
    const { data: tokens, error: tokensError } = await supabase
      .from('tokens')
      .select('mint, name, symbol')
    
    if (tokensError) {
      console.error('Error fetching tokens:', tokensError)
      errors.push(`Failed to fetch tokens: ${tokensError.message}`)
    }
    
    // Get all tokens from the token_hotness table
    const { data: hotTokens, error: hotTokensError } = await supabase
      .from('token_hotness')
      .select('token_mint, name, symbol')
    
    if (hotTokensError) {
      console.error('Error fetching hot tokens:', hotTokensError)
      errors.push(`Failed to fetch hot tokens: ${hotTokensError.message}`)
    }
    
    // Combine both lists, ensuring no duplicates
    const allTokens = [
      ...(tokens || []).map(token => ({ mint: token.mint, name: token.name, symbol: token.symbol })),
      ...(hotTokens || []).map(token => ({ mint: token.token_mint, name: token.name, symbol: token.symbol }))
    ]
    
    // Remove duplicates by mint address
    const uniqueTokens = Array.from(
      new Map(allTokens.map(token => [token.mint, token])).values()
    )
    
    console.log(`Found ${uniqueTokens.length} unique tokens to queue`)
    
    // Check which tokens are already in the queue
    const { data: queuedMessages, error: queueError } = await supabase
      .from(QUEUE_NAME)
      .select('message')
    
    if (queueError) {
      console.error('Error fetching queued messages:', queueError)
      errors.push(`Failed to fetch queued messages: ${queueError.message}`)
    }
    
    // Extract mint addresses from queued messages
    const queuedMints = new Set(
      (queuedMessages || [])
        .map(msg => {
          try {
            return typeof msg.message === 'string' 
              ? JSON.parse(msg.message).mint 
              : msg.message.mint
          } catch (e) {
            return null
          }
        })
        .filter(Boolean)
    )
    
    console.log(`Found ${queuedMints.size} tokens already in queue`)
    
    // Queue tokens that aren't already in the queue
    for (const token of uniqueTokens) {
      if (queuedMints.has(token.mint)) {
        console.log(`Token ${token.mint} is already in queue, skipping`)
        continue
      }
      
      try {
        const queueResponse = await supabase.functions.invoke('send-message', {
          body: {
            queue_name: QUEUE_NAME,
            message: {
              mint: token.mint,
              name: token.name,
              symbol: token.symbol,
              timestamp: currentTime
            }
          }
        })
        
        if (queueResponse.error) {
          console.error(`Failed to queue token ${token.mint}:`, queueResponse.error)
          errors.push(`Failed to queue token ${token.mint}: ${queueResponse.error.message}`)
        } else {
          console.log(`Successfully queued token ${token.mint} for processing`)
          queuedTokens.push(token.mint)
        }
      } catch (queueError) {
        console.error(`Error invoking send-message function for ${token.mint}:`, queueError)
        errors.push(`Error queuing token ${token.mint}: ${queueError.message}`)
      }
    }
    
    return new Response(
      JSON.stringify({
        message: `Queuing process completed. Queued ${queuedTokens.length} tokens for processing.`,
        queuedTokens,
        errors: errors.length > 0 ? errors : null
      }),
      { headers: { 'Content-Type': 'application/json' }, status: 200 }
    )
  } catch (error) {
    console.error('Queuing process error:', error)
    return new Response(
      JSON.stringify({
        error: 'Failed to queue tokens',
        details: error.message
      }),
      { headers: { 'Content-Type': 'application/json' }, status: 500 }
    )
  }
})
