import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.39.0'

// Initialize Supabase client
const supabaseUrl = Deno.env.get('SUPABASE_URL')!
const supabaseKey = Deno.env.get('SUPABASE_ANON_KEY')!
const supabase = createClient(supabaseUrl, supabaseKey)

Deno.serve(async (req) => {
  try {
    const { queue_name, batch_size = 10, visibility_timeout = 30, filter } = await req.json()
    
    console.log(`Received request to read messages from queue: ${queue_name}`)
    console.log(`Parameters: batch_size=${batch_size}, visibility_timeout=${visibility_timeout}, filter=${filter || 'none'}`)

    if (!queue_name) {
      return new Response(
        JSON.stringify({ error: 'queue_name is required' }),
        { headers: { 'Content-Type': 'application/json' }, status: 400 }
      )
    }

    // Build query - don't use .filter() as it's causing issues
    let query = supabase
      .from(queue_name)
      .select('*')
      .eq('status', 'pending')
      .limit(batch_size)
      .order('created_at', { ascending: true })
      
    // Execute the query
    const { data: messages, error: selectError } = await query

    if (selectError) {
      console.error(`Error selecting messages: ${selectError.message}`)
      throw selectError
    }

    if (!messages || messages.length === 0) {
      console.log('No pending messages found in queue')
      return new Response(
        JSON.stringify({ data: [] }),
        { headers: { 'Content-Type': 'application/json' } }
      )
    }
    
    console.log(`Found ${messages.length} messages to process`)

    // Update message visibility timeout
    const messageIds = messages.map(m => m.id)
    const visibilityTimeout = new Date(Date.now() + visibility_timeout * 1000).toISOString()

    console.log(`Setting visibility timeout to ${visibilityTimeout} for ${messageIds.length} messages`)
    
    const { error: updateError } = await supabase
      .from(queue_name)
      .update({
        status: 'processing',
        visible_after: visibilityTimeout,
        updated_at: new Date().toISOString()
      })
      .in('id', messageIds)

    if (updateError) {
      console.error(`Error updating message visibility: ${updateError.message}`)
      throw updateError
    }
    
    console.log(`Successfully updated message visibility for ${messageIds.length} messages`)

    return new Response(
      JSON.stringify({ data: messages }),
      { headers: { 'Content-Type': 'application/json' } }
    )
  } catch (error) {
    console.error(`Unhandled error in read-messages: ${error.message}`)
    console.error(error.stack || 'No stack trace available')
    
    return new Response(
      JSON.stringify({ 
        error: `Error reading messages: ${error.message}`,
        stack: error.stack,
        timestamp: new Date().toISOString()
      }),
      { headers: { 'Content-Type': 'application/json' }, status: 500 }
    )
  }
})
