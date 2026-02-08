import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { getSessionFromRequest } from "./lib/auth";
import { isAllowedOrigin, getAllowedOrigins } from "./lib/allowed-origins";

const PUBLIC_PATHS = ["/login", "/signup", "/auth/callback", "/api/auth/login", "/api/auth/signup", "/api/auth/callback", "/api/auth/resend", "/api/auth/refresh", "/api/chat", "/api/stripe/webhook", "/api/auth/logout", "/pricing", "/docs", "/privacy", "/terms", "/about"];

/**
 * Add CORS headers to the response based on the request origin.
 * Only allows origins from the configured allowlist.
 */
function withCorsHeaders(response: NextResponse, request: NextRequest): NextResponse {
  const origin = request.headers.get("origin");

  if (origin && isAllowedOrigin(origin)) {
    response.headers.set("Access-Control-Allow-Origin", origin);
    response.headers.set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS, PATCH");
    response.headers.set("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Requested-With");
    response.headers.set("Access-Control-Allow-Credentials", "true");
    response.headers.set("Access-Control-Max-Age", "86400");
  }

  return response;
}

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  // Handle CORS preflight requests
  if (req.method === "OPTIONS") {
    const origin = req.headers.get("origin");
    if (origin && isAllowedOrigin(origin)) {
      const response = new NextResponse(null, { status: 204 });
      response.headers.set("Access-Control-Allow-Origin", origin);
      response.headers.set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS, PATCH");
      response.headers.set("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Requested-With");
      response.headers.set("Access-Control-Allow-Credentials", "true");
      response.headers.set("Access-Control-Max-Age", "86400");
      return response;
    }
    return new NextResponse(null, { status: 403 });
  }

  // Allow Next.js internals and static assets
  if (pathname.startsWith("/_next") || pathname.startsWith("/favicon") || pathname === "/" || pathname.startsWith("/api/stripe/webhook")) {
    return withCorsHeaders(NextResponse.next(), req);
  }

  // Allow public assets
  if (pathname.match(/\.(png|jpg|jpeg|gif|ico|svg)$/)) {
    return NextResponse.next();
  }

  // If authenticated, redirect away from auth pages (must run BEFORE public paths early return)
  if (pathname === "/login" || pathname === "/signup") {
    const session = await getSessionFromRequest(req);
    if (session) {
      const url = req.nextUrl.clone();
      url.pathname = "/dashboard";
      return NextResponse.redirect(url);
    }
    return NextResponse.next();
  }

  if (PUBLIC_PATHS.some((p) => pathname.startsWith(p))) {
    return withCorsHeaders(NextResponse.next(), req);
  }

  // For /api/v1/* routes, validate session but allow API key authentication
  // The route handler will do the actual validation
  if (pathname.startsWith("/api/v1")) {
    const session = await getSessionFromRequest(req);
    if (!session) {
      // Let the route handler return the error with more context
      // This allows API key validation to happen in the route
      return withCorsHeaders(
        NextResponse.json({ error: "Unauthorized" }, { status: 401 }),
        req
      );
    }
    return withCorsHeaders(NextResponse.next(), req);
  }

  const session = await getSessionFromRequest(req);

  if (!session) {
    if (pathname.startsWith("/api")) {
      return withCorsHeaders(
        NextResponse.json({ error: "Unauthorized" }, { status: 401 }),
        req
      );
    }
    const url = req.nextUrl.clone();
    url.pathname = "/login";
    return NextResponse.redirect(url);
  }

  return withCorsHeaders(NextResponse.next(), req);
}

export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico).*)',
  ],
}
