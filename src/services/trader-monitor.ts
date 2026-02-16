import { EventEmitter } from 'node:events';
import type { DataApiClient } from '../clients/data-api.js';
import type { PolymarketRTDSClient } from '../clients/rtds-client.js';
import type { Config } from '../config/index.js';
import { createChildLogger } from '../logger/index.js';
import type { Trade } from '../types/polymarket.js';

const logger = createChildLogger({ module: 'TraderMonitor' });

/**
 * Events emitted by TraderMonitor
 */
interface TraderMonitorEvents {
  trade: (trade: Trade) => void;
  error: (error: Error) => void;
}

/**
 * Monitor target trader for new trades via WebSocket and polling fallback
 */
export class TraderMonitor extends EventEmitter {
  private config: Config;
  private rtdsClient: PolymarketRTDSClient;
  private dataApiClient: DataApiClient;
  private isMonitoring = false;
  private pollingInterval: NodeJS.Timeout | null = null;
  private lastSeenTimestamp = Date.now();
  // Source-aware deduplication to prevent WebSocket + Polling from emitting same trade
  private recentTrades = new Map<string, number>(); // tradeId → timestamp
  private readonly DEDUP_WINDOW_MS = 60000; // 1 minute

  constructor(config: Config, rtdsClient: PolymarketRTDSClient, dataApiClient: DataApiClient) {
    super();
    this.config = config;
    this.rtdsClient = rtdsClient;
    this.dataApiClient = dataApiClient;
  }

  /**
   * Start monitoring target trader
   */
  async start(): Promise<void> {
    if (this.isMonitoring) {
      logger.warn('Already monitoring');
      return;
    }

    this.isMonitoring = true;
    logger.info(
      {
        targetAddress: this.config.trading.targetTraderAddress,
      },
      'Starting trader monitoring'
    );

    // Set up WebSocket monitoring
    await this.setupWebSocketMonitoring();

    // Start polling backup (runs alongside WebSocket for redundancy)
    this.startPolling();
  }

  /**
   * Stop monitoring
   */
  stop(): void {
    if (!this.isMonitoring) {
      return;
    }

    this.isMonitoring = false;
    logger.info('Stopping trader monitoring');

    // Disconnect WebSocket
    this.rtdsClient.disconnect();

    // Stop polling
    if (this.pollingInterval) {
      clearInterval(this.pollingInterval);
      this.pollingInterval = null;
    }
  }

  /**
   * Set up WebSocket monitoring
   */
  private async setupWebSocketMonitoring(): Promise<void> {
    // Handle trade events
    this.rtdsClient.on('trade', (trade) => {
      this.handleTrade(trade, 'websocket');
    });

    // Handle connection events
    this.rtdsClient.on('connected', () => {
      logger.info('WebSocket connected');
    });

    this.rtdsClient.on('disconnected', () => {
      logger.warn('WebSocket disconnected, relying on polling fallback');
    });

    this.rtdsClient.on('error', (error) => {
      logger.error(
        {
          error: error.message,
        },
        'WebSocket error'
      );
      this.emit('error', error);
    });

    // Connect to WebSocket
    try {
      await this.rtdsClient.connect();
    } catch (error) {
      logger.error(
        {
          error: error instanceof Error ? error.message : String(error),
        },
        'Failed to connect WebSocket, relying on polling'
      );
    }
  }

  /**
   * Start polling for new trades
   */
  private startPolling(): void {
    const intervalMs = this.config.monitoring.pollingIntervalSeconds * 1000;

    logger.info(
      {
        intervalSeconds: this.config.monitoring.pollingIntervalSeconds,
      },
      'Starting polling backup (redundancy alongside WebSocket)'
    );

    this.pollingInterval = setInterval(async () => {
      await this.pollForNewTrades();
    }, intervalMs);
  }

  /**
   * Poll for new trades
   */
  private async pollForNewTrades(): Promise<void> {
    try {
      logger.debug(
        {
          targetAddress: `${this.config.trading.targetTraderAddress.substring(0, 10)}...`,
          lastSeenTimestamp: new Date(this.lastSeenTimestamp).toISOString(),
        },
        '🔍 Polling for new trades...'
      );

      const newTrades = await this.dataApiClient.pollNewTrades(
        this.config.trading.targetTraderAddress,
        this.lastSeenTimestamp
      );

      if (newTrades.length > 0) {
        logger.info(
          {
            count: newTrades.length,
            source: 'polling',
          },
          `📊 Polling found ${newTrades.length} new trade(s)`
        );
      }

      for (const trade of newTrades) {
        this.handleTrade(trade, 'polling');
      }
    } catch (error) {
      logger.error(
        {
          error: error instanceof Error ? error.message : String(error),
        },
        'Error polling for trades'
      );
    }
  }

