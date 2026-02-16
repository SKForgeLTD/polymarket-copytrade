import { EventEmitter } from 'node:events';
import type { DataApiClient } from '../clients/data-api.js';
import type { Config } from '../config/index.js';
import { createChildLogger } from '../logger/index.js';
import type { Trade } from '../types/polymarket.js';
import { getTradeLogObject } from '../utils/format.js';

const logger = createChildLogger({ module: 'TraderMonitor' });

/**
 * Events emitted by TraderMonitor
 */
interface TraderMonitorEvents {
  trade: (trade: Trade) => void;
  error: (error: Error) => void;
}

/**
 * Monitor target trader for new trades via HTTP polling
 */
export class TraderMonitor extends EventEmitter {
  private config: Config;
  private dataApiClient: DataApiClient;
  private isMonitoring = false;
  private pollingInterval: NodeJS.Timeout | null = null;
  private lastPollTimestamp = 0; // Track actual poll time for UI
  private readonly POLL_INTERVAL_MS = 5000; // 5 seconds = ~12/min = 720/hour (70% of 1000/hour limit)
  private readonly POLL_WINDOW_SECONDS = 7; // Fetch trades from last 7 seconds
  // Trade deduplication
  private recentTrades = new Set<string>(); // Set of transaction hashes
  private readonly MAX_DEDUP_CACHE_SIZE = 1000; // Limit cache size

  constructor(config: Config, dataApiClient: DataApiClient) {
    super();
    this.config = config;
    this.dataApiClient = dataApiClient;
  }

  /**
   * Start monitoring target trader via HTTP polling
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
        pollIntervalSeconds: this.POLL_INTERVAL_MS / 1000,
      },
      '🔄 Starting HTTP polling for target trader'
    );

    // Do initial poll immediately
    await this.pollForTrades();

    // Set up polling interval
    this.pollingInterval = setInterval(() => {
      this.pollForTrades().catch((error) => {
        logger.error(
          {
            error: error instanceof Error ? error.message : String(error),
          },
          'Error during polling'
        );
      });
    }, this.POLL_INTERVAL_MS);
  }

  /**
   * Stop monitoring
   */
  stop(): void {
    if (!this.isMonitoring) {
      return;
    }

    this.isMonitoring = false;
    logger.info('Stopping HTTP polling');

    // Clear polling interval
    if (this.pollingInterval) {
      clearInterval(this.pollingInterval);
      this.pollingInterval = null;
    }
  }

  /**
   * Poll for new trades from target trader
   */
  private async pollForTrades(): Promise<void> {
    try {
      // Update last poll timestamp for UI
      this.lastPollTimestamp = Date.now();

      // Fetch recent trades (API doesn't support time filtering for user queries)
      const trades = await this.dataApiClient.getUserTrades(this.config.trading.targetTraderAddress, {
        limit: 20, // Reduced since we filter client-side
      });

      // Log trade ages for debugging
      if (trades.length > 0) {
        const now = Date.now();
        const tradeAges = trades.map(t => Math.floor((now - t.timestamp) / 1000));
        logger.debug(
          {
            tradesFound: trades.length,
            windowSeconds: this.POLL_WINDOW_SECONDS,
            oldestTradeAge: `${Math.max(...tradeAges)}s ago`,
            newestTradeAge: `${Math.min(...tradeAges)}s ago`,
          },
          'Poll completed'
        );
      } else {
        logger.debug(
          {
            tradesFound: 0,
            windowSeconds: this.POLL_WINDOW_SECONDS,
          },
          'Poll completed - no trades'
        );
      }

      // Filter trades to only those within our polling window (ignore old trades from API)
      const now = Date.now();
      const windowMs = this.POLL_WINDOW_SECONDS * 1000;
      const recentTrades = trades.filter(trade => {
        const tradeAge = now - trade.timestamp;
        return tradeAge <= windowMs;
      });

      // Process trades in chronological order (oldest first)
      const sortedTrades = recentTrades.sort((a, b) => a.timestamp - b.timestamp);

      let newTradesCount = 0;
      let filteredCount = 0;
      let oldTradesCount = trades.length - recentTrades.length;

      for (const trade of sortedTrades) {
        const isNew = this.handleTrade(trade);
        if (isNew) {
          newTradesCount++;
        } else {
          filteredCount++;
        }
      }

      // Log if API returned trades older than our window (debug level - this is expected)
      if (oldTradesCount > 0) {
        logger.debug(
          {
            oldTrades: oldTradesCount,
            recentTrades: recentTrades.length,
          },
          'Filtered out old trades'
        );
      }

      // Log filtered trades summary if any were skipped
      if (filteredCount > 0) {
        logger.debug(
          {
            filtered: filteredCount,
            new: newTradesCount,
          },
          'Filtered duplicate/old trades'
        );
      }
    } catch (error) {
      logger.error(
        {
          error: error instanceof Error ? error.message : String(error),
        },
        'Failed to poll for trades'
      );
      throw error;
    }
  }

  /**
   * Handle detected trade from polling
   * Returns true if trade is new, false if filtered/duplicate
   */
  private handleTrade(trade: Trade): boolean {
    // Validate required fields
    if (!trade.conditionId || !trade.asset || !trade.proxyWallet || !trade.transactionHash) {
      logger.warn(
        {
          tradeHash: trade.transactionHash,
          hasConditionId: !!trade.conditionId,
          hasAsset: !!trade.asset,
          hasProxyWallet: !!trade.proxyWallet,
        },
        'Trade missing required fields, ignoring'
      );
      return false;
    }

    // Deduplicate by transaction hash
    if (this.recentTrades.has(trade.transactionHash)) {
      return false; // Already processed
    }

    // Mark as processed
    this.recentTrades.add(trade.transactionHash);

    // Cleanup cache if too large (remove oldest entries)
    if (this.recentTrades.size > this.MAX_DEDUP_CACHE_SIZE) {
      const toRemove = Array.from(this.recentTrades).slice(0, 100);
      for (const hash of toRemove) {
        this.recentTrades.delete(hash);
      }
    }

    const tradeValue = Number(trade.size) * Number(trade.price);

    // Filter by minimum trade size
    if (tradeValue < this.config.trading.minTradeSizeUsd) {
      logger.debug(
        {
          tradeHash: trade.transactionHash,
          value: `$${tradeValue.toFixed(2)}`,
          minRequired: `$${this.config.trading.minTradeSizeUsd}`,
        },
        'Trade below minimum threshold, skipping'
      );
      return false;
    }

    logger.info(getTradeLogObject(trade), '✅ Target trade detected');

    // Emit trade event
    this.emit('trade', trade);
    return true;
  }

  /**
   * Get monitoring status
   */
  getStatus() {
    return {
      isMonitoring: this.isMonitoring,
      pollingActive: !!this.pollingInterval,
      lastPollTime: this.lastPollTimestamp > 0
        ? new Date(this.lastPollTimestamp).toISOString()
        : new Date().toISOString(),
      targetAddress: this.config.trading.targetTraderAddress,
      pollIntervalSeconds: this.POLL_INTERVAL_MS / 1000,
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
