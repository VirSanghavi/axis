import { NextRequest, NextResponse } from "next/server";
import { getSessionFromRequest } from "@/lib/auth";
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL || "",
    process.env.SUPABASE_SERVICE_ROLE_KEY || ""
);

async function getOrCreateProjectId(projectName: string, userId: string) {
    const { data: project } = await supabase
        .from("projects")
        .select("id")
        .eq("name", projectName)
        .eq("owner_id", userId)
        .maybeSingle();

    if (project?.id) return project.id;

    const { data: created, error } = await supabase
        .from("projects")
        .insert({ name: projectName, owner_id: userId })
        .select("id")
        .single();

    if (error) throw error;
    return created.id;
}

export async function GET(req: NextRequest) {
    const session = await getSessionFromRequest(req);
    if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const { searchParams } = new URL(req.url);
    const projectName = searchParams.get("projectName") || "default";

    try {
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
