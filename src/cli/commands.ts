import { config } from '../config/index.js';
import { logger } from '../logger/index.js';
import { Orchestrator } from '../orchestrator.js';

/**
 * CLI Commands for the copy trading bot
 */
export class CLI {
  private orchestrator: Orchestrator;

  private constructor(orchestrator: Orchestrator) {
    this.orchestrator = orchestrator;
  }

  /**
   * Create and initialize CLI
   */
  static async create(): Promise<CLI> {
    const orchestrator = await Orchestrator.create(config);
    return new CLI(orchestrator);
  }

  /**
   * Start the copy trading bot
   */
  async start(): Promise<void> {
    logger.info('🚀 Starting Polymarket Copy Trading Bot');
    logger.info('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

    try {
      await this.orchestrator.start();

      logger.info('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      logger.info('✅ Bot is running. Press Ctrl+C to stop.');
      logger.info('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    } catch (error) {
      logger.error(
        {
          error: error instanceof Error ? error.message : String(error),
        },
        '❌ Failed to start bot'
      );
      process.exit(1);
    }
  }

  /**
   * Display current status
   */
  async status(): Promise<void> {
    logger.info('📊 Fetching current status...');

    try {
      const status = await this.orchestrator.getStatus();

      console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      console.log('📊 SYSTEM STATUS');
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      console.log(`Running: ${status.isRunning ? '✅' : '❌'}`);
      console.log(`Balance: $${status.balance.toFixed(2)}`);
      console.log('');
      console.log('POSITIONS:');
      console.log(
        `  User: ${status.positions.userPositionCount} positions ($${status.positions.userTotalValue.toFixed(2)})`
      );
      console.log(
        `  Target: ${status.positions.targetPositionCount} positions ($${status.positions.targetTotalValue.toFixed(2)})`
      );
      console.log('');
      console.log('RISK MANAGEMENT:');
      console.log(
        `  Circuit Breaker: ${status.risk.circuitBreaker.isTripped ? '🔴 ACTIVE' : '✅ Inactive'}`
      );
      console.log(`  Consecutive Failures: ${status.risk.circuitBreaker.consecutiveFailures}`);
      console.log(`  Trading Allowed: ${status.risk.tradingAllowed ? '✅' : '❌'}`);
      console.log('');
      console.log('MONITORING:');
      console.log(`  Active: ${status.monitoring.isMonitoring ? '✅' : '❌'}`);
      console.log(
        `  WebSocket: ${status.monitoring.websocketConnected ? '✅ Connected' : '⚠️  Disconnected'}`
      );
      console.log(`  Polling: ${status.monitoring.pollingActive ? '✅ Active' : '❌ Inactive'}`);
      console.log(`  Target Trader: ${status.monitoring.targetAddress}`);
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
    } catch (error) {
      logger.error(
        {
          error: error instanceof Error ? error.message : String(error),
        },
        '❌ Failed to fetch status'
      );
      process.exit(1);
    }
  }

  /**
   * Sync positions from blockchain/API
   */
  async sync(): Promise<void> {
    logger.info('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    logger.info('⚠️  Sync command disabled');
    logger.info('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    logger.info('');
    logger.info('The bot now focuses purely on live incoming trades.');
    logger.info('Position reconciliation has been removed for simplicity.');
    logger.info('');
    logger.info('To monitor trades, use: pnpm dev start');
    logger.info('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  }

  /**
   * Display help message
   */
  help(): void {
    console.log(`
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  POLYMARKET COPY TRADING BOT
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

USAGE:
  pnpm dev [command]

COMMANDS:
  start      Start the copy trading bot
  status     Display current status
  sync       Sync positions from blockchain
  help       Display this help message

EXAMPLES:
  pnpm dev start           # Start the bot
  pnpm dev status          # Check status
  pnpm dev sync            # Sync positions
  WEB_ENABLED=true pnpm dev start  # Start with web interface

CONFIGURATION:
  Edit .env file to configure:
  - API credentials
  - Target trader address
  - Copy ratio and position limits
  - Risk management settings
  - Web interface (WEB_ENABLED, WEB_PORT, WEB_HOST)

WEB INTERFACE:
  Set WEB_ENABLED=true to enable the monitoring dashboard.
  Access at http://localhost:3000 (default port).

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
`);
  }

  /**
   * Get orchestrator instance for shutdown
   */
  getOrchestrator(): Orchestrator {
    return this.orchestrator;
  }
}
