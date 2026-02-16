import { PolymarketClobClient } from './clients/clob-client.js';
import { DataApiClient } from './clients/data-api.js';
import { PolymarketRTDSClient } from './clients/rtds-client.js';
import type { Config } from './config/index.js';
import { createChildLogger } from './logger/index.js';
import { PositionCalculator } from './services/position-calculator.js';
import { PositionEntryAnalyzer } from './services/position-entry-analyzer.js';
import { PositionManager } from './services/position-manager.js';
import { RiskManager } from './services/risk-manager.js';
import { TradeExecutor } from './services/trade-executor.js';
import { TraderMonitor } from './services/trader-monitor.js';
import type { Trade } from './types/polymarket.js';
import { DEFAULT_ENTRY_CONFIG, type SyncAnalysis } from './types/position-entry.js';
import type { TradeHistoryEntry } from './web/types/api.js';

const logger = createChildLogger({ module: 'Orchestrator' });

/**
 * Main application orchestrator that coordinates all services
 */
export class Orchestrator {
  private config: Config;
  private clobClient: PolymarketClobClient;
  private dataApiClient: DataApiClient;
  private positionManager: PositionManager;
  private positionCalculator: PositionCalculator;
  private positionEntryAnalyzer: PositionEntryAnalyzer;
  private riskManager: RiskManager;
  private tradeExecutor: TradeExecutor;
  private traderMonitor: TraderMonitor;
  private isRunning = false;
  private webServer: InstanceType<typeof import('./web/server.js').WebServer> | undefined = undefined;

  // Trade queue for high-frequency processing
  private tradeQueue: Trade[] = [];
  private processingTrades = 0;
  private readonly maxConcurrentTrades = 5; // Process up to 5 trades concurrently
  private readonly maxQueueSize = 100; // Bounded queue to prevent memory issues

  // Performance metrics (production-grade)
  private metrics = {
    tradesQueued: 0,
    tradesProcessed: 0,
    tradesSkipped: 0,
    tradesFailed: 0,
    queueOverflows: 0,
    totalLatencyMs: 0,
    minLatencyMs: Infinity,
    maxLatencyMs: 0,
  };

  // Trade history tracking (circular buffer)
  private tradeHistory: TradeHistoryEntry[] = [];
  private readonly MAX_TRADE_HISTORY = 1000;

  private constructor(
    config: Config,
    clobClient: PolymarketClobClient,
    dataApiClient: DataApiClient,
    positionManager: PositionManager,
    positionCalculator: PositionCalculator,
    positionEntryAnalyzer: PositionEntryAnalyzer,
    riskManager: RiskManager,
    tradeExecutor: TradeExecutor,
    traderMonitor: TraderMonitor
  ) {
    this.config = config;
    this.clobClient = clobClient;
    this.dataApiClient = dataApiClient;
    this.positionManager = positionManager;
    this.positionCalculator = positionCalculator;
    this.positionEntryAnalyzer = positionEntryAnalyzer;
    this.riskManager = riskManager;
    this.tradeExecutor = tradeExecutor;
    this.traderMonitor = traderMonitor;
  }

  /**
   * Create and initialize an Orchestrator
   */
  static async create(config: Config): Promise<Orchestrator> {
    // Initialize clients (async)
    const clobClient = await PolymarketClobClient.create(config);
    const rtdsClient = new PolymarketRTDSClient(config.trading.targetTraderAddress);
    const dataApiClient = new DataApiClient();

    // Initialize services
    const positionManager = new PositionManager();
    const positionCalculator = new PositionCalculator(config);
    const positionEntryAnalyzer = new PositionEntryAnalyzer(
      config,
      clobClient,
      DEFAULT_ENTRY_CONFIG
    );
    const riskManager = new RiskManager(config);
    const tradeExecutor = new TradeExecutor(
      clobClient,
      riskManager,
      positionManager,
      positionCalculator
    );

    // Initialize monitor
    const traderMonitor = new TraderMonitor(config, rtdsClient, dataApiClient);

    return new Orchestrator(
      config,
      clobClient,
      dataApiClient,
      positionManager,
      positionCalculator,
      positionEntryAnalyzer,
      riskManager,
      tradeExecutor,
      traderMonitor
    );
  }

