import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.39.0'

// Initialize Supabase client
const supabaseUrl = Deno.env.get('SUPABASE_URL')!
const supabaseKey = Deno.env.get('SUPABASE_ANON_KEY')!
const supabase = createClient(supabaseUrl, supabaseKey)

Deno.serve(async (req) => {
  try {
    const { queue_name, message_id } = await req.json()

    if (!queue_name || !message_id) {
      return new Response(
        JSON.stringify({ error: 'queue_name and message_id are required' }),
        { headers: { 'Content-Type': 'application/json' }, status: 400 }
      )
    }

    // Delete message from queue
    const { error } = await supabase
      .from(queue_name)
      .delete()
      .eq('id', message_id)

    if (error) throw error

    return new Response(
      JSON.stringify({ success: true }),
      { headers: { 'Content-Type': 'application/json' } }
    )
  } catch (error) {
    return new Response(
      JSON.stringify({ error: error.message }),
      { headers: { 'Content-Type': 'application/json' }, status: 500 }
    )
  }
})
