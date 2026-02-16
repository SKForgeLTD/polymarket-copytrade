# Quick Start Guide

Get your Polymarket copy trading bot running in 5 minutes!

## Prerequisites

- ✅ Node.js v22+ installed
- ✅ pnpm v9+ installed (`npm i -g pnpm`)
- ✅ Polymarket account with API credentials
- ✅ Ethereum wallet with USDC on Polygon

## Step 1: Install Dependencies

```bash
pnpm install
```

## Step 2: Configure Environment

Edit `.env` file with your credentials:

```bash
# Get from https://polymarket.com/settings/api
POLYMARKET_API_KEY=your_api_key_here
POLYMARKET_SECRET=your_secret_here
POLYMARKET_PASSPHRASE=your_passphrase_here

# Your wallet private key (without 0x)
PRIVATE_KEY=your_private_key_hex

# Your wallet address
FUNDER_ADDRESS=0xYourWalletAddress

# Trader to copy (example address - replace with real one!)
TARGET_TRADER_ADDRESS=0xTargetTraderAddress

# Start conservative
COPY_RATIO=0.1
MAX_POSITION_SIZE_USD=10
MIN_TRADE_SIZE_USD=0.5
```

## Step 3: Test Configuration

```bash
# Verify setup
pnpm type-check

# Check status (will fail if credentials invalid)
pnpm dev status
```

## Step 4: Start Trading

```bash
# Start the bot
pnpm dev start

# In another terminal, monitor status
pnpm dev status
```

## Step 5: Monitor

Watch for log messages:
- `✅ Bot is running` - Successfully started
- `📊 Current Status` - Initial balance and settings
- `New trade detected` - Target trader made a trade
- `✅ Copy trade executed successfully` - Your trade executed
- `❌ Copy trade failed` - Trade failed (check reason)

## Common Issues

### "Configuration validation failed"
- Check all environment variables are set
- Ensure no typos in variable names
- Verify addresses start with "0x"

### "Failed to connect to RTDS"
- Normal! Bot will use polling fallback
- Check internet connection
- Verify target trader address is valid

### "Insufficient balance"
- Deposit USDC to your wallet on Polygon
- Check wallet address matches FUNDER_ADDRESS
- Reduce COPY_RATIO or MAX_POSITION_SIZE_USD

### "Circuit breaker active"
- Too many failed trades in a row
- Bot paused for 5 minutes (default)
- Check logs for root cause
- Adjust risk settings if needed

## Key Commands

```bash
# Development
pnpm dev start          # Start bot
pnpm dev status         # Check status
pnpm dev sync           # Sync positions
pnpm dev help           # Show help

# Production
pnpm build              # Build for production
pnpm start              # Run production build

# Utilities
pnpm type-check         # Check TypeScript
pnpm lint               # Run linter
pnpm lint:fix           # Auto-fix issues
```

## Safety Tips

1. **Start Small**: Test with $50-100 first
2. **Monitor Daily**: Check logs and positions
3. **Adjust Gradually**: Increase limits slowly
4. **Set Alerts**: Use monitoring tools
5. **Keep Reserve**: Don't invest 100% of portfolio

## Next Steps

- Read [README.md](./README.md) for detailed documentation
- Check [IMPLEMENTATION_NOTES.md](./IMPLEMENTATION_NOTES.md) for technical details
- Adjust risk settings in `.env` as you gain confidence
- Monitor for 1 week before increasing position sizes

## Getting Help

If you encounter issues:
1. Check logs for error messages
2. Review configuration in `.env`
3. Verify API credentials are correct
4. Ensure wallet has sufficient USDC balance
5. Check Polymarket API status

## Example Session

```bash
# Terminal 1: Start bot
$ pnpm dev start
🚀 Starting Polymarket Copy Trading Bot
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📊 Current Status
  Balance: $44.99
  User Positions: 0
  Target Positions: 0
  Copy Ratio: 0.1
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
✅ Bot is running. Press Ctrl+C to stop.

# Terminal 2: Check status anytime
$ pnpm dev status
📊 SYSTEM STATUS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Running: ✅
Balance: $44.99
...
```

## Important Notes

⚠️ **This software is for educational purposes. Trade at your own risk.**

✅ **Always test with small amounts first!**

🔐 **Never share your private key or API credentials!**

---

Ready to trade? Run `pnpm dev start` and let the bot do the work! 🚀
