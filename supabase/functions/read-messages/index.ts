import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.39.0'

// Initialize Supabase client
const supabaseUrl = Deno.env.get('SUPABASE_URL')!
const supabaseKey = Deno.env.get('SUPABASE_ANON_KEY')!
const supabase = createClient(supabaseUrl, supabaseKey)

Deno.serve(async (req) => {
  try {
    const { queue_name, batch_size = 10, visibility_timeout = 30, filter } = await req.json()

    if (!queue_name) {
      return new Response(
        JSON.stringify({ error: 'queue_name is required' }),
        { headers: { 'Content-Type': 'application/json' }, status: 400 }
      )
    }

    // Start transaction
    const { data: messages, error: selectError } = await supabase
      .from(queue_name)
      .select('*')
      .eq('status', 'pending')
      .filter(filter || '')
      .limit(batch_size)
      .order('created_at', { ascending: true })

    if (selectError) throw selectError

    if (!messages || messages.length === 0) {
      return new Response(
        JSON.stringify({ data: [] }),
        { headers: { 'Content-Type': 'application/json' } }
      )
    }

    // Update message visibility timeout
    const messageIds = messages.map(m => m.id)
    const visibilityTimeout = new Date(Date.now() + visibility_timeout * 1000).toISOString()

    const { error: updateError } = await supabase
      .from(queue_name)
      .update({
        status: 'processing',
        visible_after: visibilityTimeout,
        updated_at: new Date().toISOString()
      })
      .in('id', messageIds)

    if (updateError) throw updateError

    return new Response(
      JSON.stringify({ data: messages }),
      { headers: { 'Content-Type': 'application/json' } }
    )
  } catch (error) {
    return new Response(
      JSON.stringify({ error: error.message }),
      { headers: { 'Content-Type': 'application/json' }, status: 500 }
    )
  }
})
