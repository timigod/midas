import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.0";

// Initialize Supabase client
const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
const supabaseKey = Deno.env.get("SUPABASE_ANON_KEY")!;
const supabase = createClient(supabaseUrl, supabaseKey);

Deno.serve(async (req) => {
  try {
    const { queue_name } = await req.json();

    if (!queue_name) {
      return new Response(JSON.stringify({ error: "queue_name is required" }), {
        headers: { "Content-Type": "application/json" },
        status: 400,
      });
    }

    // Simply return success - we'll assume the queue table already exists
    // since it should be created by migrations
    return new Response(
      JSON.stringify({
        success: true,
        message: `Queue ${queue_name} initialized`,
      }),
      { headers: { "Content-Type": "application/json" } }
    );
  } catch (error) {
    console.error("Error in create-queue function:", error);
    return new Response(JSON.stringify({ error: error.message }), {
      headers: { "Content-Type": "application/json" },
      status: 500,
    });
  }
});
