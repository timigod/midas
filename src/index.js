import express from 'express';
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import axios from 'axios';
import crypto from 'crypto';

dotenv.config();

// Initialize Supabase client
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

// Initialize Supabase service role client for admin operations
const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Queue name for token stats processing
const QUEUE_NAME = 'token_stats_queue';

const app = express();
const port = process.env.PORT || 3000;

// Initialize queue for token stats fetching
async function initQueue() {
  try {
    const { error } = await supabase.functions.invoke('create-queue', {
      body: { queue_name: QUEUE_NAME }
    });
    if (error) throw error;
    console.log(`Queue ${QUEUE_NAME} initialized`);
  } catch (error) {
    console.error('Failed to initialize queue:', error);
  }
}
initQueue();

// Helper functions for database operations
async function insertToken(token) {
  // Create a copy of the token object without the is_hot field
  const { is_hot, ...tokenForDb } = token;

  // Use upsert instead of insert to handle duplicates
  const { error } = await supabase
    .from('tokens')
    .upsert(tokenForDb, {
      onConflict: 'mint',
      ignoreDuplicates: false
    });

  if (error) throw error;
}

async function updateToken(mint, updates) {
  // Create a copy of the updates object without the is_hot field
  const { is_hot, ...updatesForDb } = updates;

  const { error } = await supabase
    .from('tokens')
    .update(updatesForDb)
    .eq('mint', mint);

  if (error) throw error;
}

async function getToken(mint) {
  const { data, error } = await supabase
    .from('tokens')
    .select('*')
    .eq('mint', mint)
    .single();

  if (error) throw error;

  // Add is_hot field with default value of false
  if (data) {
    data.is_hot = false;

    // Check if token is in token_hotness table
    const { data: hotnessData, error: hotnessError } = await supabase
      .from('token_hotness')
      .select('*')
      .eq('token_mint', mint)
      .order('detected_at', { ascending: false })
      .limit(1);

    if (!hotnessError && hotnessData && hotnessData.length > 0) {
      data.is_hot = true;
    }
  }

  return data;
}

/**
 * Check if a token meets the hotness criteria and mark it as hot if it does
 * @param {Object} token - The token object with current stats
 * @returns {boolean} - Whether the token is hot
 */
async function checkTokenHotness(token) {
  try {
    // Get the latest token data from the database
    const { data: currentToken, error } = await supabase
      .from('tokens')
      .select('*')
      .eq('mint', token.mint)
      .single();

    if (error) throw error;
    if (!currentToken) return false;

    // Hotness criteria
    const marketCapGrowth = currentToken.market_cap_usd >= 3 * currentToken.start_market_cap;
    const buyVolumeRatio = (currentToken.cumulative_buy_volume / currentToken.market_cap_usd) >= 0.05;
    const positiveNetVolume = currentToken.cumulative_net_volume > 0;
    const liquidityRatio = currentToken.liquidity_usd >= 0.03 * currentToken.market_cap_usd;

    const isHot = marketCapGrowth && buyVolumeRatio && positiveNetVolume && liquidityRatio;

    if (isHot) {
      // Insert into token_hotness table using admin client to bypass RLS
      const { error: insertError } = await supabaseAdmin
        .from('token_hotness')
        .insert({
          token_mint: token.mint,
          detected_at: new Date().toISOString(),
          market_cap_usd: currentToken.market_cap_usd,
          start_market_cap: currentToken.start_market_cap,
          liquidity_usd: currentToken.liquidity_usd,
          cumulative_buy_volume: currentToken.cumulative_buy_volume,
          cumulative_net_volume: currentToken.cumulative_net_volume
        });

      if (insertError) throw insertError;
      
      console.log(`Token ${token.mint} marked as HOT! Market cap growth: ${currentToken.market_cap_usd / currentToken.start_market_cap}x, Buy volume ratio: ${currentToken.cumulative_buy_volume / currentToken.market_cap_usd}, Net volume: ${currentToken.cumulative_net_volume}, Liquidity ratio: ${currentToken.liquidity_usd / currentToken.market_cap_usd}`);
    }

    return isHot;
  } catch (error) {
    console.error(`Error checking hotness for token ${token.mint}:`, error);
    return false;
  }
}

