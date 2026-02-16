/**
 * Type definitions for Polymarket API responses and internal data structures
 */

import { Side } from '@polymarket/clob-client';

// Re-export Side from clob-client (API compatibility)
export { Side };

// Order status
export type OrderStatus = 'LIVE' | 'MATCHED' | 'CANCELLED' | 'EXPIRED';

// Order type
export type OrderType = 'GTC' | 'FOK' | 'GTD';

/**
 * Market information
 */
export interface Market {
  condition_id: string;
  question: string;
  tokens: Token[];
  min_price?: number;
  max_price?: number;
  active: boolean;
}

/**
 * Token (outcome) in a market
 */
export interface Token {
  token_id: string;
  outcome: string;
  price?: number;
  winner?: boolean;
}

/**
 * Trade from Data API or WebSocket (Real API format)
 * Uses actual field names from Polymarket APIs
 */
export interface Trade {
  // Core trade data (matches Data API and RTDS format)
  proxyWallet: string; // Trader's proxy wallet address
  side: Side; // BUY or SELL
  asset: string; // Token ID
  conditionId: string; // Market/condition ID
  size: string; // Trade size (kept as string for precision)
  price: string; // Trade price (kept as string for precision)
  timestamp: number; // Unix timestamp

  // Optional trade metadata
  outcome?: string; // Outcome name (e.g., "Yes", "No")
  outcomeIndex?: number; // Outcome position index
  transactionHash?: string; // Blockchain transaction hash

  // Market metadata (included in API responses)
  title?: string; // Market title
  slug?: string; // Market slug
  icon?: string; // Market icon URL
  eventSlug?: string; // Event slug

  // User metadata (from Data API)
  name?: string; // User display name
  pseudonym?: string; // Anonymous identifier
  bio?: string; // User biography
  profileImage?: string; // User avatar URL
  profileImageOptimized?: string; // Optimized avatar URL
}

/**
 * Order request parameters
 */
export interface OrderRequest {
  tokenID: string;
  price: number;
  size: number;
  side: Side;
  funderAddress?: string;
  orderType?: OrderType;
  expiration?: number;
}

/**
 * Order response
 */
export interface OrderResponse {
  orderID: string;
  status: OrderStatus;
  transactionHash?: string;
  error?: string;
}

/**
 * Position tracking
 */
export interface Position {
  tokenId: string;
  market: string;
  outcome: string;
  size: number;
  avgPrice: number;
  side: Side;
  value: number;
  unrealizedPnl?: number;
  lastUpdated: number;
}

/**
 * Balance information
 */
export interface Balance {
  total: number;
  available: number;
  locked: number;
}

/**
 * WebSocket trade message
 */
export interface TradeMessage {
  event_type: 'trade' | 'order' | 'tick';
  market: string;
  asset_id: string;
  maker: string;
  taker?: string;
  side: Side;
  size: string;
  price: string;
  timestamp: number;
  trade_id?: string;
}

/**
 * Risk check result
 */
export interface RiskCheckResult {
  passed: boolean;
  reason?: string;
  suggestions?: string[];
}

/**
 * Circuit breaker state
 */
export interface CircuitBreakerState {
  isTripped: boolean;
  consecutiveFailures: number;
  lastFailureTime?: number;
  cooldownEndsAt?: number;
}

/**
 * Trade execution result
 */
export interface TradeExecutionResult {
  success: boolean;
  orderId?: string;
  transactionHash?: string;
  executedSize?: number;
  executedPrice?: number;
  error?: string;
  timestamp: number;
  skipped?: boolean; // True if trade was skipped (not a failure - e.g., market closed)
}

/**
 * Position delta - what needs to be traded
 */
export interface PositionDelta {
  tokenId: string;
  market: string;
  outcome: string;
  side: Side;
  targetSize: number;
  currentSize: number;
  deltaSize: number;
  estimatedPrice?: number;
}
