# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

A production-grade automated copy trading bot for Polymarket prediction markets. Monitors target traders in real-time via WebSocket (with polling fallback) and automatically replicates their positions with intelligent sizing, comprehensive risk management, and state persistence.

**Tech Stack**: TypeScript (strict mode), Node.js v22+, pnpm, ethers v5, Biome, Vitest

## Working Principles

**CRITICAL: Do NOT make assumptions about APIs, endpoints, or behavior without verification.**

When working with external APIs or libraries:
- ✅ **Verify endpoints and parameters** - Check actual API responses, not just documentation
- ✅ **Test assumptions** - Use curl, WebFetch, or direct testing before implementing
- ✅ **Question documentation** - Official docs may be outdated or incomplete
- ✅ **Check actual behavior** - Real-world API behavior > theoretical behavior
- ❌ **Never assume** API lag, endpoint behavior, or data formats without evidence
- ❌ **Never guess** which endpoint is "better" - test both and compare

**Example**: If the UI uses a different endpoint than documentation suggests, investigate both endpoints to understand why.

## Code Quality Standards

**CRITICAL: This codebase must meet production-grade, banking-grade, quant-grade, HFT-firm grade quality standards.**

When making changes, ensure:

### Performance & Reliability
- ✅ **Low latency**: Sub-second execution paths
- ✅ **High throughput**: Handles 10+ trades/second
- ✅ **Bounded resources**: No unbounded queues, caches, or memory growth
- ✅ **Graceful degradation**: Backpressure, circuit breakers, overflow handling
- ✅ **Zero data loss**: State persistence with retry logic

### Error Handling
- ✅ **Distinguish error types**: Insufficient balance ≠ critical failure
- ✅ **Fail gracefully**: Log warnings for expected errors, don't trip circuit breakers unnecessarily
- ✅ **Retry with backoff**: Network/API errors get exponential backoff
- ✅ **Never swallow errors**: All errors logged with context

### Observability
- ✅ **Metrics tracking**: Latency, throughput, success/failure rates
- ✅ **Structured logging**: All events include context (tradeId, queueLength, latency)
- ✅ **Performance monitoring**: Track min/max/avg for critical paths

### Safety
- ✅ **Idempotency**: Trade deduplication prevents double-execution
- ✅ **Concurrent safety**: Bounded concurrency, no race conditions
- ✅ **Type safety**: No `as any`, no TypeScript suppressions
- ✅ **Validation**: Runtime validation with Zod for external data

### Production Readiness
- ✅ **Graceful shutdown**: Drain queues, wait for in-flight operations
- ✅ **Health checks**: Circuit breaker status, queue monitoring
- ✅ **Configuration**: All tunable parameters via environment variables
- ✅ **Documentation**: Architecture decisions documented inline and in docs

**Reference**: See `HFT_ENHANCEMENTS.md` for detailed performance characteristics and architecture.

## Commands

### Development
```bash
pnpm dev start         # Start bot (with hot reload)
pnpm dev status        # Show current status (balance, positions, risk state)
pnpm dev sync          # Sync positions from blockchain/API (rebuilds state)
pnpm dev help          # Show CLI help

pnpm type-check        # TypeScript compilation check
pnpm lint              # Lint with Biome
pnpm lint:fix          # Lint and auto-fix
pnpm format            # Format code with Biome
```

### Production
```bash
pnpm build             # Build to dist/ using tsup
pnpm start             # Run production build
```

### Testing
```bash
pnpm test              # Run tests with Vitest
pnpm test:watch        # Run tests in watch mode
```

## Architecture

### Core Pattern: Orchestrator + Service Layer

The `Orchestrator` class coordinates all services and manages the application lifecycle. Services are dependency-injected and communicate through event emitters.

**Event Flow**:
```
Target Trader Trade → TraderMonitor (detects) → RiskManager (validates)
→ PositionCalculator (sizes) → TradeExecutor (executes) → PositionManager (updates)
```

### Key Services

**TraderMonitor** (`services/trader-monitor.ts`)
- Primary: WebSocket via `PolymarketRTDSClient`
- Fallback: HTTP polling via `DataApiClient` (10s interval)
- Deduplicates trades across sources (60s window)
- Emits `trade` events to orchestrator

**PositionManager** (`services/position-manager.ts`)
- Tracks user positions and target positions separately (in-memory Maps)
- Persists state to `./state/positions.json` with retry logic
- Handles position lifecycle: open → add/reduce → close
- Trade deduplication with bounded cache (1000 entries)
- **Critical**: Prevents position overshoot by detecting when closing trades exceed position size

**TradeExecutor** (`services/trade-executor.ts`)
- Executes orders via `ClobClient.createAndPostOrder()`
- Order confirmation polling (2s interval, 60s timeout)
- Exponential backoff retry (3 attempts max)
- Updates position state after successful execution

