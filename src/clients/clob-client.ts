import { ClobClient, OrderType } from '@polymarket/clob-client';
import { SignatureType } from '@polymarket/order-utils';
import { Contract, providers, Wallet } from 'ethers';
import type { Config } from '../config/index.js';
import { createChildLogger } from '../logger/index.js';
import type {
  ClobApiCredentials,
  ClobCancelParams,
  ClobOrderParams,
  OpenOrder,
} from '../types/clob-api.js';
import { ERC20_ABI, USDC_DECIMALS, USDC_POLYGON_ADDRESS } from '../types/ethers-extensions.js';
import type { OrderRequest, OrderResponse } from '../types/polymarket.js';

const logger = createChildLogger({ module: 'ClobClient' });

/**
 * Wrapper for Polymarket CLOB client with error handling and retry logic
 */
export class PolymarketClobClient {
  private client: ClobClient;
  private wallet: Wallet;
  private funderAddress: string;

  // Balance caching to avoid hammering Polygon RPC
  private balanceCache: number | null = null;
  private balanceCacheTimestamp = 0;
  private readonly BALANCE_CACHE_TTL_MS = 60000; // 60 seconds

  // Rate limiting for Polymarket API calls (with proper queuing)
  private lastApiCallPromise: Promise<void> = Promise.resolve();
  private readonly API_CALL_COOLDOWN_MS = 500; // 500ms between calls

  private constructor(client: ClobClient, wallet: Wallet, funderAddress: string) {
    this.client = client;
    this.wallet = wallet;
    this.funderAddress = funderAddress;
  }

