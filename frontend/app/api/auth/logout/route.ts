import { NextResponse } from "next/server";
import { clearSessionCookie, revokeRefreshToken } from "@/lib/auth";
import { cookies } from "next/headers";

const REFRESH_COOKIE = "sc_refresh";

export async function POST(req: Request) {
  // Revoke the refresh token from Redis before clearing cookies
  const cookieStore = await cookies();
  const refreshToken = cookieStore.get(REFRESH_COOKIE)?.value;
  if (refreshToken) {
    await revokeRefreshToken(refreshToken);
  }

  await clearSessionCookie();
  const url = new URL("/", req.url);
  return NextResponse.redirect(url, { status: 303 });
}

export async function GET(req: Request) {
  // Revoke the refresh token from Redis before clearing cookies
  const cookieStore = await cookies();
  const refreshToken = cookieStore.get(REFRESH_COOKIE)?.value;
  if (refreshToken) {
    await revokeRefreshToken(refreshToken);
  }

  await clearSessionCookie();
  const url = new URL("/", req.url);
  return NextResponse.redirect(url, { status: 303 });
}
