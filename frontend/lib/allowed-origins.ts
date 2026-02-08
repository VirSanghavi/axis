/**
 * Allowed origins for CORS and redirect URL validation.
 * Only these domains are authorized for cross-origin requests and redirects.
 */

const ALLOWED_ORIGINS: string[] = [
  'https://useaxis.dev',
  'https://www.useaxis.dev',
  'https://aicontext.vercel.app',
];

// In development, also allow localhost
if (process.env.NODE_ENV !== 'production') {
  ALLOWED_ORIGINS.push(
    'http://localhost:3000',
    'http://localhost:3001',
    'http://127.0.0.1:3000',
  );
}

/**
 * Check if an origin is in the allowlist.
 */
export function isAllowedOrigin(origin: string | null | undefined): boolean {
  if (!origin) return false;
  return ALLOWED_ORIGINS.includes(origin);
}

/**
 * Validate and return a safe origin, falling back to the default production URL.
 * Use this for constructing redirect/callback URLs.
 */
export function getSafeOrigin(origin: string | null | undefined): string {
  if (origin && isAllowedOrigin(origin)) return origin;
  // Use env var if set, otherwise fall back to production domain
  return process.env.NEXT_PUBLIC_APP_URL || 'https://useaxis.dev';
}

/**
 * Get the list of allowed origins (for CORS headers).
 */
export function getAllowedOrigins(): readonly string[] {
  return ALLOWED_ORIGINS;
}
