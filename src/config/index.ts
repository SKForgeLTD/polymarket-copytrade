import dotenv from 'dotenv';
import { z } from 'zod';

// Load environment variables
dotenv.config();

// Configuration schema with validation
const configSchema = z.object({
  // Wallet
  wallet: z.object({
    privateKey: z
      .string()
      .min(64, 'PRIVATE_KEY must be at least 64 characters')
      .regex(/^[0-9a-fA-F]+$/, 'PRIVATE_KEY must be a valid hex string'),
    funderAddress: z
      .string()
      .regex(/^0x[0-9a-fA-F]{40}$/, 'FUNDER_ADDRESS must be a valid Ethereum address'),
    // Optional manual API credentials (if not provided, auto-derives from private key)
    apiKey: z.string().optional(),
    apiSecret: z.string().optional(),
    apiPassphrase: z.string().optional(),
  }),

  // Trading
  trading: z.object({
    targetTraderAddress: z
      .string()
      .regex(/^0x[0-9a-fA-F]{40}$/, 'TARGET_TRADER_ADDRESS must be a valid Ethereum address'),
    copyRatio: z.number().min(0.0001).max(1.0),
    maxPositionSizeUsd: z.number().positive(),
    minTradeSizeUsd: z.number().positive(),
    maxPortfolioExposure: z.number().min(0.1).max(1.0),
  }),

  // Risk Management
  risk: z.object({
    maxConsecutiveFailures: z.number().int().positive(),
    circuitBreakerCooldownMinutes: z.number().positive(),
    tradeCooldownMs: z.number().nonnegative(),
  }),

  // Monitoring
  monitoring: z.object({
    pollingIntervalSeconds: z.number().positive(),
  }),

  // System
  system: z.object({
    logLevel: z.enum(['debug', 'info', 'warn', 'error']),
    nodeEnv: z.enum(['development', 'production', 'test']),
    polygonRpcUrl: z.string().url().optional(),
  }),

  // Web Interface
  web: z.object({
    enabled: z.boolean().default(false),
    port: z.number().int().min(1024).max(65535).default(3000),
    host: z.string().default('localhost'),
    authToken: z.string().optional(),
    rateLimitPerMin: z.number().int().positive().default(60),
  }),
});

export type Config = z.infer<typeof configSchema>;

/**
 * Load and validate configuration from environment variables
 */
export function loadConfig(): Config {
  try {
    const config = configSchema.parse({
      wallet: {
        privateKey: process.env.PRIVATE_KEY,
        funderAddress: process.env.FUNDER_ADDRESS,
        apiKey: process.env.POLYMARKET_API_KEY,
        apiSecret: process.env.POLYMARKET_API_SECRET,
        apiPassphrase: process.env.POLYMARKET_API_PASSPHRASE,
      },
      trading: {
        targetTraderAddress: process.env.TARGET_TRADER_ADDRESS,
        copyRatio: Number(process.env.COPY_RATIO) || 0.1,
        maxPositionSizeUsd: Number(process.env.MAX_POSITION_SIZE_USD) || 10,
        minTradeSizeUsd: Number(process.env.MIN_TRADE_SIZE_USD) || 0.5,
        maxPortfolioExposure: Number(process.env.MAX_PORTFOLIO_EXPOSURE) || 0.8,
      },
      risk: {
        maxConsecutiveFailures: Number(process.env.MAX_CONSECUTIVE_FAILURES) || 5,
        circuitBreakerCooldownMinutes: Number(process.env.CIRCUIT_BREAKER_COOLDOWN_MINUTES) || 5,
        tradeCooldownMs: Number(process.env.TRADE_COOLDOWN_MS) || 10, // 10ms for HFT (100 trades/sec max)
      },
      monitoring: {
        pollingIntervalSeconds: Number(process.env.POLLING_INTERVAL_SECONDS) || 10,
      },
      system: {
        logLevel: process.env.LOG_LEVEL || 'info',
        nodeEnv: process.env.NODE_ENV || 'development',
        polygonRpcUrl: process.env.POLYGON_RPC_URL,
      },
      web: {
        enabled: process.env.WEB_ENABLED === 'true',
        port: Number(process.env.WEB_PORT) || 3000,
        host: process.env.WEB_HOST || 'localhost',
        authToken: process.env.WEB_AUTH_TOKEN,
        rateLimitPerMin: Number(process.env.WEB_RATE_LIMIT_PER_MIN) || 60,
      },
    });

    return config;
  } catch (error) {
    if (error instanceof z.ZodError) {
      console.error('Configuration validation failed:');
      for (const issue of error.issues) {
        console.error(`  - ${issue.path.join('.')}: ${issue.message}`);
      }
      throw new Error('Invalid configuration. Please check your .env file.');
    }
    throw error;
  }
}

// Export a singleton config instance
export const config = loadConfig();
