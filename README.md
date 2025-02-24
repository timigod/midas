# Midas

Token discovery and monitoring application for tracking newly launched tokens based on liquidity and market cap criteria.

## Setup

1. Install dependencies:
```bash
npm install
```

2. Configure environment variables:
- Copy `.env.example` to `.env`
- Update the values with your Supabase credentials

3. Start the application:
```bash
npm start
```

For development with auto-reload:
```bash
npm run dev
```

## API Endpoints

- `GET /health` - Check application status
- `POST /tokens` - Create a new token
- `GET /tokens/:mint` - Get token details by mint address

## Models

### Token
- mint (string)
- startMarketCap (numeric)
- liquidityUsd (numeric)
- marketCapUsd (numeric)
- cumulativeBuyVolume (numeric)
- cumulativeNetVolume (numeric)
- isHot (boolean)
- createdAt (timestamp)
- lastUpdated (timestamp)
- deadline (timestamp)

### HistoricalRecord
- tokenMint (string)
- timestamp (timestamp)
- marketCapUsd (numeric)
- liquidityUsd (numeric)
- cumulativeBuyVolume (numeric)
- cumulativeNetVolume (numeric)
