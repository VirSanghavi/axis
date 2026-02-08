import { SignJWT, jwtVerify } from "jose";
import { cookies } from "next/headers";
import type { NextRequest } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { redis } from "./redis";

const SESSION_COOKIE = "sc_session";
const REFRESH_COOKIE = "sc_refresh";
const SECRET_KEY = process.env.APP_SESSION_SECRET;
const KEY = new TextEncoder().encode(SECRET_KEY);

/** JWT access token TTL: 7 days */
const ACCESS_TOKEN_TTL = 60 * 60 * 24 * 7;
/** Refresh token TTL: 30 days */
const REFRESH_TOKEN_TTL = 60 * 60 * 24 * 30;
/** Refresh token TTL in milliseconds (for Redis pexpire) */
const REFRESH_TOKEN_TTL_MS = REFRESH_TOKEN_TTL * 1000;

type SessionPayload = {
  email: string;
  sub?: string; // User ID
  role?: string;
  keyId?: string;
  [key: string]: unknown;
};

/**
 * Generate a cryptographically random refresh token.
 */
function generateRefreshToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Hash a refresh token for safe storage in Redis.
 */
async function hashToken(token: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(token);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Create a signed JWT access token (7-day expiry).
 */
export async function createSession(
  email: string,
  userId: string | undefined,
  ttlSeconds: number = ACCESS_TOKEN_TTL
) {
  const jwt = await new SignJWT({ email, sub: userId })
    .setProtectedHeader({ alg: "HS256" })
    .setExpirationTime(Math.floor(Date.now() / 1000) + ttlSeconds)
    .sign(KEY);
  return jwt;
}

/**
 * Verify a JWT access token.
 */
export async function verifySession(
  token?: string
): Promise<SessionPayload | null> {
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, KEY);
    return payload as SessionPayload;
  } catch {
    return null;
  }
}

/**
 * Create and store a refresh token in Redis.
 * Returns the raw refresh token to be set as a cookie.
 * The token hash is stored in Redis keyed to the user.
 */
export async function createRefreshToken(
  userId: string,
  email: string
): Promise<string> {
  const rawToken = generateRefreshToken();
  const tokenHash = await hashToken(rawToken);
  const redisKey = `refresh:${tokenHash}`;

  try {
    await redis.set(
      redisKey,
      JSON.stringify({
        userId,
        email,
        createdAt: Date.now(),
      }),
      { px: REFRESH_TOKEN_TTL_MS }
    );
  } catch (err) {
    console.error("[Auth] Failed to store refresh token in Redis:", err);
    throw new Error("Failed to create refresh token");
  }

  return rawToken;
}

/**
 * Validate a refresh token and return the associated user data.
 * Implements rotation: the old token is invalidated immediately.
 */
export async function validateAndRotateRefreshToken(
  rawToken: string
): Promise<{ userId: string; email: string; newRefreshToken: string } | null> {
  const tokenHash = await hashToken(rawToken);
  const redisKey = `refresh:${tokenHash}`;

  try {
    // Atomically get and delete (rotation: old token is single-use)
    const stored = await redis.get(redisKey);
    if (!stored) return null;

    // Immediately invalidate the old token
    await redis.del(redisKey);

    const data =
      typeof stored === "string" ? JSON.parse(stored) : (stored as any);
    if (!data.userId || !data.email) return null;

    // Issue a new refresh token (rotation)
    const newRefreshToken = await createRefreshToken(data.userId, data.email);

    return {
      userId: data.userId,
      email: data.email,
      newRefreshToken,
    };
  } catch (err) {
    console.error("[Auth] Refresh token validation error:", err);
    return null;
  }
}

/**
 * Revoke a refresh token (e.g., on logout).
 */
export async function revokeRefreshToken(rawToken: string): Promise<void> {
  try {
    const tokenHash = await hashToken(rawToken);
    await redis.del(`refresh:${tokenHash}`);
  } catch (err) {
    console.error("[Auth] Failed to revoke refresh token:", err);
  }
}

async function hashKey(key: string) {
  const encoder = new TextEncoder();
  const data = encoder.encode(key);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export async function validateApiKey(
  key: string
): Promise<SessionPayload | null> {
  if (!key.startsWith("sk_sc_")) return null;

  const hash = await hashKey(key);

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) return null;

  try {
    const supabase = createClient(url, serviceKey);

    const { data, error } = await supabase
      .from("api_keys")
      .select("id, user_id, is_active")
      .eq("key_hash", hash)
      .single();

    if (error || !data || !data.is_active) return null;

    // Fire and forget update last_used_at
    supabase
      .from("api_keys")
      .update({ last_used_at: new Date().toISOString() })
      .eq("id", data.id)
      .then();

    return {
      email: "api-key-user",
      sub: data.user_id,
      keyId: data.id,
      role: "api_key",
    };
  } catch {
    return null;
  }
}

export async function getSessionFromRequest(
  req: NextRequest
): Promise<SessionPayload | null> {
  // 1. Check Cookie
  const cookieToken = req.cookies.get(SESSION_COOKIE)?.value;
  if (cookieToken) return verifySession(cookieToken);

  // 2. Check Authorization Header (Bearer Token or API Key)
  const authHeader = req.headers.get("Authorization");
  if (authHeader) {
    const [scheme, token] = authHeader.split(" ");
    if (scheme === "Bearer" && token) {
      if (token.startsWith("sk_sc_")) return validateApiKey(token);
      return verifySession(token);
    }
  }

  return null;
}

export async function setSessionCookie(token: string) {
  const secure = process.env.NODE_ENV === "production";
  const cookieStore = await cookies();
  cookieStore.set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure,
    sameSite: "lax",
    path: "/",
    maxAge: ACCESS_TOKEN_TTL,
  });
}

export async function setRefreshCookie(refreshToken: string) {
  const secure = process.env.NODE_ENV === "production";
  const cookieStore = await cookies();
  cookieStore.set(REFRESH_COOKIE, refreshToken, {
    httpOnly: true,
    secure,
    sameSite: "lax",
    path: "/",
    maxAge: REFRESH_TOKEN_TTL,
  });
}

export async function clearSessionCookie() {
  const cookieStore = await cookies();
  cookieStore.set(SESSION_COOKIE, "", {
    httpOnly: true,
    expires: new Date(0),
    path: "/",
  });
  cookieStore.set(REFRESH_COOKIE, "", {
    httpOnly: true,
    expires: new Date(0),
    path: "/",
  });
}

export async function getSessionFromCookies() {
  const cookieStore = await cookies();
  const token = cookieStore.get(SESSION_COOKIE)?.value;
  return await verifySession(token);
}

export async function getRefreshTokenFromCookies(): Promise<string | null> {
  const cookieStore = await cookies();
  return cookieStore.get(REFRESH_COOKIE)?.value || null;
}

export { SESSION_COOKIE, REFRESH_COOKIE, ACCESS_TOKEN_TTL, REFRESH_TOKEN_TTL };
