import { NextResponse } from "next/server";
import Stripe from "stripe";
import { createClient } from "@supabase/supabase-js";
import { logActivity } from "@/lib/activity";
import { resolveUserId } from "@/lib/db-utils";

export const runtime = "nodejs";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
    apiVersion: "2023-10-16",
});

const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET!;

const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
);

export async function POST(req: Request) {
    const payload = await req.text();
    const signature = req.headers.get("stripe-signature");

    console.log(`[Stripe Webhook] Received POST. Signature present: ${!!signature}`);

    if (!signature) {
        return NextResponse.json({ error: "Missing Stripe signature" }, { status: 400 });
    }

    let event: Stripe.Event;

    try {
        event = stripe.webhooks.constructEvent(payload, signature, webhookSecret);
    } catch (err) {
        const message = err instanceof Error ? err.message : "Invalid signature";
        console.error("[Stripe Webhook] Signature verification failed:", message);
        return NextResponse.json({ error: message }, { status: 400 });
    }

    try {
        switch (event.type) {
            case "checkout.session.completed": {
                const session = event.data.object as Stripe.Checkout.Session;

                const customerId = session.customer as string | null;
                const email =
                    session.customer_details?.email ??
                    session.metadata?.email ??
                    null;

                if (!customerId || !email) break;

                const { data: updatedProfile } = await supabase
                    .from("profiles")
                    .update({
                        stripe_customer_id: customerId,
                        subscription_status: "pro",
                    })
                    .ilike("email", email)
                    .select("id")
                    .single();

                if (updatedProfile) {
                    await logActivity(updatedProfile.id, "SUBSCRIPTION_ACTIVATED", "Axis Pro", { session_id: session.id });
                }

                break;
            }

            case "customer.subscription.updated": {
                const subscription = event.data.object as Stripe.Subscription;

                const customerId = subscription.customer as string;

                const now = Math.floor(Date.now() / 1000);
                const stillValid =
                    subscription.status === "active" ||
                    subscription.status === "trialing" ||
                    subscription.status === "past_due" ||
                    (subscription.status === "canceled" &&
                        subscription.current_period_end > now);

                const { data: updatedProfile } = await supabase
                    .from("profiles")
                    .update({
                        subscription_status: stillValid ? "pro" : "free",
                        current_period_end: new Date(
                            subscription.current_period_end * 1000
                        ).toISOString(),
                    })
                    .eq("stripe_customer_id", customerId)
                    .select("id")
                    .single();

                // If it just became active or trial, log it if not already logged by checkout?
                // Or log specific updates like plan changes if we had more than one plan.

                break;
            }

            case "customer.subscription.deleted": {
                const subscription = event.data.object as Stripe.Subscription;

                const customerId = subscription.customer as string;

                const { data: updatedProfile } = await supabase
                    .from("profiles")
                    .update({
                        subscription_status: "free",
                        current_period_end: null,
                    })
                    .eq("stripe_customer_id", customerId)
                    .select("id")
                    .single();

                if (updatedProfile) {
                    await logActivity(updatedProfile.id, "SUBSCRIPTION_CANCELED", "Axis Pro", { subscription_id: subscription.id });
                }

                break;
            }

            default:
                break;
        }

        return NextResponse.json({ received: true });
    } catch (err) {
        const message = err instanceof Error ? err.message : "Webhook error";
        console.error("[Stripe Webhook] Processing failed:", message);
        return NextResponse.json({ error: "Webhook handler failed" }, { status: 500 });
    }
}
