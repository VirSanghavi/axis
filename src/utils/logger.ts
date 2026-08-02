// src/utils/logger.ts
export enum LogLevel {
  DEBUG = "debug",
  INFO = "info",
  WARN = "warn",
  ERROR = "error",
}

class Logger {
  private level: LogLevel = LogLevel.INFO;

  setLevel(level: LogLevel) {
    this.level = level;
  }

  private log(level: LogLevel, message: string, meta?: object | Error) {
    const timestamp = new Date().toISOString();
    // Spreading an Error yields {} (its props are non-enumerable), which used
    // to silently swallow errors passed as meta — extract them explicitly.
    const metaFields = meta instanceof Error ? { error: meta.message, stack: meta.stack } : meta;
    console.error(JSON.stringify({
      timestamp,
      level,
      message,
      ...metaFields,
    }));
  }

  debug(message: string, meta?: object | Error) {
    if (this.level === LogLevel.DEBUG) this.log(LogLevel.DEBUG, message, meta);
  }

  info(message: string, meta?: object | Error) {
    this.log(LogLevel.INFO, message, meta);
  }

  warn(message: string, meta?: object | Error) {
    this.log(LogLevel.WARN, message, meta);
  }

  error(message: string, error?: unknown, meta?: Record<string, unknown>) {
    this.log(LogLevel.ERROR, message, {
      ...meta,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined
    });
  }
}

export const logger = new Logger();
