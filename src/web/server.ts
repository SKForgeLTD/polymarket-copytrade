/**
 * Fastify web server for monitoring dashboard
 */

import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import Fastify, { type FastifyInstance } from 'fastify';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Config } from '../config/index.js';
import { createChildLogger } from '../logger/index.js';
import type { Orchestrator } from '../orchestrator.js';
import { SSEManager } from './sse-manager.js';
import type { BotStatusResponse, RecentTradesResponse } from './types/api.js';

const logger = createChildLogger({ module: 'WebServer' });

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Web server for monitoring dashboard
 */
export class WebServer {
  private server: FastifyInstance;
  private config: Config;
  private orchestrator: Orchestrator;
  private sseManager: SSEManager;
  private startTime: number;

  constructor(config: Config, orchestrator: Orchestrator, sseManager: SSEManager) {
    this.config = config;
    this.orchestrator = orchestrator;
    this.sseManager = sseManager;
    this.startTime = Date.now();

    this.server = Fastify({
      logger: false, // Use our Pino logger instead
    });

    this.setupMiddleware();
    this.setupRoutes();
  }

  /**
   * Set up middleware
   */
  private setupMiddleware(): void {
    // CORS
    this.server.register(cors, {
      origin: true,
    });

    // Rate limiting
    this.server.register(rateLimit, {
      max: this.config.web.rateLimitPerMin,
      timeWindow: '1 minute',
    });

    // Optional authentication
    if (this.config.web.authToken) {
      this.server.addHook('onRequest', async (request, reply) => {
        // Skip auth for dashboard HTML and static files
        if (
          request.url === '/' ||
          request.url.startsWith('/static/') ||
          request.url.startsWith('/views/')
        ) {
          return;
        }

        const authHeader = request.headers.authorization;
        const token = authHeader?.replace('Bearer ', '');

        if (token !== this.config.web.authToken) {
          reply.code(401).send({ error: 'Unauthorized' });
        }
      });
    }
  }

