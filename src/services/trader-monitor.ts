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
  private lastPollTimestamp: number;
  private readonly POLL_INTERVAL_MS = 5000; // 5 seconds = ~12/min = 720/hour (70% of 1000/hour limit)
  // Trade deduplication
  private recentTrades = new Set<string>(); // Set of transaction hashes
  private readonly MAX_DEDUP_CACHE_SIZE = 1000; // Limit cache size

  constructor(config: Config, dataApiClient: DataApiClient) {
    super();
    this.config = config;
    this.dataApiClient = dataApiClient;
    // Start polling from 1 minute ago to catch recent trades on first poll
    this.lastPollTimestamp = Math.floor(Date.now() / 1000) - 60;
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
      const currentTimestamp = Math.floor(Date.now() / 1000);

      // Fetch trades since last poll
      const trades = await this.dataApiClient.getUserTrades(this.config.trading.targetTraderAddress, {
        startTime: this.lastPollTimestamp,
        limit: 100,
      });

      logger.debug(
        {
          tradesFound: trades.length,
          startTime: new Date(this.lastPollTimestamp * 1000).toISOString(),
        },
        'Poll completed'
      );

      // Process trades in chronological order (oldest first)
      const sortedTrades = trades.sort((a, b) => a.timestamp - b.timestamp);

      for (const trade of sortedTrades) {
        this.handleTrade(trade);
      }

      // Update last poll timestamp for next poll
      this.lastPollTimestamp = currentTimestamp;
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
   */
  private handleTrade(trade: Trade): void {
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
      return;
    }

    // Deduplicate by transaction hash
    if (this.recentTrades.has(trade.transactionHash)) {
      return; // Already processed
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
      return;
    }

    logger.info(getTradeLogObject(trade), '✅ Target trade detected');

    // Emit trade event
    this.emit('trade', trade);
  }

  /**
   * Get monitoring status
   */
  getStatus() {
    return {
      isMonitoring: this.isMonitoring,
      pollingActive: !!this.pollingInterval,
      lastPollTime: new Date(this.lastPollTimestamp * 1000).toISOString(),
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
