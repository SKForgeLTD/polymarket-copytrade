import pino from 'pino';
import { config } from '../config/index.js';

/**
 * Create and configure logger instance
 */
export function createLogger() {
  const isDevelopment = config.system.nodeEnv === 'development';

  const loggerConfig: any = {
    level: config.system.logLevel,
    base: {
      env: config.system.nodeEnv,
    },
  };

  if (isDevelopment) {
    loggerConfig.transport = {
      target: 'pino-pretty',
      options: {
        colorize: true,
        translateTime: 'HH:MM:ss.l',
        ignore: 'pid,hostname',
        singleLine: false,
      },
    };
  }

  return pino(loggerConfig);
}

// Export a singleton logger instance
export const logger = createLogger();

// Utility function to create child loggers with context
export function createChildLogger(context: Record<string, unknown>) {
  return logger.child(context);
}