  /**
   * Create and initialize a CLOB client
   * API credentials are automatically derived from the private key
   */
  static async create(config: Config): Promise<PolymarketClobClient> {
    // Create wallet from private key
    const privateKey = config.wallet.privateKey.startsWith('0x')
      ? config.wallet.privateKey
      : `0x${config.wallet.privateKey}`;

    // Connect wallet to Polygon RPC provider
    const provider = new providers.JsonRpcProvider(
      config.system.polygonRpcUrl || 'https://polygon-rpc.com'
    );
    const wallet = new Wallet(privateKey, provider);

    // Use manual credentials if provided, otherwise auto-derive
    let credentials: ClobApiCredentials;

    if (config.wallet.apiKey && config.wallet.apiSecret && config.wallet.apiPassphrase) {
      // Use provided credentials
      credentials = {
        key: config.wallet.apiKey,
        secret: config.wallet.apiSecret,
        passphrase: config.wallet.apiPassphrase,
      };

      logger.info(
        {
          address: wallet.address,
          apiKeyPrefix: `${config.wallet.apiKey.substring(0, 8)}...`,
        },
        'Using manual API credentials'
      );
    } else {
      // Auto-derive credentials from private key
      logger.info(
        { address: wallet.address, funder: config.wallet.funderAddress },
        'Deriving API credentials from private key...'
      );

      const tempClient = new ClobClient(
        'https://clob.polymarket.com',
        137,
        wallet,
        undefined,
        SignatureType.POLY_GNOSIS_SAFE,
        config.wallet.funderAddress
      );

      try {
        // Get current nonce for proper credential derivation
        const nonce = await provider.getTransactionCount(wallet.address);
        logger.debug({ nonce, address: wallet.address }, 'Using nonce for API credential derivation');

        const derivedCreds = await tempClient.createOrDeriveApiKey(nonce);

        if (!derivedCreds || !derivedCreds.key || !derivedCreds.secret || !derivedCreds.passphrase) {
          throw new Error(
            'API credential derivation returned invalid or empty credentials. ' +
              'This may indicate the wallet is not properly set up on Polymarket.'
          );
        }

        credentials = {
          key: derivedCreds.key,
          secret: derivedCreds.secret,
          passphrase: derivedCreds.passphrase,
        };

        logger.info(
          {
            address: wallet.address,
            apiKeyPrefix: `${derivedCreds.key.substring(0, 8)}...`,
          },
          'API credentials derived successfully'
        );
      } catch (error) {
        logger.error(
          {
            address: wallet.address,
            error: error instanceof Error ? error.message : String(error),
          },
          'Failed to derive API credentials'
        );
        throw new Error(
          `Failed to derive API credentials: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }

    // Initialize ClobClient with wallet, credentials, and funder address
    // SignatureType: EOA, POLY_PROXY, POLY_GNOSIS_SAFE
    const client = new ClobClient(
      'https://clob.polymarket.com',
      137, // Polygon mainnet
      wallet,
      credentials,
      SignatureType.POLY_GNOSIS_SAFE, // Gnosis Safe proxy wallet
      config.wallet.funderAddress // funder address for orders
    );

    // Log configuration for debugging
    logger.debug(
      {
        l1Wallet: wallet.address,
        funderAddress: config.wallet.funderAddress,
        signatureType: 'POLY_PROXY',
        chainId: 137,
      },
      'CLOB Client configuration'
    );

    // Verify credentials work by testing API access
    try {
      logger.info({ address: wallet.address }, 'Verifying API credentials...');
      await client.getOpenOrders();
      logger.info({ address: wallet.address }, 'API credentials verified successfully');
    } catch (error) {
      logger.error(
        {
          address: wallet.address,
          error: error instanceof Error ? error.message : String(error),
        },
        'API credential verification failed'
      );
      throw new Error(
        `API credentials verification failed: ${error instanceof Error ? error.message : String(error)}. ` +
          `Please ensure your wallet (${wallet.address}) is properly set up on Polymarket and has deposit permissions.`
      );
    }

    logger.info({ address: wallet.address }, 'CLOB client initialized');

    return new PolymarketClobClient(client, wallet, config.wallet.funderAddress);
  }

  /**
   * Get wallet address
   */
  getAddress(): string {
    return this.wallet.address;
  }

  /**
   * Ensure rate limit between API calls (1 second cooldown)
   * Properly queues concurrent calls to prevent race conditions
   */
  private async ensureRateLimit(): Promise<void> {
    // Chain this call after the previous one
    const currentPromise = this.lastApiCallPromise.then(async () => {
      // Wait for cooldown period
      await new Promise((resolve) => setTimeout(resolve, this.API_CALL_COOLDOWN_MS));
      logger.debug({ cooldownMs: this.API_CALL_COOLDOWN_MS }, 'Rate limit cooldown completed');
    });

    // Update the chain for the next call
    this.lastApiCallPromise = currentPromise;

    // Wait for our turn
    await currentPromise;
  }

  /**
   * Create a market order
   */
  async createOrder(order: OrderRequest, maxRetries = 3): Promise<OrderResponse> {
    const { tokenID, price, size, side } = order;

    logger.info(
      {
        tokenID,
        price,
        size,
        side,
        orderType: 'GTC',
      },
      'Creating order'
    );

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        // Rate limit before API call
        await this.ensureRateLimit();

        const params: ClobOrderParams = {
          tokenID,
          price,
          side,
          size,
        };

        // Debug logging for signature validation issues
        logger.debug(
          {
            tokenID,
            tokenIDType: typeof tokenID,
            tokenIDLength: tokenID.length,
            maker: this.funderAddress,
            signer: this.wallet.address,
            price,
            size,
            side,
          },
          'Creating order with parameters'
        );

        // Create and post the order in one call
        // Returns orderID (string) or full order object (when matched)
        const orderResponse = await this.client.createAndPostOrder(params, {}, OrderType.GTC);

        let orderId: string;
        let orderStatus: string = 'LIVE';

        // Handle different response formats
        if (orderResponse && typeof orderResponse === 'object') {
          const response = orderResponse as any;

          // Check for error
          if (response.error || response.status === 400) {
            throw new Error(
              `Order creation failed: ${response.error || 'Unknown error'} (status: ${response.status})`
            );
          }

          // Extract orderID from successful response
          if (response.orderID) {
            orderId = response.orderID;
            orderStatus = response.status || 'MATCHED';

            logger.info(
              {
                orderID: orderId,
                status: orderStatus,
                takingAmount: response.takingAmount,
                makingAmount: response.makingAmount,
                txHash: response.transactionsHashes?.[0],
              },
              'Order matched successfully'
            );
          } else {
            throw new Error(
              `Invalid order response: ${JSON.stringify(orderResponse)}`
            );
          }
        } else if (typeof orderResponse === 'string') {
          // String response (pending order)
          orderId = orderResponse;
          logger.info(
            {
              orderID: orderId,
              status: 'LIVE',
            },
            'Order created successfully'
          );
        } else {
          throw new Error(
            `Invalid order response: ${JSON.stringify(orderResponse)}`
          );
        }

        const response: OrderResponse = {
          orderID: orderId,
          status: orderStatus,
        };

        return response;
      } catch (error) {
        logger.error(
          {
            attempt,
            maxRetries,
            error: error instanceof Error ? error.message : String(error),
          },
          'Failed to create order'
        );

        if (attempt === maxRetries) {
          throw new Error(
            `Failed to create order after ${maxRetries} attempts: ${error instanceof Error ? error.message : String(error)}`
          );
        }

        // Exponential backoff
        const delay = Math.min(1000 * 2 ** (attempt - 1), 10000);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }

    throw new Error('Unexpected error in createOrder');
  }

  /**
   * Cancel an order
   */
  async cancelOrder(orderId: string): Promise<void> {
    logger.info({ orderId }, 'Cancelling order');

    try {
      // Rate limit before API call
      await this.ensureRateLimit();

      const params: ClobCancelParams = { orderID: orderId };
      await this.client.cancelOrder(params);
      logger.info({ orderId }, 'Order cancelled successfully');
    } catch (error) {
      logger.error(
        {
          orderId,
          error: error instanceof Error ? error.message : String(error),
        },
        'Failed to cancel order'
      );
      throw error;
    }
  }

  /**
   * Get user's open orders
   */
  async getOpenOrders(): Promise<OpenOrder[]> {
    try {
      // Rate limit before API call
      await this.ensureRateLimit();

      const orders = await this.client.getOpenOrders();
      return orders;
    } catch (error) {
      logger.error(
        {
          error: error instanceof Error ? error.message : String(error),
        },
        'Failed to get open orders'
      );
      throw error;
    }
  }

  /**
   * Get order by ID
   */
  async getOrder(orderId: string): Promise<OpenOrder> {
    try {
      // Rate limit before API call
      await this.ensureRateLimit();

      const order = await this.client.getOrder(orderId);
      return order;
    } catch (error) {
      logger.error(
        {
          orderId,
          error: error instanceof Error ? error.message : String(error),
        },
        'Failed to get order'
      );
      throw error;
    }
  }

  /**
   * Get user's USDC balance on Polymarket
   *
   * Queries USDC balance directly from Polygon for funder address (proxy wallet)
   * Cached for 60 seconds to avoid rate limiting on Polygon RPC
   */
  async getBalance(): Promise<number> {
    try {
      // Check cache validity
      const now = Date.now();
      const cacheAge = now - this.balanceCacheTimestamp;
      const isCacheValid = this.balanceCache !== null && cacheAge < this.BALANCE_CACHE_TTL_MS;

      if (isCacheValid) {
        logger.debug(
          {
            balance: this.balanceCache,
            cacheAgeMs: cacheAge,
            ttlMs: this.BALANCE_CACHE_TTL_MS,
          },
          'Using cached balance'
        );
        return this.balanceCache as number;
      }

      // Cache miss or expired - fetch from blockchain
      const provider = this.wallet.provider;
      if (!provider) {
        throw new Error('Wallet provider not available');
      }

      const usdcContract = new Contract(USDC_POLYGON_ADDRESS, ERC20_ABI, provider);
      const funderBalanceRaw = await usdcContract.balanceOf(this.funderAddress);
      const funderBalance = Number(funderBalanceRaw.toString()) / 10 ** USDC_DECIMALS;

      // Update cache
      this.balanceCache = funderBalance;
      this.balanceCacheTimestamp = now;

      logger.debug(
        {
          balance: funderBalance,
          cacheTTLSeconds: this.BALANCE_CACHE_TTL_MS / 1000,
        },
        'Balance fetched from RPC (now cached)'
      );

      return funderBalance;
    } catch (error) {
      logger.error(
        {
          error: error instanceof Error ? error.message : String(error),
          signerAddress: this.wallet.address,
          funderAddress: this.funderAddress,
        },
        'Failed to get balance'
      );
      throw error;
    }
  }

  /**
   * Get market best bid/ask prices
   */
  async getBestPrices(tokenId: string): Promise<{ bid: number; ask: number } | null> {
    try {
      // Rate limit before API call
      await this.ensureRateLimit();

      const orderBook = await this.client.getOrderBook(tokenId);

      // Validate orderBook structure (can be malformed during geoblocking or API errors)
      if (!orderBook || typeof orderBook !== 'object') {
        logger.warn(
          {
            tokenId,
            rawResponse: orderBook,
            responseType: typeof orderBook,
          },
          'Invalid order book response - not an object'
        );
        return null;
      }

      // Check if this is a 404 error (market closed/settled - expected)
      const isMarketClosed = (orderBook as any).error && (orderBook as any).status === 404;

      // Safely extract bids/asks arrays (may be undefined in malformed responses)
      const bids = Array.isArray(orderBook.bids) ? orderBook.bids : [];
      const asks = Array.isArray(orderBook.asks) ? orderBook.asks : [];

      // Log when bids/asks are missing or invalid (but not for closed markets)
      if (!Array.isArray(orderBook.bids) || !Array.isArray(orderBook.asks)) {
        if (isMarketClosed) {
          logger.debug(
            { tokenId, error: (orderBook as any).error },
            'Order book not available (market likely closed/settled)'
          );
        } else {
          logger.warn(
            {
              tokenId,
              rawResponse: orderBook,
              hasBids: !!orderBook.bids,
              hasAsks: !!orderBook.asks,
            },
            'Order book missing bids/asks arrays - unexpected API response'
          );
        }
      }

      const bestBid = bids.length > 0 && bids[0] ? Number(bids[0].price) : 0;
      const bestAsk = asks.length > 0 && asks[0] ? Number(asks[0].price) : 0;

      // Debug: Log order book details to help diagnose price issues
      logger.debug(
        {
          tokenId,
          bestBid: bestBid.toFixed(4),
          bestAsk: bestAsk.toFixed(4),
          bidCount: bids.length,
          askCount: asks.length,
          topBids: bids.slice(0, 3).map((b: any) => `${b.price}@${b.size}`),
          topAsks: asks.slice(0, 3).map((a: any) => `${a.price}@${a.size}`),
        },
        'Order book fetched'
      );

      return { bid: bestBid, ask: bestAsk };
    } catch (error: any) {
      // Handle 404 as market closed/settled (expected)
      if (error.response?.status === 404 || error.status === 404) {
        logger.debug(
          {
            tokenId,
            error: error.response?.data?.error || error.message,
          },
          'Order book not available (market closed/settled)'
        );
        return null;
      }

      // Log unexpected errors
      logger.error(
        {
          tokenId,
          status: error.response?.status || error.status,
          error: error.response?.data?.error || error.message || String(error),
        },
        'Failed to get best prices'
      );
      return null;
    }
  }
}
