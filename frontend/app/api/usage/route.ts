import { NextRequest, NextResponse } from "next/server";
import { getSessionFromRequest } from "@/lib/auth";
import { createClient } from "@supabase/supabase-js";
import { getClientIp, rateLimit } from "@/lib/rate-limit";
import { resolveUserId } from "@/lib/db-utils";

const WINDOW_MS = 60 * 1000;
const LIMIT = 60; // 60 req/min for usage analytics (higher volume)

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
    const { allowed } = await rateLimit(`usage:${ip}`, LIMIT, WINDOW_MS);
    if (!allowed) {
        return NextResponse.json({ error: "Too many requests" }, { status: 429 });
    }

    const supabase = getSupabaseClient();
    if (!supabase) {
        return NextResponse.json({ error: "Supabase not configured" }, { status: 503 });
    }

    const session = await getSessionFromRequest(req);
    if (!session) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    try {
        const userId = session.sub || await resolveUserId(session.email);

        if (!userId) {
            return NextResponse.json({ error: "User not found" }, { status: 404 });
        }

        // Get usage data for the last 7 days
        const { data, error } = await supabase.rpc('get_daily_usage', {
            p_user_id: userId,
            p_days: 7
        });

        if (error) {
            console.error("Usage fetch error:", error);
            // If function doesn't exist or no data, return empty array
            return NextResponse.json({ usage: [] });
        }

        // Fill in missing days with 0
        const today = new Date();
        const days = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
        const last7Days = [];

        for (let i = 6; i >= 0; i--) {
            const date = new Date(today);
            date.setDate(date.getDate() - i);
            const dateStr = date.toISOString().split('T')[0];
            const dayName = days[date.getDay()];

            const found = (data as Array<{ day: string; request_count: number; total_tokens: number }>)?.find((d) => d.day === dateStr);
            last7Days.push({
                day: dayName,
                date: dateStr,
                requests: found?.request_count || 0,
                tokens: found?.total_tokens || 0
            });
        }

        return NextResponse.json({ usage: last7Days });
    } catch (err: unknown) {
        console.error("Usage API error:", err);
        const errorMessage = err instanceof Error ? err.message : "Failed to fetch usage";
        return NextResponse.json({ error: errorMessage }, { status: 500 });
    }
}

// Log usage when API is called
export async function POST(req: NextRequest) {
    const ip = getClientIp(req.headers);
    const { allowed } = await rateLimit(`usage_post:${ip}`, LIMIT * 2, WINDOW_MS); // Higher limit for logging
    if (!allowed) {
        return NextResponse.json({ error: "Too many requests" }, { status: 429 });
    }

    const supabase = getSupabaseClient();
    if (!supabase) {
        return NextResponse.json({ error: "Supabase not configured" }, { status: 503 });
    }

    try {
        const body = await req.json();
        const { user_id, api_key_id, endpoint, method, status_code, response_time_ms, tokens_used } = body;

        // SANITIZATION & VALIDATION
        if (!user_id || typeof user_id !== 'string') {
            return NextResponse.json({ error: "Invalid user_id" }, { status: 400 });
        }
        if (!endpoint || typeof endpoint !== 'string') {
            return NextResponse.json({ error: "Invalid endpoint" }, { status: 400 });
        }
        if (tokens_used && typeof tokens_used !== 'number') {
            return NextResponse.json({ error: "Invalid tokens_used" }, { status: 400 });
        }

        const { error } = await supabase
            .from("api_usage")
            .insert({
                user_id,
                api_key_id,
                endpoint,
                method: method || 'GET',
                status_code,
                response_time_ms,
                tokens_used: tokens_used || 0
            });

        if (error) {
            console.error("Usage log error:", error);
            return NextResponse.json({ error: error.message }, { status: 500 });
        }

        return NextResponse.json({ ok: true });
    } catch (err: unknown) {
        console.error("Usage POST error:", err);
        const errorMessage = err instanceof Error ? err.message : "Failed to log usage";
        return NextResponse.json({ error: errorMessage }, { status: 500 });
    }
}
