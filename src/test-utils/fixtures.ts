/**
 * Test fixtures and helper functions for unit tests
 */

import { Side } from '@polymarket/clob-client';
import type { Config } from '../config/index.js';
import type { Position, Trade } from '../types/polymarket.js';

/**
 * Create a mock Config object with sensible defaults
 */
export function createMockConfig(overrides?: Partial<Config>): Config {
  const defaultConfig: Config = {
    wallet: {
      privateKey: '0'.repeat(64),
      funderAddress: '0x1234567890123456789012345678901234567890',
    },
    trading: {
      targetTraderAddress: '0x9876543210987654321098765432109876543210',
      copyRatio: 0.1,
      maxPositionSizeUsd: 100,
      minTradeSizeUsd: 1,
      maxPortfolioExposure: 0.8,
    },
    risk: {
      maxConsecutiveFailures: 5,
      circuitBreakerCooldownMinutes: 5,
      tradeCooldownMs: 1000,
    },
    monitoring: {
      pollingIntervalSeconds: 10,
    },
    system: {
      logLevel: 'error', // Use error level in tests to reduce noise
      nodeEnv: 'test',
      polygonRpcUrl: 'https://polygon-rpc.com',
    },
  };

  return {
    ...defaultConfig,
    ...overrides,
    wallet: { ...defaultConfig.wallet, ...overrides?.wallet },
    trading: { ...defaultConfig.trading, ...overrides?.trading },
    risk: { ...defaultConfig.risk, ...overrides?.risk },
    monitoring: { ...defaultConfig.monitoring, ...overrides?.monitoring },
    system: { ...defaultConfig.system, ...overrides?.system },
  };
}

/**
 * Create a mock Trade object
 */
export function createMockTrade(overrides?: Partial<Trade>): Trade {
  const defaultTrade: Trade = {
    id: `trade-${Date.now()}-${Math.random().toString(36).substring(7)}`,
    market: 'test-market-123',
    asset_id: 'test-token-456',
    maker_address: '0x9876543210987654321098765432109876543210',
    taker_address: '0x1111111111111111111111111111111111111111',
    side: Side.BUY,
    size: '100',
    price: '0.5',
    timestamp: Date.now(),
    outcome: 'YES',
    status: 'MATCHED',
  };

  return { ...defaultTrade, ...overrides };
}

/**
 * Create a mock Position object
 */
export function createMockPosition(overrides?: Partial<Position>): Position {
  const defaultPosition: Position = {
    tokenId: 'test-token-456',
    market: 'test-market-123',
    outcome: 'YES',
    size: 100,
    avgPrice: 0.5,
    side: Side.BUY,
    value: 50, // size * avgPrice
    lastUpdated: Date.now(),
  };

  // If custom size or avgPrice provided, recalculate value
  const position = { ...defaultPosition, ...overrides };
  if (overrides?.size !== undefined || overrides?.avgPrice !== undefined) {
    position.value = position.size * position.avgPrice;
  }

  return position;
}

/**
 * Create multiple positions with different tokens
 */
export function createMockPositions(count: number, baseOverrides?: Partial<Position>): Position[] {
  return Array.from({ length: count }, (_, i) =>
    createMockPosition({
      ...baseOverrides,
      tokenId: `token-${i}`,
      market: `market-${i}`,
    })
  );
}

/**
 * Mock logger that stores logs for inspection in tests
 */
export class MockLogger {
  public logs: Array<{ level: string; message: string; data?: unknown }> = [];

  debug(data: unknown, message?: string): void {
    this.logs.push({ level: 'debug', message: message || '', data });
  }

  info(data: unknown, message?: string): void {
    this.logs.push({ level: 'info', message: message || '', data });
  }

  warn(data: unknown, message?: string): void {
    this.logs.push({ level: 'warn', message: message || '', data });
  }

  error(data: unknown, message?: string): void {
    this.logs.push({ level: 'error', message: message || '', data });
  }

  clear(): void {
    this.logs = [];
  }

  hasLog(level: string, messageSubstring: string): boolean {
    return this.logs.some(
      (log) => log.level === level && log.message.includes(messageSubstring)
    );
  }

  getLogCount(level?: string): number {
    if (!level) return this.logs.length;
    return this.logs.filter((log) => log.level === level).length;
  }
}

/**
 * Sleep helper for testing time-dependent behavior
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Round to N decimal places
 */
export function roundTo(value: number, decimals: number): number {
  return Math.round(value * 10 ** decimals) / 10 ** decimals;
}
