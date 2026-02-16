import fs from 'node:fs/promises';
import path from 'node:path';
import { createChildLogger } from '../logger/index.js';
import type { Position, Trade } from '../types/polymarket.js';
import { getReadableMarketName } from '../utils/format.js';

const logger = createChildLogger({ module: 'PositionManager' });

/**
 * Track and manage positions for both user and target trader
 */
export class PositionManager {
  private userPositions = new Map<string, Position>();
  private targetPositions = new Map<string, Position>();
  private stateFilePath: string;
  // Track recently processed trade IDs to prevent duplicates
  private processedTradeIds = new Set<string>();
  private readonly TRADE_CACHE_SIZE = 1000;

  constructor(stateFilePath = './state/positions.json') {
    this.stateFilePath = stateFilePath;
  }

  /**
   * Initialize position manager and load persisted state
   */
  async initialize(): Promise<void> {
    try {
      await this.loadState();
      logger.info('Position manager initialized');
    } catch (error) {
      logger.warn(
        {
          error: error instanceof Error ? error.message : String(error),
        },
        'Failed to load persisted state, starting fresh'
      );
    }
  }

  /**
   * Update position based on a trade
   */
  updatePosition(trade: Trade, isUserTrade = false): void {
    const positionMap = isUserTrade ? this.userPositions : this.targetPositions;

    // CRITICAL: Validate required fields
    if (!trade.asset || !trade.conditionId) {
      logger.warn(
        {
          tradeHash: trade.transactionHash,
          hasAsset: !!trade.asset,
          hasConditionId: !!trade.conditionId,
        },
        'Trade missing required fields (asset or conditionId), skipping position update'
      );
      return;
    }

    const positionKey = trade.asset;

    const existingPosition = positionMap.get(positionKey);

    if (!existingPosition) {
      // New position
      const newPosition: Position = {
        tokenId: trade.asset,
        market: trade.conditionId,
        outcome: trade.outcome || 'Unknown',
        size: Number(trade.size),
        avgPrice: Number(trade.price),
        side: trade.side,
        value: Number(trade.size) * Number(trade.price),
        lastUpdated: trade.timestamp,
      };

      positionMap.set(positionKey, newPosition);

      logger.info(
        {
          isUserTrade,
          market: getReadableMarketName(trade),
          outcome: trade.outcome,
          side: newPosition.side,
          size: newPosition.size,
          price: newPosition.avgPrice,
        },
        'Created new position'
      );
    } else {
      // Update existing position
      const tradeSize = Number(trade.size);
      const tradePrice = Number(trade.price);

      if (trade.side === existingPosition.side) {
        // Adding to position
        const newSize = existingPosition.size + tradeSize;
        const newAvgPrice =
          (existingPosition.avgPrice * existingPosition.size + tradePrice * tradeSize) / newSize;

        existingPosition.size = newSize;
        existingPosition.avgPrice = newAvgPrice;
        existingPosition.value = newSize * newAvgPrice;
      } else {
        // Reducing or closing position
        const newSize = existingPosition.size - tradeSize;

        if (newSize <= 0) {
          // Position closed
          positionMap.delete(positionKey);

          // Log warning if position was over-closed (flipped)
          if (newSize < 0) {
            logger.warn(
              {
                isUserTrade,
                market: getReadableMarketName(trade),
                outcome: trade.outcome,
                originalSize: existingPosition.size,
                tradeSize,
                overshoot: Math.abs(newSize),
              },
              'Position closed with overshoot - trade size exceeded position size'
            );
          } else {
            logger.info(
              {
                isUserTrade,
                market: getReadableMarketName(trade),
                outcome: trade.outcome,
              },
              'Closed position'
            );
          }
          return;
        }

        existingPosition.size = newSize;
        existingPosition.value = newSize * existingPosition.avgPrice;
      }

      existingPosition.lastUpdated = trade.timestamp;

      logger.info(
        {
          isUserTrade,
          market: getReadableMarketName(trade),
          outcome: trade.outcome,
          side: trade.side,
          newSize: existingPosition.size,
          avgPrice: existingPosition.avgPrice,
        },
        'Updated position'
      );
    }

    // Persist state after update - no await to keep it async but log errors
    this.saveStateWithRetry().catch((error) => {
      logger.error(
        {
          error: error instanceof Error ? error.message : String(error),
        },
        'Critical: Failed to persist state after retries'
      );
    });
  }

  /**
   * Get user position for a specific token
   */
  getUserPosition(tokenId: string): Position | null {
    return this.userPositions.get(tokenId) || null;
  }

