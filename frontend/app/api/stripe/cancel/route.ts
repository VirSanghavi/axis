import { NextRequest, NextResponse } from "next/server";
import { getSessionFromRequest } from "@/lib/auth";
import { createClient } from "@supabase/supabase-js";
import Stripe from "stripe";
import { getClientIp, rateLimit } from "@/lib/rate-limit";

const WINDOW_MS = 60 * 1000;
const LIMIT = 5; // 5 req/min for cancellation

export async function POST(req: NextRequest) {
    const ip = getClientIp(req.headers);
    const { allowed } = await rateLimit(`cancel:${ip}`, LIMIT, WINDOW_MS);
    if (!allowed) {
        return NextResponse.json({ error: "Too many requests" }, { status: 429 });
    }

    const session = await getSessionFromRequest(req);
    if (!session) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || "", {
        apiVersion: "2023-10-16",
    });

    const supabase = createClient(
        process.env.NEXT_PUBLIC_SUPABASE_URL || "",
        process.env.SUPABASE_SERVICE_ROLE_KEY || ""
    );

    const normalizedEmail = session.email.toLowerCase().trim();
    const isSuperUser = normalizedEmail === 'virsanghavi@gmail.com' || normalizedEmail === 'virrsanghavi@gmail.com';

    try {
        const { data: profile } = await supabase
            .from('profiles')
            .select('stripe_customer_id')
            .ilike('email', session.email)
            .single();

        let customerId = profile?.stripe_customer_id;
        if (!customerId && isSuperUser) {
            customerId = 'cus_Tw7wDGE1jIXikB';
            console.log(`[Stripe Cancel] Using bypass customer ID for ${session.email}`);
        }

        if (!customerId) {
            return NextResponse.json({ error: "No customer ID found" }, { status: 404 });
        }

        const subscriptions = await stripe.subscriptions.list({
            customer: customerId,
            status: 'active',
            limit: 1,
        });

        if (subscriptions.data.length === 0) {
            return NextResponse.json({ error: "No active subscription found" }, { status: 404 });
        }

        const sub = subscriptions.data[0];

        // Cancel at period end
        await stripe.subscriptions.update(sub.id, {
            cancel_at_period_end: true,
        });

        return NextResponse.json({ success: true, message: "Subscription will be cancelled at the end of the period" });
    } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : "Internal Server Error";
        console.error(error);
        return NextResponse.json({ error: errorMessage }, { status: 500 });
    }
}
