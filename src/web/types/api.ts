/**
 * API response types for web interface
 */

import type { Position, Side } from '../../types/polymarket.js';

/**
 * Bot status response
 */
export interface BotStatusResponse {
  timestamp: number;
  bot: {
    isRunning: boolean;
    uptime: number;
  };
  balance: {
    total: number;
    available: number;
    inPositions: number;
  };
  positions: {
    user: {
      count: number;
      totalValue: number;
      positions: Position[];
    };
    target: {
      count: number;
      totalValue: number;
      positions: Position[];
    };
  };
  risk: {
    circuitBreaker: {
      isTripped: boolean;
      consecutiveFailures: number;
      cooldownEndsAt?: number;
    };
    tradingAllowed: boolean;
    exposure: number;
  };
  monitoring: {
    isActive: boolean;
    websocketConnected: boolean;
    targetAddress: string;
  };
  performance: {
    queue: {
      length: number;
      processing: number;
      maxSize: number;
    };
    metrics: {
      tradesQueued: number;
      tradesProcessed: number;
      tradesSkipped: number;
      tradesFailed: number;
      successRate: number;
    };
    latency: {
      min: number;
      max: number;
      avg: number;
    };
  };
}

/**
 * Trade history entry types
 */
export type TradeHistoryType = 'target_detected' | 'copy_executed' | 'copy_failed';

/**
 * Trade history entry
 */
export interface TradeHistoryEntry {
  id: string;
  timestamp: number;
  type: TradeHistoryType;
  market: string;
  side: Side;
  size: number;
  price: number;
  value: number;
  orderId?: string;
  error?: string;
  latencyMs?: number;
  // Market metadata
  title?: string;
  slug?: string;
  icon?: string;
  outcome?: string;
}

/**
 * Recent trades response
 */
export interface RecentTradesResponse {
  trades: TradeHistoryEntry[];
}

/**
 * SSE event types
 */
export type SSEEventType =
  | 'status_update'
  | 'trade_detected'
  | 'trade_executed'
  | 'trade_failed'
  | 'circuit_breaker'
  | 'connection_status'
  | 'uptime';

/**
 * SSE event data
 */
export interface SSEEvent {
  type: SSEEventType;
  timestamp: number;
  data: unknown;
}
