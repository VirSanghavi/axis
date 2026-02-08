import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function GET() {
    const now = new Date().toISOString();

    const checks: Record<string, string> = {
        api: "ok",
        supabase: "unknown",
        stripe: "unknown",
    };

    // Supabase connectivity
    try {
        const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
        const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
        if (url && key) {
            const res = await fetch(`${url}/rest/v1/`, {
                headers: { apikey: key },
                signal: AbortSignal.timeout(3000),
            });
            checks.supabase = res.ok ? "ok" : `error (${res.status})`;
        } else {
            checks.supabase = "not configured";
        }
    } catch (e) {
        checks.supabase = `error (${e instanceof Error ? e.message : "unknown"})`;
    }

    // Stripe connectivity
    try {
        const key = process.env.STRIPE_SECRET_KEY;
        if (key) {
            const res = await fetch("https://api.stripe.com/v1/balance", {
                headers: { Authorization: `Bearer ${key}` },
                signal: AbortSignal.timeout(3000),
            });
            checks.stripe = res.ok ? "ok" : `error (${res.status})`;
        } else {
            checks.stripe = "not configured";
        }
    } catch (e) {
        checks.stripe = `error (${e instanceof Error ? e.message : "unknown"})`;
    }

    const healthy = Object.values(checks).every(v => v === "ok" || v === "not configured");

    return NextResponse.json(
        {
            status: healthy ? "healthy" : "degraded",
            timestamp: now,
            checks,
        },
        { status: healthy ? 200 : 503 }
    );
}
