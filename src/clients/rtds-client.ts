import { EventEmitter } from 'node:events';
import { Side } from '@polymarket/clob-client';
import {
  ConnectionStatus,
  type Message,
  RealTimeDataClient,
} from '@polymarket/real-time-data-client';
import { createChildLogger } from '../logger/index.js';
import type { Trade } from '../types/polymarket.js';

const logger = createChildLogger({ module: 'RTDSClient' });

/**
 * Events emitted by RTDSClient
 */
interface RTDSClientEvents {
  trade: (trade: Trade) => void;
  connected: () => void;
  disconnected: () => void;
  error: (error: Error) => void;
}

/**
 * RTDS activity/trades payload schema
 * Based on @polymarket/real-time-data-client documentation
 */
interface ActivityTradePayload {
  proxyWallet: string;
  conditionId: string;
  asset: string;
  side: string; // 'BUY' or 'SELL' string, not enum
  size: number | string;
  price: number | string;
  timestamp: number;
  outcome: string;
  transactionHash?: string;
  // Market metadata (may be included in payloads)
  title?: string;
  slug?: string;
  icon?: string;
  eventSlug?: string;
}

/**
 * Wrapper for Polymarket Real-Time Data Service client
 */
export class PolymarketRTDSClient extends EventEmitter {
  private client: RealTimeDataClient;
  private targetAddress: string;
  private connected = false;

  constructor(targetAddress: string) {
    super();
    this.targetAddress = targetAddress.toLowerCase();

    // Initialize RTDS client with proper callbacks
    this.client = new RealTimeDataClient({
      autoReconnect: true,
      onConnect: () => {
        this.handleConnect();
      },
      onMessage: (_client: RealTimeDataClient, message: Message) => {
        this.handleMessage(message);
      },
      onStatusChange: (status: ConnectionStatus) => {
        this.handleStatusChange(status);
      },
    });

    logger.info({ targetAddress: this.targetAddress }, 'RTDS client created');
  }

  /**
   * Connect to RTDS
   */
  connect(): void {
    logger.info('Connecting to Real-Time Data Service...');
    this.client.connect();
  }

  /**
   * Disconnect from RTDS
   */
  disconnect(): void {
    try {
      if (this.connected) {
        this.client.disconnect();
        this.connected = false;
        this.emit('disconnected');
        logger.info('Disconnected from RTDS');
      }
    } catch (error) {
      logger.error(
        {
          error: error instanceof Error ? error.message : String(error),
        },
        'Error disconnecting from RTDS'
      );
    }
  }

  /**
   * Check if connected
   */
  isConnected(): boolean {
    return this.connected;
  }

  /**
   * Handle connection established
   */
  private handleConnect(): void {
    this.connected = true;
    this.emit('connected');
    logger.info({ targetAddress: this.targetAddress }, 'Connected to RTDS');

    // Subscribe to all trades on the activity topic with retry logic
    // Note: RTDS doesn't support filtering by specific user address in the subscription
    // We filter client-side in handleMessage() by checking the maker address
    this.subscribeWithRetry().catch((error) => {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error({ error: errorMessage }, 'Failed to subscribe after retries');
      this.emit('error', error instanceof Error ? error : new Error(errorMessage));
    });
  }

  /**
   * Subscribe to activity/trades with exponential backoff retry
   */
  private async subscribeWithRetry(): Promise<void> {
    const maxRetries = 3;
    const baseDelay = 1000; // 1 second

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        this.client.subscribe({
          subscriptions: [
            {
              topic: 'activity',
              type: 'trades',
              // No filters - we receive all trades and filter client-side
            },
          ],
        });
        logger.info('Subscribed to activity/trades topic');
        return;
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);

