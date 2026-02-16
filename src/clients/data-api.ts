import axios, { type AxiosInstance } from 'axios';
import { createChildLogger } from '../logger/index.js';
import type { Trade } from '../types/polymarket.js';

const logger = createChildLogger({ module: 'DataAPI' });

/**
 * Client for Polymarket Data API (REST)
 */
export class DataApiClient {
  private client: AxiosInstance;
  private baseUrl = 'https://data-api.polymarket.com';

  // Rate limiting for Data API calls (with proper queuing)
  private lastApiCallPromise: Promise<void> = Promise.resolve();
  private readonly API_CALL_COOLDOWN_MS = 1000; // 1 second between calls

  constructor() {
    this.client = axios.create({
      baseURL: this.baseUrl,
      timeout: 10000,
      headers: {
        'Content-Type': 'application/json',
      },
    });

    // Add response interceptor for logging
    this.client.interceptors.response.use(
      (response) => response,
      (error) => {
        logger.error(
          {
            url: error.config?.url,
            status: error.response?.status,
            message: error.message,
          },
          'Data API request failed'
        );
        return Promise.reject(error);
      }
    );

    logger.info('Data API client initialized');
  }

  /**
   * Ensure rate limit between API calls (1 second cooldown)
   * Properly queues concurrent calls to prevent race conditions
   */
  private async ensureRateLimit(): Promise<void> {
    // Chain this call after the previous one
    const currentPromise = this.lastApiCallPromise.then(async () => {
      // Wait for cooldown period
      await new Promise((resolve) => setTimeout(resolve, this.API_CALL_COOLDOWN_MS));
      logger.debug({ cooldownMs: this.API_CALL_COOLDOWN_MS }, 'Rate limit cooldown completed');
    });

    // Update the chain for the next call
    this.lastApiCallPromise = currentPromise;

    // Wait for our turn
    await currentPromise;
  }

  /**
   * Get trades for a specific user using /activity endpoint (real-time, ~10-15s lag)
   * Docs: https://docs.polymarket.com/developers/misc-endpoints/data-api-activity
   *
   * Supports:
   * - Time filtering (start/end timestamps)
   * - Type filtering (we use type=TRADE)
   * - Up to 500 results per request
   * - Rich metadata (title, slug, icon, outcome, pseudonym, etc.)
   *
   * Much faster than /trades endpoint (~15s lag vs 7+ min lag)
   */
  async getUserTrades(
    userAddress: string,
    options: {
      limit?: number;
      offset?: number;
      startTime?: number;
      endTime?: number;
    } = {}
  ): Promise<Trade[]> {
    try {
      // Rate limit before API call
      await this.ensureRateLimit();

      const params = new URLSearchParams({
        user: userAddress.toLowerCase(),
        limit: String(options.limit || 20),
        offset: String(options.offset || 0),
        type: 'TRADE', // Server-side filter for trades only (vs SPLIT, MERGE, REDEEM, etc.)
      });

      // Add time filtering if provided (Unix seconds)
      if (options.startTime) {
        params.append('start', String(Math.floor(options.startTime / 1000)));
      }
      if (options.endTime) {
        params.append('end', String(Math.floor(options.endTime / 1000)));
      }

      // Note: /activity endpoint is much more real-time than /trades (~15s lag vs 7+ min lag)
      // Supports time filtering (start/end), type filtering, and up to 500 results per request
      // Sorted by timestamp DESC (newest first) by default

      const response = await this.client.get<Trade[]>('/activity', { params });

      // No need to filter for TRADE type - we filter server-side via type=TRADE parameter
      const activities = response.data;

      // Convert timestamps from Unix seconds to milliseconds
      const trades = activities.map((trade) => ({
        ...trade,
        timestamp: trade.timestamp * 1000,
      }));

      logger.debug(
        {
          userAddress,
          count: trades.length,
          totalActivities: response.data.length,
        },
        'Retrieved user trades from activity endpoint'
      );

      return trades;
    } catch (error) {
      logger.error(
        {
          userAddress,
          error: error instanceof Error ? error.message : String(error),
        },
        'Failed to get user trades'
      );
      throw error;
    }
  }

  /**
   * Get the latest trade for a user
   */
  async getLatestTrade(userAddress: string): Promise<Trade | null> {
    try {
      const trades = await this.getUserTrades(userAddress, { limit: 1 });
      return trades.length > 0 ? (trades[0] ?? null) : null;
    } catch (error) {
      logger.error(
        {
          userAddress,
          error: error instanceof Error ? error.message : String(error),
        },
        'Failed to get latest trade'
      );
      return null;
    }
  }

  /**
   * Get trades for a specific market
   */
  async getMarketTrades(
    conditionId: string,
    options: {
      limit?: number;
      offset?: number;
    } = {}
  ): Promise<Trade[]> {
    try {
      // Rate limit before API call
      await this.ensureRateLimit();

      const params = new URLSearchParams({
        market: conditionId,
        limit: String(options.limit || 100),
        offset: String(options.offset || 0),
      });

      const response = await this.client.get<Trade[]>('/trades', { params });

      logger.debug(
        {
          conditionId,
          count: response.data.length,
        },
        'Retrieved market trades'
      );

      return response.data;
    } catch (error) {
      logger.error(
        {
          conditionId,
          error: error instanceof Error ? error.message : String(error),
        },
        'Failed to get market trades'
      );
      throw error;
    }
  }

  /**
   * Get market information
   */
  async getMarket(conditionId: string) {
    try {
      // Rate limit before API call
      await this.ensureRateLimit();

      const response = await this.client.get(`/markets/${conditionId}`);
      return response.data;
    } catch (error) {
      logger.error(
        {
          conditionId,
          error: error instanceof Error ? error.message : String(error),
        },
        'Failed to get market info'
      );
      throw error;
    }
  }

  /**
   * Poll for new trades since a given timestamp
   */
  async pollNewTrades(userAddress: string, sinceTimestamp: number): Promise<Trade[]> {
    try {
      const trades = await this.getUserTrades(userAddress, {
        startTime: sinceTimestamp,
        limit: 50,
      });

      // Filter trades newer than timestamp
      const newTrades = trades.filter((trade) => trade.timestamp > sinceTimestamp);

      if (newTrades.length > 0) {
        logger.info(
          {
            userAddress,
            count: newTrades.length,
            sinceTimestamp,
          },
          'Detected new trades via polling'
        );
      }

      return newTrades;
    } catch (error) {
      logger.error(
        {
          userAddress,
          sinceTimestamp,
          error: error instanceof Error ? error.message : String(error),
        },
        'Failed to poll for new trades'
      );
      return [];
    }
  }
}
