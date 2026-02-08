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

        // Timezone offset from the browser (minutes ahead of UTC, e.g. 480 for PST)
        // getTimezoneOffset() returns positive for behind-UTC zones.
        const tzParam = req.nextUrl.searchParams.get('tz');
        const tzOffsetMin = tzParam ? parseInt(tzParam, 10) : 0;

        // "Today" in the user's local timezone
        const nowMs = Date.now();
        const localNowMs = nowMs - tzOffsetMin * 60_000;
        const localNow = new Date(localNowMs);
        const localTodayStr = localNow.toISOString().split('T')[0]; // YYYY-MM-DD in user's local tz

        // Build the 7 local-date strings (oldest → newest)
        const dayNames = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
        const localDates: { dateStr: string; dayName: string }[] = [];
        for (let i = 6; i >= 0; i--) {
            const d = new Date(localNow);
            d.setUTCDate(d.getUTCDate() - i);
            const dateStr = d.toISOString().split('T')[0];
            localDates.push({ dateStr, dayName: dayNames[d.getUTCDay()] });
        }

        // Query window: from the start of the earliest local day to the end of today (in UTC)
        const rangeStartLocal = localDates[0].dateStr + 'T00:00:00';
        const rangeEndLocal = localTodayStr + 'T23:59:59.999';
        // Convert local boundaries back to UTC for the DB query
        const rangeStartUTC = new Date(new Date(rangeStartLocal).getTime() + tzOffsetMin * 60_000).toISOString();
        const rangeEndUTC = new Date(new Date(rangeEndLocal).getTime() + tzOffsetMin * 60_000).toISOString();

        // Fetch raw timestamps from api_usage
        const { data: rows, error } = await supabase
            .from('api_usage')
            .select('created_at, tokens_used')
            .eq('user_id', userId)
            .gte('created_at', rangeStartUTC)
            .lte('created_at', rangeEndUTC);

        if (error) {
            console.error("Usage fetch error:", error);
            return NextResponse.json({ usage: [] });
        }

        // Group rows by the user's local date
        const countByDate: Record<string, { requests: number; tokens: number }> = {};
        for (const row of (rows || [])) {
            // Convert UTC timestamp → user's local date
            const utcMs = new Date(row.created_at).getTime();
            const localMs = utcMs - tzOffsetMin * 60_000;
            const localDateStr = new Date(localMs).toISOString().split('T')[0];
            if (!countByDate[localDateStr]) countByDate[localDateStr] = { requests: 0, tokens: 0 };
            countByDate[localDateStr].requests += 1;
            countByDate[localDateStr].tokens += (row.tokens_used || 0);
        }

        // Build final array with 0-fills for missing days
        const last7Days = localDates.map(({ dateStr, dayName }) => ({
            day: dayName,
            date: dateStr,
            requests: countByDate[dateStr]?.requests || 0,
            tokens: countByDate[dateStr]?.tokens || 0,
        }));

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
