import { NextRequest, NextResponse } from "next/server";
import { getSessionFromRequest } from "@/lib/auth";
import { createClient } from "@supabase/supabase-js";
import { getOrCreateProjectId } from "@/lib/project-utils";

export const runtime = "nodejs";

function getSupabase() {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key) throw new Error("Supabase configuration missing");
    return createClient(url, key);
}

/**
 * GET /api/v1/lock-events?projectName=default&days=7
 * Returns lock event stats grouped by type and day.
 * Also returns recent BLOCKED events for the detail view.
 */
export async function GET(req: NextRequest) {
    const session = await getSessionFromRequest(req);
    if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const { searchParams } = new URL(req.url);
    const projectName = searchParams.get("projectName") || "default";
    const days = parseInt(searchParams.get("days") || "7", 10);

    try {
        const supabase = getSupabase();
        const projectId = await getOrCreateProjectId(projectName, session.sub!);

        // Get aggregated stats via RPC
        const { data: stats, error: statsErr } = await supabase.rpc("get_lock_event_stats", {
            p_project_id: projectId,
            p_days: days,
        });
        if (statsErr) throw statsErr;

        // Get recent blocked events for detail view (last 20)
        const { data: recentBlocked, error: recentErr } = await supabase
            .from("lock_events")
            .select("*")
            .eq("project_id", projectId)
            .eq("event_type", "BLOCKED")
            .gte("created_at", new Date(Date.now() - days * 86400000).toISOString())
            .order("created_at", { ascending: false })
            .limit(20);
        if (recentErr) throw recentErr;

        // Aggregate stats into summary
        const summary = {
            blocked: 0,
            granted: 0,
            force_unlocked: 0,
            released: 0,
        };
        const daily: Record<string, { blocked: number; granted: number }> = {};

        for (const row of (stats || [])) {
            const key = row.event_type.toLowerCase() as keyof typeof summary;
            if (key in summary) summary[key] += Number(row.event_count);

            if (!daily[row.day]) daily[row.day] = { blocked: 0, granted: 0 };
            if (row.event_type === "BLOCKED") daily[row.day].blocked += Number(row.event_count);
            if (row.event_type === "GRANTED") daily[row.day].granted += Number(row.event_count);
        }

        // Fill in missing days
        const dailyData = [];
        for (let i = days - 1; i >= 0; i--) {
            const d = new Date(Date.now() - i * 86400000);
            const key = d.toISOString().split("T")[0];
            const label = d.toLocaleDateString("en-US", { weekday: "short" }).toLowerCase();
            dailyData.push({
                day: label,
                date: key,
                blocked: daily[key]?.blocked || 0,
                granted: daily[key]?.granted || 0,
            });
        }

        return NextResponse.json({
            summary,
            daily: dailyData,
            recentBlocked: recentBlocked || [],
        });
    } catch (e: any) {
        console.error("[lock-events] Error:", e);
        return NextResponse.json({ error: e.message }, { status: 500 });
    }
}

/**
 * POST /api/v1/lock-events
 * Logs a new lock event. Called by the MCP server.
 */
export async function POST(req: NextRequest) {
    const session = await getSessionFromRequest(req);
    if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    try {
        const supabase = getSupabase();
        const body = await req.json();
        const { projectName = "default", eventType, filePath, requestingAgent, blockingAgent, intent, metadata } = body;

        if (!eventType || !filePath || !requestingAgent) {
            return NextResponse.json({ error: "eventType, filePath, and requestingAgent are required" }, { status: 400 });
        }

        const validTypes = ["BLOCKED", "GRANTED", "FORCE_UNLOCKED", "RELEASED"];
        if (!validTypes.includes(eventType)) {
            return NextResponse.json({ error: `eventType must be one of: ${validTypes.join(", ")}` }, { status: 400 });
        }

        const projectId = await getOrCreateProjectId(projectName, session.sub!);

        const { error } = await supabase.from("lock_events").insert({
            project_id: projectId,
            event_type: eventType,
            file_path: filePath,
            requesting_agent: requestingAgent,
            blocking_agent: blockingAgent || null,
            intent: intent || null,
            metadata: metadata || {},
        });

        if (error) throw error;
        return NextResponse.json({ success: true });
    } catch (e: any) {
        console.error("[lock-events] POST Error:", e);
        return NextResponse.json({ error: e.message }, { status: 500 });
    }
}
