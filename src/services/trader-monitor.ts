import { EventEmitter } from 'node:events';
import type { PolymarketRTDSClient } from '../clients/rtds-client.js';
import type { Config } from '../config/index.js';
import { createChildLogger } from '../logger/index.js';
import type { Trade } from '../types/polymarket.js';

const logger = createChildLogger({ module: 'TraderMonitor' });

/**
 * Connection status for WebSocket
 */
export interface ConnectionStatus {
  connected: boolean;
  timestamp: number;
  reason?: string;
}

/**
 * Events emitted by TraderMonitor
 */
interface TraderMonitorEvents {
  trade: (trade: Trade) => void;
  error: (error: Error) => void;
  connectionStatus: (status: ConnectionStatus) => void;
}

/**
 * Monitor target trader for new trades via WebSocket only
 */
export class TraderMonitor extends EventEmitter {
  private config: Config;
  private rtdsClient: PolymarketRTDSClient;
  private isMonitoring = false;
  private lastSeenTimestamp = Date.now();
  // Trade deduplication (WebSocket may emit duplicates)
  private recentTrades = new Map<string, number>(); // tradeId → timestamp
  private readonly DEDUP_WINDOW_MS = 60000; // 1 minute

  constructor(config: Config, rtdsClient: PolymarketRTDSClient) {
    super();
    this.config = config;
    this.rtdsClient = rtdsClient;
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
      'Starting WebSocket monitoring'
    );

    // Set up WebSocket monitoring
    await this.setupWebSocketMonitoring();
  }

  /**
   * Stop monitoring
   */
  stop(): void {
    if (!this.isMonitoring) {
      return;
    }

    this.isMonitoring = false;
    logger.info('Stopping WebSocket monitoring');

    // Disconnect WebSocket
    this.rtdsClient.disconnect();
  }

  /**
   * Set up WebSocket monitoring
   */
  private async setupWebSocketMonitoring(): Promise<void> {
    // Handle trade events
    this.rtdsClient.on('trade', (trade) => {
      this.handleTrade(trade);
    });

    // Handle connection events
    this.rtdsClient.on('connected', () => {
      logger.info('WebSocket connected');
      this.emit('connectionStatus', {
        connected: true,
        timestamp: Date.now(),
      });
    });

    this.rtdsClient.on('disconnected', () => {
      logger.warn('WebSocket disconnected');
      this.emit('connectionStatus', {
        connected: false,
        timestamp: Date.now(),
        reason: 'disconnected',
      });
    });

    this.rtdsClient.on('error', (error) => {
      logger.error(
        {
          error: error.message,
        },
        'WebSocket error'
      );
      this.emit('error', error);
      this.emit('connectionStatus', {
        connected: false,
        timestamp: Date.now(),
        reason: error.message,
      });
    });

    // Connect to WebSocket
    try {
      await this.rtdsClient.connect();
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error(
        {
          error: errorMessage,
        },
        'Failed to connect WebSocket'
      );
      this.emit('connectionStatus', {
        connected: false,
        timestamp: Date.now(),
        reason: errorMessage,
      });
      throw error;
    }
  }

  /**
   * Handle detected trade
   */
  private handleTrade(trade: Trade): void {
    const now = Date.now();

    // Validate required fields early
    if (!trade.market || !trade.asset_id || !trade.maker_address) {
      logger.warn(
        {
          tradeId: trade.id,
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
        tradeId: trade.id,
        maker: `${trade.maker_address.substring(0, 10)}...`,
        market: trade.market?.substring(0, 30) || 'unknown',
        side: trade.side,
        size: Number(trade.size).toFixed(2),
        price: Number(trade.price).toFixed(4),
        value: `$${tradeValue.toFixed(2)}`,
      },
      '📡 Trade received from WebSocket'
    );

    // Check if this trade was recently processed (prevent duplicates)
    const lastSeen = this.recentTrades.get(trade.id);
    if (lastSeen && now - lastSeen < this.DEDUP_WINDOW_MS) {
      logger.info(
        {
          tradeId: trade.id,
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

    // Use readable market name
    const marketName = trade.title || trade.slug || `${trade.market.substring(0, 6)}...${trade.market.substring(trade.market.length - 4)}`;

    logger.info(
      {
        market: marketName,
        outcome: trade.outcome,
        side: trade.side,
        size: Number(trade.size).toFixed(2),
        price: Number(trade.price).toFixed(4),
        value: `$${tradeValue.toFixed(2)}`,
      },
      '✅ Target trade detected'
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
