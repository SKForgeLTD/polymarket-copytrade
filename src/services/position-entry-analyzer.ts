import type { PolymarketClobClient } from '../clients/clob-client.js';
import type { Config } from '../config/index.js';
import { createChildLogger } from '../logger/index.js';
import type { Position } from '../types/polymarket.js';
import { Side } from '../types/polymarket.js';
import type {
  DEFAULT_ENTRY_CONFIG,
  EntryOpportunity,
  EntryOpportunityConfig,
  PositionComparison,
  SyncAnalysis,
} from '../types/position-entry.js';

const logger = createChildLogger({ module: 'PositionEntryAnalyzer' });

/**
 * Analyzes target trader's existing positions and finds opportunities
 * for better entry prices when they already have positions open
 */
export class PositionEntryAnalyzer {
  private config: Config;
  private clobClient: PolymarketClobClient;
  private entryConfig: EntryOpportunityConfig;

  constructor(
    config: Config,
    clobClient: PolymarketClobClient,
    entryConfig: typeof DEFAULT_ENTRY_CONFIG
  ) {
    this.config = config;
    this.clobClient = clobClient;
    this.entryConfig = entryConfig;
  }

  /**
   * Analyze all positions and find entry opportunities
   */
  async analyzeSyncOpportunities(
    targetPositions: Position[],
    userPositions: Position[]
  ): Promise<SyncAnalysis> {
    logger.info(
      {
        targetPositions: targetPositions.length,
        userPositions: userPositions.length,
      },
      'Analyzing sync opportunities'
    );

    const comparisons: PositionComparison[] = [];
    const opportunities: EntryOpportunity[] = [];
    const positionsToClose: string[] = [];
    const positionsToOpen: string[] = [];

    // Create maps for quick lookup
    const targetMap = new Map(targetPositions.map((p) => [p.tokenId, p]));
    const userMap = new Map(userPositions.map((p) => [p.tokenId, p]));

    // Get all unique token IDs
    const allTokenIds = new Set([
      ...targetPositions.map((p) => p.tokenId),
      ...userPositions.map((p) => p.tokenId),
    ]);

    // Analyze each position
    for (const tokenId of allTokenIds) {
      const targetPos = targetMap.get(tokenId) ?? null;
      const userPos = userMap.get(tokenId) ?? null;

      const comparison = await this.comparePositions(tokenId, targetPos, userPos);
      comparisons.push(comparison);

      // Check for entry opportunity
      if (comparison.hasBetterEntry && targetPos) {
        const opportunity = await this.evaluateEntryOpportunity(targetPos, userPos);
        if (opportunity.shouldEnter) {
          opportunities.push(opportunity);
        }
      }

      // Track positions to close/open
      if (!targetPos && userPos) {
        positionsToClose.push(tokenId);
      } else if (targetPos && !userPos) {
        positionsToOpen.push(tokenId);
      }
    }

    const totalPotentialSavings = opportunities.reduce(
      (sum, opp) => sum + (opp.potentialSavings ?? 0),
      0
    );

    const analysis: SyncAnalysis = {
      opportunities,
      comparisons,
      totalPotentialSavings,
      positionsToClose,
      positionsToOpen,
    };

    logger.info(
      {
        opportunitiesFound: opportunities.length,
        totalSavings: totalPotentialSavings.toFixed(2),
        positionsToClose: positionsToClose.length,
        positionsToOpen: positionsToOpen.length,
      },
      'Sync analysis complete'
    );

    return analysis;
  }

  /**
   * Compare a position between target and user
   */
  private async comparePositions(
    tokenId: string,
    targetPosition: Position | null,
    userPosition: Position | null
  ): Promise<PositionComparison> {
    let priceDiscrepancy = 0;
    let sizeDelta = 0;
    let hasBetterEntry = false;

    if (targetPosition && userPosition) {
      // Both have position - compare prices
      priceDiscrepancy =
        ((targetPosition.avgPrice - userPosition.avgPrice) / targetPosition.avgPrice) * 100;
      sizeDelta = Math.abs(targetPosition.size - userPosition.size);
    } else if (targetPosition) {
      // Target has position, we don't
      sizeDelta = targetPosition.size;
    } else if (userPosition) {
      // We have position, target doesn't
      sizeDelta = userPosition.size;
    }

    // Check if we can enter at a better price than target
    if (targetPosition) {
      const currentPrices = await this.clobClient.getBestPrices(tokenId);
      if (currentPrices) {
        const currentPrice =
          targetPosition.side === Side.BUY ? currentPrices.ask : currentPrices.bid;
        const potentialSavingsPercent =
          ((targetPosition.avgPrice - currentPrice) / targetPosition.avgPrice) * 100;

        if (potentialSavingsPercent > this.entryConfig.minSavingsPercent) {
          hasBetterEntry = true;
        }
      }
    }

    return {
      tokenId,
      market: targetPosition?.market ?? userPosition?.market ?? 'Unknown',
      targetPosition,
      userPosition,
      priceDiscrepancy,
      sizeDelta,
      hasBetterEntry,
    };
  }

