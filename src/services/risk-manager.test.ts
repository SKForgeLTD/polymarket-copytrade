/**
 * Unit tests for RiskManager
 * Tests circuit breaker state machine, risk validation, and time-dependent behavior
 */

import { beforeEach, describe, expect, it, vi, afterEach } from 'vitest';
import { RiskManager } from './risk-manager.js';
import { createMockConfig, createMockPosition } from '../test-utils/fixtures.js';
import { Side } from '../types/polymarket.js';
import type { Config } from '../config/index.js';

describe('RiskManager', () => {
  let riskManager: RiskManager;
  let config: Config;
  let originalDateNow: typeof Date.now;

  beforeEach(() => {
    config = createMockConfig({
      trading: {
        targetTraderAddress: '0x1234567890123456789012345678901234567890',
        copyRatio: 0.1,
        maxPositionSizeUsd: 100,
        minTradeSizeUsd: 1,
        maxPortfolioExposure: 0.8,
      },
      risk: {
        maxConsecutiveFailures: 3,
        circuitBreakerCooldownMinutes: 5,
        tradeCooldownMs: 1000,
      },
    });
    riskManager = new RiskManager(config);

    // Save original Date.now
    originalDateNow = Date.now;
  });

  afterEach(() => {
    // Restore Date.now after each test
    vi.restoreAllMocks();
  });

  describe('validateTrade - basic validation', () => {
    it('should pass validation for valid trade', async () => {
      const result = await riskManager.validateTrade(
        'token-123',
        Side.BUY,
        100, // size
        0.5, // price ($50 trade)
        200, // balance
        [] // no existing positions
      );

      expect(result.passed).toBe(true);
      expect(result.reason).toBeUndefined();
    });

    it('should reject trade with insufficient balance', async () => {
      const result = await riskManager.validateTrade(
        'token-123',
        Side.BUY,
        200, // size
        0.5, // price ($100 trade)
        50, // balance (not enough)
        []
      );

      expect(result.passed).toBe(false);
      expect(result.reason).toContain('Insufficient balance');
      expect(result.suggestions).toBeDefined();
      expect(result.suggestions?.length).toBeGreaterThan(0);
    });

    it('should allow SELL with insufficient balance', async () => {
      // SELL orders don't need balance
      const result = await riskManager.validateTrade(
        'token-123',
        Side.SELL,
        200,
        0.5,
        10, // low balance
        []
      );

      expect(result.passed).toBe(true);
    });

    it('should reject trade below minimum trade size', async () => {
      const result = await riskManager.validateTrade(
        'token-123',
        Side.BUY,
        1, // size
        0.5, // price ($0.50 trade, below $1 minimum)
        100,
        []
      );

      expect(result.passed).toBe(false);
      expect(result.reason).toContain('below minimum');
    });

    it('should accept trade at exactly minimum trade size', async () => {
      const result = await riskManager.validateTrade(
        'token-123',
        Side.BUY,
        2, // size
        0.5, // price ($1 trade, exactly minimum)
        100,
        []
      );

      expect(result.passed).toBe(true);
    });

    it('should reject trade above maximum position size', async () => {
      const result = await riskManager.validateTrade(
        'token-123',
        Side.BUY,
        400, // size
        0.5, // price ($200 trade, above $100 max)
        300,
        []
      );

      expect(result.passed).toBe(false);
      expect(result.reason).toContain('exceeds maximum');
    });

    it('should accept trade at exactly maximum position size', async () => {
      const result = await riskManager.validateTrade(
        'token-123',
        Side.BUY,
        200, // size
        0.5, // price ($100 trade, exactly maximum)
        200,
        []
      );

      expect(result.passed).toBe(true);
    });

    it('should reject trade with invalid price (too low)', async () => {
      const result = await riskManager.validateTrade(
        'token-123',
        Side.BUY,
        200, // Larger size to pass min trade size check
        0.005, // price below 0.01
        100,
        []
      );

      expect(result.passed).toBe(false);
      expect(result.reason).toContain('outside reasonable range');
    });

    it('should reject trade with invalid price (too high)', async () => {
      const result = await riskManager.validateTrade(
        'token-123',
        Side.BUY,
        100,
        0.995, // price above 0.99
        200, // Enough balance
        []
      );

      expect(result.passed).toBe(false);
      expect(result.reason).toContain('outside reasonable range');
    });

    it('should accept price at lower boundary (0.01)', async () => {
      const result = await riskManager.validateTrade(
        'token-123',
        Side.BUY,
        200,
        0.01,
        100,
        []
      );

      expect(result.passed).toBe(true);
    });

    it('should accept price at upper boundary (0.99)', async () => {
      const result = await riskManager.validateTrade(
        'token-123',
        Side.BUY,
        10, // size
        0.99, // price = $9.90 trade value (above minimum of $1)
        200,
        []
      );

      expect(result.passed).toBe(true);
    });

    it('should reject trade with invalid size (zero)', async () => {
      const result = await riskManager.validateTrade(
        'token-123',
        Side.BUY,
        0, // zero size
        0.5,
        100,
        []
      );

      expect(result.passed).toBe(false);
      // Will fail on min trade size check first (0 * 0.5 = 0 < 1)
      expect(result.reason).toContain('below minimum');
    });

    it('should reject trade with invalid size (negative)', async () => {
      const result = await riskManager.validateTrade(
        'token-123',
        Side.BUY,
        -10, // negative size
        0.5,
        100,
        []
      );

      expect(result.passed).toBe(false);
      // Will fail on min trade size check first (-10 * 0.5 = -5 < 1)
      expect(result.reason).toContain('below minimum');
    });
  });

  describe('validateTrade - portfolio exposure', () => {
    it('should reject BUY when exceeding portfolio exposure limit', async () => {
      const existingPositions = [
        createMockPosition({ value: 80 }),
        createMockPosition({ value: 40 }),
      ];
      const balance = 50;

      const result = await riskManager.validateTrade(
        'token-123',
        Side.BUY,
        100, // size
        0.5, // $50 trade
        balance,
        existingPositions
      );

      // currentValue = 120, newValue = 170
      // totalPortfolio = 50 + 120 = 170
      // newExposure = 170 / 170 = 1.0 > 0.8
      expect(result.passed).toBe(false);
      expect(result.reason).toContain('exposure');
      expect(result.suggestions).toBeDefined();
    });

    it('should allow BUY when under portfolio exposure limit', async () => {
      const existingPositions = [createMockPosition({ value: 40 })];
      const balance = 100;

      const result = await riskManager.validateTrade(
        'token-123',
        Side.BUY,
        40,
        0.5, // $20 trade
        balance,
        existingPositions
      );

      // currentValue = 40, newValue = 60
      // totalPortfolio = 100 + 40 = 140
      // newExposure = 60 / 140 = 0.43 < 0.8
      expect(result.passed).toBe(true);
    });

    it('should allow SELL regardless of exposure (reduces exposure)', async () => {
      const existingPositions = [
        createMockPosition({ value: 80 }),
        createMockPosition({ value: 40 }),
      ];
      const balance = 10;

      const result = await riskManager.validateTrade(
        'token-123',
        Side.SELL,
        100,
        0.5,
        balance,
        existingPositions
      );

      // SELL doesn't increase exposure
      expect(result.passed).toBe(true);
    });

    it('should handle zero balance with exposure calculation', async () => {
      const existingPositions = [createMockPosition({ value: 50 })];
      const balance = 0;

      const result = await riskManager.validateTrade(
        'token-123',
        Side.BUY,
        20,
        0.5, // $10 trade
        balance,
        existingPositions
      );

      // Insufficient balance should fail before exposure check
      expect(result.passed).toBe(false);
      expect(result.reason).toContain('Insufficient balance');
    });
  });

  describe('circuit breaker - state machine', () => {
    it('should start with circuit breaker off', () => {
      const status = riskManager.getCircuitBreakerStatus();

      expect(status.isTripped).toBe(false);
      expect(status.consecutiveFailures).toBe(0);
    });

    it('should increment failure count on recordFailure', () => {
      riskManager.recordFailure();

      const status = riskManager.getCircuitBreakerStatus();
      expect(status.consecutiveFailures).toBe(1);
      expect(status.isTripped).toBe(false);
    });

    it('should trip circuit breaker after max consecutive failures', () => {
      // Record 3 failures (max is 3)
      riskManager.recordFailure();
      riskManager.recordFailure();
      riskManager.recordFailure();

      const status = riskManager.getCircuitBreakerStatus();
      expect(status.isTripped).toBe(true);
      expect(status.consecutiveFailures).toBe(3);
      expect(status.cooldownEndsAt).toBeDefined();
    });

    it('should reset failure count on success', () => {
      riskManager.recordFailure();
      riskManager.recordFailure();

      expect(riskManager.getCircuitBreakerStatus().consecutiveFailures).toBe(2);

      riskManager.recordSuccess();

      expect(riskManager.getCircuitBreakerStatus().consecutiveFailures).toBe(0);
    });

    it('should block trading when circuit breaker is tripped', async () => {
      // Trip the circuit breaker
      riskManager.recordFailure();
      riskManager.recordFailure();
      riskManager.recordFailure();

      const result = await riskManager.validateTrade(
        'token-123',
        Side.BUY,
        100,
        0.5,
        200,
        []
      );

      expect(result.passed).toBe(false);
      expect(result.reason).toContain('Circuit breaker active');
    });

    it('should calculate correct cooldown remaining time', async () => {
      const mockNow = 1000000;
      vi.spyOn(Date, 'now').mockReturnValue(mockNow);

      // Trip the circuit breaker
      riskManager.recordFailure();
      riskManager.recordFailure();
      riskManager.recordFailure();

      const result = await riskManager.validateTrade(
        'token-123',
        Side.BUY,
        100,
        0.5,
        200,
        []
      );

      expect(result.passed).toBe(false);
      expect(result.reason).toContain('Circuit breaker active');
      expect(result.reason).toContain('Cooldown ends in');
    });

    it('should auto-reset circuit breaker after cooldown period', async () => {
      const mockNow = 1000000;
      vi.spyOn(Date, 'now').mockReturnValue(mockNow);

      // Trip the circuit breaker
      riskManager.recordFailure();
      riskManager.recordFailure();
      riskManager.recordFailure();

      expect(riskManager.getCircuitBreakerStatus().isTripped).toBe(true);

      // Advance time past cooldown (5 minutes = 300000 ms)
      vi.spyOn(Date, 'now').mockReturnValue(mockNow + 300001);

      const result = await riskManager.validateTrade(
        'token-123',
        Side.BUY,
        100,
        0.5,
        200,
        []
      );

      expect(result.passed).toBe(true);
      expect(riskManager.getCircuitBreakerStatus().isTripped).toBe(false);
    });

    it('should not reset if cooldown period not elapsed', async () => {
      const mockNow = 1000000;
      vi.spyOn(Date, 'now').mockReturnValue(mockNow);

      // Trip the circuit breaker
      riskManager.recordFailure();
      riskManager.recordFailure();
      riskManager.recordFailure();

      // Advance time but not enough (4 minutes instead of 5)
      vi.spyOn(Date, 'now').mockReturnValue(mockNow + 240000);

      const result = await riskManager.validateTrade(
        'token-123',
        Side.BUY,
        100,
        0.5,
        200,
        []
      );

      expect(result.passed).toBe(false);
      expect(riskManager.getCircuitBreakerStatus().isTripped).toBe(true);
    });

    it('should allow manual circuit breaker reset', () => {
      // Trip the circuit breaker
      riskManager.recordFailure();
      riskManager.recordFailure();
      riskManager.recordFailure();

      expect(riskManager.getCircuitBreakerStatus().isTripped).toBe(true);

      riskManager.forceResetCircuitBreaker();

      const status = riskManager.getCircuitBreakerStatus();
      expect(status.isTripped).toBe(false);
      expect(status.consecutiveFailures).toBe(0);
    });
  });

  describe('trade cooldown', () => {
    it('should enforce trade cooldown period', async () => {
      const mockNow = 1000000;
      vi.spyOn(Date, 'now').mockReturnValue(mockNow);

      // First trade succeeds
      riskManager.recordSuccess();

      // Immediate second trade should fail (within cooldown)
      vi.spyOn(Date, 'now').mockReturnValue(mockNow + 500); // 500ms later

      const result = await riskManager.validateTrade(
        'token-123',
        Side.BUY,
        100,
        0.5,
        200,
        []
      );

      expect(result.passed).toBe(false);
      expect(result.reason).toContain('Trade cooldown active');
    });

    it('should allow trade after cooldown period elapsed', async () => {
      const mockNow = 1000000;
      vi.spyOn(Date, 'now').mockReturnValue(mockNow);

      // First trade succeeds
      riskManager.recordSuccess();

      // Trade after cooldown should succeed
      vi.spyOn(Date, 'now').mockReturnValue(mockNow + 1001); // 1001ms later

      const result = await riskManager.validateTrade(
        'token-123',
        Side.BUY,
        100,
        0.5,
        200,
        []
      );

      expect(result.passed).toBe(true);
    });

    it('should allow first trade without cooldown', async () => {
      // No recordSuccess called yet, so lastTradeTime is 0
      const result = await riskManager.validateTrade(
        'token-123',
        Side.BUY,
        100,
        0.5,
        200,
        []
      );

      expect(result.passed).toBe(true);
    });

    it('should show correct remaining cooldown time', async () => {
      const mockNow = 1000000;
      vi.spyOn(Date, 'now').mockReturnValue(mockNow);

      riskManager.recordSuccess();

      vi.spyOn(Date, 'now').mockReturnValue(mockNow + 300); // 300ms later

      const result = await riskManager.validateTrade(
        'token-123',
        Side.BUY,
        100,
        0.5,
        200,
        []
      );

      expect(result.passed).toBe(false);
      expect(result.reason).toContain('Wait');
      expect(result.reason).toContain('s'); // Should show seconds
    });
  });

  describe('isTradingAllowed', () => {
    it('should return true when circuit breaker is not tripped', () => {
      expect(riskManager.isTradingAllowed()).toBe(true);
    });

    it('should return false when circuit breaker is tripped', () => {
      riskManager.recordFailure();
      riskManager.recordFailure();
      riskManager.recordFailure();

      expect(riskManager.isTradingAllowed()).toBe(false);
    });

    it('should return true after cooldown expires', () => {
      const mockNow = 1000000;
      vi.spyOn(Date, 'now').mockReturnValue(mockNow);

      riskManager.recordFailure();
      riskManager.recordFailure();
      riskManager.recordFailure();

      expect(riskManager.isTradingAllowed()).toBe(false);

      // Advance past cooldown
      vi.spyOn(Date, 'now').mockReturnValue(mockNow + 300001);

      expect(riskManager.isTradingAllowed()).toBe(true);
    });
  });

  describe('getSummary', () => {
    it('should return complete risk management state', () => {
      const summary = riskManager.getSummary();

      expect(summary).toHaveProperty('circuitBreaker');
      expect(summary).toHaveProperty('lastTradeTime');
      expect(summary).toHaveProperty('tradingAllowed');
      expect(summary.tradingAllowed).toBe(true);
    });

    it('should reflect circuit breaker state', () => {
      riskManager.recordFailure();
      riskManager.recordFailure();
      riskManager.recordFailure();

      const summary = riskManager.getSummary();

      expect(summary.circuitBreaker.isTripped).toBe(true);
      expect(summary.tradingAllowed).toBe(false);
    });

    it('should track last trade time', () => {
      const mockNow = 1234567890;
      vi.spyOn(Date, 'now').mockReturnValue(mockNow);

      riskManager.recordSuccess();

      const summary = riskManager.getSummary();
      expect(summary.lastTradeTime).toBe(mockNow);
    });
  });

  describe('edge cases and boundary conditions', () => {
    it('should handle exact balance match for BUY', async () => {
      const result = await riskManager.validateTrade(
        'token-123',
        Side.BUY,
        10, // size
        0.2, // price = $2
        10, // balance = $10
        [] // newExposure = 2/10 = 0.2 < 0.8
      );

      expect(result.passed).toBe(true);
    });

    it('should handle very small trade value', async () => {
      const result = await riskManager.validateTrade(
        'token-123',
        Side.BUY,
        10,
        0.1, // $1 trade (exactly minimum)
        100,
        []
      );

      expect(result.passed).toBe(true);
    });

    it('should handle very large positions array', async () => {
      const manyPositions = Array.from({ length: 100 }, (_, i) =>
        createMockPosition({ tokenId: `token-${i}`, value: 0.1 })
      );

      const result = await riskManager.validateTrade(
        'token-123',
        Side.BUY,
        20,
        0.5,
        1000,
        manyPositions
      );

      // Should still calculate exposure correctly
      // totalValue = 100 * 0.1 = 10
      // newValue = 10 + 10 = 20
      // totalPortfolio = 1000 + 10 = 1010
      // exposure = 20 / 1010 = 0.02 < 0.8
      expect(result.passed).toBe(true);
    });

    it('should handle rapid consecutive failures', () => {
      for (let i = 0; i < 10; i++) {
        riskManager.recordFailure();
      }

      const status = riskManager.getCircuitBreakerStatus();
      expect(status.isTripped).toBe(true);
      expect(status.consecutiveFailures).toBe(10); // Should count all
    });

    it('should handle rapid success/failure alternation', () => {
      riskManager.recordFailure();
      riskManager.recordSuccess();
      riskManager.recordFailure();
      riskManager.recordSuccess();

      const status = riskManager.getCircuitBreakerStatus();
      expect(status.consecutiveFailures).toBe(0);
      expect(status.isTripped).toBe(false);
    });
  });

  describe('configuration edge cases', () => {
    it('should respect custom max consecutive failures', () => {
      const customConfig = createMockConfig({
        risk: {
          maxConsecutiveFailures: 1,
          circuitBreakerCooldownMinutes: 5,
          tradeCooldownMs: 1000,
        },
      });
      const rm = new RiskManager(customConfig);

      rm.recordFailure();

      expect(rm.getCircuitBreakerStatus().isTripped).toBe(true);
    });

    it('should respect custom cooldown period', async () => {
      const customConfig = createMockConfig({
        risk: {
          maxConsecutiveFailures: 3,
          circuitBreakerCooldownMinutes: 1, // 1 minute
          tradeCooldownMs: 1000,
        },
      });
      const rm = new RiskManager(customConfig);

      const mockNow = 1000000;
      vi.spyOn(Date, 'now').mockReturnValue(mockNow);

      rm.recordFailure();
      rm.recordFailure();
      rm.recordFailure();

      // 1 minute = 60000ms
      vi.spyOn(Date, 'now').mockReturnValue(mockNow + 60001);

      const result = await rm.validateTrade('token-123', Side.BUY, 100, 0.5, 200, []);
      expect(result.passed).toBe(true);
    });

    it('should respect zero trade cooldown (HFT mode)', async () => {
      const hftConfig = createMockConfig({
        risk: {
          maxConsecutiveFailures: 3,
          circuitBreakerCooldownMinutes: 5,
          tradeCooldownMs: 0, // No cooldown
        },
      });
      const rm = new RiskManager(hftConfig);

      const mockNow = 1000000;
      vi.spyOn(Date, 'now').mockReturnValue(mockNow);

      rm.recordSuccess();

      // Immediate trade should succeed
      vi.spyOn(Date, 'now').mockReturnValue(mockNow + 1);

      const result = await rm.validateTrade('token-123', Side.BUY, 100, 0.5, 200, []);
      expect(result.passed).toBe(true);
    });
  });
});
