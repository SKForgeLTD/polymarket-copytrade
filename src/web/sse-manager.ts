/**
 * Server-Sent Events (SSE) connection manager
 */

import type { FastifyReply } from 'fastify';
import { createChildLogger } from '../logger/index.js';
import type { SSEEvent } from './types/api.js';

const logger = createChildLogger({ module: 'SSEManager' });

/**
 * Manages SSE connections for real-time updates
 */
export class SSEManager {
  private connections: Set<FastifyReply> = new Set();

  /**
   * Add a new SSE connection
   */
  addConnection(reply: FastifyReply): void {
    this.connections.add(reply);
    logger.debug({ connectionCount: this.connections.size }, 'SSE connection added');

    // Remove connection when it closes
    reply.raw.on('close', () => {
      this.connections.delete(reply);
      logger.debug({ connectionCount: this.connections.size }, 'SSE connection closed');
    });
  }

  /**
   * Broadcast event to all connected clients
   */
  broadcast(event: SSEEvent): void {
    const eventData = `event: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`;

    for (const reply of this.connections) {
      try {
        reply.raw.write(eventData);
      } catch (error) {
        logger.warn({ error }, 'Failed to write to SSE connection');
        this.connections.delete(reply);
      }
    }

    logger.debug(
      { eventType: event.type, connectionCount: this.connections.size },
      'Event broadcast to SSE clients'
    );
  }

  /**
   * Close all connections (for graceful shutdown)
   */
  closeAll(): void {
    logger.info({ connectionCount: this.connections.size }, 'Closing all SSE connections');

    for (const reply of this.connections) {
      try {
        reply.raw.end();
      } catch (error) {
        logger.warn({ error }, 'Error closing SSE connection');
      }
    }

    this.connections.clear();
  }

  /**
   * Get active connection count
   */
  getConnectionCount(): number {
    return this.connections.size;
  }
}
