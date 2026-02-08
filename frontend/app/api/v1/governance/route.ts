import { NextRequest, NextResponse } from "next/server";
import { getSessionFromRequest } from "@/lib/auth";
import { logUsage } from "@/lib/usage";
import { createClient } from "@supabase/supabase-js";
import { getClientIp, rateLimit } from "@/lib/rate-limit";

const WINDOW_MS = 60 * 1000;
const LIMIT = 10; // Strict limit for governance changes

export async function POST(req: NextRequest) {
    const startTime = Date.now();
    const session = await getSessionFromRequest(req);

    if (!session) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const ip = getClientIp(req.headers);
    const { allowed } = await rateLimit(`governance:${ip}`, LIMIT, WINDOW_MS);
    if (!allowed) {
        return NextResponse.json({ error: "Too many requests" }, { status: 429 });
    }

    const body = await req.json().catch(() => ({}));
    const { rule, target, projectId } = body;

    if (!rule || !target) {
        return NextResponse.json({ error: "Missing rule or target" }, { status: 400 });
    }

    const supabase = createClient(
        process.env.NEXT_PUBLIC_SUPABASE_URL || "",
        process.env.SUPABASE_SERVICE_ROLE_KEY || ""
    );

    // Persist to DB
    const { data: newRule, error } = await supabase.from("governance_rules").insert({
        project_id: projectId, // Optional for global/user rules
        rule_type: "governance",
        rule_body: rule,
        target,
        created_by: session.sub
    }).select().single();

    if (error) {
        console.error("[governance] Error:", error);
        return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
    }

    // Log usage
    logUsage({
        userId: session.sub!,
        apiKeyId: session.role === 'api_key' ? session.keyId : undefined,
        endpoint: "/api/v1/governance",
        method: "POST",
        statusCode: 200,
        responseTimeMs: Date.now() - startTime
    });

    return NextResponse.json({
        status: "success",
        message: "Governance protocol updated and persisted",
        applied_rule: newRule
    });
}