        if (attempt < maxRetries) {
          const delay = baseDelay * 2 ** attempt;
          logger.warn(
            { error: errorMessage, attempt: attempt + 1, maxRetries, delayMs: delay },
            'Failed to subscribe, retrying...'
          );
          await new Promise((resolve) => setTimeout(resolve, delay));
        } else {
          logger.error({ error: errorMessage, attempt: attempt + 1 }, 'Failed to subscribe');
          throw error instanceof Error ? error : new Error(errorMessage);
        }
      }
    }
  }

  /**
   * Handle incoming message
   */
  private handleMessage(message: Message): void {
    try {
      // Only process trade messages from activity topic
      if (message.topic !== 'activity' || message.type !== 'trades') {
        return;
      }

      // Extract payload - the actual trade data is in message.payload
      // Type guard to check if payload has required trade fields
      if (!this.isTradePayload(message.payload)) {
        logger.debug({ payload: message.payload }, 'Received non-trade payload on activity topic');
        return;
      }

      // TypeScript now knows payload is ActivityTradePayload
      const payload = message.payload;

      // Only process trades where target is the proxy wallet (they initiated)
      // The payload uses 'proxyWallet' field for the trader's address
      const traderAddress = payload.proxyWallet.toLowerCase();
      if (traderAddress !== this.targetAddress) {
        return;
      }

      // Validate side field before converting to enum
      if (payload.side !== 'BUY' && payload.side !== 'SELL') {
        logger.warn(
          { side: payload.side, payload },
          'Invalid side value in trade payload, expected BUY or SELL'
        );
        return;
      }

      // Convert to Trade format (using real API field names)
      const side = payload.side === 'BUY' ? Side.BUY : Side.SELL;

      const trade: Trade = {
        proxyWallet: payload.proxyWallet,
        side,
        asset: payload.asset,
        conditionId: payload.conditionId,
        size: String(payload.size), // Convert to string for consistency
        price: String(payload.price),
        timestamp: payload.timestamp * 1000, // Convert Unix seconds to milliseconds
        outcome: payload.outcome,
        ...(payload.transactionHash && { transactionHash: payload.transactionHash }),
        ...(payload.title && { title: payload.title }),
        ...(payload.slug && { slug: payload.slug }),
        ...(payload.icon && { icon: payload.icon }),
        ...(payload.eventSlug && { eventSlug: payload.eventSlug }),
      };

      // Log with readable market name
      const marketName =
        trade.title ||
        trade.slug ||
        `${trade.conditionId.substring(0, 6)}...${trade.conditionId.substring(trade.conditionId.length - 4)}`;

      logger.info(
        {
          market: marketName,
          outcome: trade.outcome,
          side: trade.side,
          size: trade.size,
          price: trade.price,
        },
        '📥 Trade detected'
      );

      this.emit('trade', trade);
    } catch (error) {
      logger.error(
        {
          error: error instanceof Error ? error.message : String(error),
          message,
        },
        'Failed to handle message'
      );
    }
  }

  /**
   * Type guard to check if payload is a trade payload from activity topic
   * Based on RTDS README schema for activity/trades
   */
  private isTradePayload(payload: unknown): payload is ActivityTradePayload {
    if (typeof payload !== 'object' || payload === null) {
      return false;
    }
    const p = payload as Record<string, unknown>;
    return (
      typeof p.proxyWallet === 'string' &&
      typeof p.conditionId === 'string' &&
      typeof p.asset === 'string' &&
      typeof p.side === 'string' &&
      (typeof p.size === 'number' || typeof p.size === 'string') &&
      (typeof p.price === 'number' || typeof p.price === 'string') &&
      typeof p.timestamp === 'number' &&
      typeof p.outcome === 'string'
    );
  }

  /**
   * Handle status change
   */
  private handleStatusChange(status: ConnectionStatus): void {
    logger.debug({ status }, 'Connection status changed');

    if (status === ConnectionStatus.DISCONNECTED && this.connected) {
      this.connected = false;
      this.emit('disconnected');
    }
  }

  /**
   * Type-safe event listener registration
   */
  override on<K extends keyof RTDSClientEvents>(event: K, listener: RTDSClientEvents[K]): this {
    return super.on(event, listener);
  }

  override once<K extends keyof RTDSClientEvents>(event: K, listener: RTDSClientEvents[K]): this {
    return super.once(event, listener);
  }

  override emit<K extends keyof RTDSClientEvents>(
    event: K,
    ...args: Parameters<RTDSClientEvents[K]>
  ): boolean {
    return super.emit(event, ...args);
  }
}
