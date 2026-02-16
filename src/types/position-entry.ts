/**
 * Type definitions for position entry analysis and decision making
 */

import type { Position, Side } from './polymarket.js';

/**
 * Entry opportunity analysis result
 */
export interface EntryOpportunity {
  shouldEnter: boolean;
  reason: string;
  tokenId: string;
  side: Side;
  targetCostBasis: number;
  currentMarketPrice: number;
  potentialSavings?: number;
  potentialSavingsPercent?: number;
  recommendedSize: number;
}

/**
 * Position comparison between target and user
 */
export interface PositionComparison {
  tokenId: string;
  market: string;
  targetPosition: Position | null;
  userPosition: Position | null;
  priceDiscrepancy: number; // Percentage difference
  sizeDelta: number; // How much size difference
  hasBetterEntry: boolean; // Can we enter cheaper than target?
}

/**
 * Sync analysis result
 */
export interface SyncAnalysis {
  opportunities: EntryOpportunity[];
  comparisons: PositionComparison[];
  totalPotentialSavings: number;
  positionsToClose: string[]; // Token IDs where target has closed but we haven't
  positionsToOpen: string[]; // Token IDs where target has opened but we haven't
}

/**
 * Configuration for entry opportunity detection
 */
export interface EntryOpportunityConfig {
  minSavingsPercent: number; // Minimum % savings to consider entry
  maxSlippagePercent: number; // Maximum slippage tolerance
  minPositionSizeUsd: number; // Minimum position size to bother with
}

/**
 * Default entry opportunity configuration
 */
export const DEFAULT_ENTRY_CONFIG: EntryOpportunityConfig = {
  minSavingsPercent: 2.0, // 2% minimum savings
  maxSlippagePercent: 1.0, // 1% max slippage
  minPositionSizeUsd: 1.0, // $1 minimum
} as const;
