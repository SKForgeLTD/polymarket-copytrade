/**
 * Type definitions for Polymarket CLOB API
 * Extends and clarifies the official @polymarket/clob-client types
 */

import type {
  OpenOrder as ClobOpenOrder,
  OrderBookSummary as ClobOrderBookSummary,
  UserOrder,
} from '@polymarket/clob-client';
import type { OrderStatus } from './polymarket.js';

/**
 * Extended order response from CLOB API
 */
export interface ClobOrderResponse {
  orderID: string;
  status: OrderStatus;
  transactionHash?: string;
  error?: string;
}

/**
 * Open order details from CLOB API
 * Re-export from official client for type compatibility
 */
export type OpenOrder = ClobOpenOrder;

/**
 * Order book response
 * Re-export from official client for type compatibility
 */
export type OrderBook = ClobOrderBookSummary;

/**
 * Order book entry extracted from summary
 */
export interface OrderBookEntry {
  price: string;
  size: string;
}

/**
 * CLOB API credentials
 */
export interface ClobApiCredentials {
  key: string;
  secret: string;
  passphrase: string;
}

/**
 * Order creation parameters for CLOB API
 * Compatible with UserOrder from official client
 */
export type ClobOrderParams = UserOrder;

/**
 * Order cancellation parameters
 */
export interface ClobCancelParams {
  orderID: string;
}
