import type { PolymarketClobClient } from '../clients/clob-client.js';
import { createChildLogger } from '../logger/index.js';
import type { OrderFillResult, OrderPollConfig } from '../types/order-fill.js';
import { DEFAULT_POLL_CONFIG } from '../types/order-fill.js';
import type { OrderRequest, Trade, TradeExecutionResult } from '../types/polymarket.js';
import { Side } from '../types/polymarket.js';
import type { PositionCalculator } from './position-calculator.js';
import type { PositionManager } from './position-manager.js';
import type { RiskManager } from './risk-manager.js';

const logger = createChildLogger({ module: 'TradeExecutor' });

/**
 * Execute trades with retry logic and error handling
 */
export class TradeExecutor {
  private clobClient: PolymarketClobClient;
  private riskManager: RiskManager;
  private positionManager: PositionManager;
  private positionCalculator: PositionCalculator;

  constructor(
    clobClient: PolymarketClobClient,
    riskManager: RiskManager,
    positionManager: PositionManager,
    positionCalculator: PositionCalculator
  ) {
    this.clobClient = clobClient;
    this.riskManager = riskManager;
    this.positionManager = positionManager;
    this.positionCalculator = positionCalculator;
  }

  /**
   * Execute a copy trade based on target trader's trade
   */
  async executeCopyTrade(targetTrade: Trade): Promise<TradeExecutionResult> {
    const startTime = Date.now();

    try {
      // Check if trading is allowed
      if (!this.riskManager.isTradingAllowed()) {
        logger.warn('Trading not allowed due to circuit breaker');
        return {
          success: false,
          error: 'Circuit breaker active' as string | undefined,
          timestamp: startTime,
        } as TradeExecutionResult;
      }

      // Smart copying: Check if we should copy this trade based on side
      const shouldCopy = await this.shouldCopyTrade(targetTrade);
      if (!shouldCopy.copy) {
        // Check if market is closed (don't count as failure)
        const isMarketClosed = (shouldCopy as any).isMarketClosed === true;

        logger.info(
          {
            tradeHash: targetTrade.transactionHash,
            side: targetTrade.side,
            reason: shouldCopy.reason,
            marketClosed: isMarketClosed,
          },
          isMarketClosed ? '⏭️  Skipping trade - market closed' : '⏭️  Skipping trade - not favorable'
        );

        const result: TradeExecutionResult = {
          success: false,
          timestamp: startTime,
          skipped: isMarketClosed, // Flag as skipped (not failed) if market closed
        };
        if (shouldCopy.reason) {
          result.error = shouldCopy.reason;
        }
        return result;
      }

      // Get current balance (cached in ClobClient)
      const balance = await this.clobClient.getBalance();

      // Get best prices for the market
      const prices = await this.clobClient.getBestPrices(targetTrade.asset);
      if (!prices) {
        logger.warn(
          { tokenId: targetTrade.asset },
          'No order book available - cannot execute trade (market may be closed)'
        );
        return {
          success: false,
          error: 'No order book available',
          timestamp: startTime,
          skipped: true, // Market closed, not a failure
        };
      }

      // Determine our side and price
      const side = targetTrade.side;
      const basePrice = side === Side.BUY ? prices.ask : prices.bid;

      if (!basePrice || basePrice === 0) {
        logger.error({ side, prices }, 'No liquidity available on required side');
        this.riskManager.recordFailure();
        return {
          success: false,
          error: 'No liquidity available',
          timestamp: startTime,
        };
      }

      // Calculate copy size
      const targetTradeValue = Number(targetTrade.size) * Number(targetTrade.price);
      const copySize = this.positionCalculator.calculateCopySize(targetTradeValue, balance);

      if (copySize === 0) {
        logger.info('Copy size too small, skipping trade');
        return {
          success: false,
          error: 'Copy size below minimum',
          timestamp: startTime,
        };
      }

      // Convert USD value to size (shares)
      const size = copySize / basePrice;
      const roundedSize = this.positionCalculator.roundToTickSize(size);

      // Calculate slippage-adjusted price
      const executionPrice = this.positionCalculator.calculateSlippagePrice(
        basePrice,
        side,
        50 // 0.5% slippage tolerance
      );
      const roundedPrice = this.positionCalculator.roundPrice(executionPrice);

      // Validate trade with risk manager
      const positions = this.positionManager.getAllUserPositions();
      const validation = await this.riskManager.validateTrade(
        targetTrade.asset,
        side,
        roundedSize,
        roundedPrice,
        balance,
        positions
      );

      if (!validation.passed) {
        logger.warn(
          {
            reason: validation.reason,
            suggestions: validation.suggestions,
          },
          'Trade validation failed'
        );
        return {
          success: false,
          error: validation.reason as string | undefined,
          timestamp: startTime,
        } as TradeExecutionResult;
      }

      // Execute order
      logger.info(
        {
          tokenId: targetTrade.asset,
          side,
          size: roundedSize,
          price: roundedPrice,
          estimatedValue: roundedSize * roundedPrice,
        },
        'Executing copy trade'
      );

      const orderRequest: OrderRequest = {
        tokenID: targetTrade.asset,
        price: roundedPrice,
        size: roundedSize,
        side,
        orderType: 'GTC',
      };

      const orderResponse = await this.clobClient.createOrder(orderRequest);

      // Record successful trade immediately (optimistic)
      this.riskManager.recordSuccess();

      // Update position immediately (optimistic - assumes order will fill)
      const executedTrade: Trade = {
        proxyWallet: this.clobClient.getAddress(),
        side,
        asset: targetTrade.asset,
        conditionId: targetTrade.conditionId,
        size: String(roundedSize),
        price: String(roundedPrice),
        timestamp: Date.now(),
        transactionHash: orderResponse.orderID, // Use orderID as identifier until filled
      };

      this.positionManager.updatePosition(executedTrade, true);

      const executionTime = Date.now() - startTime;

      logger.info(
        {
          orderId: orderResponse.orderID,
          executedSize: roundedSize,
          executedPrice: roundedPrice,
          executedValue: roundedSize * roundedPrice,
          executionTime,
        },
        '⚡ Copy trade submitted (async - not waiting for fill)'
      );

      // Start background monitoring for order fill (fire-and-forget)
      this.monitorOrderFillAsync(orderResponse.orderID, executedTrade).catch((error) => {
        logger.warn(
          {
            orderId: orderResponse.orderID,
            error: error instanceof Error ? error.message : String(error),
          },
          'Background order monitoring failed (non-critical)'
        );
      });

      return {
        success: true,
        orderId: orderResponse.orderID,
        transactionHash: orderResponse.transactionHash ?? undefined,
        executedSize: roundedSize,
        executedPrice: roundedPrice,
        timestamp: startTime,
      } as TradeExecutionResult;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      const isInsufficientBalance =
        errorMessage.toLowerCase().includes('insufficient balance') ||
        errorMessage.toLowerCase().includes('insufficient funds');

      // Log based on error type
      if (isInsufficientBalance) {
        logger.warn(
          {
            error: errorMessage,
            targetTrade,
          },
          '💰 Insufficient balance to execute copy trade (skipping)'
        );
        // Don't record as failure - this is expected during high-frequency trading
      } else {
        logger.error(
          {
            error: errorMessage,
            targetTrade,
          },
          '❌ Failed to execute copy trade'
        );
        this.riskManager.recordFailure();
      }

      return {
        success: false,
        error: errorMessage as string | undefined,
        timestamp: startTime,
      } as TradeExecutionResult;
    }
  }

