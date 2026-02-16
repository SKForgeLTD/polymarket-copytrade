#!/usr/bin/env node

import { CLI } from './cli/commands.js';
import { logger } from './logger/index.js';

/**
 * Main entry point for the Polymarket Copy Trading Bot
 */
async function main() {
  // Get command from arguments
  const command = process.argv[2] || 'start';

  // Initialize CLI (async - derives API credentials)
  const cli = await CLI.create();

  // Set up graceful shutdown
  const orchestrator = cli.getOrchestrator();

  process.on('SIGINT', async () => {
    logger.info('\n\nReceived SIGINT, shutting down gracefully...');
    await orchestrator.shutdown();
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    logger.info('\n\nReceived SIGTERM, shutting down gracefully...');
    await orchestrator.shutdown();
    process.exit(0);
  });

  process.on('unhandledRejection', (reason, promise) => {
    logger.error(
      {
        reason,
        promise,
      },
      'Unhandled rejection'
    );
  });

  process.on('uncaughtException', (error) => {
    logger.error(
      {
        error: error.message,
        stack: error.stack,
      },
      'Uncaught exception'
    );
    process.exit(1);
  });

  // Execute command
  try {
    if (command === 'start') {
      await cli.start();
    } else if (command === 'status') {
      await cli.status();
      process.exit(0);
    } else if (command === 'sync') {
      await cli.sync();
      process.exit(0);
    } else if (command === 'help' || command === '--help' || command === '-h') {
      cli.help();
      process.exit(0);
    } else {
      logger.error({ command }, 'Unknown command');
      cli.help();
      process.exit(1);
    }
  } catch (error) {
    logger.error(
      {
        error: error instanceof Error ? error.message : String(error),
      },
      'Fatal error'
    );
    process.exit(1);
  }
}

// Run main
main();
