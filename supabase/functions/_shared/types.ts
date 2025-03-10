export interface Token {
  mint: string;
  startMarketCap: number;
  liquidityUsd: number;
  marketCapUsd: number;
  cumulativeBuyVolume: number;
  cumulativeNetVolume: number;
  isHot: boolean;
  isActive: boolean;
  createdAt: string;
  lastUpdated: string;
  deadline: string;
}

export interface HistoricalRecord {
  tokenMint: string;
  marketCapUsd: number;
  liquidityUsd: number;
  cumulativeBuyVolume: number;
  cumulativeNetVolume: number;
  timestamp: string;
}

// Interface for the stats/{mint} endpoint response
export interface TokenStats {
  // Time-based stats with volume data
  "1m"?: TimeStats;
  "5m"?: TimeStats;
  "15m"?: TimeStats;
  "30m"?: TimeStats;
  "1h"?: TimeStats;
  "2h"?: TimeStats;
  "3h"?: TimeStats;
  "4h"?: TimeStats;
  "5h"?: TimeStats;
  "6h"?: TimeStats;
  "12h"?: TimeStats;
  "24h"?: TimeStats;

  // Required properties for validation
  marketCapUsd: number;
  liquidityUsd: number;
}

// Time-based statistics structure
export interface TimeStats {
  buyers?: number;
  sellers?: number;
  volume?: {
    buys: number;
    sells: number;
    total?: number;
  };
  transactions?: number;
  buys?: number;
  sells?: number;
  wallets?: number;
  price?: number;
  priceChangePercentage?: number;
}

export interface HotnessCheckResult {
  isHot: boolean;
  reason?: string;
}

export function checkTokenHotness(
  startMarketCap: number,
  currentMarketCap: number,
  cumulativeBuyVolume: number,
  cumulativeNetVolume: number,
  currentLiquidity: number
): HotnessCheckResult {
  // Market Cap Growth: currentMarketCap >= 3 × startMarketCap
  if (currentMarketCap < startMarketCap * 3) {
    return { isHot: false, reason: "Market cap growth less than 3x" };
  }

  // Cumulative Buy Volume Ratio: (cumulativeBuyVolume / currentMarketCap) >= 0.05
  if (cumulativeBuyVolume / currentMarketCap < 0.05) {
    return { isHot: false, reason: "Buy volume ratio less than 5%" };
  }

  // Cumulative Net Volume: Must be positive (> 0)
  if (cumulativeNetVolume <= 0) {
    return { isHot: false, reason: "Net volume not positive" };
  }

  // Liquidity-to-Market Cap Ratio: Current liquidity is at least 3% of current market cap
  if (currentLiquidity / currentMarketCap < 0.03) {
    return { isHot: false, reason: "Liquidity ratio less than 3%" };
  }

  return { isHot: true };
}

export interface QueueMessage {
  mint: string;
  retryCount: number;
  lastRetry?: string;
  nextRetryTime?: string;
  retryHistory?: Array<{
    retryCount: number;
    error: string;
    time: string;
  }>;
  error?: string; // Error message for debugging
  failedAt?: string; // Timestamp when the processing failed
}

export interface QueueMessageWithId extends QueueMessage {
  message_id: string;
}

// Exponential backoff configuration
export const RETRY_CONFIG = {
  MAX_RETRIES: 5,
  BASE_DELAY_MS: 2000, // 2 seconds
  MAX_DELAY_MS: 300000, // 5 minutes
  JITTER_MS: 1000, // Random delay between 0-1000ms to prevent thundering herd
};

// Calculate next retry time with exponential backoff
export function calculateNextRetryTime(retryCount: number): Date {
  const delay = Math.min(
    RETRY_CONFIG.BASE_DELAY_MS * Math.pow(2, retryCount) +
      Math.random() * RETRY_CONFIG.JITTER_MS,
    RETRY_CONFIG.MAX_DELAY_MS
  );
  return new Date(Date.now() + delay);
}
