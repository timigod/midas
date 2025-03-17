import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.39.0'

// Initialize Supabase client
const supabaseUrl = Deno.env.get('SUPABASE_URL')!
const supabaseKey = Deno.env.get('SUPABASE_ANON_KEY')!
const supabase = createClient(supabaseUrl, supabaseKey)

// Initialize Supabase admin client for operations that require bypassing RLS
const supabaseServiceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const supabaseAdmin = createClient(supabaseUrl, supabaseServiceRoleKey)

// Get Telegram configuration from environment variables
const TELEGRAM_BOT_TOKEN = Deno.env.get('TELEGRAM_BOT_TOKEN')!
const TELEGRAM_CHANNEL_ID = Deno.env.get('TELEGRAM_CHANNEL_ID')!

// Telegram API URL
const TELEGRAM_API_URL = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`

interface TokenHotness {
  token_mint: string;
  name?: string;
  symbol?: string;
  detected_at: string;
  market_cap_usd: number;
  start_market_cap: number;
  liquidity_usd: number;
  cumulative_buy_volume: number;
  cumulative_net_volume: number;
}

// Webhook payload structure from Supabase
interface WebhookPayload {
  type: 'INSERT' | 'UPDATE' | 'DELETE';
  table: string;
  schema: string;
  record: TokenHotness | null;
  old_record: TokenHotness | null;
}

/**
 * Format a number with commas and round to 2 decimal places
 */
function formatNumber(num: number): string {
  return num.toLocaleString('en-US', { 
    minimumFractionDigits: 2,
    maximumFractionDigits: 2 
  });
}

/**
 * Calculate the growth as a percentage
 */
function calculateGrowthPercentage(current: number, start: number): string {
  const growth = ((current - start) / start) * 100;
  return growth.toFixed(2) + '%';
}

/**
 * Format token details for the Telegram message
 */
function formatTokenMessage(token: TokenHotness): string {
  const marketCapGrowth = token.market_cap_usd / token.start_market_cap;
  const buyVolumeRatio = token.cumulative_buy_volume / token.market_cap_usd;
  const liquidityRatio = token.liquidity_usd / token.market_cap_usd;
  
  return `🔥 HOT TOKEN ALERT 🔥

*${token.name || 'Unknown Token'}* (${token.symbol || 'N/A'})
\`${token.token_mint}\`

📊 *Stats:*
• Market Cap: $${formatNumber(token.market_cap_usd)}
• Starting Market Cap: $${formatNumber(token.start_market_cap)}
• Growth: ${marketCapGrowth.toFixed(2)}x (${calculateGrowthPercentage(token.market_cap_usd, token.start_market_cap)})
• Liquidity: $${formatNumber(token.liquidity_usd)} (${(liquidityRatio * 100).toFixed(2)}% of MC)
• Buy Volume: $${formatNumber(token.cumulative_buy_volume)} (${(buyVolumeRatio * 100).toFixed(2)}% of MC)
• Net Volume: $${formatNumber(token.cumulative_net_volume)}

Detected at: ${new Date(token.detected_at).toUTCString()}

🔗 https://solscan.io/token/${token.token_mint}`;
}

/**
 * Send message to Telegram channel
 */
async function sendTelegramMessage(message: string): Promise<Response> {
  const params = new URLSearchParams({
    chat_id: TELEGRAM_CHANNEL_ID,
    text: message,
    parse_mode: 'Markdown',
    disable_web_page_preview: 'true'
  });

  try {
    console.log('Sending Telegram notification...');
    const response = await fetch(TELEGRAM_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: params.toString(),
    });

    if (!response.ok) {
      const errorData = await response.json();
      throw new Error(`Telegram API error: ${JSON.stringify(errorData)}`);
    }

    return response;
  } catch (error) {
    console.error('Failed to send Telegram notification:', error);
    throw error;
  }
}

Deno.serve(async (req) => {
  try {
    // Parse request body
    const payload = await req.json();
    
    // Extract token_mint from either webhook payload or direct API call
    let token_mint: string | undefined;
    
    // Check if this is a webhook payload
    if (payload.type === 'INSERT' && payload.record && payload.record.token_mint) {
      console.log('Received webhook payload for table:', payload.table);
      token_mint = payload.record.token_mint;
      
      // If we have the complete record, we can use it directly without fetching from DB
      if (isCompleteTokenRecord(payload.record)) {
        console.log('Using record data from webhook payload');
        return await handleTokenNotification(payload.record);
      }
    } 
    // Check for direct API call with token_mint parameter
    else if (payload.token_mint) {
      console.log('Received direct API call with token_mint');
      token_mint = payload.token_mint;
    }
    
    if (!token_mint) {
      return new Response(
        JSON.stringify({ error: 'Missing token_mint parameter or invalid webhook payload' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }

    if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHANNEL_ID) {
      return new Response(
        JSON.stringify({ error: 'Telegram configuration missing. Please set TELEGRAM_BOT_TOKEN and TELEGRAM_CHANNEL_ID in environment variables.' }),
        { status: 500, headers: { 'Content-Type': 'application/json' } }
      );
    }

    console.log(`Processing notification for token: ${token_mint}`);

    // Fetch token data from token_hotness table
    const { data: tokenData, error: tokenError } = await supabase
      .from('token_hotness')
      .select('*')
      .eq('token_mint', token_mint)
      .single();

    if (tokenError) {
      console.error(`Error fetching token data: ${tokenError.message}`);
      return new Response(
        JSON.stringify({ error: `Failed to fetch token data: ${tokenError.message}` }),
        { status: 500, headers: { 'Content-Type': 'application/json' } }
      );
    }

    if (!tokenData) {
      console.error(`Token not found: ${token_mint}`);
      return new Response(
        JSON.stringify({ error: `Token not found: ${token_mint}` }),
        { status: 404, headers: { 'Content-Type': 'application/json' } }
      );
    }
    
    return await handleTokenNotification(tokenData);
  } catch (error) {
    console.error('Error in notify-telegram function:', error);
    return new Response(
      JSON.stringify({ error: `Internal server error: ${error.message}` }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
});

/**
 * Check if a token record contains all the necessary fields for notification
 */
function isCompleteTokenRecord(record: any): record is TokenHotness {
  return (
    record &&
    typeof record.token_mint === 'string' &&
    typeof record.market_cap_usd === 'number' &&
    typeof record.start_market_cap === 'number' &&
    typeof record.liquidity_usd === 'number' &&
    typeof record.cumulative_buy_volume === 'number' &&
    typeof record.cumulative_net_volume === 'number'
  );
}

/**
 * Handle notification for a token
 */
async function handleTokenNotification(tokenData: TokenHotness): Promise<Response> {
  try {
    // Format the message and send to Telegram
    const message = formatTokenMessage(tokenData);
    await sendTelegramMessage(message);

    return new Response(
      JSON.stringify({ success: true, message: 'Telegram notification sent successfully' }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  } catch (error) {
    console.error('Error sending notification:', error);
    return new Response(
      JSON.stringify({ error: `Failed to send notification: ${error.message}` }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
}
