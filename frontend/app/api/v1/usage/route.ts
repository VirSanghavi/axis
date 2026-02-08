import { NextRequest, NextResponse } from "next/server";
import { getSessionFromRequest } from "@/lib/auth";
import { createClient } from "@supabase/supabase-js";
import { resolveUserId } from "@/lib/db-utils";

// Force Node runtime (Supabase service role doesn't work in Edge)
export const runtime = "nodejs";

// Create Supabase client inside function to avoid stale clients on Vercel cold starts
function getSupabase() {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    
    if (!url || !key) {
        console.error("[usage] Missing Supabase env vars:", { hasUrl: !!url, hasKey: !!key });
        throw new Error("Supabase configuration missing");
    }
    
    return createClient(url, key);
}

export async function GET(req: NextRequest) {
    const session = await getSessionFromRequest(req);
    if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    try {
        const { searchParams } = new URL(req.url);
        const emailParam = searchParams.get("email");
        
        // Determine user ID: use email lookup if provided, otherwise use session
        let userId: string;
        let userEmail: string;

        if (emailParam) {
            // Look up user by email (for MCP tools) - use profiles table
            const resolvedId = await resolveUserId(emailParam);
            if (!resolvedId) {
                return NextResponse.json({ error: "User not found" }, { status: 404 });
            }
            userId = resolvedId;
            userEmail = emailParam;
        } else {
            // Use session (for web UI)
            userId = session.sub!;
            userEmail = session.email || "unknown";
        }

        const supabase = getSupabase();
        
        // 1. Get Profile (Subscription Status)
        const { data: profile, error: profileError } = await supabase
            .from("profiles")
            .select("subscription_status, current_period_end")
            .eq("id", userId)
            .single();

        if (profileError) throw profileError;

        // 2. Get Usage (Count from api_usage)
        const { count, error: usageError } = await supabase
            .from("api_usage")
            .select("*", { count: 'exact', head: true })
            .eq("user_id", userId);

        if (usageError) throw usageError;

        const isActive = profile.subscription_status === 'pro' ||
            (profile.current_period_end && new Date(profile.current_period_end) > new Date());

        return NextResponse.json({
            email: userEmail,
            plan: isActive ? "Pro" : "Free",
            status: profile.subscription_status || "free",
            validUntil: profile.current_period_end,
            usageCount: count || 0,
            limit: 1000 // Placeholder limit
        });
    } catch (e: any) {
        return NextResponse.json({ error: e.message }, { status: 500 });
    }
}
