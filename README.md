# Polymarket Copy Trading Bot

A production-grade automated copy trading bot for Polymarket prediction markets. Monitor successful traders in real-time and automatically replicate their positions with intelligent sizing and comprehensive risk management.

## 🌟 Features

- **Real-Time Monitoring**: WebSocket + polling fallback for reliable trade detection
- **Intelligent Position Sizing**: Proportional copying based on portfolio balance
- **Risk Management**: Circuit breakers, position limits, and exposure controls
- **Automatic Execution**: Seamless order placement via CLOB API
- **State Persistence**: Maintains position history across restarts
- **Type-Safe**: Full TypeScript with strict typing
- **Fast & Efficient**: Built with modern tooling (pnpm, tsx, Biome)

## 📋 Prerequisites

- Node.js v22+ (LTS)
- pnpm v9+
- Polymarket account with API credentials
- Ethereum wallet with USDC on Polygon

## 🚀 Quick Start

### 1. Installation

```bash
# Clone the repository
git clone <repository-url>
cd polymarket-copytrade

# Install dependencies
pnpm install
```

### 2. Configuration

Copy the example environment file and configure:

```bash
cp .env.example .env
```

Edit `.env` with your credentials:

```env
# Polymarket API Credentials (from https://polymarket.com/settings/api)
POLYMARKET_API_KEY=your_api_key
POLYMARKET_SECRET=your_secret
POLYMARKET_PASSPHRASE=your_passphrase

# Ethereum Wallet
PRIVATE_KEY=your_private_key_without_0x
FUNDER_ADDRESS=0xYourWalletAddress

# Trading Configuration
TARGET_TRADER_ADDRESS=0xTargetTraderAddress
COPY_RATIO=0.1                    # Copy 10% of target's position size
MAX_POSITION_SIZE_USD=10          # Maximum $10 per position
MIN_TRADE_SIZE_USD=0.5            # Minimum $0.50 per trade
MAX_PORTFOLIO_EXPOSURE=0.8        # Max 80% portfolio exposure

# Risk Management
MAX_CONSECUTIVE_FAILURES=5         # Circuit breaker threshold
CIRCUIT_BREAKER_COOLDOWN_MINUTES=5 # Cooldown period
TRADE_COOLDOWN_MS=1000            # 1 second between trades

# Monitoring
POLLING_INTERVAL_SECONDS=10       # Fallback polling interval

# System
LOG_LEVEL=info                    # debug, info, warn, error
NODE_ENV=production               # development, production
```

### 3. Run the Bot

```bash
# Start copy trading
pnpm dev start

# Check status
pnpm dev status

# Sync positions
pnpm dev sync

# Show help
pnpm dev help
```

### 4. Production Build

```bash
# Build for production
pnpm build

# Run production build
pnpm start
```

## 🏗️ Architecture

### Components

```
┌─────────────────────────────────────────────────────────────┐
│                     Orchestrator                             │
│  (Coordinates all services and manages application flow)    │
└────────────┬────────────────────────────────────┬───────────┘
             │                                    │
    ┌────────▼────────┐                 ┌────────▼──────────┐
    │ TraderMonitor   │                 │ TradeExecutor     │
    │ • WebSocket     │                 │ • Order creation  │
    │ • Polling       │                 │ • Retry logic     │
    └────────┬────────┘                 └────────┬──────────┘
             │                                    │
    ┌────────▼────────┐                 ┌────────▼──────────┐
    │ RTDS Client     │                 │ CLOB Client       │
    │ • Real-time     │                 │ • Trade execution │
    │   WebSocket     │                 │ • Balance queries │
    └─────────────────┘                 └───────────────────┘

    ┌──────────────────────────────────────────────────────┐
    │               Core Services                          │
    ├──────────────────┬──────────────────┬────────────────┤
    │ PositionManager  │ RiskManager      │ PositionCalc   │
    │ • Track state    │ • Validation     │ • Size calc    │
    │ • Persist data   │ • Circuit breaker│ • Exposure     │
    └──────────────────┴──────────────────┴────────────────┘
```

### Data Flow

```
Target Trader Makes Trade
         ↓
   [WebSocket / Polling]
         ↓
   TraderMonitor (detects)
         ↓
   RiskManager (validates)
         ↓
   PositionCalculator (sizes)
         ↓
   TradeExecutor (executes)
         ↓
   PositionManager (updates)
```

