-- Drop existing tables if they exist
DROP TABLE IF EXISTS token_stats_queue;
DROP TABLE IF EXISTS historical_records;
DROP TABLE IF EXISTS token_hotness;
DROP TABLE IF EXISTS archived_tokens;
DROP TABLE IF EXISTS tokens;

-- Create tokens table
CREATE TABLE tokens (
  id SERIAL PRIMARY KEY,
  mint TEXT UNIQUE NOT NULL,
  name TEXT,
  symbol TEXT,
  market_cap_usd FLOAT,
  liquidity_usd FLOAT,
  start_market_cap FLOAT,
  cumulative_buy_volume FLOAT DEFAULT 0,
  cumulative_net_volume FLOAT DEFAULT 0,
  last_updated TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  deadline TIMESTAMP WITH TIME ZONE
);

-- Create token_hotness table (no longer protected)
CREATE TABLE token_hotness (
  id SERIAL PRIMARY KEY,
  token_mint TEXT UNIQUE NOT NULL,
  name TEXT,
  symbol TEXT,
  detected_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  market_cap_usd FLOAT,
  start_market_cap FLOAT,
  liquidity_usd FLOAT,
  cumulative_buy_volume FLOAT,
  cumulative_net_volume FLOAT
);

-- Create archived_tokens table
CREATE TABLE archived_tokens (
  id SERIAL PRIMARY KEY,
  token_mint TEXT UNIQUE NOT NULL,
  name TEXT,
  symbol TEXT,
  start_market_cap FLOAT,
  final_market_cap FLOAT,
  liquidity_usd FLOAT,
  cumulative_buy_volume FLOAT,
  cumulative_net_volume FLOAT,
  created_at TIMESTAMP WITH TIME ZONE,
  archived_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  deadline TIMESTAMP WITH TIME ZONE
);

-- Create historical_records table
CREATE TABLE historical_records (
  id SERIAL PRIMARY KEY,
  token_mint TEXT NOT NULL,
  name TEXT,
  symbol TEXT,
  market_cap_usd FLOAT,
  liquidity_usd FLOAT,
  cumulative_buy_volume FLOAT,
  cumulative_net_volume FLOAT,
  timestamp TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Create token_stats_queue table
CREATE TABLE token_stats_queue (
  id SERIAL PRIMARY KEY,
  queue_name TEXT NOT NULL,
  message_id TEXT UNIQUE NOT NULL,
  message JSONB NOT NULL,
  visible_after TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Create indexes for better performance
CREATE INDEX idx_tokens_mint ON tokens(mint);
CREATE INDEX idx_token_hotness_mint ON token_hotness(token_mint);
CREATE INDEX idx_archived_tokens_mint ON archived_tokens(token_mint);
CREATE INDEX idx_historical_records_mint ON historical_records(token_mint);
CREATE INDEX idx_token_stats_queue_visible ON token_stats_queue(visible_after);
CREATE INDEX idx_token_stats_queue_message_id ON token_stats_queue(message_id);
