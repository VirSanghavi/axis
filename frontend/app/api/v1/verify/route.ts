import { NextRequest, NextResponse } from "next/server";
import { getSessionFromRequest } from "@/lib/auth";
import { createClient } from "@supabase/supabase-js";

export const runtime = "nodejs";

function getSupabase() {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key) throw new Error("Supabase configuration missing");
    return createClient(url, key);
}

/**
 * GET /api/v1/verify
 * 
 * Lightweight endpoint for MCP servers to verify that the API key
 * belongs to an active subscriber. Called on server startup and
 * periodically during the session.
 * 
 * Returns:
 *   { valid: true, plan: "Pro", validUntil: "2026-03-01T..." }
 *   { valid: false, reason: "subscription_expired" }
 *   { valid: false, reason: "unauthorized" }
 */
export async function GET(req: NextRequest) {
    const session = await getSessionFromRequest(req);
    if (!session) {
        return NextResponse.json(
            { valid: false, reason: "unauthorized" },
            { status: 401 }
        );
    }

    try {
        const userId = session.sub;
        if (!userId) {
            return NextResponse.json(
                { valid: false, reason: "no_user_id" },
                { status: 401 }
            );
        }

        const supabase = getSupabase();

        const { data: profile, error } = await supabase
            .from("profiles")
            .select("subscription_status, current_period_end")
            .eq("id", userId)
            .single();

        if (error || !profile) {
            return NextResponse.json(
                { valid: false, reason: "profile_not_found" },
                { status: 404 }
            );
        }

        const isActive =
            profile.subscription_status === "pro" ||
            (profile.current_period_end &&
                new Date(profile.current_period_end) > new Date());

        if (!isActive) {
            return NextResponse.json({
                valid: false,
                reason: "subscription_expired",
                plan: "Free",
                status: profile.subscription_status || "free",
            });
        }

        return NextResponse.json({
            valid: true,
            plan: "Pro",
            status: profile.subscription_status,
            validUntil: profile.current_period_end,
        });
    } catch (e: unknown) {
        console.error("[Verify] Server error:", e);
        return NextResponse.json(
            { valid: false, reason: "server_error" },
            { status: 500 }
        );
    }
}
