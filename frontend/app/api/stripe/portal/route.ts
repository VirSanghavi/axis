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
    const { data: profile, error: dbError } = await supabase
      .from('profiles')
      .select('stripe_customer_id')
      .ilike('email', session.email)
      .single();

    if (dbError) {
      console.error(`[Stripe Portal] DB error for ${session.email}:`, dbError);
    }

    const customerId = profile?.stripe_customer_id;

    if (!customerId) {
      console.log(`[Stripe Portal] No customer ID for ${session.email}`);
      return NextResponse.json(
        { error: "no billing account found. subscribe first to manage payment methods." },
        { status: 400 }
      );
    }

    // Build return URL — origin can be null in some edge/serverless contexts
    const origin = req.headers.get("origin")
      || req.headers.get("referer")?.replace(/\/billing.*$/, '')
      || process.env.NEXT_PUBLIC_APP_URL
      || 'https://aicontext.vercel.app';
    const returnUrl = `${origin}/billing`;

    console.log(`[Stripe Portal] Creating portal for customer ${customerId}, return_url: ${returnUrl}`);

    try {
      const portalSession = await stripe.billingPortal.sessions.create({
        customer: customerId,
        return_url: returnUrl,
      });
      return NextResponse.json({ url: portalSession.url });
    } catch (portalErr: unknown) {
      const portalMsg = portalErr instanceof Error ? portalErr.message : String(portalErr);
      // Stripe customer IDs are case-sensitive; DB may have wrong case (e.g. lowercased)
      const isNoSuchCustomer = portalMsg.includes("no such customer");
      if (isNoSuchCustomer && session.email) {
        const { data: customers } = await stripe.customers.list({
          email: session.email,
          limit: 1,
        });
        const stripeCustomer = customers[0];
        if (stripeCustomer) {
          const correctId = stripeCustomer.id;
          console.log(`[Stripe Portal] Recovered correct customer ID for ${session.email}: ${correctId}`);
          await supabase
            .from("profiles")
            .update({ stripe_customer_id: correctId })
            .ilike("email", session.email);
          const portalSession = await stripe.billingPortal.sessions.create({
            customer: correctId,
            return_url: returnUrl,
          });
          return NextResponse.json({ url: portalSession.url });
        }
      }
      throw portalErr;
    }
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error(`[Stripe Portal] Error for ${session.email}:`, msg);

    if (error && typeof error === "object" && "type" in error) {
      const stripeErr = error as { type: string; message: string };
      if (stripeErr.type === "StripeInvalidRequestError") {
        const friendlyMsg = msg.includes("no such customer")
          ? "Billing account not found or invalid. Please contact support."
          : stripeErr.message || "invalid stripe request";
        return NextResponse.json({ error: friendlyMsg }, { status: 400 });
      }
    }

    return NextResponse.json({ error: msg || "Internal Server Error" }, { status: 500 });
  }
}