  /**
   * Start the copy trading bot
   */
  async start(): Promise<void> {
    if (this.isRunning) {
      logger.warn('Orchestrator already running');
      return;
    }

    logger.info('Starting Polymarket Copy Trading Bot...');

    try {
      // Initialize position manager (load state)
      await this.positionManager.initialize();

      // Check balance before starting
      const balance = await this.clobClient.getBalance();
      if (balance <= 0) {
        throw new Error(
          `Insufficient balance: $${balance.toFixed(2)}. Please deposit USDC to your Polymarket account.`
        );
      }

      logger.info({ balance: `$${balance.toFixed(2)}` }, 'Balance check passed');

      // Display initial status (before sync)
      await this.displayStatus();

      // Reconcile positions on startup (load target positions only, don't clear existing)
      await this.reconcilePositions({
        clearFirst: false,
        includeUser: false,
        includeTarget: true,
        analyze: false,
      });

      // Set up trade event handler
      this.traderMonitor.on('trade', (trade) => {
        this.handleTradeDetected(trade);
      });

      // Set up error handler
      this.traderMonitor.on('error', (error) => {
        logger.error(
          {
            error: error.message,
          },
          'Monitoring error'
        );
      });

      // Start monitoring
      await this.traderMonitor.start();

      // Start web server if enabled
      logger.info({ webEnabled: this.config.web.enabled, webPort: this.config.web.port }, 'Web configuration');
      if (this.config.web.enabled) {
        logger.info('Starting web server...');
        await this.startWebServer();
      } else {
        logger.info('Web server disabled in configuration');
      }

      this.isRunning = true;
      logger.info('Copy trading bot started successfully');
    } catch (error) {
      logger.error(
        {
          error: error instanceof Error ? error.message : String(error),
        },
        'Failed to start orchestrator'
      );
      throw error;
    }
  }

  /**
   * Stop the copy trading bot
   */
  async stop(): Promise<void> {
    if (!this.isRunning) {
      return;
    }

    logger.info('Stopping copy trading bot...');

    try {
      // Stop monitoring (no new trades)
      this.traderMonitor.stop();

      // Graceful shutdown: drain queue
      if (this.tradeQueue.length > 0 || this.processingTrades > 0) {
        logger.info(
          {
            queueLength: this.tradeQueue.length,
            processingTrades: this.processingTrades,
          },
          'Draining trade queue before shutdown...'
        );

        // Wait for queue to drain (max 30 seconds)
        const maxWaitMs = 30000;
        const startTime = Date.now();

        while (
          (this.tradeQueue.length > 0 || this.processingTrades > 0) &&
          Date.now() - startTime < maxWaitMs
        ) {
          await new Promise((resolve) => setTimeout(resolve, 100));
        }

        if (this.tradeQueue.length > 0 || this.processingTrades > 0) {
          logger.warn(
            {
              remainingQueue: this.tradeQueue.length,
              stillProcessing: this.processingTrades,
            },
            'Shutdown timeout - some trades may not have completed'
          );
        } else {
          logger.info('Queue drained successfully');
        }
      }

      // Stop web server if running
      if (this.webServer) {
        await this.stopWebServer();
      }

      this.isRunning = false;
      logger.info('Copy trading bot stopped');
    } catch (error) {
      logger.error(
        {
          error: error instanceof Error ? error.message : String(error),
        },
        'Error stopping orchestrator'
      );
    }
  }

