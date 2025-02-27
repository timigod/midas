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

const app = express();
const port = process.env.PORT || 3000;

// Initialize queue for token stats fetching
const QUEUE_NAME = 'token_stats_queue';
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
  
  const { error } = await supabase
    .from('tokens')
    .insert(tokenForDb);

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
        minLiquidity: 20000,
        minMarketCap: 200000,
        limit: 100
      }
    });

    const discoveredTokens = response.data.data;
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
            is_hot: false, // Initially set to false
            created_at: currentTime,
            last_updated: currentTime,
            deadline: new Date(currentTime.getTime() + 6 * 60 * 60 * 1000) // current time + 6 hours
          };

          // Store token in database and queue for stats fetching
          await insertToken(newToken);
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
      is_hot: req.body.isHot || req.body.is_hot || false,
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

// Start the server
app.listen(port, () => {
  console.log(`🚀 Midas is running on port ${port}`);
});
