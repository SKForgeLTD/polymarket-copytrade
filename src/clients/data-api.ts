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
   * Get trades for a specific user
   * API returns trades with fields: proxyWallet, side, asset, conditionId, size (number), price (number), timestamp
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
      const params = new URLSearchParams({
        user: userAddress.toLowerCase(),
        limit: String(options.limit || 100),
        offset: String(options.offset || 0),
      });

      if (options.startTime) {
        params.append('startTime', String(options.startTime));
      }
      if (options.endTime) {
        params.append('endTime', String(options.endTime));
      }

      const response = await this.client.get<Trade[]>('/trades', { params });

      // Convert timestamps from Unix seconds to milliseconds
      const trades = response.data.map((trade) => ({
        ...trade,
        timestamp: trade.timestamp * 1000,
      }));

      logger.debug(
        {
          userAddress,
          count: trades.length,
        },
        'Retrieved user trades'
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
