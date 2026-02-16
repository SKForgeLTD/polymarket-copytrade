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
        `  Polling: ${status.monitoring.pollingActive ? `✅ Active (every ${status.monitoring.pollIntervalSeconds}s)` : '⚠️  Inactive'}`
      );
      console.log(`  Last Poll: ${status.monitoring.lastPollTime}`);
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
  help       Display this help message

EXAMPLES:
  pnpm dev start           # Start the bot
  pnpm dev status          # Check status
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
