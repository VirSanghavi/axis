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
        const { projectName = "default", action, filePath, agentId, intent, userPrompt } = body;
        const projectId = await getOrCreateProjectId(projectName, session.sub!);

        if (action === "lock") {
            const { data, error } = await supabase
                .from("locks")
                .upsert({
                    project_id: projectId,
                    file_path: filePath,
                    agent_id: agentId,
                    intent,
                    user_prompt: userPrompt,
                    updated_at: new Date().toISOString()
                })
                .select()
                .single();
            if (error) throw error;
            return NextResponse.json(data);
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

        return NextResponse.json({ error: "Invalid action" }, { status: 400 });
    } catch (e: any) {
        return NextResponse.json({ error: e.message }, { status: 500 });
    }
}