**RiskManager** (`services/risk-manager.ts`)
- Pre-trade validation: balance, position limits, exposure, market liquidity
- Circuit breaker: trips after N consecutive failures, cooldown period
- Trade cooldown enforcement (min 1s between trades)

**PositionCalculator** (`services/position-calculator.ts`)
- Proportional sizing based on `COPY_RATIO`
- Respects `MAX_POSITION_SIZE_USD` and `MIN_TRADE_SIZE_USD`
- Portfolio exposure limits (`MAX_PORTFOLIO_EXPOSURE`)
- Tick size rounding for valid order sizes

**PositionEntryAnalyzer** (`services/position-entry-analyzer.ts`)
- Analyzes existing target positions for better entry opportunities
- Compares target cost basis vs current market price
- Identifies positions to close (target exited) and open (target entered)
- Used by `sync` command to find savings opportunities

### Client Wrappers

**PolymarketClobClient** (`clients/clob-client.ts`)
- Wraps official `@polymarket/clob-client` with retry logic
- **Important**: Uses ethers v5 (library dependency requirement)
- Balance queries via USDC contract on Polygon (6 decimals)
- Order creation with `OrderType.GTC` enum
- Funder address configured in constructor (6th parameter)

**PolymarketRTDSClient** (`clients/rtds-client.ts`)
- Wraps `@polymarket/real-time-data-client`
- **Important**: Uses callback-based API (not EventEmitter pattern)
- Auto-reconnect enabled in constructor
- Type guards for message validation

**DataApiClient** (`clients/data-api.ts`)
- HTTP fallback via `https://data-api.polymarket.com`
- Fetches user trades with pagination (limit: 200)

### Type System

**Critical Type Rules** (see TYPE_SAFETY_IMPROVEMENTS.md):
- ✅ **NO `as any`** - Zero tolerance for unsafe type assertions
- ✅ **NO TypeScript suppressions** - No `@ts-ignore`, `@ts-expect-error`, `@ts-nocheck`
- ✅ Uses ethers v5 types (`BigNumber`, `ContractTransaction`, `providers.JsonRpcProvider`)
- ✅ Proper enum usage: `Side.BUY`/`Side.SELL`, `OrderType.GTC`, `ConnectionStatus.DISCONNECTED`
- ✅ Type guards for runtime validation (`isTradeMessage`)
- ✅ Separate type definition files (no inline types)

**Type Modules**:
- `types/polymarket.ts` - Core trading types (Trade, Position, Side)
- `types/clob-api.ts` - CLOB API types (re-exports from official client)
- `types/ethers-extensions.ts` - ERC20 contract interfaces
- `types/order-fill.ts` - Order confirmation tracking
- `types/position-entry.ts` - Entry opportunity analysis

### Configuration

**Schema-validated config** (`config/index.ts`):
- Uses Zod for runtime validation with detailed error messages
- All environment variables validated on startup
- Type-safe access via `Config` type
- Fails fast on missing/invalid config

