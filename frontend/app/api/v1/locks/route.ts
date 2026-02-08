import { NextRequest, NextResponse } from "next/server";
import { getSessionFromRequest } from "@/lib/auth";
import { createClient } from "@supabase/supabase-js";
import { getOrCreateProjectId } from "@/lib/project-utils";

// Force Node runtime (Supabase service role doesn't work in Edge)
export const runtime = "nodejs";

// Create Supabase client inside function to avoid stale clients on Vercel cold starts
function getSupabase() {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    
    if (!url || !key) {
        console.error("[locks] Missing Supabase env vars:", { hasUrl: !!url, hasKey: !!key });
        throw new Error("Supabase configuration missing");
    }
    
    return createClient(url, key);
}

export async function GET(req: NextRequest) {
    const session = await getSessionFromRequest(req);
    if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const { searchParams } = new URL(req.url);
    const projectName = searchParams.get("projectName") || "default";

    try {
        const supabase = getSupabase();
        const projectId = await getOrCreateProjectId(projectName, session.sub!);
        const { data: locks, error } = await supabase
            .from("locks")
            .select("*")
            .eq("project_id", projectId);
        if (error) throw error;
        return NextResponse.json({ locks: locks || [] });
    } catch (e: any) {
        return NextResponse.json({ error: e.message }, { status: 500 });
    }
}

export async function POST(req: NextRequest) {
    const session = await getSessionFromRequest(req);
    if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    try {
        const supabase = getSupabase();
        const body = await req.json();
        const { projectName = "default", action, filePath, agentId, intent, userPrompt, reason } = body;

        // --- Input validation ---
        if (filePath !== undefined) {
            if (typeof filePath !== "string" || filePath.length === 0 || filePath.length > 1000 || filePath.includes("\0")) {
                return NextResponse.json({ error: "filePath must be a non-empty string (max 1000 chars, no null bytes)" }, { status: 400 });
            }
        }
        if (agentId !== undefined) {
            if (typeof agentId !== "string" || agentId.length === 0 || agentId.length > 200) {
                return NextResponse.json({ error: "agentId must be a non-empty string (max 200 chars)" }, { status: 400 });
            }
        }

        if (action === "lock" && (!filePath || !agentId)) {
            return NextResponse.json({ error: "filePath and agentId are required for lock" }, { status: 400 });
        }

        if (action === "unlock" && !filePath) {
            return NextResponse.json({ error: "filePath is required for unlock" }, { status: 400 });
        }

        const projectId = await getOrCreateProjectId(projectName, session.sub!);

        if (action === "lock") {
            // Use atomic try_acquire_lock RPC — prevents TOCTOU race conditions
            // between concurrent agents trying to lock the same file.
            const { data, error } = await supabase.rpc("try_acquire_lock", {
                p_project_id: projectId,
                p_file_path: filePath,
                p_agent_id: agentId,
                p_intent: intent || "",
                p_user_prompt: userPrompt || "",
                p_timeout_seconds: 1800, // 30 minutes
            });

            if (error) throw error;

            // RPC returns an array of rows from RETURNS TABLE
            const result = Array.isArray(data) ? data[0] : data;

            if (!result) {
                // RPC returned no rows — treat as error, not a silent grant
                console.error("[locks] try_acquire_lock returned no rows");
                return NextResponse.json({ error: "Lock RPC returned no result" }, { status: 500 });
            }

            if (result.status === "DENIED") {
                return NextResponse.json({
                    status: "DENIED",
                    message: `File locked by agent '${result.owner_id}'`,
                    current_lock: {
                        agent_id: result.owner_id,
                        intent: result.intent,
                        updated_at: result.updated_at,
                    },
                }, { status: 409 });
            }

            return NextResponse.json({
                status: "GRANTED",
                agent_id: agentId,
                file_path: filePath,
                intent,
            });
        }

        if (action === "unlock") {
            const { error } = await supabase
                .from("locks")
                .delete()
                .eq("project_id", projectId)
                .eq("file_path", filePath);
            if (error) throw error;
            return NextResponse.json({ success: true });
        }

        return NextResponse.json({ error: "Invalid action. Use 'lock' or 'unlock'." }, { status: 400 });
    } catch (e: any) {
        console.error("[locks] Error:", e);
        return NextResponse.json({ error: e.message }, { status: 500 });
    }
}