  /**
   * Evaluate whether we should enter a position at current price
   */
  private async evaluateEntryOpportunity(
    targetPosition: Position,
    userPosition: Position | null
  ): Promise<EntryOpportunity> {
    const currentPrices = await this.clobClient.getBestPrices(targetPosition.tokenId);

    if (!currentPrices) {
      return {
        shouldEnter: false,
        reason: 'Unable to get current market prices',
        tokenId: targetPosition.tokenId,
        side: targetPosition.side,
        targetCostBasis: targetPosition.avgPrice,
        currentMarketPrice: 0,
        recommendedSize: 0,
      };
    }

    const currentPrice = targetPosition.side === Side.BUY ? currentPrices.ask : currentPrices.bid;

    // Calculate potential savings
    const potentialSavings = (targetPosition.avgPrice - currentPrice) * targetPosition.size;
    const potentialSavingsPercent =
      ((targetPosition.avgPrice - currentPrice) / targetPosition.avgPrice) * 100;

    // Check if savings meet threshold
    if (potentialSavingsPercent < this.entryConfig.minSavingsPercent) {
      return {
        shouldEnter: false,
        reason: `Savings ${potentialSavingsPercent.toFixed(2)}% below threshold ${this.entryConfig.minSavingsPercent}%`,
        tokenId: targetPosition.tokenId,
        side: targetPosition.side,
        targetCostBasis: targetPosition.avgPrice,
        currentMarketPrice: currentPrice,
        potentialSavings,
        potentialSavingsPercent,
        recommendedSize: 0,
      };
    }

    // Calculate recommended size
    const proportionalSize = targetPosition.value * this.config.trading.copyRatio;
    const recommendedSize = Math.min(proportionalSize, this.config.trading.maxPositionSizeUsd);

    // Check minimum position size
    if (recommendedSize < this.entryConfig.minPositionSizeUsd) {
      return {
        shouldEnter: false,
        reason: `Position size $${recommendedSize.toFixed(2)} below minimum $${this.entryConfig.minPositionSizeUsd}`,
        tokenId: targetPosition.tokenId,
        side: targetPosition.side,
        targetCostBasis: targetPosition.avgPrice,
        currentMarketPrice: currentPrice,
        potentialSavings,
        potentialSavingsPercent,
        recommendedSize: 0,
      };
    }

    // Check if we already have a position
    if (userPosition) {
      // Already have position - calculate if we should add more
      const additionalSize = proportionalSize / currentPrice - userPosition.size;

      if (additionalSize < this.entryConfig.minPositionSizeUsd / currentPrice) {
        return {
          shouldEnter: false,
          reason: 'Already have sufficient position size',
          tokenId: targetPosition.tokenId,
          side: targetPosition.side,
          targetCostBasis: targetPosition.avgPrice,
          currentMarketPrice: currentPrice,
          potentialSavings,
          potentialSavingsPercent,
          recommendedSize: 0,
        };
      }
    }

    logger.info(
      {
        tokenId: targetPosition.tokenId,
        targetCostBasis: targetPosition.avgPrice,
        currentPrice,
        savingsPercent: potentialSavingsPercent.toFixed(2),
        savingsUsd: potentialSavings.toFixed(2),
        recommendedSize: recommendedSize.toFixed(2),
      },
      '✅ Entry opportunity found'
    );

    return {
      shouldEnter: true,
      reason: `Can enter ${potentialSavingsPercent.toFixed(2)}% cheaper than target's cost basis`,
      tokenId: targetPosition.tokenId,
      side: targetPosition.side,
      targetCostBasis: targetPosition.avgPrice,
      currentMarketPrice: currentPrice,
      potentialSavings,
      potentialSavingsPercent,
      recommendedSize,
    };
  }

  /**
   * Get summary of entry opportunities
   */
  formatOpportunitiesSummary(analysis: SyncAnalysis): string {
    if (analysis.opportunities.length === 0) {
      return 'No entry opportunities found at this time.';
    }

    const lines: string[] = [
      '\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
      '📈 ENTRY OPPORTUNITIES',
      '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
    ];

    for (const opp of analysis.opportunities) {
      lines.push(
        `\nToken: ${(opp.tokenId || 'unknown').substring(0, 10)}...`,
        `Side: ${opp.side}`,
        `Target Cost: $${opp.targetCostBasis.toFixed(4)}`,
        `Current Price: $${opp.currentMarketPrice.toFixed(4)}`,
        `Savings: ${opp.potentialSavingsPercent?.toFixed(2)}% ($${opp.potentialSavings?.toFixed(2)})`,
        `Recommended Size: $${opp.recommendedSize.toFixed(2)}`,
        `Reason: ${opp.reason}`
      );
    }

    lines.push(
      '\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
      `Total Potential Savings: $${analysis.totalPotentialSavings.toFixed(2)}`,
      '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n'
    );

    return lines.join('\n');
  }
}
