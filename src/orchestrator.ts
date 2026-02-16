import { PolymarketClobClient } from './clients/clob-client.js';
import { PolymarketRTDSClient } from './clients/rtds-client.js';
import type { Config } from './config/index.js';
import { createChildLogger } from './logger/index.js';
import { PositionCalculator } from './services/position-calculator.js';
import { PositionManager } from './services/position-manager.js';
import { RiskManager } from './services/risk-manager.js';
import { TradeExecutor } from './services/trade-executor.js';
import { type ConnectionStatus, TraderMonitor } from './services/trader-monitor.js';
import type { Trade } from './types/polymarket.js';
import type { TradeHistoryEntry } from './web/types/api.js';

const logger = createChildLogger({ module: 'Orchestrator' });

/**
 * Main application orchestrator that coordinates all services
 */
export class Orchestrator {
  private config: Config;
  private clobClient: PolymarketClobClient;
  private positionManager: PositionManager;
  private positionCalculator: PositionCalculator;
  private riskManager: RiskManager;
  private tradeExecutor: TradeExecutor;
  private traderMonitor: TraderMonitor;
  private isRunning = false;
  private startTime: number = 0;
  private uptimeInterval: NodeJS.Timeout | null = null;
  private webServer: InstanceType<typeof import('./web/server.js').WebServer> | undefined =
    undefined;

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
    positionManager: PositionManager,
    positionCalculator: PositionCalculator,
    riskManager: RiskManager,
    tradeExecutor: TradeExecutor,
    traderMonitor: TraderMonitor
  ) {
    this.config = config;
    this.clobClient = clobClient;
    this.positionManager = positionManager;
    this.positionCalculator = positionCalculator;
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

    // Initialize services
    const positionManager = new PositionManager();
    const positionCalculator = new PositionCalculator(config);
    const riskManager = new RiskManager(config);
    const tradeExecutor = new TradeExecutor(
      clobClient,
      riskManager,
      positionManager,
      positionCalculator
    );

    // Initialize monitor (WebSocket-only)
    const traderMonitor = new TraderMonitor(config, rtdsClient);

    return new Orchestrator(
      config,
      clobClient,
      positionManager,
      positionCalculator,
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

      logger.info('Ready to monitor live trades');

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

      // Set up connection status handler
      this.traderMonitor.on('connectionStatus', (status: ConnectionStatus) => {
        this.handleConnectionStatusChange(status);
      });

      // Start monitoring
      await this.traderMonitor.start();

      // Start web server if enabled
      logger.info(
        { webEnabled: this.config.web.enabled, webPort: this.config.web.port },
        'Web configuration'
      );
      if (this.config.web.enabled) {
        logger.info('Starting web server...');
        await this.startWebServer();
      } else {
        logger.info('Web server disabled in configuration');
      }

      // Start uptime tracking
      this.startTime = Date.now();
      this.startUptimeBroadcast();

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

      // Stop uptime broadcast
      if (this.uptimeInterval) {
        clearInterval(this.uptimeInterval);
        this.uptimeInterval = null;
      }

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
    if (
      this.positionManager.isTradeProcessed(
        trade.transactionHash || `${trade.conditionId}-${trade.timestamp}`
      )
    ) {
      logger.debug(
        { tradeId: trade.transactionHash || `${trade.conditionId}-${trade.timestamp}` },
        'Trade already processed, skipping'
      );
      return;
    }

    // Apply trade filtering
    const targetTradeValue = Number(trade.size) * Number(trade.price);
    if (targetTradeValue < this.config.trading.minTradeSizeUsd) {
      logger.debug(
        {
          tradeId: trade.transactionHash || `${trade.conditionId}-${trade.timestamp}`,
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
          tradeId: trade.transactionHash || `${trade.conditionId}-${trade.timestamp}`,
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
        tradeId: trade.transactionHash || `${trade.conditionId}-${trade.timestamp}`,
        market: trade.conditionId,
        side: trade.side,
        size: trade.size,
        price: trade.price,
        queueLength: this.tradeQueue.length,
        processing: this.processingTrades,
      },
      '📥 Trade queued for processing'
    );

    // Add to trade history
    const detectedEntry: TradeHistoryEntry = {
      id: trade.transactionHash || `${trade.conditionId}-${trade.timestamp}`,
      timestamp: Date.now(),
      type: 'target_detected' as const,
      market: trade.conditionId,
      side: trade.side,
      size: Number(trade.size),
      price: Number(trade.price),
      value: Number(trade.size) * Number(trade.price),
      // Include market metadata (only if defined)
      ...(trade.title && { title: trade.title }),
      ...(trade.slug && { slug: trade.slug }),
      ...(trade.icon && { icon: trade.icon }),
      ...(trade.outcome && { outcome: trade.outcome }),
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
              tradeId: trade.transactionHash || `${trade.conditionId}-${trade.timestamp}`,
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
      if (!trade.asset || !trade.conditionId || !trade.proxyWallet) {
        logger.warn(
          {
            tradeId: trade.transactionHash || `${trade.conditionId}-${trade.timestamp}`,
            hasAssetId: !!trade.asset,
            hasMarket: !!trade.conditionId,
            hasMaker: !!trade.proxyWallet,
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
          id: trade.transactionHash || `${trade.conditionId}-${trade.timestamp}`,
          timestamp: Date.now(),
          type: 'copy_executed',
          market: trade.conditionId,
          side: trade.side,
          size: result.executedSize || Number(trade.size),
          price: result.executedPrice || Number(trade.price),
          value:
            (result.executedSize || Number(trade.size)) *
            (result.executedPrice || Number(trade.price)),
          latencyMs,
          // Include market metadata (only if defined)
          ...(result.orderId && { orderId: result.orderId }),
          ...(trade.title && { title: trade.title }),
          ...(trade.slug && { slug: trade.slug }),
          ...(trade.icon && { icon: trade.icon }),
          ...(trade.outcome && { outcome: trade.outcome }),
        };
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
        this.positionManager.markTradeProcessed(
          trade.transactionHash || `${trade.conditionId}-${trade.timestamp}`
        );
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
          id: trade.transactionHash || `${trade.conditionId}-${trade.timestamp}`,
          timestamp: Date.now(),
          type: 'copy_failed',
          market: trade.conditionId,
          side: trade.side,
          size: Number(trade.size),
          price: Number(trade.price),
          value: Number(trade.size) * Number(trade.price),
          latencyMs,
          // Include market metadata (only if defined)
          ...(result.error && { error: result.error }),
          ...(trade.title && { title: trade.title }),
          ...(trade.slug && { slug: trade.slug }),
          ...(trade.icon && { icon: trade.icon }),
          ...(trade.outcome && { outcome: trade.outcome }),
        };
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
   * Handle WebSocket connection status change
   */
  private handleConnectionStatusChange(status: ConnectionStatus): void {
    logger.info(
      {
        connected: status.connected,
        reason: status.reason,
      },
      status.connected ? '✅ WebSocket connected' : '❌ WebSocket disconnected'
    );

    // Broadcast to SSE clients
    if (this.webServer) {
      this.webServer.getSSEManager().broadcast({
        type: 'connection_status',
        timestamp: status.timestamp,
        data: {
          connected: status.connected,
          reason: status.reason,
        },
      });
    }
  }

  /**
   * Start periodic uptime broadcast
   */
  private startUptimeBroadcast(): void {
    // Broadcast uptime every 30 seconds
    this.uptimeInterval = setInterval(() => {
      if (!this.webServer) return;

      const uptimeSeconds = Math.floor((Date.now() - this.startTime) / 1000);
      const hours = Math.floor(uptimeSeconds / 3600);
      const minutes = Math.floor((uptimeSeconds % 3600) / 60);
      const seconds = uptimeSeconds % 60;

      this.webServer.getSSEManager().broadcast({
        type: 'uptime',
        timestamp: Date.now(),
        data: {
          uptimeSeconds,
          uptimeFormatted: `${hours}h ${minutes}m ${seconds}s`,
        },
      });
    }, 30000); // Every 30 seconds
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
      clobClient: this.clobClient,
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
