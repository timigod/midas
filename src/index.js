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
  const { error } = await supabase
    .from('tokens')
    .insert({
      mint: token.mint,
      start_market_cap: token.startMarketCap,
      liquidity_usd: token.liquidityUsd,
      market_cap_usd: token.marketCapUsd,
      cumulative_buy_volume: token.cumulativeBuyVolume,
      cumulative_net_volume: token.cumulativeNetVolume,
      is_hot: token.isHot,
      created_at: token.createdAt,
      last_updated: token.lastUpdated,
      deadline: token.deadline
    });
  
  if (error) throw error;
}

async function updateToken(mint, updates) {
  const { error } = await supabase
    .from('tokens')
    .update(updates)
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
  return data;
}

async function insertHistoricalRecord(record) {
  const { error } = await supabase
    .from('historical_records')
    .insert({
      token_mint: record.tokenMint,
      market_cap_usd: record.marketCapUsd,
      liquidity_usd: record.liquidityUsd,
      cumulative_buy_volume: record.cumulativeBuyVolume,
      cumulative_net_volume: record.cumulativeNetVolume
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
        const newToken = {
          mint: token.mint,
          startMarketCap: token.marketCapUsd,
          liquidityUsd: token.liquidityUsd,
          marketCapUsd: token.marketCapUsd,
          cumulativeBuyVolume: 0, // Will be updated by worker
          cumulativeNetVolume: 0, // Will be updated by worker
          isHot: false,
          createdAt: currentTime,
          lastUpdated: currentTime,
          deadline: new Date(currentTime.getTime() + 6 * 60 * 60 * 1000) // current time + 6 hours
        };

        // Store token in database and queue for stats fetching
        try {
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
app.post('/tokens', (req, res) => {
  const token = {
    ...req.body,
    createdAt: new Date(),
    lastUpdated: new Date()
  };
  tokens.set(token.mint, token);
  res.status(201).json(token);
});

app.get('/tokens/:mint', (req, res) => {
  const token = tokens.get(req.params.mint);
  if (!token) {
    return res.status(404).json({ error: 'Token not found' });
  }
  res.json(token);
});

// Start the server
app.listen(port, () => {
  console.log(`🚀 Midas is running on port ${port}`);
});
