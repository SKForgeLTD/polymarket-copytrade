/**
 * Unit tests for PositionCalculator
 * Tests all financial calculation logic with edge cases and boundary conditions
 */

import { Side } from '@polymarket/clob-client';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Config } from '../config/index.js';
import { createMockConfig, createMockPosition } from '../test-utils/fixtures.js';
import { PositionCalculator } from './position-calculator.js';

describe('PositionCalculator', () => {
  let calculator: PositionCalculator;
  let config: Config;

  beforeEach(() => {
    config = createMockConfig({
      trading: {
        targetTraderAddress: '0x1234567890123456789012345678901234567890',
        copyRatio: 0.1, // 10%
        maxPositionSizeUsd: 100,
        minTradeSizeUsd: 1,
        maxPortfolioExposure: 0.8,
      },
    });
    calculator = new PositionCalculator(config);
  });

  describe('calculateCopySize', () => {
    it('should calculate proportional size based on copy ratio', () => {
      const targetSize = 1000;
      const availableBalance = 500;

      const result = calculator.calculateCopySize(targetSize, availableBalance);

      // 1000 * 0.1 = 100
      expect(result).toBe(100);
    });

    it('should cap at max position size', () => {
      const targetSize = 2000;
      const availableBalance = 500;

      const result = calculator.calculateCopySize(targetSize, availableBalance);

      // 2000 * 0.1 = 200, but max is 100
      expect(result).toBe(100);
    });

    it('should cap at available balance', () => {
      const targetSize = 1000;
      const availableBalance = 50;

      const result = calculator.calculateCopySize(targetSize, availableBalance);

      // 1000 * 0.1 = 100, but balance is only 50
      expect(result).toBe(50);
    });

    it('should return 0 if calculated size is below minimum', () => {
      const targetSize = 5; // 5 * 0.1 = 0.5 which is below minTradeSizeUsd (1)
      const availableBalance = 100;

      const result = calculator.calculateCopySize(targetSize, availableBalance);

      expect(result).toBe(0);
    });

    it('should handle exact minimum trade size', () => {
      const targetSize = 10; // 10 * 0.1 = 1 (exactly minTradeSizeUsd)
      const availableBalance = 100;

      const result = calculator.calculateCopySize(targetSize, availableBalance);

      expect(result).toBe(1);
    });

    it('should handle zero target size', () => {
      const result = calculator.calculateCopySize(0, 100);
      expect(result).toBe(0);
    });

    it('should handle zero available balance', () => {
      const result = calculator.calculateCopySize(1000, 0);
      expect(result).toBe(0);
    });

    it('should work with high copy ratio (1.0)', () => {
      const highRatioConfig = createMockConfig({
        trading: {
          targetTraderAddress: '0x1234567890123456789012345678901234567890',
          copyRatio: 1.0,
          maxPositionSizeUsd: 100,
          minTradeSizeUsd: 1,
          maxPortfolioExposure: 0.8,
        },
      });
      const calc = new PositionCalculator(highRatioConfig);

      const result = calc.calculateCopySize(50, 100);

      // 50 * 1.0 = 50 (no reduction from ratio)
      expect(result).toBe(50);
    });

    it('should work with low copy ratio (0.01)', () => {
      const lowRatioConfig = createMockConfig({
        trading: {
          targetTraderAddress: '0x1234567890123456789012345678901234567890',
          copyRatio: 0.01,
          maxPositionSizeUsd: 100,
          minTradeSizeUsd: 1,
          maxPortfolioExposure: 0.8,
        },
      });
      const calc = new PositionCalculator(lowRatioConfig);

      const result = calc.calculateCopySize(200, 100);

      // 200 * 0.01 = 2
      expect(result).toBe(2);
    });
  });

  describe('calculatePositionDelta', () => {
    it('should return null if no target and no current position', () => {
      const result = calculator.calculatePositionDelta(null, null);
      expect(result).toBeNull();
    });

    it('should create close delta when target exits but user still has position', () => {
      const currentPosition = createMockPosition({
        size: 100,
        avgPrice: 0.5,
        side: Side.BUY,
      });

      const result = calculator.calculatePositionDelta(null, currentPosition);

      expect(result).not.toBeNull();
      expect(result?.side).toBe(Side.SELL); // Opposite side to close BUY
      expect(result?.targetSize).toBe(0);
      expect(result?.currentSize).toBe(100);
      expect(result?.deltaSize).toBe(100);
    });

    it('should close SELL position with BUY side', () => {
      const currentPosition = createMockPosition({
        size: 50,
        avgPrice: 0.6,
        side: Side.SELL,
      });

      const result = calculator.calculatePositionDelta(null, currentPosition);

      expect(result).not.toBeNull();
      expect(result?.side).toBe(Side.BUY); // Opposite side to close SELL
      expect(result?.deltaSize).toBe(50);
    });

    it('should create open delta when target opens new position', () => {
      const targetPosition = createMockPosition({
        size: 200,
        avgPrice: 0.55,
        value: 110, // 200 * 0.55
        side: Side.BUY,
      });

      const result = calculator.calculatePositionDelta(targetPosition, null);

      expect(result).not.toBeNull();
      expect(result?.side).toBe(Side.BUY);
      expect(result?.targetSize).toBeGreaterThan(0);
      expect(result?.currentSize).toBe(0);
    });

    it('should return null when opening position below minimum', () => {
      const tinyPosition = createMockPosition({
        size: 5,
        avgPrice: 0.1,
        value: 0.5, // 5 * 0.1 = 0.5 (below min)
        side: Side.BUY,
      });

      const result = calculator.calculatePositionDelta(tinyPosition, null);

      expect(result).toBeNull();
    });

    it('should calculate increase delta (adding to existing position)', () => {
      const targetPosition = createMockPosition({
        tokenId: 'token-1',
        size: 1000,
        avgPrice: 0.5,
        value: 500,
        side: Side.BUY,
      });

      const currentPosition = createMockPosition({
        tokenId: 'token-1',
        size: 50,
        avgPrice: 0.5,
        side: Side.BUY,
      });

      const result = calculator.calculatePositionDelta(targetPosition, currentPosition);

      expect(result).not.toBeNull();
      expect(result?.side).toBe(Side.BUY); // Same side = increase
      expect(result?.currentSize).toBe(50);
      // targetValue = 500 * 0.1 (copyRatio) = 50
      // targetSize = 50 / 0.5 (avgPrice) = 100
      // deltaSize = abs(100 - 50) = 50
      expect(result?.targetSize).toBe(100);
      expect(result?.deltaSize).toBe(50);
    });

    it('should calculate decrease delta (reducing existing position)', () => {
      const targetPosition = createMockPosition({
        tokenId: 'token-1',
        size: 200,
        avgPrice: 0.5,
        value: 100, // 200 * 0.5
        side: Side.BUY,
      });

      const currentPosition = createMockPosition({
        tokenId: 'token-1',
        size: 50,
        avgPrice: 0.5,
        side: Side.BUY,
      });

      const result = calculator.calculatePositionDelta(targetPosition, currentPosition);

      expect(result).not.toBeNull();
      // targetValue = 100 * 0.1 = 10
      // targetSize = 10 / 0.5 = 20
      // deltaSize = abs(20 - 50) = 30
      expect(result?.targetSize).toBe(20);
      expect(result?.deltaSize).toBe(30);
      expect(result?.side).toBe(Side.SELL); // targetSize < currentSize = reduce
    });

    it('should return null when delta is below minimum trade size', () => {
      const targetPosition = createMockPosition({
        tokenId: 'token-1',
        size: 202, // Very close to current
        avgPrice: 0.5,
        value: 101,
        side: Side.BUY,
      });

      const currentPosition = createMockPosition({
        tokenId: 'token-1',
        size: 20,
        avgPrice: 0.5,
        side: Side.BUY,
      });

      const result = calculator.calculatePositionDelta(targetPosition, currentPosition);

      // targetValue = 101 * 0.1 = 10.1
      // targetSize = 10.1 / 0.5 = 20.2
      // deltaSize = abs(20.2 - 20) = 0.2
      // deltaValue = 0.2 * 0.5 = 0.1 (below minTradeSizeUsd of 1)
      expect(result).toBeNull();
    });

    it('should handle position with different prices correctly', () => {
      const targetPosition = createMockPosition({
        size: 1000,
        avgPrice: 0.6,
        value: 600,
        side: Side.BUY,
      });

      const currentPosition = createMockPosition({
        size: 100,
        avgPrice: 0.5, // Different from target
        side: Side.BUY,
      });

      const result = calculator.calculatePositionDelta(targetPosition, currentPosition);

      expect(result).not.toBeNull();
      // Uses current position's avgPrice for calculations
      expect(result?.estimatedPrice).toBe(0.5);
    });
  });

  describe('calculatePortfolioExposure', () => {
    it('should calculate correct exposure with positions and balance', () => {
      const positions = [createMockPosition({ value: 50 }), createMockPosition({ value: 30 })];
      const balance = 120;

      const exposure = calculator.calculatePortfolioExposure(positions, balance);

      // totalValue = 50 + 30 = 80
      // totalPortfolio = 120 + 80 = 200
      // exposure = 80 / 200 = 0.4
      expect(exposure).toBe(0.4);
    });

    it('should return 0 when portfolio is empty', () => {
      const exposure = calculator.calculatePortfolioExposure([], 0);
      expect(exposure).toBe(0);
    });

    it('should return 0 when no balance but no positions', () => {
      const exposure = calculator.calculatePortfolioExposure([], 100);
      expect(exposure).toBe(0);
    });

    it('should handle 100% exposure (all funds in positions)', () => {
      const positions = [createMockPosition({ value: 100 })];
      const balance = 0;

      const exposure = calculator.calculatePortfolioExposure(positions, balance);

      // totalValue = 100
      // totalPortfolio = 0 + 100 = 100
      // exposure = 100 / 100 = 1.0
      expect(exposure).toBe(1.0);
    });

    it('should handle multiple positions correctly', () => {
      const positions = [
        createMockPosition({ value: 10 }),
        createMockPosition({ value: 20 }),
        createMockPosition({ value: 30 }),
      ];
      const balance = 40;

      const exposure = calculator.calculatePortfolioExposure(positions, balance);

      // totalValue = 60
      // totalPortfolio = 40 + 60 = 100
      // exposure = 60 / 100 = 0.6
      expect(exposure).toBe(0.6);
    });

    it('should handle very small positions', () => {
      const positions = [createMockPosition({ value: 0.01 })];
      const balance = 1000;

      const exposure = calculator.calculatePortfolioExposure(positions, balance);

      expect(exposure).toBeCloseTo(0.00001, 5);
    });
  });

  describe('wouldExceedExposureLimit', () => {
    it('should return false when under limit', () => {
      const positions = [createMockPosition({ value: 40 })];
      const balance = 100;
      const newPositionValue = 20;

      const result = calculator.wouldExceedExposureLimit(positions, balance, newPositionValue);

      // currentValue = 40
      // newValue = 40 + 20 = 60
      // totalPortfolio = 100 + 40 = 140
      // newExposure = 60 / 140 = 0.43 < 0.8
      expect(result).toBe(false);
    });

    it('should return true when exceeding limit', () => {
      const positions = [createMockPosition({ value: 70 })];
      const balance = 50;
      const newPositionValue = 50;

      const result = calculator.wouldExceedExposureLimit(positions, balance, newPositionValue);

      // currentValue = 70
      // newValue = 70 + 50 = 120
      // totalPortfolio = 50 + 70 = 120
      // newExposure = 120 / 120 = 1.0 > 0.8
      expect(result).toBe(true);
    });

    it('should handle exact limit boundary', () => {
      const positions = [createMockPosition({ value: 32 })];
      const balance = 100;
      const newPositionValue = 64;

      const result = calculator.wouldExceedExposureLimit(positions, balance, newPositionValue);

      // currentValue = 32
      // newValue = 32 + 64 = 96
      // totalPortfolio = 100 + 32 = 132
      // newExposure = 96 / 132 = 0.727... < 0.8
      expect(result).toBe(false);
    });

    it('should return false when portfolio is empty', () => {
      const result = calculator.wouldExceedExposureLimit([], 0, 10);
      expect(result).toBe(false);
    });

    it('should handle zero balance with existing positions', () => {
      const positions = [createMockPosition({ value: 50 })];
      const balance = 0;
      const newPositionValue = 10;

      const result = calculator.wouldExceedExposureLimit(positions, balance, newPositionValue);

      // totalPortfolio = 0 + 50 = 50
      // newExposure = 60 / 50 = 1.2 > 0.8
      expect(result).toBe(true);
    });

    it('should respect custom exposure limit', () => {
      const customConfig = createMockConfig({
        trading: {
          targetTraderAddress: '0x1234567890123456789012345678901234567890',
          copyRatio: 0.1,
          maxPositionSizeUsd: 100,
          minTradeSizeUsd: 1,
          maxPortfolioExposure: 0.5, // 50% limit
        },
      });
      const customCalc = new PositionCalculator(customConfig);

      const positions = [createMockPosition({ value: 40 })];
      const balance = 100;
      const newPositionValue = 20;

      const result = customCalc.wouldExceedExposureLimit(positions, balance, newPositionValue);

      // newExposure = 60 / 140 = 0.43 < 0.5
      expect(result).toBe(false);
    });
  });

  describe('roundToTickSize', () => {
    it('should round to default tick size (0.01)', () => {
      expect(calculator.roundToTickSize(10.123)).toBeCloseTo(10.12, 2);
      expect(calculator.roundToTickSize(10.126)).toBeCloseTo(10.13, 2);
      expect(calculator.roundToTickSize(10.125)).toBeCloseTo(10.13, 2); // Round half up
    });

    it('should handle custom tick size', () => {
      expect(calculator.roundToTickSize(10.1234, 0.001)).toBe(10.123);
      expect(calculator.roundToTickSize(10.1236, 0.001)).toBe(10.124);
    });

    it('should round to whole numbers with tick size 1', () => {
      expect(calculator.roundToTickSize(10.4, 1)).toBe(10);
      expect(calculator.roundToTickSize(10.6, 1)).toBe(11);
    });

    it('should handle zero', () => {
      expect(calculator.roundToTickSize(0)).toBe(0);
    });

    it('should handle negative numbers', () => {
      expect(calculator.roundToTickSize(-10.126)).toBe(-10.13);
    });

    it('should handle very small numbers', () => {
      expect(calculator.roundToTickSize(0.001234, 0.0001)).toBeCloseTo(0.0012, 4);
    });

    it('should handle exact tick multiples', () => {
      expect(calculator.roundToTickSize(10.12)).toBeCloseTo(10.12, 2);
      expect(calculator.roundToTickSize(10.0)).toBeCloseTo(10.0, 2);
    });
  });

  describe('roundPrice', () => {
    it('should round price to default tick size (0.01)', () => {
      expect(calculator.roundPrice(0.551)).toBe(0.55);
      expect(calculator.roundPrice(0.556)).toBe(0.56);
    });

    it('should handle custom tick size', () => {
      expect(calculator.roundPrice(0.5512, 0.001)).toBe(0.551);
      expect(calculator.roundPrice(0.5516, 0.001)).toBe(0.552);
    });

    it('should handle boundary prices', () => {
      expect(calculator.roundPrice(0.0)).toBe(0.0);
      expect(calculator.roundPrice(1.0)).toBe(1.0);
    });

    it('should round prediction market prices correctly', () => {
      expect(calculator.roundPrice(0.123456)).toBe(0.12);
      expect(calculator.roundPrice(0.987654)).toBe(0.99);
    });
  });

  describe('calculateSlippagePrice', () => {
    it('should increase price for BUY orders', () => {
      const basePrice = 0.5;
      const slippageBps = 50; // 0.5%

      const result = calculator.calculateSlippagePrice(basePrice, Side.BUY, slippageBps);

      // 0.5 * (1 + 0.005) = 0.5025
      expect(result).toBe(0.5025);
    });

    it('should decrease price for SELL orders', () => {
      const basePrice = 0.5;
      const slippageBps = 50; // 0.5%

      const result = calculator.calculateSlippagePrice(basePrice, Side.SELL, slippageBps);

      // 0.5 * (1 - 0.005) = 0.4975
      expect(result).toBe(0.4975);
    });

    it('should cap BUY price at 0.99', () => {
      const basePrice = 0.98;
      const slippageBps = 200; // 2%

      const result = calculator.calculateSlippagePrice(basePrice, Side.BUY, slippageBps);

      // 0.98 * 1.02 = 0.9996, capped at 0.99
      expect(result).toBe(0.99);
    });

    it('should floor SELL price at 0.01', () => {
      const basePrice = 0.01;
      const slippageBps = 100; // 1%

      const result = calculator.calculateSlippagePrice(basePrice, Side.SELL, slippageBps);

      // 0.01 * (1 - 0.01) = 0.01 * 0.99 = 0.0099
      // Math.max(0.0099, 0.01) = 0.01 (floored)
      expect(result).toBe(0.01);
    });

    it('should handle zero slippage', () => {
      const basePrice = 0.5;

      expect(calculator.calculateSlippagePrice(basePrice, Side.BUY, 0)).toBe(0.5);
      expect(calculator.calculateSlippagePrice(basePrice, Side.SELL, 0)).toBe(0.5);
    });

    it('should handle high slippage (100 bps = 1%)', () => {
      const basePrice = 0.5;
      const slippageBps = 100;

      const buyPrice = calculator.calculateSlippagePrice(basePrice, Side.BUY, slippageBps);
      const sellPrice = calculator.calculateSlippagePrice(basePrice, Side.SELL, slippageBps);

      expect(buyPrice).toBe(0.505); // 0.5 * 1.01
      expect(sellPrice).toBe(0.495); // 0.5 * 0.99
    });

    it('should handle edge case near maximum price', () => {
      const basePrice = 0.99;
      const slippageBps = 50; // Need larger slippage to exceed cap

      const result = calculator.calculateSlippagePrice(basePrice, Side.BUY, slippageBps);

      // 0.99 * 1.005 = 0.99495, capped at 0.99
      expect(result).toBe(0.99);
    });

    it('should handle edge case near minimum price', () => {
      const basePrice = 0.01;
      const slippageBps = 10;

      const result = calculator.calculateSlippagePrice(basePrice, Side.SELL, slippageBps);

      // 0.01 * 0.999 = 0.00999, floored at 0.01
      expect(result).toBe(0.01);
    });
  });

  describe('integration scenarios', () => {
    it('should handle complete copy trade flow', () => {
      // Target trader opens $1000 position at 0.5
      const targetPosition = createMockPosition({
        size: 2000,
        avgPrice: 0.5,
        value: 1000,
        side: Side.BUY,
      });

      // Calculate what we should copy
      const copySize = calculator.calculateCopySize(1000, 200);
      expect(copySize).toBe(100); // 1000 * 0.1, capped at maxPositionSize

      // Open the position
      const delta = calculator.calculatePositionDelta(targetPosition, null);
      expect(delta).not.toBeNull();
      expect(delta?.side).toBe(Side.BUY);

      // Check exposure
      const wouldExceed = calculator.wouldExceedExposureLimit([], 200, 100);
      expect(wouldExceed).toBe(false); // 100 / 200 = 0.5 < 0.8
    });

    it('should prevent over-exposure', () => {
      // Already have large positions
      const existingPositions = [
        createMockPosition({ value: 60 }),
        createMockPosition({ value: 40 }),
      ];
      const balance = 50;

      // Try to add another large position
      const wouldExceed = calculator.wouldExceedExposureLimit(existingPositions, balance, 50);

      // currentValue = 100, newValue = 150
      // totalPortfolio = 50 + 100 = 150
      // newExposure = 150 / 150 = 1.0 > 0.8
      expect(wouldExceed).toBe(true);
    });
  });
});
