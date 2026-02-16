import { Side } from '@polymarket/clob-client';
import type { Config } from '../config/index.js';
import { createChildLogger } from '../logger/index.js';
import type { Position, PositionDelta } from '../types/polymarket.js';

const logger = createChildLogger({ module: 'PositionCalculator' });

/**
 * Calculate proportional position sizes and trade requirements
 */
export class PositionCalculator {
  private config: Config;

  constructor(config: Config) {
    this.config = config;
  }

  /**
   * Calculate the size we should trade based on target trader's trade
   */
  calculateCopySize(targetTradeSize: number, availableBalance: number): number {
    // Calculate proportional size based on copy ratio
    const proportionalSize = targetTradeSize * this.config.trading.copyRatio;

    // Ensure we don't exceed max position size
    const cappedSize = Math.min(proportionalSize, this.config.trading.maxPositionSizeUsd);

    // Ensure we don't exceed available balance
    const affordableSize = Math.min(cappedSize, availableBalance);

    // Check minimum trade size
    if (affordableSize < this.config.trading.minTradeSizeUsd) {
      logger.warn(
        {
          targetTradeSize,
          proportionalSize,
          affordableSize,
          minTradeSize: this.config.trading.minTradeSizeUsd,
        },
        'Calculated size below minimum trade threshold'
      );
      return 0;
    }

    logger.debug(
      {
        targetTradeSize,
        proportionalSize,
        cappedSize,
        affordableSize,
        copyRatio: this.config.trading.copyRatio,
      },
      'Calculated copy size'
    );

    return affordableSize;
  }

  /**
   * Calculate position delta - what needs to be traded to match target
   */
  calculatePositionDelta(
    targetPosition: Position | null,
    currentPosition: Position | null
  ): PositionDelta | null {
    // If no target position, and we have a position, we should close it
    if (!targetPosition && currentPosition) {
      return {
        tokenId: currentPosition.tokenId,
        market: currentPosition.market,
        outcome: currentPosition.outcome,
        side: currentPosition.side === Side.BUY ? Side.SELL : Side.BUY, // Opposite side to close
        targetSize: 0,
        currentSize: currentPosition.size,
        deltaSize: currentPosition.size,
        estimatedPrice: currentPosition.avgPrice,
      };
    }

    // If target has position but we don't, open new position
    if (targetPosition && !currentPosition) {
      const copySize = this.calculateCopySize(targetPosition.value, Infinity);

      if (copySize === 0) {
        return null;
      }

      return {
        tokenId: targetPosition.tokenId,
        market: targetPosition.market,
        outcome: targetPosition.outcome,
        side: targetPosition.side,
        targetSize: copySize / targetPosition.avgPrice, // Convert USD to size
        currentSize: 0,
        deltaSize: copySize / targetPosition.avgPrice,
        estimatedPrice: targetPosition.avgPrice,
      };
    }

    // Both have positions - calculate adjustment needed
    if (targetPosition && currentPosition) {
      // Calculate proportional target size
      const targetValue = targetPosition.value * this.config.trading.copyRatio;
      const targetSize = targetValue / currentPosition.avgPrice;

      const deltaSize = Math.abs(targetSize - currentPosition.size);

      // If delta is too small, skip
      if (deltaSize * currentPosition.avgPrice < this.config.trading.minTradeSizeUsd) {
        logger.debug(
          {
            tokenId: currentPosition.tokenId,
            deltaSize,
            deltaValue: deltaSize * currentPosition.avgPrice,
            minTradeSize: this.config.trading.minTradeSizeUsd,
          },
          'Position delta below minimum trade threshold'
        );
        return null;
      }

      const side = targetSize > currentPosition.size ? Side.BUY : Side.SELL;

      return {
        tokenId: currentPosition.tokenId,
        market: currentPosition.market,
        outcome: currentPosition.outcome,
        side,
        targetSize,
        currentSize: currentPosition.size,
        deltaSize,
        estimatedPrice: currentPosition.avgPrice,
      };
    }

    return null;
  }

  /**
   * Calculate total portfolio exposure
   */
  calculatePortfolioExposure(positions: Position[], balance: number): number {
    const totalValue = positions.reduce((sum, pos) => sum + pos.value, 0);
    const totalPortfolio = balance + totalValue;

    if (totalPortfolio === 0) {
      return 0;
    }

    return totalValue / totalPortfolio;
  }

  /**
   * Check if adding a position would exceed portfolio exposure limit
   */
  wouldExceedExposureLimit(
    positions: Position[],
    balance: number,
    newPositionValue: number
  ): boolean {
    const currentTotalValue = positions.reduce((sum, pos) => sum + pos.value, 0);
    const newTotalValue = currentTotalValue + newPositionValue;
    const totalPortfolio = balance + currentTotalValue;

    if (totalPortfolio === 0) {
      return false;
    }

    const newExposure = newTotalValue / totalPortfolio;
    const exceeds = newExposure > this.config.trading.maxPortfolioExposure;

    if (exceeds) {
      logger.warn(
        {
          currentExposure: currentTotalValue / totalPortfolio,
          newExposure,
          maxExposure: this.config.trading.maxPortfolioExposure,
          newPositionValue,
        },
        'New position would exceed portfolio exposure limit'
      );
    }

    return exceeds;
  }

  /**
   * Round size to valid tick size (typically 0.01)
   */
  roundToTickSize(size: number, tickSize = 0.01): number {
    return Math.round(size / tickSize) * tickSize;
  }

  /**
   * Round price to valid tick size (typically 0.001 or 0.01)
   */
  roundPrice(price: number, tickSize = 0.01): number {
    return Math.round(price / tickSize) * tickSize;
  }

  /**
   * Calculate slippage-adjusted price
   */
  calculateSlippagePrice(basePrice: number, side: Side, slippageBps = 50): number {
    const slippageMultiplier = slippageBps / 10000;

    if (side === Side.BUY) {
      // For buys, increase price (willing to pay more)
      return Math.min(basePrice * (1 + slippageMultiplier), 0.99);
    } else {
      // For sells, decrease price (willing to accept less)
      return Math.max(basePrice * (1 - slippageMultiplier), 0.01);
    }
  }
}