async function insertHistoricalRecord(record) {
  const { error } = await supabase
    .from('historical_records')
    .insert({
      token_mint: record.token_mint,
      timestamp: record.timestamp || new Date(),
      market_cap_usd: record.market_cap_usd,
      liquidity_usd: record.liquidity_usd,
      cumulative_buy_volume: record.cumulative_buy_volume,
      cumulative_net_volume: record.cumulative_net_volume
    });

  if (error) throw error;
}

app.use(express.json());

// Configure Solana Tracker API client
const solanaTrackerApi = axios.create({
  baseURL: process.env.SOLANA_TRACKER_API_URL,
  headers: {
    'x-api-key': process.env.SOLANA_TRACKER_API_KEY
  }
});

// Discovery endpoint
app.post('/discover', async (req, res) => {
  try {
    const currentTime = new Date();

    // Call Solana Tracker search endpoint
    const response = await solanaTrackerApi.get('/search', {
      params: {
        sortBy: 'createdAt',
        sortOrder: 'desc',
        minLiquidity: 2000, // Lower threshold for testing
        minMarketCap: 20000, // Lower threshold for testing
        limit: 100
      }
    });

    const discoveredTokens = response.data.data || [];
    const validTokens = [];

    for (const token of discoveredTokens) {
      // Check liquidity criteria (liquidityUsd >= 0.03 × marketCapUsd)
      if (token.liquidityUsd >= 0.03 * token.marketCapUsd) {
        try {
          // Get token stats to initialize volume data
          const statsResponse = await solanaTrackerApi.get(`/stats/${token.mint}`);
          const stats = statsResponse.data;

          const buyVolume = stats['24h']?.volume?.buys || 0;
          const sellVolume = stats['24h']?.volume?.sells || 0;

          const newToken = {
            mint: token.mint,
            start_market_cap: token.marketCapUsd,
            liquidity_usd: token.liquidityUsd,
            market_cap_usd: token.marketCapUsd,
            cumulative_buy_volume: buyVolume,
            cumulative_net_volume: buyVolume - sellVolume,
            created_at: currentTime,
            last_updated: currentTime,
            deadline: new Date(currentTime.getTime() + 6 * 60 * 60 * 1000) // current time + 6 hours
          };

          // Store token in database and queue for stats fetching
          await insertToken(newToken);

          // If market cap is ≥ $600K, perform immediate hotness check
          let isHot = false;
          if (token.marketCapUsd >= 600000) {
            console.log(`Token ${token.mint} has market cap ≥ $600K (${token.marketCapUsd}), performing immediate hotness check`);
            isHot = await checkTokenHotness(newToken);
            if (isHot) {
              newToken.is_hot = true;
            }
          }

          await supabase.functions.invoke('send-message', {
            body: {
              queue_name: QUEUE_NAME,
              message: { mint: token.mint }
            }
          });
          validTokens.push(newToken);
        } catch (error) {
          console.error(`Failed to process token ${token.mint}:`, error);
          continue;
        }
      }
    }

    res.json({
      message: `Discovery completed. Found ${validTokens.length} valid tokens.`,
      summary: {
        totalTokensChecked: discoveredTokens.length,
        validTokensFound: validTokens.length,
        liquidityFilterRejections: discoveredTokens.length - validTokens.length
      },
      tokens: validTokens
    });
  } catch (error) {
    console.error('Discovery error:', error.response?.data || error.message);
    res.status(500).json({
      error: 'Failed to discover tokens',
      details: error.response?.data || error.message
    });
  }
});