  /**
   * Handle detected trade
   */
  private handleTrade(trade: Trade, source: 'websocket' | 'polling'): void {
    const now = Date.now();

    // Validate required fields early
    if (!trade.market || !trade.asset_id || !trade.maker_address) {
      logger.warn(
        {
          tradeId: trade.id,
          source,
          hasMarket: !!trade.market,
          hasAssetId: !!trade.asset_id,
          hasMaker: !!trade.maker_address,
        },
        'Trade missing required fields, ignoring'
      );
      return;
    }

    const tradeValue = Number(trade.size) * Number(trade.price);

    // Log ALL incoming trades (before any filtering)
    logger.info(
      {
        source,
        tradeId: trade.id,
        maker: `${trade.maker_address.substring(0, 10)}...`,
        market: trade.market?.substring(0, 30) || 'unknown',
        side: trade.side,
        size: Number(trade.size).toFixed(2),
        price: Number(trade.price).toFixed(4),
        value: `$${tradeValue.toFixed(2)}`,
      },
      `📡 Trade received from ${source}`
    );

    // Check if this trade was recently processed (prevent WebSocket + Polling duplicates)
    const lastSeen = this.recentTrades.get(trade.id);
    if (lastSeen && now - lastSeen < this.DEDUP_WINDOW_MS) {
      logger.info(
        {
          tradeId: trade.id,
          source,
          timeSinceLastSeen: `${Math.round((now - lastSeen) / 1000)}s`,
        },
        '🔄 Duplicate trade filtered (already seen)'
      );
      return;
    }

    // Mark trade as recently seen
    this.recentTrades.set(trade.id, now);

    // Cleanup old entries to prevent unbounded growth
    for (const [id, ts] of this.recentTrades.entries()) {
      if (now - ts > this.DEDUP_WINDOW_MS) {
        this.recentTrades.delete(id);
      }
    }

    // Update last seen timestamp
    if (trade.timestamp > this.lastSeenTimestamp) {
      this.lastSeenTimestamp = trade.timestamp;
    }

    // Filter by maker address (target trader)
    if (
      trade.maker_address.toLowerCase() !== this.config.trading.targetTraderAddress.toLowerCase()
    ) {
      logger.info(
        {
          tradeId: trade.id,
          maker: `${trade.maker_address.substring(0, 10)}...`,
          target: `${this.config.trading.targetTraderAddress.substring(0, 10)}...`,
        },
        '❌ Trade from different address (not our target)'
      );
      return;
    }

    // Filter by minimum trade size
    if (tradeValue < this.config.trading.minTradeSizeUsd) {
      logger.info(
        {
          tradeId: trade.id,
          value: `$${tradeValue.toFixed(2)}`,
          minRequired: `$${this.config.trading.minTradeSizeUsd}`,
        },
        '⚠️ Trade below minimum threshold, skipping'
      );
      return;
    }

    logger.info(
      {
        source,
        tradeId: trade.id,
        market: trade.market?.substring(0, 40) || 'unknown',
        side: trade.side,
        size: Number(trade.size).toFixed(2),
        price: Number(trade.price).toFixed(4),
        value: `$${tradeValue.toFixed(2)}`,
        maker: `${trade.maker_address.substring(0, 10)}...`,
      },
      '✅ Target trader trade detected - processing'
    );

    // Emit trade event
    this.emit('trade', trade);
  }

  /**
   * Get monitoring status
   */
  getStatus() {
    return {
      isMonitoring: this.isMonitoring,
      websocketConnected: this.rtdsClient.isConnected(),
      pollingActive: this.pollingInterval !== null,
      lastSeenTimestamp: this.lastSeenTimestamp,
      targetAddress: this.config.trading.targetTraderAddress,
    };
  }

  /**
   * Type-safe event listener registration
   */
  override on<K extends keyof TraderMonitorEvents>(
    event: K,
    listener: TraderMonitorEvents[K]
  ): this {
    return super.on(event, listener);
  }

  override once<K extends keyof TraderMonitorEvents>(
    event: K,
    listener: TraderMonitorEvents[K]
  ): this {
    return super.once(event, listener);
  }

  override emit<K extends keyof TraderMonitorEvents>(
    event: K,
    ...args: Parameters<TraderMonitorEvents[K]>
  ): boolean {
    return super.emit(event, ...args);
  }
}