  /**
   * Reconcile positions by fetching recent trades
   * Shared method used by both startup and sync command
   */
  async reconcilePositions(options: {
    clearFirst?: boolean;
    includeUser?: boolean;
    includeTarget?: boolean;
    analyze?: boolean;
  }): Promise<{
    userTrades: Trade[];
    targetTrades: Trade[];
    analysis?: SyncAnalysis;
  }> {
    const {
      clearFirst = false,
      includeUser = false,
      includeTarget = true,
      analyze = false,
    } = options;

    try {
      logger.info('🔄 Reconciling positions...');

      let userTrades: Trade[] = [];
      let targetTrades: Trade[] = [];

      // Clear positions if requested (used by sync command)
      if (clearFirst) {
        logger.info('🗑️  Clearing existing position cache...');
        this.positionManager.clearAllPositions();
      }

      // Fetch and rebuild user positions
      if (includeUser) {
        logger.info('📊 Fetching user trade history...');
        userTrades = await this.dataApiClient.getUserTrades(this.clobClient.getAddress(), {
          limit: 200,
        });

        // Filter out trades missing required fields AND trades we've already processed
        const validTrades = userTrades.filter(t =>
          t.asset_id && t.market && !this.positionManager.isTradeProcessed(t.id)
        );
        const skippedCount = userTrades.length - validTrades.length;

        if (skippedCount > 0) {
          logger.info({ skipped: skippedCount, total: userTrades.length }, 'Filtered incomplete/processed trades');
        }

        logger.info('🔨 Rebuilding user positions...');
        for (const trade of validTrades) {
          this.positionManager.updatePosition(trade, true);
          // Mark as processed
          this.positionManager.markTradeProcessed(trade.id);
        }
      }

      // Fetch and rebuild target positions
      if (includeTarget) {
        logger.info('📊 Fetching target trader history...');
        targetTrades = await this.dataApiClient.getUserTrades(
          this.config.trading.targetTraderAddress,
          { limit: 200 }
        );

        logger.info(
          {
            tradesFound: targetTrades.length,
            targetTrader: `${this.config.trading.targetTraderAddress.substring(0, 10)}...`,
          },
          `📊 Fetched ${targetTrades.length} recent trades from target trader`
        );

        if (targetTrades.length > 0) {
          // Filter out trades missing required fields AND trades we've already processed
          const validTrades = targetTrades.filter(t =>
            t.asset_id && t.market && !this.positionManager.isTradeProcessed(t.id)
          );
          const skippedCount = targetTrades.length - validTrades.length;

          if (skippedCount > 0) {
            logger.info({ skipped: skippedCount, total: targetTrades.length }, 'Filtered incomplete/processed trades');
          }

          logger.info('🔨 Rebuilding target positions...');
          for (const trade of validTrades) {
            this.positionManager.updatePosition(trade, false);
            // Mark as processed so we don't try to copy it again
            this.positionManager.markTradeProcessed(trade.id);
          }

          const targetPositions = this.positionManager.getAllTargetPositions();

          logger.info(
            {
              totalTrades: targetTrades.length,
              activePositions: targetPositions.length,
              markets: targetPositions.map((p) => `${(p.market || 'unknown').substring(0, 30)}...`),
            },
            `✅ Reconciled target trader positions: ${targetPositions.length} active`
          );

          // Log each active position
          for (const pos of targetPositions) {
            logger.info(
              {
                market: `${(pos.market || 'unknown').substring(0, 40)}...`,
                outcome: pos.outcome,
                side: pos.side,
                size: pos.size.toFixed(2),
                avgPrice: pos.avgPrice.toFixed(4),
                value: `$${pos.value.toFixed(2)}`,
              },
              '📍 Target position'
            );
          }
        } else {
          logger.info('No recent trades found for target trader');
        }
      }

      // Analyze entry opportunities if requested
      let analysis: SyncAnalysis | undefined;
      if (analyze) {
        logger.info('🔍 Analyzing entry opportunities...');
        const userPositions = this.positionManager.getAllUserPositions();
        const targetPositions = this.positionManager.getAllTargetPositions();
        analysis = await this.positionEntryAnalyzer.analyzeSyncOpportunities(
          targetPositions,
          userPositions
        );
      }

      return analysis ? { userTrades, targetTrades, analysis } : { userTrades, targetTrades };
    } catch (error) {
      logger.warn(
        {
          error: error instanceof Error ? error.message : String(error),
        },
        '⚠️ Failed to reconcile positions (non-critical - will sync from live trades)'
      );
      return { userTrades: [], targetTrades: [] };
    }
  }

