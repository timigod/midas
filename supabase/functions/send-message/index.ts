import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.39.0'

// Initialize Supabase client
const supabaseUrl = Deno.env.get('SUPABASE_URL')!
const supabaseKey = Deno.env.get('SUPABASE_ANON_KEY')!
const supabase = createClient(supabaseUrl, supabaseKey)

Deno.serve(async (req) => {
  try {
    const { queue_name, message } = await req.json()

    if (!queue_name || !message) {
      return new Response(
        JSON.stringify({ error: 'queue_name and message are required' }),
        { headers: { 'Content-Type': 'application/json' }, status: 400 }
      )
    }

    // Insert message into queue table
    // The database will generate the id, which will be used as message_id for deletion
    const { error } = await supabase
      .from(queue_name)
      .insert({
        queue_name,
        message_id: queue_name + '_' + new Date().getTime().toString(), // Generate a unique string ID
        message,
        visible_after: new Date().toISOString(),
        created_at: new Date().toISOString()
      })

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
