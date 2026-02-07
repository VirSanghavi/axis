import { NextRequest, NextResponse } from "next/server";
import { getSessionFromRequest } from "@/lib/auth";
import { createClient, SupabaseClient } from "@supabase/supabase-js";
import crypto from "crypto";
import { getClientIp, rateLimit } from "@/lib/rate-limit";
import { resolveUserId } from "@/lib/db-utils";

const WINDOW_MS = 60 * 1000;
const LIMIT = 30; // 30 req/min for key management

function getSupabaseClient() {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!url || !key || url.includes("<") || url.includes("your-project")) {
        return null;
    }

    return createClient(url, key);
}

export async function GET(req: NextRequest) {
    const ip = getClientIp(req.headers);
    const { allowed, remaining, reset } = await rateLimit(`keys:${ip}`, LIMIT, WINDOW_MS);
    if (!allowed) {
        return NextResponse.json(
            { error: "Too many requests" },
            { status: 429, headers: rateHeaders(remaining, reset) }
        );
    }

    const supabase = getSupabaseClient();
    if (!supabase) {
        return NextResponse.json({ error: "Supabase not configured" }, { status: 503 });
    }

    const session = await getSessionFromRequest(req);
    if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    try {
        const userId = session.sub || session.id || await getUserId(supabase, session.email);

        const { data: keys, error } = await supabase
            .from("api_keys")
            .select("id, name, created_at, last_used_at, is_active")
            .eq("user_id", userId);

        if (error) return NextResponse.json({ error: error.message }, { status: 500 });
        return NextResponse.json({ keys: keys || [] }, { headers: rateHeaders(remaining, reset) });
    } catch (err: unknown) {
        console.error("Keys GET error:", err);
        const errorMessage = err instanceof Error ? err.message : "Failed to fetch keys";
        return NextResponse.json({ error: errorMessage }, { status: 500 });
    }
}

export async function POST(req: NextRequest) {
    const ip = getClientIp(req.headers);
    const { allowed, remaining, reset } = await rateLimit(`keys:${ip}`, LIMIT, WINDOW_MS);
    if (!allowed) {
        return NextResponse.json(
            { error: "Too many requests" },
            { status: 429, headers: rateHeaders(remaining, reset) }
        );
    }

    const supabase = getSupabaseClient();
    if (!supabase) {
        return NextResponse.json({ error: "Supabase not configured" }, { status: 503 });
    }

    const session = await getSessionFromRequest(req);
    if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    try {
        const body = await req.json().catch(() => ({}));
        const name = body.name || "Default Key";

        const userId = session.sub || session.id || await getUserId(supabase, session.email);
        if (!userId) return NextResponse.json({ error: "User not found" }, { status: 404 });

        // Check Pro Tier
        const { data: profile } = await supabase
            .from("profiles")
            .select("subscription_status")
            .eq("id", userId)
            .single();

        if (profile?.subscription_status !== 'pro') {
            return NextResponse.json({
                error: "API Key generation requires Axis Pro. Upgrade your plan to continue."
            }, { status: 403 });
        }

        // Generate Key
        const rawKey = `sk_sc_${crypto.randomBytes(24).toString("hex")}`;
        const keyHash = crypto.createHash("sha256").update(rawKey).digest("hex");

        const { data, error } = await supabase
            .from("api_keys")
            .insert({
                user_id: userId,
                name,
                key_hash: keyHash,
            })
            .select()
            .single();

        if (error) return NextResponse.json({ error: error.message }, { status: 500 });

        // Return the RAW key only now
        return NextResponse.json({
            key: { ...data, secret: rawKey }
        }, { headers: rateHeaders(remaining, reset) });
    } catch (err: unknown) {
        console.error("Keys POST error:", err);
        const errorMessage = err instanceof Error ? err.message : "Failed to create key";
        return NextResponse.json({ error: errorMessage }, { status: 500 });
    }
}

async function getUserId(supabase: SupabaseClient, email: string) {
    return resolveUserId(email);
}

function rateHeaders(remaining: number, reset: number) {
    return {
        "x-rate-limit-remaining": String(remaining),
        "x-rate-limit-reset": String(reset),
    };
}
