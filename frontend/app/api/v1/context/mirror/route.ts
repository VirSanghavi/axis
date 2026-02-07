import { NextRequest, NextResponse } from "next/server";
import { getSessionFromRequest } from "@/lib/auth";
import { logUsage } from "@/lib/usage";
import { getClientIp, rateLimit } from "@/lib/rate-limit";

const WINDOW_MS = 60 * 1000;
const LIMIT = 50; // Moderate limit for context mirroring

export async function GET(req: NextRequest) {
    const startTime = Date.now();
    const session = await getSessionFromRequest(req);

    if (!session) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const ip = getClientIp(req.headers);
    const { allowed } = await rateLimit(`mirror:${ip}`, LIMIT, WINDOW_MS);
    if (!allowed) {
        return NextResponse.json({ error: "Too many requests" }, { status: 429 });
    }


    // In a full implementation, we would query the 'embeddings' or 'projects' table
    // to build a real map of the context. For this iteration, we keep the schema-aligned
    // mock but ensure it's gated by real auth and logged.

    const contextMap = {
        root: "shared-context",
        timestamp: new Date().toISOString(),
        nodes: [
            { name: "src", type: "directory", children: ["local", "governance"] },
            { name: "supabase", type: "directory", children: ["schema_prod.sql"] },
            { name: "package.json", type: "file", size: 1024 }
        ],
        metadata: {
            governance: "active",
            sync_status: "production_ready"
        }
    };

    // Log usage
    logUsage({
        userId: session.sub!,
        apiKeyId: session.role === 'api_key' ? session.keyId : undefined,
        endpoint: "/api/v1/context/mirror",
        method: "GET",
        statusCode: 200,
        responseTimeMs: Date.now() - startTime
    });

    return NextResponse.json(contextMap);
}