  /**
   * Set up routes
   */
  private setupRoutes(): void {
    // Dashboard HTML
    this.server.get('/', async (_request, reply) => {
      try {
        const htmlPath = join(__dirname, 'views', 'dashboard.html');
        const html = readFileSync(htmlPath, 'utf-8');
        reply.type('text/html').send(html);
      } catch (error) {
        logger.error({ error }, 'Failed to serve dashboard HTML');
        reply.code(500).send({ error: 'Failed to load dashboard' });
      }
    });

    // Static files
    this.server.get('/static/:file', async (request, reply) => {
      const params = request.params as { file: string };
      const { file } = params;

      // Security: prevent directory traversal
      if (file.includes('..') || file.includes('/')) {
        reply.code(400).send({ error: 'Invalid file path' });
        return;
      }

      try {
        const filePath = join(__dirname, 'static', file);
        const content = readFileSync(filePath, 'utf-8');

        // Set content type based on extension
        if (file.endsWith('.js')) {
          reply.type('application/javascript');
        } else if (file.endsWith('.css')) {
          reply.type('text/css');
        } else {
          reply.type('text/plain');
        }

        reply.send(content);
      } catch (error) {
        logger.error({ error, file }, 'Failed to serve static file');
        reply.code(404).send({ error: 'File not found' });
      }
    });

    // API: Status
    this.server.get('/api/status', async (_request, reply) => {
      try {
        const status = await this.getStatus();
        reply.send(status);
      } catch (error) {
        logger.error({ error }, 'Failed to get status');
        reply.code(500).send({ error: 'Failed to get status' });
      }
    });

    // API: Recent trades
    this.server.get('/api/trades/recent', async (request, reply) => {
      const query = request.query as { limit?: string };
      const limit = query.limit ? Number.parseInt(query.limit, 10) : 50;

      if (Number.isNaN(limit) || limit < 1 || limit > 1000) {
        reply.code(400).send({ error: 'Invalid limit (must be 1-1000)' });
        return;
      }

      try {
        const trades = this.orchestrator.getTradeHistory(limit);
        const response: RecentTradesResponse = { trades };
        reply.send(response);
      } catch (error) {
        logger.error({ error }, 'Failed to get recent trades');
        reply.code(500).send({ error: 'Failed to get recent trades' });
      }
    });

    // API: Server-Sent Events
    this.server.get('/api/events', async (_request, reply) => {
      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });

      // Send initial connection message
      reply.raw.write('event: connected\ndata: {"status":"ok"}\n\n');

      // Add to SSE manager
      this.sseManager.addConnection(reply);
    });

    // Health check
    this.server.get('/health', async (_request, reply) => {
      reply.send({ status: 'ok', uptime: Date.now() - this.startTime });
    });
  }

  /**
   * Get bot status
   */
  private async getStatus(): Promise<BotStatusResponse> {
    const status = await this.orchestrator.getStatus();
    const metrics = this.orchestrator.getMetrics();
    const balance = status.balance;

    // Calculate values
    const userPositions = status.positions.userPositions || [];
    const targetPositions = status.positions.targetPositions || [];
    const userTotalValue = userPositions.reduce((sum, p) => sum + p.value, 0);
    const targetTotalValue = targetPositions.reduce((sum, p) => sum + p.value, 0);
    const inPositions = userTotalValue;

    // Calculate success rate
    const totalTrades = metrics.tradesProcessed + metrics.tradesFailed;
    const successRate = totalTrades > 0 ? metrics.tradesProcessed / totalTrades : 0;

    return {
      timestamp: Date.now(),
      bot: {
        isRunning: status.isRunning,
        uptime: Date.now() - this.startTime,
      },
      balance: {
        total: balance,
        available: balance - inPositions,
        inPositions,
      },
      positions: {
        user: {
          count: userPositions.length,
          totalValue: userTotalValue,
          positions: userPositions,
        },
        target: {
          count: targetPositions.length,
          totalValue: targetTotalValue,
          positions: targetPositions,
        },
      },
      risk: {
        circuitBreaker: status.risk.circuitBreaker,
        tradingAllowed: status.risk.tradingAllowed,
        exposure: status.positions.userTotalValue / balance,
      },
      monitoring: {
        isActive: status.monitoring.isMonitoring,
        websocketConnected: status.monitoring.websocketConnected,
        pollingActive: status.monitoring.pollingActive,
        targetAddress: status.monitoring.targetAddress,
      },
      performance: {
        queue: {
          length: metrics.queueLength,
          processing: metrics.processingTrades,
          maxSize: metrics.maxQueueSize,
        },
        metrics: {
          tradesQueued: metrics.tradesQueued,
          tradesProcessed: metrics.tradesProcessed,
          tradesSkipped: metrics.tradesSkipped,
          tradesFailed: metrics.tradesFailed,
          successRate,
        },
        latency: {
          min: metrics.minLatencyMs,
          max: metrics.maxLatencyMs,
          avg: metrics.avgLatencyMs,
        },
      },
    };
  }

  /**
   * Start the web server
   */
  async start(): Promise<void> {
    try {
      const address = await this.server.listen({
        host: this.config.web.host,
        port: this.config.web.port,
      });

      logger.info(
        {
          address,
          port: this.config.web.port,
          host: this.config.web.host,
        },
        '🌐 Web dashboard started'
      );
    } catch (error) {
      logger.error({ error }, 'Failed to start web server');
      throw error;
    }
  }

  /**
   * Stop the web server
   */
  async stop(): Promise<void> {
    try {
      // Close all SSE connections
      this.sseManager.closeAll();

      // Close server
      await this.server.close();

      logger.info('Web dashboard stopped');
    } catch (error) {
      logger.error({ error }, 'Error stopping web server');
      throw error;
    }
  }

  /**
   * Get SSE manager for broadcasting events
   */
  getSSEManager(): SSEManager {
    return this.sseManager;
  }
}