## ⚙️ Configuration Guide

### Copy Ratio

The `COPY_RATIO` determines what percentage of the target trader's position size you copy:

- `0.1` (10%) - Conservative, good for small portfolios
- `0.2` (20%) - Moderate
- `0.5` (50%) - Aggressive
- `1.0` (100%) - Full replication (requires large portfolio)

**Example**: If target trader buys $100 worth and your copy ratio is 0.1, you'll buy $10 worth.

### Position Limits

- **MAX_POSITION_SIZE_USD**: Maximum dollar amount per individual position
- **MIN_TRADE_SIZE_USD**: Minimum trade size (avoids dust trades)
- **MAX_PORTFOLIO_EXPOSURE**: Maximum percentage of portfolio in active positions

### Risk Management

- **MAX_CONSECUTIVE_FAILURES**: Number of failed trades before circuit breaker activates
- **CIRCUIT_BREAKER_COOLDOWN_MINUTES**: How long to pause trading after circuit breaker trips
- **TRADE_COOLDOWN_MS**: Minimum time between trades

## 🔒 Security Best Practices

1. **Never commit your `.env` file**
2. **Use a dedicated trading wallet** with limited funds
3. **Start with small amounts** ($50-100) for testing
4. **Monitor the bot regularly** especially in the first few days
5. **Set conservative limits** until you're comfortable

## 📊 Monitoring & Logs

Logs are structured JSON in production, pretty-printed in development:

```bash
# View logs in real-time
pnpm dev start

# Production logs (JSON)
NODE_ENV=production pnpm start | pino-pretty
```

Key log events:
- `🚀` Bot started
- `✅` Trade executed successfully
- `❌` Trade failed
- `🔴` Circuit breaker activated
- `📊` Status updates

## 🧪 Testing

```bash
# Run tests
pnpm test

# Run tests in watch mode
pnpm test:watch

# Type checking
pnpm type-check

# Linting
pnpm lint
pnpm lint:fix
```

## 🛠️ Development

### Code Quality

This project uses:
- **Biome** for linting and formatting (50x faster than ESLint + Prettier)
- **TypeScript** with strict mode for type safety
- **Pino** for fast structured logging
- **Zod** for runtime schema validation

### Scripts

```bash
pnpm dev          # Run in development mode
pnpm build        # Build for production
pnpm start        # Run production build
pnpm type-check   # Check types
pnpm lint         # Lint code
pnpm lint:fix     # Lint and fix issues
pnpm format       # Format code
```

## 🐛 Troubleshooting

### Bot won't start

- Check your `.env` file is properly configured
- Verify API credentials are correct
- Ensure wallet has USDC balance on Polygon

### Trades not executing

- Check circuit breaker status with `pnpm dev status`
- Verify sufficient balance
- Check position limits aren't exceeded
- Review logs for specific error messages

### WebSocket disconnects frequently

- The bot automatically falls back to polling
- Check your internet connection
- Polymarket may have rate limits

## 📈 Performance Tips

1. **Optimal polling interval**: 10-30 seconds balances responsiveness and API load
2. **Copy ratio**: Start small (0.05-0.1) and increase gradually
3. **Position limits**: Set based on your total portfolio size
4. **Monitor daily**: Check logs and positions regularly

## 🚧 Limitations

- Only supports USDC markets on Polygon
- Requires active internet connection
- Subject to Polymarket API rate limits
- No built-in backtesting (yet)

## 🔮 Future Enhancements

- [ ] Multiple trader monitoring
- [ ] Custom strategy filters
- [ ] Web dashboard
- [ ] Discord/Telegram notifications
- [ ] Advanced portfolio rebalancing
- [ ] Historical data analysis
- [ ] Backtesting framework

## 📚 Resources

- [Polymarket CLOB Docs](https://docs.polymarket.com/developers/CLOB/introduction)
- [CLOB Client GitHub](https://github.com/Polymarket/clob-client)
- [Real-Time Data Client](https://github.com/Polymarket/real-time-data-client)
- [Polymarket Data API](https://docs.polymarket.com/api-reference/core/get-trades-for-a-user-or-markets)

## ⚖️ License

MIT

## ⚠️ Disclaimer

This software is for educational purposes only. Trading cryptocurrencies and prediction markets involves risk. Only trade with funds you can afford to lose. The authors are not responsible for any financial losses incurred while using this software.

---

**Built with ❤️ for the Polymarket community**
