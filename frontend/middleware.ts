import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { getSessionFromRequest } from "./lib/auth";

const PUBLIC_PATHS = ["/login", "/signup", "/api/auth/login", "/api/auth/signup", "/api/auth/resend", "/api/chat", "/api/stripe/webhook", "/api/auth/logout", "/pricing", "/docs", "/privacy", "/terms", "/about"];

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  // Allow Next.js internals and static assets
  if (pathname.startsWith("/_next") || pathname.startsWith("/favicon") || pathname === "/" || pathname.startsWith("/api/stripe/webhook")) {
    return NextResponse.next();
  }

  // Allow public assets
  if (pathname.match(/\.(png|jpg|jpeg|gif|ico|svg)$/)) {
    return NextResponse.next();
  }

  const isPublic = PUBLIC_PATHS.some((p) => pathname.startsWith(p));
  console.log(`[Middleware] Path: ${pathname}, Public: ${isPublic}`);

  if (PUBLIC_PATHS.some((p) => pathname.startsWith(p))) {
    return NextResponse.next();
  }

  // For /api/v1/* routes, validate session but allow API key authentication
  // The route handler will do the actual validation
  if (pathname.startsWith("/api/v1")) {
    const session = await getSessionFromRequest(req);
    console.log(`[Middleware] /api/v1 route - session:`, session ? { email: session.email, role: session.role } : "null");
    if (!session) {
      // Let the route handler return the error with more context
      // This allows API key validation to happen in the route
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    return NextResponse.next();
  }

  const session = await getSessionFromRequest(req);

  // If authenticated, redirect away from auth pages
  if (session && (pathname === "/login" || pathname === "/signup")) {
    const url = req.nextUrl.clone();
    url.pathname = "/dashboard";
    return NextResponse.redirect(url);
  }

  if (!session) {
    if (pathname.startsWith("/api")) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const url = req.nextUrl.clone();
    url.pathname = "/login";
    return NextResponse.redirect(url);
  }

  return NextResponse.next();
}

export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico).*)',
  ],
}
