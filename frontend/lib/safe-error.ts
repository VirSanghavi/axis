/**
 * Production-safe error responses.
 * Hides internal implementation details from error messages in production.
 */

const IS_PRODUCTION = process.env.NODE_ENV === 'production';

/**
 * Returns a safe error message for API responses.
 * In production: returns the fallback message.
 * In development: returns the actual error details for debugging.
 */
export function safeErrorMessage(error: unknown, fallback = 'Internal server error'): string {
  if (!IS_PRODUCTION) {
    if (error instanceof Error) return error.message;
    if (typeof error === 'string') return error;
    return fallback;
  }
  return fallback;
}

/**
 * Log the full error server-side, but return a sanitized version.
 */
export function logAndSanitize(
  context: string,
  error: unknown,
  fallback = 'Internal server error'
): string {
  console.error(`[${context}]`, error);
  return safeErrorMessage(error, fallback);
}