// Mock discovery endpoint for testing
app.post('/mock-discover', async (req, res) => {
  try {
    const currentTime = new Date();

    // Mock tokens data
    const mockTokens = [
      {
        mint: 'mock1111111111111111111111111111111111111111',
        marketCapUsd: 500000,
        liquidityUsd: 50000, // 0.1 * marketCapUsd, should pass
        name: 'Mock Token 1'
      },
      {
        mint: 'mock2222222222222222222222222222222222222222',
        marketCapUsd: 300000,
        liquidityUsd: 6000, // 0.02 * marketCapUsd, should fail
        name: 'Mock Token 2'
      },
      {
        mint: 'mock3333333333333333333333333333333333333333',
        marketCapUsd: 1000000,
        liquidityUsd: 40000, // 0.04 * marketCapUsd, should pass
        name: 'Mock Token 3'
      }
    ];

    const validTokens = [];

    for (const token of mockTokens) {
      // Check liquidity criteria (liquidityUsd >= 0.03 × marketCapUsd)
      if (token.liquidityUsd >= 0.03 * token.marketCapUsd) {
        // Mock stats data
        const mockStats = {
          '24h': {
            volume: {
              buys: 100000,
              sells: 80000
            }
          }
        };

        const buyVolume = mockStats['24h']?.volume?.buys || 0;
        const sellVolume = mockStats['24h']?.volume?.sells || 0;

        const newToken = {
          mint: token.mint,
          start_market_cap: token.marketCapUsd,
          liquidity_usd: token.liquidityUsd,
          market_cap_usd: token.marketCapUsd,
          cumulative_buy_volume: buyVolume,
          cumulative_net_volume: buyVolume - sellVolume,
          created_at: currentTime,
          last_updated: currentTime,
          deadline: new Date(currentTime.getTime() + 6 * 60 * 60 * 1000) // current time + 6 hours
        };

        // Store token in database
        await insertToken(newToken);

        // If market cap is ≥ $600K, perform immediate hotness check
        let isHot = false;
        if (token.marketCapUsd >= 600000) {
          console.log(`Mock token ${token.mint} has market cap ≥ $600K (${token.marketCapUsd}), performing immediate hotness check`);
          
          // For mock tokens, we'll simulate growth to test the hotness check
          if (token.mint === 'mock3333333333333333333333333333333333333333') {
            // Update the token to simulate growth for testing
            await updateToken(token.mint, {
              market_cap_usd: token.marketCapUsd * 4, // 4x growth
              liquidity_usd: token.marketCapUsd * 0.15, // 15% of market cap (> 3% required)
              cumulative_buy_volume: token.marketCapUsd * 0.25, // 25% of market cap (> 5% required)
              cumulative_net_volume: token.marketCapUsd * 0.1 // positive net volume
            });
            
            // Get the updated token data
            const { data: updatedToken, error: getError } = await supabase
              .from('tokens')
              .select('*')
              .eq('mint', token.mint)
              .single();
              
            if (!getError && updatedToken) {
              // Log the token data to debug
              console.log('Updated token data for hotness check:', JSON.stringify(updatedToken));
              
              // Manually check hotness criteria
              const marketCapGrowth = updatedToken.market_cap_usd >= 3 * updatedToken.start_market_cap;
              const buyVolumeRatio = (updatedToken.cumulative_buy_volume / updatedToken.market_cap_usd) >= 0.05;
              const positiveNetVolume = updatedToken.cumulative_net_volume > 0;
              const liquidityRatio = updatedToken.liquidity_usd >= 0.03 * updatedToken.market_cap_usd;
              
              console.log(`Hotness check: marketCapGrowth=${marketCapGrowth}, buyVolumeRatio=${buyVolumeRatio}, positiveNetVolume=${positiveNetVolume}, liquidityRatio=${liquidityRatio}`);
              
              isHot = marketCapGrowth && buyVolumeRatio && positiveNetVolume && liquidityRatio;
              
              if (isHot) {
                // Insert into token_hotness table using admin client to bypass RLS
                const { error: insertError } = await supabaseAdmin
                  .from('token_hotness')
                  .insert({
                    token_mint: token.mint,
                    detected_at: new Date().toISOString(),
                    market_cap_usd: updatedToken.market_cap_usd,
                    start_market_cap: updatedToken.start_market_cap,
                    liquidity_usd: updatedToken.liquidity_usd,
                    cumulative_buy_volume: updatedToken.cumulative_buy_volume,
                    cumulative_net_volume: updatedToken.cumulative_net_volume
                  });
                  
                if (insertError) {
                  console.error(`Error inserting into token_hotness:`, insertError);
                } else {
                  console.log(`Token ${token.mint} marked as HOT!`);
                  newToken.is_hot = true;
                }
              }
            } else {
              console.error(`Error getting updated token:`, getError);
            }
          } else {
            // For other tokens, just check without simulating growth
            isHot = await checkTokenHotness(newToken);
            if (isHot) {
              newToken.is_hot = true;
            }
          }
        }

        // Queue token for stats processing
        try {
          await supabase.functions.invoke('send-message', {
            body: {
              queue_name: QUEUE_NAME,
              message: { mint: token.mint }
            }
          });
          console.log(`Queued token ${token.mint} for stats processing`);
        } catch (queueError) {
          console.error(`Failed to queue token ${token.mint}:`, queueError);
        }

        validTokens.push(newToken);
      }
    }

    res.json({
      message: `Mock discovery completed. Found ${validTokens.length} valid tokens.`,
      summary: {
        totalTokensChecked: mockTokens.length,
        validTokensFound: validTokens.length,
        liquidityFilterRejections: mockTokens.length - validTokens.length
      },
      tokens: validTokens
    });
  } catch (error) {
    console.error('Mock discovery error:', error);
    res.status(500).json({
      error: 'Failed to discover tokens',
      details: error.message
    });
  }
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({
    status: 'OK',
    message: 'Midas is running',
    timestamp: new Date().toISOString()
  });
});

