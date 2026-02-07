import { NextRequest, NextResponse } from "next/server";
import { getSessionFromRequest } from "@/lib/auth";
import { createClient } from "@supabase/supabase-js";
import { logUsage } from "@/lib/usage";

const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL || "",
    process.env.SUPABASE_SERVICE_ROLE_KEY || ""
);

async function getOrCreateProjectId(projectName: string, userId: string) {
    // Try to find project
    const { data: project, error: findError } = await supabase
        .from("projects")
        .select("id")
        .eq("name", projectName)
        .eq("owner_id", userId)
        .maybeSingle();

    if (project?.id) return project.id;

    // Create if not exists
    const { data: created, error: createError } = await supabase
        .from("projects")
        .insert({ name: projectName, owner_id: userId })
        .select("id")
        .single();

    if (createError) throw createError;
    return created.id;
}

export async function GET(req: NextRequest) {
    const session = await getSessionFromRequest(req);
    if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const { searchParams } = new URL(req.url);
    const projectName = searchParams.get("projectName") || "default";

    try {
        const projectId = await getOrCreateProjectId(projectName, session.sub!);

        const { data: jobs, error } = await supabase
            .from("jobs")
            .select("*")
            .eq("project_id", projectId)
            .order("created_at", { ascending: false });

        if (error) throw error;

        return NextResponse.json({ jobs: jobs || [] });
    } catch (e: any) {
        return NextResponse.json({ error: e.message }, { status: 500 });
    }
}

export async function POST(req: NextRequest) {
    const session = await getSessionFromRequest(req);
    if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    try {
        const body = await req.json();
        const { projectName = "default", action, ...jobData } = body;
        const projectId = await getOrCreateProjectId(projectName, session.sub!);

        if (action === "post") {
            const { data, error } = await supabase
                .from("jobs")
                .insert({
                    project_id: projectId,
                    title: jobData.title,
                    description: jobData.description,
                    priority: jobData.priority || "medium",
                    status: "todo",
                    dependencies: jobData.dependencies || []
                })
                .select()
                .single();
            if (error) throw error;
            return NextResponse.json(data);
        }

        if (action === "update") {
            const { jobId, ...updates } = jobData;
            const { data, error } = await supabase
                .from("jobs")
                .update({
                    ...updates,
                    updated_at: new Date().toISOString()
                })
                .eq("id", jobId)
                .eq("project_id", projectId)
                .select()
                .single();
            if (error) throw error;
            return NextResponse.json(data);
        }

        return NextResponse.json({ error: "Invalid action" }, { status: 400 });
    } catch (e: any) {
        return NextResponse.json({ error: e.message }, { status: 500 });
    }
}
