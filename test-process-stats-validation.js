// Test script for process-stats validation logic
import fetch from 'node-fetch';
import { config } from 'dotenv';

// Load environment variables from .env file
config();

// Supabase function endpoint and authentication
const FUNCTIONS_URL = 'http://127.0.0.1:54321/functions/v1';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;

// Verify we have the necessary environment variables
if (!SUPABASE_ANON_KEY) {
  console.error('SUPABASE_ANON_KEY environment variable is not set');
  process.exit(1);
}

// Test cases for different token data scenarios
const testCases = [
  {
    name: "Valid token data with all fields",
    mint: "VALID_TOKEN",
    tokenStats: {
      marketCapUsd: 1000000,
      liquidityUsd: 50000,
      "24h": {
        volume: {
          buys: 10000,
          sells: 5000
        }
      }
    }
  },
  {
    name: "Missing market cap",
    mint: "MISSING_MARKET_CAP",
    tokenStats: {
      liquidityUsd: 50000,
      "24h": {
        volume: {
          buys: 10000,
          sells: 5000
        }
      }
    }
  },
  {
    name: "Invalid market cap (string instead of number)",
    mint: "INVALID_MARKET_CAP",
    tokenStats: {
      marketCapUsd: "1000000",
      liquidityUsd: 50000,
      "24h": {
        volume: {
          buys: 10000,
          sells: 5000
        }
      }
    }
  },
  {
    name: "Missing liquidity",
    mint: "MISSING_LIQUIDITY",
    tokenStats: {
      marketCapUsd: 1000000,
      "24h": {
        volume: {
          buys: 10000,
          sells: 5000
        }
      }
    }
  },
  {
    name: "Missing volume data",
    mint: "MISSING_VOLUME",
    tokenStats: {
      marketCapUsd: 1000000,
      liquidityUsd: 50000
    }
  },
  {
    name: "Incomplete volume data (missing sells)",
    mint: "INCOMPLETE_VOLUME",
    tokenStats: {
      marketCapUsd: 1000000,
      liquidityUsd: 50000,
      "24h": {
        volume: {
          buys: 10000
        }
      }
    }
  },
  {
    name: "Invalid volume data (strings instead of numbers)",
    mint: "INVALID_VOLUME",
    tokenStats: {
      marketCapUsd: 1000000,
      liquidityUsd: 50000,
      "24h": {
        volume: {
          buys: "10000",
          sells: "5000"
        }
      }
    }
  }
];

async function testProcessStatsValidation() {
  console.log('Testing process-stats validation logic...\n');
  
  for (const testCase of testCases) {
    try {
      console.log(`Test case: ${testCase.name}`);
      console.log(`Input data: ${JSON.stringify(testCase.tokenStats, null, 2)}`);
      
      const response = await fetch(`${FUNCTIONS_URL}/process-stats`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${SUPABASE_ANON_KEY}`
        },
        body: JSON.stringify({
          test: true,
          mint: testCase.mint,
          tokenStats: testCase.tokenStats
        })
      });
      
      const data = await response.json();
      console.log(`Status: ${response.status}`);
      console.log('Response:', data);
      
      console.log('\n-----------------------------------\n');
    } catch (error) {
      console.error(`Error testing case ${testCase.name}:`, error);
    }
  }
}

testProcessStatsValidation();