// Basic token endpoints
app.post('/tokens', async (req, res) => {
  try {
    const token = {
      mint: req.body.mint,
      start_market_cap: req.body.startMarketCap || req.body.start_market_cap,
      liquidity_usd: req.body.liquidityUsd || req.body.liquidity_usd,
      market_cap_usd: req.body.marketCapUsd || req.body.market_cap_usd,
      cumulative_buy_volume: req.body.cumulativeBuyVolume || req.body.cumulative_buy_volume || 0,
      cumulative_net_volume: req.body.cumulativeNetVolume || req.body.cumulative_net_volume || 0,
      created_at: new Date(),
      last_updated: new Date(),
      deadline: req.body.deadline || new Date(Date.now() + 6 * 60 * 60 * 1000) // default 6 hours
    };

    await insertToken(token);
    res.status(201).json(token);
  } catch (error) {
    console.error('Error creating token:', error);
    res.status(500).json({ error: 'Failed to create token', details: error.message });
  }
});

app.get('/tokens/:mint', async (req, res) => {
  try {
    const token = await getToken(req.params.mint);
    if (!token) {
      return res.status(404).json({ error: 'Token not found' });
    }
    res.json(token);
  } catch (error) {
    console.error('Error retrieving token:', error);
    res.status(500).json({ error: 'Failed to retrieve token', details: error.message });
  }
});

// Historical record endpoint for testing
app.post('/historical-records', async (req, res) => {
  try {
    const record = {
      token_mint: req.body.token_mint,
      timestamp: req.body.timestamp || new Date(),
      market_cap_usd: req.body.market_cap_usd,
      liquidity_usd: req.body.liquidity_usd,
      cumulative_buy_volume: req.body.cumulative_buy_volume,
      cumulative_net_volume: req.body.cumulative_net_volume
    };

    await insertHistoricalRecord(record);
    res.status(201).json(record);
  } catch (error) {
    console.error('Error creating historical record:', error);
    res.status(500).json({ error: 'Failed to create historical record', details: error.message });
  }
});

// Add a new endpoint to check token details
app.get('/check-token/:mint', async (req, res) => {
  try {
    const { mint } = req.params;

    const { data, error } = await supabase
      .from('tokens')
      .select('*')
      .eq('mint', mint)
      .single();

    if (error) {
      return res.status(404).json({ message: 'Token not found', error: error.message });
    }

    return res.json({ message: 'Token found', token: data });
  } catch (error) {
    console.error('Error checking token:', error);
    return res.status(500).json({ message: 'Internal server error', error: error.message });
  }
});

// Start the server
app.listen(port, () => {
  console.log(`🚀 Midas is running on port ${port}`);
});
