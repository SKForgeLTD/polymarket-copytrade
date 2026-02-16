import type { Trade } from '../types/polymarket.js';

/**
 * Get a readable market name from a trade
 * Uses title/slug if available, otherwise shows shortened hex ID
 */
export function getReadableMarketName(trade: Trade): string {
  return (
    trade.title ||
    trade.slug ||
    `${trade.conditionId.substring(0, 6)}...${trade.conditionId.substring(trade.conditionId.length - 4)}`
  );
}

/**
 * Create standardized trade log object
 */
export function getTradeLogObject(trade: Trade) {
  const tradeValue = Number(trade.size) * Number(trade.price);
  return {
    market: getReadableMarketName(trade),
    outcome: trade.outcome,
    side: trade.side,
    size: Number(trade.size).toFixed(2),
    price: Number(trade.price).toFixed(4),
    value: `$${tradeValue.toFixed(2)}`,
  };
}
