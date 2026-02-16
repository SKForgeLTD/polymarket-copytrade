/**
 * Unit tests for PositionManager
 * Tests position tracking, deduplication, persistence, and overshoot detection
 */

import fs from 'node:fs/promises';
import { Side } from '@polymarket/clob-client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockPosition, createMockTrade } from '../test-utils/fixtures.js';
import type { Trade } from '../types/polymarket.js';
import { PositionManager } from './position-manager.js';

// Mock the fs module
vi.mock('node:fs/promises');

describe('PositionManager', () => {
  let positionManager: PositionManager;
  const testStateFilePath = './test-state/positions.json';

  beforeEach(() => {
    positionManager = new PositionManager(testStateFilePath);
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('initialization', () => {
    it('should initialize with empty positions', async () => {
      vi.mocked(fs.readFile).mockRejectedValue({ code: 'ENOENT' }); // File doesn't exist

      await positionManager.initialize();

      expect(positionManager.getAllUserPositions()).toEqual([]);
      expect(positionManager.getAllTargetPositions()).toEqual([]);
    });

    it('should load persisted state from file', async () => {
      const savedState = {
        userPositions: {
          'token-1': createMockPosition({ tokenId: 'token-1', size: 100 }),
        },
        targetPositions: {
          'token-2': createMockPosition({ tokenId: 'token-2', size: 200 }),
        },
        processedTradeIds: ['trade-1', 'trade-2'],
        lastSaved: Date.now(),
      };

      vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify(savedState));

      await positionManager.initialize();

      expect(positionManager.getUserPosition('token-1')).toBeDefined();
      expect(positionManager.getTargetPosition('token-2')).toBeDefined();
      expect(positionManager.isTradeProcessed('trade-1')).toBe(true);
    });

    it('should handle corrupted state file gracefully', async () => {
      vi.mocked(fs.readFile).mockResolvedValue('invalid json {{{');

      await positionManager.initialize();

      // Should start fresh without throwing
      expect(positionManager.getAllUserPositions()).toEqual([]);
    });

    it('should handle file read errors gracefully', async () => {
      vi.mocked(fs.readFile).mockRejectedValue(new Error('Permission denied'));

      await positionManager.initialize();

      // Should start fresh
      expect(positionManager.getAllUserPositions()).toEqual([]);
    });
  });

  describe('updatePosition - new positions', () => {
    it('should create new user position from BUY trade', () => {
      const trade = createMockTrade({
        asset: 'token-1',
        conditionId: 'market-1',
        side: Side.BUY,
        size: '100',
        price: '0.5',
        outcome: 'YES',
      });

      positionManager.updatePosition(trade, true);

      const position = positionManager.getUserPosition('token-1');
      expect(position).not.toBeNull();
      expect(position?.size).toBe(100);
      expect(position?.avgPrice).toBe(0.5);
      expect(position?.value).toBe(50);
      expect(position?.side).toBe(Side.BUY);
    });

    it('should create new target position from SELL trade', () => {
      const trade = createMockTrade({
        asset: 'token-1',
        side: Side.SELL,
        size: '50',
        price: '0.6',
      });

      positionManager.updatePosition(trade, false);

      const position = positionManager.getTargetPosition('token-1');
      expect(position).not.toBeNull();
      expect(position?.size).toBe(50);
      expect(position?.avgPrice).toBe(0.6);
      expect(position?.value).toBe(30);
      expect(position?.side).toBe(Side.SELL);
    });

    it('should skip trade with missing asset', () => {
      const invalidTrade = createMockTrade({ asset: '' });

      positionManager.updatePosition(invalidTrade, true);

      expect(positionManager.getAllUserPositions()).toEqual([]);
    });

    it('should skip trade with missing market', () => {
      const invalidTrade = createMockTrade({ conditionId: '' });

      positionManager.updatePosition(invalidTrade, true);

      expect(positionManager.getAllUserPositions()).toEqual([]);
    });
  });

  describe('updatePosition - adding to positions', () => {
    it('should add to existing position with same side', () => {
      // Create initial position
      const trade1 = createMockTrade({
        asset: 'token-1',
        side: Side.BUY,
        size: '100',
        price: '0.5',
      });
      positionManager.updatePosition(trade1, true);

      // Add to position
      const trade2 = createMockTrade({
        asset: 'token-1',
        side: Side.BUY,
        size: '100',
        price: '0.6',
      });
      positionManager.updatePosition(trade2, true);

      const position = positionManager.getUserPosition('token-1');
      expect(position?.size).toBe(200); // 100 + 100
      // avgPrice = (100 * 0.5 + 100 * 0.6) / 200 = 0.55
      expect(position?.avgPrice).toBe(0.55);
      expect(position?.value).toBeCloseTo(110, 2); // 200 * 0.55
    });

    it('should calculate weighted average price correctly', () => {
      const trade1 = createMockTrade({
        asset: 'token-1',
        side: Side.BUY,
        size: '200',
        price: '0.4',
      });
      positionManager.updatePosition(trade1, true);

      const trade2 = createMockTrade({
        asset: 'token-1',
        side: Side.BUY,
        size: '100',
        price: '0.7',
      });
      positionManager.updatePosition(trade2, true);

      const position = positionManager.getUserPosition('token-1');
      // avgPrice = (200 * 0.4 + 100 * 0.7) / 300 = (80 + 70) / 300 = 0.5
      expect(position?.avgPrice).toBe(0.5);
      expect(position?.size).toBe(300);
      expect(position?.value).toBe(150);
    });
  });

  describe('updatePosition - reducing positions', () => {
    it('should reduce position with opposite side trade', () => {
      // Create BUY position
      const trade1 = createMockTrade({
        asset: 'token-1',
        side: Side.BUY,
        size: '100',
        price: '0.5',
      });
      positionManager.updatePosition(trade1, true);

      // Reduce with SELL
      const trade2 = createMockTrade({
        asset: 'token-1',
        side: Side.SELL,
        size: '40',
        price: '0.6', // Price doesn't affect avgPrice when reducing
      });
      positionManager.updatePosition(trade2, true);

      const position = positionManager.getUserPosition('token-1');
      expect(position?.size).toBe(60); // 100 - 40
      expect(position?.avgPrice).toBe(0.5); // Unchanged
      expect(position?.value).toBe(30); // 60 * 0.5
    });

    it('should close position when reduce equals position size', () => {
      const trade1 = createMockTrade({
        asset: 'token-1',
        side: Side.BUY,
        size: '100',
        price: '0.5',
      });
      positionManager.updatePosition(trade1, true);

      const trade2 = createMockTrade({
        asset: 'token-1',
        side: Side.SELL,
        size: '100', // Exact size
        price: '0.6',
      });
      positionManager.updatePosition(trade2, true);

      const position = positionManager.getUserPosition('token-1');
      expect(position).toBeNull(); // Position closed
    });

    it('should detect overshoot when closing trade exceeds position size', () => {
      const trade1 = createMockTrade({
        asset: 'token-1',
        side: Side.BUY,
        size: '100',
        price: '0.5',
      });
      positionManager.updatePosition(trade1, true);

      // Overshoot by 20
      const trade2 = createMockTrade({
        asset: 'token-1',
        side: Side.SELL,
        size: '120', // More than position
        price: '0.6',
      });
      positionManager.updatePosition(trade2, true);

      const position = positionManager.getUserPosition('token-1');
      expect(position).toBeNull(); // Position still closed despite overshoot
    });

    it('should reduce SELL position with BUY trade', () => {
      const trade1 = createMockTrade({
        asset: 'token-1',
        side: Side.SELL,
        size: '100',
        price: '0.5',
      });
      positionManager.updatePosition(trade1, true);

      const trade2 = createMockTrade({
        asset: 'token-1',
        side: Side.BUY,
        size: '30',
        price: '0.6',
      });
      positionManager.updatePosition(trade2, true);

      const position = positionManager.getUserPosition('token-1');
      expect(position?.size).toBe(70);
      expect(position?.side).toBe(Side.SELL);
    });
  });

  describe('position getters', () => {
    beforeEach(() => {
      const userTrade = createMockTrade({ asset: 'user-token' });
      const targetTrade = createMockTrade({ asset: 'target-token' });

      positionManager.updatePosition(userTrade, true);
      positionManager.updatePosition(targetTrade, false);
    });

    it('should get specific user position', () => {
      const position = positionManager.getUserPosition('user-token');
      expect(position).not.toBeNull();
      expect(position?.tokenId).toBe('user-token');
    });

    it('should get specific target position', () => {
      const position = positionManager.getTargetPosition('target-token');
      expect(position).not.toBeNull();
      expect(position?.tokenId).toBe('target-token');
    });

    it('should return null for non-existent position', () => {
      expect(positionManager.getUserPosition('non-existent')).toBeNull();
      expect(positionManager.getTargetPosition('non-existent')).toBeNull();
    });

    it('should get all user positions', () => {
      const positions = positionManager.getAllUserPositions();
      expect(positions).toHaveLength(1);
      expect(positions[0]?.tokenId).toBe('user-token');
    });

    it('should get all target positions', () => {
      const positions = positionManager.getAllTargetPositions();
      expect(positions).toHaveLength(1);
      expect(positions[0]?.tokenId).toBe('target-token');
    });

    it('should keep user and target positions separate', () => {
      expect(positionManager.getUserPosition('target-token')).toBeNull();
      expect(positionManager.getTargetPosition('user-token')).toBeNull();
    });
  });

  describe('trade deduplication', () => {
    it('should track processed trades', () => {
      expect(positionManager.isTradeProcessed('trade-1')).toBe(false);

      positionManager.markTradeProcessed('trade-1');

      expect(positionManager.isTradeProcessed('trade-1')).toBe(true);
    });

    it('should handle multiple different trades', () => {
      positionManager.markTradeProcessed('trade-1');
      positionManager.markTradeProcessed('trade-2');
      positionManager.markTradeProcessed('trade-3');

      expect(positionManager.isTradeProcessed('trade-1')).toBe(true);
      expect(positionManager.isTradeProcessed('trade-2')).toBe(true);
      expect(positionManager.isTradeProcessed('trade-3')).toBe(true);
      expect(positionManager.isTradeProcessed('trade-4')).toBe(false);
    });

    it('should enforce cache size limit of 1000', () => {
      // Add 1100 trades
      for (let i = 0; i < 1100; i++) {
        positionManager.markTradeProcessed(`trade-${i}`);
      }

      // First 100 should be evicted (FIFO)
      expect(positionManager.isTradeProcessed('trade-0')).toBe(false);
      expect(positionManager.isTradeProcessed('trade-99')).toBe(false);

      // Trades 100-1099 should still be cached
      expect(positionManager.isTradeProcessed('trade-100')).toBe(true);
      expect(positionManager.isTradeProcessed('trade-1099')).toBe(true);
    });

    it('should maintain cache size at exactly 1000 after eviction', () => {
      // Add 1050 trades
      for (let i = 0; i < 1050; i++) {
        positionManager.markTradeProcessed(`trade-${i}`);
      }

      const summary = positionManager.getSummary();
      expect(summary.processedTradeCount).toBe(1000);
    });

    it('should handle duplicate trade IDs gracefully', () => {
      positionManager.markTradeProcessed('trade-1');
      positionManager.markTradeProcessed('trade-1'); // Duplicate

      const summary = positionManager.getSummary();
      // Set should handle duplicates automatically
      expect(summary.processedTradeCount).toBe(1);
    });
  });

  describe('clearAllPositions', () => {
    it('should clear all user and target positions', () => {
      positionManager.updatePosition(createMockTrade({ asset: 'token-1' }), true);
      positionManager.updatePosition(createMockTrade({ asset: 'token-2' }), false);
      positionManager.markTradeProcessed('trade-1');

      positionManager.clearAllPositions();

      expect(positionManager.getAllUserPositions()).toEqual([]);
      expect(positionManager.getAllTargetPositions()).toEqual([]);
      expect(positionManager.isTradeProcessed('trade-1')).toBe(false);
    });
  });

  describe('persistence', () => {
    it('should attempt to save state after position update', async () => {
      vi.mocked(fs.mkdir).mockResolvedValue(undefined);
      vi.mocked(fs.writeFile).mockResolvedValue(undefined);

      const trade = createMockTrade({ asset: 'token-1' });
      positionManager.updatePosition(trade, true);

      // Wait for async save to complete
      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(fs.mkdir).toHaveBeenCalled();
      expect(fs.writeFile).toHaveBeenCalled();
    });

    it('should create state directory if missing', async () => {
      vi.mocked(fs.mkdir).mockResolvedValue(undefined);
      vi.mocked(fs.writeFile).mockResolvedValue(undefined);

      const trade = createMockTrade({ asset: 'token-1' });
      positionManager.updatePosition(trade, true);

      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(fs.mkdir).toHaveBeenCalledWith(expect.stringContaining('test-state'), {
        recursive: true,
      });
    });

    it('should retry on save failure', async () => {
      vi.mocked(fs.mkdir).mockResolvedValue(undefined);
      vi.mocked(fs.writeFile)
        .mockRejectedValueOnce(new Error('Disk full'))
        .mockRejectedValueOnce(new Error('Disk full'))
        .mockResolvedValueOnce(undefined); // Success on 3rd try

      const trade = createMockTrade({ asset: 'token-1' });
      positionManager.updatePosition(trade, true);

      // Wait for retries (1s + 2s + 4s = 7s, plus overhead)
      await new Promise((resolve) => setTimeout(resolve, 8000));

      expect(fs.writeFile).toHaveBeenCalledTimes(3);
    }, 10000); // Increase test timeout to 10 seconds

    it('should save state with all required fields', async () => {
      vi.mocked(fs.mkdir).mockResolvedValue(undefined);

      let savedData: string = '';
      vi.mocked(fs.writeFile).mockImplementation(async (path, data) => {
        savedData = data as string;
      });

      positionManager.updatePosition(createMockTrade({ asset: 'token-1' }), true);
      positionManager.updatePosition(createMockTrade({ asset: 'token-2' }), false);
      positionManager.markTradeProcessed('trade-1');

      await new Promise((resolve) => setTimeout(resolve, 100));

      const state = JSON.parse(savedData);
      expect(state).toHaveProperty('userPositions');
      expect(state).toHaveProperty('targetPositions');
      expect(state).toHaveProperty('processedTradeIds');
      expect(state).toHaveProperty('lastSaved');
    });
  });

  describe('getSummary', () => {
    it('should return empty summary for new instance', () => {
      const summary = positionManager.getSummary();

      expect(summary.userPositionCount).toBe(0);
      expect(summary.targetPositionCount).toBe(0);
      expect(summary.userTotalValue).toBe(0);
      expect(summary.targetTotalValue).toBe(0);
      expect(summary.processedTradeCount).toBe(0);
    });

    it('should calculate position counts correctly', () => {
      positionManager.updatePosition(createMockTrade({ asset: 'token-1' }), true);
      positionManager.updatePosition(createMockTrade({ asset: 'token-2' }), true);
      positionManager.updatePosition(createMockTrade({ asset: 'token-3' }), false);

      const summary = positionManager.getSummary();

      expect(summary.userPositionCount).toBe(2);
      expect(summary.targetPositionCount).toBe(1);
    });

    it('should calculate total values correctly', () => {
      const trade1 = createMockTrade({
        asset: 'token-1',
        size: '100',
        price: '0.5',
      });
      const trade2 = createMockTrade({
        asset: 'token-2',
        size: '200',
        price: '0.3',
      });

      positionManager.updatePosition(trade1, true);
      positionManager.updatePosition(trade2, true);

      const summary = positionManager.getSummary();

      // value1 = 100 * 0.5 = 50
      // value2 = 200 * 0.3 = 60
      // total = 110
      expect(summary.userTotalValue).toBe(110);
    });

    it('should track processed trade count', () => {
      positionManager.markTradeProcessed('trade-1');
      positionManager.markTradeProcessed('trade-2');
      positionManager.markTradeProcessed('trade-3');

      const summary = positionManager.getSummary();

      expect(summary.processedTradeCount).toBe(3);
    });
  });

  describe('edge cases', () => {
    it('should handle very large position sizes', () => {
      const trade = createMockTrade({
        asset: 'token-1',
        size: '1000000',
        price: '0.5',
      });

      positionManager.updatePosition(trade, true);

      const position = positionManager.getUserPosition('token-1');
      expect(position?.size).toBe(1000000);
      expect(position?.value).toBe(500000);
    });

    it('should handle very small position sizes', () => {
      const trade = createMockTrade({
        asset: 'token-1',
        size: '0.01',
        price: '0.01',
      });

      positionManager.updatePosition(trade, true);

      const position = positionManager.getUserPosition('token-1');
      expect(position?.size).toBe(0.01);
      expect(position?.value).toBeCloseTo(0.0001, 6);
    });

    it('should handle multiple positions for same token (different user/target)', () => {
      const trade = createMockTrade({ asset: 'token-1', size: '100', price: '0.5' });

      positionManager.updatePosition(trade, true); // User
      positionManager.updatePosition(trade, false); // Target

      const userPos = positionManager.getUserPosition('token-1');
      const targetPos = positionManager.getTargetPosition('token-1');

      expect(userPos?.size).toBe(100);
      expect(targetPos?.size).toBe(100);
      expect(userPos).not.toBe(targetPos); // Different objects
    });

    it('should handle rapid consecutive updates to same position', () => {
      const trades = [
        createMockTrade({ asset: 'token-1', size: '10', price: '0.5', side: Side.BUY }),
        createMockTrade({ asset: 'token-1', size: '20', price: '0.6', side: Side.BUY }),
        createMockTrade({ asset: 'token-1', size: '30', price: '0.4', side: Side.BUY }),
      ];

      for (const trade of trades) {
        positionManager.updatePosition(trade, true);
      }

      const position = positionManager.getUserPosition('token-1');
      expect(position?.size).toBe(60); // 10 + 20 + 30
      // avgPrice = (10*0.5 + 20*0.6 + 30*0.4) / 60 = (5 + 12 + 12) / 60 = 29/60 ≈ 0.483
      expect(position?.avgPrice).toBeCloseTo(0.483, 2);
    });

    it('should update lastUpdated timestamp correctly', () => {
      const timestamp1 = Date.now();
      const trade1 = createMockTrade({ asset: 'token-1', timestamp: timestamp1 });
      positionManager.updatePosition(trade1, true);

      const timestamp2 = timestamp1 + 10000;
      const trade2 = createMockTrade({
        asset: 'token-1',
        side: Side.BUY,
        size: '10',
        timestamp: timestamp2,
      });
      positionManager.updatePosition(trade2, true);

      const position = positionManager.getUserPosition('token-1');
      expect(position?.lastUpdated).toBe(timestamp2);
    });
  });

  describe('integration scenarios', () => {
    it('should handle complete position lifecycle', () => {
      // Open position
      const trade1 = createMockTrade({
        asset: 'token-1',
        side: Side.BUY,
        size: '100',
        price: '0.5',
      });
      positionManager.updatePosition(trade1, true);
      expect(positionManager.getUserPosition('token-1')?.size).toBe(100);

      // Add to position
      const trade2 = createMockTrade({
        asset: 'token-1',
        side: Side.BUY,
        size: '50',
        price: '0.6',
      });
      positionManager.updatePosition(trade2, true);
      expect(positionManager.getUserPosition('token-1')?.size).toBe(150);

      // Reduce position
      const trade3 = createMockTrade({
        asset: 'token-1',
        side: Side.SELL,
        size: '100',
        price: '0.7',
      });
      positionManager.updatePosition(trade3, true);
      expect(positionManager.getUserPosition('token-1')?.size).toBe(50);

      // Close position
      const trade4 = createMockTrade({
        asset: 'token-1',
        side: Side.SELL,
        size: '50',
        price: '0.8',
      });
      positionManager.updatePosition(trade4, true);
      expect(positionManager.getUserPosition('token-1')).toBeNull();
    });

    it('should handle multiple positions simultaneously', () => {
      const tokens = ['token-1', 'token-2', 'token-3'];

      for (const tokenId of tokens) {
        const trade = createMockTrade({ asset: tokenId });
        positionManager.updatePosition(trade, true);
      }

      expect(positionManager.getAllUserPositions()).toHaveLength(3);

      // Close one position
      const closeTrade = createMockTrade({
        asset: 'token-2',
        side: Side.SELL,
        size: '100',
      });
      positionManager.updatePosition(closeTrade, true);

      expect(positionManager.getAllUserPositions()).toHaveLength(2);
      expect(positionManager.getUserPosition('token-2')).toBeNull();
    });
  });
});