  /**
   * Add trade to history (circular buffer)
   */
  private addToHistory(entry: TradeHistoryEntry): void {
    this.tradeHistory.unshift(entry); // Add to front
    if (this.tradeHistory.length > this.MAX_TRADE_HISTORY) {
      this.tradeHistory.pop(); // Remove oldest
    }
  }

  /**
   * Handle detected trade from target trader
   * Adds to queue for async processing (non-blocking)
   */
  private async handleTradeDetected(trade: Trade): Promise<void> {
    // Check if already processed
    if (this.positionManager.isTradeProcessed(trade.id)) {
      logger.debug({ tradeId: trade.id }, 'Trade already processed, skipping');
      return;
    }

    // Apply trade filtering
    const targetTradeValue = Number(trade.size) * Number(trade.price);
    if (targetTradeValue < this.config.trading.minTradeSizeUsd) {
      logger.debug(
        {
          tradeId: trade.id,
          value: targetTradeValue.toFixed(2),
          minValue: this.config.trading.minTradeSizeUsd,
        },
        'Trade below minimum size threshold, skipping'
      );
      return;
    }

    // Check queue capacity (bounded queue for production safety)
    if (this.tradeQueue.length >= this.maxQueueSize) {
      this.metrics.queueOverflows++;
      this.metrics.tradesSkipped++;

      logger.warn(
        {
          tradeId: trade.id,
          queueLength: this.tradeQueue.length,
          maxQueueSize: this.maxQueueSize,
          overflowCount: this.metrics.queueOverflows,
        },
        '⚠️ Queue full - dropping trade (backpressure)'
      );
      return;
    }

    logger.info(
      {
        tradeId: trade.id,
        market: trade.market,
        side: trade.side,
        size: trade.size,
        price: trade.price,
        queueLength: this.tradeQueue.length,
        processing: this.processingTrades,
      },
      '📥 Trade queued for processing'
    );

    // Add to trade history
    const detectedEntry = {
      id: trade.id,
      timestamp: Date.now(),
      type: 'target_detected' as const,
      market: trade.market,
      side: trade.side,
      size: Number(trade.size),
      price: Number(trade.price),
      value: Number(trade.size) * Number(trade.price),
    };
    this.addToHistory(detectedEntry);

    // Broadcast to SSE clients
    if (this.webServer) {
      this.webServer.getSSEManager().broadcast({
        type: 'trade_detected',
        timestamp: detectedEntry.timestamp,
        data: detectedEntry,
      });
    }

    // Add to queue
    this.tradeQueue.push(trade);
    this.metrics.tradesQueued++;

    // Process queue (non-blocking)
    this.processTradeQueue().catch((error) => {
      logger.error(
        {
          error: error instanceof Error ? error.message : String(error),
        },
        'Error in trade queue processor'
      );
    });
  }

  /**
   * Process trades from queue with concurrency limit
   */
  private async processTradeQueue(): Promise<void> {
    // Check if we can process more trades
    while (this.tradeQueue.length > 0 && this.processingTrades < this.maxConcurrentTrades) {
      const trade = this.tradeQueue.shift();
      if (!trade) break;

      this.processingTrades++;

      // Process trade asynchronously (don't await)
      this.processSingleTrade(trade)
        .catch((error) => {
          logger.error(
            {
              tradeId: trade.id,
              error: error instanceof Error ? error.message : String(error),
            },
            'Error processing trade from queue'
          );
        })
        .finally(() => {
          this.processingTrades--;

          // Try to process next trade
          if (this.tradeQueue.length > 0) {
            this.processTradeQueue().catch((error) => {
              logger.error({ error }, 'Error continuing queue processing');
            });
          }
        });
    }
  }

