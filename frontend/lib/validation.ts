/**
 * Input validation utilities for API endpoints.
 * Prevents injection, oversized payloads, and malformed input.
 */

const EMAIL_RE = /^[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}$/;

export function isValidEmail(email: unknown): email is string {
  if (typeof email !== 'string') return false;
  const trimmed = email.trim();
  return trimmed.length > 0 && trimmed.length <= 254 && EMAIL_RE.test(trimmed);
}

export function isValidPassword(password: unknown): password is string {
  if (typeof password !== 'string') return false;
  return password.length >= 8 && password.length <= 128;
}

/**
 * Sanitize a string input: trim whitespace, enforce max length.
 * Returns null if input is not a string.
 */
export function sanitizeString(input: unknown, maxLength = 1000): string | null {
  if (typeof input !== 'string') return null;
  return input.trim().slice(0, maxLength);
}

/**
 * Validate that the request body is well-formed JSON with expected fields.
 * Returns the parsed body or null on failure.
 */
export async function parseJsonBody<T extends Record<string, unknown>>(
  request: Request,
  requiredFields: string[] = []
): Promise<{ data: T | null; error: string | null }> {
  try {
    const contentType = request.headers.get('content-type');
    if (!contentType?.includes('application/json')) {
      return { data: null, error: 'Content-Type must be application/json' };
    }

    const text = await request.text();
    if (text.length > 10_000) {
      return { data: null, error: 'Request body too large' };
    }

    const body = JSON.parse(text) as T;

    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      return { data: null, error: 'Request body must be a JSON object' };
    }

    for (const field of requiredFields) {
      if (!(field in body) || body[field] === undefined || body[field] === null || body[field] === '') {
        return { data: null, error: `Missing required field: ${field}` };
      }
    }

    return { data: body, error: null };
  } catch {
    return { data: null, error: 'Invalid JSON body' };
  }
}
