/**
 * Structured logger with level filtering and sensitive data redaction.
 *
 * Supports text and JSON output formats. JSON logs can be parsed by the extension
 * to drive status indicators without brittle text parsing.
 *
 * Usage:
 *   import { logger } from './logger.js';
 *   logger.info('server_start', 'Server listening', { port: 3000 });
 *   logger.warn('rate_limit', 'Client exceeded rate limit', { ip: '192.168.1.1' });
 *
 * Configuration:
 *   LOG_LEVEL=debug|info|warn|error  (default: info)
 *   LOG_FORMAT=text|json              (default: text)
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export type LogFormat = 'text' | 'json';

export interface LogEntry {
  ts: string;
  level: LogLevel;
  event: string;
  msg: string;
  requestId?: string;
  commandId?: string;
  windowId?: string;
  generation?: number;
  [key: string]: unknown;
}

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

/**
 * Redact sensitive values from log entries.
 * Returns a redacted string or object.
 */
function redactSensitive(value: unknown): unknown {
  if (typeof value === 'string') {
    // Redact passwords (case-insensitive match for password fields)
    if (/password|secret|token|bearer|cookie|authorization/i.test(String(value))) {
      return maskString(value);
    }
    return value;
  }

  if (Array.isArray(value)) {
    return value.map(redactSensitive);
  }

  if (value && typeof value === 'object') {
    const redacted: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      // Redact known sensitive keys
      if (/password|secret|token|bearer|cookie|authorization|session|key|pat|credentials/i.test(k)) {
        redacted[k] = maskString(String(v));
      }
      // Don't log full message content
      else if (k === 'content' || k === 'text' || k === 'code') {
        redacted[k] = `<${(v as string)?.length ?? 0} chars>`;
      }
      else {
        redacted[k] = redactSensitive(v);
      }
    }
    return redacted;
  }

  return value;
}

/**
 * Mask a sensitive string, showing only first/last 4 characters.
 */
function maskString(s: string): string {
  if (s.length <= 8) return '***';
  return `${s.substring(0, 4)}...${s.substring(s.length - 4)}`;
}

/**
 * Format timestamp for text logs.
 */
function formatTimestamp(): string {
  const now = new Date();
  const h = String(now.getHours()).padStart(2, '0');
  const m = String(now.getMinutes()).padStart(2, '0');
  const s = String(now.getSeconds()).padStart(2, '0');
  const ms = String(now.getMilliseconds()).padStart(3, '0');
  return `${h}:${m}:${s}.${ms}`;
}

/**
 * Format error object safely.
 */
function formatError(err: unknown): { type: string; message: string; stack?: string } {
  if (err instanceof Error) {
    return {
      type: err.constructor.name,
      message: err.message,
      stack: err.stack,
    };
  }
  return {
    type: 'Unknown',
    message: String(err),
  };
}

class Logger {
  private minLevel: LogLevel;
  private format: LogFormat;
  private origLog: typeof console.log;
  private origWarn: typeof console.warn;
  private origError: typeof console.error;

  constructor() {
    const envLevel = (process.env.LOG_LEVEL?.toLowerCase() as LogLevel) || 'info';
    this.minLevel = LEVEL_PRIORITY[envLevel] !== undefined ? envLevel : 'info';

    const envFormat = (process.env.LOG_FORMAT?.toLowerCase() as LogFormat) || 'text';
    this.format = envFormat === 'json' ? 'json' : 'text';

    // Capture original console methods before we patch them
    this.origLog = console.log.bind(console);
    this.origWarn = console.warn.bind(console);
    this.origError = console.error.bind(console);
  }

  /**
   * Check if a level should be logged.
   */
  private shouldLog(level: LogLevel): boolean {
    return LEVEL_PRIORITY[level] >= LEVEL_PRIORITY[this.minLevel];
  }

  /**
   * Write a log entry to stdout/stderr.
   */
  private write(level: LogLevel, event: string, msg: string, meta?: Record<string, unknown>): void {
    if (!this.shouldLog(level)) return;

    const ts = formatTimestamp();
    const entry: LogEntry = {
      ts,
      level,
      event,
      msg,
      ...redactSensitive(meta ?? {}),
    };

    if (this.format === 'json') {
      const line = JSON.stringify(entry);
      if (level === 'error') {
        this.origError(line);
      } else if (level === 'warn') {
        this.origWarn(line);
      } else {
        this.origLog(line);
      }
    } else {
      // Text format
      const prefix = level === 'warn' ? '[WARN]' : level === 'error' ? '[ERROR]' : '';
      const metaStr = meta && Object.keys(meta).length > 0
        ? ` ${JSON.stringify(redactSensitive(meta))}`
        : '';
      const line = `${ts} ${prefix} [${event}] ${msg}${metaStr}`;

      if (level === 'error') {
        this.origError(line);
      } else if (level === 'warn') {
        this.origWarn(line);
      } else {
        this.origLog(line);
      }
    }
  }

  /**
   * Log at debug level.
   */
  debug(event: string, msg: string, meta?: Record<string, unknown>): void {
    this.write('debug', event, msg, meta);
  }

  /**
   * Log at info level.
   */
  info(event: string, msg: string, meta?: Record<string, unknown>): void {
    this.write('info', event, msg, meta);
  }

  /**
   * Log at warn level.
   */
  warn(event: string, msg: string, meta?: Record<string, unknown>): void {
    this.write('warn', event, msg, meta);
  }

  /**
   * Log at error level. Accepts Error objects.
   */
  error(event: string, msg: string, metaOrError?: Record<string, unknown> | Error): void {
    const meta = metaOrError instanceof Error
      ? { error: formatError(metaOrError) }
      : metaOrError;
    this.write('error', event, msg, meta);
  }

  /**
   * Patch console.* to route through structured logger.
   * This maintains backward compatibility with existing console.log/warn/error calls.
   */
  patchConsole(): void {
    console.log = (...args: unknown[]) => {
      const msg = args.map(String).join(' ');
      this.info('console', msg);
    };

    console.warn = (...args: unknown[]) => {
      const msg = args.map(String).join(' ');
      this.warn('console', msg);
    };

    console.error = (...args: unknown[]) => {
      const msg = args.map(String).join(' ');
      this.error('console', msg);
    };
  }

  /**
   * Restore original console methods.
   */
  unpatchConsole(): void {
    console.log = this.origLog;
    console.warn = this.origWarn;
    console.error = this.origError;
  }
}

/**
 * Singleton logger instance.
 */
export const logger = new Logger();