  /**
   * Process a single trade
   */
  private async processSingleTrade(trade: Trade): Promise<void> {
    const startTime = Date.now();

    try {
      // Validate trade has required fields
      if (!trade.asset_id || !trade.market || !trade.maker_address) {
        logger.warn(
          {
            tradeId: trade.id,
            hasAssetId: !!trade.asset_id,
            hasMarket: !!trade.market,
            hasMaker: !!trade.maker_address,
          },
          'Trade missing required fields, skipping'
        );
        this.metrics.tradesSkipped++;
        return;
      }

      // Update target trader's position
      this.positionManager.updatePosition(trade, false);

      // Execute copy trade
      const result = await this.tradeExecutor.executeCopyTrade(trade);

      // Track latency metrics
      const latencyMs = Date.now() - startTime;
      this.metrics.totalLatencyMs += latencyMs;
      this.metrics.minLatencyMs = Math.min(this.metrics.minLatencyMs, latencyMs);
      this.metrics.maxLatencyMs = Math.max(this.metrics.maxLatencyMs, latencyMs);

      if (result.success) {
        this.metrics.tradesProcessed++;

        logger.info(
          {
            orderId: result.orderId,
            executedSize: result.executedSize,
            executedPrice: result.executedPrice,
            latencyMs,
            queueLength: this.tradeQueue.length,
          },
          '✅ Copy trade executed'
        );

        // Add to trade history
        const executedEntry: TradeHistoryEntry = {
          id: trade.id,
          timestamp: Date.now(),
          type: 'copy_executed',
          market: trade.market,
          side: trade.side,
          size: result.executedSize || Number(trade.size),
          price: result.executedPrice || Number(trade.price),
          value: (result.executedSize || Number(trade.size)) * (result.executedPrice || Number(trade.price)),
          latencyMs,
        };
        if (result.orderId) {
          executedEntry.orderId = result.orderId;
        }
        this.addToHistory(executedEntry);

        // Broadcast to SSE clients
        if (this.webServer) {
          this.webServer.getSSEManager().broadcast({
            type: 'trade_executed',
            timestamp: executedEntry.timestamp,
            data: executedEntry,
          });
        }

        // Mark trade as processed
        this.positionManager.markTradeProcessed(trade.id);
      } else {
        this.metrics.tradesFailed++;

        logger.warn(
          {
            error: result.error,
            latencyMs,
            queueLength: this.tradeQueue.length,
          },
          '⚠️ Copy trade failed'
        );

        // Add to trade history
        const failedEntry: TradeHistoryEntry = {
          id: trade.id,
          timestamp: Date.now(),
          type: 'copy_failed',
          market: trade.market,
          side: trade.side,
          size: Number(trade.size),
          price: Number(trade.price),
          value: Number(trade.size) * Number(trade.price),
          latencyMs,
        };
        if (result.error) {
          failedEntry.error = result.error;
        }
        this.addToHistory(failedEntry);

        // Broadcast to SSE clients
        if (this.webServer) {
          this.webServer.getSSEManager().broadcast({
            type: 'trade_failed',
            timestamp: failedEntry.timestamp,
            data: failedEntry,
          });
        }
      }
    } catch (error) {
      this.metrics.tradesFailed++;

      logger.error(
        {
          error: error instanceof Error ? error.message : String(error),
          trade,
          latencyMs: Date.now() - startTime,
        },
        'Error processing single trade'
      );
    }
  }

  /**
   * Display current status
   */
  async displayStatus(): Promise<void> {
    try {
      // Get balance
      const balance = await this.clobClient.getBalance();

      // Get positions
      const userPositions = this.positionManager.getAllUserPositions();
      const targetPositions = this.positionManager.getAllTargetPositions();

      // Get risk status
      const riskStatus = this.riskManager.getSummary();

      // Calculate exposure
      const exposure = this.positionCalculator.calculatePortfolioExposure(userPositions, balance);

      // Calculate average latency
      const avgLatencyMs =
        this.metrics.tradesProcessed > 0
          ? this.metrics.totalLatencyMs / this.metrics.tradesProcessed
          : 0;

      logger.info(
        {
          walletAddress: this.clobClient.getAddress(),
          targetTrader: this.config.trading.targetTraderAddress,
          balance: `$${balance.toFixed(2)}`,
          userPositions: userPositions.length,
          targetPositions: targetPositions.length,
          portfolioExposure: `${(exposure * 100).toFixed(1)}%`,
          copyRatio: this.config.trading.copyRatio,
          maxPositionSize: `$${this.config.trading.maxPositionSizeUsd}`,
          circuitBreakerActive: riskStatus.circuitBreaker.isTripped,
          // Performance metrics
          queueLength: this.tradeQueue.length,
          processingTrades: this.processingTrades,
          tradesQueued: this.metrics.tradesQueued,
          tradesProcessed: this.metrics.tradesProcessed,
          tradesSkipped: this.metrics.tradesSkipped,
          tradesFailed: this.metrics.tradesFailed,
          queueOverflows: this.metrics.queueOverflows,
          avgLatencyMs: avgLatencyMs.toFixed(0),
          minLatencyMs: this.metrics.minLatencyMs === Infinity ? 0 : this.metrics.minLatencyMs,
          maxLatencyMs: this.metrics.maxLatencyMs,
        },
        '📊 Current Status'
      );
    } catch (error) {
      logger.error(
        {
          error: error instanceof Error ? error.message : String(error),
        },
        'Failed to display status'
      );
    }
  }

