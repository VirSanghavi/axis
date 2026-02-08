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
        console.error("[sessions/finalize] Missing Supabase env vars:", { hasUrl: !!url, hasKey: !!key });
        throw new Error("Supabase configuration missing");
    }
    
    return createClient(url, key);
}

export async function POST(req: NextRequest) {
    const session = await getSessionFromRequest(req);
    if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    try {
        const body = await req.json();
        const { projectName = "default", content } = body;
        const supabase = getSupabase();
        
        // Auto-create project if it doesn't exist
        const projectId = await getOrCreateProjectId(projectName, session.sub!);

        // 1. Archive to Sessions
        const { error: sessionError } = await supabase
            .from("sessions")
            .insert({
                project_id: projectId,
                user_id: session.sub,
                title: `Session ${new Date().toLocaleDateString()}`,
                summary: content.substring(0, 500) + "...",
                metadata: { full_content: content }
            });

        if (sessionError) throw sessionError;

        // 2. Clear Project State (Notepad)
        const { error: projectError } = await supabase
            .from("projects")
            .update({ live_notepad: "Session Start: " + new Date().toISOString() + "\n" })
            .eq("id", projectId);

        if (projectError) throw projectError;

        // 3. Clear Jobs (Done/Cancelled)
        const { error: jobError } = await supabase
            .from("jobs")
            .delete()
            .eq("project_id", projectId)
            .in("status", ["done", "cancelled"]);

        if (jobError) throw jobError;

        // 4. Clear Locks
        const { error: lockError } = await supabase
            .from("locks")
            .delete()
            .eq("project_id", projectId);

        if (lockError) throw lockError;

        return NextResponse.json({ success: true, message: "Session finalized and archived" });

    } catch (e: any) {
        console.error("[sessions/finalize] Error:", e);
        return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
    }
}
