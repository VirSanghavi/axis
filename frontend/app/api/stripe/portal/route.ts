import { NextRequest, NextResponse } from "next/server";
import { getSessionFromRequest } from "@/lib/auth";
import Stripe from "stripe";
import { createClient } from "@supabase/supabase-js";
import { getClientIp, rateLimit } from "@/lib/rate-limit";

const WINDOW_MS = 60 * 1000;
const LIMIT = 10; // 10 req/min for portal access

export async function POST(req: NextRequest) {
  const ip = getClientIp(req.headers);
  const { allowed } = await rateLimit(`portal:${ip}`, LIMIT, WINDOW_MS);
  if (!allowed) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || "", {
    apiVersion: "2023-10-16",
  });

  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL || "",
    process.env.SUPABASE_SERVICE_ROLE_KEY || ""
  );

  const session = await getSessionFromRequest(req);
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    // 1. Get stripe_customer_id from DB
    const { data: profile } = await supabase
      .from('profiles')
      .select('stripe_customer_id')
      .eq('email', session.email)
      .single();

    if (!profile?.stripe_customer_id) {
      const url = new URL("/billing", req.url);
      return NextResponse.redirect(url);
    }

    const portalSession = await stripe.billingPortal.sessions.create({
      customer: profile.stripe_customer_id,
      return_url: `${req.headers.get("origin")}/`,
    });

    return NextResponse.redirect(portalSession.url);
  } catch (error) {
    console.error(error);
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}