  /**
   * Get system status
   */
  async getStatus() {
    const balance = await this.clobClient.getBalance();
    const positionSummary = this.positionManager.getSummary();
    const riskStatus = this.riskManager.getSummary();
    const monitorStatus = this.traderMonitor.getStatus();

    return {
      isRunning: this.isRunning,
      balance,
      positions: {
        ...positionSummary,
        userPositions: this.positionManager.getAllUserPositions(),
        targetPositions: this.positionManager.getAllTargetPositions(),
      },
      risk: riskStatus,
      monitoring: monitorStatus,
    };
  }

  /**
   * Get performance metrics
   */
  getMetrics() {
    const avgLatencyMs =
      this.metrics.tradesProcessed > 0
        ? this.metrics.totalLatencyMs / this.metrics.tradesProcessed
        : 0;

    return {
      queueLength: this.tradeQueue.length,
      processingTrades: this.processingTrades,
      maxQueueSize: this.maxQueueSize,
      tradesQueued: this.metrics.tradesQueued,
      tradesProcessed: this.metrics.tradesProcessed,
      tradesSkipped: this.metrics.tradesSkipped,
      tradesFailed: this.metrics.tradesFailed,
      queueOverflows: this.metrics.queueOverflows,
      minLatencyMs: this.metrics.minLatencyMs === Infinity ? 0 : this.metrics.minLatencyMs,
      maxLatencyMs: this.metrics.maxLatencyMs,
      avgLatencyMs,
    };
  }

  /**
   * Get trade history
   */
  getTradeHistory(limit = 50): TradeHistoryEntry[] {
    return this.tradeHistory.slice(0, limit);
  }

  /**
   * Get internal services (for CLI commands)
   */
  getServices() {
    return {
      positionManager: this.positionManager,
      positionEntryAnalyzer: this.positionEntryAnalyzer,
      clobClient: this.clobClient,
      dataApiClient: this.dataApiClient,
      config: this.config,
    };
  }

  /**
   * Start web server
   */
  private async startWebServer(): Promise<void> {
    try {
      const { WebServer } = await import('./web/server.js');
      const { SSEManager } = await import('./web/sse-manager.js');

      const sseManager = new SSEManager();
      this.webServer = new WebServer(this.config, this, sseManager);
      await this.webServer.start();

      logger.info(
        {
          url: `http://${this.config.web.host}:${this.config.web.port}`,
        },
        '🌐 Web interface started'
      );
    } catch (error) {
      logger.error({ error }, 'Failed to start web server (non-critical, bot will continue)');
    }
  }

  /**
   * Stop web server
   */
  private async stopWebServer(): Promise<void> {
    const webServer = this.webServer;
    if (!webServer) {
      return;
    }

    try {
      await webServer.stop();
      this.webServer = undefined;
    } catch (error) {
      logger.error({ error }, 'Error stopping web server');
    }
  }

  /**
   * Graceful shutdown handler
   */
  async shutdown(): Promise<void> {
    logger.info('Initiating graceful shutdown...');

    try {
      await this.stop();
      logger.info('Shutdown complete');
    } catch (error) {
      logger.error(
        {
          error: error instanceof Error ? error.message : String(error),
        },
        'Error during shutdown'
      );
    }
  }
}
