import { NextRequest, NextResponse } from "next/server";
import { getSessionFromRequest } from "@/lib/auth";
import { createClient } from "@supabase/supabase-js";
import Stripe from "stripe";

export const dynamic = 'force-dynamic'; // Ensure we don't cache this

export async function GET(req: NextRequest) {
    try {
        const session = await getSessionFromRequest(req);
        if (!session) {
            console.log("[Stripe Status] No session found");
            return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
        }

        console.log(`[Stripe Status] Checking: "${session.email}"`);

        // TEMPORARY BYPASS: Force Pro for user email variations while debugging
        const normalizedEmail = session.email.toLowerCase().trim();
        const isSuperUser = normalizedEmail === 'virsanghavi@gmail.com' || normalizedEmail === 'virrsanghavi@gmail.com';

        const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
        const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

        if (!supabaseUrl || !supabaseKey) {
            console.error("Missing Supabase credentials");
            return NextResponse.json({ error: "Configuration Error" }, { status: 500 });
        }

        const supabase = createClient(supabaseUrl, supabaseKey);

        const { data: profile, error: profileError } = await supabase
            .from('profiles')
            .select('subscription_status, stripe_customer_id, current_period_end, has_seen_retention')
            .ilike('email', session.email)
            .single();

        if ((profileError || !profile) && !isSuperUser) {
            console.log(`[Stripe Status] Profile 404: "${session.email}"`);
            return NextResponse.json({ error: "Profile not found" }, { status: 404 });
        }

        let isPro = isSuperUser || profile?.subscription_status === 'pro';
        console.log(`[Stripe Status] Final Decision: ${session.email} is ${isPro ? 'pro' : 'free'}`);

        let stripeData = null;

        if (profile?.stripe_customer_id) {
            const stripeKey = process.env.STRIPE_SECRET_KEY;
            if (stripeKey) {
                const stripe = new Stripe(stripeKey, {
                    apiVersion: "2023-10-16",
                });

                const subscriptions = await stripe.subscriptions.list({
                    customer: profile.stripe_customer_id as string,
                    status: 'all',
                    limit: 1,
                    expand: ['data.discounts', 'data.discount']
                });

                if (subscriptions.data.length > 0) {
                    const sub = subscriptions.data[0];
                    console.log(`[Stripe Status] Sub: ${sub.id}, Discount: ${sub.discount?.coupon?.id}, Discounts: ${sub.discounts?.length || 0}`);
                    const now = Math.floor(Date.now() / 1000);

                    // A subscription is considered "active" if its status is active, 
                    // or if it's trialing, or if it's canceled but hasn't reached the end of the period yet.
                    const isActive = sub.status === 'active' || sub.status === 'trialing' || sub.status === 'past_due' || (sub.status === 'canceled' && sub.current_period_end > now);

                    if (isActive) {
                        isPro = true;
                    }

                    stripeData = {
                        status: sub.status,
                        current_period_end: sub.current_period_end,
                        cancel_at_period_end: sub.cancel_at_period_end,
                        is_active: isActive,
                        plan_name: 'pro',
                        has_retention_offer: (sub.discount?.coupon?.id === 'CvcPuGJs') ||
                            (sub.discounts && Array.isArray(sub.discounts) &&
                                sub.discounts.some((d: any) => d.coupon?.id === 'CvcPuGJs'))
                    };
                }
            }
        }

        // Final fallback: check profile.current_period_end
        if (profile?.current_period_end && new Date(profile.current_period_end) > new Date()) {
            isPro = true;
        }

        return NextResponse.json({
            subscription_status: isPro ? 'pro' : 'free',
            current_period_end: profile?.current_period_end,
            has_seen_retention: profile?.has_seen_retention || false,
            stripe: stripeData
        });

    } catch (error: unknown) {
        console.error("Stripe Status API Error:", error);
        const errorMessage = error instanceof Error ? error.message : "Internal Server Error";
        return NextResponse.json({ error: errorMessage }, { status: 500 });
    }
}
