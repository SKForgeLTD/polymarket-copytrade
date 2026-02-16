/**
 * Type definitions for order fill tracking and confirmation
 */

/**
 * Order fill confirmation result
 */
export interface OrderFillResult {
  status: 'MATCHED' | 'CANCELLED' | 'EXPIRED' | 'TIMEOUT';
  filledSize?: number;
  filledPrice?: number;
  attempts: number;
  timeMs: number;
}

/**
 * Order polling configuration
 */
export interface OrderPollConfig {
  timeoutMs: number;
  pollIntervalMs: number;
  maxAttempts?: number;
}

/**
 * Default polling configuration
 */
export const DEFAULT_POLL_CONFIG: OrderPollConfig = {
  timeoutMs: 60000, // 60 seconds
  pollIntervalMs: 2000, // 2 seconds
  maxAttempts: 30, // 30 attempts = 60 seconds
} as const;
