import { NextRequest, NextResponse } from "next/server";
import { getSessionFromRequest } from "@/lib/auth";
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL || "",
    process.env.SUPABASE_SERVICE_ROLE_KEY || ""
);

async function getProjectId(projectName: string, userId: string) {
    const { data: project } = await supabase
        .from("projects")
        .select("id")
        .eq("name", projectName)
        .eq("owner_id", userId)
        .maybeSingle();
    return project?.id;
}

export async function POST(req: NextRequest) {
    const session = await getSessionFromRequest(req);
    if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    try {
        const body = await req.json();
        const { projectName = "default", content } = body;
        const projectId = await getProjectId(projectName, session.sub!);

        if (!projectId) return NextResponse.json({ error: "Project not found" }, { status: 404 });

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
        return NextResponse.json({ error: e.message }, { status: 500 });
    }
}
