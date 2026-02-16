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
    logger.info('🔄 Syncing positions from Polymarket API...');

    try {
      const { positionManager } = this.orchestrator.getServices();

      // Use shared reconciliation method
      const { userTrades, targetTrades, analysis } = await this.orchestrator.reconcilePositions({
        clearFirst: true,
        includeUser: true,
        includeTarget: true,
        analyze: true,
      });

      // Display summary
      if (!analysis) {
        logger.error('Failed to analyze opportunities');
        return;
      }

      const summary = positionManager.getSummary();
      logger.info(
        {
          userTradesProcessed: userTrades.length,
          targetTradesProcessed: targetTrades.length,
          userOpenPositions: summary.userPositionCount,
          targetOpenPositions: summary.targetPositionCount,
          userTotalValue: summary.userTotalValue.toFixed(2),
          targetTotalValue: summary.targetTotalValue.toFixed(2),
          opportunities: analysis.opportunities.length,
          potentialSavings: analysis.totalPotentialSavings.toFixed(2),
        },
        '✅ Positions synced successfully'
      );

      console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      console.log('📊 SYNC RESULTS');
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      console.log(`User Trades Processed: ${userTrades.length}`);
      console.log(`Target Trades Processed: ${targetTrades.length}`);
      console.log(`User Open Positions: ${summary.userPositionCount}`);
      console.log(`Target Open Positions: ${summary.targetPositionCount}`);
      console.log(`User Total Value: $${summary.userTotalValue.toFixed(2)}`);
      console.log(`Target Total Value: $${summary.targetTotalValue.toFixed(2)}`);

      if (analysis.positionsToClose.length > 0) {
        console.log(`\n⚠️  Positions to Close: ${analysis.positionsToClose.length}`);
      }
      if (analysis.positionsToOpen.length > 0) {
        console.log(`📍 Positions to Open: ${analysis.positionsToOpen.length}`);
      }

      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

      // Display entry opportunities
      if (analysis.opportunities.length > 0) {
        const { positionEntryAnalyzer } = this.orchestrator.getServices();
        const opportunitiesSummary = positionEntryAnalyzer.formatOpportunitiesSummary(analysis);
        console.log(opportunitiesSummary);
      }
    } catch (error) {
      logger.error(
        {
          error: error instanceof Error ? error.message : String(error),
        },
        '❌ Failed to sync positions'
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
  sync       Sync positions from blockchain
  help       Display this help message

EXAMPLES:
  pnpm dev start    # Start the bot
  pnpm dev status   # Check status
  pnpm dev sync     # Sync positions

CONFIGURATION:
  Edit .env file to configure:
  - API credentials
  - Target trader address
  - Copy ratio and position limits
  - Risk management settings

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
