import Stripe from "stripe";
import { NextResponse } from "next/server";
import { getSessionFromCookies } from "@/lib/auth";
import { getClientIp, rateLimit } from "@/lib/rate-limit";
import { getSafeOrigin } from "@/lib/allowed-origins";

export const runtime = "nodejs";

const WINDOW_MS = 60 * 1000;
const LIMIT = 30;

export async function POST(request: Request) {
  const ip = getClientIp(request.headers);
  const { allowed, remaining, reset } = await rateLimit(`checkout:${ip}`, LIMIT, WINDOW_MS);
  if (!allowed) {
    return NextResponse.json(
      { error: "Too many requests" },
      { status: 429, headers: rateHeaders(remaining, reset) }
    );
  }

  const session = await getSessionFromCookies();
  if (!session) {
    return NextResponse.json(
      { error: "Unauthorized" },
      { status: 401, headers: rateHeaders(remaining, reset) }
    );
  }

  const secretKey = process.env.STRIPE_SECRET_KEY || "";
  const priceId = process.env.STRIPE_PRICE_ID || "";
  if (!secretKey || !priceId) {
    return NextResponse.json(
      { error: "Stripe is not configured" },
      { status: 500, headers: rateHeaders(remaining, reset) }
    );
  }

  const stripe = new Stripe(secretKey);
  const origin = getSafeOrigin(request.headers.get("origin"));

  const checkout = await stripe.checkout.sessions.create({
    mode: "subscription",
    customer_email: session.email,
    line_items: [{ price: priceId, quantity: 1 }],
    success_url: `${origin}/?checkout=success`,
    cancel_url: `${origin}/?checkout=cancelled`,
    allow_promotion_codes: true,
    metadata: {
      email: session.email,
    },
  });

  return NextResponse.json(
    { url: checkout.url },
    { headers: rateHeaders(remaining, reset) }
  );
}

function rateHeaders(remaining: number, reset: number) {
  return {
    "x-rate-limit-remaining": String(remaining),
    "x-rate-limit-reset": String(reset),
  };
}
