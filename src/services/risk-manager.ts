import type { Config } from '../config/index.js';
import { createChildLogger } from '../logger/index.js';
import type { CircuitBreakerState, Position, RiskCheckResult } from '../types/polymarket.js';
import { Side } from '../types/polymarket.js';

const logger = createChildLogger({ module: 'RiskManager' });

/**
 * Risk management and safety checks for trading
 */
export class RiskManager {
  private config: Config;
  private circuitBreaker: CircuitBreakerState;
  private lastTradeTime = 0;

  constructor(config: Config) {
    this.config = config;
    this.circuitBreaker = {
      isTripped: false,
      consecutiveFailures: 0,
    };
  }

  /**
   * Pre-trade validation checks
   */
  async validateTrade(
    tokenId: string,
    side: Side,
    size: number,
    price: number,
    balance: number,
    positions: Position[]
  ): Promise<RiskCheckResult> {
    // Check if circuit breaker is active
    if (this.circuitBreaker.isTripped) {
      const now = Date.now();
      if (this.circuitBreaker.cooldownEndsAt && now < this.circuitBreaker.cooldownEndsAt) {
        const remainingSeconds = Math.ceil((this.circuitBreaker.cooldownEndsAt - now) / 1000);
        return {
          passed: false,
          reason: `Circuit breaker active. Cooldown ends in ${remainingSeconds}s`,
        };
      } else {
        // Cooldown expired, reset circuit breaker
        this.resetCircuitBreaker();
      }
    }

    // Check trade cooldown
    const now = Date.now();
    const timeSinceLastTrade = now - this.lastTradeTime;
    if (timeSinceLastTrade < this.config.risk.tradeCooldownMs) {
      return {
        passed: false,
        reason: `Trade cooldown active. Wait ${Math.ceil((this.config.risk.tradeCooldownMs - timeSinceLastTrade) / 1000)}s`,
      };
    }

    // Check sufficient balance
    const tradeValue = size * price;
    if (side === Side.BUY && tradeValue > balance) {
      return {
        passed: false,
        reason: `Insufficient balance. Required: $${tradeValue.toFixed(2)}, Available: $${balance.toFixed(2)}`,
        suggestions: [
          'Reduce copy ratio',
          'Increase account balance',
          'Wait for other positions to close',
        ],
      };
    }

    // Check minimum trade size
    if (tradeValue < this.config.trading.minTradeSizeUsd) {
      return {
        passed: false,
        reason: `Trade value $${tradeValue.toFixed(2)} below minimum $${this.config.trading.minTradeSizeUsd}`,
      };
    }

    // Check maximum position size
    if (tradeValue > this.config.trading.maxPositionSizeUsd) {
      return {
        passed: false,
        reason: `Trade value $${tradeValue.toFixed(2)} exceeds maximum $${this.config.trading.maxPositionSizeUsd}`,
        suggestions: ['Reduce copy ratio', 'Increase max position size limit'],
      };
    }

    // Check portfolio exposure for BUY orders
    if (side === Side.BUY) {
      const totalValue = positions.reduce((sum, pos) => sum + pos.value, 0);
      const newTotalValue = totalValue + tradeValue;
      const totalPortfolio = balance + totalValue;
      const newExposure = totalPortfolio > 0 ? newTotalValue / totalPortfolio : 0;

      if (newExposure > this.config.trading.maxPortfolioExposure) {
        return {
          passed: false,
          reason: `New exposure ${(newExposure * 100).toFixed(1)}% exceeds limit ${(this.config.trading.maxPortfolioExposure * 100).toFixed(1)}%`,
          suggestions: [
            'Close some existing positions',
            'Increase portfolio balance',
            'Increase max exposure limit',
          ],
        };
      }
    }

    // Check price reasonableness (between 0.01 and 0.99)
    if (price < 0.01 || price > 0.99) {
      return {
        passed: false,
        reason: `Price ${price} outside reasonable range [0.01, 0.99]`,
      };
    }

    // Check size reasonableness (must be positive)
    if (size <= 0) {
      return {
        passed: false,
        reason: `Invalid size: ${size}`,
      };
    }

    logger.debug(
      {
        tokenId,
        side,
        size,
        price,
        tradeValue,
        balance,
      },
      'Trade validation passed'
    );

    return { passed: true };
  }

  /**
   * Record successful trade
   */
  recordSuccess(): void {
    this.circuitBreaker.consecutiveFailures = 0;
    this.lastTradeTime = Date.now();

    logger.debug('Recorded successful trade');
  }

  /**
   * Record failed trade
   */
  recordFailure(): void {
    this.circuitBreaker.consecutiveFailures++;
    this.circuitBreaker.lastFailureTime = Date.now();

    logger.warn(
      {
        consecutiveFailures: this.circuitBreaker.consecutiveFailures,
        maxFailures: this.config.risk.maxConsecutiveFailures,
      },
      'Recorded trade failure'
    );

    // Check if we should trip the circuit breaker
    if (this.circuitBreaker.consecutiveFailures >= this.config.risk.maxConsecutiveFailures) {
      this.tripCircuitBreaker();
    }
  }

  /**
   * Trip the circuit breaker
   */
  private tripCircuitBreaker(): void {
    const cooldownMs = this.config.risk.circuitBreakerCooldownMinutes * 60 * 1000;
    this.circuitBreaker.isTripped = true;
    this.circuitBreaker.cooldownEndsAt = Date.now() + cooldownMs;

    logger.error(
      {
        consecutiveFailures: this.circuitBreaker.consecutiveFailures,
        cooldownMinutes: this.config.risk.circuitBreakerCooldownMinutes,
      },
      'CIRCUIT BREAKER TRIPPED - Trading paused'
    );
  }

  /**
   * Reset circuit breaker
   */
  private resetCircuitBreaker(): void {
    this.circuitBreaker = {
      isTripped: false,
      consecutiveFailures: 0,
    };

    logger.info('Circuit breaker reset - Trading resumed');
  }

  /**
   * Manually reset circuit breaker (for admin/testing)
   */
  forceResetCircuitBreaker(): void {
    this.resetCircuitBreaker();
  }

  /**
   * Get circuit breaker status
   */
  getCircuitBreakerStatus(): CircuitBreakerState {
    return { ...this.circuitBreaker };
  }

  /**
   * Check if trading is currently allowed
   */
  isTradingAllowed(): boolean {
    if (this.circuitBreaker.isTripped) {
      const now = Date.now();
      if (this.circuitBreaker.cooldownEndsAt && now >= this.circuitBreaker.cooldownEndsAt) {
        this.resetCircuitBreaker();
        return true;
      }
      return false;
    }
    return true;
  }

  /**
   * Get risk management summary
   */
  getSummary() {
    return {
      circuitBreaker: this.circuitBreaker,
      lastTradeTime: this.lastTradeTime,
      tradingAllowed: this.isTradingAllowed(),
    };
  }
}