**Key Settings**:
- `COPY_RATIO`: 0.01-1.0 (percentage of target's position to copy)
- `MAX_POSITION_SIZE_USD`: Max $ per individual position
- `MAX_PORTFOLIO_EXPOSURE`: 0.1-1.0 (max portfolio in active positions)
- `MAX_CONSECUTIVE_FAILURES`: Circuit breaker threshold
- `CIRCUIT_BREAKER_COOLDOWN_MINUTES`: Cooldown after circuit trips

### Authentication & Wallet Architecture

**CRITICAL: Polymarket uses L1/L2 wallet architecture**

- **L1 Wallet (PRIVATE_KEY)**: Your local Ethereum wallet that signs API requests and transactions
  - This is a standard EOA (Externally Owned Account)
  - Example: `0x400...`
  - Used for: Signing all API requests and blockchain transactions

- **L2 Proxy Wallet (FUNDER_ADDRESS)**: Your Polymarket account/profile address
  - This is a Polymarket proxy wallet (contract wallet)
  - Example: `0x9aD...` (shown at polymarket.com/@yourname)
  - Used for: Holding USDC balance and executing trades on Polymarket

- **API Credentials**: Generated from Polymarket UI (https://polymarket.com/settings/api)
  - Must be generated while connected with your L1 wallet
  - Associated with your L2 proxy wallet (where funds are held)
  - Used for: Authenticating CLOB API requests via HMAC-SHA256 signatures

**ClobClient Configuration**:
- **signatureType**: Set to `1` (POLY_PROXY) for standard Polymarket accounts
  - `0` = EOA (not used for modern Polymarket accounts)
  - `1` = POLY_PROXY (standard Polymarket proxy wallet) ← Use this
  - `2` = GNOSIS_SAFE (only for Safe multisig accounts)

### State Management

**Persistence**:
- Positions saved to `./state/positions.json`
- Auto-creates state directory if missing
- Exponential backoff retry on save failures (1s, 2s, 4s)
- **Important**: State persistence errors are critical - they're logged and retried, not swallowed

**State Files**:
- `./state/positions.json` - User and target positions
- Automatically loaded on startup via `PositionManager.initialize()`

### Logging

**Structured logging with Pino**:
- Development: Pretty-printed to console
- Production: JSON output for log aggregation
- Child loggers per module with `module` field
- Log levels: debug, info, warn, error

**Log Events**:
- 🚀 Bot lifecycle (start/stop)
- ✅ Successful trades with execution details
- ❌ Failed trades with error context
- 🔴 Circuit breaker activation
- 📊 Status updates (balance, positions, exposure)

## Important Patterns & Constraints

### Library Version Constraints

**CRITICAL**: Must use ethers v5, NOT v6
- `@polymarket/clob-client` depends on ethers v5
- Type incompatibilities if using v6
- Import pattern: `import { Wallet, providers } from 'ethers'`

### Type Safety Rules

When making changes:
1. Never use `as any` - create proper types or type guards
2. Import enums as values, not types: `import { Side, OrderType } from '@polymarket/clob-client'`
3. For unsafe conversions: `as unknown as TargetType` with type guard
4. Extract complex types to separate files in `types/`

### API Client Patterns

**ClobClient**:
- Use `createAndPostOrder()` for order execution (returns orderID)
- Pass `OrderType.GTC` enum, not string `'GTC'`
- Funder address set in constructor, not per-order

**RealTimeDataClient**:
- Initialize with callbacks in constructor, not via `.on()`
- Pattern: `new RealTimeDataClient({ onConnect, onMessage, onStatusChange })`
- Auto-reconnect handled by library

### State Synchronization

**Trade Deduplication**:
- Set-based tracking with 1000 entry cache limit
- Source-aware deduplication (WebSocket vs Polling) with 60s window
- Both `PositionManager.isTradeProcessed()` and `TraderMonitor` duplicate checks

**Position Reconciliation**:
- `pnpm dev sync` rebuilds state from trade history (200 trades)
- Clears existing positions before rebuild
- Analyzes entry opportunities vs target cost basis

### Risk Management

**Pre-trade checks** (fail early):
1. Circuit breaker active?
2. Sufficient balance?
3. Position size within limits?
4. Portfolio exposure within limits?
5. Market has liquidity?

**Circuit Breaker**:
- Trips after N consecutive failures
- Blocks all trading during cooldown
- Auto-resets after cooldown period
- Check status: `pnpm dev status`

## Development Workflow

### Adding New Features

1. **Types First**: Define types in `src/types/`
2. **Service Layer**: Create/modify service in `src/services/`
3. **Wire to Orchestrator**: Add to `Orchestrator` constructor
4. **CLI Access**: Expose via `src/cli/commands.ts` if needed
5. **Type Check**: `pnpm type-check` (must pass with 0 errors)
6. **Build**: `pnpm build` (must succeed)

### Debugging

**Check Status**:
```bash
pnpm dev status  # Shows balance, positions, circuit breaker state
```

**View Logs**:
```bash
LOG_LEVEL=debug pnpm dev start  # Verbose logging
```

**Test Order Execution** (without live trading):
- Mock the `ClobClient` methods
- Use `TradeExecutor.executeManualTrade()` for testing

### Common Tasks

**Add new CLI command**:
1. Add method to `CLI` class in `src/cli/commands.ts`
2. Update `src/index.ts` command routing
3. Update help text in `CLI.help()`

**Modify risk checks**:
1. Edit `RiskManager.validateTrade()` in `src/services/risk-manager.ts`
2. Return `{ passed: false, reason: '...' }` on failure

**Change position sizing logic**:
1. Modify `PositionCalculator.calculateCopySize()` in `src/services/position-calculator.ts`
2. Consider exposure limits in `PositionCalculator.wouldExceedExposureLimit()`

## Testing

Currently no test files exist. When adding tests:
- Place in `src/**/*.test.ts`
- Use Vitest framework
- Mock external APIs (ClobClient, DataApiClient, RTDSClient)
- Test critical logic: PositionCalculator, RiskManager, PositionManager

## Security & Production Considerations

- **Never log private keys or API secrets**
- **Validate all environment variables** at startup (already done via Zod)
- **Use dedicated trading wallet** with limited funds
- **Circuit breaker is critical** - don't bypass in production
- **State persistence errors** should page/alert in production
- **Monitor balance and positions** - integrate with alerting system

## Resources

- [Polymarket CLOB Docs](https://docs.polymarket.com/developers/CLOB/introduction)
- [CLOB Client GitHub](https://github.com/Polymarket/clob-client)
- [Real-Time Data Client](https://github.com/Polymarket/real-time-data-client)
- [Data API](https://docs.polymarket.com/api-reference/core/get-trades-for-a-user-or-markets)