  /**
   * Get target position for a specific token
   */
  getTargetPosition(tokenId: string): Position | null {
    return this.targetPositions.get(tokenId) || null;
  }

  /**
   * Get all user positions
   */
  getAllUserPositions(): Position[] {
    return Array.from(this.userPositions.values());
  }

  /**
   * Get all target positions
   */
  getAllTargetPositions(): Position[] {
    return Array.from(this.targetPositions.values());
  }

  /**
   * Check if trade has already been processed
   */
  isTradeProcessed(tradeId: string): boolean {
    return this.processedTradeIds.has(tradeId);
  }

  /**
   * Mark trade as processed
   */
  markTradeProcessed(tradeId: string): void {
    this.processedTradeIds.add(tradeId);

    // Prevent unbounded growth by removing oldest entries
    if (this.processedTradeIds.size > this.TRADE_CACHE_SIZE) {
      const firstEntry = this.processedTradeIds.values().next().value;
      if (firstEntry) {
        this.processedTradeIds.delete(firstEntry);
      }
    }
  }

  /**
   * Clear all positions (for testing/reset)
   */
  clearAllPositions(): void {
    this.userPositions.clear();
    this.targetPositions.clear();
    this.processedTradeIds.clear();
    logger.info('Cleared all positions');
  }

  /**
   * Load state from file
   */
  private async loadState(): Promise<void> {
    try {
      const data = await fs.readFile(this.stateFilePath, 'utf-8');

      // Add validation before parsing
      let state: {
        userPositions?: unknown;
        targetPositions?: unknown;
        processedTradeIds?: unknown;
      };
      try {
        state = JSON.parse(data);
      } catch (parseError) {
        logger.error(
          {
            error: parseError instanceof Error ? parseError.message : String(parseError),
            fileLength: data.length,
            preview: data.substring(0, 100),
          },
          'Failed to parse state file - corrupted JSON. Starting fresh.'
        );
        // Don't throw - start fresh instead
        return;
      }

      // Restore user positions
      if (state.userPositions) {
        this.userPositions = new Map(Object.entries(state.userPositions));
      }

      // Restore target positions
      if (state.targetPositions) {
        this.targetPositions = new Map(Object.entries(state.targetPositions));
      }

      // Restore processed trade IDs
      if (state.processedTradeIds && Array.isArray(state.processedTradeIds)) {
        this.processedTradeIds = new Set(state.processedTradeIds);
      }

      logger.info(
        {
          userPositions: this.userPositions.size,
          targetPositions: this.targetPositions.size,
        },
        'Loaded persisted state'
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
      // File doesn't exist yet, that's okay
    }
  }

  /**
   * Save state to file with retry logic
   */
  private async saveStateWithRetry(maxRetries = 3): Promise<void> {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        await this.saveState();
        return;
      } catch (error) {
        logger.warn(
          {
            attempt,
            maxRetries,
            error: error instanceof Error ? error.message : String(error),
          },
          'Failed to save state, retrying...'
        );

        if (attempt === maxRetries) {
          throw error;
        }

        // Exponential backoff: 1s, 2s, 4s
        await new Promise((resolve) => setTimeout(resolve, 2 ** (attempt - 1) * 1000));
      }
    }
  }

  /**
   * Save state to file
   */
  private async saveState(): Promise<void> {
    try {
      const state = {
        userPositions: Object.fromEntries(this.userPositions),
        targetPositions: Object.fromEntries(this.targetPositions),
        processedTradeIds: Array.from(this.processedTradeIds),
        lastSaved: Date.now(),
      };

      // Ensure directory exists
      const dir = path.dirname(this.stateFilePath);
      await fs.mkdir(dir, { recursive: true });

      // Write state file
      await fs.writeFile(this.stateFilePath, JSON.stringify(state, null, 2), 'utf-8');

      logger.debug('Saved state to file');
    } catch (error) {
      logger.error(
        {
          error: error instanceof Error ? error.message : String(error),
        },
        'Failed to save state'
      );
      throw error;
    }
  }

  /**
   * Get summary statistics
   */
  getSummary() {
    const userPositionCount = this.userPositions.size;
    const targetPositionCount = this.targetPositions.size;

    const userTotalValue = Array.from(this.userPositions.values()).reduce(
      (sum, pos) => sum + pos.value,
      0
    );

    const targetTotalValue = Array.from(this.targetPositions.values()).reduce(
      (sum, pos) => sum + pos.value,
      0
    );

    return {
      userPositionCount,
      targetPositionCount,
      userTotalValue,
      targetTotalValue,
      processedTradeCount: this.processedTradeIds.size,
    };
  }
}
