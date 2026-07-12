/**
 * Minimal leveled logger — no dependencies (matches pxpipe's tiny-surface ethos).
 * Writes to stderr so proxy stdout stays clean for piping.
 */

import type { LogLevel } from './config.js';

const ORDER: Record<LogLevel, number> = {
  silent: 0,
  error: 1,
  warn: 2,
  info: 3,
  debug: 4,
};

export interface Logger {
  error(msg: string, ...args: unknown[]): void;
  warn(msg: string, ...args: unknown[]): void;
  info(msg: string, ...args: unknown[]): void;
  debug(msg: string, ...args: unknown[]): void;
  child(scope: string): Logger;
}

function fmt(scope: string, msg: string): string {
  const ts = new Date().toISOString();
  return `${ts} [pixroom${scope ? `:${scope}` : ''}] ${msg}`;
}

export function createLogger(level: LogLevel, scope = ''): Logger {
  const threshold = ORDER[level];
  const at = (lvl: LogLevel) => ORDER[lvl] <= threshold;
  return {
    error(msg, ...args) {
      if (at('error')) console.error(fmt(scope, msg), ...args);
    },
    warn(msg, ...args) {
      if (at('warn')) console.error(fmt(scope, msg), ...args);
    },
    info(msg, ...args) {
      if (at('info')) console.error(fmt(scope, msg), ...args);
    },
    debug(msg, ...args) {
      if (at('debug')) console.error(fmt(scope, msg), ...args);
    },
    child(childScope) {
      return createLogger(level, scope ? `${scope}.${childScope}` : childScope);
    },
  };
}
