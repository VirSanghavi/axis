import { NextResponse } from "next/server";
import {
  createSession,
  setSessionCookie,
  setRefreshCookie,
  getRefreshTokenFromCookies,
  validateAndRotateRefreshToken,
} from "@/lib/auth";
import { getClientIp, rateLimit } from "@/lib/rate-limit";

const WINDOW_MS = 60 * 1000;
const LIMIT = 20; // Allow reasonable refresh rate

/**
 * POST /api/auth/refresh
 *
 * Rotates the refresh token and issues a new JWT access token.
 * The old refresh token is invalidated on use (single-use rotation).
 * 
 * Returns: { ok: true } with new cookies set, or { error: "..." }
 */
export async function POST(request: Request) {
  const ip = getClientIp(request.headers);
  const { allowed } = await rateLimit(`refresh:${ip}`, LIMIT, WINDOW_MS);
  if (!allowed) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  try {
    const refreshToken = await getRefreshTokenFromCookies();

    if (!refreshToken) {
      return NextResponse.json(
        { error: "No refresh token" },
        { status: 401 }
      );
    }

    const result = await validateAndRotateRefreshToken(refreshToken);

    if (!result) {
      return NextResponse.json(
        { error: "Invalid or expired refresh token" },
        { status: 401 }
      );
    }

    // Issue new access token (7-day JWT)
    const newAccessToken = await createSession(result.email, result.userId);
    await setSessionCookie(newAccessToken);

    // Set new refresh token cookie (rotation)
    await setRefreshCookie(result.newRefreshToken);

    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("[Auth Refresh] Error:", err);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