  /**
   * Execute a manual trade (for testing or manual intervention)
   */
  async executeManualTrade(
    tokenId: string,
    side: Side,
    size: number,
    price: number
  ): Promise<TradeExecutionResult> {
    const startTime = Date.now();

    try {
      logger.info(
        {
          tokenId,
          side,
          size,
          price,
        },
        'Executing manual trade'
      );

      const balance = await this.clobClient.getBalance();
      const positions = this.positionManager.getAllUserPositions();

      // Validate trade
      const validation = await this.riskManager.validateTrade(
        tokenId,
        side,
        size,
        price,
        balance,
        positions
      );

      if (!validation.passed) {
        logger.warn(
          {
            reason: validation.reason,
          },
          'Manual trade validation failed'
        );
        return {
          success: false,
          error: validation.reason as string | undefined,
          timestamp: startTime,
        } as TradeExecutionResult;
      }

      // Execute order
      const orderRequest: OrderRequest = {
        tokenID: tokenId,
        price,
        size,
        side,
        orderType: 'GTC',
      };

      const orderResponse = await this.clobClient.createOrder(orderRequest);

      this.riskManager.recordSuccess();

      logger.info(
        {
          orderId: orderResponse.orderID,
        },
        'Manual trade executed successfully'
      );

      const result: TradeExecutionResult = {
        success: true,
        orderId: orderResponse.orderID,
        executedSize: size,
        executedPrice: price,
        timestamp: startTime,
      };
      if (orderResponse.transactionHash) {
        result.transactionHash = orderResponse.transactionHash;
      }
      return result;
    } catch (error) {
      logger.error(
        {
          error: error instanceof Error ? error.message : String(error),
        },
        'Failed to execute manual trade'
      );

      this.riskManager.recordFailure();

      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
        timestamp: startTime,
      };
    }
  }

  /**
   * Determine if we should copy this trade based on side and price favorability
   */
  private async shouldCopyTrade(targetTrade: Trade): Promise<{ copy: boolean; reason?: string }> {
    const side = targetTrade.side;

    // SELL trades: Only copy if we have a position to sell
    if (side === Side.SELL) {
      const userPositions = this.positionManager.getAllUserPositions();
      const existingPosition = userPositions.find(
        (p) => p.tokenId === targetTrade.asset && p.side === Side.BUY
      );

      if (!existingPosition) {
        return {
          copy: false,
          reason: 'SELL trade but we have no position to exit',
        };
      }

      logger.info(
        {
          tokenId: targetTrade.asset,
          ourPosition: existingPosition.size.toFixed(2),
          ourCost: existingPosition.avgPrice.toFixed(4),
        },
        '✅ SELL trade confirmed - we have position to exit'
      );

      return { copy: true };
    }

    // BUY trades: Check price favorability
    const targetPositions = this.positionManager.getAllTargetPositions();
    const targetExistingPosition = targetPositions.find(
      (p) => p.tokenId === targetTrade.asset && p.side === Side.BUY
    );

    // If target has no existing position, this is their entry - copy it
    if (!targetExistingPosition) {
      logger.info(
        {
          tokenId: targetTrade.asset,
          tradePrice: Number(targetTrade.price).toFixed(4),
        },
        '✅ BUY trade - target entering new position'
      );
      return { copy: true };
    }

    // Target has existing position - check if current price is favorable
    const currentPrices = await this.clobClient.getBestPrices(targetTrade.asset);

    // Only skip if API returned null (true error or 404)
    if (!currentPrices) {
      logger.info(
        { tokenId: targetTrade.asset, market: targetTrade.conditionId },
        'Market order book unavailable (likely closed/settled) - skipping trade'
      );
      return {
        copy: false,
        reason: 'Market closed/settled (API returned no order book)',
      };
    }

    // Log current market state
    logger.debug(
      {
        tokenId: targetTrade.asset,
        bid: currentPrices.bid,
        ask: currentPrices.ask,
        targetCost: targetExistingPosition.avgPrice,
      },
      'Checking current market prices for BUY trade'
    );

    // If no ask orders (ask = 0), we can still place a bid order
    // The market isn't closed - there's just no sellers at this moment
    const currentPrice =
      currentPrices.ask > 0 ? currentPrices.ask : targetExistingPosition.avgPrice;
    const targetCost = targetExistingPosition.avgPrice;
    const maxAcceptablePrice = targetCost * 1.01; // Allow up to 1% worse price

    // If no asks available, place order at target's cost (will sit in book)
    if (currentPrices.ask === 0) {
      logger.info(
        {
          tokenId: targetTrade.asset,
          targetCost: targetCost.toFixed(4),
          hasBids: currentPrices.bid > 0,
        },
        '⚠️ No ask orders available - will place bid at target cost (may not fill immediately)'
      );
      return { copy: true };
    }

    // Copy if we can buy at same price or within 1% of target's average cost
    if (currentPrice <= maxAcceptablePrice) {
      const priceDeviation = ((currentPrice - targetCost) / targetCost) * 100;
      logger.info(
        {
          tokenId: targetTrade.asset,
          currentPrice: currentPrice.toFixed(4),
          targetCost: targetCost.toFixed(4),
          deviation: `${priceDeviation >= 0 ? '+' : ''}${priceDeviation.toFixed(2)}%`,
        },
        priceDeviation <= 0
          ? '✅ BUY trade - price favorable (at or below target cost)'
          : '✅ BUY trade - price acceptable (within 1% tolerance)'
      );
      return { copy: true };
    }

    // Price is more than 1% worse than target's cost - skip
    const priceDeviation = ((currentPrice - targetCost) / targetCost) * 100;
    logger.info(
      {
        tokenId: targetTrade.asset,
        currentPrice: currentPrice.toFixed(4),
        targetCost: targetCost.toFixed(4),
        maxAcceptable: maxAcceptablePrice.toFixed(4),
        deviation: `+${priceDeviation.toFixed(2)}%`,
      },
      '⏭️  Skipping BUY - price exceeds 1% tolerance'
    );

    return {
      copy: false,
      reason: `Current price $${currentPrice.toFixed(4)} > target cost $${targetCost.toFixed(4)}`,
    };
  }

  /**
   * Monitor order fill status in background (async/non-blocking)
   * Updates position status when order is filled
   */
  private async monitorOrderFillAsync(orderId: string, trade: Trade): Promise<void> {
    try {
      const result = await this.waitForOrderFill(orderId, {
        timeoutMs: 30000, // Shorter timeout for background monitoring
        pollIntervalMs: 3000,
      });

      if (result.status === 'MATCHED') {
        logger.info(
          {
            orderId,
            timeMs: result.timeMs,
            filledSize: result.filledSize,
            filledPrice: result.filledPrice,
          },
          '✅ Background: Order filled'
        );

        // Update position with actual fill data
        const updatedTrade: Trade = {
          ...trade,
          size: result.filledSize ? String(result.filledSize) : trade.size,
          price: result.filledPrice ? String(result.filledPrice) : trade.price,
        };
        this.positionManager.updatePosition(updatedTrade, true);
      } else {
        logger.warn(
          {
            orderId,
            status: result.status,
          },
          `⚠️ Background: Order not filled (${result.status})`
        );
      }
    } catch (error) {
      logger.warn(
        {
          orderId,
          error: error instanceof Error ? error.message : String(error),
        },
        'Background order monitoring error'
      );
    }
  }

  /**
   * Wait for an order to be filled
   *
   * Polls order status until it's matched, cancelled, or times out
   */
  private async waitForOrderFill(
    orderId: string,
    config: OrderPollConfig = DEFAULT_POLL_CONFIG
  ): Promise<OrderFillResult> {
    const startTime = Date.now();
    let attempts = 0;

    while (Date.now() - startTime < config.timeoutMs) {
      attempts++;

      try {
        const order = await this.clobClient.getOrder(orderId);

        logger.debug(
          {
            orderId,
            status: order.status,
            attempt: attempts,
          },
          'Polling order status'
        );

        // Check if order is in a final state
        if (order.status === 'MATCHED') {
          const timeMs = Date.now() - startTime;

          logger.info(
            {
              orderId,
              attempts,
              timeMs,
            },
            '✅ Order filled successfully'
          );

          const result: OrderFillResult = {
            status: 'MATCHED',
            attempts,
            timeMs,
          };

          // Conditionally add optional properties
          if (order.size_matched) {
            result.filledSize = Number(order.size_matched);
          }
          if (order.price) {
            result.filledPrice = Number(order.price);
          }

          return result;
        }

        if (order.status === 'CANCELLED') {
          return {
            status: 'CANCELLED',
            attempts,
            timeMs: Date.now() - startTime,
          };
        }

        if (order.status === 'EXPIRED') {
          return {
            status: 'EXPIRED',
            attempts,
            timeMs: Date.now() - startTime,
          };
        }

        // If order is still LIVE, wait and poll again
        await new Promise((resolve) => setTimeout(resolve, config.pollIntervalMs));
      } catch (error) {
        // For errors, log and retry (unless we hit max attempts)
        logger.warn(
          {
            orderId,
            attempt: attempts,
            error: error instanceof Error ? error.message : String(error),
          },
          'Error polling order status, will retry'
        );

        await new Promise((resolve) => setTimeout(resolve, config.pollIntervalMs));
      }
    }

    // Timeout reached
    return {
      status: 'TIMEOUT',
      attempts,
      timeMs: Date.now() - startTime,
    };
  }
}
